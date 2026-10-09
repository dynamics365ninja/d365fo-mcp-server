/**
 * Where run records live and how they are read back.
 *
 * eval/benchmark/runs/<runId>.json, committed like the eval corpus: the report
 * is regenerated from them, never the other way round, and a record is never
 * rewritten — a bad run is deleted or annotated, not edited into a good one.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BENCHMARK_SCHEMA_VERSION, type BenchmarkRun } from './types.js';
import { loadJsonRecords } from '../utils/jsonRecords.js';

export interface BenchmarkPaths {
  root: string;
  prompts: string;
  runs: string;
  reports: string;
  credits: string;
}

export function benchmarkPaths(root: string): BenchmarkPaths {
  return {
    root,
    prompts: path.join(root, 'prompts'),
    runs: path.join(root, 'runs'),
    reports: path.join(root, 'reports'),
    credits: path.join(root, 'credits.json'),
  };
}

/** Windows-safe file-name fragment; keeps model ids readable (claude-sonnet-5-5). */
export function safeFragment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
}

export function buildRunId(ts: Date, promptId: string, host: string, model: string, mcp: boolean): string {
  const stamp = ts.toISOString().slice(0, 16).replace(':', '-'); // 2026-10-07T12-03
  const salt = randomBytes(3).toString('hex');
  return `${stamp}__${safeFragment(promptId)}__${safeFragment(host)}__${safeFragment(model)}__${mcp ? 'mcp' : 'plain'}__${salt}`;
}

export function isBenchmarkRun(x: unknown): x is BenchmarkRun {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    r.schemaVersion === BENCHMARK_SCHEMA_VERSION &&
    typeof r.runId === 'string' &&
    typeof r.timestamp === 'string' &&
    !Number.isNaN(Date.parse(r.timestamp)) &&
    typeof r.promptId === 'string' &&
    typeof r.host === 'string' &&
    typeof r.model === 'string' &&
    typeof r.mcp === 'boolean' &&
    typeof r.durationMs === 'number' &&
    typeof r.outputTokens === 'number' &&
    typeof r.outcome === 'string'
  );
}

export function writeRun(runsDir: string, run: BenchmarkRun): string {
  fs.mkdirSync(runsDir, { recursive: true });
  const file = path.join(runsDir, `${run.runId}.json`);
  if (fs.existsSync(file)) throw new Error(`Run record already exists: ${file}`);
  fs.writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * Replace an existing record — only for `benchmark rederive`, which rewrites
 * DERIVED fields from kept evidence and says so in the record's notes. A
 * measured number is never changed this way.
 */
export function rewriteRun(runsDir: string, run: BenchmarkRun): string {
  const file = path.join(runsDir, `${run.runId}.json`);
  if (!fs.existsSync(file)) throw new Error(`No record to rewrite: ${file}`);
  fs.writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  return file;
}

/** Every valid record, oldest first. Invalid files are skipped (same policy as the corpus loader) — `countRunFiles` says how many were there. */
export function loadRuns(runsDir: string): BenchmarkRun[] {
  return loadJsonRecords(runsDir, isBenchmarkRun).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function countRunFiles(runsDir: string): number {
  if (!fs.existsSync(runsDir)) return 0;
  return fs.readdirSync(runsDir).filter(f => f.endsWith('.json')).length;
}

export interface RunFilter {
  prompt?: string;
  host?: string;
  /** Case-insensitive substring of the model id. */
  model?: string;
  label?: string;
  /** ISO date or date-time; inclusive. */
  since?: string;
  /** ISO date (whole day included) or date-time; inclusive. */
  until?: string;
}

function parseBoundary(value: string, endOfDay: boolean): number {
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`Not a date: '${value}' (use YYYY-MM-DD or an ISO date-time)`);
  // A bare date means the whole day on the `until` side.
  return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? t + 24 * 3600 * 1000 - 1 : t;
}

export function filterRuns(runs: BenchmarkRun[], f: RunFilter): BenchmarkRun[] {
  const since = f.since ? parseBoundary(f.since, false) : null;
  const until = f.until ? parseBoundary(f.until, true) : null;
  const model = f.model?.toLowerCase();
  return runs.filter(r => {
    if (f.prompt && r.promptId !== f.prompt) return false;
    if (f.host && r.host !== f.host) return false;
    if (model && !r.model.toLowerCase().includes(model)) return false;
    if (f.label && r.label !== f.label) return false;
    const t = Date.parse(r.timestamp);
    if (since !== null && t < since) return false;
    if (until !== null && t > until) return false;
    return true;
  });
}

/** Commit time of HEAD, or null outside a git checkout. */
export function headCommitTime(repoRoot: string): Date | null {
  try {
    const s = execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
    return s ? new Date(Number(s) * 1000) : null;
  } catch {
    return null;
  }
}

/** Short commit of the server under test, or null outside a git checkout. */
export function serverGitSha(repoRoot: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim() || null;
  } catch {
    return null;
  }
}
