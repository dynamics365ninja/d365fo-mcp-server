/**
 * Regression (eval scenario 5 — inventory aging analytics): generate_object(mode="scaffold",
 * objectType="report") emitted `SysOperationMandatoryAttribute(true)` on a Contract parm method
 * for any contractParams entry with mandatory:true. No such class exists in D365FO — the build
 * failed with "Class 'SysOperationMandatoryAttribute' was not found. Are you missing a module
 * reference?" on every report with a mandatory dialog field (e.g. InventLocationId mandatory=true).
 * Mandatory enforcement for a SysOperation/report contract is already correctly done via the
 * generated validate() method's checkFailed() call — no per-parameter attribute is needed.
 *
 * The tool has two output paths depending on process.platform: Windows writes files to disk via
 * fs.writeFileSync, non-Windows (Azure/Linux — this is how the CI runner sees it) returns every
 * generated object's XML embedded as text instead. The test forces the platform-independent
 * non-Windows path so it behaves identically in CI and locally, without needing to mock fs/
 * ProjectFileManager (neither is reached on that path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getPackagePath: vi.fn(() => 'K:\\PackagesLocalDirectory'),
    getModelName: vi.fn(() => 'MyModel'),
    getProjectPath: vi.fn(async () => null),
    getSolutionPath: vi.fn(async () => null),
    getAutoDetectedModelName: vi.fn(async () => 'MyModel'),
  })),
}));

vi.mock('../../src/utils/modelClassifier', () => ({
  resolveObjectPrefix: vi.fn(() => ''),
  applyObjectPrefix: vi.fn((name: string) => name),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
}));

import { handleGenerateSmartReport } from '../../src/tools/generateSmartReport';

function createSymbolIndexStub() {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined) };
  return {
    getReadDb: vi.fn(() => ({ prepare: vi.fn(() => stmt) })),
  } as any;
}

describe('generate_object(scaffold, report) contract mandatory param', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    // Force the non-Windows (Azure/Linux) code path, which returns every generated
    // object's XML as text instead of writing to disk — deterministic regardless of
    // which OS actually runs the test (local Windows VM vs. the Linux CI runner).
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('never emits the non-existent SysOperationMandatoryAttribute for a mandatory contractParam', async () => {
    const symbolIndex = createSymbolIndexStub();

    const result = await handleGenerateSmartReport(
      {
        name: 'InventAgingReport',
        fieldsHint: 'ItemId, InventLocationId',
        contractParams: [
          { name: 'InventLocationId', type: 'InventLocationId', mandatory: true, label: 'Warehouse' },
          { name: 'AsOfDate', type: 'TransDate', mandatory: false, label: 'As of date' },
        ],
        modelName: 'MyModel',
      } as any,
      symbolIndex
    );

    const text = result.content[0].text as string;

    // Sanity: the Contract class was actually generated and embedded in the output.
    expect(text).toContain('InventAgingReportContract');
    expect(text).toContain('DataMemberAttribute');
    // Mandatory enforcement still happens, just via validate()/checkFailed, not a
    // per-parameter attribute — the class this was hallucinated for does not exist.
    expect(text).not.toContain('SysOperationMandatoryAttribute');
    expect(text).toContain('public boolean validate()');
    expect(text).toContain('checkFailed');
  });
});

/**
 * Regression: scaffold:report ignored the EDT index.
 *
 * suggestEdtFromFieldName() in generateSmartReport.ts was a private hardcoded keyword
 * ladder ending in `return 'String255'` that never queried the DB — while its doc comment
 * claimed it was "shared with generateSmartTable" and the tool schema documents fieldsHint
 * identically for scaffold:table and scaffold:report ("EDTs auto-suggested from the index").
 * Only the table side actually hit the index (resolveBestEdt).
 *
 * Observed on the VM (eval/corpus/runs/2026-07-28T04__L4-ssrs-report-multidataset__39adafe.json):
 * prepare(mode="create") resolved NoteId→Num, Subject→smmSubject, LineCount→Counter, yet the
 * report writer emitted String255 for all three. Worst case is a count becoming a string —
 * AxReportDataSetField/DataType turns into System.String, killing SSRS numeric formatting and
 * aggregation and forcing the DP to wrap the aggregate in int642Str().
 */
