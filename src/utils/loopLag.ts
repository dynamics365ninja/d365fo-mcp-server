/**
 * Event-loop lag monitor — attribution for "the first call took seconds".
 *
 * Why this exists rather than a fix: the 2026-08-25 audit measured, over 268
 * real `labels` calls, a mean server time of 5.6 s, while the FTS query those
 * calls run takes 6–11 ms in isolation. Narrowing it further: the first call
 * after the handshake took 1,215–1,336 ms, the SAME call 8 s later took 18 ms,
 * and the tool's own phase timer reported 0.0 s for a call the client saw take
 * 1.3 s. So the time was not inside the tool — requests were queueing behind
 * synchronous work on the single Node event loop. `node:sqlite` is synchronous
 * by design and this server opens a 2.5 GB symbol index and a 630 MB label
 * index, so that is the shape of the suspect.
 *
 * What could NOT be reproduced: measured from outside on this VM with a WARM
 * OS file cache, the loop is barely blocked — three ~140 ms stalls in the first
 * 5.5 s, 415 ms of blocking in total across 25 s, on top of a 1,749 ms
 * `initialize`. The corpus averages come from cold caches, which cannot be
 * recreated on demand without disturbing the machine.
 *
 * Rather than invent a fix for blocking that cannot currently be measured, this
 * leaves the measurement in the server. Turn it on with DEBUG_LOGGING and the
 * next investigation gets attribution — which phase, how long — instead of the
 * inference above. Off by default; the timer is unref'd, so it never keeps the
 * process alive, and it does no work beyond a subtraction per tick.
 */

/** How often the probe wakes. Small enough to catch a stall, cheap enough to ignore. */
const SAMPLE_MS = 100;

/**
 * Report a tick only when it drifted this far past its schedule.
 *
 * Windows timers routinely run ~15 ms late (the default timer resolution), and
 * a GC pause can add tens more; anything under this is noise, not a stall worth
 * a line in the log.
 */
const REPORT_THRESHOLD_MS = 150;

let timer: ReturnType<typeof setInterval> | null = null;
let worstLagMs = 0;
let totalLagMs = 0;
let stallCount = 0;

/** Start sampling. No-op when already running, or when debug logging is off. */
export function startLoopLagMonitor(startedAt: number = Date.now()): void {
  if (timer || process.env.DEBUG_LOGGING !== 'true') return;

  let expected = Date.now() + SAMPLE_MS;
  timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    expected = now + SAMPLE_MS;
    if (lag < REPORT_THRESHOLD_MS) return;

    stallCount++;
    totalLagMs += lag;
    if (lag > worstLagMs) worstLagMs = lag;
    // console.error, not debugLog: debugLog re-checks a DEBUG_LOGGING constant
    // captured when ITS module loaded, so a monitor gated here and logging there
    // has two sources of truth for one switch. The gate above is the only one.
    console.error(
      `[loopLag] event loop blocked ~${lag} ms at t+${now - startedAt} ms ` +
      `(stall ${stallCount}, worst ${worstLagMs} ms, total ${totalLagMs} ms)`,
    );
  }, SAMPLE_MS);

  if (typeof timer.unref === 'function') timer.unref();
}

/** Stop sampling. Safe to call when never started. */
export function stopLoopLagMonitor(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** What the monitor has seen so far — for a diagnostics dump or a test. */
export function getLoopLagStats(): { stallCount: number; worstLagMs: number; totalLagMs: number } {
  return { stallCount, worstLagMs, totalLagMs };
}

/** Test seam — the counters are process-wide. */
export function resetLoopLagStats(): void {
  worstLagMs = 0;
  totalLagMs = 0;
  stallCount = 0;
}
