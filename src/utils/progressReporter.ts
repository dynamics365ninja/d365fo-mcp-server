/**
 * Per-request progress channel for long-running tools.
 *
 * A tool that blocks for minutes (build, db sync, test run) is invisible to the
 * caller while it works, so the only way it could report was to give up on a
 * timeout and hand back "call me again to collect" — one build turning into
 * several round trips. MCP already has the mechanism for this: a client that
 * passes `_meta.progressToken` accepts `notifications/progress` for the life of
 * the request, and clients that support it also reset their request timeout on
 * every notification, so a streaming tool stays alive in a SINGLE call.
 *
 * Two channels, same as the one-shot notification the dispatcher already sends:
 *   - notifications/progress — only when the client supplied a progressToken
 *   - notifications/message  — logging fallback for clients that did not
 *
 * Both are best-effort: a client that rejects or ignores them must never fail
 * or stall the tool.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

/**
 * Reports one progress step. `progress` must be monotonically increasing across
 * calls for the same request (MCP spec); elapsed seconds is the natural choice
 * for a tool whose total is unknown. `total` may be omitted for open-ended work.
 */
export type ProgressReporter = (message: string, progress: number, total?: number) => Promise<void>;

/**
 * How often an in-flight tool call re-announces itself.
 *
 * Long enough that a normal call never sends one, short enough to stay inside the
 * request timeouts clients reset on each notification (VS Code's is ~60 s).
 */
export const PROGRESS_HEARTBEAT_MS = 15_000;

/**
 * Keep saying "still running" until the returned stop() is called.
 *
 * The dispatcher sends one notification when a tool starts, and then nothing for
 * however long it takes — so a call that runs for minutes is indistinguishable from
 * a hung one. On 2026-09-07 a first get_workspace_info ran 337.5 s behind a cold
 * database open: the IDE showed "⚙️ Reading workspace configuration" and no further
 * sign of life for five and a half minutes, and the server log (which mirrors
 * stderr, and startup progress does not reach stderr) held nothing either.
 *
 * A tick says the call is alive and how long it has been running, and — for clients
 * that honour progress notifications — resets their request timeout, the mechanism
 * build_d365fo_project already relies on to survive a long xppc. Elapsed seconds is
 * the progress value because MCP requires it to increase and no total is known.
 * Nothing fires before the first tick, so tools answering in milliseconds send
 * exactly what they sent before.
 */
export function startProgressHeartbeat(
  report: ProgressReporter,
  message: string,
  everyMs: number = PROGRESS_HEARTBEAT_MS,
): () => void {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    void report(`${message} — still running, ${elapsedSec}s`, elapsedSec);
  }, everyMs);
  // Never hold the process open for a heartbeat.
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The slice of the SDK's request `extra` that the reporter needs. */
export interface ProgressRequestExtra {
  _meta?: Record<string, unknown>;
  sendNotification?: (notification: unknown) => Promise<void>;
}

/**
 * Build a reporter bound to one in-flight tool call. Always returns a callable —
 * when the client offers neither channel the reporter is simply a no-op, so
 * callers never have to branch on its availability.
 */
export function createProgressReporter(
  server: Pick<Server, 'sendLoggingMessage'>,
  extra: ProgressRequestExtra | undefined,
): ProgressReporter {
  const progressToken = extra?._meta?.progressToken;
  const sendNotification = extra?.sendNotification;
  const canNotify = sendNotification !== undefined && progressToken !== undefined && progressToken !== null;

  return async (message: string, progress: number, total?: number): Promise<void> => {
    if (canNotify) {
      try {
        await sendNotification!({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress,
            ...(total !== undefined ? { total } : {}),
            message,
          },
        });
      } catch {
        // Non-fatal — client may not support progress notifications
      }
    }

    try {
      await server.sendLoggingMessage({ level: 'info', data: message });
    } catch {
      // Non-fatal — logging is best-effort, never block the tool
    }
  };
}
