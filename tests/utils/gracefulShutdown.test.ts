/**
 * Graceful shutdown coordinator.
 *
 * The server had no shutdown path at all: SIGINT/SIGTERM and a closed stdin
 * ended the process outright, so the C# bridge child was cut off wherever it
 * happened to be — including part-way through writing AOT XML — and the SQLite
 * handles were never closed.
 *
 * The properties worth pinning down are the ones that make shutdown safe to rely
 * on: it releases everything, it releases in the right order, a resource that
 * refuses to close cannot strand the others, and it always terminates.
 */

import { describe, it, expect, vi } from 'vitest';
import { createShutdownCoordinator } from '../../src/utils/gracefulShutdown.js';

function harness(deadlineMs = 5_000) {
  const logs: string[] = [];
  const exits: number[] = [];
  const coordinator = createShutdownCoordinator({
    deadlineMs,
    exit: (code) => { exits.push(code); },
    log: (m) => { logs.push(m); },
  });
  return { coordinator, logs, exits };
}

describe('shutdown coordinator', () => {
  it('runs every registered cleanup', async () => {
    const { coordinator } = harness();
    const bridge = vi.fn();
    const index = vi.fn();

    coordinator.onShutdown('symbol index', index);
    coordinator.onShutdown('C# bridge', bridge);
    await coordinator.shutdown('test');

    expect(bridge).toHaveBeenCalledOnce();
    expect(index).toHaveBeenCalledOnce();
  });

  it('releases last-registered first, so a resource goes before what it sits on', async () => {
    const { coordinator } = harness();
    const order: string[] = [];

    coordinator.onShutdown('log file', () => { order.push('log file'); });
    coordinator.onShutdown('symbol index', () => { order.push('symbol index'); });
    coordinator.onShutdown('C# bridge', () => { order.push('C# bridge'); });
    await coordinator.shutdown('test');

    expect(order).toEqual(['C# bridge', 'symbol index', 'log file']);
  });

  it('awaits async cleanups instead of racing past them', async () => {
    const { coordinator } = harness();
    const order: string[] = [];

    coordinator.onShutdown('http server', async () => {
      await new Promise(r => setTimeout(r, 20));
      order.push('http server');
    });
    coordinator.onShutdown('C# bridge', () => { order.push('C# bridge'); });
    await coordinator.shutdown('test');

    expect(order).toEqual(['C# bridge', 'http server']);
  });

  it('keeps going when one resource refuses to close, and says which', async () => {
    const { coordinator, logs } = harness();
    const after = vi.fn();

    coordinator.onShutdown('symbol index', after);
    coordinator.onShutdown('C# bridge', () => { throw new Error('pipe already gone'); });
    await coordinator.shutdown('test');

    expect(after).toHaveBeenCalledOnce();
    expect(logs.join('\n')).toContain('C# bridge failed to close: pipe already gone');
  });

  it('survives a cleanup that rejects, not just one that throws', async () => {
    const { coordinator, logs } = harness();
    const after = vi.fn();

    coordinator.onShutdown('symbol index', after);
    coordinator.onShutdown('http server', async () => { throw new Error('socket stuck'); });
    await coordinator.shutdown('test');

    expect(after).toHaveBeenCalledOnce();
    expect(logs.join('\n')).toContain('http server failed to close: socket stuck');
  });

  it('runs once even if several signals arrive together', async () => {
    const { coordinator, exits } = harness();
    const bridge = vi.fn();
    coordinator.onShutdown('C# bridge', bridge);

    await Promise.all([
      coordinator.shutdown('received SIGTERM', 143),
      coordinator.shutdown('received SIGINT', 130),
    ]);
    await coordinator.shutdown('stdin closed');

    expect(bridge).toHaveBeenCalledOnce();
    expect(exits).toEqual([143]);
  });

  it('exits with the code it was given', async () => {
    const { coordinator, exits } = harness();
    await coordinator.shutdown('received SIGTERM', 143);
    expect(exits).toEqual([143]);
  });

  it('exits anyway when a cleanup never finishes', async () => {
    vi.useFakeTimers();
    try {
      const { coordinator, exits, logs } = harness(1_000);
      coordinator.onShutdown('wedged bridge', () => new Promise<void>(() => { /* never resolves */ }));

      void coordinator.shutdown('received SIGTERM', 143);
      await vi.advanceTimersByTimeAsync(1_000);

      // A stop that does not stop is worse than an unclean one.
      expect(exits).toEqual([143]);
      expect(logs.join('\n')).toContain('still busy after 1000 ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports why it is shutting down', async () => {
    const { coordinator, logs } = harness();
    await coordinator.shutdown('stdin closed by the MCP client');

    expect(logs[0]).toBe('[shutdown] stdin closed by the MCP client — releasing resources');
    expect(logs.at(-1)).toBe('[shutdown] done');
  });

  it('exposes whether a shutdown is already under way', async () => {
    const { coordinator } = harness();
    expect(coordinator.isShuttingDown).toBe(false);
    await coordinator.shutdown('test');
    expect(coordinator.isShuttingDown).toBe(true);
  });
});
