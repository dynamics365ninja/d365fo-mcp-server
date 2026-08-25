/**
 * Argument normalisation for d365fo_file(action="modify") — the corrections the
 * server had already computed and then declined to use.
 *
 * Measured on 2026-08-25 against the real VM (model fm-mcp):
 *
 *   add-index   { indexName:"ProbeIdx", indexFields:["ProbeId"] }
 *     → "indexFields.0: Invalid input: expected object, received string" + the
 *       full 3,000-char add-index spec. Nothing written.
 *   add-field-group { fieldGroupName:"Overview", fields:["ProbeId","Amount"] }
 *     → the same, twice, for a list the operation calls `fieldGroupFields`.
 *   add-field   { name:"Note2", edt:"Notes" }
 *     → "name: IGNORED (not a recognised d365fo_file parameter) — did you mean
 *       'fieldName'?" and nothing written.
 *
 * Each of those is a full MCP round trip that re-bills the entire cached context
 * and drags the spec into it permanently. Each also had exactly ONE reading the
 * server could derive from state it already held.
 *
 * The two things these tests are really guarding:
 *  1. The written XML, not just an ok verdict — the key a bare string is wrapped
 *     into must be the key the WRITER reads. A bridge contract once read
 *     {type, edt} while the tool wrote {fieldType, extendedDataType}, and the
 *     values vanished under a ✅.
 *  2. autoCorrect=false still errors exactly as before, because the eval harness
 *     and deterministic callers depend on it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// ─── Bridge mock: force the direct-XML fallback so the XML is observable ──────

const { mockBridgeAddIndex, mockBridgeAddField } = vi.hoisted(() => ({
  mockBridgeAddIndex: vi.fn(),
  mockBridgeAddField: vi.fn(),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddIndex: mockBridgeAddIndex,
    bridgeAddField: mockBridgeAddField,
    bridgeRefreshProvider: vi.fn(async () => ({ success: true, elapsedMs: 1 })),
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

const TABLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConProbeTable</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ConProbeTable extends common
{
}
]]></Declaration>
\t\t<Methods />
\t</SourceCode>
\t<DeleteActions />
\t<FieldGroups />
\t<Fields>
\t\t<AxTableField xmlns="" i:type="AxTableFieldString">
\t\t\t<Name>ProbeId</Name>
\t\t\t<ExtendedDataType>Num</ExtendedDataType>
\t\t</AxTableField>
\t</Fields>
\t<FullTextIndexes />
\t<Indexes />
\t<Mappings />
\t<Relations />
\t<StateMachines />
</AxTable>`;

const { mockWriteFile } = vi.hoisted(() => ({ mockWriteFile: vi.fn(async () => {}) }));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (typeof p === 'string' && p.endsWith('.xml')) return TABLE_XML;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: mockWriteFile,
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false, size: 1234 })),
  readdir: vi.fn(async () => []),
  copyFile: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getPackagePath: vi.fn(() => 'K:\\PackagesLocalDirectory'),
    getModelName: vi.fn(() => 'MyModel'),
    getWriteAnchorModel: vi.fn(() => 'MyModel'),
    getToolProjectSwitch: vi.fn(() => null),
    getPackageNameFromWorkspacePath: vi.fn(() => 'MyPackage'),
    getProjectPath: vi.fn(async () => null),
    getSolutionPath: vi.fn(async () => null),
    getDevEnvironmentType: vi.fn(async () => 'traditional'),
    getCustomPackagesPath: vi.fn(async () => null),
    getMicrosoftPackagesPath: vi.fn(async () => null),
    getProjectsForModel: vi.fn(() => []),
    getWorkspaceProjectCandidates: vi.fn(() => []),
  })),
  fallbackPackagePath: vi.fn(() => 'C:\\AosService\\PackagesLocalDirectory'),
  extractModelFromFilePath: vi.fn(() => null),
}));

vi.mock('../../src/utils/packageResolver', () => ({
  PackageResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(async (m: string) => ({ packageName: m, modelName: m, rootPath: 'K:\\PackagesLocalDirectory' })),
    resolveWithPackage: vi.fn((m: string, p: string) => ({ packageName: p, modelName: m, rootPath: 'K:\\PackagesLocalDirectory' })),
  })),
}));

vi.mock('../../src/utils/modelClassifier', () => ({
  registerCustomModel: vi.fn(),
  resolveObjectPrefix: vi.fn(() => ''),
  resolveRawPrefix: vi.fn(() => ''),
  deriveExtensionInfix: vi.fn(() => ''),
  applyObjectPrefix: vi.fn((name: string) => name),
  resolveRegularObjectPrefixToken: vi.fn(() => ''),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
}));

import {
  modifyD365FileTool, normalizeModifyArgs, baseObjectNameCandidates, resetRepeatedNoteMemory,
} from '../../src/tools/write/modifyD365File';
import { deriveExtensionInfix } from '../../src/utils/modelClassifier';

const FILE_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ConProbeTable.xml';

const ctx = () => {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
  return {
    symbolIndex: {
      searchSymbols: vi.fn(() => []),
      getSymbolByName: vi.fn(() => undefined),
      getCustomModels: vi.fn(() => ['MyModel']),
      db: { prepare: vi.fn(() => stmt) },
      getReadDb: vi.fn(function (this: any) { return this.db; }),
    } as any,
    parser: {} as any,
    cache: {} as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
    bridge: { isReady: true, metadataAvailable: true } as any,
  } as any;
};

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'modify_d365fo_file', arguments: args },
});

const textOf = (r: any) => r.content.map((c: any) => c.text).join('\n');

/** XML of the write that landed the index (writeFileAtomic writes a temp sibling). */
const writtenIndexXml = (): string | undefined =>
  mockWriteFile.mock.calls.find(
    (c: any[]) => typeof c[1] === 'string' && c[1].includes('<AxTableIndex>'),
  )?.[1] as string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  // Bridge cannot resolve it → the direct-XML fallback runs and the XML is
  // observable. Exactly the same-session situation the live probe hits.
  mockBridgeAddIndex.mockResolvedValue({ success: false, message: "Table 'ConProbeTable' not found" });
  mockBridgeAddField.mockResolvedValue({ success: true, message: "✅ Field added via IMetaTableProvider.Update" });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a list of names where the contract wants objects', () => {
  it('writes the index — and the field name lands in <DataField>, not just an ok verdict', async () => {
    const result = await modifyD365FileTool(
      req({
        objectType: 'table', objectName: 'ConProbeTable', operation: 'add-index',
        indexName: 'ProbeIdx', indexFields: ['ProbeId'], filePath: FILE_PATH,
      }),
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    // The key the WRITER reads, proven against the serialised XML.
    expect(writtenIndexXml()).toMatch(
      /<Fields>\s*<AxTableIndexField>\s*<DataField>ProbeId<\/DataField>\s*<\/AxTableIndexField>\s*<\/Fields>/,
    );
    // Reported, never silent.
    expect(textOf(result)).toMatch(/Note:.*indexFields/s);
  });

  it('refuses it under autoCorrect=false, with the contract, exactly as before', async () => {
    const result = await modifyD365FileTool(
      req({
        objectType: 'table', objectName: 'ConProbeTable', operation: 'add-index',
        indexName: 'ProbeIdx', indexFields: ['ProbeId'], autoCorrect: false, filePath: FILE_PATH,
      }),
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parameter spec for operation 'add-index'");
    expect(writtenIndexXml()).toBeUndefined();
  });
});

