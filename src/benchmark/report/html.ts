/**
 * The HTML report — one self-contained file, no network, opens from disk on
 * the VM. Charts are server-rendered SVG (svg.ts); the page script only adds
 * the hover layer, the prompt switcher and the theme toggle.
 *
 * Colour discipline (dataviz skill): one categorical slot per model for the
 * whole page; the with/without-MCP comparison is two shades of ONE hue on a
 * dumbbell, never a second categorical colour; deltas carry a glyph as well as
 * a colour; every chart has a table under it.
 */
import {
  EFFECT_METRICS,
  HEADLINE_METRICS,
  METRICS,
  METRIC_BY_KEY,
  formatDeltaPct,
  formatMetric,
  type McpEffect,
  type MetricKey,
  type ModelEffectRow,
} from '../aggregate.js';
import type { Kpi, PromptSection, ReportModel } from './model.js';
import { divergingBars, dumbbellChart, esc, legend, lineChart, type DivergingRow, type DumbbellRow, type LineSeries } from './svg.js';

const CSS = `
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --text: #0b0b0b; --text-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100;
  --series-5: #e87ba4; --series-6: #008300; --series-7: #4a3aa7; --series-8: #e34948; --series-other: #898781;
  --from: #86b6ef; --to: #2a78d6;
  --good: #006300; --bad: #d03b3b; --good-mark: #0ca30c; --bad-mark: #d03b3b; --warn-bg: #fff6e0;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --text: #ffffff; --text-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
    --series-5: #d55181; --series-6: #008300; --series-7: #9085e9; --series-8: #e66767;
    --from: #86b6ef; --to: #3987e5; --good: #0ca30c; --bad: #e66767; --good-mark: #0ca30c; --bad-mark: #d03b3b; --warn-bg: #2a2410;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --text: #ffffff; --text-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
  --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
  --series-5: #d55181; --series-6: #008300; --series-7: #9085e9; --series-8: #e66767;
  --from: #86b6ef; --to: #3987e5; --good: #0ca30c; --bad: #e66767; --good-mark: #0ca30c; --bad-mark: #d03b3b; --warn-bg: #2a2410;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--page); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1240px; margin: 0 auto; padding: 24px 16px 48px; }
header.top { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
h1 { font-size: 22px; margin: 0; font-weight: 600; }
h2 { font-size: 18px; margin: 32px 0 8px; font-weight: 600; }
h3 { font-size: 14px; margin: 20px 0 8px; font-weight: 600; color: var(--text-2); text-transform: uppercase; letter-spacing: .04em; }
.meta { color: var(--text-2); }
.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0 4px; }
.filters button, .toggle { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 999px; padding: 4px 12px; cursor: pointer; font: inherit; }
.filters button[aria-pressed="true"] { background: var(--text); color: var(--page); border-color: var(--text); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 12px 0; }
.kpi .label { color: var(--text-2); font-size: 12px; }
.kpi .value { font-size: 26px; font-weight: 600; margin: 2px 0; }
.kpi .sub { color: var(--muted); font-size: 12px; }
.kpi.good .value { color: var(--good); } .kpi.bad .value { color: var(--bad); }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 12px; }
@media (max-width: 480px) { .grid2 { grid-template-columns: 1fr; } }
figure { margin: 0; }
figcaption { font-weight: 600; margin-bottom: 4px; }
figcaption small { color: var(--muted); font-weight: 400; margin-left: 6px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
@media (max-width: 760px) { .pair { grid-template-columns: 1fr; } }
.pair .panel-title { font-size: 12px; color: var(--text-2); margin: 4px 0; }
.empty { color: var(--muted); font-size: 12px; padding: 24px 0; text-align: center; border: 1px dashed var(--grid); border-radius: 6px; }
svg.chart { display: block; overflow: visible; }
svg .grid { stroke: var(--grid); stroke-width: 1; }
svg .axis { stroke: var(--axis); stroke-width: 1; }
svg .tick, svg .muted { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
svg .label { fill: var(--text); font-size: 12px; }
svg .value { fill: var(--text-2); font-size: 11px; font-variant-numeric: tabular-nums; }
svg .connector { stroke: var(--axis); stroke-width: 2; stroke-linecap: round; }
svg .dot { stroke: var(--surface); stroke-width: 2; cursor: default; }
svg .dot:hover, svg .dot:focus { stroke: var(--text); outline: none; }
svg .dot.from { fill: var(--from); } svg .dot.to { fill: var(--to); }
svg .dot.clipped { stroke-width: 1.5; }
svg .bar.good { fill: var(--good-mark); } svg .bar.bad { fill: var(--bad-mark); } svg .bar.neutral { fill: var(--axis); }
svg .bar:hover, svg .bar:focus { opacity: .85; outline: none; }
svg .axis.zero { stroke: var(--muted); }
.grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
details.more > summary { font-weight: 600; color: var(--text-2); padding: 10px 0; }
details.more[open] > summary { margin-bottom: 8px; }
.lede { color: var(--text-2); margin: 0 0 8px; }
svg .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
svg .crosshair { stroke: var(--axis); stroke-width: 1; pointer-events: none; }
.s0 { stroke: var(--series-1); fill: var(--series-1); } .s1 { stroke: var(--series-2); fill: var(--series-2); }
.s2 { stroke: var(--series-3); fill: var(--series-3); } .s3 { stroke: var(--series-4); fill: var(--series-4); }
.s4 { stroke: var(--series-5); fill: var(--series-5); } .s5 { stroke: var(--series-6); fill: var(--series-6); }
.s6 { stroke: var(--series-7); fill: var(--series-7); } .s7 { stroke: var(--series-8); fill: var(--series-8); }
.s8 { stroke: var(--series-other); fill: var(--series-other); }
svg .line.s0 { fill: none; } svg .line.s1 { fill: none; } svg .line.s2 { fill: none; } svg .line.s3 { fill: none; }
svg .line.s4 { fill: none; } svg .line.s5 { fill: none; } svg .line.s6 { fill: none; } svg .line.s7 { fill: none; } svg .line.s8 { fill: none; }
.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 0; margin: 6px 0 0; color: var(--text-2); font-size: 12px; }
.legend .key { display: inline-block; width: 18px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 6px; }
.legend .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; vertical-align: middle; margin-right: 6px; }
.swatch.from { background: var(--from); } .swatch.to { background: var(--to); }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); vertical-align: top; }
th { color: var(--text-2); font-weight: 600; white-space: nowrap; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.delta.good { color: var(--good); } .delta.bad { color: var(--bad); }
.tagline { color: var(--muted); font-size: 12px; }
.tag { display: inline-block; border: 1px solid var(--border); border-radius: 999px; padding: 0 8px; font-size: 11px; margin-right: 4px; color: var(--text-2); }
.warn { background: var(--warn-bg); border-left: 3px solid var(--series-4); padding: 8px 12px; border-radius: 6px; margin: 8px 0; }
details { margin: 8px 0; }
summary { cursor: pointer; color: var(--text-2); }
pre.prompt { white-space: pre-wrap; background: var(--page); border: 1px solid var(--grid); border-radius: 6px; padding: 10px; font-size: 12.5px; }
.tip { position: fixed; z-index: 10; pointer-events: none; background: var(--text); color: var(--page); padding: 6px 9px; border-radius: 6px; font-size: 12px; max-width: 320px; display: none; }
.tip b { font-weight: 600; } .tip .row { display: flex; gap: 8px; align-items: center; } .tip .k { display: inline-block; width: 12px; height: 2px; }
.excerpt { color: var(--text-2); font-size: 12px; max-width: 360px; }
footer { margin-top: 40px; color: var(--muted); font-size: 12px; }
.hidden { display: none; }
`;

