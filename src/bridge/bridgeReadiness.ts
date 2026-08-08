/**
 * Bridge startup readiness gate.
 *
 * The MCP tool list goes live the moment the handshake completes, but the C#
 * bridge is spawned out-of-band (see `initializeBridge` in src/index.ts) and
 * needs a few seconds to bring up its metadata provider. Until then
 * `context.bridge` is undefined, so a bridge-backed tool called in that window
 * fell through every read path and reported a configuration problem — a
 * diagnostic dead end, because nothing is wrong and the identical call succeeds
 * seconds later (issue #826).
 *
 * The fix has two halves, both in this module:
 *  1. `awaitBridgeReady` — the dispatcher waits (bounded) for a startup that is
 *     still in flight, so the agent never observes the race. Trading a 3-second
 *     LLM round trip for a 2-second in-process wait is a straight win.
 *  2. `bridgeStartupState` / `describeBridgeStartup` — when the wait genuinely
 *     times out, the "not found" messages can say the bridge is still starting
 *     instead of telling the user to go fix a config that is fine.
 */

import { READY_TIMEOUT_MS } from './bridgeClient.js';

/**
 * Handle to the one-shot bridge startup attempt, attached to the server context.
 * `done` never rejects — a failed startup is a settled attempt with no bridge.
 */
export interface BridgeStartup {
  /** Resolves when the startup attempt has settled (bridge attached, or given up). */
  readonly done: Promise<void>;
  /** True once `done` has resolved. Lets callers classify without awaiting. */
  readonly settled: boolean;
}

/**
 * The readiness slice of XppServerContext. Structural rather than the concrete
 * context type so message helpers in src/utils can use it without importing the
 * whole server context (and so tests can pass a two-field stub).
 */
export interface BridgeReadinessSource {
  bridge?: { isReady?: boolean; metadataAvailable?: boolean };
  bridgeStartup?: BridgeStartup;
}

/**
 * Wrap the in-flight bridge startup so the dispatcher can both await it and ask
 * synchronously whether it has settled. Swallows rejections deliberately: the
 * caller's own error reporting owns the failure, this handle only tracks timing.
 */
export function trackBridgeStartup(attempt: Promise<unknown>): BridgeStartup {
  const handle = {
    settled: false,
    done: attempt.then(
      () => { handle.settled = true; },
      () => { handle.settled = true; },
    ),
  };
  return handle;
}

/**
 * Tools whose answers come from (or are materially improved by) the C# bridge.
 * These are gated on bridge readiness; everything else dispatches immediately.
 *
 * Membership tracks the tool implementations that reach `context.bridge` — see
 * tests/tools/bridgeReadinessGate.test.ts, which fails if a tool starts using
 * the bridge without being listed here.
 */
export const BRIDGE_BACKED_TOOLS = new Set([
  'search',
  'batch_get_info',
  'get_object_info',
  'get_method',
  'find_references',
  'extension_info',
  'security_info',
  'generate_object',
  'd365fo_file',
  'labels',
  'prepare',
  'analyze_code',
  'update_symbol_index',
  'undo_last_modification',
]);

/**
 * Outcome of waiting for the bridge before running a bridge-backed tool.
 *  - `ready`       the bridge is up; the tool gets live metadata
 *  - `unavailable` startup settled without a bridge (no D365FO install / bad config)
 *  - `timeout`     still starting after the bounded wait — a genuinely slow start
 *  - `not-tracked` nothing wired a startup attempt (HTTP pre-init, unit tests)
 */
export type BridgeWaitOutcome = 'ready' | 'unavailable' | 'timeout' | 'not-tracked';

/** Synchronous view of where the bridge startup stands right now. */
export type BridgeStartupState = 'ready' | 'starting' | 'unavailable';

/**
 * Classify the bridge without waiting. `starting` is the state that used to be
 * misreported as "not connected".
 */
export function bridgeStartupState(context: BridgeReadinessSource): BridgeStartupState {
  if (context.bridge?.isReady) return 'ready';
  // A startup attempt that has not settled is still in flight — the bridge may
  // yet appear. Once it has settled, a missing bridge is a real absence.
  if (context.bridgeStartup && !context.bridgeStartup.settled) return 'starting';
  return 'unavailable';
}

/**
 * Wait (bounded) for a bridge startup that is still in flight.
 *
 * Returns immediately when the bridge is already up, when the startup attempt
 * has already settled, or when no attempt is tracked at all — so the common
 * warm-server path costs nothing.
 */
export async function awaitBridgeReady(
  context: BridgeReadinessSource,
  timeoutMs: number = READY_TIMEOUT_MS,
): Promise<BridgeWaitOutcome> {
  if (context.bridge?.isReady) return 'ready';

  const startup = context.bridgeStartup;
  if (!startup) return 'not-tracked';
  if (startup.settled) return context.bridge?.isReady ? 'ready' : 'unavailable';

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    // Never hold the process open just for this watchdog.
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const raced = await Promise.race([startup.done.then(() => 'settled' as const), timeout]);
    if (raced === 'timeout') return 'timeout';
  } finally {
    if (timer) clearTimeout(timer);
  }
  return context.bridge?.isReady ? 'ready' : 'unavailable';
}

/**
 * The bridge half of a "not found" message, for tools that exhausted bridge,
 * symbol index and disk. Splits the two cases the old text conflated: a bridge
 * that is still coming up (retry — the config is fine) versus one that is
 * genuinely absent (check the config).
 *
 * Returns null when the bridge is up and healthy — the object really is missing,
 * and the caller owns that wording.
 */
export function describeBridgeStartup(context: BridgeReadinessSource): string | null {
  switch (bridgeStartupState(context)) {
    case 'starting':
      return (
        `The C# bridge is still starting — this is a cold-start race, NOT a configuration problem, ` +
        `and NOT evidence that the object does not exist. Retry the identical call in a few seconds.`
      );
    case 'unavailable':
      return (
        `The C# bridge is not connected. Ensure the bridge exe is built and D365FO metadata ` +
        `is accessible. Check .mcp.json → context.packagePath (and context.microsoftPackagesPath ` +
        `for UDE environments).`
      );
    default:
      return null;
  }
}