describe('normalizeModifyArgs — driven by the schema, not by a per-operation table', () => {
  it('wraps a bare string into the ONE required key of the element', () => {
    const { args, notes } = normalizeModifyArgs({
      operation: 'add-index', indexName: 'Idx', indexFields: ['A', 'B'],
    });
    expect(args.indexFields).toEqual([{ fieldName: 'A' }, { fieldName: 'B' }]);
    expect(notes.join()).toContain('indexFields');
  });

  it('covers add-full-text-index too, without naming it anywhere', () => {
    const { args } = normalizeModifyArgs({
      operation: 'add-full-text-index', indexName: 'Idx', indexFields: ['A'],
    });
    expect(args.indexFields).toEqual([{ fieldName: 'A' }]);
  });

  it('leaves a shape with TWO required keys alone — half a constraint compiles', () => {
    const { args, notes } = normalizeModifyArgs({
      operation: 'add-relation', relationName: 'R', relatedTable: 'CustTable',
      relationConstraints: ['AccountNum'],
    });
    expect(args.relationConstraints).toEqual(['AccountNum']);
    expect(notes).toEqual([]);
  });

  it('leaves entries that are already objects untouched', () => {
    const original = [{ fieldName: 'A', direction: 'Desc' }];
    const { args, notes } = normalizeModifyArgs({
      operation: 'add-index', indexName: 'Idx', indexFields: original,
    });
    expect(args.indexFields).toBe(original);
    expect(notes).toEqual([]);
  });

  it('renames a wrong key to its only candidate, then reshapes for the TARGET', () => {
    // `fields` on add-field-group is the replace-all-fields param; the one this
    // operation reads is fieldGroupFields, an array of plain strings.
    const { args, notes } = normalizeModifyArgs({
      operation: 'add-field-group', fieldGroupName: 'Overview', fields: ['ProbeId', 'Amount'],
    });
    expect(args.fieldGroupFields).toEqual(['ProbeId', 'Amount']);
    expect(args.fields).toBeUndefined();
    expect(notes.join()).toContain('fieldGroupFields');
  });

  it('applies the did-you-mean it was already printing', () => {
    const { args } = normalizeModifyArgs({ operation: 'add-field', name: 'Note2', edt: 'Notes' });
    expect(args.fieldName).toBe('Note2');   // via the single REQUIRED candidate
    expect(args.fieldType).toBe('Notes');   // via the documented `edt` alias
  });

  it('keeps a genuinely ambiguous key ambiguous', () => {
    // Both fieldName and fieldGroupName are REQUIRED here, so `name` has no
    // single reading and the call keeps returning the full spec.
    const { args } = normalizeModifyArgs({ operation: 'add-field-to-field-group', name: 'X' });
    expect(args.fieldName).toBeUndefined();
    expect(args.fieldGroupName).toBeUndefined();
    expect(args.name).toBe('X');
  });

  it('never overwrites a spelling the caller supplied itself', () => {
    const { args } = normalizeModifyArgs({
      operation: 'add-field', fieldName: 'Real', name: 'Wrong', fieldType: 'Notes',
    });
    expect(args.fieldName).toBe('Real');
    expect(args.name).toBe('Wrong');
  });

  it('applies nothing under autoCorrect=false', () => {
    const { args, notes } = normalizeModifyArgs({
      operation: 'add-index', indexName: 'Idx', indexFields: ['A'], autoCorrect: false,
    });
    expect(args.indexFields).toEqual(['A']);
    expect(notes).toEqual([]);
  });

  it('maps the parent/after spelling get_object_info prints onto add-control', () => {
    const { args } = normalizeModifyArgs({
      operation: 'add-control', controlName: 'MyField',
      parent: 'TabPageGeneral', after: 'GeneralGroup',
    });
    expect(args.parentControl).toBe('TabPageGeneral');
    expect(args.previousSibling).toBe('GeneralGroup');
  });

  it('resolves aliases even under autoCorrect=false — an alias is the contract', () => {
    const { args, notes } = normalizeModifyArgs({
      operation: 'add-control', controlName: 'MyField', parent: 'TabPageGeneral', autoCorrect: false,
    });
    expect(args.parentControl).toBe('TabPageGeneral');
    expect(notes).toEqual([]);
  });

  it('leaves an unknown operation completely alone', () => {
    const raw = { operation: 'no-such-op', indexFields: ['A'] };
    expect(normalizeModifyArgs(raw).args).toEqual(raw);
  });
});

