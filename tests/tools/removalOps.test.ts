/**
 * remove-control and remove-entry-point through the modify surface.
 *
 * Both are the missing inverse of an operation that already existed — add-control,
 * and the entry point buildAxSecurityPrivilegeXml writes for `targetObject` — and
 * neither had any grounded path at all: the C# bridge exposes no RemoveControl,
 * and security objects have no bridge write path whatsoever, so taking a button
 * and its security exposure off a form meant d365fo_file(action="create",
 * overwrite=true) — the whole-file escape hatch the eval loop forbids.
 *
 * The XML logic is unit-tested where it lives (tests/utils/formControlRemoval and
 * tests/tools/securityPrivilegeXml). What is tested HERE is the surface: that the
 * ops clear the dispatch gate, reach their writer, and — the part a caller acts on
 * — that a control or entry point which is NOT there comes back as isError, not as
 * a ✅ that sends the agent off to build a model still carrying the button.
 *
 * Mock shape follows deleteActionOps.test.ts, the closest sibling (also an
 * operation with no bridge op behind it).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return { ...actual, bridgeValidateAfterWrite: vi.fn(async () => null) };
});

/** Form with a button, its separator and a grid, nested inside an ActionPane. */
const FORM_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoTicketTable</Name>
\t<SourceCode>
\t\t<Methods />
\t</SourceCode>
\t<DataSources />
\t<Design>
\t\t<Controls>
\t\t\t<AxFormControl xmlns="" i:type="AxFormActionPaneControl">
\t\t\t\t<Name>ActionPane</Name>
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns="" i:type="AxFormCommandButtonControl">
\t\t\t\t\t\t<Name>NewButton</Name>
\t\t\t\t\t</AxFormControl>
\t\t\t\t\t<AxFormControl xmlns="" i:type="AxFormButtonSeparatorControl">
\t\t\t\t\t\t<Name>PostSeparator</Name>
\t\t\t\t\t</AxFormControl>
\t\t\t\t\t<AxFormControl xmlns="" i:type="AxFormButtonControl">
\t\t\t\t\t\t<Name>ConDemoPostButton</Name>
\t\t\t\t\t\t<Text>Post</Text>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t</AxFormControl>
\t\t</Controls>
\t</Design>
</AxForm>`;

/** Privilege granting one display menu item. */
const PRIVILEGE_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityPrivilege xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoTicketMaintain</Name>
\t<Label>@ConDemo:TicketMaintain</Label>
\t<DataEntityPermissions />
\t<DirectAccessPermissions />
\t<EntryPoints>
\t\t<AxSecurityEntryPointReference>
\t\t\t<Name>ConDemoPostTicket</Name>
\t\t\t<Grant>
\t\t\t\t<Read>Allow</Read>
\t\t\t</Grant>
\t\t\t<ObjectName>ConDemoPostTicket</ObjectName>
\t\t\t<ObjectType>MenuItemAction</ObjectType>
\t\t\t<Forms />
\t\t</AxSecurityEntryPointReference>
\t</EntryPoints>
\t<FormControlOverrides />
</AxSecurityPrivilege>`;

/**
 * BP-check suppression list carrying two <Diagnostic> entries. Root/child
 * shape (root <IgnoreDiagnostics>, <Name>/<Items> as direct children,
 * <Diagnostic> as a direct child of <Items>) matches a real production
 * suppression file — see ignoreDiagnosticListXml.ts's docblock.
 */
const SUPPRESSIONS_XML = `<?xml version="1.0" encoding="utf-8"?>
<IgnoreDiagnostics>
\t<Name>MyModel_BPSuppressions</Name>
\t<Items>
\t\t<Diagnostic>
\t\t\t<DiagnosticType>BestPractices</DiagnosticType>
\t\t\t<Severity>Warning</Severity>
\t\t\t<Path>dynamics://Form/ConDemoTicketTable</Path>
\t\t\t<Moniker>BPErrorGridCaption</Moniker>
\t\t\t<Justification>TODO</Justification>
\t\t</Diagnostic>
\t\t<Diagnostic>
\t\t\t<DiagnosticType>BestPractices</DiagnosticType>
\t\t\t<Severity>Warning</Severity>
\t\t\t<Path>dynamics://SecurityPrivilege/ConDemoTicketMaintain</Path>
\t\t\t<Moniker>BPErrorPrivilegeNotCoveredByDuty</Moniker>
\t\t\t<Justification>TODO</Justification>
\t\t</Diagnostic>
\t</Items>
</IgnoreDiagnostics>`;

