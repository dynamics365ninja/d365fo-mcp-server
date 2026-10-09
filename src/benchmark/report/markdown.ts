/**
 * Markdown twin of the HTML report — the tables, for a PR description or a
 * release note. Same numbers, same medians, no charts.
 */
import { EFFECT_METRICS, METRIC_BY_KEY, formatDeltaPct, formatMetric, type MetricKey, type ModelEffectRow } from '../aggregate.js';
import type { ReportModel, Scope } from './model.js';

const COLS: Array<[MetricKey, string]> = [
  ['durationMs', 'time (med)'],
  ['outputTokens', 'out tokens'],
  ['aic', 'AIC'],
  ['requests', 'turns'],
  ['toolCalls', 'tool calls'],
  ['score', 'checks'],
];

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

function effectTable(rows: ModelEffectRow[], multiHost: boolean): string {
  return table(
    ['model', ...(multiHost ? ['host'] : []), ...EFFECT_METRICS.map(k => `Δ ${METRIC_BY_KEY[k].shortLabel}`)],
    rows.map(r => [r.model, ...(multiHost ? [r.host] : []), ...EFFECT_METRICS.map(k => formatDeltaPct(r.deltas[k]?.deltaPct ?? null))]),
  );
}

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)} %`);

/** The leaderboard of one scope, ranked as on the page. */
function leaderboardTable(scope: Scope): string {
  const judged = scope.configs.some(c => c.q.judged > 0);
  return table(
    ['#', 'model', 'MCP', judged ? 'valid output' : 'checks', '95 % CI', 'checks', 'AIC / valid', 'AIC / run', 'time (med)', 'runs'],
    scope.configs.map((c, i) => [
      String(i + 1), c.model, c.mcp ? 'yes' : 'no',
      judged ? `${pct(c.q.validRate)} (${c.validCount}/${c.q.judged})` : pct(c.q.checksMean === null ? null : c.q.checksMean / 100),
      c.validCi ? `${Math.round(c.validCi[0] * 100)}–${Math.round(c.validCi[1] * 100)} %` : '—',
      pct(c.q.checksMean === null ? null : c.q.checksMean / 100),
      c.q.aicPerValid === null ? (c.q.judged ? 'no valid run' : '—') : formatMetric('aic', c.q.aicPerValid),
      formatMetric('aic', c.aicMean), formatMetric('durationMs', c.q.timeMs), String(c.q.n),
    ]),
  );
}

export function renderMarkdown(m: ReportModel): string {
  const out: string[] = [];
  out.push(`# ${m.title}`);
  out.push('');
  out.push(`Generated ${m.generatedAt.slice(0, 16).replace('T', ' ')} UTC · ${m.runsTotal} runs` +
    (m.span ? ` · ${m.span.from.slice(0, 10)} → ${m.span.to.slice(0, 10)}` : '') +
    (m.filters.length ? ` · filters: ${m.filters.join(', ')}` : ''));
  out.push('');
  for (const k of m.overviewKpis) out.push(`- **${k.label}:** ${k.value}${k.sub ? ` — ${k.sub}` : ''}`);
  for (const s of m.scopes) {
    out.push('');
    out.push(`## Leaderboard — ${s.label} (${s.promptIds.length} task${s.promptIds.length === 1 ? '' : 's'}, ${s.runs} runs)`);
    out.push('');
    out.push(leaderboardTable(s));
  }
  out.push('');
  out.push('Valid output = builds clean, well-formed XML, no new best-practice error. AIC / run is the mean; AIC / valid = the AIC of all runs ÷ valid runs.');
  out.push('');
  out.push('## MCP effect per model, all prompts');
  out.push('');
  out.push(m.overviewEffects.length ? effectTable(m.overviewEffects, m.hosts.length > 1) : '_no model has both cells yet_');
  out.push('');
  out.push('With MCP relative to without; median per model, then median over prompts. Lower is better for every column except checks.');
  out.push('');
  out.push('## All prompts, medians');
  out.push('');
  out.push(table(
    ['model', 'host', 'MCP', 'runs', 'prompts', 'completed', ...COLS.map(c => c[1])],
    m.overview.map(r => [
      r.model, r.host, r.mcp ? 'yes' : 'no', String(r.n), String(r.prompts), `${Math.round(r.completionRate * 100)} %`,
      ...COLS.map(([k]) => formatMetric(k, r.medians[k]?.median ?? null)),
    ]),
  ));
  for (const p of m.prompts) {
    out.push('');
    out.push(`## ${p.title}`);
    out.push('');
    out.push(`\`${p.promptId}\`${p.tags.length ? ` · ${p.tags.join(', ')}` : ''} · ${p.runs.length} runs` +
      (p.hashDrift ? ' · ⚠ prompt text changed since some runs' : ''));
    out.push('');
    for (const k of p.kpis) out.push(`- **${k.label}:** ${k.value}${k.sub ? ` — ${k.sub}` : ''}`);
    out.push('');
    out.push(table(
      ['model', ...(p.hosts.length > 1 ? ['host'] : []), 'MCP', 'runs', 'completed', ...COLS.map(c => c[1]), 'time p90'],
      p.groups.map(g => [
        g.model, ...(p.hosts.length > 1 ? [g.host] : []), g.mcp ? 'yes' : 'no', String(g.n), `${Math.round(g.completionRate * 100)} %`,
        ...COLS.map(([k]) => formatMetric(k, g.metrics[k]?.median ?? null)),
        formatMetric('durationMs', g.metrics.durationMs?.p90 ?? null),
      ]),
    ));
    if (p.effects.length) {
      out.push('');
      out.push('With MCP vs without (medians):');
      out.push('');
      const models = [...new Set(p.effects.map(e => `${e.model}\u0000${e.host}`))];
      out.push(table(
        ['model', ...(p.hosts.length > 1 ? ['host'] : []), 'Δ time', 'Δ out tokens', 'Δ AIC', 'Δ turns', 'Δ checks'],
        models.map(key => {
          const [model, host] = key.split('\u0000');
          const d = (k: MetricKey) => formatDeltaPct(p.effects.find(e => e.model === model && e.host === host && e.metric === k)?.deltaPct ?? null);
          return [model, ...(p.hosts.length > 1 ? [host] : []), d('durationMs'), d('outputTokens'), d('aic'), d('requests'), d('score')];
        }),
      ));
    }
  }
  out.push('');
  out.push('## How AIC was obtained');
  out.push('');
  for (const n of m.creditsNotes) out.push(`- ${n}`);
  if (m.creditsNotes.length === 0) out.push('- no priced runs');
  out.push('');
  return out.join('\n');
}