describe('inside a batch, the per-operation trailers stay quiet', () => {
  // They answer a question about the FILE, and runModifyBatch asks it once for
  // the whole call. Repeating ~250 chars per entry - and re-running the stat()
  // and the symbol-index re-parse behind them - is the batch paying twenty times
  // for one answer.
  const withPeers = (extra: Record<string, unknown> = {}) => modifyD365FileTool(
    req({
      objectType: 'table', objectName: 'ConProbeTable', operation: 'add-index',
      indexName: 'ProbeIdx', indexFields: [{ fieldName: 'ProbeId' }], filePath: FILE_PATH,
      peerOperations: ['add-index', 'add-field'], ...extra,
    }),
    ctx(),
  );

  it('emits no verification, no index line and no Next: of its own', async () => {
    const t = textOf(await withPeers());
    expect(t).not.toContain('Verified:');
    expect(t).not.toContain('Symbol index updated in place');
    expect(t).not.toContain('Next: build_d365fo_project');
    expect(t).not.toContain('Send them together');
  });

  it('still emits all of them for a single-operation call', async () => {
    const t = textOf(await modifyD365FileTool(
      req({
        objectType: 'table', objectName: 'ConProbeTable', operation: 'add-index',
        indexName: 'ProbeIdx2', indexFields: [{ fieldName: 'ProbeId' }], filePath: FILE_PATH,
      }),
      ctx(),
    ));
    expect(t).toContain('Verified:');
    // One call that builds AND runs the best-practice check, rather than sending
    // the agent to verify_d365fo_project / run_bp_check separately.
    expect(t).toContain('Next: build_d365fo_project(bpCheck:true)');
    expect(t).not.toContain('verify_d365fo_project');
  });

  it('publishes the written file so the batch can verify it once', async () => {
    const outcome: any = {};
    await modifyD365FileTool(
      req({
        objectType: 'table', objectName: 'ConProbeTable', operation: 'add-index',
        indexName: 'ProbeIdx3', indexFields: [{ fieldName: 'ProbeId' }], filePath: FILE_PATH,
        peerOperations: ['add-index'],
      }),
      ctx(),
      outcome,
    );
    expect(outcome.filePath).toBe(FILE_PATH);
    expect(outcome.objectType).toBe('table');
    expect(outcome.objectName).toBe('ConProbeTable');
  });
});

