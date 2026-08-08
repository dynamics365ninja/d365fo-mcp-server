/**
 * Debounced Bridge Refresh Tests
 */

import { describe, it, expect, vi } from 'vitest';

// Must import AFTER vi.useFakeTimers so setTimeout is intercepted
vi.useFakeTimers();

import { refresh, flush, cancel } from '../../src/bridge/debouncedRefresh';

const makeBridge = (ready = true) => ({
  isReady: ready,
  metadataAvailable: ready,
  refreshProvider: vi.fn(async () => ({ success: true })),
}) as any;

describe('debouncedRefresh', () => {
  afterEach(() => {
    cancel(); // clean up any pending state between tests
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
});
