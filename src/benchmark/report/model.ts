/**
 * The report as data — everything the HTML and the markdown print, computed once.
 */
import {
  EFFECT_METRICS,
  HEADLINE_METRICS,
  METRICS,
  METRIC_BY_KEY,
  type EffectSeries,
  type GroupSummary,
  type McpEffect,
  type MetricKey,
  type ModelEffectRow,
  type Stats,
  type TimeSeries,
  assignModelSlots,
  effectSeries,
  formatDeltaPct,
  formatMetric,
  groupRuns,
  mcpEffects,
  modelEffectRows,
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

/**
 * What one variant (with or without MCP) delivered and what it cost — the
 * verdict's unit. Rates are means (a median of 0/1 outcomes says nothing),
 * costs are medians as everywhere else, rework counts are means per run.
 */
export interface VariantQuality {
  n: number;
  /** Runs whose output could be judged (sandbox runs that were built). */
  judged: number;
  /** Valid output: builds clean, well-formed XML, no new BP errors (where measured). 0..1. */
  validRate: number | null;
  buildRate: number | null;
  /** Mean checks passed, 0..100. */
  checksMean: number | null;
  timeMs: number | null;
  aic: number | null;
  /**
   * Total AIC of the judged runs divided by the valid ones among them — what one
   * usable result cost. A run that stops early with broken output is cheap per
   * run and dear per result. Null when nothing was judged or nothing was valid.
   */
  aicPerValid: number | null;
  turns: number | null;
  outputTokens: number | null;
  /** Mean per run, over runs that carry a rework trace. */
  toolErrors: number | null;
  mcpToolErrors: number | null;
  buildFailures: number | null;
  rewrites: number | null;
  /** Mean new BP errors / warnings per run, over runs where xppbp ran. */
  bpErrors: number | null;
  bpWarnings: number | null;
}

export interface Versus {
  with: VariantQuality | null;
  without: VariantQuality | null;
}

/** One check's pass rate per variant, for the heat strip. */
export interface CheckRate {
  name: string;
  withRate: number | null;
  withoutRate: number | null;
}

/** A failure that recurs: a build error or a BP finding, positions stripped, counted. */
export interface Issue {
  kind: 'build' | 'bp' | 'xml';
  text: string;
  count: number;
}

/** A column of the leaderboard and the task matrix: one agent setup. */
export interface ConfigKey {
  key: string;
  host: string;
  model: string;
  mcp: boolean;
  /** With-MCP extras (BenchmarkRun.setup); null = the server alone. */
  setup: string | null;
}

/**
 * One leaderboard row: a configuration over a set of tasks. The design is
 * balanced — every configuration runs every task the same number of times — so
 * pooling across tasks compares like with like.
 */
export interface ConfigRow extends ConfigKey {
  q: VariantQuality;
  validCount: number;
  /** 95 % Wilson interval of the valid-output rate; null when nothing was judged. */
  validCi: [number, number] | null;
  /** Mean AIC per run (total ÷ runs): with the valid rate it is the price of a valid result. */
  aicMean: number | null;
  prompts: number;
  /** Runs per task, the most any task got. */
  repeats: number;
}

/** What switching the MCP server on did for one model — one lift per MCP setup, each against the same run without. */
export interface ModelLift {
  model: string;
  host: string;
  setup: string | null;
  with: ConfigRow | null;
  without: ConfigRow | null;
}

/** A task suite (a shared first tag, e.g. reference / daily), or all tasks. */
export interface Scope {
  id: string;
  label: string;
  promptIds: string[];
  runs: number;
  /** Ranked: valid-output rate, then AIC per valid output. */
  configs: ConfigRow[];
  lifts: ModelLift[];
}

export interface MatrixRow {
  promptId: string;
  title: string;
  suite: string;
  /** Aligned with ReportModel.configKeys. */
  cells: Array<ConfigRow | null>;
}

export interface PromptSection {
  promptId: string;
  title: string;
  /** The suite this task belongs to (its first tag when other tasks share it). */
  suite: string;
  /** This task per configuration, aligned with ReportModel.configKeys. */
  configs: Array<ConfigRow | null>;
  /** Each check's pass rate per configuration, aligned with ReportModel.configKeys. */
  checkMatrix: Array<{ name: string; rates: Array<number | null> }>;
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
  /** The headline: one row per model, the MCP effect per metric. */
  modelEffects: ModelEffectRow[];
  /** The MCP effect over time per model, per headline metric. */
  effectTrends: Record<MetricKey, EffectSeries[]>;
  /** Absolute series per headline metric, for the detailed small multiples. */
  trends: Record<MetricKey, TimeSeries[]>;
  hosts: string[];
  /** With vs without, pooled over models: the section's verdict. */
  versus: Versus;
  checkRates: CheckRate[];
  issues: { with: Issue[]; without: Issue[] };
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
  /** Per model across all prompts: the median of the per-prompt MCP effects. */
  overviewEffects: ModelEffectRow[];
  overview: OverviewRow[];
  prompts: PromptSection[];
  /** With vs without over every run: the page's headline. */
  versus: Versus;
  /** Every configuration in the runs, by model, with MCP first: the leaderboard's and the matrix's columns. */
  configKeys: ConfigKey[];
  /** "all" first, then one per suite when there is more than one. */
  scopes: Scope[];
  matrix: MatrixRow[];
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

const meanOf = (xs: Array<number | null | undefined>): number | null => {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};

/** Valid output: built clean, no malformed XML, no new BP errors where xppbp ran. Null when the run was not built. */
export function isValidOutput(r: BenchmarkRun): boolean | null {
  if (!r.build && r.build !== null) return null; // not a built sandbox run
  if (r.build === null) return false; // a workspace run that wrote nothing to build
  if (!r.build.ok) return false;
  if (r.quality?.xmlInvalid.length) return false;
  if (r.quality?.bp && r.quality.bp.errors > 0) return false;
  return true;
}

export function variantQuality(runs: BenchmarkRun[]): VariantQuality | null {
  if (runs.length === 0) return null;
  const judged = runs.map(isValidOutput).filter((v): v is boolean => v !== null);
  const judgedRuns = runs.filter(r => isValidOutput(r) !== null);
  const validCount = judged.filter(Boolean).length;
  const judgedAic = judgedRuns.every(r => r.aic) ? judgedRuns.reduce((s, r) => s + r.aic!.value, 0) : null;
  const built = runs.filter(r => r.build !== undefined);
  const withRework = runs.filter(r => r.rework);
  const withBp = runs.filter(r => r.quality?.bp);
  const med = (xs: Array<number | null>) => medianOf(xs);
  return {
    n: runs.length,
    judged: judged.length,
    validRate: judged.length ? judged.filter(Boolean).length / judged.length : null,
    buildRate: built.length ? built.filter(r => r.build?.ok).length / built.length : null,
    checksMean: meanOf(runs.map(r => (r.score === null ? null : r.score * 100))),
    timeMs: med(runs.map(r => r.durationMs)),
    aic: med(runs.map(r => r.aic?.value ?? null)),
    aicPerValid: judgedAic !== null && validCount > 0 ? judgedAic / validCount : null,
    turns: med(runs.map(r => r.requests)),
    outputTokens: med(runs.map(r => r.outputTokens)),
    toolErrors: withRework.length ? meanOf(withRework.map(r => r.rework!.toolErrors)) : null,
    mcpToolErrors: withRework.length ? meanOf(withRework.map(r => r.rework!.mcpToolErrors)) : null,
    buildFailures: withRework.length ? meanOf(withRework.map(r => r.rework!.buildFailures)) : null,
    rewrites: withRework.length ? meanOf(withRework.map(r => r.rework!.rewrites)) : null,
    bpErrors: withBp.length ? meanOf(withBp.map(r => r.quality!.bp!.errors)) : null,
    bpWarnings: withBp.length ? meanOf(withBp.map(r => r.quality!.bp!.warnings)) : null,
  };
}

/** 95 % Wilson score interval for k successes in n — honest at 0/n and n/n, where the normal interval collapses. */
export function wilson(k: number, n: number, z = 1.96): [number, number] | null {
  if (n <= 0) return null;
  const p = k / n;
  const z2 = z * z;
  const d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const setupOf = (r: BenchmarkRun) => (r.mcp ? r.setup ?? null : null);
const configKeyOf = (r: BenchmarkRun) => `${r.host}\u0000${r.model}\u0000${r.mcp}\u0000${setupOf(r) ?? ''}`;

export function configRow(runs: BenchmarkRun[]): ConfigRow | null {
  const q = variantQuality(runs);
  if (!q) return null;
  const first = runs[0];
  const validCount = runs.filter(r => isValidOutput(r) === true).length;
  const perPrompt = new Map<string, number>();
  for (const r of runs) perPrompt.set(r.promptId, (perPrompt.get(r.promptId) ?? 0) + 1);
  const priced = runs.filter(r => r.aic);
  return {
    key: configKeyOf(first),
    host: first.host,
    model: first.model,
    mcp: first.mcp,
    setup: setupOf(first),
    q,
    validCount,
    validCi: q.judged ? wilson(validCount, q.judged) : null,
    aicMean: priced.length === runs.length ? priced.reduce((s, r) => s + r.aic!.value, 0) / runs.length : null,
    prompts: perPrompt.size,
    repeats: Math.max(...perPrompt.values()),
  };
}

/** Rank: more valid output first; at a tie, the cheaper valid result; then by name. */
export function rankConfigs(rows: ConfigRow[]): ConfigRow[] {
  const v = (r: ConfigRow) => r.q.validRate ?? -1;
  const c = (r: ConfigRow) => r.q.aicPerValid ?? Number.POSITIVE_INFINITY;
  return [...rows].sort((a, b) => v(b) - v(a) || c(a) - c(b) || a.model.localeCompare(b.model) || Number(b.mcp) - Number(a.mcp) || (a.setup ?? '').localeCompare(b.setup ?? ''));
}

function scopeOf(id: string, label: string, runs: BenchmarkRun[], promptIds: string[]): Scope {
  const byKey = new Map<string, BenchmarkRun[]>();
  for (const r of runs) {
    const k = configKeyOf(r);
    const b = byKey.get(k);
    if (b) b.push(r); else byKey.set(k, [r]);
  }
  const configs = rankConfigs([...byKey.values()].map(configRow).filter((c): c is ConfigRow => c !== null));
  // One lift per MCP setup of a model, each against the same run without MCP.
  const plain = new Map(configs.filter(c => !c.mcp).map(c => [`${c.host}\u0000${c.model}`, c]));
  const lifts: ModelLift[] = configs
    .filter(c => c.mcp)
    .map(c => ({ model: c.model, host: c.host, setup: c.setup, with: c, without: plain.get(`${c.host}\u0000${c.model}`) ?? null }));
  for (const [k, c] of plain) {
    if (!lifts.some(l => `${l.host}\u0000${l.model}` === k)) lifts.push({ model: c.model, host: c.host, setup: null, with: null, without: c });
  }
  // Per model, the documented setup (server + instructions) first, the server alone after it.
  lifts.sort((a, b) => a.model.localeCompare(b.model) || a.host.localeCompare(b.host) || Number(b.setup !== null) - Number(a.setup !== null) || (a.setup ?? '').localeCompare(b.setup ?? ''));
  return { id, label, promptIds, runs: runs.length, configs, lifts };
}

/**
 * A task's suite is its first tag when another task in the report shares it
 * (reference, daily); a tag only one task carries is a topic, not a suite.
 */
function suitesOf(promptIds: string[], specById: Map<string, PromptSpec>): Map<string, string> {
  const first = new Map(promptIds.map(id => [id, specById.get(id)?.tags[0] ?? '']));
  const count = new Map<string, number>();
  for (const t of first.values()) if (t) count.set(t, (count.get(t) ?? 0) + 1);
  return new Map(promptIds.map(id => {
    const t = first.get(id) ?? '';
    return [id, t && (count.get(t) ?? 0) > 1 ? t : 'other'];
  }));
}

const suiteLabel = (s: string) => (s === 'all' ? 'All tasks' : s.charAt(0).toUpperCase() + s.slice(1));

function versusOf(runs: BenchmarkRun[]): Versus {
  return { with: variantQuality(runs.filter(r => r.mcp)), without: variantQuality(runs.filter(r => !r.mcp)) };
}

function checkRatesOf(runs: BenchmarkRun[]): CheckRate[] {
  const names: string[] = [];
  for (const r of runs) for (const c of r.checks) if (!names.includes(c.name)) names.push(c.name);
  const rate = (rs: BenchmarkRun[], name: string) => {
    const hits = rs.flatMap(r => r.checks.filter(c => c.name === name));
    return hits.length ? hits.filter(c => c.passed).length / hits.length : null;
  };
  return names.map(name => ({ name, withRate: rate(runs.filter(r => r.mcp), name), withoutRate: rate(runs.filter(r => !r.mcp), name) }));
}

/** Strip what differs between occurrences of the same error (positions, the severity prefix of a BP line). */
export function normalizeIssue(text: string): string {
  return text.replace(/:\s*\[\(\d+,\d+\),\(\d+,\d+\)\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function issuesOf(runs: BenchmarkRun[]): Issue[] {
  const counts = new Map<string, Issue>();
  const add = (kind: Issue['kind'], raw: string) => {
    const text = normalizeIssue(raw);
    const key = `${kind}\u0000${text}`;
    const cur = counts.get(key);
    if (cur) cur.count++; else counts.set(key, { kind, text, count: 1 });
  };
  for (const r of runs) {
    for (const e of r.build?.errors ?? []) add('build', e);
    for (const f of r.quality?.bp?.findings ?? []) if (/^Error\b/.test(f)) add('bp', f);
    for (const x of r.quality?.xmlInvalid ?? []) add('xml', `malformed XML: ${x.split('/').slice(-2).join('/')}`);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text)).slice(0, 8);
}

export function buildReportModel(runs: BenchmarkRun[], specs: PromptSpec[], opts: ReportOptions): ReportModel {
  const now = opts.now ?? new Date();
  const specById = new Map(specs.map(s => [s.id, s]));
  const models = [...new Set(runs.map(r => r.model))].sort();
  const hosts = [...new Set(runs.map(r => r.host))].sort();
  const slots = assignModelSlots(models);
  const sortedAll = [...runs].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  // The per-model aggregates (overview, effects, trends) pair "with" and "without"
  // by model. A with-MCP setup beyond the server alone is a separate series there,
  // named after it, so it is never pooled into the plain server's numbers.
  const legacy = (rs: BenchmarkRun[]) => rs.map(r => (r.mcp && r.setup ? { ...r, model: `${r.model} + ${r.setup.split(':')[0]}` } : r));

  // Overview: every (host, model, mcp) cell across all prompts.
  const overviewMap = new Map<string, BenchmarkRun[]>();
  for (const r of legacy(runs)) {
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

  // By title, numerically: "Reference 2" before "Reference 10", and in the order the catalogue names them.
  const titleOf = (id: string) => specById.get(id)?.title ?? id;
  const promptIds = [...new Set(runs.map(r => r.promptId))].sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'en', { numeric: true }) || a.localeCompare(b));
  const suites = suitesOf(promptIds, specById);

  const keyMap = new Map<string, ConfigKey>();
  for (const r of runs) {
    const key = configKeyOf(r);
    if (!keyMap.has(key)) keyMap.set(key, { key, host: r.host, model: r.model, mcp: r.mcp, setup: setupOf(r) });
  }
  const configKeys = [...keyMap.values()].sort((a, b) =>
    a.model.localeCompare(b.model) || a.host.localeCompare(b.host) || Number(b.mcp) - Number(a.mcp) || (b.setup ?? '').localeCompare(a.setup ?? ''));
  const perConfig = (rs: BenchmarkRun[]) => configKeys.map(k => configRow(rs.filter(r => configKeyOf(r) === k.key)));

  const prompts: PromptSection[] = promptIds.map(promptId => {
    const prs = sortedAll.filter(r => r.promptId === promptId);
    const lrs = legacy(prs);
    const spec = specById.get(promptId) ?? null;
    const sectionHosts = [...new Set(prs.map(r => r.host))].sort();
    const groups = groupRuns(lrs);
    const effects = mcpEffects(groups);
    const hashes = [...new Set(prs.map(r => r.promptHash))];
    const currentHash = spec ? promptHash(spec.prompt) : null;
    const trends = Object.fromEntries(HEADLINE_METRICS.map(m => [m, timeSeries(lrs, m)])) as Record<MetricKey, TimeSeries[]>;
    const effectTrends = Object.fromEntries(EFFECT_METRICS.map(m => [m, effectSeries(lrs, m)])) as Record<MetricKey, EffectSeries[]>;
    const checkNames: string[] = [];
    for (const r of prs) for (const c of r.checks) if (!checkNames.includes(c.name)) checkNames.push(c.name);
    const checkMatrix = checkNames.map(name => ({
      name,
      rates: configKeys.map(k => {
        const hits = prs.filter(r => configKeyOf(r) === k.key).flatMap(r => r.checks.filter(c => c.name === name));
        return hits.length ? hits.filter(c => c.passed).length / hits.length : null;
      }),
    }));
    return {
      promptId,
      title: spec?.title ?? promptId,
      suite: suites.get(promptId) ?? 'other',
      configs: perConfig(prs),
      checkMatrix,
      spec,
      tags: spec?.tags ?? [],
      hashes,
      currentHash,
      hashDrift: currentHash !== null && hashes.some(h => h !== currentHash),
      runs: prs,
      groups,
      effects,
      kpis: promptKpis(groups, effects, lrs, sectionHosts),
      modelEffects: modelEffectRows(effects),
      effectTrends,
      trends,
      hosts: sectionHosts,
      versus: versusOf(prs),
      checkRates: checkRatesOf(prs),
      issues: { with: issuesOf(prs.filter(r => r.mcp)), without: issuesOf(prs.filter(r => !r.mcp)) },
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

  const suiteIds = [...new Set(promptIds.map(id => suites.get(id) ?? 'other'))];
  const scopes: Scope[] = [scopeOf('all', suiteLabel('all'), runs, promptIds)];
  if (suiteIds.length > 1) {
    for (const s of suiteIds) {
      const ids = promptIds.filter(id => suites.get(id) === s);
      scopes.push(scopeOf(s, suiteLabel(s), runs.filter(r => ids.includes(r.promptId)), ids));
    }
  }
  // Suites in first-seen order, tasks by title inside each.
  const matrix: MatrixRow[] = suiteIds.flatMap(s => prompts.filter(p => p.suite === s).map(p => ({ promptId: p.promptId, title: p.title, suite: p.suite, cells: p.configs })));

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
    overviewEffects: modelEffectRows(allEffects),
    overview,
    prompts,
    versus: versusOf(runs),
    configKeys,
    scopes,
    matrix,
  };
}
