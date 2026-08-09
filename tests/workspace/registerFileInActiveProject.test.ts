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

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

  it('never throws when membership cannot be resolved', async () => {
    mockResolveMembership.mockRejectedValue(new Error('unreadable'));

    expect(await register(ACTIVE)).toBe('');
  });
});
