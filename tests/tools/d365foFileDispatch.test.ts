/**
 * d365fo_file dispatcher tests — params-merge back-compat contract.
 *
 * The published schema advertises op-specific values inside a single `params`
 * object; legacy callers pass them flat. The dispatcher must accept BOTH,
 * flatten `params` before forwarding (nested wins on collision), and never
 * forward the `params` wrapper itself. Underlying handlers are mocked — these
 * tests assert only the dispatcher's own routing + merging.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../src/tools/write/createD365File', () => ({
  handleCreateD365File: vi.fn(async (_r: any) => ({ content: [{ type: 'text', text: 'create' }] })),
}));
vi.mock('../../src/tools/write/modifyD365File', () => ({
  modifyD365FileTool: vi.fn(async (_r: any) => ({ content: [{ type: 'text', text: 'modify' }] })),
}));
vi.mock('../../src/tools/xml/generateD365Xml', () => ({
  handleGenerateD365Xml: vi.fn(async (_r: any) => ({ content: [{ type: 'text', text: 'generate' }] })),
}));

import { d365foFileTool } from '../../src/tools/d365foFile';
import { handleCreateD365File } from '../../src/tools/write/createD365File';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import { handleGenerateD365Xml } from '../../src/tools/xml/generateD365Xml';

const ctx: any = { symbolIndex: {} };
const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'd365fo_file', arguments: args },
});
const argsOf = (mock: any) => mock.mock.calls[0][0].params.arguments;

beforeEach(() => vi.clearAllMocks());

describe('d365fo_file dispatcher — params merge', () => {
  it('flattens nested params into the forwarded args (modify)', async () => {
    await d365foFileTool(req({
      action: 'modify',
      objectType: 'table',
      objectName: 'MyTable',
      operation: 'add-index',
      params: { indexName: 'ItemIdx', indexFields: [{ fieldName: 'ItemId' }] },
    }), ctx);
    expect(modifyD365FileTool).toHaveBeenCalledOnce();
    const fwd = argsOf(modifyD365FileTool);
    expect(fwd).toMatchObject({
      objectType: 'table',
      objectName: 'MyTable',
      operation: 'add-index',
      indexName: 'ItemIdx',
      indexFields: [{ fieldName: 'ItemId' }],
    });
    expect(fwd.params).toBeUndefined();
    expect(fwd.action).toBeUndefined();
  });

  it('keeps accepting legacy flat op params (modify)', async () => {
    await d365foFileTool(req({
      action: 'modify',
      objectType: 'class',
      objectName: 'MyClass',
      operation: 'add-method',
      methodName: 'run',
      sourceCode: 'public void run() {}',
    }), ctx);
    const fwd = argsOf(modifyD365FileTool);
    expect(fwd).toMatchObject({ methodName: 'run', sourceCode: 'public void run() {}' });
  });

  it('nested params win over flat duplicates', async () => {
    await d365foFileTool(req({
      action: 'modify',
      objectType: 'enum',
      objectName: 'MyEnum',
      operation: 'add-enum-value',
      enumValueName: 'FlatValue',
      params: { enumValueName: 'NestedValue' },
    }), ctx);
    expect(argsOf(modifyD365FileTool).enumValueName).toBe('NestedValue');
  });

  it('merges params for action=create and routes to the create handler', async () => {
    await d365foFileTool(req({
      action: 'create',
      objectType: 'class',
      objectName: 'MyClass',
      params: { sourceCode: 'class MyClass {}' },
    }), ctx);
    expect(handleCreateD365File).toHaveBeenCalledOnce();
    expect(modifyD365FileTool).not.toHaveBeenCalled();
    const fwd = argsOf(handleCreateD365File);
    expect(fwd.sourceCode).toBe('class MyClass {}');
    expect(fwd.params).toBeUndefined();
  });

  it('routes action=generate and passes args through untouched when params is absent', async () => {
    await d365foFileTool(req({ action: 'generate', objectType: 'enum', objectName: 'MyEnum' }), ctx);
    expect(handleGenerateD365Xml).toHaveBeenCalledOnce();
    expect(argsOf(handleGenerateD365Xml)).toEqual({ objectType: 'enum', objectName: 'MyEnum' });
  });

  it('rejects a non-object params with a friendly error', async () => {
    const r: any = await d365foFileTool(req({
      action: 'modify',
      objectType: 'table',
      objectName: 'MyTable',
      operation: 'add-index',
      params: 'indexName=ItemIdx',
    }), ctx);
    expect(r.isError).toBe(true);
    expect(modifyD365FileTool).not.toHaveBeenCalled();
  });
});
