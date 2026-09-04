/**
 * Run the first-start metadata index in a worker thread and wait for it.
 *
 * See startupIndexWorker.ts for why. The parent side is thin: it spawns the
 * worker, routes its console output where the caller says (stderr in stdio
 * mode — stdout is the MCP protocol channel there), and settles once with the
 * worker's result. It still WAITS: the caller holds dbReady until the index is
 * populated, so tools that need symbols keep getting the "still loading"
 * answer instead of silently empty results — the difference is that the event
 * loop is free meanwhile, so the tools that need no symbols answer at once.
 */

import { Worker } from 'node:worker_threads';
import type { StartupIndexMessage, StartupIndexWorkerData } from './startupIndexWorker.js';

export interface StartupIndexOptions extends StartupIndexWorkerData {
  /** Injected in tests; the real one resolves next to the compiled worker. */
  workerUrl?: URL;
  /** Where the worker's stdout/stderr go. Defaults to the parent's stderr. */
  output?: NodeJS.WritableStream;
  /**
   * Heap cap for the worker. A worker's default old-generation limit is derived
   * from the parent's, which is sized for serving, not for indexing.
   */
  maxOldGenerationSizeMb?: number;
}

export interface StartupIndexResult {
  elapsedMs: number;
  symbolCount: number;
}

/** In-memory databases cannot be shared with a worker — the caller indexes inline. */
export function canIndexOffThread(dbPath: string, labelsDbPath: string): boolean {
  return dbPath !== ':memory:' && labelsDbPath !== ':memory:';
}

export function indexMetadataOffThread(opts: StartupIndexOptions): Promise<StartupIndexResult> {
  const url = opts.workerUrl ?? new URL('./startupIndexWorker.js', import.meta.url);
  const output = opts.output ?? process.stderr;
  const workerData: StartupIndexWorkerData = {
    dbPath: opts.dbPath,
    labelsDbPath: opts.labelsDbPath,
    metadataPath: opts.metadataPath,
    modelNames: opts.modelNames,
  };

  return new Promise<StartupIndexResult>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    let worker: Worker;
    try {
      worker = new Worker(url, {
        workerData,
        // Own the streams: with the defaults a worker's stdout is piped straight
        // into the parent's stdout, which in stdio mode is the protocol channel.
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: opts.maxOldGenerationSizeMb ?? 4096 },
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    worker.stdout.pipe(output, { end: false });
    worker.stderr.pipe(output, { end: false });

    worker.on('message', (msg: StartupIndexMessage) => {
      if (msg.type === 'done') {
        settle(() => resolve({ elapsedMs: msg.elapsedMs, symbolCount: msg.symbolCount }));
        void worker.terminate();
      } else if (msg.type === 'error') {
        settle(() => reject(new Error(msg.error)));
        void worker.terminate();
      }
    });
    worker.once('error', e => settle(() => reject(e)));
    // A promise settles once — this covers "exited before the done message".
    worker.once('exit', code => settle(() => reject(new Error(`startup index worker exited with code ${code}`))));
  });
}
