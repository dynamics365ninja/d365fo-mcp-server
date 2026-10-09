/**
 * The sandbox a workspace prompt writes into — and the reset that makes the
 * next cell start where this one did.
 *
 * A prompt that creates a table, a form and a batch job is only comparable
 * across cells when every cell starts from the same model. Without a reset the
 * second cell finds the first one's objects already there (the MCP server's
 * `search` even returns them, from the index entries the first cell's writes
 * upserted), and "with MCP was faster" means nothing. So the matrix:
 *
 *   1. snapshots the sandbox PACKAGE once (Descriptor, the model folder, bin —
 *      a sandbox is a few MB, a full copy is cheaper than being clever),
 *   2. after each cell diffs the package against the snapshot (that diff is
 *      what the file checks score, and what the record lists as artifacts),
 *      optionally builds it with xppc,
 *   3. restores it byte for byte and re-diffs to prove the restore,
 *   4. and has the caller re-sync the symbol index for every path that moved.
 *
 * The package must look like one (a Descriptor folder with a descriptor in it)
 * and be small: pointing --sandbox at ApplicationSuite, or at the
 * PackagesLocalDirectory root, is refused before anything is copied.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BuildResult } from './types.js';

/** A sandbox bigger than this is not a sandbox. fm-mcp is ~125 files. */
export const MAX_SANDBOX_FILES = 5000;

export interface SandboxInfo {
  /** The package folder: <packagesRoot>/<package>. */
  packageDir: string;
  packagesRoot: string;
  /** Package (= module) name, the folder name. */
  packageName: string;
  /** The model whose Ax* folders the prompts target; defaults to the package name. */
  model: string;
  modelDir: string;
}

export function relPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // A symlink is followed only when it points at a directory; the sandbox on
    // the VM has been a junction before (see the modify containment fix).
    if (entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(full).isDirectory())) walk(full, out);
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(full);
  }
  return out;
}

