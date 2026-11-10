/**
 * add-duty, remove-duty, add-privilege and remove-privilege through the modify
 * surface: the dispatch gate, the wrong-objectType refusal, the checks against the
 * symbol index and the base object, and a missing extension.
 *
 * The XML logic is tested where it lives (securityDutyRoleXml.test.ts). Mock shape
 * follows removalOps.test.ts, the entry-point sibling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool, ModifyD365FileArgsSchema, type ModifyOutcome } from '../../src/tools/write/modifyD365File';
import { canBridgeModify } from '../../src/bridge/bridgeAdapter';
import { D365FO_FILE_CREATE_PROPERTY_SPECS, D365FO_FILE_OP_SPECS, getRequiredParams } from '../../src/tools/specs/d365foFileOpSpecs';
import { d365foFileTool } from '../../src/server/toolSchemas/d365foFile';
import { preserveDroppedProperties } from '../../src/tools/write/preserveMetadataElements';
import { extractModelFromFilePath } from '../../src/utils/configManager';
import { isStandardModel } from '../../src/utils/modelClassifier';
import {
  buildAxSecurityDutyExtensionXml,
  buildAxSecurityDutyXml,
  buildAxSecurityRoleExtensionXml,
  buildAxSecurityRoleXml,
} from '../../src/tools/xml/securityDutyRoleXml';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return { ...actual, bridgeValidateAfterWrite: vi.fn(async () => null) };
});

const { mockWriteFile, mockAccess, mockCopyFile, files } = vi.hoisted(() => ({
  mockWriteFile: vi.fn(async () => {}),
  mockAccess: vi.fn(async () => {}),
  mockCopyFile: vi.fn(async () => {}),
  /** Content per AOT folder, which is what tells a base object from its extension. */
  files: { value: {} as Record<string, string> },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    const folder = String(p).split(/[\\/]/).at(-2) ?? '';
    if (String(p).endsWith('.xml') && folder in files.value) return files.value[folder];
    if (String(p).endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: mockWriteFile,
  mkdir: vi.fn(async () => {}),
  access: mockAccess,
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false, size: 10 })),
  readdir: vi.fn(async () => []),
  copyFile: mockCopyFile,
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
  isAsGivenNamingMode: vi.fn(() => false),
  resolveObjectPrefix: vi.fn(() => ''),
  applyObjectPrefix: vi.fn((name: string) => name),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
  getExtensionNamingStyle: vi.fn(() => 'prefix'),
  getExtensionClassNamingStyle: vi.fn(() => 'prefix'),
}));

const ROOT = 'K:\\PackagesLocalDirectory\\ContosoExt\\ContosoExt';
const ROLE_PATH = `${ROOT}\\AxSecurityRole\\ContosoRentClerk.xml`;
const DUTY_PATH = `${ROOT}\\AxSecurityDuty\\ContosoRentDuty.xml`;
const ROLE_EXT_PATH = `${ROOT}\\AxSecurityRoleExtension\\SystemUser.ContosoExtension.xml`;
const DUTY_EXT_PATH = `${ROOT}\\AxSecurityDutyExtension\\BatchJobMaintain.ContosoExtension.xml`;

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'modify_d365fo_file', arguments: args },
});

/** Index rows the fake answers from. Case-sensitive, as the exact-case probe is. */
let symbols: Array<{ name: string; type: string; file_path?: string }>;

