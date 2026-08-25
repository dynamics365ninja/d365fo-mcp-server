/**
 * A modify aimed at an extension nobody has created yet must not dead-end.
 *
 * The old answer was "File not found for table-extension X" plus four retry
 * options — pass modelName, pass packagePath, pass filePath, re-run create — and
 * none of them was "create it", even though the extension name had already been
 * normalised and its expected path computed. In the sampled sessions this
 * produced the same modify re-sent against the same *_Extension object, failing
 * identically every time.
 *
 * The create is composed by the DISPATCHER, not by modifyD365File: the two
 * largest write tools are not allowed to import each other
 * (tests/utils/layering.test.ts), and it must go through the ordinary create
 * path so path containment, prefixing, .rnrproj registration, the model guards
 * and the direct-XML fallbacks all still apply.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockModify, mockCreate } = vi.hoisted(() => ({ mockModify: vi.fn(), mockCreate: vi.fn() }));

vi.mock('../../src/tools/write/modifyD365File', () => ({ modifyD365FileTool: mockModify }));
vi.mock('../../src/tools/write/createD365File', () => ({ handleCreateD365File: mockCreate }));
vi.mock('../../src/tools/xml/generateD365Xml', () => ({ handleGenerateD365Xml: vi.fn() }));
vi.mock('../../src/tools/write/inlineIndexUpsert', () => ({ upsertWrittenFileIntoIndex: vi.fn(async () => '') }));

import { d365foFileTool } from '../../src/tools/d365foFile';

const ctx = {} as any;
const EXT_PATH = 'K:\\PLD\\fm-mcp\\fm-mcp\\AxTableExtension\\CustTable.FmMcpExtension.xml';

const call = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'd365fo_file', arguments: { action: 'modify', ...args } },
});
const text = (r: any) => r.content[0].text as string;

beforeEach(() => {
  vi.clearAllMocks();
  // First call: the extension is missing but its base exists — reported, not done.
  mockModify
    .mockImplementationOnce(async (_r: CallToolRequest, _c: unknown, outcome: any) => {
      if (outcome) outcome.createExtensionFirst = { objectType: 'table-extension', objectName: 'CustTable.Extension' };
      return { content: [{ type: 'text', text: '❌ does not exist yet' }], isError: true };
    })
    .mockImplementation(async () => ({ content: [{ type: 'text', text: '✅ add-field on table-extension' }] }));

  mockCreate.mockImplementation(async (_r: CallToolRequest, _c: unknown, outcome: any) => {
    if (outcome) {
      outcome.filePath = EXT_PATH;
      outcome.finalObjectName = 'CustTable.FmMcpExtension';
    }
    return { content: [{ type: 'text', text: '✅ Created table-extension' }] };
  });
});

const addField = () => d365foFileTool(call({
  objectType: 'table-extension',
  objectName: 'CustTable.Extension',
  operation: 'add-field',
  params: { fieldName: 'Tier', fieldType: 'Num' },
}), ctx);

describe('modify on a not-yet-created extension', () => {
  it('creates it through the ordinary create path, then applies the operation', async () => {
    const result = await addField();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect((mockCreate.mock.calls[0][0] as CallToolRequest).params.arguments).toMatchObject({
      objectType: 'table-extension', objectName: 'CustTable.Extension',
    });
    expect(mockModify).toHaveBeenCalledTimes(2);
    expect(result.isError).toBeFalsy();
  });

  it('retries against the name and path create actually wrote', async () => {
    await addField();
    const retry = (mockModify.mock.calls[1][0] as CallToolRequest).params.arguments as any;
    // Not the requested name — create normalises it, and a retry aimed at the
    // requested one would land on nothing while reporting success.
    expect(retry.objectName).toBe('CustTable.FmMcpExtension');
    expect(retry.filePath).toBe(EXT_PATH);
    expect(retry.fieldName).toBe('Tier');
  });

  it('reports BOTH actions, plainly, with the file it created', async () => {
    const t = text(await addField());
    expect(t).toContain('did not exist');
    expect(t).toContain('CustTable.FmMcpExtension');
    expect(t).toContain(EXT_PATH);
    expect(t).toContain('add-field');
  });

  it('does not attempt the operation when the create itself failed', async () => {
    mockCreate.mockImplementation(async () => ({ content: [{ type: 'text', text: '❌ create refused' }], isError: true }));
    const result = await addField();

    expect(mockModify).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('was NOT attempted');
  });

  it('creates nothing when the modify did not ask for it', async () => {
    mockModify.mockReset();
    mockModify.mockImplementation(async () => ({ content: [{ type: 'text', text: '❌ File not found for table "Nope"' }], isError: true }));

    const result = await d365foFileTool(call({
      objectType: 'table', objectName: 'Nope', operation: 'add-field',
      params: { fieldName: 'A', fieldType: 'Num' },
    }), ctx);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it('works from inside operations[] as well as from a single-op call', async () => {
    await d365foFileTool(call({
      objectType: 'table-extension',
      objectName: 'CustTable.Extension',
      operations: [{ operation: 'add-field', fieldName: 'Tier', fieldType: 'Num' }],
    }), ctx);

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
