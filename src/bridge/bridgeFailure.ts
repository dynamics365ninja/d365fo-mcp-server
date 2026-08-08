/**
 * The bridge error contract.
 *
 * `bridgeAdapter.ts` used to answer every thrown bridge call with a bare `null` —
 * the same value it returns for "the bridge has no such object". The calling tool
 * could not tell the two apart, so a bridge that was throwing looked exactly like
 * an empty metadata model: the tool fell through to the SQLite symbol index and
 * reported the stale answer as if the bridge had agreed with it. That is the shape
 * behind the "could not resolve" reports, the security-artifact empty write, and
 * the table-extension field drop.
 *
 * Two mechanisms, deliberately:
 *
 *  1. `BridgeFailure` / `BridgeAttempt<T>` — a value distinct from `null`, returned
 *     by the wrappers whose caller must CHANGE WHAT IT DOES on a failure (today the
 *     create/resolve path, which otherwise falls back to XML generation and answers
 *     ✅ without mentioning that the bridge never ran). `null` keeps meaning "not
 *     found" everywhere, so a wrapper that has not been converted is still correct.
 *
 *  2. The ambient failure log — every swallowed catch in the adapter records here,
 *     and `toolHandler` turns anything recorded during a tool call into a visible
 *     "bridge errored" line on the response. This is what makes the ~28 read
 *     wrappers honest without touching their `ToolResult | null` signature or any
 *     of their call sites: the tool still serves the index fallback, but the answer
 *     now says where it came from and why.
 *
 * The log is AsyncLocalStorage-scoped (same mechanism ConfigManager uses for
 * per-request context) because tool calls run concurrently — a module-level array
 * would attribute one call's bridge outage to another call's response.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { debugLog } from '../utils/logger.js';

/**
 * A bridge call that threw. Distinct from `null`, which continues to mean "the
 * bridge answered, and the object is not there".
 */
export interface BridgeFailure {
  readonly bridgeFailed: true;
  /** The bridge call that failed, with its arguments, e.g. `readTable(CustTable)`. */
  readonly operation: string;
  /** The thrown error, stringified. */
  readonly reason: string;
}

/**
 * What a bridge wrapper can answer: the data, `null` for "not found / bridge not
 * in play", or a `BridgeFailure`. Callers must discriminate with `isBridgeFailure`
 * BEFORE the usual truthiness check — a failure is truthy.
 */
export type BridgeAttempt<T> = T | BridgeFailure | null;

export function isBridgeFailure(value: unknown): value is BridgeFailure {
  return typeof value === 'object' && value !== null && (value as BridgeFailure).bridgeFailed === true;
}

/** Marker the dispatcher looks for so a tool that already reported the failure isn't annotated twice. */
export const BRIDGE_FAILURE_MARKER = 'bridge errored:';

const failureScope = new AsyncLocalStorage<BridgeFailure[]>();

/**
 * Run `fn` with a collector attached, so every bridge failure inside it lands in
 * `sink`. `sink` is passed in rather than returned so failures recorded before an
 * exception — or by fire-and-forget work like `bridgeValidateAfterWrite` — are
 * still visible to the caller.
 */
export function runWithBridgeFailureScope<T>(sink: BridgeFailure[], fn: () => Promise<T>): Promise<T> {
  return failureScope.run(sink, fn);
}

/**
 * Log a thrown bridge call and record it on the current tool call.
 *
 * Returns the failure so a wrapper that discriminates can `return
 * recordBridgeFailure(...)`, while a wrapper still on the `| null` contract does
 * `recordBridgeFailure(...); return null;` and gets the visible note for free.
 * Outside a scope (CLI, eval harness, tests) the recording is a no-op and this is
 * just the log line the adapter used to write by hand.
 *
 * `quiet` keeps a call that the caller genuinely expects to miss out of stderr; it
 * changes only the log level, never whether the failure is recorded.
 */
export function recordBridgeFailure(
  operation: string,
  error: unknown,
  options?: { quiet?: boolean },
): BridgeFailure {
  const failure: BridgeFailure = {
    bridgeFailed: true,
    operation,
    reason: error instanceof Error ? error.message : String(error),
  };
  const line = `[BridgeAdapter] ${operation} failed: ${error}`;
  if (options?.quiet) debugLog(line);
  else console.error(line);
  failureScope.getStore()?.push(failure);
  return failure;
}

/** One-line description of a failure, for a tool that wants to name it in its own message. */
export function describeBridgeFailure(failure: BridgeFailure): string {
  return `${BRIDGE_FAILURE_MARKER} ${failure.operation} — ${failure.reason}`;
}

/**
 * The note appended to a response that was produced while the bridge was throwing.
 * It has to say what the answer IS (index/disk data) as well as what went wrong —
 * "bridge error" on its own reads as "no answer", and the agent retries instead of
 * treating the result as the possibly-stale data it is.
 */
export function renderBridgeFailureNote(failures: BridgeFailure[]): string {
  const shown = failures.slice(0, 3);
  const rest = failures.length - shown.length;
  const lines = shown.map(f => `>    • ${f.operation} — ${f.reason}`);
  if (rest > 0) lines.push(`>    • …and ${rest} more bridge call${rest === 1 ? '' : 's'}`);
  return (
    `> ⚠️ ${BRIDGE_FAILURE_MARKER} the C# metadata bridge threw during this call, so anything ` +
    `above came from the SQLite symbol index or from disk — NOT from live D365FO metadata. ` +
    `Treat "not found" and empty lists as unproven, and re-run once the bridge is healthy ` +
    `before concluding an object does not exist.\n` +
    lines.join('\n')
  );
}
