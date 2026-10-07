/**
 * The report as data — everything the HTML and the markdown print, computed once.
 */
import {
  HEADLINE_METRICS,
  METRICS,
  METRIC_BY_KEY,
  type GroupSummary,
  type McpEffect,
  type MetricKey,
  type Stats,
  type TimeSeries,
  assignModelSlots,
  formatDeltaPct,
  formatMetric,
  groupRuns,
  mcpEffects,
  quantile,
  stats,
  timeSeries,
} from '../aggregate.js';
import { promptHash } from '../prompts.js';
import type { BenchmarkRun, CreditsConfig, PromptSpec } from '../types.js';

export interface Kpi {
  label: string;
  value: string;
  /** Second line: what the value is relative to, or who holds it. */
  sub: string | null;
  /** Direction colouring for a delta tile; null for a plain count. */
  tone: 'good' | 'bad' | null;
}

export interface OverviewRow {
  host: string;
  model: string;
  mcp: boolean;
  n: number;
  prompts: number;
  completionRate: number;
  medians: Record<MetricKey, Stats | null>;
}

export interface PromptSection {
  promptId: string;
  title: string;
  spec: PromptSpec | null;
  tags: string[];
  /** Hashes seen in the runs; drift = the catalogue text differs from some runs' hash. */
  hashes: string[];
  currentHash: string | null;
  hashDrift: boolean;
  runs: BenchmarkRun[];
  groups: GroupSummary[];
  effects: McpEffect[];
  kpis: Kpi[];
  /** Series per headline metric, for the small multiples. */
  trends: Record<MetricKey, TimeSeries[]>;
  hosts: string[];
}

export interface ReportModel {
  generatedAt: string;
  title: string;
  filters: string[];
  creditsUnit: string;
  creditsNotes: string[];
  runsTotal: number;
  skippedFiles: number;
  models: string[];
  slots: Map<string, number>;
  hosts: string[];
  span: { from: string; to: string } | null;
  overviewKpis: Kpi[];
  overview: OverviewRow[];
  prompts: PromptSection[];
}

export interface ReportOptions {
  title?: string;
  filters?: string[];
  skippedFiles?: number;
  credits: CreditsConfig;
  now?: Date;
}

/** Row label for a model when the section mixes hosts. */
export function seriesName(model: string, host: string, hosts: string[]): string {
  return hosts.length > 1 ? `${model} · ${host}` : model;
}

function medianOf(values: Array<number | null>): number | null {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  return xs.length ? quantile(xs, 0.5) : null;
}

function deltaKpi(effects: McpEffect[], metric: MetricKey, label: string): Kpi | null {
  const def = METRIC_BY_KEY[metric];
  const deltas = effects.filter(e => e.metric === metric).map(e => e.deltaPct);
  const med = medianOf(deltas);
  if (med === null) return null;
  const improved = def.better === 'lower' ? med < 0 : med > 0;
  const models = new Set(effects.filter(e => e.metric === metric).map(e => e.model)).size;
  return {
    label,
    value: formatDeltaPct(med),
    sub: `with MCP vs without · median over ${models} model${models === 1 ? '' : 's'}`,
    tone: med === 0 ? null : improved ? 'good' : 'bad',
  };
}

function promptKpis(groups: GroupSummary[], effects: McpEffect[], runs: BenchmarkRun[], hosts: string[]): Kpi[] {
  const kpis: Kpi[] = [];
  const models = new Set(groups.map(g => g.model)).size;
  kpis.push({ label: 'Runs', value: String(runs.length), sub: `${models} model${models === 1 ? '' : 's'} · ${groups.length} cells`, tone: null });

  const fastest = groups
    .filter(g => g.metrics.durationMs)
    .sort((a, b) => a.metrics.durationMs!.median - b.metrics.durationMs!.median)[0];
  if (fastest) {
    kpis.push({
      label: 'Fastest median',
      value: formatMetric('durationMs', fastest.metrics.durationMs!.median),
      sub: `${seriesName(fastest.model, fastest.host, hosts)} · ${fastest.mcp ? 'with' : 'without'} MCP`,
      tone: null,
    });
  }
  const cheapest = groups
    .filter(g => g.metrics.aic)
    .sort((a, b) => a.metrics.aic!.median - b.metrics.aic!.median)[0];
  if (cheapest) {
    kpis.push({
      label: 'Cheapest median',
      value: `${formatMetric('aic', cheapest.metrics.aic!.median)} AIC`,
      sub: `${seriesName(cheapest.model, cheapest.host, hosts)} · ${cheapest.mcp ? 'with' : 'without'} MCP`,
      tone: null,
    });
  }
  for (const [metric, label] of [
    ['durationMs', 'MCP effect on time'],
    ['aic', 'MCP effect on AIC'],
    ['outputTokens', 'MCP effect on output'],
    ['score', 'MCP effect on checks'],
  ] as Array<[MetricKey, string]>) {
    const k = deltaKpi(effects, metric, label);
    if (k) kpis.push(k);
  }
  return kpis;
}

