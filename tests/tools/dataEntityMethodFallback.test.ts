/**
 * Regression tests — add-method / remove-method on a data-entity.
 *
 * The C# bridge's AddMethod had no data-entity arm, so the call failed with
 * "add-method not supported for objectType 'data-entity' via bridge (use XML
 * fallback)" — and nothing used the XML fallback the message named. Found on
 * AVADemandPlanningEntity: 0/3 operations applied. The server now falls back to
 * the root <SourceCode><Methods> writer when the bridge declines the type.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import { isBridgeUnsupportedTypeDecline } from '../../src/tools/write/methodXmlFallback';
import { upsertSourceCodeMethod, removeSourceCodeMethod } from '../../src/tools/write/directXmlWriters';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockBridgeAddMethod, mockBridgeRemoveMethod, mockWriteFile, state } = vi.hoisted(() => ({
  mockBridgeAddMethod: vi.fn(),
  mockBridgeRemoveMethod: vi.fn(),
  mockWriteFile: vi.fn(),
  state: { xml: '' },
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddMethod: mockBridgeAddMethod,
    bridgeRemoveMethod: mockBridgeRemoveMethod,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

const ENTITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
	<Name>AVADemandPlanningEntity</Name>
	<SourceCode>
		<Declaration><![CDATA[
/// <summary>
/// Demand planning entity.
/// </summary>
public class AVADemandPlanningEntity extends common
{
}
]]></Declaration>
		<Methods>
			<Method>
				<Name>postLoad</Name>
				<Source><![CDATA[
    /// <summary>
    /// Post load.
    /// </summary>
    public void postLoad()
    {
        super();
    }

]]></Source>
			</Method>
		</Methods>
	</SourceCode>
	<Label>Demand planning</Label>
	<Fields />
</AxDataEntityView>`;

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (p.endsWith('.xml')) return state.xml;
    if (p.endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: mockWriteFile,
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
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

const FILE_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxDataEntityView\\AVADemandPlanningEntity.xml';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: {
    name: 'modify_d365fo_file',
    arguments: { objectType: 'data-entity', objectName: 'AVADemandPlanningEntity', filePath: FILE_PATH, ...args },
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

const declined = (op: string) => ({
  success: false,
  message: `Error: Bridge error [-32602]: ${op} not supported for objectType 'data-entity' via bridge (use XML fallback)`,
});

const STRIP_METHOD = `public static str stripLineBreaks(str _s)
{
    return strReplace(strReplace(_s, '\\r', ''), '\\n', ' ');
}`;

describe('upsertSourceCodeMethod / removeSourceCodeMethod', () => {
  it('appends a method after the existing ones, leaving the declaration alone', () => {
    const r = upsertSourceCodeMethod(ENTITY_XML.replace(/\r\n/g, '\n'), 'stripLineBreaks', STRIP_METHOD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replaced).toBe(false);
    const names = [...r.xml.matchAll(/<Method>\s*<Name>([^<]+)<\/Name>/g)].map(m => m[1]);
    expect(names).toEqual(['postLoad', 'stripLineBreaks']);
    expect(r.xml).toContain('\t\t\t<Method>\n\t\t\t\t<Name>stripLineBreaks</Name>\n\t\t\t\t<Source><![CDATA[\npublic static str stripLineBreaks');
    expect(r.xml).toMatch(/<\/Method>\n\t\t<\/Methods>\n\t<\/SourceCode>/);
  });

  it('is not fooled by <summary> markup inside the declaration CDATA', () => {
    const r = upsertSourceCodeMethod(ENTITY_XML, 'x', 'void x() {}');
    expect(r.ok && r.xml.indexOf('<Name>x</Name>')).toBeGreaterThan(ENTITY_XML.indexOf('<Methods>'));
  });

  it('replaces an existing method in place (case-insensitive), like the bridge upsert', () => {
    const r = upsertSourceCodeMethod(ENTITY_XML, 'POSTLOAD', 'public void postLoad()\n{\n    super();\n    this.x();\n}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replaced).toBe(true);
    expect(r.xml.match(/<Method>/g)).toHaveLength(1);
    expect(r.xml).toContain('this.x();');
  });

  it('expands a self-closing <Methods /> and creates a missing one', () => {
    const selfClosing = ENTITY_XML.replace(/<Methods>[\s\S]*<\/Methods>/, '<Methods />');
    const a = upsertSourceCodeMethod(selfClosing, 'm', 'void m() {}');
    expect(a.ok && a.xml).toMatch(/<Methods>\n\t\t\t<Method>\n\t\t\t\t<Name>m<\/Name>[\s\S]*<\/Method>\n\t\t<\/Methods>/);

    const absent = ENTITY_XML.replace(/\t\t<Methods>[\s\S]*<\/Methods>\n/, '');
    const b = upsertSourceCodeMethod(absent, 'm', 'void m() {}');
    expect(b.ok && b.xml).toMatch(/\]\]><\/Declaration>\n\t\t<Methods>\n\t\t\t<Method>[\s\S]*<\/Methods>\n\t<\/SourceCode>/);
  });

  it('refuses source that would close the CDATA section early', () => {
    expect(upsertSourceCodeMethod(ENTITY_XML, 'm', 'str s = "]]>";').ok).toBe(false);
  });

  it('removes a method and collapses an emptied collection to <Methods />', () => {
    const r = removeSourceCodeMethod(ENTITY_XML, 'postLoad');
    expect(r.ok && r.xml).toMatch(/\]\]><\/Declaration>\n\t\t<Methods \/>\n\t<\/SourceCode>/);
    expect(removeSourceCodeMethod(ENTITY_XML, 'nope').ok).toBe(false);
  });
});

describe('isBridgeUnsupportedTypeDecline', () => {
  it('matches only the bridge\'s no-arm refusal', () => {
    expect(isBridgeUnsupportedTypeDecline(declined('add-method'))).toBe(true);
    expect(isBridgeUnsupportedTypeDecline({ success: false, message: "Data entity 'X' not found" })).toBe(false);
    expect(isBridgeUnsupportedTypeDecline({ success: true, message: 'ok' })).toBe(false);
    expect(isBridgeUnsupportedTypeDecline(null)).toBe(false);
  });
});

describe('data-entity add-method / remove-method fall back to XML when the bridge declines', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    state.xml = ENTITY_XML;
    mockBridgeAddMethod.mockReset().mockResolvedValue(declined('add-method'));
    mockBridgeRemoveMethod.mockReset().mockResolvedValue(declined('remove-method'));
    mockWriteFile.mockReset().mockImplementation(async (_p: string, content: string) => {
      if (String(content).includes('<AxDataEntityView')) state.xml = String(content);
    });
  });

  it('adds the method via the XML writer instead of failing', async () => {
    const result = await modifyD365FileTool(
      req({ operation: 'add-method', methodName: 'stripLineBreaks', sourceCode: STRIP_METHOD }),
      ctx,
    );
    expect(result.isError, result.content[0].text).toBeFalsy();
    expect(mockBridgeAddMethod).toHaveBeenCalledTimes(1);
    expect(state.xml).toContain('<Name>stripLineBreaks</Name>');
    expect(state.xml).toContain('<Name>postLoad</Name>');
    expect(result.content[0].text).not.toMatch(/Bridge operation 'add-method' failed/);
  });

  it('adds several methods from one sourceCode', async () => {
    const two = `${STRIP_METHOD}\n\npublic static str replaceLineBreaks(str _s, str _with)\n{\n    return strReplace(_s, '\\n', _with);\n}`;
    const result = await modifyD365FileTool(req({ operation: 'add-method', sourceCode: two }), ctx);
    expect(result.isError, result.content[0].text).toBeFalsy();
    const names = [...state.xml.matchAll(/<Method>\s*<Name>([^<]+)<\/Name>/g)].map(m => m[1]);
    expect(names).toEqual(['postLoad', 'stripLineBreaks', 'replaceLineBreaks']);
  });

  it('removes the method via the XML writer', async () => {
    const result = await modifyD365FileTool(req({ operation: 'remove-method', methodName: 'postLoad' }), ctx);
    expect(result.isError, result.content[0].text).toBeFalsy();
    expect(state.xml).not.toContain('<Name>postLoad</Name>');
  });

  it('leaves other bridge failures alone (no XML write)', async () => {
    mockBridgeAddMethod.mockResolvedValue({ success: false, message: 'Bridge addMethod returned success=false' });
    const result = await modifyD365FileTool(
      req({ operation: 'add-method', methodName: 'stripLineBreaks', sourceCode: STRIP_METHOD }),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(state.xml).toBe(ENTITY_XML);
  });
});
