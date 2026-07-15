/**
 * Symbol-counts worker thread.
 *
 * COUNT(*) / GROUP BY over the symbols table is a full index scan — on a
 * 2 GB production database with a cold OS file cache it takes 30-60+ seconds.
 * better-sqlite3 is synchronous, so running it on the main thread blocks the
 * event loop and the MCP server cannot answer tools/list or the first tool
 * call; the client (VS Code Copilot) times out after 60 s and kills the
 * server. Running the scan here, on a separate thread with its own read-only
 * connection, keeps the main thread free (WAL mode allows concurrent readers).
 *
 * Spawned by XppSymbolIndex.getSymbolCounts(); posts a single message:
 *   { ok: true, total, byType } | { ok: false, error }
 */

import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const { dbPath } = workerData as { dbPath: string };

try {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.pragma('busy_timeout = 5000');
    // One GROUP BY scan yields both the per-type breakdown and (summed) the
    // total — half the work of separate COUNT(*) + GROUP BY queries.
    const rows = db
      .prepare(`SELECT type, COUNT(*) as count FROM symbols GROUP BY type`)
      .all() as Array<{ type: string; count: number }>;
    const byType: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      byType[row.type] = row.count;
      total += row.count;
    }
    parentPort!.postMessage({ ok: true, total, byType });
  } finally {
    db.close();
  }
} catch (e) {
  parentPort!.postMessage({ ok: false, error: String(e) });
}
