/**
 * d365fo_file(action="delete") — the counterpart to `create`.
 *
 * Two properties carry the whole feature, and both are the kind that fail
 * silently:
 *
 *  1. BOTH halves of the create are undone. Deleting only the XML leaves a
 *     `<Content Include>` pointing at nothing; VS reports it, nothing else does,
 *     and the project fails to load for the next developer. So the un-register
 *     runs against EVERY project of the model that lists the object, not only the
 *     active one.
 *  2. An object that resolves to nothing is an ERROR. "Nothing to delete" and "the
 *     name was wrong" look identical from the caller's side, and reporting the
 *     second as success leaves the object in the build under a ✅.
 *
 * Plus the refusals a delete must never skip: standard Microsoft models, and paths
 * outside the allowed metadata roots.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const PLD = 'K:\\PackagesLocalDirectory';
const FORM_PATH = `${PLD}\\MyPackage\\MyModel\\AxForm\\ConDemoTicketTable.xml`;
const PROJECT_A = 'K:\\VSProjects\\MyModel\\Feature\\Feature.rnrproj';
const PROJECT_B = 'K:\\VSProjects\\MyModel\\Maintenance\\Maintenance.rnrproj';

const {
  mockUnlink, mockStat, mockRemoveFromProject, mockResolveMembership,
  mockFindOnDisk, mockRemoveSymbols, mockRemoveLabels, mockForget, mockWriteFile, state,
} = vi.hoisted(() => {
  const state = {
    owners: [] as string[],
    membershipStatus: 'active' as string,
    onDisk: null as string | null,
    // Separate from `onDisk`: the deletion-target lookup and the post-delete
    // BP-suppression-file lookup share the same findD365FileOnDisk mock, and
    // most tests care only about the former.
    suppressionFileOnDisk: null as string | null,
    suppressionsXml: undefined as string | undefined,
    isStandardModel: false,
    modelFromPath: 'MyModel' as string | null,
    modelSegment: 'MyModel' as string | null,
  };
  return {
    state,
    mockUnlink: vi.fn(async () => {}),
    mockStat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
    mockRemoveFromProject: vi.fn(async () => true),
    mockResolveMembership: vi.fn(async () => ({ status: state.membershipStatus, owners: state.owners })),
    mockFindOnDisk: vi.fn(async (objectType: string) => (
      objectType === 'ignore-diagnostic-list' ? state.suppressionFileOnDisk : state.onDisk
    )),
    mockRemoveSymbols: vi.fn(() => ({ deletedCount: 3, objectNames: ['ConDemoTicketTable'] })),
    mockRemoveLabels: vi.fn(() => 0),
    mockForget: vi.fn(),
    mockWriteFile: vi.fn(async () => {}),
  };
});

vi.mock('fs/promises', () => ({
  unlink: mockUnlink,
  stat: mockStat,
  readFile: vi.fn(async (p: string) => (
    typeof p === 'string' && p.includes('BPSuppressions')
      ? (state.suppressionsXml ?? '<IgnoreDiagnostics><Items /></IgnoreDiagnostics>')
      : '<Project><ItemGroup></ItemGroup></Project>'
  )),
  writeFile: mockWriteFile,
  access: vi.fn(async () => {}),
  // writeFileAtomic (used by the post-delete BP-suppression cleanup) writes a
  // temp sibling and renames it over the target.
  rename: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/objectFileLookup', () => ({
  findD365FileOnDisk: mockFindOnDisk,
}));

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getModelName: vi.fn(() => 'MyModel'),
    getWriteAnchorModel: vi.fn(() => 'MyModel'),
    getProjectPath: vi.fn(async () => PROJECT_A),
    getProjectsForModel: vi.fn(() => [PROJECT_A, PROJECT_B]),
    getToolProjectSwitch: vi.fn(() => null),
  })),
  extractModelFromFilePath: vi.fn(() => state.modelFromPath),
}));

vi.mock('../../src/utils/modelClassifier', () => ({
  isStandardModel: vi.fn(() => state.isStandardModel),
}));

vi.mock('../../src/utils/objectNaming', () => ({
  normalizeObjectName: vi.fn((name: string) => `ConDemo${name}`),
}));

vi.mock('../../src/utils/pathContainment', () => ({
  assertWritePathAllowed: vi.fn(async (filePath: string) => (
    filePath.startsWith(PLD)
      ? { ok: true, canonicalPath: filePath, packageSegment: 'MyPackage', modelSegment: state.modelSegment }
      : { ok: false, reason: `outside the allowed metadata roots: "${filePath}"` }
  )),
}));

// A real class, not vi.fn().mockImplementation(): clearAllMocks() in beforeEach
// wipes a mocked implementation, and the constructor then returns undefined.
vi.mock('../../src/workspace/projectFile', () => ({
  ProjectFileManager: class {
    removeFromProject = mockRemoveFromProject;
  },
}));

vi.mock('../../src/workspace/projectMembership', async (orig) => {
  const actual = await orig<typeof import('../../src/workspace/projectMembership')>();
  return { ...actual, resolveMembership: mockResolveMembership };
});

vi.mock('../../src/workspace/createdArtifactLedger', () => ({
  forgetCreatedArtifact: mockForget,
}));

vi.mock('../../src/bridge/index', () => ({
  bridgeRefreshProvider: vi.fn(async () => {}),
}));

vi.mock('../../src/tools/write/writeAnchorGuard', () => ({
  resolveAnchorModel: vi.fn(async () => 'MyModel'),
}));

import { handleDeleteD365File } from '../../src/tools/write/deleteD365File';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'delete_d365fo_file', arguments: args },
});

const ctx: any = {
  symbolIndex: {
    removeSymbolsByFile: mockRemoveSymbols,
    removeLabelsByFile: mockRemoveLabels,
  },
  bridge: { isReady: true, metadataAvailable: true },
};

const textOf = (r: any): string => r.content[0].text as string;

beforeEach(() => {
  vi.clearAllMocks();
  state.owners = [PROJECT_A];
  state.membershipStatus = 'active';
  state.onDisk = FORM_PATH;
  state.suppressionFileOnDisk = null;
  state.suppressionsXml = undefined;
  state.isStandardModel = false;
  state.modelFromPath = 'MyModel';
  state.modelSegment = 'MyModel';
  // clearAllMocks() clears CALLS, not implementations — a rejection installed by
  // one test would otherwise leak into every test after it.
  mockUnlink.mockResolvedValue(undefined as never);
  mockRemoveFromProject.mockResolvedValue(true as never);
  mockStat.mockResolvedValue({ isFile: () => true, isDirectory: () => false } as never);
  mockResolveMembership.mockImplementation(async () => ({
    status: state.membershipStatus, owners: state.owners,
  }) as never);
  mockFindOnDisk.mockImplementation(async (objectType: string) => (
    objectType === 'ignore-diagnostic-list' ? state.suppressionFileOnDisk : state.onDisk
  ) as never);
});

describe('d365fo_file(action="delete")', () => {
  it('deletes the XML and un-registers it from the project', async () => {
    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'ConDemoTicketTable' }), ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(mockUnlink).toHaveBeenCalledWith(FORM_PATH);
    expect(mockRemoveFromProject).toHaveBeenCalledWith(PROJECT_A, 'form', 'ConDemoTicketTable');
    expect(textOf(result)).toContain('Deleted D365FO form');
    expect(textOf(result)).toContain(FORM_PATH);
  });

  it('un-registers from EVERY project of the model that lists the object', async () => {
    // An element may belong to several .rnrproj of one model; cleaning only the
    // active one is exactly the case that leaves a dangling include behind.
    state.membershipStatus = 'other';
    state.owners = [PROJECT_A, PROJECT_B];

    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'ConDemoTicketTable' }), ctx,
    );

    expect(mockRemoveFromProject).toHaveBeenCalledTimes(2);
    expect(mockRemoveFromProject).toHaveBeenCalledWith(PROJECT_A, 'form', 'ConDemoTicketTable');
    expect(mockRemoveFromProject).toHaveBeenCalledWith(PROJECT_B, 'form', 'ConDemoTicketTable');
    expect(textOf(result)).toContain('Feature');
    expect(textOf(result)).toContain('Maintenance');
  });

  it('un-registers BEFORE unlinking, so a locked project file is caught while the object is whole', async () => {
    const order: string[] = [];
    mockRemoveFromProject.mockImplementation(async () => { order.push('project'); return true; });
    mockUnlink.mockImplementation(async () => { order.push('unlink'); });

    await handleDeleteD365File(req({ objectType: 'form', objectName: 'ConDemoTicketTable' }), ctx);
    expect(order).toEqual(['project', 'unlink']);
  });

  it('reports ❌ for an object that resolves to nothing — never a silent no-op', async () => {
    state.onDisk = null;
    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'NotAThing' }), ctx,
    );

    expect(result.isError).toBe(true);
    expect(mockUnlink).not.toHaveBeenCalled();
    expect(mockRemoveFromProject).not.toHaveBeenCalled();
    const text = textOf(result);
    expect(text).toContain('Nothing deleted');
    // It must not read as "already gone, you are done".
    expect(text).toContain('the name may simply be wrong');
    expect(text).toContain('filePath');
  });

  it('retries under the name create would have written', async () => {
    // The caller usually still holds the UNPREFIXED name it passed to create.
    state.onDisk = null;
    mockFindOnDisk
      .mockImplementationOnce(async () => null as never)
      .mockImplementationOnce(async () => FORM_PATH as never);

    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'TicketTable' }), ctx,
    );

    expect(result.isError).toBeFalsy();
    // 2 calls to resolve the deletion target (miss, then retry under the
    // normalized name), + 1 for the post-delete BP-suppression-file lookup.
    expect(mockFindOnDisk).toHaveBeenCalledTimes(3);
    // Second attempt used the normalized (prefixed) name.
    expect(mockFindOnDisk.mock.calls[1][1]).toBe('ConDemoTicketTable');
    // Third call looks up the model's suppression file, not the deleted object.
    expect(mockFindOnDisk.mock.calls[2][0]).toBe('ignore-diagnostic-list');
    expect(mockUnlink).toHaveBeenCalledWith(FORM_PATH);
  });

  it('refuses an object in a standard Microsoft model', async () => {
    state.isStandardModel = true;
    state.modelFromPath = 'ApplicationSuite';

    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'SalesTable', filePath: `${PLD}\\ApplicationSuite\\Foundation\\AxForm\\SalesTable.xml` }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('ApplicationSuite');
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('refuses a filePath outside the allowed metadata roots', async () => {
    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'ConDemoTicketTable', filePath: 'C:\\Windows\\System32\\drivers\\etc\\hosts.xml' }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Refusing to delete');
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('refuses a path that exists but is not a file', async () => {
    mockStat.mockResolvedValue({ isFile: () => false, isDirectory: () => true } as never);
    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'ConDemoTicketTable' }), ctx,
    );
    expect(result.isError).toBe(true);
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('reports ❌ when the file named by filePath does not exist', async () => {
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as never);
    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'ConDemoTicketTable', filePath: FORM_PATH }), ctx,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('does not exist');
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('clears the stale symbols so later reads cannot answer from them', async () => {
    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'ConDemoTicketTable' }), ctx,
    );
    expect(mockRemoveSymbols).toHaveBeenCalledWith(FORM_PATH);
    expect(mockRemoveLabels).toHaveBeenCalledWith(FORM_PATH);
    // And the create's undo-ledger entry, which now points at nothing.
    expect(mockForget).toHaveBeenCalledWith(FORM_PATH);
    expect(textOf(result)).toContain('removed 3 symbol(s)');
  });

  it('says so when no project referenced the object', async () => {
    state.membershipStatus = 'missing';
    state.owners = [];
    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'ConDemoTicketTable' }), ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(mockRemoveFromProject).not.toHaveBeenCalled();
    expect(textOf(result)).toContain('nothing to un-register');
  });

  it('warns about an include it could not remove, without hiding that the file is gone', async () => {
    // A .rnrproj locked by Visual Studio. The XML is already deleted by then, so
    // the reply has to say BOTH things — an outright failure would read as "nothing
    // happened" while the object is in fact gone.
    state.owners = [PROJECT_A];
    mockRemoveFromProject.mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) as never);

    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'ConDemoTicketTable' }), ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(mockUnlink).toHaveBeenCalled();
    const text = textOf(result);
    expect(text).toContain('Could not update');
    expect(text).toContain('EBUSY');
    expect(text).toContain('project will not load');
  });

  it('reports a failed unlink as an error', async () => {
    mockUnlink.mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }) as never);
    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'ConDemoTicketTable' }), ctx,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('EPERM');
  });

  it('derives the object name from filePath when only the path is given', async () => {
    const result = await handleDeleteD365File(
      req({ objectType: 'form', filePath: FORM_PATH }), ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(mockRemoveFromProject).toHaveBeenCalledWith(PROJECT_A, 'form', 'ConDemoTicketTable');
  });

  it('requires objectName or filePath', async () => {
    const result = await handleDeleteD365File(req({ objectType: 'form' }), ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('objectName');
  });

  it('strips stale BP suppressions for the deleted object from the model suppression file', async () => {
    const suppFile = `${PLD}\\MyPackage\\MyModel\\AxIgnoreDiagnosticList\\MyModel_BPSuppressions.xml`;
    state.suppressionFileOnDisk = suppFile;
    state.suppressionsXml =
      `<IgnoreDiagnostics><Items>` +
      `<Diagnostic><Path>dynamics://Form/ConDemoTicketTable</Path><Moniker>BPErrorGridCaption</Moniker></Diagnostic>` +
      `<Diagnostic><Path>dynamics://Form/SomeOtherForm</Path><Moniker>BPErrorGridCaption</Moniker></Diagnostic>` +
      `</Items></IgnoreDiagnostics>`;

    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'ConDemoTicketTable' }), ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining(`${suppFile}.tmp-`),
      expect.stringContaining('SomeOtherForm'),
      'utf-8',
    );
    const [, writtenXml] = mockWriteFile.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].startsWith(`${suppFile}.tmp-`),
    )!;
    expect(writtenXml).not.toContain('ConDemoTicketTable');
    expect(textOf(result)).toContain('🧹 BP suppressions: removed 1 stale');
  });

  it('leaves the suppression file untouched when nothing there targets the deleted object', async () => {
    state.suppressionFileOnDisk = `${PLD}\\MyPackage\\MyModel\\AxIgnoreDiagnosticList\\MyModel_BPSuppressions.xml`;
    state.suppressionsXml =
      `<IgnoreDiagnostics><Items>` +
      `<Diagnostic><Path>dynamics://Form/SomeOtherForm</Path><Moniker>BPErrorGridCaption</Moniker></Diagnostic>` +
      `</Items></IgnoreDiagnostics>`;

    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'ConDemoTicketTable' }), ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(mockWriteFile).not.toHaveBeenCalledWith(
      expect.stringContaining('BPSuppressions'), expect.anything(), expect.anything(),
    );
    expect(textOf(result)).not.toContain('BP suppressions');
  });

  it('does not attempt suppression cleanup when no suppression file exists for the model', async () => {
    state.suppressionFileOnDisk = null;
    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'ConDemoTicketTable' }), ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toContain('BP suppressions');
  });

  it('does not attempt suppression cleanup when the deleted object IS the suppression list itself', async () => {
    state.suppressionFileOnDisk = `${PLD}\\MyPackage\\MyModel\\AxIgnoreDiagnosticList\\MyModel_BPSuppressions.xml`;
    const result = await handleDeleteD365File(
      req({ objectType: 'ignore-diagnostic-list', objectName: 'MyModel_BPSuppressions' }), ctx,
    );
    expect(result.isError).toBeFalsy();
    // Only the deletion-target lookup runs — no second call for the file it IS.
    expect(mockFindOnDisk).toHaveBeenCalledTimes(1);
    expect(textOf(result)).not.toContain('BP suppressions');
  });

  it('reports an owning project whose include did not match, instead of staying silent', async () => {
    // resolveMembership named this project as an owner, so the include IS there.
    // A remover that then matches nothing is a disagreement between the two —
    // and the file is already unlinked. Swallowing it produces exactly the
    // dangling include this step exists to prevent, under a ✅.
    state.owners = [PROJECT_A];
    mockRemoveFromProject.mockResolvedValue(false as never);

    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'ConDemoTicketTable' }), ctx,
    );

    const text = textOf(result);
    expect(text).toContain('Could not update');
    expect(text).toContain('Feature');
    expect(text).toContain('did not match on removal');
    // …and it must NOT claim nothing referenced the object.
    expect(text).not.toContain('nothing to un-register');
  });

  it('refuses when objectType does not match the AOT folder the file sits in', async () => {
    // Everything downstream trusts objectType: the un-register step builds its
    // Content Include from it, and an unrecognised type resolves to AxClass. So a
    // mismatch would delete this file and un-register a DIFFERENT object.
    const result = await handleDeleteD365File(
      req({ objectType: 'table', filePath: FORM_PATH }), ctx,
    );

    expect(result.isError).toBe(true);
    expect(mockUnlink).not.toHaveBeenCalled();
    expect(mockRemoveFromProject).not.toHaveBeenCalled();
    const text = textOf(result);
    expect(text).toContain('AxTable');
    expect(text).toContain('AxForm');
  });

  it('refuses a cross-model delete, and does not offer an extension as the remedy', async () => {
    // An extension cannot un-define its base, so the "extend it from your model
    // instead" advice every other cross-model refusal gives cannot be followed here.
    state.modelSegment = 'SomeoneElsesModel';
    state.modelFromPath = 'SomeoneElsesModel';

    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'ConDemoTicketTable' }), ctx,
    );

    expect(result.isError).toBe(true);
    expect(mockUnlink).not.toHaveBeenCalled();
    const text = textOf(result);
    expect(text).toContain('Refusing to delete');
    expect(text).toContain('SomeoneElsesModel');
    expect(text).not.toContain('Extend it from');
    expect(text).toContain('find_references');
  });

  describe('grounding', () => {
    const previous = process.env.GROUNDING_ENFORCE;
    beforeEach(() => { process.env.GROUNDING_ENFORCE = 'true'; });
    afterEach(() => {
      if (previous === undefined) delete process.env.GROUNDING_ENFORCE;
      else process.env.GROUNDING_ENFORCE = previous;
    });

    it('requires a grounding token for an extension, exactly as create and modify do', async () => {
      // Deleting is the one action that cannot be undone. An agent barred from
      // CREATING a table extension without prepare must not be free to delete one.
      const result = await handleDeleteD365File(
        req({ objectType: 'table-extension', objectName: 'CustTable.ConDemoExtension' }), ctx,
      );

      expect(result.isError).toBe(true);
      expect(mockUnlink).not.toHaveBeenCalled();
      expect(textOf(result)).toContain('Grounding required');
    });

    it('leaves a non-extension object alone — the same scope create and modify use', async () => {
      const result = await handleDeleteD365File(
        req({ objectType: 'form', objectName: 'ConDemoTicketTable' }), ctx,
      );
      expect(result.isError).toBeFalsy();
    });
  });

  it('points at find_references and source control, the only recovery there is', async () => {
    // There is no undo_last_modification path for a delete, and every remaining
    // reference is now a compile error — both belong in the reply, not in a wiki.
    const result = await handleDeleteD365File(
      req({ objectType: 'form', objectName: 'ConDemoTicketTable' }), ctx,
    );
    const text = textOf(result);
    expect(text).toContain('find_references');
    expect(text).toContain('source control');
  });
});

describe('d365fo_file dispatcher routes action="delete"', () => {
  it('forwards to the delete handler with params flattened', async () => {
    vi.resetModules();
    const create = vi.fn(async () => ({ content: [{ type: 'text', text: 'create' }] }));
    const modify = vi.fn(async () => ({ content: [{ type: 'text', text: 'modify' }] }));
    const generate = vi.fn(async () => ({ content: [{ type: 'text', text: 'generate' }] }));
    const del = vi.fn(async () => ({ content: [{ type: 'text', text: 'delete' }] }));

    vi.doMock('../../src/tools/write/createD365File', () => ({ handleCreateD365File: create }));
    vi.doMock('../../src/tools/write/modifyD365File', () => ({ modifyD365FileTool: modify }));
    vi.doMock('../../src/tools/xml/generateD365Xml', () => ({ handleGenerateD365Xml: generate }));
    vi.doMock('../../src/tools/write/deleteD365File', () => ({ handleDeleteD365File: del }));

    const { d365foFileTool } = await import('../../src/tools/d365foFile');
    await d365foFileTool(
      {
        method: 'tools/call',
        params: {
          name: 'd365fo_file',
          arguments: {
            action: 'delete',
            objectType: 'security-privilege',
            objectName: 'ConDemoTicketMaintain',
            params: { modelName: 'MyModel' },
          },
        },
      } as CallToolRequest,
      {} as any,
    );

    expect(del).toHaveBeenCalledOnce();
    const fwd = (del as any).mock.calls[0][0].params.arguments;
    expect(fwd).toMatchObject({
      objectType: 'security-privilege',
      objectName: 'ConDemoTicketMaintain',
      modelName: 'MyModel',
    });
    // The wrapper itself is never forwarded, and neither is the discriminator.
    expect(fwd.params).toBeUndefined();
    expect(fwd.action).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(modify).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});
