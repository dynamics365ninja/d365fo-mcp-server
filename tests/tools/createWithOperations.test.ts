/**
 * 16 of the create -> modify sequences in the sampled sessions targeted the object
 * create had just made: a table is created, then its field group, index or extra
 * fields arrive one MCP call at a time.
 *
 * The one thing this must never do is guess the target. create applies prefix and
 * casing normalization, so the name that was WRITTEN can differ from the one that
 * was asked for; a chained edit aimed at the requested name would land on a
 * different object — or on nothing — while reporting success.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockCreate, mockModify } = vi.hoisted(() => ({ mockCreate: vi.fn(), mockModify: vi.fn() }));

vi.mock('../../src/tools/write/createD365File', () => ({ handleCreateD365File: mockCreate }));
vi.mock('../../src/tools/write/modifyD365File', () => ({ modifyD365FileTool: mockModify }));
vi.mock('../../src/tools/write/deleteD365File', () => ({ handleDeleteD365File: vi.fn() }));
vi.mock('../../src/tools/xml/generateD365Xml', () => ({ handleGenerateD365Xml: vi.fn() }));

import { d365foFileTool } from '../../src/tools/d365foFile';

const ctx = {} as any;
const call = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call', params: { name: 'd365fo_file', arguments: args },
});
const text = (r: any) => r.content[0].text as string;
const forwarded = () => mockModify.mock.calls.map(c => (c[0] as CallToolRequest).params.arguments as any);

/** create that reports the name it actually wrote via the out-parameter. */
const creates = (writtenName: string, opts: { isError?: boolean; report?: boolean } = {}) =>
  mockCreate.mockImplementation(async (_req: any, _ctx: any, outcome: any) => {
    if (opts.report !== false && outcome) {
      outcome.finalObjectName = writtenName;
      outcome.filePath = 'K:/pkg/' + writtenName + '.xml';
    }
    return { content: [{ type: 'text', text: 'created ' + writtenName }], ...(opts.isError ? { isError: true } : {}) };
  });

const OPS = [{ operation: 'add-field-group', fieldGroupName: 'Grp' }, { operation: 'add-index', indexName: 'Idx' }];

beforeEach(() => { vi.resetAllMocks(); });

describe('d365fo_file(action="create") with operations[]', () => {
  it('runs the operations against the name the object ACTUALLY got', async () => {
    // Asked for MyTable, written as ConMyTable — the prefix is the whole point.
    creates('ConMyTable');
    mockModify.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    const r: any = await d365foFileTool(
      call({ action: 'create', objectType: 'table', objectName: 'MyTable', operations: OPS }), ctx);

    expect(mockModify).toHaveBeenCalledTimes(2);
    for (const args of forwarded()) expect(args.objectName).toBe('ConMyTable');
    expect(forwarded().map(a => a.operation)).toEqual(['add-field-group', 'add-index']);
    // Both halves of the answer survive.
    expect(text(r)).toContain('created ConMyTable');
    expect(text(r)).toContain('2/2 operation(s) applied');
    expect(r.isError).toBeFalsy();
  });

  it('does not forward operations[] into the create itself', async () => {
    creates('ConMyTable');
    mockModify.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    await d365foFileTool(call({ action: 'create', objectType: 'table', objectName: 'MyTable', operations: OPS }), ctx);
    expect((mockCreate.mock.calls[0][0] as CallToolRequest).params.arguments).not.toHaveProperty('operations');
  });

  it('attempts nothing when the create failed', async () => {
    creates('ConMyTable', { isError: true });
    const r: any = await d365foFileTool(
      call({ action: 'create', objectType: 'table', objectName: 'MyTable', operations: OPS }), ctx);

    expect(mockModify).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('2 operation(s) were NOT attempted');
  });

  it('refuses to guess the target when create reports no final name', async () => {
    // Fails safe: one extra round trip, never an edit aimed at the wrong object.
    creates('ConMyTable', { report: false });
    const r: any = await d365foFileTool(
      call({ action: 'create', objectType: 'table', objectName: 'MyTable', operations: OPS }), ctx);

    expect(mockModify).not.toHaveBeenCalled();
    expect(text(r)).toContain('NOT attempted');
    expect(text(r)).toContain('without guessing');
    // The create itself still succeeded, and says so.
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('created ConMyTable');
  });

  it('reports isError when an operation fails, and keeps the create verdict visible', async () => {
    creates('ConMyTable');
    mockModify
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'boom' }], isError: true });

    const r: any = await d365foFileTool(
      call({ action: 'create', objectType: 'table', objectName: 'MyTable', operations: OPS }), ctx);

    expect(r.isError).toBe(true);
    expect(text(r)).toContain('created ConMyTable');
    expect(text(r)).toContain('1/2 operation(s) applied');
  });

  it('leaves a plain create untouched', async () => {
    creates('ConMyTable');
    const r: any = await d365foFileTool(call({ action: 'create', objectType: 'table', objectName: 'MyTable' }), ctx);
    expect(mockModify).not.toHaveBeenCalled();
    expect(text(r)).toBe('created ConMyTable');
  });

  it('treats an empty operations[] as a plain create', async () => {
    creates('ConMyTable');
    const r: any = await d365foFileTool(
      call({ action: 'create', objectType: 'table', objectName: 'MyTable', operations: [] }), ctx);
    expect(mockModify).not.toHaveBeenCalled();
    expect(text(r)).toBe('created ConMyTable');
  });
});
