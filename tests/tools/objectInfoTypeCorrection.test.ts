/**
 * get_object_info answers for the type the object actually IS, when only one is
 * plausible (audit 2026-08-25).
 *
 * VERIFIED LIVE: `get_object_info(objectType="class", name="CustTable")` returned
 * "❌ Class not found" plus a "Type Mismatch — use the correct tool" block naming
 * form/query/table. The server had already run the lookup that proves which types
 * exist; making the caller spend another round trip to act on it is the expensive
 * half of the answer, because every round trip re-bills the whole cached context.
 *
 * One plausible type → read it and disclose the correction, the same "corrected,
 * here is what I did" shape the write tools use. Several → nothing here can pick
 * for the caller, so the list stands.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClassInfo = vi.fn();
const mockTableInfo = vi.fn();
const mockFormInfo = vi.fn();

vi.mock('../../src/tools/readers/objectInfoRegistry', async (orig) => {
  const actual = await orig<typeof import('../../src/tools/readers/objectInfoRegistry')>();
  return {
    ...actual,
    READER_DISPATCH: {
      ...actual.READER_DISPATCH,
      class: { ...actual.READER_DISPATCH.class, tool: (...a: any[]) => mockClassInfo(...a) },
      table: { ...actual.READER_DISPATCH.table, tool: (...a: any[]) => mockTableInfo(...a) },
      form: { ...actual.READER_DISPATCH.form, tool: (...a: any[]) => mockFormInfo(...a) },
    },
  };
});

import { getObjectInfoTool } from '../../src/tools/readers/getObjectInfo';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'get_object_info', arguments: args },
});

/** Symbol index whose `detectObjectTypeInDb` query returns `rows`. */
function buildContext(rows: Array<{ type: string; model: string }>): XppServerContext {
  return {
    symbolIndex: {
      getReadDb: () => ({ prepare: () => ({ all: () => rows, get: () => undefined }) }),
    },
  } as unknown as XppServerContext;
}

const notFound = (what: string) => ({
  content: [{ type: 'text', text: `❌ ${what} "CustTable" not found via bridge or symbol index.` }],
  isError: true,
});

beforeEach(() => {
  mockClassInfo.mockReset().mockResolvedValue(notFound('Class'));
  mockTableInfo.mockReset().mockResolvedValue({ content: [{ type: 'text', text: '# Table: CustTable\n\n**Model:** Foundation' }] });
  mockFormInfo.mockReset().mockResolvedValue({ content: [{ type: 'text', text: '# Form: CustTable' }] });
});

describe('get_object_info — single plausible type', () => {
  it('answers for the type that does exist and says it did', async () => {
    const result = await getObjectInfoTool(
      req({ objectType: 'class', name: 'CustTable' }),
      buildContext([{ type: 'table', model: 'Foundation' }]),
    );
    const text = result.content[0].text as string;

    expect(result.isError).toBeFalsy();
    expect(mockTableInfo).toHaveBeenCalledTimes(1);
    expect(text).toContain('does not exist as a **class**');
    expect(text).toContain('so this is the table');
    expect(text).toContain('objectType="table"');
    // The corrected answer itself is there — not just an instruction to fetch it.
    expect(text).toContain('# Table: CustTable');
  });

  it('carries the caller\'s options into the corrected read', async () => {
    await getObjectInfoTool(
      req({ objectType: 'class', name: 'CustTable', options: { fieldFilter: 'Invoice' } }),
      buildContext([{ type: 'table', model: 'Foundation' }]),
    );
    expect(mockTableInfo.mock.calls[0][0].params.arguments).toMatchObject({ fieldFilter: 'Invoice' });
  });

  it('keeps the original error when the corrected read also fails', async () => {
    mockTableInfo.mockResolvedValue(notFound('Table'));
    const result = await getObjectInfoTool(
      req({ objectType: 'class', name: 'CustTable' }),
      buildContext([{ type: 'table', model: 'Foundation' }]),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Class "CustTable" not found');
  });
});

describe('get_object_info — several plausible types', () => {
  it('leaves the existing list alone when it cannot pick', async () => {
    const result = await getObjectInfoTool(
      req({ objectType: 'class', name: 'CustTable' }),
      buildContext([
        { type: 'table', model: 'Foundation' },
        { type: 'form', model: 'Foundation' },
        { type: 'query', model: 'Foundation' },
      ]),
    );
    expect(result.isError).toBe(true);
    expect(mockTableInfo).not.toHaveBeenCalled();
    expect(mockFormInfo).not.toHaveBeenCalled();
  });

  it('does not correct when the index knows nothing about the name', async () => {
    const result = await getObjectInfoTool(
      req({ objectType: 'class', name: 'CustTable' }),
      buildContext([]),
    );
    expect(result.isError).toBe(true);
    expect(mockTableInfo).not.toHaveBeenCalled();
  });
});

/**
 * The correction must not fire when the index says the requested type EXISTS.
 *
 * `buildObjectTypeMismatchMessage` has always bailed in that case
 * (`if (expectedEntries.length > 0 …) return ''`), and folding the correction in
 * here dropped that guard: the candidate list was built by filtering the
 * requested type out, then checked only for length 1.
 *
 * So for a name indexed as both a table and a form, a table read that fails for
 * an unrelated reason — a stale file_path, a moved file, the bridge down — would
 * return the FORM, prefixed with "does not exist as a table — it exists only as
 * a form". Both halves false, and the trigger is usually "the live source of
 * truth is broken", which is the worst moment to treat the index as an oracle.
 */
describe('get_object_info — the requested type is also indexed', () => {
  it('does not answer for another type when the requested one exists', async () => {
    mockTableInfo.mockReset().mockResolvedValue({
      content: [{ type: 'text', text: '❌ Table "CustTable" not found via bridge or symbol index.' }],
      isError: true,
    });

    const result = await getObjectInfoTool(
      req({ objectType: 'table', name: 'CustTable' }),
      // Indexed as BOTH — the read failed for some other reason.
      buildContext([{ type: 'table', model: 'Foundation' }, { type: 'form', model: 'Foundation' }]),
    );
    const text = result.content[0].text as string;

    expect(mockFormInfo, 'must not silently read a different object').not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(text).not.toContain('does not exist as a **table**');
    expect(text).toContain('not found');
  });

  it('still corrects when the requested type is genuinely absent', async () => {
    const result = await getObjectInfoTool(
      req({ objectType: 'class', name: 'CustTable' }),
      buildContext([{ type: 'table', model: 'Foundation' }, { type: 'form', model: 'Foundation' }]),
    );
    // Two candidates, neither of them the requested one -> it cannot pick, so it
    // must fall back to the list rather than guess.
    expect(mockTableInfo).not.toHaveBeenCalled();
    expect(mockFormInfo).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });
});
