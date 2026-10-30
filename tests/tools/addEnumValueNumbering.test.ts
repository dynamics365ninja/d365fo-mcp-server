/**
 * add-enum-value without enumValueInt must not write a second 0.
 *
 * The op documents "the next available value is assigned automatically", but the
 * dispatcher passed `enumValueInt ?? 0` and the bridge's AddEnumValue writes what
 * it is given. In the shipped enum shape the first member is the one without a
 * <Value> (0), so every added member collided with it: "Duplicate value '0'
 * detected", reported only by a full build. Enum EXTENSIONS keep 0 — the platform
 * numbers their members, and most shipped extensions (219 of 278) carry no <Value>.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import { nextEnumValue } from '../../src/utils/axEnumProperties';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const ENUM_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxEnum xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>ContosoClaimStatus</Name>
	<UseEnumValue>No</UseEnumValue>
	<EnumValues>
		<AxEnumValue>
			<Name>Draft</Name>
		</AxEnumValue>
		<AxEnumValue>
			<Name>Submitted</Name>
			<Value>1</Value>
		</AxEnumValue>
		<AxEnumValue>
			<Name>Settled</Name>
			<Value>5</Value>
		</AxEnumValue>
	</EnumValues>
</AxEnum>`;

const EXTENSION_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxEnumExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>HierarchyPurpose.Contoso</Name>
	<EnumValues>
		<AxEnumValue>
			<Name>ContosoProfitability</Name>
		</AxEnumValue>
	</EnumValues>
</AxEnumExtension>`;

const { mockBridgeAddEnumValue } = vi.hoisted(() => ({
  mockBridgeAddEnumValue: vi.fn(async (..._args: unknown[]) => ({ success: true, message: 'added' })),
}));

vi.mock('../../src/bridge/bridgeAdapter', async orig => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddEnumValue: mockBridgeAddEnumValue,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (p.includes('AxEnumExtension')) return EXTENSION_XML;
    if (p.endsWith('.xml')) return ENUM_XML;
    if (p.endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
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
  resolveObjectPrefix: vi.fn(() => ''),
  applyObjectPrefix: vi.fn((name: string) => name),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
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

/** The value argument the bridge's AddEnumValue was called with. */
const sentValue = () => mockBridgeAddEnumValue.mock.calls[0][3];

describe('nextEnumValue', () => {
  it('is one past the highest value, counting a member without <Value> as 0', () => {
    expect(nextEnumValue(ENUM_XML)).toBe(6);
    expect(nextEnumValue(EXTENSION_XML)).toBe(1);
  });

  it('is 0 for an empty enum or a file that could not be read', () => {
    expect(nextEnumValue('<AxEnum><EnumValues /></AxEnum>')).toBe(0);
    expect(nextEnumValue(null)).toBe(0);
  });
});

describe('add-enum-value numbering', () => {
  beforeEach(() => mockBridgeAddEnumValue.mockClear());

  it('gives a new member of an enum the next free value', async () => {
    await modifyD365FileTool(
      req({
        objectType: 'enum',
        objectName: 'ContosoClaimStatus',
        operation: 'add-enum-value',
        enumValueName: 'Rejected',
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxEnum\\ContosoClaimStatus.xml',
      }),
      buildContext(),
    );

    expect(mockBridgeAddEnumValue).toHaveBeenCalledTimes(1);
    expect(sentValue()).toBe(6);
  });

  it('keeps an explicit enumValueInt, including 0', async () => {
    await modifyD365FileTool(
      req({
        objectType: 'enum',
        objectName: 'ContosoClaimStatus',
        operation: 'add-enum-value',
        enumValueName: 'Rejected',
        enumValueInt: 0,
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxEnum\\ContosoClaimStatus.xml',
      }),
      buildContext(),
    );

    expect(sentValue()).toBe(0);
  });

  it('leaves enum-extension members to the platform', async () => {
    const result = await modifyD365FileTool(
      req({
        objectType: 'enum-extension',
        objectName: 'HierarchyPurpose.Contoso',
        operation: 'add-enum-value',
        enumValueName: 'ContosoMargin',
        filePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxEnumExtension\\HierarchyPurpose.Contoso.xml',
      }),
      buildContext(),
    );

    expect((result as any).isError).toBeFalsy();
    expect(sentValue()).toBe(0);
  });
});
