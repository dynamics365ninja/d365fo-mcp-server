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
