/**
 * The arithmetic behind the report: group, summarise, compare, and lay out in time.
 *
 * Medians throughout. Agent runs have a long right tail (one run that wandered
 * for ten minutes), and a mean would let that one run speak for the model. p90
 * is kept beside the median so the tail is still visible.
 */
import type { BenchmarkRun } from './types.js';

export type MetricKey = 'durationMs' | 'outputTokens' | 'aic' | 'requests' | 'toolCalls' | 'inputTokens' | 'score';

export interface MetricDef {
  key: MetricKey;
  label: string;
  shortLabel: string;
  unit: string;
  /** Which direction is an improvement — decides the sign colouring of a delta. */
  better: 'lower' | 'higher';
  /** Value of a run, or null when the run does not carry this metric. */
  of: (run: BenchmarkRun) => number | null;
  format: (v: number) => string;
}

const fmtInt = (v: number) => Math.round(v).toLocaleString('en-US');

export const METRICS: MetricDef[] = [
  {
    key: 'durationMs', label: 'Run time', shortLabel: 'time', unit: 's', better: 'lower',
    of: r => r.durationMs,
    format: v => (v >= 60000 ? `${(v / 60000).toFixed(1)} min` : `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} s`),
  },
  {
    key: 'outputTokens', label: 'Output tokens', shortLabel: 'out tok', unit: 'tokens', better: 'lower',
    of: r => r.outputTokens, format: fmtInt,
  },
  {
    key: 'aic', label: 'AI Credits', shortLabel: 'AIC', unit: 'AIC', better: 'lower',
    of: r => (r.aic ? r.aic.value : null), format: v => (v >= 100 ? fmtInt(v) : v.toFixed(2)),
  },
  {
    key: 'requests', label: 'Model round trips', shortLabel: 'turns', unit: 'requests', better: 'lower',
    of: r => r.requests, format: fmtInt,
  },
  {
    key: 'toolCalls', label: 'Tool calls', shortLabel: 'tools', unit: 'calls', better: 'lower',
    of: r => r.toolCalls, format: fmtInt,
  },
  {
    key: 'inputTokens', label: 'Prompt tokens sent', shortLabel: 'in tok', unit: 'tokens', better: 'lower',
    of: r => r.inputTokens, format: fmtInt,
  },
  {
    key: 'score', label: 'Checks passed', shortLabel: 'score', unit: '%', better: 'higher',
    of: r => (r.score === null ? null : r.score * 100), format: v => `${Math.round(v)} %`,
  },
];

export const METRIC_BY_KEY: Record<MetricKey, MetricDef> = Object.fromEntries(METRICS.map(m => [m.key, m])) as Record<MetricKey, MetricDef>;

/** The four the charts lead with; the rest live in the tables. */
export const HEADLINE_METRICS: MetricKey[] = ['durationMs', 'outputTokens', 'aic', 'requests'];

export interface Stats {
  n: number;
  median: number;
  p90: number;
  mean: number;
  min: number;
  max: number;
}

/** Nearest-rank quantile on a sorted copy; q in [0,1]. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function stats(values: Array<number | null | undefined>): Stats | null {
  const xs = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  return {
    n: xs.length,
    median: quantile(xs, 0.5),
    p90: quantile(xs, 0.9),
    mean: xs.reduce((s, v) => s + v, 0) / xs.length,
    min: xs[0],
    max: xs[xs.length - 1],
  };
}

export interface GroupSummary {
  promptId: string;
  host: string;
  model: string;
  mcp: boolean;
  runs: BenchmarkRun[];
  n: number;
  completed: number;
  completionRate: number;
  metrics: Record<MetricKey, Stats | null>;
  /** How the AIC figures were obtained, for the "derived" caveat. */
  aicSources: string[];
  /** Distinct prompt hashes seen — more than one means the wording changed under the group. */
  promptHashes: string[];
  firstRun: string;
  lastRun: string;
}

export function groupKey(r: Pick<BenchmarkRun, 'promptId' | 'host' | 'model' | 'mcp'>): string {
  return `${r.promptId}\u0000${r.host}\u0000${r.model}\u0000${r.mcp ? 'mcp' : 'plain'}`;
}

export function groupRuns(runs: BenchmarkRun[]): GroupSummary[] {
  const buckets = new Map<string, BenchmarkRun[]>();
  for (const r of runs) {
    const k = groupKey(r);
    const b = buckets.get(k);
    if (b) b.push(r); else buckets.set(k, [r]);
  }
  const groups: GroupSummary[] = [];
  for (const bucket of buckets.values()) {
    const sorted = [...bucket].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const first = sorted[0];
    const completed = sorted.filter(r => r.outcome === 'completed').length;
    const metrics = Object.fromEntries(METRICS.map(m => [m.key, stats(sorted.map(m.of))])) as Record<MetricKey, Stats | null>;
    groups.push({
      promptId: first.promptId,
      host: first.host,
      model: first.model,
      mcp: first.mcp,
      runs: sorted,
      n: sorted.length,
      completed,
      completionRate: completed / sorted.length,
      metrics,
      aicSources: [...new Set(sorted.map(r => r.aic?.source ?? null).filter((s): s is NonNullable<typeof s> => s !== null))],
      promptHashes: [...new Set(sorted.map(r => r.promptHash))],
      firstRun: first.timestamp,
      lastRun: sorted[sorted.length - 1].timestamp,
    });
  }
  return groups.sort((a, b) =>
    a.promptId.localeCompare(b.promptId) || a.host.localeCompare(b.host) || a.model.localeCompare(b.model) || Number(b.mcp) - Number(a.mcp),
  );
}

