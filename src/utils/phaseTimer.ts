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

export function createPhaseTimer(): PhaseTimer {
  const started = Date.now();
  const phases: Array<{ name: string; ms: number }> = [];

  return {
    async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const t0 = Date.now();
      try {
        return await fn();
      } finally {
        phases.push({ name, ms: Date.now() - t0 });
      }
    },
    add(name: string, ms: number): void {
      phases.push({ name, ms });
    },
    totalMs(): number {
      return Date.now() - started;
    },
    render(thresholdMs = DEFAULT_THRESHOLD_MS): string {
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
