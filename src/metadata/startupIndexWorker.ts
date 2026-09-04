/**
 * First-start metadata indexing, off the main thread.
 *
 * When the server starts with an empty symbol database and METADATA_PATH set,
 * it indexes the requested models before it declares itself ready. That build
 * is synchronous end to end — a recursive readdirSync per model, node:sqlite
 * inserts, one FTS rebuild — and inline on the main thread it blocked the
 * event loop for the whole duration: every tool call, get_workspace_info
 * included, hung until the build finished, on exactly the machine where the
 * user was trying the server for the first time.
 *
 * Here the same XppSymbolIndex.indexMetadataDirectory runs on its own
 * connection. WAL mode lets the main thread keep serving from the same file —
 * the startup path never takes the EXCLUSIVE lock the build scripts use, so
 * the two connections coexist — and the main thread sees each model as its
 * transaction commits.
 *
 * Spawned by indexMetadataOffThread() (startupIndexing.ts) and posts:
 *   { type: 'done', elapsedMs, symbolCount } | { type: 'error', error }
 *
 * Bundled by build:scripts beside the other workers (tests/packaging/workerBundles).
 */

import { parentPort, workerData } from 'node:worker_threads';
import { XppSymbolIndex } from './symbolIndex.js';

export interface StartupIndexWorkerData {
  dbPath: string;
  labelsDbPath: string;
  metadataPath: string;
  modelNames: string[];
}

export type StartupIndexMessage =
  | { type: 'done'; elapsedMs: number; symbolCount: number }
  | { type: 'error'; error: string };

const data = workerData as StartupIndexWorkerData;

async function run(): Promise<void> {
  const started = Date.now();
  // backgroundIndexBuilds: false — this thread IS the background; nesting a
  // second worker per file-path index buys nothing and complicates shutdown.
  const index = new XppSymbolIndex(data.dbPath, data.labelsDbPath, { backgroundIndexBuilds: false });
  try {
    await index.indexMetadataDirectory(data.metadataPath, data.modelNames);
    const symbolCount = index.getSymbolCount();
    parentPort!.postMessage({ type: 'done', elapsedMs: Date.now() - started, symbolCount } satisfies StartupIndexMessage);
  } finally {
    index.close();
  }
}

run().catch(e => {
  parentPort!.postMessage({ type: 'error', error: String(e?.stack ?? e) } satisfies StartupIndexMessage);
});
