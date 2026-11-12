/**
 * add-control with a position on a plain form, through modify_d365fo_file: what the
 * reply says, and that a bad position is refused before anything is written.
 *
 * addBaseFormControl answers some calls without the bridge (moving a control the form
 * already has, finding it already there, refusing a position). Those replies used to
 * read "applied via IMetadataProvider.Update()" or "Bridge operation 'add-control'
 * failed" — an API that never ran — and the design-root names the bridge accepts
 * ("FormDesign", "Root", "<Form>Design") were refused by the placement that follows it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockBridgeAddControl, store } = vi.hoisted(() => ({
  mockBridgeAddControl: vi.fn(),
  store: { xml: '' },
}));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeAddControl: mockBridgeAddControl,
    bridgeRefreshProvider: vi.fn(async () => ({ success: true })),
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

const field = (name: string) => [
  `\t\t\t<AxFormControl xmlns="" i:type="AxFormStringControl">`,
  `\t\t\t\t<Name>${name}</Name>`,
  `\t\t\t\t<Type>String</Type>`,
  `\t\t\t\t<FormControlExtension i:nil="true" />`,
  `\t\t\t</AxFormControl>`,
];

/** A form whose design holds these controls, in this order. */
const form = (controls: string[]) => [
  `<?xml version="1.0" encoding="utf-8"?>`,
  `<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">`,
  `\t<Name>ConDemoCtrlNoteForm</Name>`,
  `\t<SourceCode>`,
  `\t\t<Methods xmlns="" />`,
  `\t</SourceCode>`,
  `\t<DataSources />`,
  `\t<Design>`,
  `\t\t<Controls xmlns="">`,
  ...controls.flatMap(field),
  `\t\t</Controls>`,
  `\t</Design>`,
  `</AxForm>`,
  '',
].join('\n');

const order = (xml: string) =>
  [...xml.matchAll(/<Name>(\w+)<\/Name>/g)].map(m => m[1]).filter(n => n !== 'ConDemoCtrlNoteForm');

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (p.endsWith('.xml')) return store.xml;
    if (p.endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  // writeFileAtomic writes a temp sibling of the form and renames it over the target.
  writeFile: vi.fn(async (p: string, data: string) => {
    if (String(p).includes('ConDemoCtrlNoteForm')) store.xml = String(data);
  }),
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

const FORM_FILE_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxForm\\ConDemoCtrlNoteForm.xml';

const addControl = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: {
    name: 'modify_d365fo_file',
    arguments: {
      objectType: 'form',
      objectName: 'ConDemoCtrlNoteForm',
      operation: 'add-control',
      controlType: 'String',
      parentControl: 'Design',
      filePath: FORM_FILE_PATH,
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

const text = (r: { content: Array<{ text?: string }> }) => r.content[0].text as string;

describe('add-control with a position on a plain form — the reply', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    mockBridgeAddControl.mockReset();
  });

  it('places a new control under the design-root names the bridge accepts', async () => {
    for (const parentControl of ['FormDesign', 'Root', 'ConDemoCtrlNoteFormDesign']) {
      store.xml = form(['Subject', 'Body']);
      mockBridgeAddControl.mockImplementation(async () => {
        store.xml = form(['Subject', 'Body', 'Notes']); // the bridge appends to the design
        return { success: true, message: "✅ Control 'Notes' added to 'Design'" };
      });
      const r = await modifyD365FileTool(addControl({ controlName: 'Notes', parentControl, positionType: 'Begin' }), ctx);
      expect(r.isError, parentControl).toBeFalsy();
      expect(text(r)).not.toContain('Added at the END');
      expect(order(store.xml)).toEqual(['Notes', 'Subject', 'Body']);
    }
  });

  it('moves an existing control under a design-root name the bridge accepts', async () => {
    store.xml = form(['Subject', 'Body']);
    const r = await modifyD365FileTool(addControl({ controlName: 'Body', parentControl: 'Root', positionType: 'Begin' }), ctx);
    expect(r.isError).toBeFalsy();
    expect(order(store.xml)).toEqual(['Body', 'Subject']);
  });

  it('does not credit the bridge for moving an existing control', async () => {
    store.xml = form(['Subject', 'Body']);
    const r = await modifyD365FileTool(addControl({ controlName: 'Body', positionType: 'Begin' }), ctx);
    expect(mockBridgeAddControl).not.toHaveBeenCalled();
    expect(text(r)).not.toContain('IMetadataProvider');
  });

  it('says SKIPPED when the control is already where it was asked', async () => {
    store.xml = form(['Subject', 'Body']);
    const r = await modifyD365FileTool(addControl({ controlName: 'Subject', positionType: 'Begin' }), ctx);
    expect(text(r)).toContain('SKIPPED, nothing was written');
  });

  it('says SKIPPED when the control exists and no position is asked', async () => {
    store.xml = form(['Subject', 'Body']);
    const r = await modifyD365FileTool(addControl({ controlName: 'Body' }), ctx);
    expect(mockBridgeAddControl).not.toHaveBeenCalled();
    expect(text(r)).toContain('SKIPPED, nothing was written');
  });

  it('does not blame the bridge for a refused move', async () => {
    store.xml = form(['Subject', 'Body']);
    const r = await modifyD365FileTool(addControl({ controlName: 'Body', previousSibling: 'Missing' }), ctx);
    expect(r.isError).toBeTruthy();
    expect(text(r)).toContain('previousSibling "Missing"');
    expect(text(r)).not.toContain('Bridge operation');
  });

  it('refuses a bad position for a new control before the bridge writes it', async () => {
    for (const position of [{ previousSibling: 'Missing' }, { positionType: 'Middle' }, { positionType: 'AfterItem' }, { previousSibling: 'Notes' }]) {
      store.xml = form(['Subject', 'Body']);
      mockBridgeAddControl.mockClear();
      const r = await modifyD365FileTool(addControl({ controlName: 'Notes', ...position }), ctx);
      expect(r.isError, JSON.stringify(position)).toBeTruthy();
      expect(mockBridgeAddControl).not.toHaveBeenCalled();
      expect(text(r)).not.toContain('Bridge operation');
      expect(order(store.xml)).toEqual(['Subject', 'Body']);
    }
  });
});
