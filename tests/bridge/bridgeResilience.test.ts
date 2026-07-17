/**
 * Bridge resilience tests — read-only retry, write protection, restart cap.
 *
 * The real D365MetadataBridge.exe only runs on a Windows D365FO VM, so these
 * tests stub the single-shot transport (callOnce) and the spawn path
 * (spawnAndWaitReady) and verify the resilience logic around them.
 */

import { describe, it, expect, vi } from 'vitest';
import { BridgeClient } from '../../src/bridge/bridgeClient';

function makeClient(opts: { maxRetries?: number; maxRestarts?: number } = {}): BridgeClient {
  const client = new BridgeClient({
    packagesPath: 'C:\\NonExistent',
    maxRetries: opts.maxRetries ?? 2,
    maxRestarts: opts.maxRestarts ?? 3,
  });
  // Pretend the child is up — transport is stubbed per-test.
  (client as any)._isReady = true;
  return client;
}

const timeoutError = () => new Error(`Bridge call 'readTable' timed out after 60000ms`);
const bridgeError = () => new Error('Bridge error [INVALID_ARG]: tableName is required');

describe('read retry', () => {
  it('retries a read call after a transient failure and returns the result', async () => {
    const client = makeClient();
    const callOnce = vi.fn()
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce({ name: 'CustTable' });
    (client as any).callOnce = callOnce;
    (client as any).ensureHealthy = vi.fn().mockResolvedValue(undefined);

    const result = await client.call('readTable', { tableName: 'CustTable' });
    expect(result).toEqual({ name: 'CustTable' });
    expect(callOnce).toHaveBeenCalledTimes(2);
    expect((client as any).ensureHealthy).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries and surfaces the last error', async () => {
    const client = makeClient({ maxRetries: 2 });
    const callOnce = vi.fn().mockRejectedValue(timeoutError());
    (client as any).callOnce = callOnce;
    (client as any).ensureHealthy = vi.fn().mockResolvedValue(undefined);

    await expect(client.call('readTable', { tableName: 'CustTable' })).rejects.toThrow('timed out');
    expect(callOnce).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does NOT retry deterministic bridge errors', async () => {
    const client = makeClient();
    const callOnce = vi.fn().mockRejectedValue(bridgeError());
    (client as any).callOnce = callOnce;

    await expect(client.call('readTable', {})).rejects.toThrow('INVALID_ARG');
    expect(callOnce).toHaveBeenCalledTimes(1);
  });

  it('respects maxRetries=0 (retry disabled)', async () => {
    const client = makeClient({ maxRetries: 0 });
    const callOnce = vi.fn().mockRejectedValue(timeoutError());
    (client as any).callOnce = callOnce;

    await expect(client.call('readTable', {})).rejects.toThrow('timed out');
    expect(callOnce).toHaveBeenCalledTimes(1);
  });
});

describe('write protection', () => {
  it.each(['createObject', 'addMethod', 'setProperty', 'batchModify', 'refreshProvider'])(
    'never retries write method %s on timeout',
    async (method) => {
      const client = makeClient();
      const callOnce = vi.fn().mockRejectedValue(new Error(`Bridge call '${method}' timed out after 60000ms`));
      (client as any).callOnce = callOnce;
      const ensureHealthy = vi.fn();
      (client as any).ensureHealthy = ensureHealthy;

      await expect(client.call(method, {})).rejects.toThrow('timed out');
      expect(callOnce).toHaveBeenCalledTimes(1);
      expect(ensureHealthy).not.toHaveBeenCalled();
    },
  );
});

describe('ensureHealthy', () => {
  it('pings a live child and skips restart when the ping succeeds', async () => {
    const client = makeClient();
    (client as any).process = { exitCode: null };
    (client as any).callOnce = vi.fn().mockResolvedValue('pong');
    const restart = vi.fn();
    (client as any).restart = restart;

    await (client as any).ensureHealthy();
    expect(restart).not.toHaveBeenCalled();
  });

  it('restarts when the child is dead', async () => {
    const client = makeClient();
    (client as any).process = null; // dead
    const restart = vi.fn().mockResolvedValue(undefined);
    (client as any).restart = restart;

    await (client as any).ensureHealthy();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('restarts when the child is alive but the ping times out', async () => {
    const client = makeClient();
    (client as any).process = { exitCode: null };
    (client as any).callOnce = vi.fn().mockRejectedValue(timeoutError());
    const restart = vi.fn().mockResolvedValue(undefined);
    (client as any).restart = restart;

    await (client as any).ensureHealthy();
    expect(restart).toHaveBeenCalledTimes(1);
  });
});

describe('restart', () => {
  it('caps respawns within the 60s window and reports the bridge log', async () => {
    const client = makeClient({ maxRestarts: 3 });
    (client as any).spawnAndWaitReady = vi.fn().mockImplementation(async () => {
      (client as any)._isReady = true;
      (client as any).readyPayload = { metadataAvailable: true, xrefAvailable: false };
    });
    (client as any).killChild = vi.fn();

    await client.restart();
    await client.restart();
    await client.restart();
    await expect(client.restart()).rejects.toThrow(/giving up.*D365FO_BRIDGE_LOG_FILE/s);
  });

  it('shares a single in-flight restart between concurrent callers', async () => {
    const client = makeClient();
    let resolveSpawn!: () => void;
    const spawnAndWaitReady = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveSpawn = () => {
          (client as any)._isReady = true;
          (client as any).readyPayload = { metadataAvailable: true, xrefAvailable: false };
          resolve();
        };
      }),
    );
    (client as any).spawnAndWaitReady = spawnAndWaitReady;
    (client as any).killChild = vi.fn();

    const p1 = client.restart();
    const p2 = client.restart();
    resolveSpawn();
    await Promise.all([p1, p2]);
    expect(spawnAndWaitReady).toHaveBeenCalledTimes(1);
  });

  it('refuses to restart a disposed client', async () => {
    const client = makeClient();
    (client as any)._isReady = false;
    client.dispose();
    await expect(client.restart()).rejects.toThrow('disposed');
  });
});
