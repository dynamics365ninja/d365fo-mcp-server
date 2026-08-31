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

import { handleGenerateSmartReport } from '../../src/tools/smart/generateSmartReport';

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

/**
 * Phase D: uiBuilder=true emits the UI-builder class and binds it on the
 * Contract via [SysOperationContractProcessing] — and stays absent otherwise,
 * so the default scaffold shape (compile-proven by the L4 goldens) is unchanged.
 */
describe('generate_object(scaffold, report) uiBuilder option', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('emits <Name>UIBuilder and the SysOperationContractProcessing binding', async () => {
    const result = await handleGenerateSmartReport(
      {
        name: 'CustAgingReport',
        fieldsHint: 'CustAccount, Balance',
        contractParams: [{ name: 'CustGroup', type: 'CustGroupId' }],
        uiBuilder: true,
        modelName: 'MyModel',
      } as any,
      createSymbolIndexStub()
    );
    const text = result.content[0].text as string;

    expect(text).toContain('CustAgingReportUIBuilder');
    expect(text).toContain('extends SrsReportDataContractUIBuilder');
    expect(text).toContain('SysOperationContractProcessing(classStr(CustAgingReportUIBuilder))');
    // build() calls super() first, per the ssrs-ui-builder topic
    expect(text).toContain('public void build()');
    expect(text).toContain('parmCustGroup');
  });

  it('default scaffold carries no UI builder and a plain [DataContractAttribute]', async () => {
    const result = await handleGenerateSmartReport(
      {
        name: 'PlainReport',
        fieldsHint: 'ItemId, Qty',
        modelName: 'MyModel',
      } as any,
      createSymbolIndexStub()
    );
    const text = result.content[0].text as string;

    expect(text).not.toContain('UIBuilder');
    expect(text).not.toContain('SysOperationContractProcessing');
    expect(text).toContain('[DataContractAttribute]');
  });
});

describe('generate_object(scaffold, report) preProcess option — Phase F VM-verified shape', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('pairs the TempDB tmp table with SrsReportDataProviderPreProcessTempDB, keeps the parameter attribute and invents no hook', async () => {
    const result = await handleGenerateSmartReport(
      {
        name: 'HeavyLedgerRecap',
        fieldsHint: 'AccountNum, Amount',
        contractParams: [{ name: 'FromDate', type: 'TransDate' }],
        preProcess: true,
        modelName: 'MyModel',
      } as any,
      createSymbolIndexStub()
    );
    const text = result.content[0].text as string;

    // 332 of the 370 shipped pre-processed DPs pair a TempDB staging table with this base;
    // SrsReportDataProviderPreProcess is the regular-table (createdTransactionId) variant.
    expect(text).toContain('extends SrsReportDataProviderPreProcessTempDB');
    expect(text).not.toMatch(/extends SrsReportDataProviderPreProcess(?!TempDB)/);
    expect(text).toContain('<TableType>TempDB</TableType>');
    // Every shipped pre-processed DP binds its contract this way (AssetCardDP, AgreementFollowUpDP …).
    expect(text).toContain('SRSReportParameterAttribute(classStr(HeavyLedgerRecapContract))');
    expect(text).toContain('parmFromDate()');
    // SrsReportDataProviderPreProcessInterface has only cleanUp/initialize/parm* members —
    // processReport() IS the pre-processing step, so no invented preProcess() method.
    expect(text).not.toContain('void preProcess()');
  });
});

describe('generate_object(scaffold, report) controllerType="printMgmt" — Phase F VM-verified shape', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('implements the abstract runPrintMgmt, constructs the PrintMgmtReportRun in initPrintMgmtReportRun, and never calls parmPrintMgmtDocType', async () => {
    const result = await handleGenerateSmartReport(
      {
        name: 'ConsignmentNote',
        fieldsHint: 'SalesId, CustAccount',
        controllerType: 'printMgmt',
        generateController: true,
        modelName: 'MyModel',
      } as any,
      createSymbolIndexStub()
    );
    const text = result.content[0].text as string;

    expect(text).toContain('extends SrsPrintMgmtController');
    // xppc on the VM: "Class 'X' does not implement the abstract method 'runPrintMgmt'"
    expect(text).toContain('protected void runPrintMgmt()');
    expect(text).toContain('this.outputReports();');
    expect(text).toContain('protected void initPrintMgmtReportRun()');
    expect(text).toContain('PrintMgmtReportRun::construct(');
    expect(text).toContain('printMgmtReportRun.parmReportRunController(this);');
    // xppc on the VM: "does not contain a definition for method 'parmPrintMgmtDocType'"
    expect(text).not.toContain('parmPrintMgmtDocType');
    expect(text).toContain('ssrsReportStr(ConsignmentNote, Report)');
  });
});

/**
 * Regression: without a `caption` the scaffold labelled the tmp table and menu item
 * "<Name> (temp)" / "<Name>" — prose in a slot that must hold a label ID, so every
 * scaffolded report started life with a BPErrorLabelIsText
 * (eval/corpus/runs/2026-08-30T05__L3-print-mgmt-doctype-extension).
 */