const JS = `
(function () {
  var tip = document.createElement('div'); tip.className = 'tip'; document.body.appendChild(tip);
  function show(html, x, y) {
    tip.innerHTML = html; tip.style.display = 'block';
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var left = x + 14, top = y + 14;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top + h > window.innerHeight - 8) top = y - h - 14;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  }
  function hide() { tip.style.display = 'none'; }
  function text(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  document.addEventListener('pointerover', function (e) {
    var el = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (el) show('<b>' + text(el.getAttribute('data-tip')) + '</b>', e.clientX, e.clientY);
  });
  document.addEventListener('pointerout', function (e) { if (e.target.closest && e.target.closest('[data-tip]')) hide(); });
  document.addEventListener('focusin', function (e) {
    var el = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (el) { var r = el.getBoundingClientRect(); show('<b>' + text(el.getAttribute('data-tip')) + '</b>', r.left + r.width / 2, r.top); }
  });
  document.addEventListener('focusout', hide);

  // Crosshair on line charts: snap to the nearest date, list every series there.
  var charts = document.querySelectorAll('svg.lines');
  for (var i = 0; i < charts.length; i++) (function (svg) {
    var desc = svg.querySelector('desc[data-series]');
    if (!desc) return;
    var series = JSON.parse(desc.getAttribute('data-series'));
    var plot = svg.getAttribute('data-plot').split(',').map(Number);
    var t0 = Number(svg.getAttribute('data-t0')), t1 = Number(svg.getAttribute('data-t1'));
    var vb = svg.viewBox.baseVal;
    var cross = svg.querySelector('.crosshair');
    var times = [];
    series.forEach(function (s) { s.points.forEach(function (p) { if (times.indexOf(p[0]) < 0) times.push(p[0]); }); });
    times.sort(function (a, b) { return a - b; });
    if (!times.length) return;
    svg.addEventListener('pointermove', function (e) {
      var rect = svg.getBoundingClientRect();
      var vx = (e.clientX - rect.left) / rect.width * vb.width;
      var t = t0 + (vx - plot[0]) / plot[2] * (t1 - t0);
      var best = times[0];
      for (var k = 1; k < times.length; k++) if (Math.abs(times[k] - t) < Math.abs(best - t)) best = times[k];
      var x = plot[0] + (best - t0) / (t1 - t0) * plot[2];
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.style.display = '';
      var d = new Date(best);
      var html = '<div>' + text(d.toISOString().slice(0, 10)) + '</div>';
      series.forEach(function (s) {
        var hit = null;
        s.points.forEach(function (p) { if (Math.abs(p[0] - best) < 43200000 && (hit === null || Math.abs(p[0] - best) < Math.abs(hit[0] - best))) hit = p; });
        if (hit) html += '<div class="row"><span class="k s' + s.slot + '"></span><b>' + text(hit[2]) + '</b><span>' + text(s.name) + '</span></div>';
      });
      show(html, e.clientX, e.clientY);
    });
    svg.addEventListener('pointerleave', function () { cross.style.display = 'none'; hide(); });
  })(charts[i]);

  // Prompt switcher.
  var buttons = document.querySelectorAll('.filters button[data-prompt]');
  function select(id) {
    for (var b = 0; b < buttons.length; b++) buttons[b].setAttribute('aria-pressed', String(buttons[b].getAttribute('data-prompt') === id));
    var sections = document.querySelectorAll('section.prompt');
    for (var s = 0; s < sections.length; s++) sections[s].classList.toggle('hidden', id !== '*' && sections[s].getAttribute('data-prompt') !== id);
    try { localStorage.setItem('bench.prompt', id); } catch (err) {}
  }
  for (var b = 0; b < buttons.length; b++) buttons[b].addEventListener('click', function (e) { select(e.currentTarget.getAttribute('data-prompt')); });
  var saved = null; try { saved = localStorage.getItem('bench.prompt'); } catch (err) {}
  if (saved && document.querySelector('.filters button[data-prompt="' + saved.replace(/"/g, '') + '"]')) select(saved);

  // Theme toggle.
  var toggle = document.querySelector('.toggle');
  var root = document.documentElement;
  try { var th = localStorage.getItem('bench.theme'); if (th) root.setAttribute('data-theme', th); } catch (err) {}
  toggle.addEventListener('click', function () {
    var dark = root.getAttribute('data-theme') === 'dark' || (!root.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var next = dark ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('bench.theme', next); } catch (err) {}
  });
})();
`;