const { mockWriteFile, currentXml } = vi.hoisted(() => ({
  mockWriteFile: vi.fn(async () => {}),
  // null simulates the target .xml not existing yet (ENOENT) — used by
  // add-diagnostic-suppression's "create a fresh suppression file" path.
  currentXml: { value: '' as string | null },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (typeof p === 'string' && p.endsWith('.xml')) {
      if (currentXml.value === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return currentXml.value;
    }
    if (typeof p === 'string' && p.endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: mockWriteFile,
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
  readdir: vi.fn(async () => []),
  copyFile: vi.fn(async () => {}),
  // writeFileAtomic writes a temp sibling and renames it over the target.
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
  applyObjectPrefix: vi.fn((name: string) => name),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
}));

const FORM_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxForm\\ConDemoTicketTable.xml';
const PRIV_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxSecurityPrivilege\\ConDemoTicketMaintain.xml';
const SUPP_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxIgnoreDiagnosticList\\MyModel_BPSuppressions.xml';

const req = (
  objectType: string,
  objectName: string,
  filePath: string,
  args: Record<string, unknown>,
): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'modify_d365fo_file', arguments: { objectType, objectName, filePath, ...args } },
});

const buildContext = (): XppServerContext => {
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
    cache: { get: vi.fn(async () => null), set: vi.fn(async () => {}), generateSearchKey: vi.fn((q: string) => `k:${q}`) } as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
    bridge: { isReady: true, metadataAvailable: true } as any,
  };
};

/** The XML written whose root element matches `root`. */
const written = (root: string): string | undefined =>
  mockWriteFile.mock.calls.find(
    (c: any[]) => typeof c[1] === 'string' && c[1].includes(`<${root}`),
  )?.[1] as string | undefined;