describe('baseObjectNameCandidates', () => {
  beforeEach(() => vi.mocked(deriveExtensionInfix).mockReturnValue(''));

  it('reads the base off a dot-notation extension name', () => {
    expect(baseObjectNameCandidates('CustTable.FmMcpExtension')).toEqual(['CustTable']);
  });

  it('handles the element-style class-extension spelling', () => {
    expect(baseObjectNameCandidates('CustTable_Extension')).toEqual(['CustTable']);
  });

  it('offers the infix-stripped form too, since the plain strip keeps it', () => {
    // CustTableConSk_Extension extends CustTable, not "CustTableConSk" - both
    // spellings are tried, best guess first.
    vi.mocked(deriveExtensionInfix).mockReturnValue('ConSk');
    const out = baseObjectNameCandidates('CustTableConSk_Extension', 'ContosoFinanceSK');
    expect(out[0]).toBe('CustTableConSk');
    expect(out).toContain('CustTable');
  });

  it('says nothing for a name that is not an extension at all', () => {
    expect(baseObjectNameCandidates('CustTable')).toEqual([]);
  });
});

describe('an advisory about the workspace is spelled out once, not per write', () => {
  // The forced-backup line rode on EVERY write in a non-git metadata tree: ~200
  // chars restating a fact the caller cannot act on mid-task. The path changes
  // every time and must survive; the explanation need not repeat.
  beforeEach(() => resetRepeatedNoteMemory());

  const addIndex = (name: string) => modifyD365FileTool(
    req({
      objectType: 'table', objectName: 'ConProbeTable', operation: 'add-index',
      indexName: name, indexFields: [{ fieldName: 'ProbeId' }], filePath: FILE_PATH,
    }),
    ctx(),
  );

  it('explains itself the first time and shrinks afterwards, keeping the path', async () => {
    const first = textOf(await addIndex('Idx1'));
    const second = textOf(await addIndex('Idx2'));

    expect(first).toContain('Target is not under git');
    expect(first).toContain('d365fo_file(action="undo") would not work here');
    expect(second).not.toContain('Target is not under git');
    // The backup path is what a caller may actually need - never dropped.
    expect(second).toMatch(/Backup: .*\.backup-/);
  });
});
