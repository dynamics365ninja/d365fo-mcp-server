/**
 * projectName → one project.
 *
 * The regression these guard: a model name shared by many projects used to
 * resolve to whichever came first in the scan, so switching "back" to your own
 * model landed you in a stranger's project and every write registered there.
 */

import { describe, it, expect } from 'vitest';
import {
  selectProject,
  renderSelectionFailure,
  type ProjectSelection,
} from '../../src/workspace/projectSelector.js';
import type { D365ProjectInfo } from '../../src/utils/workspaceDetector.js';

const ROOT = 'K:\\repos\\Contoso\\projects';

function proj(stem: string, modelName: string, folder = stem): D365ProjectInfo {
  return {
    projectPath: `${ROOT}\\${folder}\\${stem}.rnrproj`,
    modelName,
    solutionPath: `${ROOT}\\${folder}`,
  };
}

/** Three projects of one model plus one of another — the shape that broke. */
const PROJECTS: D365ProjectInfo[] = [
  proj('ContosoFin - FeatureManagement', 'ContosoFin'),
  proj('ContosoFin - StatementFormat', 'ContosoFin'),
  proj('contoso-demo-workspace', 'ContosoFin'),
  proj('ContosoCore - FeatureManagement', 'ContosoCore'),
];

function resolvedPath(s: ProjectSelection): string | undefined {
  return s.kind === 'resolved' ? s.project.projectPath : undefined;
}

describe('selectProject', () => {
  it('refuses a model name that several projects build', () => {
    const s = selectProject('ContosoFin', PROJECTS);
    expect(s.kind).toBe('ambiguous');
    if (s.kind !== 'ambiguous') return;
    expect(s.matchedOn).toBe('model');
    expect(s.candidates).toHaveLength(3);
  });

  it('does not fall through to a partial match after an ambiguous exact model match', () => {
    // "ContosoFin" is also a substring of nothing else here, but the point is
    // that an ambiguous exact hit must stop, not degrade into another guess.
    const s = selectProject('contosofin', PROJECTS);
    expect(s.kind).toBe('ambiguous');
  });

  it('resolves a model that exactly one project builds', () => {
    const s = selectProject('ContosoCore', PROJECTS);
    expect(resolvedPath(s)).toBe(`${ROOT}\\ContosoCore - FeatureManagement\\ContosoCore - FeatureManagement.rnrproj`);
    expect(s.kind === 'resolved' && s.matchedOn).toBe('model');
  });

  it('resolves by project file name, case-insensitively', () => {
    const s = selectProject('CONTOSO-demo-WORKSPACE', PROJECTS);
    expect(resolvedPath(s)).toBe(`${ROOT}\\contoso-demo-workspace\\contoso-demo-workspace.rnrproj`);
    expect(s.kind === 'resolved' && s.matchedOn).toBe('project-file');
  });

  it('prefers the project file name over a model name', () => {
    // A project named exactly like another project's model must still win as a
    // project — identity beats classification.
    const projects = [...PROJECTS, proj('ContosoCore', 'ContosoFin', 'odd-one-out')];
    const s = selectProject('ContosoCore', projects);
    expect(resolvedPath(s)).toBe(`${ROOT}\\odd-one-out\\ContosoCore.rnrproj`);
    expect(s.kind === 'resolved' && s.matchedOn).toBe('project-file');
  });

  it('resolves a unique partial project name', () => {
    const s = selectProject('StatementFormat', PROJECTS);
    expect(resolvedPath(s)).toBe(`${ROOT}\\ContosoFin - StatementFormat\\ContosoFin - StatementFormat.rnrproj`);
  });

  it('refuses a partial project name that hits several', () => {
    const s = selectProject('FeatureManagement', PROJECTS);
    expect(s.kind).toBe('ambiguous');
    if (s.kind !== 'ambiguous') return;
    expect(s.matchedOn).toBe('project-file');
    expect(s.candidates).toHaveLength(2);
  });

  it('resolves a full .rnrproj path passed as projectName', () => {
    const target = PROJECTS[1].projectPath!;
    const s = selectProject(target, PROJECTS);
    expect(resolvedPath(s)).toBe(target);
    expect(s.kind === 'resolved' && s.matchedOn).toBe('project-path');
  });

  it('reports none for an unknown name', () => {
    expect(selectProject('NoSuchThing', PROJECTS).kind).toBe('none');
  });

  it('reports none for blank input rather than matching everything', () => {
    expect(selectProject('   ', PROJECTS).kind).toBe('none');
  });

  it('reads the project file name out of a Windows path on any host', () => {
    // path.basename on POSIX treats "\" as an ordinary character and hands back
    // the whole path, so every stem comparison ran against a path and nothing
    // short of a full-path match could resolve. CI is Linux; the paths are not.
    const s = selectProject('ContosoFin - StatementFormat', PROJECTS);
    expect(s.kind).toBe('resolved');
    expect(s.kind === 'resolved' && s.matchedOn).toBe('project-file');
  });

  it('tolerates projects with no .rnrproj path', () => {
    const modelOnly: D365ProjectInfo = { modelName: 'ContosoOrphan' };
    const s = selectProject('ContosoOrphan', [...PROJECTS, modelOnly]);
    expect(s.kind).toBe('resolved');
    expect(resolvedPath(s)).toBeUndefined();
  });
});

describe('renderSelectionFailure', () => {
  it('lists every candidate with its model so the caller can pick', () => {
    const s = selectProject('ContosoFin', PROJECTS);
    if (s.kind !== 'ambiguous') throw new Error('expected ambiguous');
    const text = renderSelectionFailure(s, PROJECTS);
    expect(text).toContain('3 projects match');
    expect(text).toContain('ContosoFin - FeatureManagement');
    expect(text).toContain('contoso-demo-workspace');
    expect(text).toContain('Nothing was switched');
  });

  it('says reading needs no switch, so the agent stops switching to read', () => {
    const s = selectProject('ContosoFin', PROJECTS);
    if (s.kind !== 'ambiguous') throw new Error('expected ambiguous');
    expect(renderSelectionFailure(s, PROJECTS)).toMatch(/Reading never needs a switch/i);
  });

  it('names projects, not models, when nothing matched', () => {
    const s = selectProject('NoSuchThing', PROJECTS);
    if (s.kind !== 'none') throw new Error('expected none');
    const text = renderSelectionFailure(s, PROJECTS);
    expect(text).toContain('selects a PROJECT');
    expect(text).toContain('ContosoFin - StatementFormat');
  });
});
