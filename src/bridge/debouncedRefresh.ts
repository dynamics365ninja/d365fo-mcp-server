/**
 * Coalesces multiple rapid refreshProvider() calls into a single call, so that
 * a burst of create/modify operations triggers only one DiskProvider refresh.
 */

import type { BridgeClient } from './bridgeClient.js';
import type { BridgeRefreshResult } from './bridgeClient.js';

const SETTLE_MS = 400;
const MAX_WAIT_MS = 2_000;

let pending: {
  promise: Promise<BridgeRefreshResult | null>;
  resolve: (v: BridgeRefreshResult | null) => void;
  timer: ReturnType<typeof setTimeout>;
  firstRequestTime: number;
  bridge: BridgeClient;
} | null = null;

/**
 * When the most recent provider refresh STARTED (epoch ms), across both this
 * module and the direct bridgeRefreshProvider() path.
 *
 * Start rather than completion, because only a refresh that began after a file
 * was written is guaranteed to have read it. Callers use this to skip a refresh
 * that would rediscover nothing: a create/modify already refreshes the provider
 * on its way out, so the update_symbol_index call that follows it was paying for
 * a second full DiskProvider rebuild that could not see anything new.
 */
let lastRefreshStartedAt = 0;

/** Epoch ms at which the last provider refresh started; 0 if none yet. */
export function getLastRefreshStartedAt(): number {
  return lastRefreshStartedAt;
}

/** Record that a refresh is starting now. Called by every refresh path. */
export function markRefreshStarted(at: number = Date.now()): void {
  if (at > lastRefreshStartedAt) lastRefreshStartedAt = at;
}

/** Forget the recorded refresh time (test isolation). */
export function resetRefreshTracking(): void {
  lastRefreshStartedAt = 0;
}

/**
 * Request a bridge refresh. If one is already pending, the settle timer
 * resets (up to MAX_WAIT_MS). All callers receive the same result.
 */
export function refresh(bridge: BridgeClient): Promise<BridgeRefreshResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) {
    return Promise.resolve(null);
  }

  // If there's already a pending refresh for a DIFFERENT bridge instance, flush it
  if (pending && pending.bridge !== bridge) {
    clearTimeout(pending.timer);
    executeRefresh();
  }

  if (pending) {
    // Reset the settle timer (but respect MAX_WAIT_MS)
    clearTimeout(pending.timer);
    const elapsed = Date.now() - pending.firstRequestTime;
    const remaining = Math.max(0, MAX_WAIT_MS - elapsed);
    const delay = Math.min(SETTLE_MS, remaining);

    if (delay > 0) {
      pending.timer = setTimeout(executeRefresh, delay);
    } else {
      // Max wait exceeded — fire immediately
      executeRefresh();
    }
    return pending.promise;
  }

  // First request — create a new pending entry
  let resolve!: (v: BridgeRefreshResult | null) => void;
  const promise = new Promise<BridgeRefreshResult | null>(r => { resolve = r; });

  pending = {
    promise,
    resolve,
    timer: setTimeout(executeRefresh, SETTLE_MS),
    firstRequestTime: Date.now(),
    bridge,
  };

  return promise;
}

function executeRefresh(): void {
  if (!pending) return;
  const { resolve, bridge } = pending;
  pending = null;

  markRefreshStarted();
  bridge.refreshProvider()
    .then(result => resolve(result))
    .catch(err => {
      console.error(`[debouncedRefresh] refreshProvider failed: ${err}`);
      resolve(null);
    });
}

/** Flush any pending refresh immediately (used in tests or shutdown). */
export function flush(): Promise<BridgeRefreshResult | null> {
  if (!pending) return Promise.resolve(null);
  clearTimeout(pending.timer);
  const p = pending.promise;
  executeRefresh();
  return p;
}

/** Cancel any pending refresh without executing it (test cleanup). */
export function cancel(): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.resolve(null);
  pending = null;
}
