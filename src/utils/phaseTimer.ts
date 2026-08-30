/**
 * Phase timings for one write, reported in the write's own reply when it was
 * slow.
 *
 * A tool call that takes 95 s to create an enum is a fact the transcript
 * records and nobody can act on: the response says only that it succeeded, and
 * the aggregate metrics cannot attribute one call. Naming the phases turns
 * "the server is sometimes slow" into "the bridge call was 92 s of it".
 *
 * Silent below the threshold, so a normal write's reply is unchanged.
 */

const DEFAULT_THRESHOLD_MS = Number(process.env.SLOW_CALL_LOG_MS ?? 10_000);

export interface PhaseTimer {
  /** Run `fn`, recording how long it took under `name`. */
  time<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Record a phase measured elsewhere. */
  add(name: string, ms: number): void;
  /** Total elapsed since the timer was created. */
  totalMs(): number;
  /** A `⏱️` block, or '' when the call was quick enough not to matter. */
  render(thresholdMs?: number): string;
}

/**
 * How often a call that is still running says what it is doing.
 *
 * A tool call that takes minutes is invisible while it takes them: the client
 * shows a spinner, the reply arrives afterwards, and the phase block is only
 * ever read after the fact. One create in benchmark run d79f62a3 took 341 s and
 * reported all of it as `(unmeasured)` — there was nothing to look at, live or
 * later. This puts the phase in flight on stderr, where the server's own log
 * shows it while it is happening.
 */
const HEARTBEAT_MS = Number(process.env.SLOW_CALL_HEARTBEAT_MS ?? 30_000);

export function createPhaseTimer(): PhaseTimer {
  const started = Date.now();
  const phases: Array<{ name: string; ms: number }> = [];
  let inFlight: { name: string; at: number } | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stopHeartbeat = () => {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  };
  const startHeartbeat = () => {
    if (heartbeat || HEARTBEAT_MS <= 0) return;
    heartbeat = setInterval(() => {
      const elapsed = ((Date.now() - started) / 1000).toFixed(0);
      const phase = inFlight
        ? `${inFlight.name} (${((Date.now() - inFlight.at) / 1000).toFixed(0)}s)`
        : 'between phases';
      console.error(`[slow-call] ${elapsed}s elapsed — ${phase}`);
    }, HEARTBEAT_MS);
    // Never a reason to keep the process alive.
    heartbeat.unref?.();
  };

  return {
    async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const t0 = Date.now();
      inFlight = { name, at: t0 };
      startHeartbeat();
      try {
        return await fn();
      } finally {
        phases.push({ name, ms: Date.now() - t0 });
        inFlight = null;
      }
    },
    add(name: string, ms: number): void {
      phases.push({ name, ms });
    },
    totalMs(): number {
      return Date.now() - started;
    },
    render(thresholdMs = DEFAULT_THRESHOLD_MS): string {
      stopHeartbeat();
      const measured = phases.reduce((sum, p) => sum + p.ms, 0);
      // Phases recorded with add() may cover work that started before this
      // timer, so the larger of the two decides.
      const total = Math.max(Date.now() - started, measured);
      if (total < thresholdMs) return '';

      const shown = [...phases]
        .filter(p => p.ms >= 100)
        .sort((a, b) => b.ms - a.ms)
        .map(p => `   ${(p.ms / 1000).toFixed(1)}s  ${p.name}`);
      const rest = total - measured;
      if (rest >= 100) shown.push(`   ${(rest / 1000).toFixed(1)}s  (unmeasured)`);

      return `\n\n⏱️ This call took ${(total / 1000).toFixed(1)}s:\n${shown.join('\n')}`;
    },
  };
}
