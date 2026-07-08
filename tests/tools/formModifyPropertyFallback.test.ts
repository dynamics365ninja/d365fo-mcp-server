/**
 * Regression tests — modify-property direct-XML fallback for forms.
 *
 * The C# bridge rejects modify-property outright for AxForm ("modify-property
 * not supported for objectType 'form' via bridge") even for a plain text
 * element like <Caption> that's trivially editable by string replacement —
 * found while building eval case L1-form-basic (Phase 5). This exercises the
 * new directXmlModifyProperty fallback in modifyD365File.ts, which only
 * activates when the bridge itself reports failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockBridgeSetProperty, mockWriteFile } = vi.hoisted(() => ({
  mockBridgeSetProperty: vi.fn(async () => ({
    success: false,
    message: "Bridge error [-32602]: modify-property not supported for objectType 'form' via bridge",
  })),
  mockWriteFile: vi.fn(async () => {}),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeSetProperty: mockBridgeSetProperty,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

const FORM_XML_ONE_CAPTION = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
	<Name>ContosoXyzNoteHeaderList</Name>
	<Design>
		<Caption xmlns="">Note headers</Caption>
		<DataSource xmlns="">ContosoXyzNoteHeader</DataSource>
	</Design>
</AxForm>`;

const FORM_XML_TWO_CAPTIONS = `<?xml version="1.0" encoding="utf-8"?>
<AxForm>
	<Design>
		<Caption xmlns="">First</Caption>
	</Design>
	<Parts>
		<Part>
			<Caption xmlns="">Second</Caption>
		</Part>
	</Parts>
</AxForm>`;

let currentFormXml = FORM_XML_ONE_CAPTION;

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (p.endsWith('.xml')) return currentFormXml;
    if (p.endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: mockWriteFile,
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
  readdir: vi.fn(async () => []),
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
    resolve: vi.fn(async (m: string) => ({
      packageName: m, modelName: m, rootPath: 'K:\\PackagesLocalDirectory',
    })),
    resolveWithPackage: vi.fn((m: string, p: string) => ({
      packageName: p, modelName: m, rootPath: 'K:\\PackagesLocalDirectory',
    })),
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

const FORM_FILE_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxForm\\ContosoXyzNoteHeaderList.xml';

const req = (name: string, args: Record<string, unknown> = {}): CallToolRequest => ({
  method: 'tools/call',
  params: { name, arguments: args },
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

describe('modify-property direct-XML fallback for forms (regression)', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    currentFormXml = FORM_XML_ONE_CAPTION;
    mockBridgeSetProperty.mockClear();
    mockWriteFile.mockClear();
    mockBridgeSetProperty.mockResolvedValue({
      success: false,
      message: "Bridge error [-32602]: modify-property not supported for objectType 'form' via bridge",
    });
  });

  it('falls back to direct XML editing when the bridge rejects modify-property for a form', async () => {
    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'form',
        objectName: 'ContosoXyzNoteHeaderList',
        operation: 'modify-property',
        propertyPath: 'Caption',
        propertyValue: '@MyModel:HeaderNote',
        filePath: FORM_FILE_PATH,
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/direct XML fallback/i);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [, writtenContent] = mockWriteFile.mock.calls[0];
    expect(writtenContent).toContain('<Caption xmlns="">@MyModel:HeaderNote</Caption>');
    expect(writtenContent).not.toContain('Note headers');
  });

  it('refuses to guess when the property element appears more than once', async () => {
    currentFormXml = FORM_XML_TWO_CAPTIONS;

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'form',
        objectName: 'ContosoXyzNoteHeaderList',
        operation: 'modify-property',
        propertyPath: 'Caption',
        propertyValue: '@MyModel:HeaderNote',
        filePath: FORM_FILE_PATH,
      }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/ambiguous/i);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('surfaces the original bridge error when the property element is not found on disk', async () => {
    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'form',
        objectName: 'ContosoXyzNoteHeaderList',
        operation: 'modify-property',
        propertyPath: 'ThisPropertyDoesNotExist',
        propertyValue: 'x',
        filePath: FORM_FILE_PATH,
      }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not supported for objectType 'form'/i);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
