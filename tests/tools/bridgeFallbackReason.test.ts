/**
 * Regression tests — the direct-XML fallbacks must name the reason they engaged.
 *
 * Sweep finding #4: a replace-code call reported "✅ Code replaced via direct XML
 * fallback (bridge was unavailable)" twice mid-session while a third call seconds
 * later went through the bridge's Update just fine. The bridge was healthy; the
 * message was hardcoded. It is the true reason in only one of the four ways the
 * bridge path can decline (unavailable / unsupported type / SDK declined / threw),
 * so an agent reading it goes off to restart a bridge that is fine — and a real
 * outage looks identical to a form control override the SDK cannot reach.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  modifyD365FileTool,
  describeBridgeFallbackReason,
} from '../../src/tools/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

describe('describeBridgeFallbackReason', () => {
  const ready = { isReady: true, metadataAvailable: true };

  it('reports an outage only when the bridge is actually down', () => {
    expect(describeBridgeFallbackReason(undefined, 'form', 'replace-code', null))
      .toBe('the bridge was unavailable');
    expect(describeBridgeFallbackReason({ isReady: false }, 'form', 'replace-code', null))
      .toBe('the bridge was unavailable');
    expect(describeBridgeFallbackReason({ isReady: true, metadataAvailable: false }, 'form', 'replace-code', null))
      .toBe('the bridge was unavailable');
  });

  it('names an unsupported objectType instead of blaming availability', () => {
    const reason = describeBridgeFallbackReason(ready, 'security-privilege', 'replace-code', null);
    expect(reason).toContain('does not support');
    expect(reason).toContain('security-privilege');
    expect(reason).not.toContain('unavailable');
  });

  it('quotes the bridge\'s own refusal when it was reachable but declined', () => {
    const reason = describeBridgeFallbackReason(ready, 'form', 'replace-code', {
      success: false,
      message: 'Bridge replaceCode returned success=false',
    });
    expect(reason).toContain('reachable');
    expect(reason).toContain('Bridge replaceCode returned success=false');
    expect(reason).not.toContain('unavailable');
  });
});

const { mockBridgeReplaceCode, mockWriteFile } = vi.hoisted(() => ({
  mockBridgeReplaceCode: vi.fn(async () => ({
    success: false,
    message: 'Bridge replaceCode returned success=false',
  })),
  mockWriteFile: vi.fn(async () => {}),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeReplaceCode: mockBridgeReplaceCode,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

const FORM_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
	<Name>ContosoXyzNoteHeaderList</Name>
	<SourceCode>
		<Methods xmlns="">
			<Method>
				<Name>PostButton</Name>
				<Source><![CDATA[
public void clicked()
{
    ttsbegin;
    super();
    ttscommit;
}
]]></Source>
			</Method>
		</Methods>
	</SourceCode>
</AxForm>`;

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (p.endsWith('.xml')) return FORM_XML;
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

const buildContext = (bridge: unknown): XppServerContext => {
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
    bridge: bridge as any,
  };
};

const replaceCode = (ctx: XppServerContext) =>
  modifyD365FileTool(
    req('modify_d365fo_file', {
      objectType: 'form',
      objectName: 'ContosoXyzNoteHeaderList',
      operation: 'replace-code',
      methodName: 'PostButton.clicked',
      oldCode: 'ttsbegin;',
      newCode: 'ttsbegin; // guarded',
      filePath: FORM_FILE_PATH,
    }),
    ctx,
  );

describe('replace-code direct-XML fallback message (finding #4)', () => {
  beforeEach(() => {
    mockBridgeReplaceCode.mockClear();
    mockWriteFile.mockClear();
    mockBridgeReplaceCode.mockResolvedValue({
      success: false,
      message: 'Bridge replaceCode returned success=false',
    });
  });

  it('does not claim an outage when a healthy bridge simply could not reach the method', async () => {
    const result = await replaceCode(buildContext({ isReady: true, metadataAvailable: true }));

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text as string;
    expect(text).toMatch(/direct XML fallback/i);
    expect(text).not.toMatch(/unavailable/i);
    expect(text).toContain('Bridge replaceCode returned success=false');
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it('does say the bridge was unavailable when it really was', async () => {
    const result = await replaceCode(buildContext({ isReady: false, metadataAvailable: false }));

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text as string).toMatch(/the bridge was unavailable/i);
  });
});
