/**
 * add-delete-action / remove-delete-action — finding #36.
 *
 * The modify surface had no operation for table DeleteActions at all, so a
 * cascading delete action was inexpressible: the only way to land one was
 * d365fo_file(action="create", overwrite=true), the whole-file escape hatch the
 * eval loop forbids. There is no bridge op either (MetadataWriteService only
 * writes DeleteActions as a side effect of table creation), so the op is backed
 * by a direct-XML writer — same pattern as directXmlAddIndex.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return { ...actual, bridgeValidateAfterWrite: vi.fn(async () => null) };
});

/** Header table with an empty <DeleteActions /> collection. */
const TABLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoHeader</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ConDemoHeader extends common
{
}
]]></Declaration>
\t\t<Methods />
\t</SourceCode>
\t<Label>@Contoso:Header</Label>
\t<DeleteActions />
\t<FieldGroups />
\t<Fields>
\t\t<AxTableField xmlns="" i:type="AxTableFieldString">
\t\t\t<Name>HeaderId</Name>
\t\t\t<ExtendedDataType>Num</ExtendedDataType>
\t\t</AxTableField>
\t</Fields>
\t<FullTextIndexes />
\t<Indexes />
\t<Mappings />
\t<Relations />
\t<StateMachines />
</AxTable>`;

/** Same table, with one delete action already present. */
const TABLE_WITH_ACTION_XML = TABLE_XML.replace(
  '\t<DeleteActions />',
  '\t<DeleteActions>\n\t\t<AxTableDeleteAction>\n\t\t\t<Name>ConDemoLine</Name>\n' +
  '\t\t\t<Table>ConDemoLine</Table>\n\t\t\t<DeleteAction>Cascade</DeleteAction>\n' +
  '\t\t</AxTableDeleteAction>\n\t</DeleteActions>',
);

const { mockWriteFile, currentXml } = vi.hoisted(() => ({
  mockWriteFile: vi.fn(async () => {}),
  currentXml: { value: '' },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (typeof p === 'string' && p.endsWith('.xml')) return currentXml.value;
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

const FILE_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ConDemoHeader.xml';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'modify_d365fo_file', arguments: { objectType: 'table', objectName: 'ConDemoHeader', filePath: FILE_PATH, ...args } },
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

/** The written XML that carries a delete-action edit. */
const captured = (): string | undefined => {
  const call = mockWriteFile.mock.calls.find((c: any[]) => typeof c[1] === 'string' && c[1].includes('<DeleteAction'));
  return call?.[1] as string | undefined;
};

describe('table DeleteActions via the modify surface (#36)', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    currentXml.value = TABLE_XML;
    mockWriteFile.mockClear();
  });

  it('adds a cascading delete action in canonical shape', async () => {
    const result = await modifyD365FileTool(
      req({ operation: 'add-delete-action', deleteActionName: 'ConDemoLine', deleteActionType: 'Cascade' }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const xml = captured();
    expect(xml).toBeTruthy();
    expect(xml).toMatch(
      /<DeleteActions>\s*<AxTableDeleteAction>\s*<Name>ConDemoLine<\/Name>\s*<Table>ConDemoLine<\/Table>\s*<DeleteAction>Cascade<\/DeleteAction>\s*<\/AxTableDeleteAction>\s*<\/DeleteActions>/,
    );
    expect(xml).not.toContain('<DeleteActions />');
  });

  it('never steers the agent into create overwrite=true', async () => {
    const result = await modifyD365FileTool(
      req({ operation: 'add-delete-action', deleteActionName: 'ConDemoLine', deleteActionType: 'Cascade' }),
      ctx,
    );
    expect(result.content[0].text as string).not.toMatch(/overwrite=true/);
  });

  it('defaults deleteActionTable to the name and the type to Restricted', async () => {
    await modifyD365FileTool(req({ operation: 'add-delete-action', deleteActionName: 'ConDemoLine' }), ctx);
    const xml = captured();
    expect(xml).toContain('<Table>ConDemoLine</Table>');
    expect(xml).toContain('<DeleteAction>Restricted</DeleteAction>');
  });

  it('honours a deleteActionTable distinct from the action name', async () => {
    await modifyD365FileTool(
      req({ operation: 'add-delete-action', deleteActionName: 'Lines', deleteActionTable: 'ConDemoLine', deleteActionType: 'CascadeRestricted' }),
      ctx,
    );
    const xml = captured();
    expect(xml).toContain('<Name>Lines</Name>');
    expect(xml).toContain('<Table>ConDemoLine</Table>');
    expect(xml).toContain('<DeleteAction>CascadeRestricted</DeleteAction>');
  });

  it('is idempotent — an existing action is not duplicated', async () => {
    currentXml.value = TABLE_WITH_ACTION_XML;
    const result = await modifyD365FileTool(
      req({ operation: 'add-delete-action', deleteActionName: 'ConDemoLine', deleteActionType: 'Cascade' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text as string).toMatch(/idempotent/i);
    expect(captured()).toBeUndefined();
  });

  it('removes an existing delete action', async () => {
    currentXml.value = TABLE_WITH_ACTION_XML;
    const result = await modifyD365FileTool(
      req({ operation: 'remove-delete-action', deleteActionName: 'ConDemoLine' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const written = mockWriteFile.mock.calls.find(
      (c: any[]) => typeof c[1] === 'string' && c[1].includes('<AxTable'),
    )?.[1] as string | undefined;
    expect(written).toBeTruthy();
    expect(written).not.toContain('<AxTableDeleteAction>');
  });

  it('refuses to patch a non-table file', async () => {
    currentXml.value = `<?xml version="1.0" encoding="utf-8"?>\n<AxEnum><Name>ConDemoStatus</Name></AxEnum>`;
    const result = await modifyD365FileTool(
      req({ operation: 'add-delete-action', deleteActionName: 'ConDemoLine' }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(captured()).toBeUndefined();
  });
});
