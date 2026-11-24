/**
 * Which project a written object gets registered in.
 *
 * The rule this pins reversed once. The previous one treated a .rnrproj as an
 * ownership claim — "some project of the model already lists it, so leave it
 * out of this one" — and reported the sibling as the owner. That is not how a
 * D365FO solution works: the MODEL is the build unit and an element compiles
 * once however many projects name it, so an object may legitimately be
 * referenced by several .rnrproj, and teams routinely put one element in both a
 * feature project and a maintenance project.
 *
 * What the old rule actually produced was an object edited in the active
 * project and absent from it — you cannot build, check in, or hand over a
 * change through a project that does not contain the object it changed. So the
 * only silent case is 'already here'; everything else gets an entry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockResolveMembership, mockAddToProject, mockGetProjectsForModel } = vi.hoisted(() => ({
  mockResolveMembership: vi.fn(),
  mockAddToProject: vi.fn(),
  mockGetProjectsForModel: vi.fn(() => [] as string[]),
}));

vi.mock('../../src/workspace/projectMembership', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveMembership: mockResolveMembership,
}));

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: () => ({ getProjectsForModel: mockGetProjectsForModel }),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerFileInActiveProject, ProjectFileManager } from '../../src/workspace/projectFile';

const ACTIVE = 'K:\\repo\\projects\\Ctso - Feature\\Ctso - Feature.rnrproj';
const SIBLING = 'K:\\repo\\projects\\Ctso - Maintenance\\Ctso - Maintenance.rnrproj';

// No default for projectPath: a JS default fires on an explicit `undefined`
// too, which would quietly turn the "no active project" cases into the ordinary
// ones and pass for the wrong reason.
const register = (projectPath: string | undefined) =>
  registerFileInActiveProject('table-extension', 'TaxLog.CtsoExtension', 'CtsoFinance', projectPath);

describe('registerFileInActiveProject', () => {
  beforeEach(() => {
    mockResolveMembership.mockReset();
    mockAddToProject.mockReset();
    mockAddToProject.mockResolvedValue(true);
    vi.spyOn(ProjectFileManager.prototype, 'addToProject').mockImplementation(mockAddToProject);
  });

  it('says nothing and writes nothing when the active project already has it', async () => {
    mockResolveMembership.mockResolvedValue({ status: 'active', owners: [ACTIVE] });

    expect(await register(ACTIVE)).toBe('');
    expect(mockAddToProject).not.toHaveBeenCalled();
  });

  // The reversal. This used to return "Already registered in <sibling> — that
  // project owns it. Nothing to add here." and leave the active project without
  // the object it had just been used to edit.
  it('adds it to the active project even when a sibling project references it', async () => {
    mockResolveMembership.mockResolvedValue({ status: 'other', owners: [SIBLING] });

    const note = await register(ACTIVE);

    expect(mockAddToProject).toHaveBeenCalledWith(ACTIVE, 'table-extension', 'TaxLog.CtsoExtension', '');
    expect(note).toMatch(/Added to the active project/);
    expect(note).toContain('Ctso - Feature');
    // Names the sibling, so the second reference is understood as deliberate.
    expect(note).toContain('Ctso - Maintenance');
    expect(note).not.toMatch(/Nothing to add here/i);
  });

  describe('D365FO_PROJECT_MEMBERSHIP=owner', () => {
    beforeEach(() => { process.env.D365FO_PROJECT_MEMBERSHIP = 'owner'; });
    afterEach(() => { delete process.env.D365FO_PROJECT_MEMBERSHIP; });

    it('leaves an object in the single project that owns it', async () => {
      mockResolveMembership.mockResolvedValue({ status: 'other', owners: [SIBLING] });

      const note = await register(ACTIVE);

      expect(mockAddToProject).not.toHaveBeenCalled();
      expect(note).toMatch(/Left in Ctso - Maintenance/);
    });

    it('still adds it when several projects reference it', async () => {
      mockResolveMembership.mockResolvedValue({ status: 'other', owners: [SIBLING, 'K:\\x\\Other.rnrproj'] });

      await register(ACTIVE);

      expect(mockAddToProject).toHaveBeenCalledTimes(1);
    });

    it('still adds a new object no project references', async () => {
      mockResolveMembership.mockResolvedValue({ status: 'missing', owners: [] });

      await register(ACTIVE);

      expect(mockAddToProject).toHaveBeenCalledTimes(1);
    });
  });

  it('adds a true orphan and says so differently', async () => {
    mockResolveMembership.mockResolvedValue({ status: 'missing', owners: [] });

    const note = await register(ACTIVE);

    expect(mockAddToProject).toHaveBeenCalledTimes(1);
    expect(note).toMatch(/in no project of this model/i);
  });

  it('stays quiet when no project could be read at all', async () => {
    mockResolveMembership.mockResolvedValue({ status: 'unknown', owners: [] });

    expect(await register(ACTIVE)).toBe('');
    expect(mockAddToProject).not.toHaveBeenCalled();
  });

  it('warns about an orphan it has nowhere to add', async () => {
    mockResolveMembership.mockResolvedValue({ status: 'missing', owners: [] });

    const note = await register(undefined);

    expect(note).toMatch(/no active projectPath is configured/i);
    expect(mockAddToProject).not.toHaveBeenCalled();
  });

  // A sibling has it, so it compiles. Without an active project there is
  // nothing to add it to and nothing worth saying.
  it('stays quiet with no active project when a sibling already references it', async () => {
    mockResolveMembership.mockResolvedValue({ status: 'other', owners: [SIBLING] });

    expect(await register(undefined)).toBe('');
    expect(mockAddToProject).not.toHaveBeenCalled();
  });

  it('reports a failed registration without pretending the write failed', async () => {
    mockResolveMembership.mockResolvedValue({ status: 'missing', owners: [] });
    mockAddToProject.mockRejectedValue(new Error('project file is locked'));

    const note = await register(ACTIVE);

    expect(note).toMatch(/Could not add/i);
    expect(note).toContain('project file is locked');
  });

  // #1332: the active project builds the main model; an object of the test model
  // added to it breaks that project's build.
  describe('an object of another model of the workspace', () => {
    let dir: string;
    let mainProject: string;
    let testProject: string;
    const writeProject = (name: string, model: string) => {
      const file = path.join(dir, name, `${name}.rnrproj`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `<Project><PropertyGroup><Model>${model}</Model></PropertyGroup></Project>`);
      return file;
    };

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'register-model-'));
      mainProject = writeProject('CtsoFinance', 'CtsoFinance');
      testProject = writeProject('CtsoFinanceTests', 'CtsoFinanceTests');
      mockResolveMembership.mockResolvedValue({ status: 'missing', owners: [] });
    });
    afterEach(() => {
      mockGetProjectsForModel.mockReset();
      mockGetProjectsForModel.mockReturnValue([]);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('goes to the project of its own model, not the active one', async () => {
      mockGetProjectsForModel.mockImplementation((m: string) => (m === 'CtsoFinanceTests' ? [testProject] : []));

      const note = await registerFileInActiveProject('class', 'CtsoTaxTest', 'CtsoFinanceTests', mainProject);

      expect(mockAddToProject).toHaveBeenCalledWith(testProject, 'class', 'CtsoTaxTest', '');
      expect(mockAddToProject).not.toHaveBeenCalledWith(mainProject, expect.anything(), expect.anything(), expect.anything());
      expect(note).toContain('the project of model "CtsoFinanceTests"');
    });

    it('goes nowhere, and says so, when its model has no project', async () => {
      const note = await registerFileInActiveProject('class', 'CtsoTaxTest', 'CtsoFinanceTests', mainProject);

      expect(mockAddToProject).not.toHaveBeenCalled();
      expect(note).toContain('builds model "CtsoFinance"');
      expect(note).toContain('no project of "CtsoFinanceTests" was found');
    });
  });

  it('never throws when membership cannot be resolved', async () => {
    mockResolveMembership.mockRejectedValue(new Error('unreadable'));

    expect(await register(ACTIVE)).toBe('');
  });
});