const buildContext = (): XppServerContext => {
  const prepare = vi.fn((sql: string) => ({
    all: vi.fn((name: string, ...types: string[]) =>
      /symbols_fts/.test(sql)
        ? []
        : symbols
            .filter(s => s.name === name && types.includes(s.type))
            .map(s => ({ ...s, model: 'ApplicationCommon', extends_class: null, file_path: s.file_path ?? null }))),
    get: vi.fn((first: string, second?: string) => {
      if (/SELECT 1 FROM symbols/.test(sql)) return symbols.some(s => s.type === first) ? { 1: 1 } : undefined;
      if (/SELECT file_path FROM symbols/.test(sql)) return symbols.find(s => s.type === first && s.name === second);
      return undefined;
    }),
    run: vi.fn(),
  }));
  return {
    symbolIndex: {
      searchSymbols: vi.fn(() => []),
      getSymbolByName: vi.fn(() => undefined),
      getCustomModels: vi.fn(() => ['ContosoExt']),
      db: { prepare },
      getReadDb: vi.fn(function (this: any) { return this.db; }),
    } as any,
    parser: {} as any,
    cache: { get: vi.fn(async () => null), set: vi.fn(async () => {}), generateSearchKey: vi.fn((q: string) => `k:${q}`) } as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
    bridge: { isReady: true, metadataAvailable: true } as any,
  };
};

const written = (root: string): string | undefined =>
  mockWriteFile.mock.calls.map(c => String((c as unknown[])[1])).find(xml => xml.includes(`<${root} `));

const text = (r: { content: Array<{ text?: string }> }) => r.content[0].text ?? '';

let ctx: XppServerContext;

beforeEach(() => {
  ctx = buildContext();
  symbols = [
    { name: 'ContosoRentDuty', type: 'security-duty' },
    { name: 'ContosoRentMaintain', type: 'security-privilege' },
  ];
  files.value = {
    AxSecurityRole: buildAxSecurityRoleXml('ContosoRentClerk', { duties: ['ContosoOtherDuty'] }),
    AxSecurityDuty: buildAxSecurityDutyXml('ContosoRentDuty'),
    AxSecurityRoleExtension: buildAxSecurityRoleExtensionXml('SystemUser.ContosoExtension'),
    AxSecurityDutyExtension: buildAxSecurityDutyExtensionXml('BatchJobMaintain.ContosoExtension'),
  };
  mockWriteFile.mockClear();
  mockCopyFile.mockClear();
  mockAccess.mockReset();
  mockAccess.mockImplementation(async () => {});
});

describe('the four operations are reachable', () => {
  const DUTY_TYPES = ['security-role', 'security-role-extension'];
  const PRIVILEGE_TYPES = [...DUTY_TYPES, 'security-duty', 'security-duty-extension'];
  const NOT_BRIDGE_TYPES = ['security-privilege', 'ignore-diagnostic-list', 'model-descriptor', 'report'];

  it.each([
    ['add-duty', 'dutyName', DUTY_TYPES],
    ['remove-duty', 'dutyName', DUTY_TYPES],
    ['add-privilege', 'privilegeName', PRIVILEGE_TYPES],
    ['remove-privilege', 'privilegeName', PRIVILEGE_TYPES],
  ])('%s is published with its spec and clears the gate for its types only', (op, param, types) => {
    expect((d365foFileTool.inputSchema.properties as any).operation.enum).toContain(op);
    expect(D365FO_FILE_OP_SPECS[op]).toBeDefined();
    expect(getRequiredParams(op)).toEqual([param]);
    for (const t of types) {
      expect(canBridgeModify(t, op), t).toBe(true);
      expect(ModifyD365FileArgsSchema.parse({ objectType: t, operation: op, [param]: 'X' })).toMatchObject({ [param]: 'X' });
    }
    for (const t of NOT_BRIDGE_TYPES) expect(canBridgeModify(t, op), t).toBe(false);
  });

  it('the extension types stay closed to every other operation', () => {
    for (const op of ['add-method', 'modify-property', 'add-entry-point']) {
      expect(canBridgeModify('security-role-extension', op), op).toBe(false);
    }
  });

  it('the create specs point at the operations', () => {
    expect(D365FO_FILE_CREATE_PROPERTY_SPECS['security-role']).toContain('add-duty');
    expect(D365FO_FILE_CREATE_PROPERTY_SPECS['security-role']).toContain('add-privilege');
    expect(D365FO_FILE_CREATE_PROPERTY_SPECS['security-duty']).toContain('add-privilege');
  });
});

