/**
 * Create / delete Visual Studio D365FO projects (.rnrproj) and keep the solution (.sln) in step.
 * Shapes follow projects VS itself wrote. Project dependencies live in the .sln
 * (`ProjectSection(ProjectDependencies)`), not the .rnrproj. Two solution layouts exist —
 * one shared `<Model>.sln`, or one `.sln` per project folder — and 'auto' detects which;
 * an undecidable repo is an error, never a guess.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { withFileLock, writeFileAtomic } from '../utils/atomicFileWrite.js';
import {
  defaultProjectTemplate, renderRnrprojFromTemplate, ProjectTemplateError, type ProjectTemplate,
} from './projectTemplate.js';

/** Project-type GUID VS assigns to a D365FO (.rnrproj) project. */
export const D365FO_PROJECT_TYPE_GUID = '{FC65038C-1B2F-41E1-A629-BED71D161FFF}';

const BOM = '﻿';

export type SolutionMode = 'auto' | 'shared' | 'per-project' | 'none';

export interface ScaffoldProjectOptions {
  projectName: string;
  modelName: string;
  /** Folder that holds the project folders (`…/Projects/<Model>`). */
  projectsRoot: string;
  solutionMode: SolutionMode;
  /** Shared mode only: the .sln to extend, when the folder holds more than one. */
  solutionFile?: string;
  /** Text shown for the project in the solution. Default: the project name. */
  displayName?: string;
  /** Names of projects in the SAME solution this one builds after. */
  dependsOn?: string[];
  /** The .rnrproj template. Default: Visual Studio's own (defaultProjectTemplate). */
  template?: ProjectTemplate;
}

export interface ScaffoldResult {
  projectPath: string;
  projectGuid: string;
  /** The solution the project was registered in; null when solutionMode is 'none'. */
  solutionPath: string | null;
  /** The mode actually used ('auto' resolved). */
  solutionMode: Exclude<SolutionMode, 'auto'>;
  /** Every file written, for the caller's report. */
  written: string[];
  /** Projects of the solution this one now depends on. */
  dependsOn: string[];
  /** The template the .rnrproj was made from. */
  template: ProjectTemplate;
}

/** A refusal the caller can act on. Never thrown for a programming error. */
export class ScaffoldError extends Error {}

// ── Names ────────────────────────────────────────────────────────────────────

/** A name becomes a folder, a file name and an XML text node — checked against all three. */
export function validateProjectName(name: string): string | null {
  if (!name || !name.trim()) return 'projectName is empty';
  if (name !== name.trim()) return 'projectName has leading/trailing whitespace';
  if (name.length > 100) return 'projectName is longer than 100 characters';
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._()\-]*$/.test(name)) {
    return `projectName "${name}" may contain only letters, digits, space, '.', '_', '-', '(' and ')' and must start with a letter or digit`;
  }
  if (/[. ]$/.test(name)) return 'projectName must not end with a dot or a space';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) return `projectName "${name}" is a reserved Windows name`;
  return null;
}

// ── .rnrproj ─────────────────────────────────────────────────────────────────

// The .rnrproj itself comes from projectTemplate.ts. It has no ItemGroups:
// ProjectFileManager.addToProject creates them on first use.

// ── .sln ─────────────────────────────────────────────────────────────────────

interface SlnProject { name: string; relPath: string; guid: string; typeGuid: string }