/** Validate --sandbox and derive the paths the run needs. Throws with the reason. */
export function describeSandbox(packageDir: string, model?: string): SandboxInfo {
  const dir = path.resolve(packageDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Sandbox ${dir} does not exist or is not a folder.`);
  const descriptorDir = path.join(dir, 'Descriptor');
  if (!fs.existsSync(descriptorDir) || !fs.readdirSync(descriptorDir).some(f => f.toLowerCase().endsWith('.xml'))) {
    throw new Error(`Sandbox ${dir} is not a D365FO package folder (no Descriptor/<Model>.xml). Pass the package, e.g. …\\PackagesLocalDirectory\\fm-mcp.`);
  }
  const files = walk(dir);
  if (files.length > MAX_SANDBOX_FILES) {
    throw new Error(`Sandbox ${dir} holds ${files.length} files (> ${MAX_SANDBOX_FILES}) — that is not a sandbox model. The benchmark restores the folder after every cell; point it at a throwaway package.`);
  }
  const packageName = path.basename(dir);
  const modelName = model ?? packageName;
  const modelDir = path.join(dir, modelName);
  if (!fs.existsSync(modelDir)) throw new Error(`Sandbox model folder ${modelDir} does not exist (--sandbox-model ${modelName}).`);
  return { packageDir: dir, packagesRoot: path.dirname(dir), packageName, model: modelName, modelDir };
}

export type Manifest = Map<string, string>;

function hashFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Relative path → content hash of every file in the folder. */
export function manifestOf(dir: string): Manifest {
  const m: Manifest = new Map();
  for (const f of walk(dir)) m.set(relPath(dir, f), hashFile(f));
  return m;
}

export interface Snapshot {
  /** The copy, outside the sandbox. */
  dir: string;
  manifest: Manifest;
  /** Every folder the package had, empty ones included — a restore must not prune those. */
  dirs: Set<string>;
}

function walkDirs(dir: string, root: string = dir, out: Set<string> = new Set()): Set<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(full).isDirectory())) {
      out.add(relPath(root, full));
      walkDirs(full, root, out);
    }
  }
  return out;
}

/** Copy the package to `snapshotDir` (which must not exist yet) and record what it held. */
export function snapshotSandbox(packageDir: string, snapshotDir: string): Snapshot {
  if (fs.existsSync(snapshotDir)) throw new Error(`Snapshot folder ${snapshotDir} already exists.`);
  fs.mkdirSync(path.dirname(snapshotDir), { recursive: true });
  fs.cpSync(packageDir, snapshotDir, { recursive: true, dereference: true });
  const manifest = manifestOf(packageDir);
  const copy = manifestOf(snapshotDir);
  for (const [rel, hash] of manifest) {
    if (copy.get(rel) !== hash) throw new Error(`Snapshot of ${packageDir} is incomplete: ${rel} did not copy intact.`);
  }
  return { dir: snapshotDir, manifest, dirs: walkDirs(packageDir) };
}

export interface SandboxDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

export function diffSandbox(packageDir: string, snapshot: Pick<Snapshot, 'manifest'>): SandboxDiff {
  const now = manifestOf(packageDir);
  const diff: SandboxDiff = { added: [], modified: [], deleted: [] };
  for (const [rel, hash] of now) {
    const before = snapshot.manifest.get(rel);
    if (before === undefined) diff.added.push(rel);
    else if (before !== hash) diff.modified.push(rel);
  }
  for (const rel of snapshot.manifest.keys()) if (!now.has(rel)) diff.deleted.push(rel);
  for (const list of [diff.added, diff.modified, diff.deleted]) list.sort();
  return diff;
}

export function isEmptyDiff(d: SandboxDiff): boolean {
  return d.added.length + d.modified.length + d.deleted.length === 0;
}

/**
 * Compiler and build-tool output: not something the agent wrote, so neither an
 * artifact nor something a file check may be satisfied by. Restored all the same.
 */
export function isBuildOutput(rel: string): boolean {
  const lower = rel.toLowerCase();
  const top = lower.split('/')[0];
  if (top === 'bin' || top === 'xppmetadata' || top === 'resources') return true;
  if (!lower.includes('/') && (/^buildmodelresult\./.test(lower) || lower.endsWith('.log'))) return true;
  return false;
}

/** What the agent changed: added and modified files, build output left out. */
export function authoredChanges(d: SandboxDiff): string[] {
  return [...d.added, ...d.modified].filter(rel => !isBuildOutput(rel)).sort();
}

function pruneEmptyDirs(root: string, rel: string, keep: Set<string>): void {
  let dir = path.dirname(path.join(root, rel));
  while (dir.length > root.length && dir.startsWith(root)) {
    if (keep.has(relPath(root, dir)) || fs.readdirSync(dir).length > 0) return;
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

/**
 * Put the package back exactly as the snapshot holds it, then prove it.
 * Throws when the re-diff is not empty — the matrix must stop there, because
 * every later cell would start from a different model.
 */
export function restoreSandbox(packageDir: string, snapshot: Snapshot, diff: SandboxDiff = diffSandbox(packageDir, snapshot)): void {
  const keepDirs = new Set<string>(snapshot.dirs);
  for (const rel of snapshot.manifest.keys()) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) keepDirs.add(parts.slice(0, i).join('/'));
  }
  for (const rel of diff.added) {
    fs.rmSync(path.join(packageDir, rel), { force: true });
    pruneEmptyDirs(packageDir, rel, keepDirs);
  }
  for (const rel of [...diff.modified, ...diff.deleted]) {
    const target = path.join(packageDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(snapshot.dir, rel), target);
  }
  const after = diffSandbox(packageDir, snapshot);
  if (!isEmptyDiff(after)) {
    const left = [...after.added, ...after.modified, ...after.deleted].slice(0, 5).join(', ');
    throw new Error(`Sandbox ${packageDir} could not be restored to its snapshot (${left}${after.added.length + after.modified.length + after.deleted.length > 5 ? ', …' : ''}). Stopping: later cells would not start from the same model. The snapshot is kept at ${snapshot.dir}.`);
  }
}

/**
 * Authored .xml files that do not parse. A file that is not XML at all builds
 * as "element not found" somewhere else, if it is noticed; named here it says
 * which tool wrote broken metadata.
 */
export async function malformedXml(packageDir: string, rels: string[]): Promise<string[]> {
  const { parseStringPromise } = await import('xml2js');
  const bad: string[] = [];
  for (const rel of rels.filter(r => r.toLowerCase().endsWith('.xml'))) {
    try {
      await parseStringPromise(fs.readFileSync(path.join(packageDir, ...rel.split('/')), 'utf8'));
    } catch {
      bad.push(rel);
    }
  }
  return bad;
}

/** One xppbp run over the module: its detail lines and its own totals. */
export interface BpRun {
  ran: boolean;
  /** `BestPractices Error|Warning: …` lines, trimmed. */
  lines: string[];
  errors: number;
  warnings: number;
  /** Why it did not run, when it did not. */
  problem?: string;
}

export function parseBpOutput(output: string): BpRun {
  const lines = output.split(/\r?\n/).map(l => l.trim()).filter(l => /^BestPractices\s+(Error|Warning)\s*:/.test(l));
  const errors = /^Errors:\s*(\d+)/m.exec(output);
  const warnings = /^Warnings:\s*(\d+)/m.exec(output);
  if (!errors && !warnings && lines.length === 0) return { ran: false, lines: [], errors: 0, warnings: 0, problem: output.trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 200) || 'no output' };
  return { ran: true, lines, errors: errors ? Number(errors[1]) : 0, warnings: warnings ? Number(warnings[1]) : 0 };
}

/**
 * Findings the cell introduced: detail lines the clean sandbox did not have.
 * Counted per severity off the lines, not off xppbp's totals, which include the
 * fixture's own findings.
 */
export function bpDelta(baseline: BpRun | null, run: BpRun): { errors: number; warnings: number; findings: string[] } {
  const known = new Set(baseline?.lines ?? []);
  const fresh = run.lines.filter(l => !known.has(l));
  const findings = fresh.map(l => {
    const m = /^BestPractices\s+(Error|Warning)\s*:\s*(\S+)\s+dynamics:\/\/([^:]+?)(?::\s*\[[^\]]*\])?:\s*(BP[A-Za-z0-9]+)/.exec(l);
    return m ? `${m[1]} ${m[4]} ${m[3]}` : l.slice(0, 160);
  });
  return {
    errors: fresh.filter(l => /^BestPractices\s+Error/.test(l)).length,
    warnings: fresh.filter(l => /^BestPractices\s+Warning/.test(l)).length,
    findings: findings.slice(0, 15),
  };
}

export type BpRunner = (sandbox: SandboxInfo, timeoutMs: number) => Promise<BpRun>;

/** xppbp over the whole sandbox module — the same flag style the server's run_bp_check tries first. */
export const bpCheckSandbox: BpRunner = (sandbox, timeoutMs) =>
  new Promise(resolve => {
    const root = sandbox.packagesRoot;
    const xppbp = path.join(root, 'bin', 'xppbp.exe');
    if (!fs.existsSync(xppbp)) {
      resolve({ ran: false, lines: [], errors: 0, warnings: 0, problem: `xppbp.exe not found at ${xppbp}` });
      return;
    }
    const child = spawn(xppbp, [
      `-metadata:${root}`,
      `-module:${sandbox.packageName}`,
      `-model:${sandbox.model}`,
      `-compilerMetadata:${root}`,
      `-packagesRoot:${root}`,
      '-all',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', err => { clearTimeout(timer); resolve({ ran: false, lines: [], errors: 0, warnings: 0, problem: `xppbp did not start: ${err.message}` }); });
    child.on('close', () => { clearTimeout(timer); resolve(parseBpOutput(out)); });
  });

/**
 * Compile the module's labels into its resources before the build and the BP
 * check: both resolve @File:Id against the compiled assembly, so a label the
 * cell just wrote would otherwise read as missing (BPErrorUnknownLabel). The
 * server's build tool does the same before it calls xppc.
 */
export async function compileSandboxLabels(sandbox: SandboxInfo): Promise<string | null> {
  try {
    const { compileModelLabels } = await import('../tools/write/compileLabels.js');
    const r = await compileModelLabels(sandbox.packagesRoot, sandbox.packagesRoot, sandbox.packageName, true);
    return r.success ? null : r.message;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Remove the server build tool's state file for this module (os.tmpdir()/d365build_state_*.json): it outlives the cell. */
export function clearBuildState(sandbox: SandboxInfo, tmpDir: string = os.tmpdir()): number {
  let removed = 0;
  for (const f of fs.readdirSync(tmpDir).filter(n => /^d365build_state_[0-9a-f]+\.json$/i.test(n))) {
    const file = path.join(tmpDir, f);
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { targetModel?: string };
      const target = String(state.targetModel ?? '').toLowerCase();
      if (target === sandbox.packageName.toLowerCase() || target === sandbox.model.toLowerCase()) {
        fs.rmSync(file, { force: true });
        removed++;
      }
    } catch { /* not ours, or being written — leave it */ }
  }
  return removed;
}

/** Lines of an xppc log that make a build fail — the same filter scripts/verify-goldens-build.ts uses. */
export function xppcErrorLines(log: string): string[] {
  return log
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => /^(Compile Error|Compile Fatal Error|Metadata Error|.*Validation Error)/.test(l));
}

export type BuildRunner = (sandbox: SandboxInfo, logFile: string, timeoutMs: number) => Promise<BuildResult>;

const BUILD_ERRORS_KEPT = 8;

/**
 * Full xppc build of the sandbox module (no -incremental: metadata validation
 * only runs on a full build). The compiler the MCP server's build tool wraps,
 * called directly so the verdict does not depend on the server under test.
 */
export const buildSandbox: BuildRunner = (sandbox, logFile, timeoutMs) =>
  new Promise(resolve => {
    const started = Date.now();
    const root = sandbox.packagesRoot;
    const xppc = path.join(root, 'bin', 'xppc.exe');
    const done = (ok: boolean, errors: string[]) =>
      resolve({ ok, errorCount: errors.length, errors: errors.slice(0, BUILD_ERRORS_KEPT).map(e => e.slice(0, 300)), durationMs: Date.now() - started });
    if (!fs.existsSync(xppc)) {
      done(false, [`xppc.exe not found at ${xppc} — the build check needs a D365FO development VM`]);
      return;
    }
    try { fs.unlinkSync(logFile); } catch { /* fresh log */ }
    const child = spawn(xppc, [
      `-metadata=${root}`,
      `-compilermetadata=${root}`,
      `-modelmodule=${sandbox.packageName}`,
      `-referenceFolder=${root}`,
      `-output=${path.join(sandbox.packageDir, 'bin')}`,
      `-log=${logFile}`,
      '-verbose',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', () => { /* the log file is the record */ });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', err => { clearTimeout(timer); done(false, [`xppc did not start: ${err.message}`]); });
    child.on('close', () => {
      clearTimeout(timer);
      let log = '';
      try { log = fs.readFileSync(logFile, 'utf8'); } catch { log = stdout; }
      // The exit code is not the verdict — the error lines are, as in
      // scripts/verify-goldens-build.ts; only an unfinished build is a failure by itself.
      const errors = xppcErrorLines(log);
      if (timedOut) errors.push(`xppc did not finish within ${Math.round(timeoutMs / 1000)} s`);
      done(errors.length === 0, errors);
    });
  });
