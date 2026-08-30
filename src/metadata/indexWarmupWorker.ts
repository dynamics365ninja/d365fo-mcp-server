/**
 * Index warm-up worker thread.
 *
 * Every measurement below is from the reference VM's production databases
 * (2.5 GB metadata / 1.19 M symbols, 630 MB labels / 1.42 M rows), each taken
 * cold and then repeated warm:
 *
 *   idx_symbols_name, covering scan   83 s cold  →  0.11 s warm
 *   idx_type_name, covering scan      33 s cold  →     (same shape)
 *   labels ⋈ label_files, one locale  31 s cold  →     (same shape)
 *
 * Those three are the whole of the latency the benchmark keeps re-measuring:
 * run d79f62a3 (2026-08-17) spent 189 s on one `search` batch, 174 s on the
 * session's first `labels(action="search")` and 33 s on a `get_object_info`
 * that its own report timed at 4.8 s — 87 % of a 23-minute run was tool time,
 * and the queries themselves are milliseconds once the pages are in the OS
 * cache. Nothing about the SQL is slow; the first reader of each index pays for
 * the whole file being cold.
 *
 * So pay it before the user does, on a thread that cannot block the event loop.
 * The OS page cache is process-wide, so warming it here warms it for the
 * server's own connections — the work does not have to happen on them.
 *
 * Spawned by warmIndexes(); posts one message per step and a final summary.
 */

import { parentPort, workerData } from 'node:worker_threads';
import Database from '../database/sqlite.js';

export interface WarmupStep {
  /** Reported back to the parent, and the name a slow step is blamed on. */
  name: string;
  /** Which database the step reads. */
  db: 'symbols' | 'labels';
  /**
   * A COUNT over an explicitly named index. `INDEXED BY` is not a hint here but
   * the point of the query: without it SQLite is free to answer the count off
   * whichever index is smallest, warming one nothing else reads.
   */
  sql: string;
}

export interface WarmupMessage {
  type: 'step' | 'done' | 'error';
  name?: string;
  ms?: number;
  rows?: number;
  totalMs?: number;
  error?: string;
}

/**
 * In descending order of what the benchmark actually waits on, because the
 * budget cuts from the end.
 *
 *  - idx_symbols_name backs the substring fallback in searchSymbols and every
 *    prefix lookup: 83 s for the first one on a cold cache.
 *  - the labels join is what `labels(action="search")` pays after FTS has
 *    already answered in 2 ms.
 *  - idx_type_name backs every type-filtered search and get_object_info.
 *  - the FTS steps pull the postings lists for tokens that appear in most
 *    English label texts, which is the part of the FTS b-tree a phrase search
 *    walks.
 */
export const WARMUP_STEPS: WarmupStep[] = [
  {
    name: 'symbols.idx_symbols_name',
    db: 'symbols',
    sql: `SELECT COUNT(*) AS n FROM symbols INDEXED BY idx_symbols_name WHERE name > ''`,
  },
  {
    name: 'labels join label_files',
    db: 'labels',
    sql: `SELECT COUNT(*) AS n FROM labels l JOIN label_files lf ON lf.id = l.file_path_id
          WHERE LOWER(l.language) = 'en-us'`,
  },
  {
    name: 'symbols.idx_type_name',
    db: 'symbols',
    sql: `SELECT COUNT(*) AS n FROM symbols INDEXED BY idx_type_name WHERE type > ''`,
  },
  {
    name: 'labels_fts',
    db: 'labels',
    sql: `SELECT COUNT(*) AS n FROM labels_fts WHERE labels_fts MATCH 'cannot OR value OR not'`,
  },
  {
    name: 'symbols_fts',
    db: 'symbols',
    sql: `SELECT COUNT(*) AS n FROM symbols_fts WHERE symbols_fts MATCH '"table"*'`,
  },
];

if (parentPort) {
  const { dbPath, labelsDbPath, budgetMs } = workerData as {
    dbPath: string;
    labelsDbPath: string;
    budgetMs: number;
  };

  const started = Date.now();
  const open = (p: string) => {
    const db = new Database(p, { readonly: true });
    db.pragma('busy_timeout = 5000');
    return db;
  };

  let symbols: ReturnType<typeof open> | null = null;
  let labels: ReturnType<typeof open> | null = null;

  try {
    for (const step of WARMUP_STEPS) {
      // The budget cuts whole steps, never a running one: a half-scanned index
      // is warm for the half it read, and the next session pays the rest.
      if (Date.now() - started >= budgetMs) break;
      try {
        if (step.db === 'symbols') symbols ??= open(dbPath);
        else labels ??= open(labelsDbPath);
        const db = step.db === 'symbols' ? symbols! : labels!;
        const t0 = Date.now();
        const row = db.prepare(step.sql).get() as { n?: number } | undefined;
        parentPort.postMessage({
          type: 'step', name: step.name, ms: Date.now() - t0, rows: row?.n ?? 0,
        } satisfies WarmupMessage);
      } catch (e) {
        // A missing table or index is normal on a partial database — warm what
        // exists and say which step could not run, rather than aborting.
        parentPort.postMessage({ type: 'error', name: step.name, error: String(e) } satisfies WarmupMessage);
      }
    }
    parentPort.postMessage({ type: 'done', totalMs: Date.now() - started } satisfies WarmupMessage);
  } finally {
    symbols?.close();
    labels?.close();
  }
}
