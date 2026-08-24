import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../src/tools/knowledge/xppKnowledge', () => ({
  xppKnowledgeTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'knowledge' }] })),
}));
vi.mock('../../src/tools/knowledge/d365foErrorHelp', () => ({
  d365foErrorHelpTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'error' }] })),
}));

import { getKnowledgeTool } from '../../src/tools/knowledge/getKnowledge';
import { xppKnowledgeTool } from '../../src/tools/knowledge/xppKnowledge';
import { d365foErrorHelpTool } from '../../src/tools/knowledge/d365foErrorHelp';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'get_knowledge', arguments: args },
});

beforeEach(() => vi.clearAllMocks());

describe('get_knowledge kind inference', () => {
  it('routes explicit kind=error to the error-help handler', async () => {
    await getKnowledgeTool(req({ kind: 'error', errorText: 'SYS10028' }));
    expect(d365foErrorHelpTool).toHaveBeenCalledOnce();
    expect(xppKnowledgeTool).not.toHaveBeenCalled();
  });

  it('infers kind=knowledge from a bare topic', async () => {
    await getKnowledgeTool(req({ topic: 'select-statement' }));
    expect(xppKnowledgeTool).toHaveBeenCalledOnce();
    expect(d365foErrorHelpTool).not.toHaveBeenCalled();
  });

  it('infers kind=error from errorText when kind omitted', async () => {
    await getKnowledgeTool(req({ errorText: 'BPFrameworkFatalException' }));
    expect(d365foErrorHelpTool).toHaveBeenCalledOnce();
    expect(xppKnowledgeTool).not.toHaveBeenCalled();
  });

  it('defaults to knowledge for a bare list-all call', async () => {
    await getKnowledgeTool(req({}));
    expect(xppKnowledgeTool).toHaveBeenCalledOnce();
  });

  it('remaps query → topic for the knowledge handler', async () => {
    await getKnowledgeTool(req({ query: 'X++ static variable lifetime' }));
    expect(xppKnowledgeTool).toHaveBeenCalledOnce();
    expect((xppKnowledgeTool as any).mock.calls[0][0].params.arguments).toMatchObject({
      topic: 'X++ static variable lifetime',
    });
  });

  it('remaps q / search aliases to topic too', async () => {
    await getKnowledgeTool(req({ search: 'number sequences' }));
    expect((xppKnowledgeTool as any).mock.calls[0][0].params.arguments).toMatchObject({ topic: 'number sequences' });
  });

  it('does not override an explicit topic with query', async () => {
    await getKnowledgeTool(req({ topic: 'CoC', query: 'ignored' }));
    expect((xppKnowledgeTool as any).mock.calls[0][0].params.arguments.topic).toBe('CoC');
  });
});

describe('get_knowledge topics[] — several lookups in one call', () => {
  const textOf = (r: any) => r.content.map((c: any) => c.text).join('');

  it('answers every op-spec topic in one response', async () => {
    const r = await getKnowledgeTool(req({ kind: 'op-spec', topics: ['add-field', 'add-index'] }));
    const text = textOf(r);
    expect(text).toContain("operation 'add-field'");
    expect(text).toContain("operation 'add-index'");
  });

  it('fans the knowledge kind out and labels each answer', async () => {
    const r = await getKnowledgeTool(req({ topics: ['select-statement', 'coc-authoring'] }));
    expect(xppKnowledgeTool).toHaveBeenCalledTimes(2);
    expect((xppKnowledgeTool as any).mock.calls[0][0].params.arguments.topic).toBe('select-statement');
    expect((xppKnowledgeTool as any).mock.calls[1][0].params.arguments.topic).toBe('coc-authoring');
    // Each block is headed by its topic, or a two-topic answer is unattributable.
    expect(textOf(r)).toContain('## select-statement');
    expect(textOf(r)).toContain('## coc-authoring');
  });

  it('never forwards topics[] to the underlying handler', async () => {
    await getKnowledgeTool(req({ topics: ['CoC'] }));
    expect((xppKnowledgeTool as any).mock.calls[0][0].params.arguments.topics).toBeUndefined();
  });

  it('caps the batch so one call cannot return everything', async () => {
    await getKnowledgeTool(req({ topics: Array.from({ length: 25 }, (_, i) => 't' + i) }));
    expect(xppKnowledgeTool).toHaveBeenCalledTimes(10);
  });

  it('falls back to the single-topic path rather than failing on a bad shape', async () => {
    // A bare string belongs in `topic`; rejecting it would just recreate the loop.
    await getKnowledgeTool(req({ topics: 'CoC', topic: 'CoC' }));
    expect(xppKnowledgeTool).toHaveBeenCalledOnce();
    expect((xppKnowledgeTool as any).mock.calls[0][0].params.arguments.topic).toBe('CoC');
  });

  it('ignores empty entries and an empty array', async () => {
    await getKnowledgeTool(req({ topics: ['', '   '], topic: 'CoC' }));
    expect(xppKnowledgeTool).toHaveBeenCalledOnce();
    expect((xppKnowledgeTool as any).mock.calls[0][0].params.arguments.topic).toBe('CoC');
  });
});

describe('topics[] with an unusable shape answers in words, not a validator dump', () => {
  // The fallback to the single-topic path is only graceful when a `topic` was ALSO
  // supplied. It was not: `topics: "CoC"` alone reached xppKnowledgeTool with topic
  // undefined and came back as a raw zod dump naming a parameter the caller never
  // passed — the same unusable shape #937 fixed for d365fo_file.
  const textOf = (r: any) => r.content.map((c: any) => c.text).join('');

  it('names the shape it got and both valid forms', async () => {
    const r: any = await getKnowledgeTool(req({ kind: 'knowledge', topics: 'CoC' }));
    expect(r.isError).toBe(true);
    const t = textOf(r);
    expect(t).toContain('must be an array of non-empty strings');
    expect(t).toContain('got a string');
    expect(t).toContain('topic: "select-statement"');
    expect(t).not.toContain('invalid_type');
    expect(xppKnowledgeTool).not.toHaveBeenCalled();
  });

  it('reports how many entries were unusable', async () => {
    const r: any = await getKnowledgeTool(req({ kind: 'knowledge', topics: [1, null] }));
    expect(textOf(r)).toContain('2 entries');
  });

  it('rejects an empty array rather than silently answering nothing', async () => {
    const r: any = await getKnowledgeTool(req({ kind: 'knowledge', topics: [] }));
    expect(r.isError).toBe(true);
  });

  it('still falls through when a usable topic came along', async () => {
    await getKnowledgeTool(req({ kind: 'knowledge', topics: 'CoC', topic: 'CoC' }));
    expect(xppKnowledgeTool).toHaveBeenCalledOnce();
    expect((xppKnowledgeTool as any).mock.calls[0][0].params.arguments.topic).toBe('CoC');
  });
});
