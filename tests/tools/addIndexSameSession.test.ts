/**
 * Regression tests — add-index on a table CREATED THIS SESSION
 *
 * Corpus evidence:
 *   eval/corpus/runs/2026-07-21T19__L2-error-handling-infolog__c262b19.json
 *   eval/corpus/runs/2026-07-21T20__L3-workflow-document-submit__c262b19.json
 *
 * Defect cluster #16 / #23 / #29 (all on the bridge-backed modify surface):
 *
 *  The C# bridge's AddIndex resolves its table via _provider.Tables.Read(name),
 *  whose DiskProvider metadata roots are fixed at bridge startup. A table created
 *  earlier in the SAME session is therefore reported "Table '<name>' not found" —
 *  even after a successful update_symbol_index(filePath) and even when an explicit
 *  filePath was supplied (filePath only steers the TS-side file lookup, never the
 *  bridge's own name resolution — #23). With no working grounded path, every
 *  table-shaped case in the sweep was forced into d365fo_file(action="create",
 *  overwrite=true) — the whole-file escape hatch the eval loop forbids (HEADLINE 2).
 *
 *  The C# resolution itself needs the live Microsoft.Dynamics metadata provider and
 *  cannot be exercised VM-free, so the fix lands TS-side: when the bridge cannot
 *  resolve the same-session table, add-index now writes the <AxTableIndex> straight
 *  into the on-disk <Indexes> collection (directXmlAddIndex) — the same direct-XML
 *  fallback pattern that already backs modify-property / replace-code /
 *  add-menu-item-to-menu / add-control(form-extension). These tests pin that the
 *  grounded op now COMPLETES instead of dead-ending, in the exact serialised shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// ─── Bridge mock: simulate the same-session resolution failure ────────────────

const { mockBridgeAddIndex, mockBridgeRefreshProvider } = vi.hoisted(() => ({
  mockBridgeAddIndex: vi.fn(),
  mockBridgeRefreshProvider: vi.fn(async () => ({ success: true, elapsedMs: 1 })),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddIndex: mockBridgeAddIndex,
    bridgeRefreshProvider: mockBridgeRefreshProvider,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

// ─── fs/promises mock (capture writeFile output) ──────────────────────────────

/** A table created this session, still with an EMPTY <Indexes /> collection. */
const TABLE_NO_INDEX_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoTicket</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ConDemoTicket extends common
{
}
]]></Declaration>
\t\t<Methods />
\t</SourceCode>
\t<Label>@TaxTransactionInquiry:HeaderNote</Label>
\t<TitleField1>TicketId</TitleField1>
\t<DeleteActions />
\t<FieldGroups />
\t<Fields>
\t\t<AxTableField xmlns="" i:type="AxTableFieldString">
\t\t\t<Name>TicketId</Name>
\t\t\t<ExtendedDataType>Num</ExtendedDataType>
\t\t</AxTableField>
\t</Fields>
\t<FullTextIndexes />
\t<Indexes />
\t<Mappings />
\t<Relations />
\t<StateMachines />
</AxTable>`;

/**
 * The same starting point one level up: a table EXTENSION created this session.
 * Shape copied from eval/goldens/L2-table-extension/CustGroup.ConExtension.metadata.xml —
 * an AxTableExtension carries the same <Indexes> collection an AxTable does.
 */
const TABLE_EXTENSION_NO_INDEX_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTableExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>CustGroup.MyModelExtension</Name>
\t<FieldGroupExtensions />
\t<FieldGroups />
\t<FieldModifications />
\t<Fields>
\t\t<AxTableField xmlns="" i:type="AxTableFieldString">
\t\t\t<Name>TicketId</Name>
\t\t\t<ExtendedDataType>Num</ExtendedDataType>
\t\t</AxTableField>
\t</Fields>
\t<FullTextIndexes />
\t<Indexes />
\t<Mappings />
\t<PropertyModifications />
\t<RelationExtensions />
\t<RelationModifications />
\t<Relations />
</AxTableExtension>`;

/**
 * Which fixture readFile serves — switched per describe block. Held in a vi.hoisted
 * box because vi.mock factories are lifted above these declarations.
 */
