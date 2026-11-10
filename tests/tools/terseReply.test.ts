/**
 * `params.terse` — a create / modify reply cut down to status, path and warnings.
 *
 * Two halves. The first runs the post-processing pass over reply texts in the
 * shapes the writers really compose (createD365File.ts, modifyD365File.ts,
 * runModifyBatch) and pins what goes and what must stay. The second drives
 * d365fo_file itself with the writers mocked, to pin the wiring: the flag is
 * accepted flat or in `params`, never reaches a writer, leaves an error reply
 * alone, and changes nothing at all when it is absent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockModify, mockCreate, mockUpsert, mockVerify } = vi.hoisted(() => ({
  mockModify: vi.fn(),
  mockCreate: vi.fn(),
  mockUpsert: vi.fn(async () => '\n🔎 Symbol index updated in place — no update_symbol_index call needed.'),
  mockVerify: vi.fn(async () => ({ onDisk: true, bytes: 1969 })),
}));

vi.mock('../../src/tools/write/modifyD365File', () => ({ modifyD365FileTool: mockModify }));
vi.mock('../../src/tools/write/createD365File', () => ({ handleCreateD365File: mockCreate }));
vi.mock('../../src/tools/xml/generateD365Xml', () => ({ handleGenerateD365Xml: vi.fn() }));
vi.mock('../../src/tools/write/inlineIndexUpsert', () => ({ upsertWrittenFileIntoIndex: mockUpsert }));
vi.mock('../../src/tools/write/inlineWriteVerification', async (orig) => {
  const actual = await orig<typeof import('../../src/tools/write/inlineWriteVerification')>();
  return { ...actual, verifyWrittenFile: mockVerify };
});
vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    getProjectPath: vi.fn(async () => null),
    getModelName: vi.fn(() => 'ContosoExt'),
    getProjectsForModel: vi.fn(() => []),
  })),
}));

import { d365foFileTool } from '../../src/tools/d365foFile';
import { terseReplyText, terseResult } from '../../src/tools/write/terseReply';
import { lookupOpSpec } from '../../src/tools/specs/opSpecs';

const CLASS_FILE = 'K:\\PLD\\ContosoExt\\ContosoExt\\AxClass\\ContosoRentHelper.xml';
const TABLE_FILE = 'K:\\PLD\\ContosoExt\\ContosoExt\\AxTable\\ContosoRentEquipmentTable.xml';
const PROJECT = 'K:\\VSProjects\\ContosoExt\\ContosoExt.rnrproj';

const VERIFIED = '✅ Verified: on disk (1969 bytes), referenced by the .rnrproj.';
const INDEXED = '🔎 Symbol index updated in place — no update_symbol_index call needed.';
const NEXT_MODIFY = 'Next: build_d365fo_project(bpCheck:true) — builds and runs the best-practice check in one call.';
const NEXT_CREATE = 'Next: build_d365fo_project(bpCheck:true) — builds AND best-practice-checks in one call.';
const MORE_EDITS = (name: string) =>
  `More edits to "${name}"? Send them together: operations:[{operation:"…"}, …] in ONE modify call.`;
const FURTHER_EDITS = (type: string, name: string) =>
  `Further edits to "${name}" go in ONE call: d365fo_file(action="modify", objectType="${type}", ` +
  `objectName="${name}", operations:[…]) — not one call per edit.`;

/** A clean XML-path create, as createD365File.ts composes it. */
const cleanCreate =
  `✅ Created class ContosoRentHelper\n📁 ${CLASS_FILE}\n` +
  `\n✅ Added to project: ${PROJECT}\n` +
  `\n${VERIFIED}` +
  `\n${INDEXED}` +
  `\n${NEXT_CREATE}\n${FURTHER_EDITS('class', 'ContosoRentHelper')}\nIt exists now — do not create it again.\n`;

/** A clean bridge create. */
const cleanBridgeCreate =
  `✅ Created table 'ContosoRentEquipmentTable' via IMetadataProvider.Create()\n` +
  `📁 ${TABLE_FILE}\n✅ Added to project: ContosoExt.rnrproj\n` +
  `🔧 API: Created AxTable ContosoRentEquipmentTable\n${VERIFIED}\n${INDEXED}`;

