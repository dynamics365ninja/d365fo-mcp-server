/**
 * batch_get_info tests — parallel fan-out to the underlying get_*_info tools.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/tools/classInfo', () => ({
  classInfoTool: vi.fn(async (req: any) => ({
    content: [{ type: 'text', text: `class:${req.params.arguments.className}` }],
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

import { batchGetInfoTool } from '../../src/tools/batchGetInfo';
import { classInfoTool } from '../../src/tools/classInfo';
import { tableInfoTool } from '../../src/tools/tableInfo';

const makeRequest = (objects: unknown): any => ({
  method: 'tools/call',
  params: { name: 'batch_get_info', arguments: { objects } },
});

const context = {} as any;

describe('batch_get_info', () => {
  it('dispatches each object to its info tool with the right argument key', async () => {
    const result = await batchGetInfoTool(
      makeRequest([
        { name: 'SalesFormLetter', type: 'class' },
        { name: 'CustTable', type: 'table' },
      ]),
      context,
    );

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('class:SalesFormLetter');
    expect(text).toContain('table:CustTable');
    expect(text).toContain('Success: 2/2');
    expect(vi.mocked(classInfoTool).mock.calls[0][0].params.arguments).toEqual({ className: 'SalesFormLetter' });
    expect(vi.mocked(tableInfoTool).mock.calls[0][0].params.arguments).toEqual({ tableName: 'CustTable' });
  });

  it('reports per-object failures without failing the whole batch', async () => {
    const result = await batchGetInfoTool(
      makeRequest([
        { name: 'CustTable', type: 'table' },
        { name: 'NoSuchEnum', type: 'enum' },
      ]),
      context,
    );

    expect(result.isError).toBeFalsy(); // one success → batch is not an error
    const text = result.content[0].text;
    expect(text).toContain('Success: 1/2');
    expect(text).toContain('NoSuchEnum [ENUM] ❌');
  });

  it('appends actionable resolution guidance (and forbids filesystem scanning) on a not-found result', async () => {
    const result = await batchGetInfoTool(
      makeRequest([{ name: 'NoSuchEnum', type: 'enum' }]),
      context,
    );

    const text = result.content[0].text;
    // The reader's own "not found" is preserved …
    expect(text).toContain('enum not found');
    // … and the shared guidance is appended: steer to search/update_symbol_index …
    expect(text).toMatch(/search.*batch_search|update_symbol_index/i);
    expect(text).toMatch(/D365FO_CUSTOM_PACKAGES_PATH/);
    // … and explicitly forbid Get-ChildItem / Select-String filesystem scanning.
    expect(text).toMatch(/Get-ChildItem|Select-String/);
  });

  it('rejects invalid arguments', async () => {
    const result = await batchGetInfoTool(makeRequest([]), context);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('invalid arguments');
  });

  it('rejects more than 10 objects', async () => {
    const objects = Array.from({ length: 11 }, (_, i) => ({ name: `T${i}`, type: 'table' }));
    const result = await batchGetInfoTool(makeRequest(objects), context);
    expect(result.isError).toBe(true);
  });
});