describe('add-duty and add-privilege', () => {
  it('writes a duty onto a role', async () => {
    const r = await modifyD365FileTool(req({
      objectType: 'security-role', objectName: 'ContosoRentClerk', filePath: ROLE_PATH,
      operation: 'add-duty', dutyName: 'ContosoRentDuty',
    }), ctx);

    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("this server's XML writer");
    expect(written('AxSecurityRole')).toContain('<Name>ContosoRentDuty</Name>');
  });

  it.each([
    ['security-role', 'ContosoRentClerk', ROLE_PATH, 'AxSecurityRole'],
    ['security-duty', 'ContosoRentDuty', DUTY_PATH, 'AxSecurityDuty'],
    ['security-role-extension', 'SystemUser.ContosoExtension', ROLE_EXT_PATH, 'AxSecurityRoleExtension'],
    ['security-duty-extension', 'BatchJobMaintain.ContosoExtension', DUTY_EXT_PATH, 'AxSecurityDutyExtension'],
  ])('writes a privilege onto a %s', async (objectType, objectName, filePath, root) => {
    const r = await modifyD365FileTool(req({
      objectType, objectName, filePath, operation: 'add-privilege', privilegeName: 'ContosoRentMaintain',
    }), ctx);

    expect(r.isError).toBeFalsy();
    expect(written(root)).toContain('<Name>ContosoRentMaintain</Name>');
  });

  it('finds an extension by name, with no filePath', async () => {
    const r = await modifyD365FileTool(req({
      objectType: 'security-role-extension', objectName: 'SystemUser.ContosoExtension',
      operation: 'add-duty', dutyName: 'ContosoRentDuty',
    }), ctx);

    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('AxSecurityRoleExtension');
    expect(written('AxSecurityRoleExtension')).toContain('<Name>ContosoRentDuty</Name>');
  });

  it('says SKIPPED, not ✅, for a reference that is already there', async () => {
    const r = await modifyD365FileTool(req({
      objectType: 'security-role', objectName: 'ContosoRentClerk', filePath: ROLE_PATH,
      operation: 'add-duty', dutyName: 'contosootherduty',
    }), ctx);

    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('SKIPPED, nothing was written');
    expect(text(r)).toContain(`'ContosoOtherDuty' is already in <Duties>`);
    expect(written('AxSecurityRole')).toBeUndefined();
  });

  it('refuses add-duty given a privilege, naming add-privilege', async () => {
    const r = await modifyD365FileTool(req({
      objectType: 'security-role', objectName: 'ContosoRentClerk', filePath: ROLE_PATH,
      operation: 'add-duty', dutyName: 'ContosoRentMaintain',
    }), ctx);

    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`'ContosoRentMaintain' is a privilege in the symbol index, not a duty`);
    expect(text(r)).toContain('Use add-privilege with privilegeName="ContosoRentMaintain"');
    expect(written('AxSecurityRole')).toBeUndefined();
  });

  it('refuses add-privilege given a duty on a role, naming add-duty', async () => {
    const r = await modifyD365FileTool(req({
      objectType: 'security-role', objectName: 'ContosoRentClerk', filePath: ROLE_PATH,
      operation: 'add-privilege', privilegeName: 'ContosoRentDuty',
    }), ctx);

    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Use add-duty with dutyName="ContosoRentDuty"');
  });

  it('on a duty, does not tell the caller to use an operation a duty refuses', async () => {
    const r = await modifyD365FileTool(req({
      objectType: 'security-duty', objectName: 'ContosoRentDuty', filePath: DUTY_PATH,
      operation: 'add-privilege', privilegeName: 'ContosoRentDuty',
    }), ctx);

    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain('Use add-duty');
    expect(text(r)).toContain('add-duty is the operation for it, on objectType="security-role"');
  });

  it('accepts a name that is both a duty and a privilege', async () => {
    symbols.push({ name: 'ContosoRentMaintain', type: 'security-duty' });
    const r = await modifyD365FileTool(req({
      objectType: 'security-role', objectName: 'ContosoRentClerk', filePath: ROLE_PATH,
      operation: 'add-duty', dutyName: 'ContosoRentMaintain',
    }), ctx);

    expect(r.isError).toBeFalsy();
    expect(text(r)).not.toContain('⚠️ No duty');
  });

  it('warns about an unknown name and writes it anyway', async () => {
    const r = await modifyD365FileTool(req({
      objectType: 'security-role', objectName: 'ContosoRentClerk', filePath: ROLE_PATH,
      operation: 'add-duty', dutyName: 'ContosoNotYetThere',
    }), ctx);

    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('⚠️ No duty named "ContosoNotYetThere" is in the symbol index');
    expect(written('AxSecurityRole')).toContain('<Name>ContosoNotYetThere</Name>');
  });

  it('says it could not check when the index holds no duties at all (write-only companion)', async () => {
    symbols = [];
    const r = await modifyD365FileTool(req({
      objectType: 'security-role', objectName: 'ContosoRentClerk', filePath: ROLE_PATH,
      operation: 'add-duty', dutyName: 'ContosoRentDuty',
    }), ctx);

    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('Could not verify "ContosoRentDuty"');
    expect(text(r)).not.toContain('⚠️ No duty');
    expect(written('AxSecurityRole')).toContain('<Name>ContosoRentDuty</Name>');
  });

  it('points a list at operations[]', async () => {
    const r = await modifyD365FileTool(req({
      objectType: 'security-role', objectName: 'ContosoRentClerk', filePath: ROLE_PATH,
      operation: 'add-duty', dutyName: 'ContosoA,ContosoB',
    }), ctx);

    expect(r.isError).toBe(true);
    expect(text(r)).toContain('send several as operations[] entries');
    expect(written('AxSecurityRole')).toBeUndefined();
  });

  it('returns the op-spec when the name parameter is missing', async () => {
    const r = await modifyD365FileTool(req({
      objectType: 'security-role', objectName: 'ContosoRentClerk', filePath: ROLE_PATH, operation: 'add-duty',
    }), ctx);

    expect(r.isError).toBe(true);
    expect(text(r)).toContain('dutyName');
  });

  it('goes through the backup a modify takes', async () => {
    // Asked for explicitly: the forced copy outside git keys on the file's folder,
    // and path.dirname of a K:\\ path on a POSIX host is '.', this repository.
    await modifyD365FileTool(req({
      objectType: 'security-role', objectName: 'ContosoRentClerk', filePath: ROLE_PATH,
      operation: 'add-duty', dutyName: 'ContosoRentDuty', createBackup: true,
    }), ctx);

    expect(mockCopyFile).toHaveBeenCalled();
  });
});