/** A clean single-operation modify, as modifyD365File.ts composes it. */
const cleanModify =
  `✅ add-method on class "ContosoRentHelper" — applied via IMetadataProvider.Update()\n\n` +
  `**File:** ${CLASS_FILE}\n` +
  `🔧 API: Method 'validateRate' added` +
  `\n${VERIFIED}\n${INDEXED}` +
  `\n\n${NEXT_MODIFY}\n${MORE_EDITS('ContosoRentHelper')}`;

describe('terseReplyText', () => {
  it('cuts a clean create down to the verdict and the path', () => {
    expect(terseReplyText(cleanCreate)).toBe(`✅ Created class ContosoRentHelper\n📁 ${CLASS_FILE}`);
    expect(terseReplyText(cleanBridgeCreate)).toBe(
      `✅ Created table 'ContosoRentEquipmentTable' via IMetadataProvider.Create()\n📁 ${TABLE_FILE}`,
    );
  });

  it('cuts a clean modify down to the verdict and the file', () => {
    expect(terseReplyText(cleanModify)).toBe(
      `✅ add-method on class "ContosoRentHelper" — applied via IMetadataProvider.Update()\n\n**File:** ${CLASS_FILE}`,
    );
  });

  it('drops the replace-code echo of the changed lines, fence and all', () => {
    const reply =
      `✅ replace-code on class "ContosoRentHelper" — applied via IMetadataProvider.Update()\n\n` +
      `**File:** ${CLASS_FILE}\n🔧 API: Code replaced` +
      `\n\n**Result on disk** (› = changed):\n\`\`\`\n     11 | {\n›    12 |     // TODO: this must NOT fail\n     13 | }\n\`\`\`` +
      `\n\nℹ️ Backup: ${CLASS_FILE}.bak` +
      `\n${VERIFIED}\n${INDEXED}\n\n${NEXT_MODIFY}\n${MORE_EDITS('ContosoRentHelper')}`;

    const short = terseReplyText(reply);
    expect(short).not.toContain('Result on disk');
    expect(short).not.toContain('```');
    expect(short).not.toContain('TODO');
    // The backup path is not a success confirmation, so it stays.
    expect(short).toBe(
      `✅ replace-code on class "ContosoRentHelper" — applied via IMetadataProvider.Update()\n\n` +
      `**File:** ${CLASS_FILE}\n\nℹ️ Backup: ${CLASS_FILE}.bak`,
    );
  });

  it('leaves an echo with no closing fence alone', () => {
    const cut = `✅ replace-code on class "ContosoRentHelper" — applied via IMetadataProvider.Update()\n\n` +
      `**Result on disk** (› = changed):\n\`\`\`\n›    12 |     return true;`;
    expect(terseReplyText(cut)).toBe(cut);
  });

  it('keeps every warning, error and not-done line of a modify', () => {
    const kept = [
      '⚠️ BP: a table field must belong to a field group (BPErrorTableFieldNotInFieldGroup). Send the group entry in the SAME call next time.',
      '❌ Verification: "Label=@ContosoExt:Rate" is NOT in the file after a reported success.',
      'Treat this write as failed and re-read the object — a metadata round trip can drop a value it could not deserialize, and it does so without an error.',
      '🔧 Restored after the write: ConfigurationKey=ContosoRent.',
      '📝 Note: fieldType "String" was written as an EDT reference.',
      '⚠️ No .rnrproj of this model references `AxTable\\ContosoRentEquipmentTable` — it still compiles (xppc builds the whole model folder), but no project shows it in Visual Studio. Re-send with addToProject=true to add it to the active project.',
      '⚠️ Written, but the symbol index could not be updated: database is locked',
      '   Run update_symbol_index(filePath="' + TABLE_FILE + '") before searching for it.',
      '⚠️ 1 parameter(s) IGNORED by add-field: mandatry (not a recognised d365fo_file parameter).',
      '⛔ **The file on disk now has 1 element(s) the metadata deserializer will DROP silently** — they are in the file and the compiler will not see them:',
      '> **Untested.** No SysTest in the index references `ContosoRentHelper`.',
    ];
    const reply =
      `✅ add-field on table "ContosoRentEquipmentTable" — applied via IMetadataProvider.Update()\n\n` +
      `${kept[4]}\n(Pass autoCorrect=false to have corrections like this raise an error instead.)\n\n` +
      `**File:** ${TABLE_FILE}\n🔧 API: Field added` +
      `\n\n${kept[3]}\n\n${kept[1]}\n${kept[2]}\n\n${kept[0]}` +
      `\n✅ Verified: on disk (1969 bytes)\n${kept[5]}\n${kept[6]}\n${kept[7]}\n\n${kept[9]}` +
      `\n\n${kept[8]}\n\n${NEXT_MODIFY}\n${MORE_EDITS('ContosoRentEquipmentTable')}\n\n${kept[10]}`;

    const short = terseReplyText(reply);
    for (const line of kept) expect(short, line).toContain(line);
    expect(short).toContain(`**File:** ${TABLE_FILE}`);
    expect(short).not.toContain('Verified: on disk');
    expect(short).not.toContain('Next: build');
    expect(short).not.toContain('🔧 API: Field added');
    expect(short).not.toContain('Pass autoCorrect=false');
    expect(short.length).toBeLessThan(reply.length);
  });

  it('keeps the failed verification and the project problems of a create', () => {
    const reply =
      `✅ Created class ContosoRentHelper (prefixed from "RentHelper")\n📁 ${CLASS_FILE}\n` +
      `\n⚠️ File created but failed to add to project:\nEBUSY: resource busy or locked\n` +
      `This usually means Visual Studio has the .rnrproj file locked.\n` +
      `\n❌ Verification: the file is NOT on disk after a reported success — treat this write as failed.` +
      `\n\n### Best-practice check (bpCheck=true)\nBPErrorLabelIsText: ContosoRentHelper.description uses raw text` +
      `\nNext: add the file to your .rnrproj, then build_d365fo_project(bpCheck:true) — builds AND best-practice-checks in one call.\n` +
      `${FURTHER_EDITS('class', 'ContosoRentHelper')}\nIt exists now — do not create it again.\n`;

    const short = terseReplyText(reply);
    expect(short).toContain('(prefixed from "RentHelper")');
    expect(short).toContain('⚠️ File created but failed to add to project:');
    expect(short).toContain('EBUSY: resource busy or locked');
    expect(short).toContain('This usually means Visual Studio has the .rnrproj file locked.');
    expect(short).toContain('❌ Verification: the file is NOT on disk');
    expect(short).toContain('### Best-practice check (bpCheck=true)');
    expect(short).toContain('BPErrorLabelIsText');
    // Still something the caller has to do, unlike the plain build hint.
    expect(short).toContain('Next: add the file to your .rnrproj');
    expect(short).not.toContain('Further edits to');
    expect(short).not.toContain('It exists now');
  });

  it('keeps the bridge reason on a skip — the API line only goes under an applied verdict', () => {
    const skipped =
      `⏭️ add-data-source on form "ContosoRentForm" — SKIPPED, nothing was written\n\n` +
      `**File:** K:\\PLD\\ContosoExt\\ContosoExt\\AxForm\\ContosoRentForm.xml\n` +
      `🔧 API: Data source 'ContosoRentEquipmentTable' already exists`;
    expect(terseReplyText(skipped)).toBe(skipped);
  });

  it('keeps an API line that itself reports a problem', () => {
    const reply =
      `✅ add-index on table "ContosoRentEquipmentTable" — applied via IMetadataProvider.Update()\n\n` +
      `**File:** ${TABLE_FILE}\n🔧 API: Index added, AllowDuplicates was NOT applied`;
    expect(terseReplyText(reply)).toBe(reply);
  });

  it('keeps a line it does not know, and text made only of droppable lines', () => {
    const unknown = `✅ Created class ContosoRentHelper\n📁 ${CLASS_FILE}\nSome future note about the write.`;
    expect(terseReplyText(unknown)).toBe(unknown);
    expect(terseReplyText(`${VERIFIED}\n${INDEXED}`)).toBe(`${VERIFIED}\n${INDEXED}`);
  });

  it('does not touch an error result', () => {
    const error = { content: [{ type: 'text', text: `❌ nope\n${NEXT_MODIFY}` }], isError: true };
    expect(terseResult(error)).toBe(error);
  });
});

