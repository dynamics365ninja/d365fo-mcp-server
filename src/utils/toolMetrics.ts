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
  /** Calls with identical tool+args repeated within the recent-call window */
  duplicateCalls: number;
}

const stats = new Map<string, ToolStats>();

let logIntervalHandle: ReturnType<typeof setInterval> | null = null;

function getStats(toolName: string): ToolStats {
  let s = stats.get(toolName);
  if (!s) {
    s = { calls: 0, totalLatencyMs: 0, emptyResults: 0, duplicateCalls: 0 };
    stats.set(toolName, s);
  }
  return s;
}

/**
 * Wall-clock past which a single tool call is logged individually, in ms.
 *
 * The aggregate stats below cannot attribute one slow call after the fact.
 *
 * The ⚠️ is load-bearing: console.error in src/index.ts drops "[module]"-
 * prefixed messages without an error/warning marker.
 */
const SLOW_CALL_MS = Number(process.env.SLOW_CALL_LOG_MS ?? 10_000);

/** Argument digest for a slow-call line — enough to identify the call, never the payload. */
function digestArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const entries = Object.entries(args as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null)
    .slice(0, 6)
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      const short = (s ?? '').length > 40 ? `${(s ?? '').slice(0, 40)}…` : s;
      return `${k}=${short}`;
    });
  return entries.length > 0 ? ` {${entries.join(', ')}}` : '';
}

/** Log a single tool call that ran long enough to be worth attributing. */
export function reportSlowCall(toolName: string, elapsedMs: number, args?: unknown): void {
  if (elapsedMs < SLOW_CALL_MS) return;
  console.error(
    `[toolMetrics] ⚠️ slow call: ${toolName} took ${(elapsedMs / 1000).toFixed(1)}s${digestArgs(args)}`,
  );
}

/** Call before dispatching a tool. Returns a finish() callback. */
export function recordToolStart(toolName: string): (isEmpty: boolean) => void {
  const t0 = Date.now();
  return (isEmpty: boolean) => {
    const elapsed = Date.now() - t0;
    const s = getStats(toolName);
    s.calls++;
    s.totalLatencyMs += elapsed;
    if (isEmpty) s.emptyResults++;
  };
}

// Call-sequence tracking (agentic-loop detection): a ring buffer of recent
// tool calls (tool + args hash). recordCallSequence returns how many times an
// exact call appeared in the recent window so callers can flag likely loops.

const SEQUENCE_WINDOW = 15;
const SEQUENCE_BUFFER_MAX = 30;

interface SequenceEntry {
  tool: string;
  argsKey: string;
  at: number;
}

const recentCalls: SequenceEntry[] = [];

/**
 * Record a call in the sequence buffer and return the number of occurrences
 * of this exact tool+args combination within the recent window (including
 * the call just recorded). 1 = first occurrence, 3+ = likely loop.
 */
export function recordCallSequence(toolName: string, argsKey: string): number {
  recentCalls.push({ tool: toolName, argsKey, at: Date.now() });
  if (recentCalls.length > SEQUENCE_BUFFER_MAX) {
    recentCalls.splice(0, recentCalls.length - SEQUENCE_BUFFER_MAX);
  }
  const window = recentCalls.slice(-SEQUENCE_WINDOW);
  const occurrences = window.filter(e => e.tool === toolName && e.argsKey === argsKey).length;
  if (occurrences > 1) getStats(toolName).duplicateCalls++;
  return occurrences;
}

/** Test/maintenance helper — clears the sequence buffer. */
export function resetCallSequence(): void {
  recentCalls.length = 0;
}

/** Returns a snapshot of current metrics sorted by call count descending. */
export function getMetricsSnapshot(): Array<{
  tool: string;
  calls: number;
  avgLatencyMs: number;
  emptyRatio: number;
  duplicateCalls: number;
}> {
  return Array.from(stats.entries())
    .map(([tool, s]) => ({
      tool,
      calls: s.calls,
      avgLatencyMs: s.calls > 0 ? Math.round(s.totalLatencyMs / s.calls) : 0,
      emptyRatio: s.calls > 0 ? Math.round((s.emptyResults / s.calls) * 100) / 100 : 0,
      duplicateCalls: s.duplicateCalls,
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