const { fixture, mockWriteFile } = vi.hoisted(() => ({
  fixture: { xml: '' },
  mockWriteFile: vi.fn(async () => {}),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (typeof p === 'string' && p.endsWith('.xml')) return fixture.xml;
    if (typeof p === 'string' && p.endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: mockWriteFile,
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
  readdir: vi.fn(async () => []),
  copyFile: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getPackagePath: vi.fn(() => 'K:\\PackagesLocalDirectory'),
    getModelName: vi.fn(() => 'MyModel'),
    // Writes are measured against the anchor, not the active model (see getWriteAnchorModel).
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
    resolve: vi.fn(async (m: string) => ({
      packageName: m,
      modelName: m,
      rootPath: 'K:\\PackagesLocalDirectory',
    })),
    resolveWithPackage: vi.fn((m: string, p: string) => ({
      packageName: p,
      modelName: m,
      rootPath: 'K:\\PackagesLocalDirectory',
    })),
  })),
}));

vi.mock('../../src/utils/modelClassifier', () => ({
  registerCustomModel: vi.fn(),
  resolveObjectPrefix: vi.fn(() => ''),
  applyObjectPrefix: vi.fn((name: string) => name),
  // Empty, like resolveObjectPrefix above: these cases are about index XML
  // shape, so leaving names unprefixed keeps the fixtures readable. Extension
  // member prefixing has its own tests (tests/tools/extensionMemberPrefix).
  resolveRegularObjectPrefixToken: vi.fn(() => ''),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
}));

const TABLE_FILE_PATH =
  'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ConDemoTicket.xml';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'modify_d365fo_file', arguments: args },
});

const addIndexReq = (extra: Record<string, unknown> = {}) =>
  req({
    objectType: 'table',
    objectName: 'ConDemoTicket',
    operation: 'add-index',
    indexName: 'TicketIdx',
    indexFields: [{ fieldName: 'TicketId' }],
    indexAlternateKey: true,
    filePath: TABLE_FILE_PATH,
    ...extra,
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
    cache: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      generateSearchKey: vi.fn((q: string) => `k:${q}`),
    } as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
    bridge: { isReady: true, metadataAvailable: true } as any,
  };
};

/** Return the XML content of the writeFile call that landed the index. */
const capturedIndexXml = (): string | undefined => {
  const call = mockWriteFile.mock.calls.find(
    (c: any[]) => typeof c[1] === 'string' && c[1].includes('<AxTableIndex>'),
  );
  return call?.[1] as string | undefined;
};

describe('add-index on a same-session table (bridge cannot resolve it)', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    fixture.xml = TABLE_NO_INDEX_XML;
    mockBridgeAddIndex.mockReset();
    mockBridgeRefreshProvider.mockClear();
    mockWriteFile.mockClear();
  });

  // The exact bridge failure the corpus recorded: the C# provider's fixed
  // metadata roots don't contain the table written this session.
  const RESOLUTION_FAILURE = { success: false, message: "Table 'ConDemoTicket' not found" };

  it('completes via the direct-XML fallback instead of dead-ending', async () => {
    mockBridgeAddIndex.mockResolvedValue(RESOLUTION_FAILURE);

    const result = await modifyD365FileTool(addIndexReq(), ctx);

    // On main this throws unresolvedObjectError (isError) — the whole point.
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text as string;
    expect(text).toMatch(/direct XML fallback/i);
    // The op reports SUCCESS, not the dead-end "could not resolve" GUIDANCE that
    // used to steer the agent away (the honest one-line reason may still mention
    // that the bridge could not resolve it — that is a note, not a failure).
    expect(text).not.toMatch(/Bridge operation '.*' could not resolve/i);
  });

  it('never steers the agent into create overwrite=true', async () => {
    mockBridgeAddIndex.mockResolvedValue(RESOLUTION_FAILURE);
    const result = await modifyD365FileTool(addIndexReq(), ctx);
    const text = result.content[0].text as string;
    expect(text).not.toMatch(/overwrite=true/);
  });

  it('writes the AxTableIndex into the <Indexes> collection in canonical shape', async () => {
    mockBridgeAddIndex.mockResolvedValue(RESOLUTION_FAILURE);

    await modifyD365FileTool(addIndexReq(), ctx);

    const xml = capturedIndexXml();
    expect(xml).toBeTruthy();
    // The index lands inside the <Indexes> collection, not loose in the file.
    expect(xml).toMatch(/<Indexes>[\s\S]*<AxTableIndex>[\s\S]*<\/AxTableIndex>[\s\S]*<\/Indexes>/);
    // Canonical element order: Name, AllowDuplicates, AlternateKey, Fields.
    expect(xml).toMatch(
      /<AxTableIndex>\s*<Name>TicketIdx<\/Name>\s*<AllowDuplicates>No<\/AllowDuplicates>\s*<AlternateKey>Yes<\/AlternateKey>\s*<Fields>\s*<AxTableIndexField>\s*<DataField>TicketId<\/DataField>\s*<\/AxTableIndexField>\s*<\/Fields>\s*<\/AxTableIndex>/,
    );
    // The empty self-closing collection must be gone.
    expect(xml).not.toContain('<Indexes />');
  });

  it('omits <AlternateKey> when not requested and defaults AllowDuplicates to No', async () => {
    mockBridgeAddIndex.mockResolvedValue(RESOLUTION_FAILURE);

    await modifyD365FileTool(
      addIndexReq({ indexAlternateKey: undefined, indexAllowDuplicates: undefined }),
      ctx,
    );

    const xml = capturedIndexXml();
    expect(xml).toBeTruthy();
    expect(xml).toContain('<AllowDuplicates>No</AllowDuplicates>');
    expect(xml).not.toContain('<AlternateKey>');
  });

  it('does not run the fallback when the bridge itself succeeded', async () => {
    mockBridgeAddIndex.mockResolvedValue({
      success: true,
      message: "✅ Index 'TicketIdx' added via IMetaTableProvider.Update",
    });

    const result = await modifyD365FileTool(addIndexReq(), ctx);

    expect(result.isError).toBeFalsy();
    // The bridge wrote the index through the provider — no direct-XML write of it.
    expect(capturedIndexXml()).toBeUndefined();
  });
});