// ── Through d365fo_file ─────────────────────────────────────────────────────

const ctx = {} as any;
const call = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'd365fo_file', arguments: args },
});
const text = (r: any) => r.content[0].text as string;
const forwardedModify = () => mockModify.mock.calls.map(c => (c[0] as CallToolRequest).params.arguments as any);

/** What one batched entry answers: the trailers are suppressed in a batch, the API line is not. */
const entryReply = (operation: string) =>
  `✅ ${operation} on table "ContosoRentEquipmentTable" — applied via IMetadataProvider.Update()\n\n` +
  `**File:** ${TABLE_FILE}\n🔧 API: done`;

beforeEach(() => {
  vi.clearAllMocks();
  mockModify.mockImplementation(async (req: CallToolRequest, _ctx: unknown, outcome: any) => {
    const args = req.params.arguments as any;
    if (outcome) {
      outcome.filePath = TABLE_FILE;
      outcome.objectType = 'table';
      outcome.objectName = 'ContosoRentEquipmentTable';
      outcome.modelName = 'ContosoExt';
    }
    return {
      content: [{ type: 'text', text: Array.isArray(args.peerOperations) ? entryReply(args.operation) : cleanModify }],
    };
  });
  mockCreate.mockImplementation(async (_req: CallToolRequest, _ctx: unknown, outcome: any) => {
    if (outcome) {
      outcome.filePath = CLASS_FILE;
      outcome.finalObjectName = 'ContosoRentHelper';
    }
    return { content: [{ type: 'text', text: cleanCreate }] };
  });
});