const SLN_PROJECT_RE = /^Project\("(\{[^}]+\})"\)\s*=\s*"([^"]*)",\s*"([^"]*)",\s*"(\{[^}]+\})"/gm;

export function parseSolutionProjects(sln: string): SlnProject[] {
  return [...sln.matchAll(SLN_PROJECT_RE)].map(m => ({
    typeGuid: m[1].toUpperCase(), name: m[2], relPath: m[3], guid: m[4].toUpperCase(),
  }));
}

/**
 * Resolve a caller's project name to projects of the solution: display name, file stem
 * or "<name> (…)" prefix, the first tier that matches. More than one hit is ambiguous —
 * the caller refuses rather than wire a dependency on whichever the file lists first.
 */
function findSolutionProjects(projects: SlnProject[], wanted: string): SlnProject[] {
  const w = wanted.toLowerCase();
  const stem = (p: SlnProject) => path.win32.basename(p.relPath).replace(/\.rnrproj$/i, '').toLowerCase();
  const tiers: Array<(p: SlnProject) => boolean> = [
    p => p.name.toLowerCase() === w,
    p => stem(p) === w,
    p => p.name.toLowerCase().startsWith(w + ' '),
  ];
  for (const matches of tiers) {
    const hits = projects.filter(matches);
    if (hits.length) return hits;
  }
  return [];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function projectBlock(opts: {
  displayName: string; relPath: string; guid: string; dependsOnGuids: string[]; eol: string;
}): string {
  const { displayName, relPath, guid, dependsOnGuids, eol } = opts;
  const out = [`Project("${D365FO_PROJECT_TYPE_GUID}") = "${displayName}", "${relPath}", "${guid}"`];
  if (dependsOnGuids.length) {
    out.push('\tProjectSection(ProjectDependencies) = postProject');
    for (const g of dependsOnGuids) out.push(`\t\t${g} = ${g}`);
    out.push('\tEndProjectSection');
  }
  out.push('EndProject');
  return out.join(eol) + eol;
}

const CONFIG_KEYS = (guid: string) => [
  `\t\t${guid}.Debug|Any CPU.ActiveCfg = Debug|Any CPU`,
  `\t\t${guid}.Debug|Any CPU.Build.0 = Debug|Any CPU`,
];

/**
 * Configuration lines for a project joining `sln`: one pair per solution configuration,
 * mapped the way an existing D365FO project of the solution maps it (repos differ:
 * Release → Release|Any CPU in some, → Debug|Any CPU in others). A solution that
 * declares no configurations gets the Debug pair.
 */
function configLinesFor(sln: string, guid: string): string[] {
  const declared = /GlobalSection\(SolutionConfigurationPlatforms\)\s*=\s*preSolution([\s\S]*?)EndGlobalSection/.exec(sln)?.[1] ?? '';
  const configs = [...declared.matchAll(/^[ \t]*([^=\r\n]+?)[ \t]*=/gm)].map(m => m[1]);
  if (!configs.length) return CONFIG_KEYS(guid);

  const sibling = parseSolutionProjects(sln).find(p => p.typeGuid === D365FO_PROJECT_TYPE_GUID);
  const mapped = new Map<string, string>();
  if (sibling) {
    const re = new RegExp(`^[ \\t]*${escapeRe(sibling.guid)}\\.(.+?)\\.(ActiveCfg|Build\\.0)[ \\t]*=[ \\t]*(.+?)[ \\t]*$`, 'gim');
    for (const m of sln.matchAll(re)) mapped.set(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`, m[3]);
  }
  const out: string[] = [];
  for (const cfg of configs) {
    const active = mapped.get(`${cfg.toLowerCase()}.activecfg`) ?? `${cfg.split('|')[0]}|Any CPU`;
    out.push(`\t\t${guid}.${cfg}.ActiveCfg = ${active}`);
    // A sibling left out of the build in this configuration leaves the new one out too.
    const build = sibling ? mapped.get(`${cfg.toLowerCase()}.build.0`) : active;
    if (build) out.push(`\t\t${guid}.${cfg}.Build.0 = ${build}`);
  }
  return out;
}

/** Add a project to solution text. Pure — the caller reads and writes the file. */
export function addProjectToSolutionText(sln: string, opts: {
  displayName: string; relPath: string; guid: string; dependsOnGuids: string[];
}): string {
  const eol = eolOf(sln);
  const block = projectBlock({ ...opts, eol });

  // Project entries sit between the header and `Global`.
  const globalAt = sln.search(/^Global\s*$/m);
  if (globalAt < 0) {
    // No Global section at all: append a minimal one after the project.
    const sections = [
      'Global',
      '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
      '\t\tDebug|Any CPU = Debug|Any CPU',
      '\tEndGlobalSection',
      '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution',
      ...CONFIG_KEYS(opts.guid),
      '\tEndGlobalSection',
      'EndGlobal',
    ].join(eol) + eol;
    return sln.replace(/\s*$/, eol) + block + sections;
  }
  const configLines = configLinesFor(sln, opts.guid);
  let out = sln.slice(0, globalAt) + block + sln.slice(globalAt);

  const cfgRe = /(GlobalSection\(ProjectConfigurationPlatforms\)\s*=\s*postSolution[\s\S]*?)(\r?\n[ \t]*EndGlobalSection)/;
  if (cfgRe.test(out)) {
    out = out.replace(cfgRe, (_m, body: string, end: string) => body + eol + configLines.join(eol) + end);
  } else {
    // A solution with no project-configuration section: add one before EndGlobal.
    out = out.replace(/^EndGlobal\s*$/m, [
      '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution',
      ...configLines,
      '\tEndGlobalSection',
      'EndGlobal',
    ].join(eol));
  }
  return out;
}

export function renderNewSolution(opts: {
  displayName: string; relPath: string; guid: string; dependsOnGuids?: string[];
}): string {
  const eol = '\r\n';
  const lines = [
    '',
    'Microsoft Visual Studio Solution File, Format Version 12.00',
    '# Visual Studio Version 17',
    'VisualStudioVersion = 17.9.34728.123',
    'MinimumVisualStudioVersion = 10.0.40219.1',
  ].join(eol) + eol;
  const project = projectBlock({ ...opts, dependsOnGuids: opts.dependsOnGuids ?? [], eol });
  const global = [
    'Global',
    '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
    '\t\tDebug|Any CPU = Debug|Any CPU',
    '\tEndGlobalSection',
    '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution',
    ...CONFIG_KEYS(opts.guid),
    '\tEndGlobalSection',
    '\tGlobalSection(SolutionProperties) = preSolution',
    '\t\tHideSolutionNode = FALSE',
    '\tEndGlobalSection',
    '\tGlobalSection(ExtensibilityGlobals) = postSolution',
    `\t\tSolutionGuid = {${randomUUID().toUpperCase()}}`,
    '\tEndGlobalSection',
    'EndGlobal',
  ].join(eol) + eol;
  return BOM + lines + project + global;
}

// ── Layout detection ─────────────────────────────────────────────────────────

async function listDir(dir: string): Promise<import('fs').Dirent[]> {
  try { return await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

export interface SolutionLayout {
  mode: 'shared' | 'per-project' | 'unknown';
  /** Shared: every .sln beside the project folders. */
  sharedCandidates: string[];
}

/** Decide which solution pattern `projectsRoot` follows — see the file header. */
export async function detectSolutionLayout(projectsRoot: string): Promise<SolutionLayout> {
  const entries = await listDir(projectsRoot);
  const shared = entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.sln'))
    .map(e => path.join(projectsRoot, e.name));
  if (shared.length) return { mode: 'shared', sharedCandidates: shared };

  for (const e of entries.filter(x => x.isDirectory())) {
    const inner = await listDir(path.join(projectsRoot, e.name));
    if (inner.some(f => f.isFile() && f.name.toLowerCase().endsWith('.sln'))) {
      return { mode: 'per-project', sharedCandidates: [] };
    }
  }
  return { mode: 'unknown', sharedCandidates: [] };
}

/** Where a model's project folders live: the most common `<root>` of `<root>/<Proj>/<Proj>.rnrproj`. */
export function inferProjectsRoot(existingProjectPaths: string[]): string | null {
  const votes = new Map<string, number>();
  for (const p of existingProjectPaths) {
    const root = path.dirname(path.dirname(p));
    votes.set(root, (votes.get(root) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [root, count] of votes) if (count > n) { best = root; n = count; }
  return best;
}

/** A root is only accepted if it already holds a .sln/.rnrproj (beside or one folder down) — no files in arbitrary folders. */
export async function looksLikeProjectsRoot(root: string): Promise<boolean> {
  const entries = await listDir(root);
  if (entries.some(e => e.isFile() && /\.(sln|rnrproj)$/i.test(e.name))) return true;
  for (const e of entries.filter(x => x.isDirectory())) {
    const inner = await listDir(path.join(root, e.name));
    if (inner.some(f => f.isFile() && /\.(sln|rnrproj)$/i.test(f.name))) return true;
  }
  return false;
}

// ── Orchestration ────────────────────────────────────────────────────────────

async function readTextKeepingBom(file: string): Promise<{ text: string; bom: boolean }> {
  const raw = await fs.readFile(file, 'utf-8');
  return raw.charCodeAt(0) === 0xFEFF ? { text: raw.slice(1), bom: true } : { text: raw, bom: false };
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/** Create the folder and .rnrproj and register it in a solution. Validates before the first write; a later failure removes what this call created. */
export async function scaffoldProject(opts: ScaffoldProjectOptions): Promise<ScaffoldResult> {
  const nameError = validateProjectName(opts.projectName);
  if (nameError) throw new ScaffoldError(nameError);
  // The display name sits between quotes on a .sln line: a quote or a line break in it
  // would end that line early and let the rest be read as further solution entries.
  if (opts.displayName !== undefined && [...opts.displayName].some(c => c === '"' || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) {
    throw new ScaffoldError('displayName may not contain a double quote, a line break or another control character');
  }
  if (!opts.modelName || !/^[A-Za-z0-9_]+$/.test(opts.modelName)) {
    throw new ScaffoldError(`modelName "${opts.modelName}" is not a valid model name`);
  }

  const projectDir = path.join(opts.projectsRoot, opts.projectName);
  const projectPath = path.join(projectDir, `${opts.projectName}.rnrproj`);
  if (await exists(projectPath)) {
    throw new ScaffoldError(`${projectPath} already exists — refusing to overwrite an existing project.`);
  }

  // Resolve the solution first, so an undecidable layout stops before anything is written.
  let mode: Exclude<SolutionMode, 'auto'>;
  let sharedSln: string | null = null;
  if (opts.solutionMode === 'auto') {
    const layout = await detectSolutionLayout(opts.projectsRoot);
    if (layout.mode === 'unknown') {
      throw new ScaffoldError(
        `Cannot tell whether "${opts.projectsRoot}" uses one shared .sln or one .sln per project ` +
        `(no .sln found beside or inside the existing project folders). Ask the user, then re-run with ` +
        `solutionMode="shared" or "per-project" (or "none" to create only the .rnrproj).`,
      );
    }
    mode = layout.mode;
  } else {
    mode = opts.solutionMode;
  }

  if (mode === 'shared') {
    if (opts.solutionFile) {
      sharedSln = path.resolve(opts.solutionFile);
      if (!(await exists(sharedSln))) throw new ScaffoldError(`solutionFile ${sharedSln} does not exist.`);
      // Same containment as projectsRoot.
      if (path.resolve(path.dirname(sharedSln)).toLowerCase() !== path.resolve(opts.projectsRoot).toLowerCase()) {
        throw new ScaffoldError(`solutionFile ${sharedSln} is not in ${opts.projectsRoot}.`);
      }
    } else {
      const layout = await detectSolutionLayout(opts.projectsRoot);
      if (layout.sharedCandidates.length === 0) {
        throw new ScaffoldError(
          `solutionMode="shared" but no .sln exists in ${opts.projectsRoot}. ` +
          `Pass solutionFile, or use solutionMode="per-project" to create a new solution for this project.`,
        );
      }
      if (layout.sharedCandidates.length > 1) {
        throw new ScaffoldError(
          `${layout.sharedCandidates.length} solutions in ${opts.projectsRoot} — pass solutionFile to choose one:\n` +
          layout.sharedCandidates.map(c => `  - ${c}`).join('\n'),
        );
      }
      sharedSln = layout.sharedCandidates[0];
    }
  }

  const dependsOn = (opts.dependsOn ?? []).filter(Boolean);
  if (dependsOn.length && mode !== 'shared') {
    throw new ScaffoldError(
      `dependsOn needs a solution that already contains the projects it names, so it works only ` +
      `with a shared solution (this call resolved to "${mode}").`,
    );
  }

  const guid = `{${randomUUID().toUpperCase()}}`;
  let slnText = '';
  let slnBom = false;
  let dependsOnGuids: string[] = [];
  if (sharedSln) {
    ({ text: slnText, bom: slnBom } = await readTextKeepingBom(sharedSln));
    const existing = parseSolutionProjects(slnText);
    const relPathCheck = `${opts.projectName}\\${opts.projectName}.rnrproj`.toLowerCase();
    if (existing.some(p => p.relPath.toLowerCase() === relPathCheck)) {
      throw new ScaffoldError(`${path.basename(sharedSln)} already lists ${relPathCheck}.`);
    }
    const missing: string[] = [];
    for (const dep of dependsOn) {
      const hits = findSolutionProjects(existing, dep);
      if (hits.length > 1) {
        throw new ScaffoldError(
          `dependsOn "${dep}" matches ${hits.length} projects of ${path.basename(sharedSln)}: ` +
          `${hits.map(h => h.name).join(', ')} — pass the exact name.`,
        );
      }
      if (hits.length) dependsOnGuids.push(hits[0].guid); else missing.push(dep);
    }
    if (missing.length) {
      throw new ScaffoldError(
        `dependsOn names project(s) not in ${path.basename(sharedSln)}: ${missing.join(', ')}. ` +
        `Solution has: ${existing.map(p => p.name).join(', ') || '(none)'}.`,
      );
    }
    dependsOnGuids = [...new Set(dependsOnGuids)];
  }

  const template = opts.template ?? await defaultProjectTemplate();
  let rnrproj: string;
  try {
    rnrproj = renderRnrprojFromTemplate(template.text, {
      modelName: opts.modelName, projectName: opts.projectName, projectGuid: guid,
    });
  } catch (e) {
    if (e instanceof ProjectTemplateError) throw new ScaffoldError(`cannot use the project template: ${e.message}`);
    throw e;
  }

  // ── Writes ────────────────────────────────────────────────────────────────
  const written: string[] = [];
  const createdDir = !(await exists(projectDir));
  const displayName = opts.displayName?.trim() || opts.projectName;
  const relPath = `${opts.projectName}\\${opts.projectName}.rnrproj`;
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await writeFileAtomic(projectPath, rnrproj);
    written.push(projectPath);

    let solutionPath: string | null = null;
    if (mode === 'shared' && sharedSln) {
      solutionPath = sharedSln;
      await withFileLock(sharedSln, async () => {
        // Re-read under the lock: two projects created back to back must both land.
        const fresh = await readTextKeepingBom(sharedSln!);
        const updated = addProjectToSolutionText(fresh.text, { displayName, relPath, guid, dependsOnGuids });
        await writeFileAtomic(sharedSln!, (fresh.bom || slnBom ? BOM : '') + updated);
      });
      written.push(sharedSln);
    } else if (mode === 'per-project') {
      solutionPath = path.join(projectDir, `${opts.projectName}.sln`);
      await writeFileAtomic(solutionPath, renderNewSolution({
        displayName, relPath: `${opts.projectName}.rnrproj`, guid,
      }));
      written.push(solutionPath);
    }

    return { projectPath, projectGuid: guid, solutionPath, solutionMode: mode, written, dependsOn, template };
  } catch (err) {
    // Undo this call's files; the shared .sln is written last, so it is untouched here.
    for (const f of written) {
      if (f !== sharedSln) await fs.rm(f, { force: true }).catch(() => {});
    }
    if (createdDir) await fs.rmdir(projectDir).catch(() => {});
    throw err;
  }
}

// ── Removal ──────────────────────────────────────────────────────────────────

const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();

/** Remove a project's block, configuration lines and dependency lines from solution text. Pure; null when not listed. */
export function removeProjectFromSolutionText(sln: string, relPath: string): { text: string; guid: string } | null {
  const entry = parseSolutionProjects(sln).find(p => norm(p.relPath) === norm(relPath));
  if (!entry) return null;
  const g = escapeRe(entry.guid);

  let out = sln.replace(
    new RegExp(`^Project\\("\\{[^}]+\\}"\\)\\s*=\\s*"[^"]*",\\s*"${escapeRe(entry.relPath)}",\\s*"${g}"[\\s\\S]*?^EndProject[ \\t]*\\r?\\n`, 'im'),
    '',
  );
  // Configuration, nesting and dependency lines naming it.
  out = out.replace(new RegExp(`^[ \\t]*${g}\\.[^\\r\\n]*\\r?\\n`, 'gim'), '');
  out = out.replace(new RegExp(`^[ \\t]*\\{[^}]+\\}[ \\t]*=[ \\t]*${g}[ \\t]*\\r?\\n`, 'gim'), '');
  out = out.replace(new RegExp(`^[ \\t]*${g}[ \\t]*=[ \\t]*\\{[^}]+\\}[ \\t]*\\r?\\n`, 'gim'), '');
  // Drop a dependency section left empty.
  out = out.replace(/^[ \t]*ProjectSection\(ProjectDependencies\)\s*=\s*postProject[ \t]*\r?\n[ \t]*EndProjectSection[ \t]*\r?\n/gim, '');
  return { text: out, guid: entry.guid };
}

export interface RemoveProjectResult {
  /** Solutions the project was taken out of. */
  solutions: string[];
  /** Files/folders removed from disk (only with removeFiles). */
  removed: string[];
  /** AOT elements the project listed that no other project of the model lists. */
  orphanedElements: string[];
}

/** Names a project folder may hold that are the project's own — safe to delete with it. */
function isOwnFile(name: string, projectName: string, isDir: boolean): boolean {
  const n = name.toLowerCase();
  const p = projectName.toLowerCase();
  if (isDir) return n === 'bin' || n === 'obj' || n === '.vs';
  return n === `${p}.rnrproj` || n === `${p}.rnrproj.vspscc` || n === `${p}.rnrproj.user`
    || n === `${p}.sln`;
}

/** `AxClass\Foo` includes of a project file — its element membership. */
export function elementIncludesOf(rnrprojXml: string): string[] {
  return [...rnrprojXml.matchAll(/<Content\s+Include="(Ax[A-Za-z]+\\[^"]+)"/g)].map(m => m[1]);
}

/** Solutions listing this project (shared: beside the folders; per-project: inside it). Being listed is what vouches for a path. */
export async function solutionsListingProject(projectPath: string): Promise<Array<{ sln: string; relPath: string }>> {
  const resolved = path.resolve(projectPath);
  const projectDir = path.dirname(resolved);
  const plan: Array<{ sln: string; relPath: string }> = [];
  for (const dir of [path.dirname(projectDir), projectDir]) {
    for (const e of await listDir(dir)) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.sln')) continue;
      const sln = path.join(dir, e.name);
      const rel = path.relative(dir, resolved).replace(/\//g, '\\');
      try {
        const { text } = await readTextKeepingBom(sln);
        if (removeProjectFromSolutionText(text, rel)) plan.push({ sln, relPath: rel });
      } catch { /* an unreadable solution vouches for nothing */ }
    }
  }
  return plan;
}

/** Other projects of the solution(s) listing this one, as absolute paths that exist. */
export async function solutionMateProjects(projectPath: string): Promise<string[]> {
  const self = path.resolve(projectPath).toLowerCase();
  const out = new Set<string>();
  for (const { sln } of await solutionsListingProject(projectPath)) {
    const { text } = await readTextKeepingBom(sln);
    for (const p of parseSolutionProjects(text)) {
      const abs = path.resolve(path.dirname(sln), p.relPath.replaceAll('\\', path.sep));
      if (abs.toLowerCase() !== self && (await exists(abs))) out.add(abs);
    }
  }
  return [...out];
}

/**
 * Take a project out of its solution(s); with removeFiles also delete its own files.
 * Model metadata is never touched. Validated before the first write.
 */
export async function removeProject(opts: {
  projectPath: string;
  removeFiles: boolean;
  /** Other projects of the model, to work out which elements the removal orphans. */
  otherProjectPaths?: string[];
}): Promise<RemoveProjectResult> {
  const projectPath = path.resolve(opts.projectPath);
  if (!projectPath.toLowerCase().endsWith('.rnrproj')) throw new ScaffoldError('projectPath must be a .rnrproj file.');
  if (!(await exists(projectPath))) throw new ScaffoldError(`${projectPath} does not exist.`);
  const projectDir = path.dirname(projectPath);
  const projectName = path.basename(projectPath, '.rnrproj');

  const plan = await solutionsListingProject(projectPath);

  // Foreign files in the folder: refuse before writing anything.
  const deletable: string[] = [];
  if (opts.removeFiles) {
    const foreign: string[] = [];
    for (const e of await listDir(projectDir)) {
      if (isOwnFile(e.name, projectName, e.isDirectory())) deletable.push(path.join(projectDir, e.name));
      else foreign.push(e.name + (e.isDirectory() ? '\\' : ''));
    }
    if (foreign.length) {
      throw new ScaffoldError(
        `${projectDir} holds files that are not the project's own: ${foreign.slice(0, 15).join(', ')}` +
        `${foreign.length > 15 ? ', …' : ''}. Nothing was changed. Move or delete them, or call without removeFiles ` +
        `to only unregister the project from its solution.`,
      );
    }
  }
  // Only a project a solution lists is real enough to unregister or delete; a path alone is not.
  if (!plan.length) {
    throw new ScaffoldError(
      `${projectName} is not listed in any solution next to it — nothing to unregister` +
      `${opts.removeFiles ? ', and its folder is not deleted on the strength of a path alone' : ''}.`,
    );
  }

  // What the removal leaves without a project.
  const mine = new Set(elementIncludesOf((await readTextKeepingBom(projectPath)).text).map(norm));
  for (const other of opts.otherProjectPaths ?? []) {
    if (path.resolve(other).toLowerCase() === projectPath.toLowerCase()) continue;
    try {
      for (const inc of elementIncludesOf((await readTextKeepingBom(other)).text)) mine.delete(norm(inc));
    } catch { /* an unreadable sibling cannot claim anything */ }
  }

  const solutions: string[] = [];
  for (const { sln, relPath } of plan) {
    await withFileLock(sln, async () => {
      const fresh = await readTextKeepingBom(sln);
      const res = removeProjectFromSolutionText(fresh.text, relPath);
      if (!res) return;
      await writeFileAtomic(sln, (fresh.bom ? BOM : '') + res.text);
    });
    solutions.push(sln);
  }

  const removed: string[] = [];
  if (opts.removeFiles) {
    for (const f of deletable) {
      await fs.rm(f, { recursive: true, force: true });
      removed.push(f);
    }
    await fs.rmdir(projectDir).catch(() => {});
  }
  return { solutions, removed, orphanedElements: [...mine].sort() };
}
