/**
 * The models this workspace develops: a set, not one model (#1332).
 *
 * The server used to treat the model of the active .rnrproj as the only model a
 * workspace develops, and every other custom model as somebody else's code. That
 * does not match how D365FO is developed. A model almost always comes with a test
 * model, a partner solution is often split across several models, and a customer
 * can take over the models of more than one partner. Under the single-model
 * premise a write into the test model was refused or carried a "you probably did
 * not mean this" warning, and an object of the test model was registered into the
 * main model's project, which that project's build then fails on.
 *
 * A model belongs to the workspace when:
 *   • it is the write anchor (configManager.getWriteAnchorModel), as before;
 *   • a project of the anchor project's VS solution (.sln / .slnx) builds it.
 *     The solution is the developer's own statement of what they work on
 *     together, and Visual Studio already lets them edit every project in it;
 *   • it is listed in `workspace.models` (D365FO_WORKSPACE_MODELS), or in
 *     D365FO_CROSS_MODEL_WRITE_MODELS, the older name of the same list;
 * and it is not listed in `workspace.excludeModels` (D365FO_WORKSPACE_EXCLUDE_MODELS),
 * which takes a model out again whatever the solution or the other list says. A
 * customer's build solution holds a project for every ISV model shipped as source,
 * only so that the pipeline compiles it; read as a
 * statement of what the workspace develops, it made that ISV code writable in
 * place (#1342). The anchor itself cannot be excluded.
 *
 * Every other custom model is still refused by the cross-model guard: the
 * failure that guard was written for (an agent editing a shared model in place,
 * from a workspace that only consumes it) is untouched by this. The solution is
 * read from the project the SERVER detected or the user configured, never from a
 * get_workspace_info project switch, so a tool call cannot widen the set. When
 * neither exists — several projects build the anchor model and none was picked —
 * no solution is read at all, except the one D365FO_SOLUTION_PATH names: every
 * solution that lists any of those projects would be a guess about intent, and
 * one build solution among them was enough to add every model it builds (#1342).
 *
 * The guard is synchronous and is called from a dozen writers, so the solution
 * part is cached here and refreshed by refreshWorkspaceModels(), which
 * resolveAnchorModel() — the one call every writer already awaits before its
 * guard — runs first.
 */

import * as fs from 'fs/promises';
import { existsSync, readdirSync, statSync } from 'fs';
import * as path from 'path';
import { reloadWritePolicy } from '../utils/loadEnv.js';
import { extractModelNameFromProject } from '../utils/workspaceDetector.js';

/** One project of the anchor project's solution, with the model it builds. */
export interface SolutionProject {
  projectPath: string;
  modelName: string;
}

/** Why a model counts as one of this workspace's models. */
export type WorkspaceModelSource = 'anchor' | 'solution' | 'config';

export interface WorkspaceModel {
  name: string;
  source: WorkspaceModelSource;
}

const eq = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map(v => v.trim()).filter(Boolean);
}

/** The models the user listed, from `workspace.models` and its older env name. */
export function configuredWorkspaceModels(): string[] {
  reloadWritePolicy();
  const out: string[] = [];
  for (const name of [
    ...splitList(process.env.D365FO_WORKSPACE_MODELS),
    ...splitList(process.env.D365FO_CROSS_MODEL_WRITE_MODELS),
  ]) {
    if (!out.some(o => eq(o, name))) out.push(name);
  }
  return out;
}

/** The models `workspace.excludeModels` takes out of the workspace (#1342). */
export function excludedWorkspaceModels(): string[] {
  reloadWritePolicy();
  return splitList(process.env.D365FO_WORKSPACE_EXCLUDE_MODELS);
}

/** True when `workspace.excludeModels` lists `model`. */
export function isExcludedWorkspaceModel(model: string | null | undefined): boolean {
  return !!model && excludedWorkspaceModels().some(m => eq(m, model));
}

// ── Solution projects ────────────────────────────────────────────────────────

interface SolutionState {
  /** Solution files and their mtimes, so an unchanged solution is not re-read. */
  key: string;
  solutionFiles: string[];
  projects: SolutionProject[];
}

let solutionState: SolutionState = { key: '', solutionFiles: [], projects: [] };

/** For tests: forget the cached solution. */
export function resetWorkspaceModelsCache(): void {
  solutionState = { key: '', solutionFiles: [], projects: [] };
}

/** The projects of the anchor project's solution, as last refreshed. */
export function solutionProjects(): readonly SolutionProject[] {
  return solutionState.projects;
}

/** The solution files the cached projects came from. */
export function solutionFiles(): readonly string[] {
  return solutionState.solutionFiles;
}

/** Normalised for comparison: resolved, one separator, case-folded (Windows paths are). */
function pathKey(p: string): string {
  return path.resolve(p.replace(/[\\/]+/g, path.sep)).toLowerCase();
}

