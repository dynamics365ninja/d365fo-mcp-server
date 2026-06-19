import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../src/tools/xppKnowledge', () => ({
  xppKnowledgeTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'knowledge' }] })),
}));
vi.mock('../../src/tools/d365foErrorHelp', () => ({
  d365foErrorHelpTool: vi.fn((_r: any) => ({ content: [{ type: 'text', text: 'error' }] })),
}));

import { getKnowledgeTool } from '../../src/tools/getKnowledge';
import { xppKnowledgeTool } from '../../src/tools/xppKnowledge';
import { d365foErrorHelpTool } from '../../src/tools/d365foErrorHelp';

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
});