/**
 * Same defect, one level up. #799 taught the C# AddIndex to fall back from Tables to
 * TableExtensions, but the provider still resolves against metadata roots fixed at
 * bridge startup — so an extension CREATED THIS SESSION is exactly as unresolvable as
 * the table above, and the direct-XML fallback used to refuse it: its shape guard was
 * /<AxTable\b/, and `\b` does not match `<AxTableExtension` (E is a word character).
 */
describe('add-index on a same-session table-EXTENSION', () => {
  let ctx: XppServerContext;

  const EXT_FILE_PATH =
    'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTableExtension\\CustGroup.MyModelExtension.xml';

  const addIndexToExtensionReq = (extra: Record<string, unknown> = {}) =>
    req({
      objectType: 'table-extension',
      objectName: 'CustGroup.MyModelExtension',
      operation: 'add-index',
      indexName: 'TicketIdx',
      indexFields: [{ fieldName: 'TicketId' }],
      filePath: EXT_FILE_PATH,
      ...extra,
    });

  const RESOLUTION_FAILURE = {
    success: false,
    message: "Table or table-extension 'CustGroup.MyModelExtension' not found",
  };

  beforeEach(() => {
    ctx = buildContext();
    fixture.xml = TABLE_EXTENSION_NO_INDEX_XML;
    mockBridgeAddIndex.mockReset();
    mockBridgeRefreshProvider.mockClear();
    mockWriteFile.mockClear();
  });

  it('completes via the direct-XML fallback instead of dead-ending', async () => {
    mockBridgeAddIndex.mockResolvedValue(RESOLUTION_FAILURE);

    const result = await modifyD365FileTool(addIndexToExtensionReq(), ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text as string).toMatch(/direct XML fallback/i);
  });

  it('writes the AxTableIndex into the extension\'s own <Indexes> collection', async () => {
    mockBridgeAddIndex.mockResolvedValue(RESOLUTION_FAILURE);

    await modifyD365FileTool(addIndexToExtensionReq(), ctx);

    const xml = capturedIndexXml();
    expect(xml).toBeTruthy();
    // Still an AxTableExtension, with the index inside <Indexes> — not appended to
    // FullTextIndexes, RelationExtensions or any of the neighbouring collections.
    expect(xml).toContain('<AxTableExtension');
    expect(xml).toMatch(/<Indexes>[\s\S]*<AxTableIndex>[\s\S]*<\/AxTableIndex>[\s\S]*<\/Indexes>/);
    expect(xml).toMatch(/<Name>TicketIdx<\/Name>/);
    expect(xml).not.toContain('<Indexes />');
    // The collections that must NOT have been touched are still self-closing.
    expect(xml).toContain('<FullTextIndexes />');
    expect(xml).toContain('<RelationExtensions />');
  });

  it('leaves a shape that carries no <Indexes> collection alone', async () => {
    // An AxClass has no <Indexes> anywhere — the guard must refuse rather than
    // invent one, so a mis-typed objectType can never corrupt an unrelated file.
    fixture.xml = `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>MyClass</Name>
</AxClass>`;
    mockBridgeAddIndex.mockResolvedValue(RESOLUTION_FAILURE);

    await modifyD365FileTool(addIndexToExtensionReq(), ctx);

    expect(capturedIndexXml()).toBeUndefined();
  });
});