describe('remove-control through the modify surface', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    currentXml.value = FORM_XML;
    mockWriteFile.mockClear();
  });

  it('removes a button nested inside an ActionPane', async () => {
    const result = await modifyD365FileTool(
      req('form', 'ConDemoTicketTable', FORM_PATH, {
        operation: 'remove-control',
        controlName: 'ConDemoPostButton',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const xml = written('AxForm');
    expect(xml).toBeTruthy();
    expect(xml).not.toContain('ConDemoPostButton');
    // Its container and siblings are untouched.
    expect(xml).toContain('<Name>ActionPane</Name>');
    expect(xml).toContain('<Name>NewButton</Name>');
    expect(xml).toContain('<Name>PostSeparator</Name>');
  });

  it('drops the orphaned separator when removeSeparator is set', async () => {
    const result = await modifyD365FileTool(
      req('form', 'ConDemoTicketTable', FORM_PATH, {
        operation: 'remove-control',
        controlName: 'ConDemoPostButton',
        removeSeparator: true,
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const xml = written('AxForm');
    expect(xml).not.toContain('ConDemoPostButton');
    expect(xml).not.toContain('PostSeparator');
    expect(xml).toContain('<Name>NewButton</Name>');
    // The extra removal is disclosed, not silent — it was not what the caller named.
    expect(result.content[0].text as string).toContain('PostSeparator');
  });

  it('fails — and writes nothing — for a control that is not there', async () => {
    const result = await modifyD365FileTool(
      req('form', 'ConDemoTicketTable', FORM_PATH, {
        operation: 'remove-control',
        controlName: 'NoSuchButton',
      }),
      ctx,
    );

    // The failure mode this guards: a ✅ for a control still on the form sends the
    // agent to build_d365fo_project believing the change landed.
    expect(result.isError).toBe(true);
    expect(result.content[0].text as string).toContain('NoSuchButton');
    // Names what IS there, so the retry does not need another read.
    expect(result.content[0].text as string).toContain('ConDemoPostButton');
    expect(written('AxForm')).toBeUndefined();
  });

  it('never steers the agent into create overwrite=true', async () => {
    const result = await modifyD365FileTool(
      req('form', 'ConDemoTicketTable', FORM_PATH, {
        operation: 'remove-control',
        controlName: 'NoSuchButton',
      }),
      ctx,
    );
    expect(result.content[0].text as string).not.toMatch(/overwrite=true/);
  });

  it('refuses a file that is not a form', async () => {
    currentXml.value = `<?xml version="1.0" encoding="utf-8"?>\n<AxEnum><Name>ConDemoStatus</Name></AxEnum>`;
    const result = await modifyD365FileTool(
      req('form', 'ConDemoStatus', FORM_PATH, {
        operation: 'remove-control',
        controlName: 'ConDemoPostButton',
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    // Names the SHAPE mismatch. A null result here would route into the bridge's
    // provider-refresh retry and come back as an unresolved-object error about
    // metadata roots — the wrong cause, and one no refresh can fix.
    const text = result.content[0].text as string;
    expect(text).toContain('not an AxForm');
    expect(text).not.toMatch(/metadata roots/i);
    expect(written('AxEnum')).toBeUndefined();
  });

  it('reports the missing parameter with the op spec when controlName is omitted', async () => {
    const result = await modifyD365FileTool(
      req('form', 'ConDemoTicketTable', FORM_PATH, { operation: 'remove-control' }),
      ctx,
    );
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('controlName');
    expect(text).toContain('kind="op-spec"');
    expect(written('AxForm')).toBeUndefined();
  });
});

describe('remove-entry-point through the modify surface', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    currentXml.value = PRIVILEGE_XML;
    mockWriteFile.mockClear();
  });

  it('removes the entry point named by entryPointName', async () => {
    const result = await modifyD365FileTool(
      req('security-privilege', 'ConDemoTicketMaintain', PRIV_PATH, {
        operation: 'remove-entry-point',
        entryPointName: 'ConDemoPostTicket',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const xml = written('AxSecurityPrivilege');
    expect(xml).toBeTruthy();
    expect(xml).not.toContain('AxSecurityEntryPointReference');
    expect(xml).not.toContain('ConDemoPostTicket');
    // The privilege itself survives — its own <Name> is not an entry point.
    expect(xml).toContain('<Name>ConDemoTicketMaintain</Name>');
    expect(xml).toContain('<Label>@ConDemo:TicketMaintain</Label>');
  });

  it('resolves the entry point by objectName + objectType', async () => {
    const result = await modifyD365FileTool(
      req('security-privilege', 'ConDemoTicketMaintain', PRIV_PATH, {
        operation: 'remove-entry-point',
        entryPointObjectName: 'ConDemoPostTicket',
        entryPointObjectType: 'MenuItemAction',
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(written('AxSecurityPrivilege')).not.toContain('AxSecurityEntryPointReference');
  });

  it('fails — and writes nothing — for an entry point that is not there', async () => {
    const result = await modifyD365FileTool(
      req('security-privilege', 'ConDemoTicketMaintain', PRIV_PATH, {
        operation: 'remove-entry-point',
        entryPointName: 'ConDemoNoSuchItem',
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('ConDemoNoSuchItem');
    // Names the entry points that ARE on the privilege.
    expect(text).toContain('ConDemoPostTicket');
    expect(written('AxSecurityPrivilege')).toBeUndefined();
  });

  it('refuses a call carrying neither identifier', async () => {
    // Nothing to match on means nothing would be written, so success would be a lie
    // (the mutationOneOf gate — same guard modify-field has).
    const result = await modifyD365FileTool(
      req('security-privilege', 'ConDemoTicketMaintain', PRIV_PATH, {
        operation: 'remove-entry-point',
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('entryPointName');
    expect(text).toContain('entryPointObjectName');
    expect(written('AxSecurityPrivilege')).toBeUndefined();
  });

  it('refuses a file that is not a privilege', async () => {
    currentXml.value = `<?xml version="1.0" encoding="utf-8"?>\n<AxSecurityDuty><Name>ConDemoDuty</Name></AxSecurityDuty>`;
    const result = await modifyD365FileTool(
      req('security-privilege', 'ConDemoDuty', PRIV_PATH, {
        operation: 'remove-entry-point',
        entryPointName: 'ConDemoPostTicket',
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('not an AxSecurityPrivilege');
    // And says what a duty/role reference instead, since that is the mistake.
    expect(text).toContain('duties');
    expect(written('AxSecurityDuty')).toBeUndefined();
  });
});

describe('remove-diagnostic-suppression through the modify surface', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    currentXml.value = SUPPRESSIONS_XML;
    mockWriteFile.mockClear();
  });

  it('removes the diagnostic identified by diagnosticPath', async () => {
    const result = await modifyD365FileTool(
      req('ignore-diagnostic-list', 'MyModel_BPSuppressions', SUPP_PATH, {
        operation: 'remove-diagnostic-suppression',
        diagnosticPath: 'dynamics://Form/ConDemoTicketTable',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const xml = written('IgnoreDiagnostics');
    expect(xml).toBeTruthy();
    expect(xml).not.toContain('BPErrorGridCaption');
    expect(xml).not.toContain('ConDemoTicketTable');
    // The other suppression survives whole.
    expect(xml).toContain('dynamics://SecurityPrivilege/ConDemoTicketMaintain');
    expect(xml).toContain('BPErrorPrivilegeNotCoveredByDuty');
  });

  it('fails — and writes nothing — for a path that is not suppressed', async () => {
    const result = await modifyD365FileTool(
      req('ignore-diagnostic-list', 'MyModel_BPSuppressions', SUPP_PATH, {
        operation: 'remove-diagnostic-suppression',
        diagnosticPath: 'dynamics://Table/NoSuchTable',
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('dynamics://Table/NoSuchTable');
    // Names what IS there, so the retry does not need another read.
    expect(text).toContain('dynamics://Form/ConDemoTicketTable');
    expect(written('IgnoreDiagnostics')).toBeUndefined();
  });

  it('reports the missing parameter with the op spec when diagnosticPath is omitted', async () => {
    const result = await modifyD365FileTool(
      req('ignore-diagnostic-list', 'MyModel_BPSuppressions', SUPP_PATH, { operation: 'remove-diagnostic-suppression' }),
      ctx,
    );
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('diagnosticPath');
    expect(text).toContain('kind="op-spec"');
    expect(written('IgnoreDiagnostics')).toBeUndefined();
  });

  it('refuses two diagnostics on the same path without diagnosticMoniker to narrow it', async () => {
    currentXml.value = `<?xml version="1.0" encoding="utf-8"?>
<IgnoreDiagnostics>
\t<Name>MyModel_BPSuppressions</Name>
\t<Items>
\t\t<Diagnostic>
\t\t\t<Path>dynamics://Form/ConDemoTicketTable</Path>
\t\t\t<Moniker>BPErrorGridCaption</Moniker>
\t\t\t<Justification>TODO</Justification>
\t\t</Diagnostic>
\t\t<Diagnostic>
\t\t\t<Path>dynamics://Form/ConDemoTicketTable</Path>
\t\t\t<Moniker>BPXmlDocMissingSummary</Moniker>
\t\t\t<Justification>TODO</Justification>
\t\t</Diagnostic>
\t</Items>
</IgnoreDiagnostics>`;
    const result = await modifyD365FileTool(
      req('ignore-diagnostic-list', 'MyModel_BPSuppressions', SUPP_PATH, {
        operation: 'remove-diagnostic-suppression',
        diagnosticPath: 'dynamics://Form/ConDemoTicketTable',
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('BPErrorGridCaption');
    expect(text).toContain('BPXmlDocMissingSummary');
    expect(text).toContain('diagnosticMoniker');
    expect(written('IgnoreDiagnostics')).toBeUndefined();
  });

  it('refuses a file that is not a suppression list', async () => {
    currentXml.value = PRIVILEGE_XML;
    const result = await modifyD365FileTool(
      req('ignore-diagnostic-list', 'ConDemoTicketMaintain', SUPP_PATH, {
        operation: 'remove-diagnostic-suppression',
        diagnosticPath: 'dynamics://Form/ConDemoTicketTable',
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text as string).toContain('not a suppression list');
    expect(written('AxSecurityPrivilege')).toBeUndefined();
  });
});

describe('add-diagnostic-suppression through the modify surface', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    currentXml.value = SUPPRESSIONS_XML;
    mockWriteFile.mockClear();
  });

  it('adds a suppression identified by diagnosticPath', async () => {
    const result = await modifyD365FileTool(
      req('ignore-diagnostic-list', 'MyModel_BPSuppressions', SUPP_PATH, {
        operation: 'add-diagnostic-suppression',
        diagnosticMoniker: 'BPErrorMissingPKConstraint',
        diagnosticPath: 'dynamics://Table/ConDemoNewTable',
        diagnosticJustification: 'Staging table, no natural key yet.',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const xml = written('IgnoreDiagnostics');
    expect(xml).toBeTruthy();
    expect(xml).toContain('dynamics://Table/ConDemoNewTable');
    expect(xml).toContain('BPErrorMissingPKConstraint');
    expect(xml).toContain('Staging table, no natural key yet.');
    // The two that were already there survive whole.
    expect(xml).toContain('dynamics://Form/ConDemoTicketTable');
    expect(xml).toContain('dynamics://SecurityPrivilege/ConDemoTicketMaintain');
  });

  it('derives diagnosticPath from diagnosticElementType + diagnosticElementName', async () => {
    const result = await modifyD365FileTool(
      req('ignore-diagnostic-list', 'MyModel_BPSuppressions', SUPP_PATH, {
        operation: 'add-diagnostic-suppression',
        diagnosticMoniker: 'BPErrorMissingPKConstraint',
        diagnosticElementType: 'AxTable',
        diagnosticElementName: 'ConDemoNewTable',
      }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(written('IgnoreDiagnostics')).toContain('dynamics://Table/ConDemoNewTable');
  });

  it('refuses a duplicate — same path AND moniker already suppressed', async () => {
    const result = await modifyD365FileTool(
      req('ignore-diagnostic-list', 'MyModel_BPSuppressions', SUPP_PATH, {
        operation: 'add-diagnostic-suppression',
        diagnosticMoniker: 'BPErrorGridCaption',
        diagnosticPath: 'dynamics://Form/ConDemoTicketTable',
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('already');
    expect(text).toContain('BPErrorGridCaption');
    expect(written('IgnoreDiagnostics')).toBeUndefined();
  });

  it('reports the missing parameter with the op spec when diagnosticMoniker is omitted', async () => {
    const result = await modifyD365FileTool(
      req('ignore-diagnostic-list', 'MyModel_BPSuppressions', SUPP_PATH, {
        operation: 'add-diagnostic-suppression',
        diagnosticPath: 'dynamics://Table/ConDemoNewTable',
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('diagnosticMoniker');
    expect(text).toContain('kind="op-spec"');
    expect(written('IgnoreDiagnostics')).toBeUndefined();
  });

  it('fails when neither diagnosticPath nor an elementType+elementName pair is given', async () => {
    const result = await modifyD365FileTool(
      req('ignore-diagnostic-list', 'MyModel_BPSuppressions', SUPP_PATH, {
        operation: 'add-diagnostic-suppression',
        diagnosticMoniker: 'BPErrorMissingPKConstraint',
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(written('IgnoreDiagnostics')).toBeUndefined();
  });

  it('creates a fresh suppression file when the model has never suppressed anything before, and says so', async () => {
    currentXml.value = null;
    const result = await modifyD365FileTool(
      req('ignore-diagnostic-list', 'MyModel_BPSuppressions', SUPP_PATH, {
        operation: 'add-diagnostic-suppression',
        diagnosticMoniker: 'BPErrorMissingPKConstraint',
        diagnosticPath: 'dynamics://Table/ConDemoNewTable',
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const xml = written('IgnoreDiagnostics');
    expect(xml).toBeTruthy();
    expect(xml).toContain('dynamics://Table/ConDemoNewTable');
    const text = result.content[0].text as string;
    expect(text).toContain('did not exist');
    expect(text).toContain('UNVERIFIED');
  });

  it('refuses a file that is not a suppression list', async () => {
    currentXml.value = PRIVILEGE_XML;
    const result = await modifyD365FileTool(
      req('ignore-diagnostic-list', 'ConDemoTicketMaintain', SUPP_PATH, {
        operation: 'add-diagnostic-suppression',
        diagnosticMoniker: 'BPErrorMissingPKConstraint',
        diagnosticPath: 'dynamics://Table/ConDemoNewTable',
      }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text as string).toContain('not a suppression list');
    expect(written('AxSecurityPrivilege')).toBeUndefined();
  });
});