const fmtTs = (iso: string) => iso.slice(0, 16).replace('T', ' ');

function kpiRow(kpis: Kpi[]): string {
  return `<div class="kpis">${kpis
    .map(k => `<div class="card kpi${k.tone ? ` ${k.tone}` : ''}"><div class="label">${esc(k.label)}</div><div class="value">${esc(k.value)}</div>${k.sub ? `<div class="sub">${esc(k.sub)}</div>` : ''}</div>`)
    .join('')}</div>`;
}

function deltaCell(effects: McpEffect[], model: string, host: string, metric: MetricKey): string {
  const e = effects.find(x => x.model === model && x.host === host && x.metric === metric);
  if (!e || e.deltaPct === null) return '<td class="num">—</td>';
  const def = METRIC_BY_KEY[metric];
  const improved = def.better === 'lower' ? e.deltaPct < 0 : e.deltaPct > 0;
  const tone = e.deltaPct === 0 ? '' : improved ? 'good' : 'bad';
  const glyph = e.deltaPct === 0 ? '' : improved ? '▼ ' : '▲ ';
  const tip = `${def.label}: ${def.format(e.withMcp)} with MCP (n=${e.nWith}) vs ${def.format(e.withoutMcp)} without (n=${e.nWithout})`;
  return `<td class="num delta ${tone}" data-tip="${esc(tip)}">${glyph}${esc(formatDeltaPct(e.deltaPct))}</td>`;
}

