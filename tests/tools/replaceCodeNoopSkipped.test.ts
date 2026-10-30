/**
 * A replace-code that is already applied writes nothing, so a batch must count it
 * as skipped. The no-op answer returned before outcome.skipped was set, so
 * runModifyBatch folded it into "N/N operation(s) applied" and put the file in
 * the "verified on disk" set for a write that never happened.
 */
import { describe, it, expect, vi } from 'vitest';
import { modifyD365FileTool, type ModifyOutcome } from '../../src/tools/write/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const CLASS_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>ContosoPostingService</Name>
	<SourceCode>
		<Declaration><![CDATA[
public class ContosoPostingService
{
}
]]></Declaration>
		<Methods>
			<Method>
				<Name>post</Name>
				<Source><![CDATA[
    public void post()
    {
        ttsbegin;
        this.lock();
        this.write();
        ttscommit;
    }

]]></Source>
			</Method>
		</Methods>
	</SourceCode>
</AxClass>`;

const { mockBridgeReplaceCode } = vi.hoisted(() => ({
  mockBridgeReplaceCode: vi.fn(async (..._args: unknown[]) => ({
    success: true,
    message: '✅ Code replaced via Update',
  })),
}));

vi.mock('../../src/bridge/bridgeAdapter', async orig => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeReplaceCode: mockBridgeReplaceCode,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (p.endsWith('.xml')) return CLASS_XML;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: vi.fn(async () => {}),
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
    resolveWithPackage: vi.fn((m: string, p: string) => ({
      packageName: p,
      modelName: m,
      rootPath: 'K:\\PackagesLocalDirectory',
    })),
  })),
}));

vi.mock('../../src/utils/modelClassifier', async orig => ({
  ...(await orig<typeof import('../../src/utils/modelClassifier')>()),
  registerCustomModel: vi.fn(),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
}));

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'modify_d365fo_file', arguments: args },
});

const buildContext = (): XppServerContext => {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
  return {
    symbolIndex: {
      searchSymbols: vi.fn(() => []),
      getSymbolByName: vi.fn(() => undefined),
      getCustomModels: vi.fn(() => ['MyModel']),
      db: { prepare: vi.fn(() => stmt) },
      getReadDb: vi.fn(function (this: any) {
        return this.db;
      }),
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

describe('replace-code that is already applied', () => {
  it('reports no change and marks the outcome skipped, so a batch does not count it as applied', async () => {
    const outcome: ModifyOutcome = {};
    const result = await modifyD365FileTool(
      req({
        objectType: 'class',
        objectName: 'ContosoPostingService',
        operation: 'replace-code',
        methodName: 'post',
        oldCode: 'this.write();',
        newCode: 'this.lock();\n        this.write();',
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxClass\\ContosoPostingService.xml',
      }),
      buildContext(),
      outcome,
    );

    expect((result as any).content[0].text).toContain('no change needed');
    expect(mockBridgeReplaceCode).not.toHaveBeenCalled();
    expect(outcome.skipped).toBe(true);
  });
});
