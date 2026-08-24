/**
 * One d365fo_file call must not be able to return a context window.
 *
 * d365fo_file is 'uncapped' in TOOL_CAP_SIZES on purpose — a truncated create
 * loses the file path — so nothing downstream trims a batch report. With
 * operations[] concatenating up to 20 full per-operation responses, and per-op
 * text that can run long (replace-code echoes the changed region, an inline
 * bpCheck report is itself uncapped), a single call measured at 1,000,573 chars
 * — roughly 278k tokens. Each SECTION is bounded instead of the whole response,
 * so the verdict of every operation survives.
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
const call = (args: Record<string, unknown>): CallToolRequest =>
  ({ method: 'tools/call', params: { name: 'd365fo_file', arguments: args } });
const text = (r: any) => (r?.content ?? []).map((c: any) => c?.text ?? '').join('');

/** Per-op output of the size a replace-code echo or an inline BP report reaches. */
const HUGE = 'x'.repeat(50_000);
const ops = (n: number) => Array.from({ length: n }, (_, i) => ({ operation: 'replace-code', tag: i }));

beforeEach(() => {
  vi.resetAllMocks();
  mockCreate.mockImplementation(async (_r: any, _c: any, outcome: any) => {
    if (outcome) { outcome.finalObjectName = 'ConProbe'; outcome.filePath = 'K:/p/ConProbe.xml'; }
    return { content: [{ type: 'text', text: 'created ConProbe' }] };
  });
});

describe('a batch report is bounded per operation', () => {
  it('caps a 20-operation modify that would otherwise return ~1 MB', async () => {
    mockModify.mockResolvedValue({ content: [{ type: 'text', text: HUGE }] });

    const r: any = await d365foFileTool(
      call({ action: 'modify', objectType: 'table', objectName: 'ConProbe', operations: ops(20) }), ctx);

    const size = text(r).length;
    // 20 × 50k was 1,000,573 chars before; 20 sections of ~4k plus framing now.
    expect(size).toBeLessThan(120_000);
    expect(text(r)).toContain('truncated at 4000 chars');
    // The write is not what was truncated, and the reply has to say so.
    expect(text(r)).toContain('The operation itself is unaffected.');
  });

  it('keeps EVERY operation verdict — the reason the cap is per section', async () => {
    mockModify.mockResolvedValue({ content: [{ type: 'text', text: HUGE }] });

    const r: any = await d365foFileTool(
      call({ action: 'modify', objectType: 'table', objectName: 'ConProbe', operations: ops(20) }), ctx);

    const t = text(r);
    // A whole-response tail cut would have deleted the last sections outright.
    expect(t).toContain('### ✅ #1 replace-code');
    expect(t).toContain('### ✅ #20 replace-code');
    expect(t).toContain('20/20 operation(s) applied');
  });

  it('leaves an ordinary operation untouched', async () => {
    const small = '✅ Field added.\nFile: K:/p/ConProbe.xml';
    mockModify.mockResolvedValue({ content: [{ type: 'text', text: small }] });

    const r: any = await d365foFileTool(
      call({ action: 'modify', objectType: 'table', objectName: 'ConProbe', operations: ops(3) }), ctx);

    expect(text(r)).toContain(small);
    expect(text(r)).not.toContain('truncated at');
  });

  it('bounds the create path too, where the batch rides along with the create output', async () => {
    mockModify.mockResolvedValue({ content: [{ type: 'text', text: HUGE }] });

    const r: any = await d365foFileTool(
      call({ action: 'create', objectType: 'table', objectName: 'Probe', operations: ops(20) }), ctx);

    expect(text(r).length).toBeLessThan(120_000);
    // The create's own answer is never the thing that gets cut.
    expect(text(r)).toContain('created ConProbe');
  });
});
