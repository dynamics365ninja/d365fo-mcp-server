/**
 * replace-code must reach the bridge in the file's own line endings.
 *
 * The bridge matches with String.Contains against method source read through
 * IMetadataProvider, which keeps the file's CRLF (a CCTPM method read through the
 * bridge: 11 CR for 11 LF). Clients send oldCode with LF, so a multi-line oldCode
 * never matched and every such edit was written by the XML fallback with a
 * "bridge declined" note: 168 of 176 multi-line replace-code calls in one
 * project's sessions, against 3 of 181 single-line ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import { withEol, readFileEol } from '../../src/utils/eolUtils';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const CLASS_XML_LF = `<?xml version="1.0" encoding="utf-8"?>
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
        this.write();
        ttscommit;
    }

]]></Source>
			</Method>
		</Methods>
	</SourceCode>
</AxClass>`;

const { mockBridgeReplaceCode, fileState } = vi.hoisted(() => ({
  mockBridgeReplaceCode: vi.fn(async (..._args: unknown[]) => ({
    success: true,
    message: '✅ Code replaced via Update',
  })),
  fileState: { eol: '\r\n' as '\r\n' | '\n' },
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
    if (p.endsWith('.xml')) return CLASS_XML_LF.replace(/\n/g, fileState.eol);
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

const FILE = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxClass\\ContosoPostingService.xml';

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

const replace = () =>
  modifyD365FileTool(
    req({
      objectType: 'class',
      objectName: 'ContosoPostingService',
      operation: 'replace-code',
      methodName: 'post',
      oldCode: 'ttsbegin;\n        this.write();',
      newCode: 'ttsbegin;\n        this.lock();\n        this.write();',
      filePath: FILE,
    }),
    buildContext(),
  );

describe('withEol', () => {
  it('rewrites every line break to the given ending', () => {
    expect(withEol('a\nb\r\nc', '\r\n')).toBe('a\r\nb\r\nc');
    expect(withEol('a\r\nb\nc', '\n')).toBe('a\nb\nc');
    expect(withEol('a\nb', null)).toBe('a\nb');
  });
});

describe('readFileEol', () => {
  it('is null when the file cannot be read', async () => {
    await expect(readFileEol('K:\\nowhere.txt')).resolves.toBeNull();
  });
});

describe('replace-code line endings', () => {
  beforeEach(() => mockBridgeReplaceCode.mockClear());

  it('sends a multi-line oldCode to the bridge in CRLF when the file is CRLF', async () => {
    fileState.eol = '\r\n';
    await replace();

    expect(mockBridgeReplaceCode).toHaveBeenCalledTimes(1);
    const [, , , , oldCode, newCode] = mockBridgeReplaceCode.mock.calls[0] as string[];
    expect(oldCode).toBe('ttsbegin;\r\n        this.write();');
    expect(newCode).toBe('ttsbegin;\r\n        this.lock();\r\n        this.write();');
  });

  it('keeps LF for an LF file', async () => {
    fileState.eol = '\n';
    await replace();

    const [, , , , oldCode] = mockBridgeReplaceCode.mock.calls[0] as string[];
    expect(oldCode).toBe('ttsbegin;\n        this.write();');
  });
});
