/**
 * Re-derive what can be re-derived of a recorded run from its kept evidence —
 * eval/benchmark/artifacts/<runId>/ holds the cell's raw stream and the files
 * it wrote.
 *
 * Why: the derived numbers are only as good as the parser and the checks of
 * the day, and both have been wrong after the fact — a form check that did not
 * allow `<Pattern xmlns="">`, a build counter that took `ls … | grep xppc` for a
 * build. Re-running a cell costs minutes and credits and measures a different
 * run; re-deriving costs nothing and keeps the measurement.
 *
 * What is recomputed: the rework trace (from the stream), the answer checks
 * (from the stream's final answer), the file checks (from the kept files).
 * What is kept: the build and xppbp checks — they need the sandbox state, which
 * the restore removed — and every measured number (time, tokens, cost).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseStreamJson, summarizeRework } from './claudeCode.js';
import { evaluateChecks, evaluateFileChecks } from './prompts.js';
import type { BenchmarkRun, CheckResult, PromptSpec } from './types.js';

export interface Rederived {
  run: BenchmarkRun;
  /** What changed, for the console and the record's note. Empty = nothing to rewrite. */
  changes: string[];
}

/** Checks that come from the build oracle and cannot be recomputed without it. */
const KEPT_CHECK = /^(builds clean|written XML is well-formed|no new best-practice errors)/;

export function rederiveRun(run: BenchmarkRun, spec: PromptSpec | null, evidenceDir: string, now: Date = new Date()): Rederived {
  const changes: string[] = [];
  const streamFile = path.join(evidenceDir, 'stream.jsonl');
  if (!fs.existsSync(streamFile)) return { run, changes };
  const summary = parseStreamJson(fs.readFileSync(streamFile, 'utf8'));
  const next: BenchmarkRun = { ...run };

  const rework = summarizeRework(summary.rework);
  if (JSON.stringify(rework) !== JSON.stringify(run.rework)) {
    const was = run.rework;
    changes.push(
      `rework ${was ? `${was.toolErrors}/${was.buildFailures}/${was.buildAttempts}/${was.rewrites}` : 'none'} → ` +
        `${rework.toolErrors}/${rework.buildFailures}/${rework.buildAttempts}/${rework.rewrites} (tool errors/failed/attempted builds/rewrites)`,
    );
    next.rework = rework;
  }

  if (spec) {
    const answer = typeof summary.result?.result === 'string' ? summary.result.result : null;
    const answerChecks = evaluateChecks(spec, answer).checks;
    const files = (run.artifacts ?? []).map(rel => ({
      path: rel,
      read: () => {
        try { return fs.readFileSync(path.join(evidenceDir, ...rel.split('/')), 'utf8'); } catch { return null; }
      },
    }));
    const fileChecks = spec.workspace ? evaluateFileChecks(spec, files) : [];
    const kept = run.checks.filter(c => KEPT_CHECK.test(c.name));
    const checks: CheckResult[] = [...answerChecks, ...fileChecks, ...kept];
    const flipped = checks.filter(c => run.checks.find(o => o.name === c.name)?.passed !== c.passed).map(c => `${c.name} → ${c.passed ? 'pass' : 'fail'}`);
    const renamed = checks.length !== run.checks.length || checks.some(c => !run.checks.find(o => o.name === c.name));
    if (flipped.length > 0 || renamed) {
      changes.push(...(flipped.length ? flipped : ['check set updated to the current catalogue']));
      next.checks = checks;
      const s = checks.length ? checks.filter(c => c.passed).length / checks.length : null;
      next.score = s === null ? null : run.outcome === 'completed' ? s : 0;
    }
  }

  if (changes.length > 0) {
    const note = `re-derived ${now.toISOString().slice(0, 10)} from kept stream/artifacts: ${changes.join('; ')}`;
    next.notes = run.notes ? `${run.notes} · ${note}` : note;
  }
  return { run: next, changes };
}
