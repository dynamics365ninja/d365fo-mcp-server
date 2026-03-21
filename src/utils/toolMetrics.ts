/**
 * Lightweight in-memory tool usage metrics.
 *
 * Tracks per-tool call counts, total latency, and empty-result counts.
 * Stats are logged to stderr periodically and exposed via getMetricsSnapshot().
 * All state is in-process only — resets on server restart.
 */

interface ToolStats {
  calls: number;
  totalLatencyMs: number;
  emptyResults: number;
}

const stats = new Map<string, ToolStats>();

let logIntervalHandle: ReturnType<typeof setInterval> | null = null;

/** Call before dispatching a tool. Returns a finish() callback. */
export function recordToolStart(toolName: string): (isEmpty: boolean) => void {
  const t0 = Date.now();
  return (isEmpty: boolean) => {
    const elapsed = Date.now() - t0;
    let s = stats.get(toolName);
    if (!s) {
      s = { calls: 0, totalLatencyMs: 0, emptyResults: 0 };
      stats.set(toolName, s);
    }
    s.calls++;
    s.totalLatencyMs += elapsed;
    if (isEmpty) s.emptyResults++;
  };
}

/** Returns a snapshot of current metrics sorted by call count descending. */
export function getMetricsSnapshot(): Array<{
  tool: string;
  calls: number;
  avgLatencyMs: number;
  emptyRatio: number;
}> {
  return Array.from(stats.entries())
    .map(([tool, s]) => ({
      tool,
      calls: s.calls,
      avgLatencyMs: s.calls > 0 ? Math.round(s.totalLatencyMs / s.calls) : 0,
      emptyRatio: s.calls > 0 ? Math.round((s.emptyResults / s.calls) * 100) / 100 : 0,
    }))
    .sort((a, b) => b.calls - a.calls);
}

/**
 * Start periodic logging of metrics to stderr.
 * Safe to call multiple times — only the first call starts the interval.
 * @param intervalMs default 5 minutes
 */
export function startMetricsLogging(intervalMs = 5 * 60 * 1000): void {
  if (logIntervalHandle) return;
  logIntervalHandle = setInterval(() => {
    const snapshot = getMetricsSnapshot();
    if (snapshot.length === 0) return;
    const top10 = snapshot.slice(0, 10);
    const lines = top10.map(
      r => `  ${r.tool.padEnd(40)} calls=${r.calls}  avgMs=${r.avgLatencyMs}  emptyRatio=${r.emptyRatio}`
    );
    console.error('[metrics] Tool usage (top 10 by calls):\n' + lines.join('\n'));
  }, intervalMs);
  // Don't prevent Node from exiting
  if (logIntervalHandle && typeof logIntervalHandle === 'object' && 'unref' in logIntervalHandle) {
    (logIntervalHandle as any).unref();
  }
}
