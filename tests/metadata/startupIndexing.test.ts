/**
 * First-start metadata indexing runs off the main thread.
 *
 * Inline, the build blocked the event loop for its whole duration and every
 * tool call hung with it. The parent side has three jobs: settle once with the
 * worker's verdict, keep the worker's console output OFF the parent's stdout
 * (the MCP protocol channel in stdio mode), and stay off for `:memory:`.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { canIndexOffThread, indexMetadataOffThread } from '../../src/metadata/startupIndexing.js';

const fake = new URL('../fixtures/fakeStartupIndexWorker.mjs', import.meta.url);

function options(scenario: string, output: NodeJS.WritableStream): Parameters<typeof indexMetadataOffThread>[0] {
  return {
    dbPath: 'K:\\db\\symbols.db',
    labelsDbPath: 'K:\\db\\labels.db',
    // The fixture picks its outcome from this field (the only free-form one
    // the parent forwards).
    metadataPath: `scenario:${scenario}`,
    modelNames: ['ContosoCore'],
    workerUrl: fake,
    output,
  };
}

/** The fixture posts before it exits; give the pipe a tick to flush. */
const captured = (sink: PassThrough) =>
  new Promise<string>(resolve => setTimeout(() => resolve(sink.read()?.toString() ?? ''), 50));

describe('indexMetadataOffThread', () => {
  it('resolves with the worker result and routes its console output to the given stream', async () => {
    const sink = new PassThrough();
    const result = await indexMetadataOffThread(options('done', sink));
    expect(result).toEqual({ elapsedMs: 4200, symbolCount: 1234 });

    const out = await captured(sink);
    expect(out).toContain('[100%] ContosoCore indexing...');
    expect(out).toContain('worker stderr line');
  });

  it('rejects with the worker-reported error', async () => {
    await expect(indexMetadataOffThread(options('fail', new PassThrough())))
      .rejects.toThrow(/SQLITE_BUSY/);
  });

  it('rejects when the worker throws before posting', async () => {
    await expect(indexMetadataOffThread(options('crash', new PassThrough())))
      .rejects.toThrow(/blew up/);
  });

  it('rejects when the worker exits without a verdict', async () => {
    await expect(indexMetadataOffThread(options('exit', new PassThrough())))
      .rejects.toThrow(/exited with code 3/);
  });

  it('rejects, rather than hangs, when the worker file does not exist', async () => {
    const opts = options('done', new PassThrough());
    opts.workerUrl = new URL('../fixtures/thisWorkerDoesNotExist.mjs', import.meta.url);
    await expect(indexMetadataOffThread(opts)).rejects.toThrow();
  });
});

describe('canIndexOffThread', () => {
  it('is false for an in-memory database, which no second thread can open', () => {
    expect(canIndexOffThread(':memory:', 'K:\\labels.db')).toBe(false);
    expect(canIndexOffThread('K:\\symbols.db', ':memory:')).toBe(false);
    expect(canIndexOffThread('K:\\symbols.db', 'K:\\labels.db')).toBe(true);
  });
});