function statsTable(p: PromptSection): string {
  const multiHost = p.hosts.length > 1;
  const head = [
    '<th>model</th>', ...(multiHost ? ['<th>host</th>'] : []), '<th>MCP</th>', '<th class="num">runs</th>', '<th class="num">completed</th>',
    ...METRICS.map(m => `<th class="num">${esc(m.shortLabel)} <small>med</small></th>`),
    '<th class="num">time <small>p90</small></th>', '<th>AIC source</th>',
  ].join('');
  const rows = p.groups.map(g => {
    const cells = [
      `<td>${esc(g.model)}</td>`, ...(multiHost ? [`<td>${esc(g.host)}</td>`] : []), `<td>${g.mcp ? 'with' : 'without'}</td>`,
      `<td class="num">${g.n}</td>`, `<td class="num">${Math.round(g.completionRate * 100)} %</td>`,
      ...METRICS.map(m => `<td class="num">${esc(formatMetric(m.key, g.metrics[m.key]?.median ?? null))}</td>`),
      `<td class="num">${esc(formatMetric('durationMs', g.metrics.durationMs?.p90 ?? null))}</td>`,
      `<td>${esc(g.aicSources.join(', ') || '—')}</td>`,
    ];
    return `<tr>${cells.join('')}</tr>`;
  });
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function effectsTable(p: PromptSection): string {
  if (p.effects.length === 0) return '<p class="tagline">No model has runs both with and without MCP yet — the comparison needs both cells.</p>';
  const multiHost = p.hosts.length > 1;
  const keys = [...new Set(p.effects.map(e => `${e.model}\u0000${e.host}`))];
  const cols: MetricKey[] = ['durationMs', 'outputTokens', 'aic', 'requests', 'toolCalls', 'score'];
  const head = ['<th>model</th>', ...(multiHost ? ['<th>host</th>'] : []), ...cols.map(c => `<th class="num">Δ ${esc(METRIC_BY_KEY[c].shortLabel)}</th>`)].join('');
  const rows = keys.map(k => {
    const [model, host] = k.split('\u0000');
    return `<tr><td>${esc(model)}</td>${multiHost ? `<td>${esc(host)}</td>` : ''}${cols.map(c => deltaCell(p.effects, model, host, c)).join('')}</tr>`;
  });
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>
  <p class="tagline">▼ green = better with MCP, ▲ red = worse. Lower is better for every column except checks.</p>`;
}

function runsTable(p: PromptSection): string {
  const rows = [...p.runs].reverse().map(r => {
    const toolsNote = r.toolCalls > 0 ? `${r.toolCalls}${r.mcpToolCalls ? ` (${r.mcpToolCalls} MCP)` : ''}` : '0';
    const extra = [r.label, r.notes].filter(Boolean).map(esc).join(' · ');
    return `<tr>
      <td>${esc(fmtTs(r.timestamp))}</td><td>${esc(r.model)}${r.host !== p.hosts[0] || p.hosts.length > 1 ? ` <span class="tagline">${esc(r.host)}</span>` : ''}</td>
      <td>${r.mcp ? 'with' : 'without'}</td><td>${esc(r.outcome)}</td>
      <td class="num">${esc(formatMetric('durationMs', r.durationMs))}</td><td class="num">${r.requests}</td><td class="num">${esc(toolsNote)}</td>
      <td class="num">${esc(formatMetric('outputTokens', r.outputTokens))}</td><td class="num">${esc(formatMetric('aic', r.aic?.value ?? null))}</td>
      <td class="num">${r.score === null ? '—' : `${Math.round(r.score * 100)} %`}</td>
      <td><div class="excerpt">${extra}${r.resultExcerpt ? `${extra ? '<br>' : ''}<em>${esc(r.resultExcerpt.slice(0, 160))}${r.resultExcerpt.length > 160 ? '…' : ''}</em>` : ''}</div></td>
    </tr>`;
  });
  return `<table><thead><tr><th>when (UTC)</th><th>model</th><th>MCP</th><th>outcome</th><th class="num">time</th><th class="num">turns</th><th class="num">tools</th><th class="num">out tok</th><th class="num">AIC</th><th class="num">checks</th><th>label · notes · answer</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function dumbbells(p: PromptSection): string {
  const metricsShown: MetricKey[] = [...HEADLINE_METRICS];
  if (p.groups.some(g => g.metrics.score)) metricsShown.push('score');
  const charts = metricsShown.map(metric => {
    const def = METRIC_BY_KEY[metric];
    // One scale per host, as in the trends: a 17-minute editor session next to
    // 30-second print runs would push every other row onto the axis origin.
    const facets = p.hosts.map(host => {
      const models = [...new Set(p.groups.filter(g => g.host === host).map(g => g.model))].sort();
      const rows: DumbbellRow[] = models.map(model => {
        const w = p.groups.find(g => g.model === model && g.host === host && g.mcp)?.metrics[metric] ?? null;
        const wo = p.groups.find(g => g.model === model && g.host === host && !g.mcp)?.metrics[metric] ?? null;
        return { label: model, from: wo?.median ?? null, to: w?.median ?? null, fromN: wo?.n ?? 0, toN: w?.n ?? 0 };
      });
      if (rows.length === 0) return '';
      const svg = dumbbellChart({ rows, title: `${def.label}, median per model, ${host}`, fromLabel: 'without MCP', toLabel: 'with MCP', format: def.format, better: def.better });
      return `${p.hosts.length > 1 ? `<div class="panel-title">${esc(host)}</div>` : ''}${svg}`;
    });
    return `<figure class="card"><figcaption>${esc(def.label)}<small>median · ${def.better === 'lower' ? 'lower is better' : 'higher is better'}</small></figcaption>${facets.join('')}</figure>`;
  });
  return `<div class="grid2">${charts.join('')}</div>
  <ul class="legend"><li><span class="swatch from"></span>without MCP</li><li><span class="swatch to"></span>with MCP</li></ul>`;
}

function trends(p: PromptSection, slots: Map<string, number>): string {
  const blocks = HEADLINE_METRICS.map(metric => {
    const def = METRIC_BY_KEY[metric];
    const all = p.trends[metric];
    if (all.length === 0) return '';
    // One facet per host: a Copilot session and a headless claude run are not
    // on one scale (a 95-turn editor session beside a 6-turn print run flattens
    // the latter to a line on the floor), and they never share a cell anyway.
    const facets = p.hosts.map(host => {
      const mine = all.filter(s => s.host === host);
      if (mine.length === 0) return '';
      const tAll = mine.flatMap(s => s.raw.map(r => r.t));
      const tDomain: [number, number] = [Math.min(...tAll), Math.max(...tAll)];
      // The axis fits the daily medians (the lines); a single run far above them —
      // a timeout among 30-second runs — is drawn clipped at the top edge rather
      // than allowed to flatten every line to the floor.
      const yMax = Math.max(...mine.flatMap(s => s.points.map(r => r.value)), 0);
      const panel = (mcp: boolean) => {
        const series: LineSeries[] = mine
          .filter(s => s.mcp === mcp)
          .map(s => ({
            name: s.model,
            slot: slots.get(s.model) ?? 8,
            points: s.points.map(pt => ({ t: pt.t, v: pt.value })),
            dots: s.raw.map(pt => ({ t: pt.t, v: pt.value })),
          }));
        const title = `${def.label} over time, ${mcp ? 'with' : 'without'} MCP, ${host}`;
        return `<div><div class="panel-title">${mcp ? 'with MCP' : 'without MCP'}${p.hosts.length > 1 ? ` · ${esc(host)}` : ''}</div>${
          series.length ? lineChart({ series, title, format: def.format, tDomain, yMax }) : '<div class="empty">no runs</div>'
        }</div>`;
      };
      const models = [...new Set(mine.map(s => s.model))].sort().map(model => ({ name: model, slot: slots.get(model) ?? 8 }));
      return `<div class="pair">${panel(true)}${panel(false)}</div>${legend(models)}`;
    });
    return `<figure class="card"><figcaption>${esc(def.label)}<small>daily median per model · dots are single runs</small></figcaption>${facets.join('')}</figure>`;
  });
  return blocks.join('');
}

const pct = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(Math.abs(v) >= 10 ? 0 : 1)} %`;

/**
 * The headline: one small multiple per metric, one bar per model, the bar
 * being "with MCP relative to without". Reads left to right as a scorecard.
 */
function effectBars(rows: ModelEffectRow[], hosts: string[], scope: string): string {
  if (rows.length === 0) {
    return '<p class="tagline">No model has runs both with and without MCP yet — the comparison needs both cells.</p>';
  }
  const metrics = EFFECT_METRICS.filter(k => rows.some(r => r.deltas[k]));
  // The host joins the row label only when the ROWS span more than one host —
  // a Copilot session that never has both cells must not stamp every row.
  const rowHosts = new Set(rows.map(r => r.host));
  const label = (r: ModelEffectRow) => (rowHosts.size > 1 || (hosts.length > 1 && !rows.length) ? `${r.model} · ${r.host}` : r.model);
  // One shared extent per scorecard so the bars are comparable across the panels.
  const extent = Math.max(...rows.flatMap(r => metrics.map(k => Math.abs(r.deltas[k]?.deltaPct ?? 0))), 10);
  const panels = metrics.map(k => {
    const def = METRIC_BY_KEY[k];
    const bars: DivergingRow[] = rows.map(r => {
      const d = r.deltas[k];
      if (!d) return { label: label(r), value: null, good: null, tip: '' };
      const good = d.deltaPct === 0 ? null : def.better === 'lower' ? d.deltaPct < 0 : d.deltaPct > 0;
      const tip = `${r.model}: ${def.format(d.withMcp)} with MCP vs ${def.format(d.withoutMcp)} without (${d.nWith} + ${d.nWithout} runs${d.prompts > 1 ? `, ${d.prompts} prompts` : ''})`;
      return { label: label(r), value: d.deltaPct, good, tip };
    });
    return `<figure class="card"><figcaption>${esc(def.label)}<small>${def.better === 'lower' ? 'less is better' : 'more is better'}</small></figcaption>${divergingBars({ rows: bars, title: `MCP effect on ${def.label}, ${scope}`, format: pct, extent })}</figure>`;
  });
  return `<div class="grid3">${panels.join('')}</div>
  <p class="tagline">Bar = with MCP relative to without, median per model${scope === 'all prompts' ? ', then median over prompts' : ''}. ▼ green = better with MCP, ▲ red = worse.</p>`;
}

/** The MCP effect over time: one line per model, zero = no difference. */
function effectTrends(p: PromptSection, slots: Map<string, number>): string {
  const blocks = EFFECT_METRICS.map(metric => {
    const def = METRIC_BY_KEY[metric];
    const all = p.effectTrends[metric];
    if (all.length === 0) return '';
    const tAll = all.flatMap(s => s.points.map(r => r.t));
    const vAll = all.flatMap(s => s.points.map(r => r.value));
    const seriesHosts = new Set(all.map(s => s.host));
    const series: LineSeries[] = all.map(s => ({
      name: seriesHosts.size > 1 ? `${s.model} · ${s.host}` : s.model,
      slot: slots.get(s.model) ?? 8,
      points: s.points.map(pt => ({ t: pt.t, v: pt.value })),
      dots: s.points.map(pt => ({ t: pt.t, v: pt.value })),
    }));
    // A delta cannot go below −100 %, and above +200 % one bad day (a timeout
    // against 30-second runs) would flatten every other line; such a day is
    // drawn clipped at the top edge with its value in the tooltip.
    const maxAbs = Math.max(...vAll.map(Math.abs), 10);
    const svg = lineChart({
      series,
      title: `MCP effect on ${def.label} over time`,
      format: pct,
      tDomain: [Math.min(...tAll), Math.max(...tAll)],
      yMax: Math.min(maxAbs, 200),
      yMin: -Math.min(maxAbs, 100),
      width: 640,
      height: 220,
    });
    const models = [...new Set(all.map(s => s.model))].sort().map(model => ({ name: model, slot: slots.get(model) ?? 8 }));
    return `<figure class="card"><figcaption>${esc(def.label)}<small>with MCP vs without, per day · ${def.better === 'lower' ? 'below zero is better' : 'above zero is better'}</small></figcaption>${svg}${legend(models)}</figure>`;
  }).filter(Boolean);
  if (blocks.length === 0) return '<p class="tagline">No day has both cells for a model yet — run both variants on the same day to get a point.</p>';
  return `<div class="grid2">${blocks.join('')}</div>`;
}

function promptSection(p: PromptSection, m: ReportModel): string {
  const promptText = p.spec ? `<details><summary>Prompt text</summary><pre class="prompt">${esc(p.spec.prompt)}</pre></details>` : '<p class="tagline">Prompt text not in the catalogue (eval/benchmark/prompts/).</p>';
  const drift = p.hashDrift
    ? `<div class="warn">⚠ The prompt text in the catalogue (hash ${esc(p.currentHash ?? '')}) differs from the one some of these runs used (${esc(p.hashes.filter(h => h !== p.currentHash).join(', '))}). Treat older runs as a different experiment.</div>`
    : '';
  return `<section class="prompt" data-prompt="${esc(p.promptId)}">
  <h2>${esc(p.title)}</h2>
  <div class="tagline"><code>${esc(p.promptId)}</code> ${p.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')} · ${p.runs.length} runs · ${esc(p.hosts.join(', '))}</div>
  ${drift}
  ${promptText}
  ${kpiRow(p.kpis)}
  <h3>MCP effect per model</h3>
  ${effectBars(p.modelEffects, p.hosts, p.promptId)}
  <h3>MCP effect over time</h3>
  ${effectTrends(p, m.slots)}
  <details class="more"><summary>Details — absolute values, trends, tables, every run</summary>
    <h3>With MCP vs without, medians</h3>
    ${dumbbells(p)}
    <h3>Over time, absolute</h3>
    ${trends(p, m.slots)}
    <h3>Numbers</h3>
    <div class="card">${statsTable(p)}</div>
    <h3>MCP effect, table</h3>
    <div class="card">${effectsTable(p)}</div>
    <details><summary>All ${p.runs.length} runs</summary><div class="card">${runsTable(p)}</div></details>
  </details>
</section>`;
}

function overviewTable(m: ReportModel): string {
  const cols: MetricKey[] = ['durationMs', 'outputTokens', 'aic', 'requests', 'toolCalls', 'score'];
  const rows = m.overview.map(r => `<tr>
    <td>${esc(r.model)}</td><td>${esc(r.host)}</td><td>${r.mcp ? 'with' : 'without'}</td>
    <td class="num">${r.n}</td><td class="num">${r.prompts}</td><td class="num">${Math.round(r.completionRate * 100)} %</td>
    ${cols.map(c => `<td class="num">${esc(formatMetric(c, r.medians[c]?.median ?? null))}</td>`).join('')}
  </tr>`);
  return `<table><thead><tr><th>model</th><th>host</th><th>MCP</th><th class="num">runs</th><th class="num">prompts</th><th class="num">completed</th>${cols
    .map(c => `<th class="num">${esc(METRIC_BY_KEY[c].shortLabel)} <small>med</small></th>`)
    .join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

export function renderHtml(m: ReportModel): string {
  const filters = m.prompts.length > 1
    ? `<div class="filters"><span class="meta">Prompt:</span><button data-prompt="*" aria-pressed="true">All</button>${m.prompts
        .map(p => `<button data-prompt="${esc(p.promptId)}" aria-pressed="false">${esc(p.title)}</button>`)
        .join('')}</div>`
    : '';
  const body = m.runsTotal === 0
    ? '<div class="card empty">No runs match. Record one with <code>d365fo-mcp benchmark run</code> or <code>benchmark ingest</code>.</div>'
    : `${kpiRow(m.overviewKpis)}
  <h3>MCP effect per model, all prompts</h3>
  ${effectBars(m.overviewEffects, m.hosts, 'all prompts')}
  <details class="more"><summary>All prompts, medians per model</summary><div class="card">${overviewTable(m)}</div></details>
  ${m.prompts.map(p => promptSection(p, m)).join('\n')}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.title)}</title>
<meta name="description" content="Model × MCP benchmark: run time, output tokens and AI Credits per model, with and without the D365FO MCP server, over time.">
<style>${CSS}</style>
</head>
<body>
<main>
<header class="top">
  <div><h1>${esc(m.title)}</h1>
  <div class="meta">Generated ${esc(fmtTs(m.generatedAt))} UTC · ${m.runsTotal} runs${m.span ? ` · ${esc(m.span.from.slice(0, 10))} → ${esc(m.span.to.slice(0, 10))}` : ''}${m.filters.length ? ` · filters: ${esc(m.filters.join(', '))}` : ''}${m.skippedFiles ? ` · <span class="delta bad">${m.skippedFiles} unreadable record file(s) skipped</span>` : ''}</div></div>
  <button class="toggle" type="button">Light / dark</button>
</header>
${filters}
${body}
<footer>
  <p><b>AIC = AI Credits.</b> ${m.creditsNotes.length ? esc(m.creditsNotes.join(' · ')) : 'No priced runs.'} Rates live in <code>eval/benchmark/credits.json</code>.</p>
  <p>Medians throughout; p90 shown for run time. A cell is one (prompt, host, model, with/without MCP). Every chart's numbers are in the table beneath it.</p>
</footer>
</main>
<script>${JS}</script>
</body>
</html>
`;
}
