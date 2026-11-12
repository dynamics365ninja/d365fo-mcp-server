/**
 * add-method with methodName="Control.method" on a form (#1161).
 *
 * A control override that does not exist yet is written to the form XML by this
 * server: the bridge would add a form method literally named "OkButton.clicked".
 * Data source names and overrides that already exist keep the bridge path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// The XML mock is STATEFUL: writeFile keeps what was written and readFile hands it
// back, so the writer's read-back check sees its own write.
const { mockBridgeAddMethod, mockWriteFile, fsState } = vi.hoisted(() => {
  const fsState = { xml: '' };
  return {
    fsState,
    mockBridgeAddMethod: vi.fn(),
    mockWriteFile: vi.fn(async (_p: string, content: string) => {
      if (typeof content === 'string' && content.includes('<AxForm')) fsState.xml = content;
    }),
  };
});

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddMethod: mockBridgeAddMethod,
    bridgeRefreshProvider: vi.fn(async () => ({ success: true, elapsedMs: 1 })),
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

const FORM_XML = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">',
  '\t<Name>ContosoRentDialog</Name>',
  '\t<SourceCode>',
  '\t\t<Methods xmlns="">',
  '\t\t\t<Method>',
  '\t\t\t\t<Name>classDeclaration</Name>',
  '\t\t\t\t<Source><![CDATA[',
  '[Form]',
  'public class ContosoRentDialog extends FormRun',
  '{',
  '}',
  ']]></Source>',
  '\t\t\t</Method>',
  '\t\t</Methods>',
  '\t\t<DataSources xmlns="" />',
  '\t\t<DataControls xmlns="">',
  '\t\t\t<Control>',
  '\t\t\t\t<Name>CloseButton</Name>',
  '\t\t\t\t<Type>CommandButton</Type>',
  '\t\t\t\t<Methods>',
  '\t\t\t\t\t<Method>',
  '\t\t\t\t\t\t<Name>clicked</Name>',
  '\t\t\t\t\t\t<Source><![CDATA[',
  '        public void clicked()',
  '        {',
  '            super();',
  '        }',
  '',
  ']]></Source>',
  '\t\t\t\t\t</Method>',
  '\t\t\t\t</Methods>',
  '\t\t\t</Control>',
  '\t\t</DataControls>',
  '\t\t<Members xmlns="" />',
  '\t</SourceCode>',
  '\t<DataSources>',
  '\t\t<AxFormDataSource xmlns="">',
  '\t\t\t<Name>ContosoRentHeader</Name>',
  '\t\t\t<Table>ContosoRentHeader</Table>',
  '\t\t\t<Fields />',
  '\t\t\t<ReferencedDataSources />',
  '\t\t\t<DataSourceLinks />',
  '\t\t\t<DerivedDataSources />',
  '\t\t</AxFormDataSource>',
  '\t</DataSources>',
  '\t<Design>',
  '\t\t<Controls xmlns="">',
  '\t\t\t<AxFormControl xmlns=""',
  '\t\t\t\ti:type="AxFormCommandButtonControl">',
  '\t\t\t\t<Name>OkButton</Name>',
  '\t\t\t\t<Type>CommandButton</Type>',
  '\t\t\t\t<FormControlExtension',
  '\t\t\t\t\ti:nil="true" />',
  '\t\t\t</AxFormControl>',
  '\t\t\t<AxFormControl xmlns=""',
  '\t\t\t\ti:type="AxFormCommandButtonControl">',
  '\t\t\t\t<Name>CloseButton</Name>',
  '\t\t\t\t<Type>CommandButton</Type>',
  '\t\t\t\t<FormControlExtension',
  '\t\t\t\t\ti:nil="true" />',
  '\t\t\t</AxFormControl>',
  '\t\t</Controls>',
  '\t</Design>',
  '\t<Parts />',
  '</AxForm>',
].join('\r\n');

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (typeof p === 'string' && p.endsWith('.xml')) return fsState.xml;
    if (typeof p === 'string' && p.endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: mockWriteFile,
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false, size: 100 })),
  readdir: vi.fn(async () => []),
  copyFile: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getPackagePath: vi.fn(() => 'K:\\PackagesLocalDirectory'),
    getModelName: vi.fn(() => 'ContosoExt'),
    getWriteAnchorModel: vi.fn(() => 'ContosoExt'),
    getToolProjectSwitch: vi.fn(() => null),
    getPackageNameFromWorkspacePath: vi.fn(() => 'ContosoExt'),
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
  resolveRegularObjectPrefixToken: vi.fn(() => ''),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
}));

const FILE_PATH = 'K:\\PackagesLocalDirectory\\ContosoExt\\ContosoExt\\AxForm\\ContosoRentDialog.xml';
const CLICKED = '/// <summary>\n/// Closes the dialog.\n/// </summary>\npublic void clicked()\n{\n    super();\n    element.close();\n}';

const addMethod = (methodName: string, sourceCode = CLICKED): CallToolRequest => ({
  method: 'tools/call',
  params: {
    name: 'modify_d365fo_file',
    arguments: {
      objectType: 'form', objectName: 'ContosoRentDialog', operation: 'add-method',
      filePath: FILE_PATH, methodName, sourceCode,
    },
  },
});

const buildContext = (): XppServerContext => {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
  return {
    symbolIndex: {
      searchSymbols: vi.fn(() => []),
      getSymbolByName: vi.fn(() => undefined),
      getCustomModels: vi.fn(() => ['ContosoExt']),
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

const textOf = (r: any): string => r.content.map((c: any) => c.text).join('\n');

beforeEach(() => {
  fsState.xml = FORM_XML;
  mockWriteFile.mockClear();
  mockBridgeAddMethod.mockReset();
  mockBridgeAddMethod.mockResolvedValue({ success: true, message: "✅ Method added via IMetaFormProvider.Update" });
});

describe('add-method — Control.method on a form', () => {
  it('writes the first override of a control into <DataControls>, without the bridge', async () => {
    const r = await modifyD365FileTool(addMethod('OkButton.clicked'), buildContext());

    expect(r.isError, textOf(r)).toBeFalsy();
    expect(mockBridgeAddMethod).not.toHaveBeenCalled();
    expect(fsState.xml).toContain([
      '\t\t\t</Control>',
      '\t\t\t<Control>',
      '\t\t\t\t<Name>OkButton</Name>',
      '\t\t\t\t<Type>CommandButton</Type>',
      '\t\t\t\t<Methods>',
      '\t\t\t\t\t<Method>',
      '\t\t\t\t\t\t<Name>clicked</Name>',
      '\t\t\t\t\t\t<Source><![CDATA[',
    ].join('\r\n'));
    expect(fsState.xml).toContain('element.close();');
    // No form method with a dot in its name, CRLF throughout, the rest untouched.
    expect(fsState.xml).not.toContain('<Name>OkButton.clicked</Name>');
    expect(fsState.xml).not.toMatch(/[^\r]\n/);
    expect(fsState.xml.startsWith(FORM_XML.slice(0, FORM_XML.indexOf('\t\t</DataControls>')))).toBe(true);
    expect(textOf(r)).toContain("control 'OkButton'");
  });

  it('refuses a name that is neither a data source nor a control, naming close controls', async () => {
    const r = await modifyD365FileTool(addMethod('OkButon.clicked'), buildContext());

    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("no data source and no control named 'OkButon'");
    expect(textOf(r)).toContain('OkButton');
    expect(mockBridgeAddMethod).not.toHaveBeenCalled();
    expect(fsState.xml).toBe(FORM_XML);
  });

  it('leaves a data source override to the bridge', async () => {
    const r = await modifyD365FileTool(addMethod('ContosoRentHeader.active', 'public int active()\n{\n    return super();\n}'), buildContext());

    expect(r.isError, textOf(r)).toBeFalsy();
    expect(mockBridgeAddMethod).toHaveBeenCalledTimes(1);
    expect(mockBridgeAddMethod.mock.calls[0][3]).toBe('ContosoRentHeader.active');
    expect(fsState.xml).toBe(FORM_XML);
  });

  it('leaves an override that already exists to the bridge, which updates it in place', async () => {
    const r = await modifyD365FileTool(addMethod('CloseButton.clicked'), buildContext());

    expect(r.isError, textOf(r)).toBeFalsy();
    expect(mockBridgeAddMethod).toHaveBeenCalledTimes(1);
    expect(mockBridgeAddMethod.mock.calls[0][3]).toBe('CloseButton.clicked');
    expect(fsState.xml).toBe(FORM_XML);
  });
});
