/**
 * Spawn the index warm-up worker and report what it cost.
 *
 * See indexWarmupWorker.ts for the measurements this exists for. The parent
 * side is deliberately thin: it decides whether to warm at all, and it never
 * waits — a warm-up that has not finished simply means the first query pays for
 * the part not yet read, which is the behaviour without it anyway.
 */

import { Worker } from 'node:worker_threads';
import type { WarmupMessage } from './indexWarmupWorker.js';

/** How long the whole warm-up may take before it stops starting new steps. */
const DEFAULT_BUDGET_MS = 10 * 60 * 1000;

export interface WarmupReport {
  steps: Array<{ name: string; ms: number; rows: number }>;
  failed: Array<{ name: string; error: string }>;
  totalMs: number;
}

export interface WarmupOptions {
  dbPath: string;
  labelsDbPath: string;
  budgetMs?: number;
  /** Injected in tests; the real one resolves next to the compiled worker. */
  workerUrl?: URL;
}

/**
 * Is warming worth doing at all?
 *
 * `:memory:` has nothing to warm, and INDEX_WARMUP=off is the escape hatch for
 * an environment where a second reader of the same file is not free (a slow
 * network share, a container with a hard IOPS cap).
 */
export function shouldWarmIndexes(dbPath: string, labelsDbPath: string): boolean {
  if ((process.env.INDEX_WARMUP ?? '').toLowerCase() === 'off') return false;
  return dbPath !== ':memory:' && labelsDbPath !== ':memory:';
}

/**
 * Run the warm-up in a worker thread. Resolves with what each step cost;
 * rejects only if the worker itself could not run.
 */
export function warmIndexes(opts: WarmupOptions): Promise<WarmupReport> {
  const budgetMs = opts.budgetMs ?? Number(process.env.INDEX_WARMUP_BUDGET_MS ?? DEFAULT_BUDGET_MS);
  const url = opts.workerUrl ?? new URL('./indexWarmupWorker.js', import.meta.url);

  return new Promise<WarmupReport>((resolve, reject) => {
    const report: WarmupReport = { steps: [], failed: [], totalMs: 0 };
    const worker = new Worker(url, {
      workerData: { dbPath: opts.dbPath, labelsDbPath: opts.labelsDbPath, budgetMs },
    });

    worker.on('message', (msg: WarmupMessage) => {
      if (msg.type === 'step') report.steps.push({ name: msg.name!, ms: msg.ms!, rows: msg.rows ?? 0 });
      else if (msg.type === 'error') report.failed.push({ name: msg.name!, error: msg.error! });
      else if (msg.type === 'done') {
        report.totalMs = msg.totalMs ?? 0;
        resolve(report);
        void worker.terminate();
      }
    });
    worker.once('error', reject);
    // A promise settles once — this covers "exited before the done message".
    worker.once('exit', code => reject(new Error(`warm-up worker exited with code ${code}`)));
  });
}

/** One line naming the two most expensive steps — the ones worth acting on. */
export function renderWarmupReport(report: WarmupReport): string {
  const slowest = [...report.steps]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 2)
    .map(s => `${s.name} ${(s.ms / 1000).toFixed(1)}s`)
    .join(', ');
  const failed = report.failed.length > 0 ? ` (${report.failed.length} step(s) skipped)` : '';
  return `Warmed indexes in ${(report.totalMs / 1000).toFixed(1)}s${slowest ? ` — slowest: ${slowest}` : ''}${failed}`;
}
