/**
 * get_method dispatcher tests — routing by `include` and the "both" merge rule.
 *
 * The two underlying handlers are mocked so these tests assert ONLY the
 * dispatcher's own routing + result-merging logic. The key regression here:
 * when a member (e.g. classDeclaration) has no parseable signature, the
 * signature handler returns isError, but the source handler succeeds — the
 * merged "both" result must NOT surface that false-negative.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../src/tools/knowledge/methodSignature', () => ({
  getMethodSignatureTool: vi.fn(),
}));
vi.mock('../../src/tools/readers/getMethodSource', () => ({
  getMethodSourceTool: vi.fn(),
}));

import { getMethodTool } from '../../src/tools/readers/getMethod';
import { getMethodSignatureTool } from '../../src/tools/knowledge/methodSignature';
import { getMethodSourceTool } from '../../src/tools/readers/getMethodSource';

const sigMock = getMethodSignatureTool as any;
const srcMock = getMethodSourceTool as any;

const ctx: any = { symbolIndex: {} };
const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'get_method', arguments: args },
});
const ok = (text: string) => ({ content: [{ type: 'text', text }] });
const err = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

beforeEach(() => vi.clearAllMocks());

describe('get_method dispatcher', () => {
  it('include=signature → only the signature handler', async () => {
    sigMock.mockResolvedValue(ok('sig'));
    await getMethodTool(req({ className: 'C', methodName: 'm', include: 'signature' }), ctx);
    expect(getMethodSignatureTool).toHaveBeenCalledOnce();
    expect(getMethodSourceTool).not.toHaveBeenCalled();
  });

  it('include=source → only the source handler', async () => {
    srcMock.mockResolvedValue(ok('src'));
    await getMethodTool(req({ className: 'C', methodName: 'm', include: 'source' }), ctx);
    expect(getMethodSourceTool).toHaveBeenCalledOnce();
    expect(getMethodSignatureTool).not.toHaveBeenCalled();
  });

  it('missing className → friendly error, no handler call', async () => {
    const r: any = await getMethodTool(req({ methodName: 'm' }), ctx);
    expect(r.isError).toBe(true);
    expect(getMethodSignatureTool).not.toHaveBeenCalled();
    expect(getMethodSourceTool).not.toHaveBeenCalled();
  });

  it('both: concatenates when both succeed', async () => {
    sigMock.mockResolvedValue(ok('SIG'));
    srcMock.mockResolvedValue(ok('SRC'));
    const r: any = await getMethodTool(req({ className: 'C', methodName: 'm' }), ctx);
    expect(r.isError).toBe(false);
    expect(r.content.map((c: any) => c.text)).toEqual(['SIG', 'SRC']);
  });

  it('both: source success suppresses a signature-only failure (classDeclaration case)', async () => {
    sigMock.mockResolvedValue(err('❌ not found / Delegate methods'));
    srcMock.mockResolvedValue(ok('## C.classDeclaration\n_Source: C# bridge_'));
    const r: any = await getMethodTool(req({ className: 'C', methodName: 'classDeclaration' }), ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toHaveLength(1);
    expect(r.content[0].text).toContain('classDeclaration');
    expect(r.content[0].text).not.toContain('Delegate methods');
  });

  it('both: when both fail, returns the source error', async () => {
    sigMock.mockResolvedValue(err('sig error'));
    srcMock.mockResolvedValue(err('src not found — use get_object_info'));
    const r: any = await getMethodTool(req({ className: 'C', methodName: 'nope' }), ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toHaveLength(1);
    expect(r.content[0].text).toContain('get_object_info');
  });
});