/**
 * The .rnrproj files a solution lists, as absolute paths.
 *
 * `.sln`: `Project("{type}") = "Name", "Folder\Name.rnrproj", "{guid}"`.
 * `.slnx` (Visual Studio 17.13+): `<Project Path="Folder/Name.rnrproj" />`.
 * Paths are relative to the solution's folder.
 */
export function parseSolutionProjects(solutionFile: string, text: string): string[] {
  const dir = path.dirname(solutionFile);
  const rel: string[] = [];
  if (/\.slnx$/i.test(solutionFile)) {
    for (const m of text.matchAll(/<Project\b[^>]*\bPath\s*=\s*"([^"]+\.rnrproj)"/gi)) rel.push(m[1]);
  } else {
    for (const m of text.matchAll(/^\s*Project\("[^"]*"\)\s*=\s*"[^"]*"\s*,\s*"([^"]+\.rnrproj)"/gim)) rel.push(m[1]);
  }
  return rel.map(r => {
    const native = r.replace(/[\\/]+/g, path.sep);
    return path.isAbsolute(native) || /^[A-Za-z]:/.test(r) ? native : path.join(dir, native);
  });
}

/** Every .sln / .slnx directly in `dir`, or `dir` itself when it is one. */
function solutionFilesIn(dir: string): string[] {
  if (/\.slnx?$/i.test(dir)) return existsSync(dir) ? [dir] : [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && /\.slnx?$/i.test(e.name))
      .map(e => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function mtime(file: string): string {
  try { return String(statSync(file).mtimeMs); } catch { return '-'; }
}

/** The subset of ConfigManager this module reads — every member optional, for mocks. */
export interface WorkspaceModelsConfig {
  getServerDetectedProject?: () => { projectPath?: string } | null;
  getConfiguredProjectPath?: () => string | undefined;
  getWriteAnchorModel?: () => string | null;
  getProjectsForModel?: (model: string | null | undefined) => string[];
}

/**
 * The projects the workspace itself points at: the one the server detected or
 * the user configured. Never a project a get_workspace_info switch activated,
 * and never "every project of the anchor model" when none was picked — see the
 * header. With 81 work-item projects building one model, the solutions that
 * list any of them included the customer's build solution, and with it every
 * ISV model that solution compiles (#1342).
 */
function anchorProjects(cm: WorkspaceModelsConfig): string[] {
  const out: string[] = [];
  const add = (p: string | null | undefined) => {
    if (p && /\.rnrproj$/i.test(p) && !out.some(o => pathKey(o) === pathKey(p))) out.push(p);
  };
  try { add(cm.getServerDetectedProject?.()?.projectPath); } catch { /* best effort */ }
  try { add(cm.getConfiguredProjectPath?.()); } catch { /* best effort */ }
  return out;
}

/**
 * Re-read the anchor project's solution when it changed. Cheap when it did not:
 * one directory listing and one stat per solution file.
 *
 * Only solutions that actually list an anchor project count. A projects folder
 * holding several unrelated solutions next to each other would otherwise make
 * every model in all of them part of this workspace.
 */
export async function refreshWorkspaceModels(cm: WorkspaceModelsConfig): Promise<void> {
  try {
    const anchors = anchorProjects(cm);
    const configuredSolution = process.env.D365FO_SOLUTION_PATH?.trim();
    const candidates: string[] = [];
    const addAll = (files: string[]) => {
      for (const f of files) if (!candidates.some(c => pathKey(c) === pathKey(f))) candidates.push(f);
    };
    if (configuredSolution) addAll(solutionFilesIn(configuredSolution));
    for (const project of anchors) {
      // Visual Studio puts the .sln one folder above the project folder; a
      // flattened layout keeps it next to the .rnrproj.
      addAll(solutionFilesIn(path.dirname(project)));
      addAll(solutionFilesIn(path.dirname(path.dirname(project))));
    }

    const key = [...anchors.map(pathKey), '|', ...candidates.map(c => `${pathKey(c)}@${mtime(c)}`)].join(';');
    if (key === solutionState.key) return;

    const anchorKeys = new Set(anchors.map(pathKey));
    const used: string[] = [];
    const listed: string[] = [];
    for (const file of candidates) {
      let text: string;
      try { text = await fs.readFile(file, 'utf-8'); } catch { continue; }
      const projects = parseSolutionProjects(file, text);
      // A configured solution counts on its own; a discovered one only when it
      // lists the anchor project.
      const isConfigured = !!configuredSolution &&
        (pathKey(file) === pathKey(configuredSolution) || pathKey(path.dirname(file)) === pathKey(configuredSolution));
      if (!isConfigured && !projects.some(p => anchorKeys.has(pathKey(p)))) continue;
      used.push(file);
      for (const p of projects) if (!listed.some(l => pathKey(l) === pathKey(p))) listed.push(p);
    }

    const projects: SolutionProject[] = [];
    for (const projectPath of listed) {
      const modelName = await extractModelNameFromProject(projectPath).catch(() => null);
      if (modelName) projects.push({ projectPath, modelName });
    }
    solutionState = { key, solutionFiles: used, projects };
  } catch {
    /* best effort: the guard falls back to the anchor and the configured list */
  }
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Every model this workspace develops, with the reason it counts. The anchor
 * comes first when given. A model `workspace.excludeModels` lists is left out,
 * unless it is the anchor.
 */
export function workspaceModels(anchor?: string | null): WorkspaceModel[] {
  const out: WorkspaceModel[] = [];
  const excluded = excludedWorkspaceModels();
  const add = (name: string, source: WorkspaceModelSource) => {
    if (!name || out.some(m => eq(m.name, name))) return;
    if (source !== 'anchor' && excluded.some(x => eq(x, name))) return;
    out.push({ name, source });
  };
  if (anchor) add(anchor, 'anchor');
  for (const p of solutionState.projects) add(p.modelName, 'solution');
  for (const m of configuredWorkspaceModels()) add(m, 'config');
  return out;
}

/** The reason `model` counts as one of this workspace's models, or null. */
export function workspaceModelSource(model: string | null | undefined): WorkspaceModelSource | null {
  if (!model || isExcludedWorkspaceModel(model)) return null;
  if (solutionState.projects.some(p => eq(p.modelName, model))) return 'solution';
  if (configuredWorkspaceModels().some(m => eq(m, model))) return 'config';
  return null;
}

/**
 * True when `model` is developed in this workspace besides the anchor: a model
 * of the solution, or one the user listed. The anchor itself is the guard's own
 * comparison and is not repeated here.
 */
export function isWorkspaceModel(model: string | null | undefined): boolean {
  return workspaceModelSource(model) !== null;
}

// ── Which project an object of a model is registered in ─────────────────────

export interface ProjectForModel {
  /** The project to register into, or undefined when there is none to pick. */
  projectPath?: string;
  /** True when this is not the project the caller handed in. */
  rerouted: boolean;
  /** The project the caller handed in, when it builds another model. */
  mismatch?: { projectPath: string; projectModel: string };
  /** Several projects build the model and none was given: the caller must name one. */
  ambiguous: string[];
}

/**
 * The project an object of `model` belongs in, starting from `preferred` — the
 * active project, or the projectPath the caller passed.
 *
 * Every writer registered into the active project without asking which model it
 * builds, so an object written into the test model was added to the main
 * model's project, whose build then fails on an element of a model it does not
 * build (#1332). A project of another model is never the answer. The model's
 * own project is: one in the solution, or one the solutions scan found.
 *
 * A `preferred` whose model cannot be read is kept, as before: refusing to
 * register on an unreadable project would turn a best-effort step into a gap.
 */
export async function resolveProjectForModel(
  model: string | null | undefined,
  preferred: string | null | undefined,
  cm?: WorkspaceModelsConfig,
): Promise<ProjectForModel> {
  if (!model) return { projectPath: preferred ?? undefined, rerouted: false, ambiguous: [] };

  let mismatch: ProjectForModel['mismatch'];
  if (preferred && /\.rnrproj$/i.test(preferred)) {
    const projectModel = await extractModelNameFromProject(preferred).catch(() => null);
    if (!projectModel || eq(projectModel, model)) return { projectPath: preferred, rerouted: false, ambiguous: [] };
    mismatch = { projectPath: preferred, projectModel };
  } else if (preferred) {
    // A folder, not a project: the callers that accept one search it themselves.
    return { projectPath: preferred, rerouted: false, ambiguous: [] };
  }

  const candidates: string[] = [];
  const add = (p: string) => {
    if (!candidates.some(c => pathKey(c) === pathKey(p))) candidates.push(p);
  };
  for (const p of solutionState.projects) if (eq(p.modelName, model)) add(p.projectPath);
  try { for (const p of cm?.getProjectsForModel?.(model) ?? []) add(p); } catch { /* best effort */ }
  const existing = candidates.filter(p => existsSync(p));

  if (existing.length === 1) return { projectPath: existing[0], rerouted: !!preferred, mismatch, ambiguous: [] };
  // `preferred` is either absent here or builds another model: nothing to keep.
  return { projectPath: undefined, rerouted: false, mismatch, ambiguous: existing.length > 1 ? existing : [] };
}

/** The line that says why the object was not registered into `mismatch.projectPath`. */
export function describeProjectMismatch(model: string, r: ProjectForModel): string {
  if (!r.mismatch) return '';
  const name = path.basename(r.mismatch.projectPath);
  if (r.projectPath) {
    return `added to ${path.basename(r.projectPath)}, the project of model "${model}" — not to ${name}, ` +
      `which builds "${r.mismatch.projectModel}"`;
  }
  const why = r.ambiguous.length > 1
    ? `${r.ambiguous.length} projects build "${model}" (${r.ambiguous.map(p => path.basename(p)).join(', ')}); ` +
      `pass projectPath with the one to add it to`
    : `no project of "${model}" was found; add that project to the solution, or pass its projectPath`;
  return `not added to ${name}: that project builds model "${r.mismatch.projectModel}", and an element of ` +
    `"${model}" in it breaks its build. ${why}`;
}