describe('d365fo_file with params.terse', () => {
  const modifyArgs = {
    action: 'modify', objectType: 'class', objectName: 'ContosoRentHelper',
    operation: 'add-method', methodName: 'validateRate', sourceCode: 'public boolean validateRate() { return true; }',
  };

  it('without the flag the reply is exactly what the writer composed', async () => {
    expect(text(await d365foFileTool(call(modifyArgs), ctx))).toBe(cleanModify);
    expect(text(await d365foFileTool(call({ ...modifyArgs, params: { terse: false } }), ctx))).toBe(cleanModify);
    expect(text(await d365foFileTool(call({ action: 'create', objectType: 'class', objectName: 'ContosoRentHelper' }), ctx)))
      .toBe(cleanCreate);
  });

  it('shortens a single modify, nested in params or flat, and never forwards the flag', async () => {
    const short = `✅ add-method on class "ContosoRentHelper" — applied via IMetadataProvider.Update()\n\n**File:** ${CLASS_FILE}`;
    expect(text(await d365foFileTool(call({ ...modifyArgs, params: { terse: true } }), ctx))).toBe(short);
    expect(text(await d365foFileTool(call({ ...modifyArgs, terse: true }), ctx))).toBe(short);
    expect(text(await d365foFileTool(call({ ...modifyArgs, terse: 'true' }), ctx))).toBe(short);
    for (const args of forwardedModify()) expect(args).not.toHaveProperty('terse');
  });

  it('shortens a create', async () => {
    const r = await d365foFileTool(
      call({ action: 'create', objectType: 'class', objectName: 'ContosoRentHelper', params: { terse: true } }), ctx);
    expect(text(r)).toBe(`✅ Created class ContosoRentHelper\n📁 ${CLASS_FILE}`);
    expect((mockCreate.mock.calls[0][0] as CallToolRequest).params.arguments).not.toHaveProperty('terse');
  });

  it('keeps the batch header and one verdict per operation', async () => {
    const batchArgs = {
      action: 'modify', objectType: 'table', objectName: 'ContosoRentEquipmentTable',
      operations: [
        { operation: 'add-field', fieldName: 'DailyRate', fieldType: 'AmountMST' },
        { operation: 'add-field-to-field-group', fieldName: 'DailyRate', fieldGroupName: 'Overview' },
        { operation: 'add-index', indexName: 'RateIdx' },
      ],
    };
    const full = text(await d365foFileTool(call(batchArgs), ctx));
    const short = text(await d365foFileTool(call({ ...batchArgs, params: { terse: true } }), ctx));

    expect(short.split('\n')[0]).toBe('✅ d365fo_file(action="modify") — 3/3 operation(s) applied');
    expect(short.match(/^### ✅ #\d /gm)).toHaveLength(3);
    expect(short.match(/ — applied via /g)).toHaveLength(3);
    expect(short).toContain('### ✅ #2 add-field-to-field-group');
    expect(short).not.toContain('🔧 API');
    expect(short).not.toContain('Verified');
    expect(short).not.toContain('Symbol index updated');
    expect(short).not.toContain('Next: ');
    // The full reply had all of it.
    expect(full).toContain('✅ Verified: on disk (1969 bytes).');
    expect(full).toContain('Next: build_d365fo_project(bpCheck:true)');
    expect(short.length).toBeLessThan(full.length);
  });

  it('keeps the skipped operation of a batch, with its reason', async () => {
    mockModify.mockImplementation(async (req: CallToolRequest, _ctx: unknown, outcome: any) => {
      const args = req.params.arguments as any;
      const skip = args.operation === 'add-index';
      if (outcome) {
        outcome.filePath = TABLE_FILE;
        outcome.objectType = 'table';
        outcome.objectName = 'ContosoRentEquipmentTable';
        outcome.skipped = skip;
      }
      return {
        content: [{
          type: 'text',
          text: skip
            ? `⏭️ add-index on table "ContosoRentEquipmentTable" — SKIPPED, nothing was written\n\n` +
              `**File:** ${TABLE_FILE}\n🔧 API: Index 'RateIdx' already exists`
            : entryReply(args.operation),
        }],
      };
    });
    const short = text(await d365foFileTool(call({
      action: 'modify', objectType: 'table', objectName: 'ContosoRentEquipmentTable', terse: true,
      operations: [
        { operation: 'add-field', fieldName: 'DailyRate', fieldType: 'AmountMST' },
        { operation: 'add-index', indexName: 'RateIdx' },
      ],
    }), ctx));

    expect(short.split('\n')[0]).toContain('1/2 operation(s) applied, 1 skipped (nothing written — see below)');
    expect(short).toContain('### ⏭️ #2 add-index');
    expect(short).toContain('SKIPPED, nothing was written');
    expect(short).toContain(`🔧 API: Index 'RateIdx' already exists`);
    expect(short).not.toContain('🔧 API: done');
  });

  it('returns a failed batch exactly as without the flag', async () => {
    mockModify.mockImplementation(async (req: CallToolRequest) => {
      const args = req.params.arguments as any;
      return args.operation === 'add-index'
        ? { content: [{ type: 'text', text: `❌ add-index: indexFields is required\n${NEXT_MODIFY}` }], isError: true }
        : { content: [{ type: 'text', text: entryReply(args.operation) }] };
    });
    const batchArgs = {
      action: 'modify', objectType: 'table', objectName: 'ContosoRentEquipmentTable',
      operations: [
        { operation: 'add-field', fieldName: 'DailyRate', fieldType: 'AmountMST' },
        { operation: 'add-index', indexName: 'RateIdx' },
      ],
    };
    const full = await d365foFileTool(call(batchArgs), ctx);
    const terse = await d365foFileTool(call({ ...batchArgs, params: { terse: true } }), ctx);

    expect(terse.isError).toBe(true);
    expect(text(terse)).toBe(text(full));
    expect(text(terse)).toContain('🔧 API: done');
  });

  it('returns a failed single modify and a failed create unchanged', async () => {
    const failure = `❌ add-method: sourceCode is required\n\n${NEXT_MODIFY}`;
    mockModify.mockImplementation(async () => ({ content: [{ type: 'text', text: failure }], isError: true }));
    mockCreate.mockImplementation(async () => ({ content: [{ type: 'text', text: failure }], isError: true }));

    expect(text(await d365foFileTool(call({ ...modifyArgs, params: { terse: true } }), ctx))).toBe(failure);
    expect(text(await d365foFileTool(
      call({ action: 'create', objectType: 'class', objectName: 'ContosoRentHelper', terse: true }), ctx))).toBe(failure);
  });

  it('shortens create + operations[] and keeps both verdicts', async () => {
    const short = text(await d365foFileTool(call({
      action: 'create', objectType: 'table', objectName: 'ContosoRentEquipmentTable', terse: true,
      operations: [{ operation: 'add-index', indexName: 'RateIdx' }],
    }), ctx));

    expect(short).toContain('✅ Created class ContosoRentHelper');
    expect(short).toContain(`📁 ${CLASS_FILE}`);
    expect(short).toContain('✅ d365fo_file(action="create") — 1/1 operation(s) applied');
    expect(short).toContain('### ✅ #1 add-index');
    expect(short).not.toContain('Next: ');
    expect(short).not.toContain('It exists now');
  });

  it('is documented in the d365fo_file op-spec next to bpCheck', () => {
    const spec = lookupOpSpec('d365fo_file') ?? '';
    expect(spec).toMatch(/^\s*terse: \[create\|modify\]/m);
  });
});
