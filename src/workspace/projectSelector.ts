/**
 * Resolving the `projectName` argument of get_workspace_info to one project.
 *
 * The rule this module exists to enforce: a project identifies its model, never
 * the other way round. A .rnrproj states its model in its own PropertyGroup —
 *
 *   <Model>ContosoFin</Model>
 *
 * — so going project → model is a read of a declared fact. Going model →
 * project is a guess, because a model is built by as many projects as its
 * owner cares to split it into. In the solution this bug was found in, fifteen
 * .rnrproj files declare `ContosoFin`.
 *
 * The previous implementation took the first of those fifteen:
 *
 *   allProjects.find(p => p.modelName.toLowerCase() === needle)
 *     ?? allProjects.find(p => p.modelName.toLowerCase().includes(needle))
 *
 * An agent that switched away to read another model and then switched "back"
 * by model name did not come back — it landed on a same-model project it had
 * never asked for, and every subsequent write registered itself there. The
 * workspace's own project was never touched, and nothing in the run said so.
 *
 * So: match on project IDENTITY first (its file name, or its path), and fall
 * back to the model name only when exactly one project claims it. More than
 * one and this returns `ambiguous` — the caller lists them and picks nothing.
 * Refusing to choose is the entire point; a wrong project here is silent and
 * only shows up as a model that does not build.
 */

import type { D365ProjectInfo } from '../utils/workspaceDetector.js';

/** How a needle was matched, for the switch note the tool prints. */
export type ProjectMatchKind = 'project-path' | 'project-file' | 'model';

export type ProjectSelection =
  | { kind: 'resolved'; project: D365ProjectInfo; matchedOn: ProjectMatchKind }
  | { kind: 'ambiguous'; needle: string; matchedOn: ProjectMatchKind; candidates: D365ProjectInfo[] }
  | { kind: 'none'; needle: string };

/**
 * "…\ContosoFin - FeatureManagement.rnrproj" → "contosofin - featuremanagement"
 *
 * Splits on BOTH separators rather than using path.basename: the server can run
 * on a POSIX host while every project path it is handed comes from a Windows
 * metadata store, and path.basename there treats the backslashes as ordinary
 * characters and returns the whole path. Every stem comparison below would then
 * be against a path, so nothing short of a full-path match could resolve.
 */
function projectFileStem(p: D365ProjectInfo): string | null {
  if (!p.projectPath) return null;
  return projectDisplayName(p.projectPath).toLowerCase();
}

/** Leaf name of a project path, extension dropped. Cross-platform, as above. */
function projectDisplayName(projectPath: string): string {
  const leaf = projectPath.split(/[\\/]/).pop() ?? projectPath;
  return leaf.replace(/\.rnrproj$/i, '');
}

/**
 * Pick the single project a `projectName` refers to.
 *
 * The strategies run in order and the FIRST one that matches anything decides
 * the outcome — including when what it matched is several projects. It must not
 * fall through to a later strategy after a hit, or the fix defeats itself:
 * "ContosoFin" matches three projects by model, but it is also a substring of
 * exactly one project's file name, so a fall-through would quietly resolve to
 * "ContosoFin - FeatureManagement" — the very landing this module exists to
 * prevent, reintroduced by the ranking rather than by the guess.
 *
 * Every exact strategy therefore precedes every partial one, and a tie inside a
 * strategy is reported, never broken.
 */
const STRATEGIES: ReadonlyArray<{
  matchedOn: ProjectMatchKind;
  hits: (p: D365ProjectInfo, needle: string) => boolean;
}> = [
  // A full path to the .rnrproj — unambiguous by construction, and lets a
  // caller holding the path use the friendlier argument name.
  { matchedOn: 'project-path', hits: (p, n) => p.projectPath?.toLowerCase() === n },
  // The project's own file name: what VS shows in Solution Explorer, and what
  // someone means when they name a project rather than a model.
  { matchedOn: 'project-file', hits: (p, n) => projectFileStem(p) === n },
  // Model name. Only a selection when the model has exactly one project;
  // otherwise the caller has named a set.
  { matchedOn: 'model', hits: (p, n) => p.modelName.toLowerCase() === n },
  // "FeatureManagement" for "ContosoFin - FeatureManagement".
  { matchedOn: 'project-file', hits: (p, n) => projectFileStem(p)?.includes(n) ?? false },
  { matchedOn: 'model', hits: (p, n) => p.modelName.toLowerCase().includes(n) },
];

export function selectProject(
  projectName: string,
  allProjects: readonly D365ProjectInfo[],
): ProjectSelection {
  const needle = projectName.trim().toLowerCase();
  if (!needle) return { kind: 'none', needle: projectName };

  for (const { matchedOn, hits } of STRATEGIES) {
    const found = allProjects.filter(p => hits(p, needle));
    if (found.length === 1) return { kind: 'resolved', project: found[0], matchedOn };
    if (found.length > 1) {
      return { kind: 'ambiguous', needle: projectName, matchedOn, candidates: found };
    }
  }

  return { kind: 'none', needle: projectName };
}

/** The list an ambiguous or failed selection prints. One line per project. */
export function renderProjectCandidates(candidates: readonly D365ProjectInfo[]): string {
  return candidates
    .map(c => {
      const stem = c.projectPath ? projectDisplayName(c.projectPath) : '(no .rnrproj)';
      return `  • ${stem}   [model: ${c.modelName}]\n      ${c.projectPath ?? '(path unknown)'}`;
    })
    .join('\n');
}

/** The whole message for a `projectName` that could not be resolved to one project. */
export function renderSelectionFailure(
  selection: Extract<ProjectSelection, { kind: 'ambiguous' | 'none' }>,
  allProjects: readonly D365ProjectInfo[],
): string {
  if (selection.kind === 'none') {
    const names = allProjects.length
      ? renderProjectCandidates(allProjects.slice(0, 20)) +
        (allProjects.length > 20 ? `\n  … and ${allProjects.length - 20} more` : '')
      : '  (none — set D365FO_SOLUTIONS_PATH)';
    return (
      `❌ No project matches "${selection.needle}".\n\n` +
      `projectName selects a PROJECT, by its .rnrproj file name or full path.\n` +
      `Known projects:\n${names}`
    );
  }

  const what = selection.matchedOn === 'model' ? 'model' : 'partial project name';
  return (
    `❌ "${selection.needle}" is a ${what}, not one project — ${selection.candidates.length} projects match it.\n` +
    `Nothing was switched. Name the project you want, or pass its projectPath:\n\n` +
    renderProjectCandidates(selection.candidates) +
    `\n\nReading never needs a switch: get_object_info, search and find_references span every model ` +
    `regardless of which project is active. Switch only to change where new files get REGISTERED.`
  );
}
