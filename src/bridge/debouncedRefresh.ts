/**
 * Coalesces multiple rapid refreshProvider() calls into a single call, so that
 * a burst of create/modify operations triggers only one DiskProvider refresh.
 *
 * Writers call refresh() and do NOT await it — a full DiskProvider rebuild
 * serialized into a create's response is seconds the caller pays for a provider
 * generation nothing may ever read. Anything that must resolve an object written
 * this session calls flush() first, which is free unless a rebuild is actually
 * outstanding. The guarantee "a write is visible to the next bridge operation"
 * therefore survives; only who pays for it moves.
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
  /** Newest request in this batch — the point the rebuild has to be no older than. */
  lastRequestTime: number;
  bridge: BridgeClient;
} | null = null;

/**
 * The rebuild currently running, if any.
 *
 * flush() must be able to wait for a refresh that already fired on its settle
 * timer, not just one still queued: a create schedules the refresh and returns,
 * and the modify that follows it 400 ms later would otherwise be told "nothing
 * pending" while the DiskProvider is mid-rebuild — the stale-provider state the
 * eager refresh existed to rule out.
 */
let inFlight: Promise<BridgeRefreshResult | null> | null = null;

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

/** Forget the recorded refresh time and any in-flight rebuild (test isolation). */
export function resetRefreshTracking(): void {
  lastRefreshStartedAt = 0;
  inFlight = null;
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

  const now = Date.now();

  if (pending) {
    // Reset the settle timer (but respect MAX_WAIT_MS)
    clearTimeout(pending.timer);
    pending.lastRequestTime = now;
    const elapsed = now - pending.firstRequestTime;
    const remaining = Math.max(0, MAX_WAIT_MS - elapsed);
    const delay = Math.min(SETTLE_MS, remaining);

    if (delay > 0) {
      pending.timer = startTimer(delay);
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
    timer: startTimer(SETTLE_MS),
    firstRequestTime: now,
    lastRequestTime: now,
    bridge,
  };

  return promise;
}

/**
 * The settle timer must not be the reason the process stays alive: callers no
 * longer await the refresh, so a create that returns right before shutdown would
 * otherwise hold the event loop open for the settle window to rebuild a provider
 * nobody will read. unref() is absent under some fake-timer implementations.
 */
function startTimer(delay: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(executeRefresh, delay);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

function executeRefresh(): void {
  if (!pending) return;
  const { resolve, bridge, lastRequestTime } = pending;
  pending = null;

  // A direct bridgeRefreshProvider() — update_symbol_index, the modify auto-retry —
  // may have rebuilt the provider after the newest request in this batch landed.
  // That rebuild has by definition already read everything the batch wrote, so
  // running ours would be a second full DiskProvider scan that can discover nothing.
  if (lastRefreshStartedAt > lastRequestTime) {
    resolve(null);
    return;
  }

  markRefreshStarted();
  // A throwing refreshProvider must not escape: flush() is awaited on the write
  // path now, so an exception here would turn a bridge hiccup into a failed
  // create/modify instead of a stale provider.
  const run: Promise<BridgeRefreshResult | null> = (async () => bridge.refreshProvider())()
    .catch(err => {
      console.error(`[debouncedRefresh] refreshProvider failed: ${err}`);
      return null;
    })
    .then(result => {
      if (inFlight === run) inFlight = null;
      resolve(result);
      return result;
    });
  inFlight = run;
}

/**
 * Wait until the provider is no older than this moment.
 *
 * Free when nothing is outstanding, which is the single-operation case: it must
 * not become the 400 ms settle window a naive `await refresh()` would impose.
 * When a write did schedule a rebuild, the caller that actually needs to resolve
 * the new object pays for it — instead of every writer paying on its way out.
 */
export function flush(): Promise<BridgeRefreshResult | null> {
  if (pending) {
    clearTimeout(pending.timer);
    const p = pending.promise;
    executeRefresh();
    return p;
  }
  return inFlight ?? Promise.resolve(null);
}

/** Cancel any pending refresh without executing it (test cleanup). */
export function cancel(): void {
  inFlight = null;
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.resolve(null);
  pending = null;
}