export interface McpEffect {
  promptId: string;
  host: string;
  model: string;
  metric: MetricKey;
  withMcp: number;
  withoutMcp: number;
  /** (with − without) / without; negative is a saving on a lower-is-better metric. */
  deltaPct: number | null;
  nWith: number;
  nWithout: number;
}

/** Median with MCP against median without, per model that has both cells. */
export function mcpEffects(groups: GroupSummary[]): McpEffect[] {
  const byModel = new Map<string, { with?: GroupSummary; without?: GroupSummary }>();
  for (const g of groups) {
    const k = `${g.promptId}\u0000${g.host}\u0000${g.model}`;
    const pair = byModel.get(k) ?? {};
    if (g.mcp) pair.with = g; else pair.without = g;
    byModel.set(k, pair);
  }
  const out: McpEffect[] = [];
  for (const pair of byModel.values()) {
    if (!pair.with || !pair.without) continue;
    for (const m of METRICS) {
      const a = pair.with.metrics[m.key];
      const b = pair.without.metrics[m.key];
      if (!a || !b) continue;
      out.push({
        promptId: pair.with.promptId,
        host: pair.with.host,
        model: pair.with.model,
        metric: m.key,
        withMcp: a.median,
        withoutMcp: b.median,
        deltaPct: b.median === 0 ? null : ((a.median - b.median) / b.median) * 100,
        nWith: a.n,
        nWithout: b.n,
      });
    }
  }
  return out;
}

export interface SeriesPoint {
  /** epoch ms */
  t: number;
  value: number;
  /** Runs folded into this point (one unless several ran the same day). */
  runIds: string[];
}

export interface TimeSeries {
  model: string;
  host: string;
  mcp: boolean;
  /** One point per UTC day: the day's median. */
  points: SeriesPoint[];
  /** Every run, for the dots. */
  raw: SeriesPoint[];
}

const DAY_MS = 24 * 3600 * 1000;

/** Per (host, model, mcp): the metric over time, folded to a daily median so repeats on one day read as one point. */
export function timeSeries(runs: BenchmarkRun[], metric: MetricKey): TimeSeries[] {
  const def = METRIC_BY_KEY[metric];
  const buckets = new Map<string, BenchmarkRun[]>();
  for (const r of runs) {
    if (def.of(r) === null) continue;
    const k = `${r.host}\u0000${r.model}\u0000${r.mcp ? 'mcp' : 'plain'}`;
    const b = buckets.get(k);
    if (b) b.push(r); else buckets.set(k, [r]);
  }
  const series: TimeSeries[] = [];
  for (const bucket of buckets.values()) {
    const sorted = [...bucket].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const raw: SeriesPoint[] = sorted.map(r => ({ t: Date.parse(r.timestamp), value: def.of(r)!, runIds: [r.runId] }));
    const byDay = new Map<number, SeriesPoint[]>();
    for (const p of raw) {
      const day = Math.floor(p.t / DAY_MS) * DAY_MS;
      const d = byDay.get(day);
      if (d) d.push(p); else byDay.set(day, [p]);
    }
    const points: SeriesPoint[] = [...byDay.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, ps]) => ({
        t: ps.reduce((s, p) => s + p.t, 0) / ps.length,
        value: quantile(ps.map(p => p.value).sort((a, b) => a - b), 0.5),
        runIds: ps.flatMap(p => p.runIds),
      }));
    series.push({ model: sorted[0].model, host: sorted[0].host, mcp: sorted[0].mcp, points, raw });
  }
  return series.sort((a, b) => a.model.localeCompare(b.model) || Number(b.mcp) - Number(a.mcp));
}

/**
 * Colour follows the entity: every model gets one categorical slot for the
 * whole report, assigned once from the sorted list of models seen anywhere in
 * it, never per chart. The palette has eight slots; a ninth model folds into
 * "Other" rather than inventing a hue (dataviz skill, non-negotiables).
 */
export const MAX_MODEL_SLOTS = 8;

export function assignModelSlots(models: Iterable<string>): Map<string, number> {
  const sorted = [...new Set(models)].sort();
  const slots = new Map<string, number>();
  sorted.forEach((m, i) => slots.set(m, i < MAX_MODEL_SLOTS ? i : MAX_MODEL_SLOTS));
  return slots;
}

/** Compact run time for tables and tiles. */
export function formatMetric(metric: MetricKey, value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : METRIC_BY_KEY[metric].format(value);
}

export function formatDeltaPct(delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return '—';
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
  return `${sign}${Math.abs(delta).toFixed(Math.abs(delta) >= 10 ? 0 : 1)} %`;
}
