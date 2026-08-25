/**
 * The loop-lag monitor has to actually fire, or it is worse than nothing: a
 * silent instrument reads as "the loop was fine" when it may only mean the
 * probe was never running.
 *
 * It was added because the audit could measure the SYMPTOM — a first `labels`
 * call taking 1.3 s while the query inside it takes 6–11 ms, and the tool's own
 * phase timer reporting 0.0 s — but not the cause, and a warm-cache run on the
 * dev VM would not reproduce the blocking at all. So these tests block the loop
 * on purpose and assert the monitor says so.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  startLoopLagMonitor,
  stopLoopLagMonitor,
  getLoopLagStats,
  resetLoopLagStats,
} from '../../src/utils/loopLag.js';

/** Block the event loop for real — no timers, no await, just spin. */
function blockLoopFor(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Busy-wait: this is the thing the monitor exists to notice.
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

afterEach(() => {
  stopLoopLagMonitor();
  resetLoopLagStats();
  delete process.env.DEBUG_LOGGING;
  vi.restoreAllMocks();
});

describe('event-loop lag monitor', () => {
  it('stays silent unless DEBUG_LOGGING is on — it is a diagnostic, not a default cost', async () => {
    delete process.env.DEBUG_LOGGING;
    startLoopLagMonitor();
    blockLoopFor(400);
    await sleep(250);
    expect(getLoopLagStats().stallCount).toBe(0);
  });

  it('reports a stall that really happened, with a plausible duration', async () => {
    process.env.DEBUG_LOGGING = 'true';
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    startLoopLagMonitor();
    await sleep(150);          // let the probe take at least one clean sample
    blockLoopFor(500);         // the stall
    await sleep(250);          // let it be noticed and reported

    const stats = getLoopLagStats();
    expect(stats.stallCount).toBeGreaterThan(0);
    // The tick that spanned the block cannot report less than the block itself,
    // and should not report wildly more.
    expect(stats.worstLagMs).toBeGreaterThanOrEqual(300);
    expect(stats.worstLagMs).toBeLessThan(2000);

    const lines = stderr.mock.calls.map(c => String(c[0]));
    expect(lines.some(l => l.includes('[loopLag]') && l.includes('event loop blocked'))).toBe(true);
  });

  it('ignores ordinary timer jitter, so the log stays readable', async () => {
    process.env.DEBUG_LOGGING = 'true';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    startLoopLagMonitor();
    // No deliberate block: Windows timers run ~15 ms late by default and a GC
    // pause adds more. None of that is a stall worth a line.
    await sleep(600);
    expect(getLoopLagStats().stallCount).toBe(0);
  });

  it('does not start twice, and stops cleanly when never started', () => {
    process.env.DEBUG_LOGGING = 'true';
    startLoopLagMonitor();
    startLoopLagMonitor();
    stopLoopLagMonitor();
    expect(() => stopLoopLagMonitor()).not.toThrow();
  });
});
