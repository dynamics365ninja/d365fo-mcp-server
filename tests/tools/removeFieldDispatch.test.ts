/**
 * d365fo_file [modify] remove-field, end to end through the dispatcher: after the
 * bridge removed the field, the reply says which field groups it was taken out of
 * and what still references it, and the file on disk has the group entries gone.
 *
 * The transform itself is pinned in removeFieldDanglingReferences.test.ts. This
 * file pins the wiring: the cleanup runs only after a successful removal, and a
 * field that was in no group gets the reply it always got.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockBridgeRemoveField } = vi.hoisted(() => ({ mockBridgeRemoveField: vi.fn() }));

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    bridgeRemoveField: mockBridgeRemoveField,
    bridgeRefreshProvider: vi.fn(async () => {}),
    bridgeValidateAfterWrite: vi.fn(async () => null),
  };
});

/** The one file on the fake disk, and what writeFileAtomic has staged for it. */
const { disk } = vi.hoisted(() => ({ disk: { xml: '', staged: new Map<string, string>(), writes: 0 } }));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (typeof p === 'string' && p.endsWith('.xml')) return disk.xml;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  // writeFileAtomic: a temp sibling written with writeFile, then renamed over the target.
  writeFile: vi.fn(async (p: string, content: string) => { disk.staged.set(p, content); }),
  rename: vi.fn(async (from: string) => {
    const content = disk.staged.get(from);
    if (content !== undefined) { disk.xml = content; disk.writes++; }
  }),
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false, size: 1234 })),
  readdir: vi.fn(async () => []),
  copyFile: vi.fn(async () => {}),
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
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
  resolveRegularObjectPrefixToken: vi.fn(() => ''),
}));

const TABLE_FILE_PATH = 'K:\\PackagesLocalDirectory\\ContosoExt\\ContosoExt\\AxTable\\ContosoRentEquipmentTable.xml';

const FIELD = (name: string) =>
  `\t\t<AxTableField xmlns="" i:type="AxTableFieldString">\n\t\t\t<Name>${name}</Name>\n\t\t</AxTableField>\n`;
const GROUP_ENTRY = (name: string) =>
  `\t\t\t\t<AxTableFieldGroupField>\n\t\t\t\t\t<DataField>${name}</DataField>\n\t\t\t\t</AxTableFieldGroupField>\n`;

const TABLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ContosoRentEquipmentTable</Name>
\t<FieldGroups>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoReport</Name>
\t\t\t<Fields>
${GROUP_ENTRY('EquipmentId')}${GROUP_ENTRY('Colour')}\t\t\t</Fields>
\t\t</AxTableFieldGroup>
\t\t<AxTableFieldGroup>
\t\t\t<Name>Appearance</Name>
\t\t\t<Fields>
${GROUP_ENTRY('Colour')}\t\t\t</Fields>
\t\t</AxTableFieldGroup>
\t</FieldGroups>
\t<Fields>
${FIELD('EquipmentId')}${FIELD('Colour')}${FIELD('Weight')}\t</Fields>
\t<Indexes>
\t\t<AxTableIndex>
\t\t\t<Name>ColourIdx</Name>
\t\t\t<Fields>
\t\t\t\t<AxTableIndexField>
\t\t\t\t\t<DataField>Colour</DataField>
\t\t\t\t</AxTableIndexField>
\t\t\t</Fields>
\t\t</AxTableIndex>
\t</Indexes>
\t<Relations />
</AxTable>`;

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

const textOf = (r: any) => r.content.map((c: any) => c.text).join('\n');

const removeField = (fieldName: string) =>
  modifyD365FileTool(
    req({
      objectType: 'table',
      objectName: 'ContosoRentEquipmentTable',
      operation: 'remove-field',
      fieldName,
      filePath: TABLE_FILE_PATH,
    }),
    buildContext(),
  );

beforeEach(() => {
  vi.clearAllMocks();
  disk.xml = TABLE_XML;
  disk.staged.clear();
  disk.writes = 0;
  // What the bridge's RemoveField does: the field leaves <Fields>, nothing else moves.
  mockBridgeRemoveField.mockImplementation(async (_bridge: unknown, _table: string, fieldName: string) => {
    const field = new RegExp(`\\t\\t<AxTableField [^>]*>\\n\\t\\t\\t<Name>${fieldName}</Name>\\n\\t\\t</AxTableField>\\n`, 'i');
    if (!field.test(disk.xml)) return { success: false, message: `Field '${fieldName}' not found` };
    disk.xml = disk.xml.replace(field, '');
    return { success: true, message: `✅ Field '${fieldName}' removed via IMetaTableProvider.Update` };
  });
});

describe('remove-field through the dispatcher', () => {
  it('names the groups the field left and the index that still uses it', async () => {
    const result = await removeField('colour');
    const text = textOf(result);

    expect(result.isError).toBeFalsy();
    expect(text).toContain("✅ Field 'colour' removed via IMetaTableProvider.Update");
    expect(text).toContain("Also removed 'colour' from field groups AutoReport, Appearance");
    expect(text).toContain("index 'ColourIdx' has it as a field");
    expect(text).toContain('operation="remove-index"');

    expect(disk.xml).not.toContain(GROUP_ENTRY('Colour').replace(/\n/g, '\r\n'));
    expect(disk.xml).toContain('<DataField>EquipmentId</DataField>');
    // The index was reported, not edited.
    expect(disk.xml).toContain('<AxTableIndexField>\r\n\t\t\t\t\t<DataField>Colour</DataField>');
  });

  it('a field in no group gets the reply it always got and no second write', async () => {
    const text = textOf(await removeField('Weight'));
    expect(text).toContain("✅ Field 'Weight' removed via IMetaTableProvider.Update");
    expect(text).not.toContain('Also removed');
    expect(text).not.toContain('still references it');
    expect(disk.writes).toBe(0);
  });

  it('cleans nothing when the bridge did not remove the field', async () => {
    mockBridgeRemoveField.mockResolvedValue({ success: false, message: 'Bridge removeField returned success=false' });
    const result = await removeField('Colour');
    expect(result.isError).toBe(true);
    expect(disk.xml).toBe(TABLE_XML);
    expect(disk.writes).toBe(0);
  });
});