describe('generate_object(scaffold, report) EDT resolution', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  /** Stub whose edt_metadata table contains exactly `edts`, answered by SQL shape. */
  function createIndexedSymbolIndexStub(edts: Record<string, string>) {
    const known = new Set(Object.keys(edts));
    const prepare = vi.fn((sql: string) => ({
      get: vi.fn((param: string) => {
        if (sql.includes('extends') || sql.includes('edt_metadata WHERE edt_name = ?')) {
          return known.has(param)
            ? { edt_name: param, extends: edts[param] }
            : undefined;
        }
        return undefined;
      }),
      all: vi.fn(() => []),
    }));
    return { getReadDb: vi.fn(() => ({ prepare })) } as any;
  }

  it('resolves a field name that IS an EDT through the index instead of defaulting to String255', async () => {
    const symbolIndex = createIndexedSymbolIndexStub({
      Num: 'String',
      Counter: 'Integer',
    });

    const result = await handleGenerateSmartReport(
      {
        name: 'DemoNoteReport',
        fieldsHint: 'Num, Counter',
        modelName: 'MyModel',
      } as any,
      symbolIndex
    );

    const text = result.content[0].text as string;
    expect(text).toContain('<ExtendedDataType>Num</ExtendedDataType>');
    expect(text).toContain('<ExtendedDataType>Counter</ExtendedDataType>');
    // The whole point: neither field silently became the generic string default.
    expect(text).not.toContain('<ExtendedDataType>String255</ExtendedDataType>');
  });

  it('still falls back to the shared heuristic when the index knows nothing', async () => {
    const symbolIndex = createIndexedSymbolIndexStub({});

    const result = await handleGenerateSmartReport(
      { name: 'DemoNoteReport', fieldsHint: 'CustAccount', modelName: 'MyModel' } as any,
      symbolIndex
    );

    const text = result.content[0].text as string;
    expect(text).toContain('CustAccount');
  });
});

/**
 * Regression: the resolved EDT and the emitted AxTableField i:type were computed
 * independently and never reconciled.
 *
 * b3d7856 made scaffold:report resolve EDTs from the index, which surfaced a second,
 * older fault one function over. generateSmartReport carried its OWN duplicate
 * resolveEdtBaseType whose comment claimed it was "same as generateSmartTable" — it was
 * not: the shared copy returns undefined for a ROOT EDT with no string_size (the index
 * stores extends=null for AxEdtInt64/Date/Real/String alike, so the primitive is genuinely
 * unknowable from SQL), while the local copy collapsed that to 'String'.
 *
 * resolveFieldType() then mapped 'String' to undefined, and SmartXmlBuilder fell through
 * to its EDT-NAME heuristic — `includes('count')` → AxTableFieldInt (Int32) — over
 * PurchLineCount, which extends the Int64 root EDT NumberOfRecords. Full build:
 *   Metadata Error: AxTable/…/Fields/LineCount/ExtendedDataType: Data type mismatch.
 * Meanwhile AxReportDataSetField/DataType and the RDL rd:TypeName stayed System.String —
 * the two halves were wrong in OPPOSITE directions from the same unreconciled pair.
 * Evidence: eval/corpus/runs/2026-07-28T06__L4-ssrs-report-multidataset__b3d7856.json
 *
 * Both now read one cached primitive per EDT (bridge → index → heuristic), so they cannot
 * disagree. Invisible to validate_code — only a full build ever caught it.
 */
describe('generate_object(scaffold, report) EDT/field-type reconciliation', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  function createEdtChainStub(edts: Record<string, string>) {
    const prepare = vi.fn((sql: string) => ({
      get: vi.fn((param: string) =>
        sql.includes('edt_metadata') && param in edts
          ? { edt_name: param, extends: edts[param], enum_type: null, string_size: null }
          : undefined
      ),
      all: vi.fn(() => []),
    }));
    return { getReadDb: vi.fn(() => ({ prepare })) } as any;
  }

  it('emits an Int64 field type for an Int64-rooted EDT instead of guessing Int32 from the name', async () => {
    // "LineCount" is exactly the shape that broke: the name heuristic says Int32,
    // the EDT chain says Int64. The EDT must win.
    const symbolIndex = createEdtChainStub({ LineCount: 'Int64' });

    const result = await handleGenerateSmartReport(
      { name: 'DemoNoteReportMulti', fieldsHint: 'LineCount', modelName: 'MyModel' } as any,
      symbolIndex
    );

    const text = result.content[0].text as string;
    expect(text).toContain('AxTableFieldInt64');
    expect(text).not.toContain('AxTableFieldInt<');
    expect(text).not.toContain('"AxTableFieldInt"');
  });

  it('derives the dataset/RDL type from the same primitive as the table field', async () => {
    const symbolIndex = createEdtChainStub({ LineCount: 'Int64' });

    const result = await handleGenerateSmartReport(
      { name: 'DemoNoteReportMulti', fieldsHint: 'LineCount', modelName: 'MyModel' } as any,
      symbolIndex
    );

    const text = result.content[0].text as string;
    // The half that used to stay System.String while the table field went Int32.
    // Anchored on the field itself — System.String legitimately appears elsewhere in the
    // RDL boilerplate, so a bare not-toContain would assert something untrue.
    expect(text).toMatch(/<Name>LineCount<\/Name>[\s\S]{0,300}?System\.Int64/);
    expect(text).not.toMatch(/<Name>LineCount<\/Name>[\s\S]{0,300}?System\.String/);
  });
});
