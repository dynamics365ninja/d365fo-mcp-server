/**
 * Regression tests — add-control on the form DESIGN ROOT
 *
 * Corpus evidence:
 *   eval/corpus/runs/2026-07-21T18__L2-form-modify-controls__c262b19.json
 *
 * Two defects are pinned here, both on the `add-control` path:
 *
 *  (#8) The C# bridge resolved `parentControl` purely with
 *       `FindControlRecursive(design, parentControl)`, which only ever walks
 *       `design.Controls` and can therefore never return the design ROOT. A form whose
 *       design has no controls yet could not receive its FIRST top-level control, so
 *       every `parentControl` value failed by construction. The bridge-side fix lives in
 *       FormAuthoringDefaults.IsDesignRootSentinel (covered by
 *       tests/bridge/formAuthoringDefaults.test.ts); this file pins the TS contract that
 *       "Design" is the documented way to address the design root.
 *
 * (#11) When the bridge said "Parent control 'Design' not found in form 'X'", the TS
 *       layer misclassified it as an OBJECT-resolution failure and told the caller the
 *       bridge "could not find '<form>' in its metadata model" — factually wrong, the
 *       form had just been read. The attached "Reliable fallback" then recommended
 *       `d365fo_file(action="create", overwrite=true, xmlContent=...)`, i.e. the
 *       hand-authored-XML escape hatch the eval loop exists to prevent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool, isUnresolvedObjectError } from '../../src/tools/modifyD365File';
import { D365FO_FILE_OP_SPECS } from '../../src/tools/d365foFileOpSpecs';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// ─── Bridge mock ─────────────────────────────────────────────────────────────

const { mockBridgeAddControl, mockBridgeRefreshProvider } = vi.hoisted(() => ({
  mockBridgeAddControl: vi.fn(),
  mockBridgeRefreshProvider: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddControl: mockBridgeAddControl,
    bridgeRefreshProvider: mockBridgeRefreshProvider,
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

// ─── Module mocks (same shape as form-control-method-inplace.test.ts) ─────────

/** Form whose design has NO controls — the exact shape that used to be unfixable. */
const EMPTY_DESIGN_FORM_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>ConDemoCtrlNoteForm</Name>
\t<SourceCode>
\t\t<Methods xmlns="" />
\t</SourceCode>
\t<DataSources />
\t<Design>
\t\t<Controls xmlns="" />
\t</Design>
</AxForm>`;

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (p.endsWith('.xml')) return EMPTY_DESIGN_FORM_XML;
    if (p.endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: vi.fn(async () => {}),
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

const FORM_FILE_PATH =
  'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxForm\\ConDemoCtrlNoteForm.xml';

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

const addControlReq = (parentControl: string) =>
  req('modify_d365fo_file', {
    objectType: 'form',
    objectName: 'ConDemoCtrlNoteForm',
    operation: 'add-control',
    controlName: 'SubjectField',
    parentControl,
    controlDataSource: 'ConDemoCtrlNote',
    controlDataField: 'Subject',
    controlType: 'String',
    filePath: FORM_FILE_PATH,
  });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('add-control: addressing the form design root', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    mockBridgeAddControl.mockReset();
    mockBridgeRefreshProvider.mockClear();
  });

  it('forwards parentControl="Design" to the bridge unchanged (design-root sentinel)', async () => {
    mockBridgeAddControl.mockResolvedValue({
      success: true,
      message: "✅ Control 'SubjectField' added to 'Design'",
    });

    const result = await modifyD365FileTool(addControlReq('Design'), ctx);

    expect(result.isError).toBeFalsy();
    expect(mockBridgeAddControl).toHaveBeenCalledTimes(1);
    // parentControl is argument #4 (bridge, objectName, controlName, parentControl, …)
    expect(mockBridgeAddControl.mock.calls[0][3]).toBe('Design');
  });

  it('documents "Design" as the way to reach the top level of a form design', () => {
    const spec = D365FO_FILE_OP_SPECS['add-control'];
    expect(spec).toBeTruthy();
    expect(spec!.note ?? '').toMatch(/parentControl="Design"/);
  });

  describe('when the bridge reports a genuine parent-control-not-found', () => {
    const BRIDGE_MSG = "Parent control 'TabGeneral' not found in form 'ConDemoCtrlNoteForm'";

    beforeEach(() => {
      mockBridgeAddControl.mockResolvedValue({ success: false, message: BRIDGE_MSG });
    });

    it('is NOT classified as an object-resolution failure', () => {
      expect(isUnresolvedObjectError(BRIDGE_MSG)).toBe(false);
      // …while a real object-resolution failure still is.
      expect(isUnresolvedObjectError("Form 'ConDemoCtrlNoteForm' not found")).toBe(true);
    });

    it('does not claim the form itself could not be found', async () => {
      const result = await modifyD365FileTool(addControlReq('TabGeneral'), ctx);

      expect(result.isError).toBeTruthy();
      const text = result.content[0].text as string;
      expect(text).toContain(BRIDGE_MSG);
      expect(text).not.toMatch(/could not resolve form/i);
      expect(text).not.toMatch(/could not find .* in its metadata model/i);
    });

    it('never suggests create overwrite=true / hand-authored xmlContent as the remedy', async () => {
      const result = await modifyD365FileTool(addControlReq('TabGeneral'), ctx);
      const text = result.content[0].text as string;

      expect(text).not.toMatch(/overwrite=true/);
      expect(text).not.toMatch(/xmlContent="<complete updated XML>"/);
    });

    it('points at parentControl="Design" for a top-level control instead', async () => {
      const result = await modifyD365FileTool(addControlReq('TabGeneral'), ctx);
      const text = result.content[0].text as string;

      expect(text).toMatch(/parentControl="Design"/);
    });
  });
});

describe('unresolvedObjectError guidance (all modify operations)', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    mockBridgeAddControl.mockReset();
  });

  it('does not offer the hand-authored-XML rewrite for a real resolution failure either', async () => {
    mockBridgeAddControl.mockResolvedValue({
      success: false,
      message: "Form 'ConDemoCtrlNoteForm' not found",
    });

    const result = await modifyD365FileTool(addControlReq('Design'), ctx);

    expect(result.isError).toBeTruthy();
    const text = result.content[0].text as string;
    expect(text).toMatch(/could not resolve/i); // this one IS a resolution failure
    expect(text).not.toMatch(/overwrite=true/);
  });
});