describe('generate_object(scaffold, report) labels', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  const scaffold = (args: Record<string, unknown>) =>
    handleGenerateSmartReport(
      {
        name: 'DemoNoteReport',
        fieldsHint: 'NoteId, Subject',
        generateController: true,
        modelName: 'MyModel',
        ...args,
      } as any,
      createSymbolIndexStub()
    );

  it('writes no Label at all when no caption is given, and says so', async () => {
    const text = (await scaffold({})).content[0].text as string;

    expect(text).not.toContain('(temp)');
    expect(text).not.toContain('<Label>DemoNoteReport');
    expect(text).not.toContain('@TODO:LabelId');
    expect(text).toContain('BPErrorLabelIsText');
    expect(text).toContain('caption="@Model:LabelId"');
  });

  it('keeps prose out of the Label slot but still titles the RDL with it', async () => {
    const text = (await scaffold({ caption: 'Inventory by Zones' })).content[0].text as string;

    expect(text).not.toContain('<Label>Inventory by Zones</Label>');
    // The caption is not lost — it is the RDL page-header title and the doc comments.
    expect(text).toContain('Inventory by Zones');
    expect(text).toContain('is prose, not a label ID');
  });

  it('uses a label reference everywhere when one is given', async () => {
    const text = (await scaffold({ caption: '@TaxTransactionInquiry:HeaderNote' })).content[0].text as string;

    // Both the tmp table and the menu item — the shape every captured report golden holds.
    expect(text.match(/<Label>@TaxTransactionInquiry:HeaderNote<\/Label>/g)?.length).toBeGreaterThanOrEqual(2);
    expect(text).not.toContain('BPErrorLabelIsText');
  });
});

/**
 * Regression: `prePromptModifyContract()` opened with a contract local followed by a
 * TODO that never read it — a BPLocalVariableNotUsed on all three Phase F report
 * captures (eval/corpus/runs/2026-08-30T04+).
 */
describe('generate_object(scaffold, report) controller hook', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('does not declare an unused contract local when there is nothing to pre-fill', async () => {
    const result = await handleGenerateSmartReport(
      {
        name: 'DemoNoteReport',
        fieldsHint: 'NoteId, Subject',
        contractParams: [{ name: 'subjectFilter', type: 'str' }],
        generateController: true,
        modelName: 'MyModel',
      } as any,
      createSymbolIndexStub()
    );
    const text = result.content[0].text as string;

    expect(text).toContain('protected void prePromptModifyContract()');
    // The fetch survives as an example, never as a live declaration.
    expect(text).not.toContain('        DemoNoteReportContract contract = this.parmReportContract()');
    expect(text).toContain('//     DemoNoteReportContract contract = this.parmReportContract()');
    // Pinned wording: the five captured controller goldens carry these exact lines.
    expect(text).toContain('// TODO: set default parameter values here. Fetch the contract where you read it:');
    // Emitted X++ stays ASCII — the AOT goldens are ASCII documents.
    const hookStart = text.indexOf('protected void prePromptModifyContract()');
    const hook = text.slice(hookStart, hookStart + 400);
    expect([...hook].filter(c => (c.codePointAt(0) ?? 0) > 127)).toEqual([]);
  });

  it('still declares and USES the contract when a caller record pre-fills it', async () => {
    const result = await handleGenerateSmartReport(
      {
        name: 'DemoNoteReport',
        fieldsHint: 'NoteId, Subject',
        contractParams: [{ name: 'CustAccount', type: 'str' }],
        callerTableName: 'CustTable',
        generateController: true,
        modelName: 'MyModel',
      } as any,
      createSymbolIndexStub()
    );
    const text = result.content[0].text as string;

    expect(text).toContain('        DemoNoteReportContract contract = this.parmReportContract()');
    expect(text).toContain('contract.parmCustAccount(custTable.CustAccount);');
  });
});

/**
 * A report temp table has no natural key: it is a bag of rows produced by
 * processReport(). The scaffold built its UNIQUE index on the table's FIRST
 * field, which under designStyle="GroupedWithTotals" is by construction the GROUP
 * key — so the table could hold exactly one row per group, and the second record
 * in a group failed on a duplicate key. At RUN time; the metadata builds clean
 * and nothing else notices, which is why an eval run had to find it and repair
 * the table by hand.
 */
describe('report temp table index', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    // Same reason as above: the non-Windows path RETURNS the XML instead of
    // writing it. Without this the test scaffolds a real package into
    // PackagesLocalDirectory — which is exactly what happened while writing it.
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('keys the unique index on RecId, not on the first data column', async () => {
    const symbolIndex = createSymbolIndexStub();

    const result = await handleGenerateSmartReport(
      {
        name: 'ConDemoIdxProbe',
        fieldsHint: 'CustGroup, AccountNum, CreditMax',
        designStyle: 'GroupedWithTotals',
        modelName: 'MyModel',
      } as any,
      symbolIndex,
    );

    const text = result.content[0].text as string;
    const indexBlock = /<Indexes>([\s\S]*?)<\/Indexes>/.exec(text)?.[1] ?? '';

    expect(indexBlock, 'no <Indexes> block was emitted for the temp table').not.toBe('');
    expect(indexBlock).toContain('RecId');
    // The group column must not be made unique by accident.
    expect(indexBlock).not.toContain('CustGroup');
  });
});
