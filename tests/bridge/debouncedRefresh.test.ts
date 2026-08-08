/**
 * Debounced Bridge Refresh Tests
 */

import { describe, it, expect, vi } from 'vitest';

// Must import AFTER vi.useFakeTimers so setTimeout is intercepted
vi.useFakeTimers();

import {
  refresh, flush, cancel, resetRefreshTracking, markRefreshStarted, getLastRefreshStartedAt,
} from '../../src/bridge/debouncedRefresh';

const makeBridge = (ready = true) => ({
  isReady: ready,
  metadataAvailable: ready,
  refreshProvider: vi.fn(async () => ({ success: true })),
}) as any;

describe('debouncedRefresh', () => {
  afterEach(() => {
    cancel(); // clean up any pending state between tests
    // The fake clock restarts at the same instant for every test, so a refresh
    // recorded by the previous one sits in this one's future and would look like
    // an already-satisfied rebuild to the redundancy check in executeRefresh().
    resetRefreshTracking();
    vi.clearAllTimers();
  });

  it('delays refresh by settle window', async () => {
    const bridge = makeBridge();
    const p = refresh(bridge);

    // Not called immediately
    expect(bridge.refreshProvider).not.toHaveBeenCalled();

    // Advance past settle window
    await vi.advanceTimersByTimeAsync(500);

    const result = await p;
    expect(bridge.refreshProvider).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true });
  });

  it('coalesces multiple rapid calls into one refresh', async () => {
    const bridge = makeBridge();

    const p1 = refresh(bridge);
    const p2 = refresh(bridge);
    const p3 = refresh(bridge);

    // Still not called — settle timer keeps resetting
    expect(bridge.refreshProvider).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(bridge.refreshProvider).toHaveBeenCalledTimes(1);
    // All callers get the same result
    expect(r1).toEqual({ success: true });
    expect(r2).toEqual({ success: true });
    expect(r3).toEqual({ success: true });
  });

  it('returns null for unavailable bridge', async () => {
    const bridge = makeBridge(false);
    const result = await refresh(bridge);
    expect(result).toBeNull();
    expect(bridge.refreshProvider).not.toHaveBeenCalled();
  });

  it('flush executes pending refresh immediately', async () => {
    const bridge = makeBridge();
    refresh(bridge);

    expect(bridge.refreshProvider).not.toHaveBeenCalled();

    const result = await flush();
    expect(bridge.refreshProvider).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true });
  });

  it('cancel discards pending refresh', async () => {
    const bridge = makeBridge();
    const p = refresh(bridge);
    cancel();

    const result = await p;
    expect(result).toBeNull();
    expect(bridge.refreshProvider).not.toHaveBeenCalled();
  });

  it('respects max wait time', async () => {
    const bridge = makeBridge();

    // First call at t=0
    refresh(bridge);

    // Simulate repeated calls every 300ms — exceeds max wait of 2s
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(300);
      refresh(bridge);
    }

    // At t=2400ms, max wait (2s) was exceeded — first batch already fired
    expect(bridge.refreshProvider).toHaveBeenCalled();

    // Flush remaining to clean up
    await flush();
  });

  it('flush waits for a rebuild that already fired on its timer', async () => {
    // The writer no longer awaits the refresh, so by the time a modify calls
    // flush() the settle timer may already have started the rebuild. Returning
    // "nothing pending" there would hand the modify a half-rebuilt provider —
    // exactly the stale-provider state the eager refresh existed to rule out.
    let release!: () => void;
    const bridge = makeBridge();
    bridge.refreshProvider = vi.fn(
      () => new Promise(res => { release = () => res({ success: true }); }),
    );

    refresh(bridge);
    await vi.advanceTimersByTimeAsync(500);
    expect(bridge.refreshProvider).toHaveBeenCalledTimes(1);

    let settled = false;
    const waited = flush().then(r => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    release();
    expect(await waited).toEqual({ success: true });
    expect(bridge.refreshProvider).toHaveBeenCalledTimes(1);
  });

  it('drops a queued rebuild that a direct refresh has already performed', async () => {
    // update_symbol_index and the modify auto-retry call bridgeRefreshProvider()
    // straight through. Once that rebuild has started, the queued one can no
    // longer discover anything — running it is a second full DiskProvider scan.
    const bridge = makeBridge();
    refresh(bridge);

    await vi.advanceTimersByTimeAsync(50);
    markRefreshStarted(); // stands in for a direct bridgeRefreshProvider()
    expect(getLastRefreshStartedAt()).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(500);
    expect(bridge.refreshProvider).not.toHaveBeenCalled();
  });

  it('still rebuilds when the write landed after the last refresh started', async () => {
    // The mirror of the case above: the skip must key off WHEN the refresh was
    // requested, or a write made during someone else's rebuild is never picked up.
    const bridge = makeBridge();

    markRefreshStarted();
    await vi.advanceTimersByTimeAsync(50);
    refresh(bridge);

    await vi.advanceTimersByTimeAsync(500);
    expect(bridge.refreshProvider).toHaveBeenCalledTimes(1);
  });
});
