/**
 * Regression tests — Form control method in-place editing
 *
 * Verifies that `modify_d365fo_file` with operation `add-method` on a form and
 * a control-qualified method name (`ControlName.methodName` format) routes to
 * `bridgeAddMethod` exactly once — without first calling `bridgeRemoveMethod`.
 *
 * Before the fix in MetadataWriteService.cs (TryUpdateSourceInFormDataControls),
 * `TryUpdateMethodSourceInPlace` failed to find control override methods inside
 * SourceCode.DataControls, so the bridge returned success=false.  The AI then
 * fell back to the documented workaround of remove-method + add-method, which
 * always appends the method at the end of the file (breaking method order).
 *
 * This TS layer test asserts the correct single-call pattern from the tool up.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// ─── Hoist bridge mock functions so they can be referenced inside vi.mock ────

const { mockBridgeAddMethod, mockBridgeRemoveMethod } = vi.hoisted(() => ({
  mockBridgeAddMethod: vi.fn(async () => ({
    success: true,
    message: '✅ Method PostButton.clicked updated in place via IMetadataProvider',
  })),
  mockBridgeRemoveMethod: vi.fn(async () => ({
    success: true,
    message: '✅ Method removed',
  })),
}));

// Keep canBridgeModify real so form+add-method is correctly accepted.
// Replace only the functions under test.
vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddMethod: mockBridgeAddMethod,
    bridgeRemoveMethod: mockBridgeRemoveMethod,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

// ─── Module mocks (same pattern as file-ops.test.ts) ─────────────────────────

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (p.endsWith('.xml')) return FORM_XML_WITH_CONTROL_METHOD;
    if (p.endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: vi.fn(async () => {}),
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
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Minimal form XML with an existing PostButton.clicked control override. */
const FORM_XML_WITH_CONTROL_METHOD = `<?xml version="1.0" encoding="utf-8"?>
<AxForm>
  <Name>VendInvoiceApprovalJournal</Name>
  <SourceCode>
    <Methods />
    <DataControls>
      <DataControl>
        <Name>PostButton</Name>
        <Methods>
          <Method>
            <Name>clicked</Name>
            <Source><![CDATA[public void clicked()
{
    super();
}]]></Source>
          </Method>
        </Methods>
      </DataControl>
    </DataControls>
  </SourceCode>
</AxForm>`;

const FORM_FILE_PATH =
  'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxForm\\VendInvoiceApprovalJournal.xml';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    /** Bridge present and ready — required or the tool returns early with isError */
    bridge: {
      isReady: true,
      metadataAvailable: true,
    } as any,
  };
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('form control method in-place editing (regression)', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    mockBridgeAddMethod.mockClear();
    mockBridgeRemoveMethod.mockClear();
  });

  it('calls bridgeAddMethod exactly once with the control-qualified method name', async () => {
    const newSource = `public void clicked()\n{\n    super();\n    info("posted");\n}`;

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'form',
        objectName: 'VendInvoiceApprovalJournal',
        operation: 'add-method',
        methodName: 'PostButton.clicked',
        sourceCode: newSource,
        filePath: FORM_FILE_PATH,
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(mockBridgeAddMethod).toHaveBeenCalledTimes(1);
    expect(mockBridgeAddMethod).toHaveBeenCalledWith(
      ctx.bridge,
      'form',
      'VendInvoiceApprovalJournal',
      'PostButton.clicked',
      newSource,
    );
  });

  it('does NOT call bridgeRemoveMethod (anti-regression: no remove+add workaround)', async () => {
    const newSource = `public void clicked()\n{\n    super();\n    info("done");\n}`;

    await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'form',
        objectName: 'VendInvoiceApprovalJournal',
        operation: 'add-method',
        methodName: 'PostButton.clicked',
        sourceCode: newSource,
        filePath: FORM_FILE_PATH,
      }),
      ctx,
    );

    expect(mockBridgeRemoveMethod).not.toHaveBeenCalled();
  });

  it('returns a success response that mentions the object name', async () => {
    const newSource = `public void clicked()\n{\n    super();\n}`;

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'form',
        objectName: 'VendInvoiceApprovalJournal',
        operation: 'add-method',
        methodName: 'PostButton.clicked',
        sourceCode: newSource,
        filePath: FORM_FILE_PATH,
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('VendInvoiceApprovalJournal');
  });

  it('handles a top-level form method (no control prefix) the same way', async () => {
    const newSource = `void init()\n{\n    super();\n}`;

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'form',
        objectName: 'VendInvoiceApprovalJournal',
        operation: 'add-method',
        methodName: 'init',
        sourceCode: newSource,
        filePath: FORM_FILE_PATH,
      }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(mockBridgeAddMethod).toHaveBeenCalledTimes(1);
    expect(mockBridgeAddMethod).toHaveBeenCalledWith(
      ctx.bridge,
      'form',
      'VendInvoiceApprovalJournal',
      'init',
      newSource,
    );
    expect(mockBridgeRemoveMethod).not.toHaveBeenCalled();
  });

  it('returns isError when bridge is absent', async () => {
    ctx.bridge = undefined;

    const result = await modifyD365FileTool(
      req('modify_d365fo_file', {
        objectType: 'form',
        objectName: 'VendInvoiceApprovalJournal',
        operation: 'add-method',
        methodName: 'PostButton.clicked',
        sourceCode: `public void clicked()\n{\n    super();\n}`,
        filePath: FORM_FILE_PATH,
      }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/bridge is not available/i);
  });
});
