/**
 * Regression (audit finding 3, CRITICAL): directXmlModifyProperty corrupted
 * non-leaf XML elements.
 *
 * The guard counted how many times <Tag> occurred and refused only when there
 * was more than one. A single occurrence that happens to be a CONTAINER passed
 * that check, and the value rewrite `m.replace(/>[\s\S]*?</, '>' + v + '<')`
 * is non-greedy — it stopped at the first child tag, producing
 *   <DeleteActions>NewValue<AxTableDeleteAction>…</AxTableDeleteAction></DeleteActions>
 * i.e. structurally broken XML written to disk and reported as success.
 *
 * Separately, `tagName` was interpolated into `new RegExp` unescaped.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockBridgeSetProperty, mockWriteFile } = vi.hoisted(() => ({
  mockBridgeSetProperty: vi.fn(async () => ({ success: false, message: 'Bridge error [-32602]: unsupported' })),
  mockWriteFile: vi.fn(async () => {}),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return { ...actual, bridgeSetProperty: mockBridgeSetProperty, bridgeValidateAfterWrite: vi.fn(async () => null) };
});

/** A container element (<DeleteActions>) and a leaf (<Label>) on the same table. */
const TABLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
	<Name>ContosoXyzNoteHeader</Name>
	<Label>Old label</Label>
	<DeleteActions>
		<AxTableDeleteAction>
			<Name>ContosoXyzNoteLine</Name>
			<DeleteAction>Cascade</DeleteAction>
		</AxTableDeleteAction>
	</DeleteActions>
</AxTable>`;

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (p.endsWith('.xml')) return TABLE_XML;
    if (p.endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
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

const FILE_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxTable\\ContosoXyzNoteHeader.xml';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: {
    name: 'modify_d365fo_file',
    arguments: {
      objectType: 'table',
      objectName: 'ContosoXyzNoteHeader',
      operation: 'modify-property',
      filePath: FILE_PATH,
      ...args,
    },
  },
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

/** The XML actually handed to writeFile, if any. */
const writtenXml = (): string | undefined =>
  mockWriteFile.mock.calls.map(c => (c as unknown as [string, string])[1]).find(c => typeof c === 'string' && c.includes('<AxTable'));

describe('directXmlModifyProperty — leaf guard and tagName escaping (regression)', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    mockBridgeSetProperty.mockClear();
    mockWriteFile.mockClear();
    mockBridgeSetProperty.mockResolvedValue({ success: false, message: 'Bridge error [-32602]: unsupported' });
  });

  it('refuses to overwrite a container element instead of writing malformed XML', async () => {
    const result = await modifyD365FileTool(req({ propertyPath: 'DeleteActions', propertyValue: 'Cascade' }), ctx);

    expect(result.isError).toBeTruthy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/child elements/i);
    // The decisive assertion: nothing structurally broken reached the disk.
    expect(writtenXml()).toBeUndefined();
  });

  it('still sets a genuine leaf element', async () => {
    const result = await modifyD365FileTool(req({ propertyPath: 'Label', propertyValue: 'New label' }), ctx);

    expect(result.isError).toBeFalsy();
    const xml = writtenXml();
    expect(xml).toContain('<Label>New label</Label>');
    // The untouched container is still intact.
    expect(xml).toContain('<AxTableDeleteAction>');
  });

  it('writes a value containing `$&` literally rather than as a capture reference', async () => {
    await modifyD365FileTool(req({ propertyPath: 'Label', propertyValue: 'A$&B' }), ctx);
    expect(writtenXml()).toContain('<Label>A$&amp;B</Label>');
  });

  it('rejects a propertyPath that is not a plain XML element name', async () => {
    const result = await modifyD365FileTool(req({ propertyPath: 'Label(x', propertyValue: 'v' }), ctx);

    expect(result.isError).toBeTruthy();
    expect((result.content[0] as { text: string }).text).toMatch(/does not name a plain XML element/i);
    expect(writtenXml()).toBeUndefined();
  });
});
