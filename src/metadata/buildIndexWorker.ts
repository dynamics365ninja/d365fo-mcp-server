/**
 * Index-build worker thread.
 *
 * CREATE INDEX over an already-populated table is a full table read plus a
 * B-tree write — ~8 s on the 2 GB production symbol DB. node:sqlite is
 * synchronous, so running that on the main thread blocks the event loop for its
 * whole duration and the MCP client (VS Code Copilot) can time the server out
 * before it answers its first request. Running it here, on its own connection,
 * keeps the main thread serving; WAL mode lets this write proceed alongside the
 * main thread's readers.
 *
 * Spawned by XppSymbolIndex.ensureFilePathIndexes() and posts a single message:
 *   { ok: true, elapsedMs } | { ok: false, error }
 *
 * The connection is NOT read-only (unlike symbolCountsWorker) — this one writes.
 */

import { parentPort, workerData } from 'node:worker_threads';
import Database from '../database/sqlite.js';

const { dbPath, sql } = workerData as { dbPath: string; sql: string; indexName: string };

try {
  const db = new Database(dbPath);
  try {
    // A WAL checkpoint racing with a main-thread reader returns SQLITE_BUSY
    // immediately without this; the build is background work, so it can afford
    // to wait far longer than the 5 s used elsewhere.
    db.pragma('busy_timeout = 120000');
    const started = Date.now();
    db.exec(sql);
    parentPort!.postMessage({ ok: true, elapsedMs: Date.now() - started });
  } finally {
    db.close();
  }
} catch (e) {
  parentPort!.postMessage({ ok: false, error: String(e) });
}