export function buildReportModel(runs: BenchmarkRun[], specs: PromptSpec[], opts: ReportOptions): ReportModel {
  const now = opts.now ?? new Date();
  const specById = new Map(specs.map(s => [s.id, s]));
  const models = [...new Set(runs.map(r => r.model))].sort();
  const hosts = [...new Set(runs.map(r => r.host))].sort();
  const slots = assignModelSlots(models);
  const sortedAll = [...runs].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Overview: every (host, model, mcp) cell across all prompts.
  const overviewMap = new Map<string, BenchmarkRun[]>();
  for (const r of runs) {
    const k = `${r.host}\u0000${r.model}\u0000${r.mcp}`;
    const b = overviewMap.get(k);
    if (b) b.push(r); else overviewMap.set(k, [r]);
  }
  const overview: OverviewRow[] = [...overviewMap.values()]
    .map(rs => ({
      host: rs[0].host,
      model: rs[0].model,
      mcp: rs[0].mcp,
      n: rs.length,
      prompts: new Set(rs.map(r => r.promptId)).size,
      completionRate: rs.filter(r => r.outcome === 'completed').length / rs.length,
      medians: Object.fromEntries(METRICS.map(m => [m.key, stats(rs.map(m.of))])) as Record<MetricKey, Stats | null>,
    }))
    .sort((a, b) => a.model.localeCompare(b.model) || a.host.localeCompare(b.host) || Number(b.mcp) - Number(a.mcp));

  const promptIds = [...new Set(runs.map(r => r.promptId))].sort();
  const prompts: PromptSection[] = promptIds.map(promptId => {
    const prs = sortedAll.filter(r => r.promptId === promptId);
    const spec = specById.get(promptId) ?? null;
    const sectionHosts = [...new Set(prs.map(r => r.host))].sort();
    const groups = groupRuns(prs);
    const effects = mcpEffects(groups);
    const hashes = [...new Set(prs.map(r => r.promptHash))];
    const currentHash = spec ? promptHash(spec.prompt) : null;
    const trends = Object.fromEntries(HEADLINE_METRICS.map(m => [m, timeSeries(prs, m)])) as Record<MetricKey, TimeSeries[]>;
    return {
      promptId,
      title: spec?.title ?? promptId,
      spec,
      tags: spec?.tags ?? [],
      hashes,
      currentHash,
      hashDrift: currentHash !== null && hashes.some(h => h !== currentHash),
      runs: prs,
      groups,
      effects,
      kpis: promptKpis(groups, effects, prs, sectionHosts),
      trends,
      hosts: sectionHosts,
    };
  });

  const allEffects = prompts.flatMap(p => p.effects);
  const overviewKpis: Kpi[] = [
    { label: 'Runs', value: String(runs.length), sub: `${promptIds.length} prompt${promptIds.length === 1 ? '' : 's'} · ${models.length} model${models.length === 1 ? '' : 's'} · ${hosts.join(', ') || 'no hosts'}`, tone: null },
  ];
  for (const [metric, label] of [
    ['durationMs', 'MCP effect on time'],
    ['aic', 'MCP effect on AIC'],
    ['outputTokens', 'MCP effect on output'],
  ] as Array<[MetricKey, string]>) {
    const k = deltaKpi(allEffects, metric, label);
    if (k) overviewKpis.push({ ...k, sub: `${k.sub} · all prompts` });
  }

  const sources = new Map<string, Set<string>>();
  for (const r of runs) {
    if (!r.aic) continue;
    const s = sources.get(r.host) ?? new Set<string>();
    s.add(r.aic.source);
    sources.set(r.host, s);
  }
  const creditsNotes: string[] = [];
  for (const [host, srcs] of sources) {
    const words = [...srcs].map(s =>
      s === 'host' ? 'billed by the host'
        : s === 'host-cost' ? `derived from the host's USD cost × ${opts.credits.creditsPerUsd}`
        : `derived from tokens × model list rates × ${opts.credits.creditsPerUsd} per USD`,
    );
    creditsNotes.push(`${host}: ${words.join('; ')}`);
  }
  const unpriced = runs.filter(r => !r.aic).length;
  if (unpriced > 0) creditsNotes.push(`${unpriced} run(s) carry no AIC — no cost and no rate for the model`);

  return {
    generatedAt: now.toISOString(),
    title: opts.title ?? 'D365FO MCP benchmark',
    filters: opts.filters ?? [],
    creditsUnit: opts.credits.unit,
    creditsNotes,
    runsTotal: runs.length,
    skippedFiles: opts.skippedFiles ?? 0,
    models,
    slots,
    hosts,
    span: sortedAll.length ? { from: sortedAll[0].timestamp, to: sortedAll[sortedAll.length - 1].timestamp } : null,
    overviewKpis,
    overview,
    prompts,
  };
}
