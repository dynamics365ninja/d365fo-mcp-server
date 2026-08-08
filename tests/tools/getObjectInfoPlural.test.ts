/**
 * get_object_info plural form — `objects[]` fans out to the underlying get_*_info
 * readers in ONE call (issue #831; absorbs the retired `batch_get_info` tool).
 *
 * The compatibility guarantee under test: the single `{objectType, name}` form is
 * exactly the one-element plural form `{objects:[{objectType, objectName}]}` and
 * its result shape is unchanged (no batch header, no numbered sections). Entries
 * carry the name as `objectName` — the key verify_d365fo_project and run_bp_check
 * already use for their `objects[]`.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/tools/classInfo', () => ({
  classInfoTool: vi.fn(async (req: any) => ({
    content: [{ type: 'text', text: `class:${req.params.arguments.className}:compact=${req.params.arguments.compact}` }],
  })),
}));
vi.mock('../../src/tools/tableInfo', () => ({
  tableInfoTool: vi.fn(async (req: any) => ({
    content: [{ type: 'text', text: `table:${req.params.arguments.tableName}` }],
  })),
}));
vi.mock('../../src/tools/enumInfo', () => ({
  getEnumInfoTool: vi.fn(async () => ({
    content: [{ type: 'text', text: 'enum not found' }],
    isError: true,
  })),
}));

import { getObjectInfoTool } from '../../src/tools/getObjectInfo';
import { classInfoTool } from '../../src/tools/classInfo';
import { tableInfoTool } from '../../src/tools/tableInfo';
import { toolSchemas } from '../../src/server/toolSchemas/index';
import { buildProgressMessage } from '../../src/utils/toolProgressMessage';

const req = (args: Record<string, unknown>): any => ({
  method: 'tools/call',
  params: { name: 'get_object_info', arguments: args },
});

const context = {} as any;

describe('get_object_info — plural objects[] form', () => {
  it('reads three objects in ONE call and dispatches each to its reader (issue #831)', async () => {
    vi.mocked(classInfoTool).mockClear();

    const result = await getObjectInfoTool(
      req({
        objects: [
          { objectType: 'class', objectName: 'Table1Model_Extension' },
          { objectType: 'class', objectName: 'Table2Model_Extension' },
          { objectType: 'class', objectName: 'Table3Model_Extension' },
        ],
      }),
      context,
    );

    // ONE result, not three — this is the round-trip saving the issue is about.
    expect(result.content).toHaveLength(1);
    expect(result.isError).toBeFalsy();

    const text = result.content[0].text;
    expect(text).toContain('Fetched: 3 object(s) in parallel');
    expect(text).toContain('Success: 3/3');
    expect(text).toContain('## 1. Table1Model_Extension [CLASS]');
    expect(text).toContain('## 2. Table2Model_Extension [CLASS]');
    expect(text).toContain('## 3. Table3Model_Extension [CLASS]');

    // …and exactly one reader invocation per object, all through the registry.
    expect(vi.mocked(classInfoTool)).toHaveBeenCalledTimes(3);
  });

  it('mixes object types in one call, each with the right argument key', async () => {
    vi.mocked(classInfoTool).mockClear();
    vi.mocked(tableInfoTool).mockClear();

    const result = await getObjectInfoTool(
      req({
        objects: [
          { objectType: 'class', objectName: 'SalesFormLetter' },
          { objectType: 'table', objectName: 'CustTable' },
        ],
      }),
      context,
    );

    const text = result.content[0].text;
    expect(text).toContain('class:SalesFormLetter');
    expect(text).toContain('table:CustTable');
    expect(vi.mocked(classInfoTool).mock.calls[0][0].params.arguments).toEqual({ className: 'SalesFormLetter' });
    expect(vi.mocked(tableInfoTool).mock.calls[0][0].params.arguments).toEqual({ tableName: 'CustTable' });
  });

  it('reports per-object failures without failing the whole batch', async () => {
    const result = await getObjectInfoTool(
      req({
        objects: [
          { objectType: 'table', objectName: 'CustTable' },
          { objectType: 'enum', objectName: 'NoSuchEnum' },
        ],
      }),
      context,
    );

    expect(result.isError).toBeFalsy(); // one success → the call is not an error
    const text = result.content[0].text;
    expect(text).toContain('Success: 1/2');
    expect(text).toContain('NoSuchEnum [ENUM] ❌');
  });

  it('appends the shared not-found guidance (and forbids filesystem scanning) per object', async () => {
    const result = await getObjectInfoTool(
      req({ objects: [{ objectType: 'enum', objectName: 'NoSuchEnum' }, { objectType: 'enum', objectName: 'AlsoMissing' }] }),
      context,
    );

    const text = result.content[0].text;
    expect(result.isError).toBe(true); // zero successes → error
    expect(text).toContain('enum not found');
    expect(text).toMatch(/search.*batch_search|update_symbol_index/i);
    expect(text).toMatch(/D365FO_CUSTOM_PACKAGES_PATH/);
    expect(text).toMatch(/Get-ChildItem|Select-String/);
  });

  it('applies top-level options to every entry, with per-entry options winning', async () => {
    const result = await getObjectInfoTool(
      req({
        compact: false,
        objects: [
          { objectType: 'class', objectName: 'A' },
          { objectType: 'class', objectName: 'B', options: { compact: true } },
        ],
      }),
      context,
    );

    const text = result.content[0].text;
    expect(text).toContain('class:A:compact=false');
    expect(text).toContain('class:B:compact=true');
  });

  it('rejects an empty objects[] and more than 10 entries', async () => {
    const empty = await getObjectInfoTool(req({ objects: [] }), context);
    expect(empty.isError).toBe(true);
    expect(empty.content[0].text).toContain('invalid arguments');

    const tooMany = await getObjectInfoTool(
      req({ objects: Array.from({ length: 11 }, (_, i) => ({ objectType: 'table', objectName: `T${i}` })) }),
      context,
    );
    expect(tooMany.isError).toBe(true);
  });

  it('rejects a call that has neither {objectType, name} nor objects[]', async () => {
    const result = await getObjectInfoTool(req({}), context);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('invalid arguments');
  });

  it('takes the entry name only as objectName — no tolerated `name` alias', async () => {
    const result = await getObjectInfoTool(
      req({ objects: [{ objectType: 'table', name: 'CustTable' }] }),
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('objectName');
  });
});

describe('get_object_info — single-object form is unchanged (compatibility guarantee)', () => {
  it('returns the plain reader result, without the batch header or numbered sections', async () => {
    const result = await getObjectInfoTool(req({ objectType: 'table', name: 'CustTable' }), context);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('table:CustTable');
    expect(result.content[0].text).not.toContain('Fetched:');
    expect(result.content[0].text).not.toContain('## 1.');
  });

  it('a one-element objects[] is the exact shorthand equivalent of the single form', async () => {
    const single = await getObjectInfoTool(req({ objectType: 'table', name: 'CustTable' }), context);
    const plural = await getObjectInfoTool(req({ objects: [{ objectType: 'table', objectName: 'CustTable' }] }), context);

    expect(plural.content[0].text).toBe(single.content[0].text);
  });

  it('still forwards the top-level class shortcuts into the reader options', async () => {
    const result = await getObjectInfoTool(req({ objectType: 'class', name: 'SalesFormLetter', compact: false }), context);
    expect(result.content[0].text).toBe('class:SalesFormLetter:compact=false');
  });
});

describe('get_object_info — published surface', () => {
  it('batch_get_info is no longer published; get_object_info advertises objects[]', () => {
    const names = toolSchemas.map(t => t.name);
    expect(names).not.toContain('batch_get_info');

    const schema = toolSchemas.find(t => t.name === 'get_object_info')!;
    const props = (schema.inputSchema as any).properties;
    expect(props.objects).toBeDefined();
    expect(props.objects.maxItems).toBe(10);
    expect(props.objects.items.required).toEqual(['objectType', 'objectName']);
    expect(props.objects.items.properties.name).toBeUndefined();
    // Neither form may be declared globally required — the tool accepts both.
    expect((schema.inputSchema as any).required).toBeUndefined();
    expect(schema.description).not.toContain('batch_get_info(');
  });

  it('labels a plural call in the progress message', () => {
    const msg = buildProgressMessage('get_object_info', {
      objects: [{ objectType: 'class', objectName: 'A' }, { objectType: 'class', objectName: 'B' }],
    });
    expect(msg).toContain('2 objects');
    expect(msg).toContain('A, B');

    expect(buildProgressMessage('get_object_info', { objectType: 'table', name: 'CustTable' }))
      .toContain('table CustTable');
  });
});