describe('an extension whose base object already holds the reference', () => {
  beforeEach(() => {
    files.value.AxSecurityRole = buildAxSecurityRoleXml('SystemUser', {
      duties: ['ContosoRentDuty'], privileges: ['ContosoRentMaintain'],
    });
    files.value.AxSecurityDuty = buildAxSecurityDutyXml('BatchJobMaintain', { privileges: ['ContosoRentMaintain'] });
  });

  it.each([
    ['security-role-extension', 'SystemUser.ContosoExtension', ROLE_EXT_PATH, 'add-duty', { dutyName: 'contosorentduty' }, 'security-role "SystemUser"'],
    ['security-role-extension', 'SystemUser.ContosoExtension', ROLE_EXT_PATH, 'add-privilege', { privilegeName: 'ContosoRentMaintain' }, 'security-role "SystemUser"'],
    ['security-duty-extension', 'BatchJobMaintain.ContosoExtension', DUTY_EXT_PATH, 'add-privilege', { privilegeName: 'ContosoRentMaintain' }, 'security-duty "BatchJobMaintain"'],
  ])('%s %s: %s warns and still writes', async (objectType, objectName, filePath, operation, param, base) => {
    const r = await modifyD365FileTool(req({ objectType, objectName, filePath, operation, ...param }), ctx);

    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain(`⚠️ ${base} already references`);
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it('says nothing when the base does not hold it', async () => {
    files.value.AxSecurityRole = buildAxSecurityRoleXml('SystemUser');
    const r = await modifyD365FileTool(req({
      objectType: 'security-role-extension', objectName: 'SystemUser.ContosoExtension', filePath: ROLE_EXT_PATH,
      operation: 'add-duty', dutyName: 'ContosoRentDuty',
    }), ctx);

    expect(r.isError).toBeFalsy();
    expect(text(r)).not.toContain('already references');
  });

  it('never warns on the base object itself', async () => {
    files.value.AxSecurityRole = buildAxSecurityRoleXml('ContosoRentClerk');
    const r = await modifyD365FileTool(req({
      objectType: 'security-role', objectName: 'ContosoRentClerk', filePath: ROLE_PATH,
      operation: 'add-duty', dutyName: 'ContosoRentDuty',
    }), ctx);

    expect(text(r)).not.toContain('already references');
  });
});

describe('remove-duty and remove-privilege', () => {
  it('removes the reference, collapsing the emptied list', async () => {
    const r = await modifyD365FileTool(req({
      objectType: 'security-role', objectName: 'ContosoRentClerk', filePath: ROLE_PATH,
      operation: 'remove-duty', dutyName: 'ContosoOtherDuty',
    }), ctx);

    expect(r.isError).toBeFalsy();
    expect(written('AxSecurityRole')).toContain('<Duties />');
  });

  it('answers a name that is not there with the list, as an error', async () => {
    const r = await modifyD365FileTool(req({
      objectType: 'security-role', objectName: 'ContosoRentClerk', filePath: ROLE_PATH,
      operation: 'remove-duty', dutyName: 'ContosoRentDuty',
    }), ctx);

    expect(r.isError).toBe(true);
    expect(text(r)).toContain('<Duties> lists: ContosoOtherDuty.');
    expect(written('AxSecurityRole')).toBeUndefined();
  });

  it('removes a dangling reference without asking the index about it', async () => {
    symbols = [{ name: 'ContosoOtherDuty', type: 'security-privilege' }];
    const r = await modifyD365FileTool(req({
      objectType: 'security-role', objectName: 'ContosoRentClerk', filePath: ROLE_PATH,
      operation: 'remove-duty', dutyName: 'ContosoOtherDuty',
    }), ctx);

    expect(r.isError).toBeFalsy();
  });

  it('is on the list of operations whose missing element is the intent', () => {
    const before = '<AxSecurityRole><Name>A</Name><Label>B</Label></AxSecurityRole>';
    const after = '<AxSecurityRole><Name>A</Name></AxSecurityRole>';
    for (const op of ['remove-duty', 'remove-privilege']) {
      expect(preserveDroppedProperties(before, after, op).restored, op).toEqual([]);
    }
  });
});

describe('a wrong objectType is refused before anything is looked up', () => {
  it.each([
    ['add-duty', 'security-duty', { dutyName: 'X' }, 'A duty holds privileges'],
    ['remove-duty', 'security-duty-extension', { dutyName: 'X' }, 'A duty holds privileges'],
    ['add-duty', 'security-privilege', { dutyName: 'X' }, 'A privilege holds entry points'],
    ['remove-duty', 'security-privilege', { dutyName: 'X' }, 'A privilege holds entry points'],
    ['add-privilege', 'security-privilege', { privilegeName: 'X' }, 'A privilege holds entry points'],
    ['remove-privilege', 'security-privilege', { privilegeName: 'X' }, 'A privilege holds entry points'],
    ['add-duty', 'table', { dutyName: 'X' }, "'add-duty' applies to"],
    ['add-privilege', 'menu', { privilegeName: 'X' }, "'add-privilege' applies to"],
  ])('%s on %s', async (operation, objectType, param, expected) => {
    const r = await modifyD365FileTool(req({ objectType, objectName: 'Anything', operation, ...param }), ctx);

    expect(r.isError).toBe(true);
    expect(text(r)).toContain(expected);
    expect(text(r)).toContain('nothing was written');
    expect(text(r)).not.toContain('not supported by the bridge');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('the writer still refuses when filePath points at a different kind of object', async () => {
    const r = await modifyD365FileTool(req({
      objectType: 'security-role', objectName: 'ContosoRentDuty', filePath: DUTY_PATH,
      operation: 'add-duty', dutyName: 'ContosoRentDuty',
    }), ctx);

    expect(r.isError).toBe(true);
    expect(text(r)).toContain('is an AxSecurityDuty, which has no <Duties> list');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

describe('an extension that does not exist yet', () => {
  /** The file is missing from every candidate path, so only the index can name the base. */
  const noFilesOnDisk = () => mockAccess.mockImplementation(async () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });

  it('offers the one call that works for a standard base role only the index knows', async () => {
    noFilesOnDisk();
    symbols.push({ name: 'SystemUser', type: 'security-role', file_path: 'K:\\Ms\\ApplicationCommon\\AxSecurityRole\\SystemUser.xml' });
    const outcome: ModifyOutcome = {};

    const r = await modifyD365FileTool(req({
      objectType: 'security-role-extension', objectName: 'SystemUser.ContosoExtension',
      operation: 'add-duty', dutyName: 'ContosoRentDuty',
    }), ctx, outcome);

    expect(outcome.createExtensionFirst).toEqual({ objectType: 'security-role-extension', objectName: 'SystemUser.ContosoExtension' });
    expect(text(r)).toContain('Create it and apply the same edit in ONE call');
    expect(text(r)).toContain('operations:[{operation: "add-duty", dutyName: "ContosoRentDuty"}]');
  });

  it('does the same for a duty extension', async () => {
    noFilesOnDisk();
    symbols.push({ name: 'BatchJobMaintain', type: 'security-duty', file_path: 'K:\\Ms\\ApplicationCommon\\AxSecurityDuty\\BatchJobMaintain.xml' });
    const outcome: ModifyOutcome = {};

    await modifyD365FileTool(req({
      objectType: 'security-duty-extension', objectName: 'BatchJobMaintain.ContosoExtension',
      operation: 'add-privilege', privilegeName: 'ContosoRentMaintain',
    }), ctx, outcome);

    expect(outcome.createExtensionFirst?.objectType).toBe('security-duty-extension');
  });

  it('keeps "not found" when the base does not exist either', async () => {
    noFilesOnDisk();
    const outcome: ModifyOutcome = {};

    const r = await modifyD365FileTool(req({
      objectType: 'security-role-extension', objectName: 'ContosoTypo.ContosoExtension',
      operation: 'add-duty', dutyName: 'ContosoRentDuty',
    }), ctx, outcome);

    expect(r.isError).toBe(true);
    expect(outcome.createExtensionFirst).toBeUndefined();
    expect(text(r)).toContain('File not found');
  });
});

describe('a standard role or duty', () => {
  it('names the extension types in the refusal', async () => {
    vi.mocked(extractModelFromFilePath).mockReturnValueOnce('ApplicationCommon');
    vi.mocked(isStandardModel).mockReturnValueOnce(true);

    const r = await modifyD365FileTool(req({
      objectType: 'security-role', objectName: 'SystemUser', filePath: ROLE_PATH,
      operation: 'add-duty', dutyName: 'ContosoRentDuty',
    }), ctx);

    expect(r.isError).toBe(true);
    expect(text(r)).toContain('security-role-extension');
  });
});
