/**
 * A batch answers ONCE about the file it wrote.
 *
 * Measured on a 2-operation batch against the real VM (fm-mcp, 2026-08-25):
 * every entry emitted its own "✅ Verified: on disk (N bytes)", its own
 * "🔎 Symbol index updated in place", its own "Next: build_d365fo_project…" and
 * its own "More edits? Send them together" — and re-ran the stat() and the
 * symbol-index re-parse of the SAME file to produce them. A 20-operation batch
 * therefore repeated ~250 bytes of trailer twenty times and verified one file
 * twenty times.
 *
 * They all answer a question about the FILE, not about the operation, so the
 * batch runs them once per distinct target after the loop and prints one block.
 *
 * The best-practice advisory is the same story with a bigger paragraph: three
 * add-field entries printed the identical 350-char
 * BPErrorTableFieldNotInFieldGroup text three times, including for fields whose
 * group entry sat two lines below in that very call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockModify, mockUpsert, mockVerify } = vi.hoisted(() => ({
  mockModify: vi.fn(),
  mockUpsert: vi.fn(async () => '\n🔎 Symbol index updated in place — no update_symbol_index call needed.'),
  mockVerify: vi.fn(async () => ({ onDisk: true, bytes: 1969 })),
}));

vi.mock('../../src/tools/write/modifyD365File', () => ({ modifyD365FileTool: mockModify }));
vi.mock('../../src/tools/write/createD365File', () => ({ handleCreateD365File: vi.fn() }));
vi.mock('../../src/tools/xml/generateD365Xml', () => ({ handleGenerateD365Xml: vi.fn() }));
vi.mock('../../src/tools/write/inlineIndexUpsert', () => ({ upsertWrittenFileIntoIndex: mockUpsert }));
vi.mock('../../src/tools/write/inlineWriteVerification', async (orig) => {
  const actual = await orig<typeof import('../../src/tools/write/inlineWriteVerification')>();
  return { ...actual, verifyWrittenFile: mockVerify };
});
vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    getProjectPath: vi.fn(async () => null),
    getModelName: vi.fn(() => 'MyModel'),
    getProjectsForModel: vi.fn(() => []),
  })),
}));

import { d365foFileTool } from '../../src/tools/d365foFile';

const ctx = {} as any;
const FILE = 'K:\\PLD\\fm-mcp\\fm-mcp\\AxTable\\ConProbeTbl.xml';

const call = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'd365fo_file', arguments: { action: 'modify', ...args } },
});

const forwarded = () => mockModify.mock.calls.map(c => (c[0] as CallToolRequest).params.arguments as any);
const text = (r: any) => r.content[0].text as string;

beforeEach(() => {
  vi.clearAllMocks();
  mockModify.mockImplementation(async (_req: CallToolRequest, _ctx: unknown, outcome: any) => {
    // What a real entry publishes once it has written: the file it touched.
    if (outcome) {
      outcome.filePath = FILE;
      outcome.objectType = 'table';
      outcome.objectName = 'ConProbeTbl';
      outcome.modelName = 'fm-mcp';
    }
    return { content: [{ type: 'text', text: '✅ applied' }] };
  });
});

describe('one trailer for the whole batch', () => {
  const twoOps = () => d365foFileTool(call({
    objectType: 'table',
    objectName: 'ConProbeTbl',
    operations: [
      { operation: 'add-field', fieldName: 'Amount', fieldType: 'AmountMST' },
      { operation: 'add-field-group', fieldGroupName: 'Overview' },
    ],
  }), ctx);

  it('verifies and re-indexes the file ONCE, not once per operation', async () => {
    await twoOps();
    expect(mockModify).toHaveBeenCalledTimes(2);
    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it('prints exactly one verification, one index line and one Next:', async () => {
    const t = text(await twoOps());
    expect(t.match(/✅ Verified:/g) ?? []).toHaveLength(1);
    expect(t.match(/Symbol index updated in place/g) ?? []).toHaveLength(1);
    expect(t.match(/^Next: /gm) ?? []).toHaveLength(1);
  });

  it('names build_d365fo_project(bpCheck:true) — one call, not verify + run_bp_check', async () => {
    const t = text(await twoOps());
    expect(t).toContain('build_d365fo_project(bpCheck:true)');
    expect(t).not.toContain('verify_d365fo_project');
    expect(t).not.toContain('run_bp_check');
  });

  it('does not tell a batch to send its edits as a batch', async () => {
    expect(text(await twoOps())).not.toMatch(/Send them together/);
  });

  it('verifies each distinct file when a batch spans two objects', async () => {
    let n = 0;
    mockModify.mockImplementation(async (_r: CallToolRequest, _c: unknown, outcome: any) => {
      n += 1;
      if (outcome) {
        outcome.filePath = `K:\\PLD\\m\\m\\AxTable\\T${n}.xml`;
        outcome.objectType = 'table';
        outcome.objectName = `T${n}`;
      }
      return { content: [{ type: 'text', text: '✅ applied' }] };
    });

    await d365foFileTool(call({
      objectType: 'table',
      operations: [
        { operation: 'add-field', objectName: 'T1', fieldName: 'A', fieldType: 'Num' },
        { operation: 'add-field', objectName: 'T2', fieldName: 'B', fieldType: 'Num' },
      ],
    }), ctx);

    expect(mockVerify).toHaveBeenCalledTimes(2);
  });

  it('emits no trailer at all when nothing was written', async () => {
    mockModify.mockImplementation(async () => ({ content: [{ type: 'text', text: '❌ nope' }], isError: true }));
    const t = text(await d365foFileTool(call({
      objectType: 'table', objectName: 'ConProbeTbl',
      operations: [{ operation: 'add-field', fieldName: 'A' }],
    }), ctx));

    expect(t).not.toContain('Verified');
    expect(t).not.toContain('Next: build_d365fo_project');
  });
});

describe('the shared best-practice advisory is decided by the batch', () => {
  it('elects exactly one entry to print it, and lists every field it covers', async () => {
    await d365foFileTool(call({
      objectType: 'table',
      objectName: 'ConProbeTbl',
      operations: [
        { operation: 'add-field', fieldName: 'A', fieldType: 'Num' },
        { operation: 'add-field', fieldName: 'B', fieldType: 'Num' },
        { operation: 'add-field', fieldName: 'C', fieldType: 'Num' },
      ],
    }), ctx);

    const advice = forwarded().map(a => a.batchAdvice);
    expect(advice.map(a => a.suppressFieldGroupNote)).toEqual([false, true, true]);
    expect(advice[0].fieldGroupNoteFields).toEqual(['A', 'B', 'C']);
  });

  it('says nothing at all when every field already has its group entry here', async () => {
    await d365foFileTool(call({
      objectType: 'table-extension',
      objectName: 'CustTable.CtsoExtension',
      operations: [
        { operation: 'add-field', fieldName: 'Tier', fieldType: 'Num' },
        { operation: 'add-field-to-field-group', fieldName: 'Tier', fieldGroupName: 'Admin' },
      ],
    }), ctx);

    // No entry is elected: every add-field is already covered, so the advisory
    // has nothing to be about.
    expect(forwarded().every(a => a.batchAdvice.suppressFieldGroupNote)).toBe(true);
  });

  it('still advises about the fields the batch did NOT group', async () => {
    await d365foFileTool(call({
      objectType: 'table',
      objectName: 'ConProbeTbl',
      operations: [
        { operation: 'add-field', fieldName: 'Grouped', fieldType: 'Num' },
        { operation: 'add-field', fieldName: 'Loose', fieldType: 'Num' },
        { operation: 'add-field-to-field-group', fieldName: 'Grouped', fieldGroupName: 'Overview' },
      ],
    }), ctx);

    const advice = forwarded().map(a => a.batchAdvice);
    expect(advice[0].suppressFieldGroupNote).toBe(true);   // Grouped: covered here
    expect(advice[1].suppressFieldGroupNote).toBe(false);  // Loose: not
    expect(advice[1].fieldGroupNoteFields).toEqual(['Loose']);
  });

  it('reads the field name out of a nested `params` too', async () => {
    await d365foFileTool(call({
      objectType: 'table',
      objectName: 'ConProbeTbl',
      operations: [
        { operation: 'add-field', params: { fieldName: 'Tier', fieldType: 'Num' } },
        { operation: 'add-field-to-field-group', params: { fieldName: 'Tier', fieldGroupName: 'Admin' } },
      ],
    }), ctx);

    expect(forwarded().every(a => a.batchAdvice.suppressFieldGroupNote)).toBe(true);
  });
});
