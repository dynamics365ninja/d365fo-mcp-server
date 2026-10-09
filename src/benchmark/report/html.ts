/**
 * The HTML report — one self-contained file, no network, opens from disk on
 * the VM. Charts are server-rendered (SVG in svg.ts, bars and strips as plain
 * HTML here); the page script adds hover, the prompt switcher, the theme
 * toggle and the motion: cards rise in as they scroll into view, bars grow
 * from zero, the headline numbers count up. Everything renders complete
 * without the script, and nothing moves under prefers-reduced-motion.
 *
 * Reading order is the question order:
 *   1. Verdict — does MCP get the job done, at what cost, with how much rework?
 *   2. Scoreboard — the same answer per prompt, winner marked.
 *   3. Per prompt — with vs without side by side, which checks fail where,
 *      the errors that recur; the MCP effect per model.
 *   4. Details — absolute charts, trends, tables, every run.
 *
 * Colour discipline: one accent for "with MCP", one neutral for "without",
 * green/red only for better/worse (always with a glyph), one categorical slot
 * per model for the model charts in the details.
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
import type { CheckRate, Issue, Kpi, PromptSection, ReportModel, VariantQuality, Versus } from './model.js';
import { divergingBars, dumbbellChart, esc, legend, lineChart, type DivergingRow, type DumbbellRow, type LineSeries } from './svg.js';

const LIGHT = `
  --page: #f4f5f9; --surface: #ffffff; --surface-2: #f8f9fc; --text: #0f1222; --text-2: #4a4f66; --muted: #858aa0;
  --grid: #e4e6ef; --axis: #c5c9d8; --border: rgba(15,18,34,0.08); --shadow: 0 1px 2px rgba(15,18,34,.04), 0 8px 24px rgba(15,18,34,.06);
  --mcp: #4f46e5; --mcp-soft: #e0e7ff; --mcp-ink: #3730a3; --plain: #94a3b8; --plain-soft: #eef1f6; --plain-ink: #475569;
  --good: #047857; --good-soft: #d1fae5; --bad: #b91c1c; --bad-soft: #fee2e2; --warn: #b45309; --warn-soft: #fef3c7;
  --hero-a: #4f46e5; --hero-b: #0ea5e9;
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100;
  --series-5: #e87ba4; --series-6: #008300; --series-7: #4a3aa7; --series-8: #e34948; --series-other: #898781;
  --from: #a5b4c8; --to: #4f46e5; --good-mark: #10b981; --bad-mark: #ef4444;`;
const DARK = `
  --page: #0b0d17; --surface: #141726; --surface-2: #1a1e30; --text: #f3f4fa; --text-2: #b6bad0; --muted: #7c8199;
  --grid: #262a3f; --axis: #383d58; --border: rgba(255,255,255,0.08); --shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px rgba(0,0,0,.35);
  --mcp: #818cf8; --mcp-soft: #262a5c; --mcp-ink: #c7d2fe; --plain: #64748b; --plain-soft: #1f2436; --plain-ink: #cbd5e1;
  --good: #34d399; --good-soft: #0b3a2c; --bad: #f87171; --bad-soft: #43171a; --warn: #fbbf24; --warn-soft: #3a2a0a;
  --hero-a: #6366f1; --hero-b: #0891b2;
  --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
  --series-5: #d55181; --series-6: #008300; --series-7: #9085e9; --series-8: #e66767;
  --from: #64748b; --to: #818cf8; --good-mark: #10b981; --bad-mark: #ef4444;`;

const CSS = `
:root { color-scheme: light; ${LIGHT} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; ${DARK} } }
:root[data-theme="dark"] { color-scheme: dark; ${DARK} }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--page); color: var(--text); font: 14px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif; }
main { max-width: 1240px; margin: 0 auto; padding: 0 16px 56px; }
code { font: 12.5px/1.4 "Cascadia Code", Consolas, ui-monospace, monospace; }

/* hero */
.hero { position: relative; margin: 0 -16px 28px; padding: 36px 32px 30px; color: #fff; overflow: hidden;
  background: linear-gradient(120deg, var(--hero-a), var(--hero-b)); border-radius: 0 0 22px 22px; }
.hero::after { content: ""; position: absolute; inset: -40% -10% auto auto; width: 520px; height: 520px; border-radius: 50%;
  background: radial-gradient(closest-side, rgba(255,255,255,.22), transparent); animation: drift 14s ease-in-out infinite alternate; }
@keyframes drift { to { transform: translate(-80px, 60px) scale(1.1); } }
.hero .eyebrow { text-transform: uppercase; letter-spacing: .14em; font-size: 12px; opacity: .85; font-weight: 600; }
.hero h1 { font: 700 32px/1.15 "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif; margin: 6px 0 8px; letter-spacing: -.01em; }
.hero .meta { opacity: .9; font-size: 13px; }
.hero .toggle { position: absolute; right: 24px; top: 24px; z-index: 1; border: 1px solid rgba(255,255,255,.4); background: rgba(255,255,255,.12);
  color: #fff; border-radius: 999px; padding: 6px 14px; cursor: pointer; font: inherit; backdrop-filter: blur(6px); }
.hero .toggle:hover { background: rgba(255,255,255,.22); }
.legend-chips { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
.legend-chips span { display: inline-flex; align-items: center; gap: 6px; background: rgba(255,255,255,.14); border-radius: 999px; padding: 3px 12px; font-size: 12.5px; }
.legend-chips i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.legend-chips .mcp i { background: #fff; } .legend-chips .plain i { background: rgba(255,255,255,.45); }

h2 { font: 650 20px/1.25 "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif; margin: 40px 0 6px; letter-spacing: -.01em; }
h3 { font-size: 12px; margin: 26px 0 10px; font-weight: 700; color: var(--text-2); text-transform: uppercase; letter-spacing: .08em; }
.lede { color: var(--text-2); margin: 0 0 14px; max-width: 900px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px; box-shadow: var(--shadow); }

/* verdict */
.verdict { display: grid; grid-template-columns: 1.45fr repeat(var(--rest, 3), minmax(0, 1fr)); gap: 14px; }
@media (max-width: 1080px) { .verdict { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 620px) { .verdict { grid-template-columns: 1fr; } }
.vcard { position: relative; overflow: hidden; }
.vcard .k { color: var(--text-2); font-size: 12.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
.vcard .big { font: 750 44px/1.05 "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif; margin: 8px 0 2px; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.vcard.lead .big { font-size: 56px; }
.vcard .vs { color: var(--text-2); font-size: 13px; }
.vcard .vs b { color: var(--text); font-variant-numeric: tabular-nums; }
.vcard::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 5px; background: var(--plain); }
.vcard.good::before { background: var(--good); } .vcard.bad::before { background: var(--bad); }
.vcard.good .big { color: var(--good); } .vcard.bad .big { color: var(--bad); }
.chip { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 2px 10px; font-size: 12.5px; font-weight: 650; font-variant-numeric: tabular-nums; white-space: nowrap; }
.chip.good { background: var(--good-soft); color: var(--good); } .chip.bad { background: var(--bad-soft); color: var(--bad); }
.chip.neutral { background: var(--plain-soft); color: var(--plain-ink); }
.pair-bars { margin-top: 12px; display: grid; gap: 6px; }
.pbar { display: grid; grid-template-columns: 84px 1fr 64px; align-items: center; gap: 8px; font-size: 12px; color: var(--text-2); }
.pbar .track { height: 10px; background: var(--surface-2); border-radius: 6px; overflow: hidden; border: 1px solid var(--border); }
.pbar .fill { height: 100%; width: var(--w); border-radius: 6px; background: var(--plain); }
.pbar.mcp .fill { background: linear-gradient(90deg, var(--mcp), var(--hero-b)); }
.pbar .v { text-align: right; font-variant-numeric: tabular-nums; color: var(--text); font-weight: 600; }
.sentence { margin: 16px 0 0; font-size: 15.5px; color: var(--text); background: var(--surface); border: 1px solid var(--border);
  border-left: 5px solid var(--mcp); border-radius: 12px; padding: 14px 18px; box-shadow: var(--shadow); }

/* scoreboard */
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--grid); vertical-align: middle; }
th { color: var(--text-2); font-weight: 650; white-space: nowrap; font-size: 12px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.board td { padding: 12px 10px; }
.board .prompt-cell b { display: block; font-size: 14px; }
.board .prompt-cell code { color: var(--muted); }
.duo { display: inline-grid; grid-template-columns: auto auto; gap: 4px 6px; align-items: center; }
.pill { display: inline-block; white-space: nowrap; min-width: 58px; text-align: center; border-radius: 8px; padding: 3px 8px; font-weight: 650; font-variant-numeric: tabular-nums; font-size: 12.5px; }
.pill.mcp { background: var(--mcp-soft); color: var(--mcp-ink); } .pill.plain { background: var(--plain-soft); color: var(--plain-ink); }
.pill.win { box-shadow: inset 0 0 0 2px var(--good); }
.pill .crown { margin-left: 4px; }
.scroll { overflow-x: auto; }

/* prompt switcher */
.filters { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 0; margin: 28px 0 0;
  background: color-mix(in srgb, var(--page) 88%, transparent); backdrop-filter: blur(8px); }
.filters .meta { color: var(--text-2); font-weight: 600; margin-right: 4px; }
.filters button { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 999px; padding: 6px 14px; cursor: pointer; font: inherit;
  transition: background .2s, color .2s, transform .15s; }
.filters button:hover { transform: translateY(-1px); }
.filters button[aria-pressed="true"] { background: var(--mcp); color: #fff; border-color: var(--mcp); }

/* prompt section */
section.prompt { margin-top: 36px; padding-top: 4px; }
.phead { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; justify-content: space-between; }
.phead h2 { margin: 0; }
.tagline { color: var(--muted); font-size: 12.5px; }
.tag { display: inline-block; border: 1px solid var(--border); background: var(--surface); border-radius: 999px; padding: 0 9px; font-size: 11.5px; margin: 2px 4px 2px 0; color: var(--text-2); }
.vgrid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 14px; margin-top: 14px; }
@media (max-width: 900px) { .vgrid { grid-template-columns: 1fr; } }
.vtable { display: grid; grid-template-columns: 150px 1fr 1fr 82px; gap: 0; align-items: center; }
.vtable > div { padding: 9px 8px; border-bottom: 1px solid var(--grid); }
.vtable .hd { font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--text-2); }
.vtable .hd.mcp { color: var(--mcp); } .vtable .hd.plain { color: var(--plain-ink); }
.vtable .metric { color: var(--text-2); font-size: 13px; }
.vtable .metric.key { color: var(--text); font-weight: 650; }
.vtable .metric.sub { padding-left: 24px; font-size: 12px; color: var(--muted); }
.vcell { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
.vcell .track { height: 8px; background: var(--surface-2); border-radius: 5px; overflow: hidden; }
.vcell .fill { height: 100%; width: var(--w); border-radius: 5px; background: var(--plain); }
.vcell.mcp .fill { background: var(--mcp); }
.vcell .v { font-variant-numeric: tabular-nums; font-weight: 650; min-width: 64px; text-align: right; }
.vcell.win .v { color: var(--good); }
.vcell.win .v::after { content: " ✓"; }
.row-key > div { background: color-mix(in srgb, var(--mcp-soft) 35%, transparent); }
.row-key .v { font-size: 16px; }

@media (max-width: 560px) {
  .vtable { grid-template-columns: 96px minmax(0, 1fr) minmax(0, 1fr) 62px; font-size: 12.5px; }
  .vcell { grid-template-columns: 1fr; } .vcell .track { display: none; } .vcell .v { min-width: 0; }
  .vtable > div { padding: 8px 4px; }
  .hero { padding: 26px 20px 22px; } .hero h1 { font-size: 26px; }
  .hero .toggle { position: static; margin-top: 14px; }
  .vcard .big { font-size: 38px; } .vcard.lead .big { font-size: 46px; }
  .pbar { grid-template-columns: 64px 1fr 56px; }
}
.heat { display: grid; grid-template-columns: minmax(0, 1fr) minmax(52px, 70px) minmax(52px, 70px); gap: 4px 6px; align-items: center; font-size: 12.5px; }
.heat .hd { font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--text-2); text-align: center; }
.heat .hd:first-child { text-align: left; }
.heat .name { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.heat .cell { text-align: center; border-radius: 6px; padding: 4px 0; font-weight: 650; font-variant-numeric: tabular-nums; }
.heat .c-full { background: var(--good-soft); color: var(--good); }
.heat .c-part { background: var(--warn-soft); color: var(--warn); }
.heat .c-none { background: var(--bad-soft); color: var(--bad); }
.heat .c-na { color: var(--muted); }
.issues { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 14px; }
@media (max-width: 760px) { .issues { grid-template-columns: 1fr; } }
.issues h4 { margin: 0 0 8px; font-size: 13px; }
.issues h4.mcp { color: var(--mcp); } .issues h4.plain { color: var(--plain-ink); }
.issues ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
.issues li { display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: start; font-size: 12.5px; }
.issues .n { background: var(--bad-soft); color: var(--bad); border-radius: 6px; padding: 0 7px; font-weight: 700; font-variant-numeric: tabular-nums; }
.issues .kind { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; margin-right: 4px; }
.issues .none { color: var(--good); font-weight: 600; }

/* KPI tiles (details) */
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 12px 0; }
.kpi .label { color: var(--text-2); font-size: 12px; }
.kpi .value { font-size: 24px; font-weight: 700; margin: 2px 0; font-variant-numeric: tabular-nums; }
.kpi .sub { color: var(--muted); font-size: 12px; }
.kpi.good .value { color: var(--good); } .kpi.bad .value { color: var(--bad); }

/* charts */
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 12px; }
.grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
@media (max-width: 480px) { .grid2, .grid3 { grid-template-columns: 1fr; } }
figure { margin: 0; }
figcaption { font-weight: 650; margin-bottom: 4px; }
figcaption small { color: var(--muted); font-weight: 400; margin-left: 6px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
@media (max-width: 760px) { .pair { grid-template-columns: 1fr; } }
.pair .panel-title, .panel-title { font-size: 12px; color: var(--text-2); margin: 4px 0; }
.empty { color: var(--muted); font-size: 12px; padding: 24px 0; text-align: center; border: 1px dashed var(--grid); border-radius: 8px; }
svg.chart { display: block; overflow: visible; }
svg .grid { stroke: var(--grid); stroke-width: 1; }
svg .axis { stroke: var(--axis); stroke-width: 1; }
svg .tick, svg .muted { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
svg .label { fill: var(--text); font-size: 12px; }
svg .value { fill: var(--text-2); font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
svg .connector { stroke: var(--axis); stroke-width: 2; stroke-linecap: round; }
svg .dot { stroke: var(--surface); stroke-width: 2; cursor: default; }
svg .dot:hover, svg .dot:focus { stroke: var(--text); outline: none; }
svg .dot.from { fill: var(--from); } svg .dot.to { fill: var(--to); }
svg .dot.clipped { stroke-width: 1.5; }
svg .bar.good { fill: var(--good-mark); } svg .bar.bad { fill: var(--bad-mark); } svg .bar.neutral { fill: var(--axis); }
svg .bar:hover, svg .bar:focus { opacity: .85; outline: none; }
svg .axis.zero { stroke: var(--muted); stroke-width: 1.5; }
svg .line { fill: none; stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }
svg .crosshair { stroke: var(--axis); stroke-width: 1; pointer-events: none; }
.s0 { stroke: var(--series-1); fill: var(--series-1); } .s1 { stroke: var(--series-2); fill: var(--series-2); }
.s2 { stroke: var(--series-3); fill: var(--series-3); } .s3 { stroke: var(--series-4); fill: var(--series-4); }
.s4 { stroke: var(--series-5); fill: var(--series-5); } .s5 { stroke: var(--series-6); fill: var(--series-6); }
.s6 { stroke: var(--series-7); fill: var(--series-7); } .s7 { stroke: var(--series-8); fill: var(--series-8); }
.s8 { stroke: var(--series-other); fill: var(--series-other); }
svg .line.s0, svg .line.s1, svg .line.s2, svg .line.s3, svg .line.s4, svg .line.s5, svg .line.s6, svg .line.s7, svg .line.s8 { fill: none; }
.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 0; margin: 6px 0 0; color: var(--text-2); font-size: 12px; }
.legend .key { display: inline-block; width: 18px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 6px; }
.legend .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; vertical-align: middle; margin-right: 6px; }
.swatch.from { background: var(--from); } .swatch.to { background: var(--to); }
.delta.good { color: var(--good); font-weight: 650; } .delta.bad { color: var(--bad); font-weight: 650; }
.warn { background: var(--warn-soft); border-left: 4px solid var(--warn); padding: 10px 14px; border-radius: 10px; margin: 10px 0; }
details { margin: 10px 0; }
summary { cursor: pointer; color: var(--text-2); }
details.more { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 4px 18px; margin-top: 18px; }
details.more > summary { font-weight: 650; padding: 12px 0; list-style: none; display: flex; align-items: center; gap: 8px; }
details.more > summary::before { content: "▸"; transition: transform .2s; display: inline-block; color: var(--mcp); }
details.more[open] > summary::before { transform: rotate(90deg); }
details.more[open] { padding-bottom: 18px; }
pre.prompt { white-space: pre-wrap; background: var(--surface-2); border: 1px solid var(--grid); border-radius: 10px; padding: 12px; font-size: 12.5px; }
.tip { position: fixed; z-index: 20; pointer-events: none; background: var(--text); color: var(--page); padding: 7px 10px; border-radius: 8px; font-size: 12px; max-width: 340px; display: none; box-shadow: var(--shadow); }
.tip b { font-weight: 600; } .tip .row { display: flex; gap: 8px; align-items: center; } .tip .k { display: inline-block; width: 12px; height: 2px; }
.excerpt { color: var(--text-2); font-size: 12px; max-width: 360px; }
.ok { color: var(--good); font-weight: 650; } .ko { color: var(--bad); font-weight: 650; }
footer { margin-top: 44px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--grid); padding-top: 14px; }
.hidden { display: none; }

/* motion — only with the script on, never under reduced motion */
.js .reveal { opacity: 0; transform: translateY(14px); transition: opacity .6s ease, transform .6s cubic-bezier(.2,.8,.2,1); }
.js .reveal.in { opacity: 1; transform: none; }
.js .reveal.in .fill { animation: grow 1.1s cubic-bezier(.2,.8,.2,1) both; }
.js .reveal.in svg .bar { animation: grow-x .9s cubic-bezier(.2,.8,.2,1) both; transform-box: fill-box; transform-origin: left center; }
.js .reveal.in svg .bar.neg { transform-origin: right center; }
.js .reveal.in svg .line { stroke-dasharray: 1600; animation: draw 1.4s ease-out both; }
@keyframes grow { from { width: 0; } }
@keyframes grow-x { from { transform: scaleX(0); } }
@keyframes draw { from { stroke-dashoffset: 1600; } to { stroke-dashoffset: 0; } }
.vcard { transition: transform .2s ease, box-shadow .2s ease; }
.vcard:hover { transform: translateY(-2px); }
@media (prefers-reduced-motion: reduce) {
  .js .reveal { opacity: 1; transform: none; transition: none; }
  .js .reveal.in .fill, .js .reveal.in svg .bar, .js .reveal.in svg .line { animation: none; }
  .hero::after { animation: none; } .vcard, .filters button { transition: none; }
}
`;

const JS = `
(function () {
  var root = document.documentElement;
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.classList.add('js');

  // Reveal on scroll; the bars inside grow, the numbers count up.
  function countUp(el) {
    var to = Number(el.getAttribute('data-to'));
    if (!isFinite(to) || still) return;
    var dec = Number(el.getAttribute('data-dec') || 0), pre = el.getAttribute('data-pre') || '', suf = el.getAttribute('data-suf') || '';
    var start = null, dur = 1100;
    function fmt(v) { var s = Math.abs(v).toFixed(dec); s = s.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','); return pre + (v < 0 ? '\\u2212' : '') + s + suf; }
    function step(ts) { if (start === null) start = ts; var k = Math.min(1, (ts - start) / dur); var e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(to * e); if (k < 1) requestAnimationFrame(step); else el.textContent = fmt(to); }
    requestAnimationFrame(step);
  }
  var revealed = function (el) { el.classList.add('in'); var n = el.querySelectorAll('[data-to]'); for (var i = 0; i < n.length; i++) countUp(n[i]); };
  var items = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !still) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { revealed(en.target); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px' });
    for (var r = 0; r < items.length; r++) { items[r].style.transitionDelay = (Math.min(r % 6, 5) * 60) + 'ms'; io.observe(items[r]); }
  } else { for (var r2 = 0; r2 < items.length; r2++) revealed(items[r2]); }

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
    for (var s = 0; s < sections.length; s++) {
      var hideIt = id !== '*' && sections[s].getAttribute('data-prompt') !== id;
      sections[s].classList.toggle('hidden', hideIt);
      if (!hideIt) { var rs = sections[s].querySelectorAll('.reveal'); for (var q = 0; q < rs.length; q++) revealed(rs[q]); }
    }
    try { localStorage.setItem('bench.prompt', id); } catch (err) {}
  }
  for (var b = 0; b < buttons.length; b++) buttons[b].addEventListener('click', function (e) { select(e.currentTarget.getAttribute('data-prompt')); });
  var saved = null; try { saved = localStorage.getItem('bench.prompt'); } catch (err) {}
  if (saved && document.querySelector('.filters button[data-prompt="' + saved.replace(/"/g, '') + '"]')) select(saved);
  var links = document.querySelectorAll('a[data-goto]');
  for (var l = 0; l < links.length; l++) links[l].addEventListener('click', function (e) { select(e.currentTarget.getAttribute('data-goto')); });

  // Theme toggle.
  var toggle = document.querySelector('.toggle');
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

// ---------------------------------------------------------------- formatting helpers

type Better = 'lower' | 'higher';

/** A number that counts up on reveal; the server-rendered text is the final value. */
function counter(value: number, text: string, dec: number, pre = '', suf = ''): string {
  return `<span data-to="${value.toFixed(dec)}" data-dec="${dec}" data-pre="${esc(pre)}" data-suf="${esc(suf)}">${esc(text)}</span>`;
}

const pctOf = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)} %`);
const num1 = (v: number | null) => (v === null ? '—' : v >= 10 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1));

/** Which side wins on a metric; null on a tie or when a side is missing. */
function winner(withV: number | null, withoutV: number | null, better: Better): 'with' | 'without' | null {
  if (withV === null || withoutV === null || withV === withoutV) return null;
  return (better === 'lower' ? withV < withoutV : withV > withoutV) ? 'with' : 'without';
}

function deltaChip(withV: number | null, withoutV: number | null, better: Better, mode: 'pct' | 'pp' | 'abs'): string {
  if (withV === null || withoutV === null) return '<span class="chip neutral">—</span>';
  let d: number;
  let text: string;
  if (mode === 'pp') {
    d = (withV - withoutV) * 100;
    text = `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(Math.round(d))} pp`;
  } else if (mode === 'abs') {
    d = withV - withoutV;
    text = `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d) >= 10 ? Math.round(Math.abs(d)) : Math.abs(d).toFixed(1)}`;
  } else {
    if (withoutV === 0) return '<span class="chip neutral">—</span>';
    d = ((withV - withoutV) / withoutV) * 100;
    text = formatDeltaPct(d);
  }
  if (Math.abs(d) < 1e-9) return `<span class="chip neutral">${esc(text)}</span>`;
  // The glyph marks the verdict, as everywhere on the page: ▼ better with MCP, ▲ worse.
  const good = better === 'lower' ? d < 0 : d > 0;
  return `<span class="chip ${good ? 'good' : 'bad'}">${good ? '▼' : '▲'} ${esc(text)}</span>`;
}

// ---------------------------------------------------------------- 1. verdict

interface VerdictMetric {
  key: string;
  label: string;
  better: Better;
  get: (q: VariantQuality) => number | null;
  show: (v: number | null) => string;
  mode: 'pct' | 'pp' | 'abs';
}

const VERDICT_METRICS: VerdictMetric[] = [
  { key: 'valid', label: 'Valid output', better: 'higher', get: q => q.validRate, show: pctOf, mode: 'pp' },
  { key: 'time', label: 'Run time (median)', better: 'lower', get: q => q.timeMs, show: v => formatMetric('durationMs', v), mode: 'pct' },
  { key: 'aic', label: 'Cost, AI Credits (median)', better: 'lower', get: q => q.aic, show: v => formatMetric('aic', v), mode: 'pct' },
  {
    key: 'rework', label: 'Rework per run', better: 'lower',
    get: q => (q.toolErrors === null && q.buildFailures === null ? null : (q.toolErrors ?? 0) + (q.buildFailures ?? 0) + (q.rewrites ?? 0)),
    show: num1, mode: 'abs',
  },
];

function pairBars(withV: number | null, withoutV: number | null, show: (v: number | null) => string): string {
  const max = Math.max(withV ?? 0, withoutV ?? 0) || 1;
  const bar = (cls: string, label: string, v: number | null) =>
    `<div class="pbar ${cls}"><span>${label}</span><div class="track"><div class="fill" style="--w:${v === null ? 0 : Math.max(2, (v / max) * 100).toFixed(1)}%"></div></div><span class="v">${esc(show(v))}</span></div>`;
  return `<div class="pair-bars">${bar('mcp', 'with MCP', withV)}${bar('plain', 'without', withoutV)}</div>`;
}

/**
 * A relative effect as the rest of the page computes it: per prompt (median
 * with vs median without, then median over models), then the median of those.
 * Pooling every run's time or cost across prompts instead mixes a 2-minute
 * prompt with an 8-minute one and can point the other way: on the first
 * reference run the pooled AIC said −6 % while every per-prompt view said +33 %.
 */
export interface PromptEffect {
  median: number;
  perPrompt: Array<{ title: string; delta: number }>;
}

export function promptEffects(m: ReportModel, metric: MetricKey): PromptEffect | null {
  const per = m.prompts
    .map(p => {
      const ds = p.modelEffects.map(r => r.deltas[metric]?.deltaPct).filter((d): d is number => typeof d === 'number');
      if (ds.length === 0) return null;
      const sorted = [...ds].sort((a, b) => a - b);
      const mid = sorted.length / 2;
      const d = sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
      return { title: p.title.replace(/^Reference \d+:\s*/, '').split(' — ')[0], delta: d };
    })
    .filter((x): x is { title: string; delta: number } => x !== null);
  if (per.length === 0) return null;
  const sorted = per.map(x => x.delta).sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return { median: sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2, perPrompt: per };
}

function effectCard(metric: VerdictMetric, effect: PromptEffect): string {
  const d = effect.median;
  const good = metric.better === 'lower' ? d < 0 : d > 0;
  const tone = Math.abs(d) < 1e-9 ? '' : good ? 'good' : 'bad';
  const chips = effect.perPrompt.map(x => {
    const g = metric.better === 'lower' ? x.delta < 0 : x.delta > 0;
    return `<div class="pbar"><span title="${esc(x.title)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.title)}</span><span></span><span class="chip ${Math.abs(x.delta) < 1e-9 ? 'neutral' : g ? 'good' : 'bad'}">${esc(formatDeltaPct(x.delta))}</span></div>`;
  });
  return `<div class="card vcard reveal${tone ? ` ${tone}` : ''}">
    <div class="k">${esc(metric.label.replace(' (median)', ''))}</div>
    <div class="big">${counter(d, formatDeltaPct(d), Math.abs(d) >= 10 ? 0 : 1, d > 0 ? '+' : '', ' %')}</div>
    <div class="vs">with MCP vs without · median of ${effect.perPrompt.length} per-prompt effect${effect.perPrompt.length === 1 ? '' : 's'}</div>
    <div class="pair-bars">${chips.join('')}</div>
  </div>`;
}

function verdictCard(metric: VerdictMetric, vs: Versus, lead: boolean, effect?: PromptEffect | null): string {
  if (effect && metric.mode === 'pct') return effectCard(metric, effect);
  const w = vs.with ? metric.get(vs.with) : null;
  const wo = vs.without ? metric.get(vs.without) : null;
  const win = winner(w, wo, metric.better);
  const tone = win === 'with' ? 'good' : win === 'without' ? 'bad' : '';
  let big: string;
  if (metric.key === 'valid' && w !== null) big = counter(w * 100, pctOf(w), 0, '', ' %');
  else if (metric.mode === 'pct' && w !== null && wo !== null && wo !== 0) {
    const d = ((w - wo) / wo) * 100;
    big = counter(d, formatDeltaPct(d), Math.abs(d) >= 10 ? 0 : 1, d > 0 ? '+' : '', ' %');
  } else if (metric.mode === 'abs' && w !== null && wo !== null) {
    const d = w - wo;
    big = counter(d, `${d > 0 ? '+' : d < 0 ? '−' : '±'}${num1(Math.abs(d))}`, Math.abs(d) >= 10 ? 0 : 1, d > 0 ? '+' : '');
  } else big = esc(metric.show(w));
  const sub = metric.key === 'valid'
    ? `with MCP vs <b>${esc(pctOf(wo))}</b> without · ${deltaChip(w, wo, 'higher', 'pp')}`
    : `with MCP vs without · <b>${esc(metric.show(w))}</b> vs <b>${esc(metric.show(wo))}</b>`;
  const n = metric.key === 'valid' && vs.with && vs.without
    ? `<div class="tagline">${Math.round((w ?? 0) * vs.with.judged)} of ${vs.with.judged} runs with MCP · ${Math.round((wo ?? 0) * vs.without.judged)} of ${vs.without.judged} without · builds clean, well-formed XML, no new BP errors</div>`
    : metric.key === 'rework'
      ? '<div class="tagline">tool errors + failed builds + rewrites of the same object, mean per run</div>'
      : '';
  return `<div class="card vcard reveal${lead ? ' lead' : ''}${tone ? ` ${tone}` : ''}">
    <div class="k">${esc(metric.label)}</div>
    <div class="big">${big}</div>
    <div class="vs">${sub}</div>
    ${pairBars(w, wo, metric.show)}
    ${n}
  </div>`;
}

/** One sentence that says what the numbers say, so nobody has to assemble it from tiles. */
export function verdictSentence(vs: Versus, effects: { time?: PromptEffect | null; aic?: PromptEffect | null } = {}): string {
  const w = vs.with, wo = vs.without;
  if (!w || !wo) return 'Run both variants to compare them — every number here is "with MCP relative to without".';
  const parts: string[] = [];
  if (w.validRate !== null && wo.validRate !== null) {
    parts.push(`With MCP, ${Math.round(w.validRate * w.judged)} of ${w.judged} runs delivered valid output, against ${Math.round(wo.validRate * wo.judged)} of ${wo.judged} without`);
  }
  const say = (d: number, word: [string, string]) =>
    Math.abs(d) < 3 ? `about as ${word[0] === 'longer' ? 'long' : 'much'}` : `${Math.abs(Math.round(d))} % ${d > 0 ? word[0] : word[1]}`;
  const rel = (a: number | null, b: number | null, word: [string, string], effect?: PromptEffect | null) => {
    if (effect) return say(effect.median, word);
    if (a === null || b === null || b === 0) return null;
    return say(((a - b) / b) * 100, word);
  };
  const time = rel(w.timeMs, wo.timeMs, ['longer', 'shorter'], effects.time);
  const cost = rel(w.aic, wo.aic, ['more', 'less'], effects.aic);
  const perPrompt = effects.time || effects.aic ? ' (median per prompt)' : '';
  if (time) parts.push(`it took ${time}`);
  if (cost) parts.push(`it cost ${cost}${perPrompt}`);
  const rw = (q: VariantQuality) => (q.toolErrors ?? 0) + (q.buildFailures ?? 0) + (q.rewrites ?? 0);
  if (w.toolErrors !== null && wo.toolErrors !== null) {
    parts.push(`and needed ${num1(rw(w))} repair step${rw(w) === 1 ? '' : 's'} per run against ${num1(rw(wo))}`);
  }
  if (parts.length === 0) return 'No comparable runs yet.';
  const s = parts.join(', ');
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

function verdictBlock(vs: Versus, scope: string, effects: { time?: PromptEffect | null; aic?: PromptEffect | null } = {}): string {
  if (!vs.with || !vs.without) return '<p class="lede">The verdict needs runs both with and without MCP.</p>';
  // A card neither side has data for (rework on records older than the trace) is left out, not drawn empty.
  const metrics = VERDICT_METRICS.filter(m => m.get(vs.with!) !== null || m.get(vs.without!) !== null);
  const effectOf = (key: string) => (key === 'time' ? effects.time : key === 'aic' ? effects.aic : null);
  return `<div class="verdict" style="--rest:${Math.max(1, metrics.length - 1)}">${metrics.map((m, i) => verdictCard(m, vs, i === 0 && m.key === 'valid', effectOf(m.key))).join('')}</div>
  <p class="sentence reveal">${esc(verdictSentence(vs, effects))} <span class="tagline">(${esc(scope)})</span></p>`;
}

// ---------------------------------------------------------------- 2. scoreboard

function duoCell(w: number | null, wo: number | null, better: Better, show: (v: number | null) => string): string {
  const win = winner(w, wo, better);
  const pill = (cls: string, v: number | null, isWin: boolean) =>
    `<span class="pill ${cls}${isWin ? ' win' : ''}">${esc(show(v))}${isWin ? '<span class="crown">✓</span>' : ''}</span>`;
  return `<td><span class="duo">${pill('mcp', w, win === 'with')}${pill('plain', wo, win === 'without')}</span></td>`;
}

function scoreboard(m: ReportModel): string {
  const rows = m.prompts.map(p => {
    const w = p.versus.with, wo = p.versus.without;
    const g = <T,>(q: VariantQuality | null, f: (q: VariantQuality) => T) => (q ? f(q) : null);
    const rework = (q: VariantQuality) => (q.toolErrors === null ? null : (q.toolErrors ?? 0) + (q.buildFailures ?? 0) + (q.rewrites ?? 0));
    return `<tr>
      <td class="prompt-cell"><a href="#p-${esc(p.promptId)}" data-goto="${esc(p.promptId)}" style="color:inherit;text-decoration:none"><b>${esc(p.title)}</b></a><code>${esc(p.promptId)}</code></td>
      ${duoCell(g(w, q => q.validRate), g(wo, q => q.validRate), 'higher', pctOf)}
      ${duoCell(g(w, q => q.checksMean), g(wo, q => q.checksMean), 'higher', v => (v === null ? '—' : `${Math.round(v)} %`))}
      ${duoCell(g(w, q => q.timeMs), g(wo, q => q.timeMs), 'lower', v => formatMetric('durationMs', v))}
      ${duoCell(g(w, q => q.aic), g(wo, q => q.aic), 'lower', v => formatMetric('aic', v))}
      ${duoCell(g(w, rework), g(wo, rework), 'lower', num1)}
    </tr>`;
  });
  return `<div class="card reveal scroll"><table class="board"><thead><tr><th>prompt</th><th>valid output</th><th>checks</th><th>run time</th><th>AIC</th><th>rework / run</th></tr></thead>
  <tbody>${rows.join('')}</tbody></table>
  <p class="tagline"><span class="pill mcp">with MCP</span> <span class="pill plain">without</span> · ✓ marks the better side · valid output = builds clean, well-formed XML, no new BP errors</p></div>`;
}

// ---------------------------------------------------------------- 3. per prompt

interface VsRow { label: string; key?: boolean; better: Better; get: (q: VariantQuality) => number | null; show: (v: number | null) => string; mode: 'pct' | 'pp' | 'abs' }

const VS_ROWS: VsRow[] = [
  { label: 'Valid output', key: true, better: 'higher', get: q => q.validRate, show: pctOf, mode: 'pp' },
  { label: 'Builds clean', better: 'higher', get: q => q.buildRate, show: pctOf, mode: 'pp' },
  { label: 'Checks passed', better: 'higher', get: q => (q.checksMean === null ? null : q.checksMean / 100), show: pctOf, mode: 'pp' },
  { label: 'Run time', better: 'lower', get: q => q.timeMs, show: v => formatMetric('durationMs', v), mode: 'pct' },
  { label: 'AI Credits', better: 'lower', get: q => q.aic, show: v => formatMetric('aic', v), mode: 'pct' },
  { label: 'Round trips', better: 'lower', get: q => q.turns, show: v => formatMetric('requests', v), mode: 'pct' },
  { label: 'Tool errors / run', better: 'lower', get: q => q.toolErrors, show: num1, mode: 'abs' },
  { label: '  of them MCP', better: 'lower', get: q => q.mcpToolErrors, show: num1, mode: 'abs' },
  { label: 'Failed builds / run', better: 'lower', get: q => q.buildFailures, show: num1, mode: 'abs' },
  { label: 'Rewrites / run', better: 'lower', get: q => q.rewrites, show: num1, mode: 'abs' },
  { label: 'New BP errors / run', better: 'lower', get: q => q.bpErrors, show: num1, mode: 'abs' },
  { label: 'New BP warnings / run', better: 'lower', get: q => q.bpWarnings, show: num1, mode: 'abs' },
];

function versusTable(vs: Versus): string {
  if (!vs.with && !vs.without) return '';
  const cells: string[] = ['<div class="hd"></div>', '<div class="hd mcp">with MCP</div>', '<div class="hd plain">without</div>', '<div class="hd">Δ</div>'];
  for (const row of VS_ROWS) {
    const w = vs.with ? row.get(vs.with) : null;
    const wo = vs.without ? row.get(vs.without) : null;
    if (w === null && wo === null) continue;
    const max = Math.max(w ?? 0, wo ?? 0) || 1;
    const win = winner(w, wo, row.better);
    const cell = (cls: string, v: number | null, isWin: boolean) =>
      `<div class="vcell ${cls}${isWin ? ' win' : ''}"><div class="track"><div class="fill" style="--w:${v === null ? 0 : Math.max(v === 0 ? 0 : 2, (v / max) * 100).toFixed(1)}%"></div></div><span class="v">${esc(row.show(v))}</span></div>`;
    const rowCells = [
      `<div class="metric${row.key ? ' key' : ''}${row.label.startsWith(' ') ? ' sub' : ''}">${esc(row.label.trim())}</div>`,
      cell('mcp', w, win === 'with'),
      cell('plain', wo, win === 'without'),
      `<div>${deltaChip(w, wo, row.better, row.mode)}</div>`,
    ];
    cells.push(row.key ? `<div class="row-key" style="display:contents">${rowCells.join('')}</div>` : rowCells.join(''));
  }
  return `<div class="card reveal"><h3 style="margin-top:0">With MCP vs without</h3><div class="vtable">${cells.join('')}</div>
  <p class="tagline">Rates are shares of runs; time, AIC and round trips are medians; rework and BP counts are means per run. ✓ marks the better side.</p></div>`;
}

function heatClass(rate: number | null): string {
  if (rate === null) return 'c-na';
  return rate >= 0.999 ? 'c-full' : rate <= 0.001 ? 'c-none' : 'c-part';
}

function checkHeat(rates: CheckRate[]): string {
  if (rates.length === 0) return '';
  const shorten = (n: string) => n.replace(/^file /, '').replace(/^matches /, 'answer ~ ').replace(/^avoids /, 'answer ≁ ');
  const rows = rates.map(r => `<div class="name" title="${esc(r.name)}">${esc(shorten(r.name))}</div>
    <div class="cell ${heatClass(r.withRate)}" data-tip="with MCP: ${esc(pctOf(r.withRate))} of runs passed">${esc(pctOf(r.withRate))}</div>
    <div class="cell ${heatClass(r.withoutRate)}" data-tip="without MCP: ${esc(pctOf(r.withoutRate))} of runs passed">${esc(pctOf(r.withoutRate))}</div>`);
  return `<div class="card reveal"><h3 style="margin-top:0">Checks — share of runs that passed</h3>
  <div class="heat"><div class="hd">check</div><div class="hd">MCP</div><div class="hd">plain</div>${rows.join('')}</div></div>`;
}

function issueList(issues: Issue[], cls: string, title: string): string {
  const body = issues.length === 0
    ? '<p class="none">No build error, malformed file or new BP error in any run.</p>'
    : `<ul>${issues.map(i => `<li><span class="n">${i.count}×</span><span><span class="kind">${i.kind === 'bp' ? 'BP' : i.kind}</span>${esc(i.text)}</span></li>`).join('')}</ul>`;
  return `<div><h4 class="${cls}">${esc(title)}</h4>${body}</div>`;
}

function issuesBlock(p: PromptSection): string {
  if (!p.versus.with?.judged && !p.versus.without?.judged) return '';
  return `<div class="card reveal"><h3 style="margin-top:0">What broke — recurring errors</h3><div class="issues">
    ${issueList(p.issues.with, 'mcp', 'with MCP')}${issueList(p.issues.without, 'plain', 'without MCP')}</div></div>`;
}

// ---------------------------------------------------------------- details (charts and tables)

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
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
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
    const build = r.build === undefined ? '—' : r.build === null ? '<span class="ko">nothing</span>' : r.build.ok ? '<span class="ok">clean</span>' : `<span class="ko" data-tip="${esc(r.build.errors.slice(0, 3).join(' | '))}">${r.build.errorCount} err</span>`;
    const bp = r.quality?.bp ? `${r.quality.bp.errors ? `<span class="ko">${r.quality.bp.errors} err</span>` : '<span class="ok">0 err</span>'} · ${r.quality.bp.warnings} warn` : '—';
    const rework = r.rework ? `${r.rework.toolErrors} / ${r.rework.buildFailures} / ${r.rework.rewrites}` : '—';
    return `<tr>
      <td>${esc(fmtTs(r.timestamp))}</td><td>${esc(r.model)}${r.host !== p.hosts[0] || p.hosts.length > 1 ? ` <span class="tagline">${esc(r.host)}</span>` : ''}</td>
      <td>${r.mcp ? '<span class="pill mcp">with</span>' : '<span class="pill plain">without</span>'}</td><td>${esc(r.outcome)}</td>
      <td class="num">${esc(formatMetric('durationMs', r.durationMs))}</td><td class="num">${r.requests}</td><td class="num">${esc(toolsNote)}</td>
      <td class="num">${esc(formatMetric('outputTokens', r.outputTokens))}</td><td class="num">${esc(formatMetric('aic', r.aic?.value ?? null))}</td>
      <td class="num">${r.score === null ? '—' : `${Math.round(r.score * 100)} %`}</td>
      <td>${build}</td><td>${bp}</td><td class="num" data-tip="tool errors / failed builds / rewrites">${rework}</td>
      <td><div class="excerpt">${extra}${r.resultExcerpt ? `${extra ? '<br>' : ''}<em>${esc(r.resultExcerpt.slice(0, 160))}${r.resultExcerpt.length > 160 ? '…' : ''}</em>` : ''}</div></td>
    </tr>`;
  });
  return `<div class="scroll"><table><thead><tr><th>when (UTC)</th><th>model</th><th>MCP</th><th>outcome</th><th class="num">time</th><th class="num">turns</th><th class="num">tools</th><th class="num">out tok</th><th class="num">AIC</th><th class="num">checks</th><th>build</th><th>BP (new)</th><th class="num">rework</th><th>label · notes · answer</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function dumbbells(p: PromptSection): string {
  const metricsShown: MetricKey[] = [...HEADLINE_METRICS];
  if (p.groups.some(g => g.metrics.score)) metricsShown.push('score');
  const charts = metricsShown.map(metric => {
    const def = METRIC_BY_KEY[metric];
    // One scale per host: a 17-minute editor session next to 30-second print
    // runs would push every other row onto the axis origin.
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
    return `<figure class="card reveal"><figcaption>${esc(def.label)}<small>median · ${def.better === 'lower' ? 'lower is better' : 'higher is better'}</small></figcaption>${facets.join('')}</figure>`;
  });
  return `<div class="grid2">${charts.join('')}</div>
  <ul class="legend"><li><span class="swatch from"></span>without MCP</li><li><span class="swatch to"></span>with MCP</li></ul>`;
}

function trends(p: PromptSection, slots: Map<string, number>): string {
  const blocks = HEADLINE_METRICS.map(metric => {
    const def = METRIC_BY_KEY[metric];
    const all = p.trends[metric];
    if (all.length === 0) return '';
    // One facet per host: a Copilot session and a headless claude run are not on one scale.
    const facets = p.hosts.map(host => {
      const mine = all.filter(s => s.host === host);
      if (mine.length === 0) return '';
      const tAll = mine.flatMap(s => s.raw.map(r => r.t));
      const tDomain: [number, number] = [Math.min(...tAll), Math.max(...tAll)];
      // The axis fits the daily medians; a run far above them is drawn clipped.
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
    return `<figure class="card reveal"><figcaption>${esc(def.label)}<small>daily median per model · dots are single runs</small></figcaption>${facets.join('')}</figure>`;
  });
  return blocks.join('');
}

const pct = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(Math.abs(v) >= 10 ? 0 : 1)} %`;

/**
 * One small multiple per metric, one bar per model, the bar being "with MCP
 * relative to without". Reads left to right as a scorecard.
 */
function effectBars(rows: ModelEffectRow[], hosts: string[], scope: string): string {
  if (rows.length === 0) {
    return '<p class="tagline">No model has runs both with and without MCP yet — the comparison needs both cells.</p>';
  }
  const metrics = EFFECT_METRICS.filter(k => rows.some(r => r.deltas[k]));
  // The host joins the row label only when the ROWS span more than one host.
  const rowHosts = new Set(rows.map(r => r.host));
  const label = (r: ModelEffectRow) => (rowHosts.size > 1 || (hosts.length > 1 && !rows.length) ? `${r.model} · ${r.host}` : r.model);
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
    return `<figure class="card reveal"><figcaption>${esc(def.label)}<small>${def.better === 'lower' ? 'less is better' : 'more is better'}</small></figcaption>${divergingBars({ rows: bars, title: `MCP effect on ${def.label}, ${scope}`, format: pct, extent })}</figure>`;
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
    // A delta cannot go below −100 %; above +200 % one bad day would flatten
    // every other line, so such a day is drawn clipped at the top edge.
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
    return `<figure class="card reveal"><figcaption>${esc(def.label)}<small>with MCP vs without, per day · ${def.better === 'lower' ? 'below zero is better' : 'above zero is better'}</small></figcaption>${svg}${legend(models)}</figure>`;
  }).filter(Boolean);
  if (blocks.length === 0) return '<p class="tagline">No day has both cells for a model yet — run both variants on the same day to get a point.</p>';
  return `<div class="grid2">${blocks.join('')}</div>`;
}

function promptSection(p: PromptSection, m: ReportModel): string {
  const promptText = p.spec ? `<details><summary>Prompt text</summary><pre class="prompt">${esc(p.spec.prompt)}</pre></details>` : '<p class="tagline">Prompt text not in the catalogue (eval/benchmark/prompts/).</p>';
  const drift = p.hashDrift
    ? `<div class="warn">⚠ The prompt text in the catalogue (hash ${esc(p.currentHash ?? '')}) differs from the one some of these runs used (${esc(p.hashes.filter(h => h !== p.currentHash).join(', '))}). Treat older runs as a different experiment.</div>`
    : '';
  const quality = `${versusTable(p.versus)}<div style="display:grid;gap:14px">${checkHeat(p.checkRates)}</div>`;
  return `<section class="prompt" data-prompt="${esc(p.promptId)}" id="p-${esc(p.promptId)}">
  <div class="phead"><h2>${esc(p.title)}</h2><div class="tagline">${p.runs.length} runs · ${esc(p.hosts.join(', '))}</div></div>
  <div class="tagline"><code>${esc(p.promptId)}</code> ${p.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
  ${drift}
  ${promptText}
  <div class="vgrid">${quality}</div>
  ${issuesBlock(p)}
  <h3>MCP effect per model</h3>
  ${effectBars(p.modelEffects, p.hosts, p.promptId)}
  <details class="more"><summary>Details — over time, absolute values, tables, every run</summary>
    ${kpiRow(p.kpis)}
    <h3>MCP effect over time</h3>
    ${effectTrends(p, m.slots)}
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
  return `<div class="scroll"><table><thead><tr><th>model</th><th>host</th><th>MCP</th><th class="num">runs</th><th class="num">prompts</th><th class="num">completed</th>${cols
    .map(c => `<th class="num">${esc(METRIC_BY_KEY[c].shortLabel)} <small>med</small></th>`)
    .join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

export function renderHtml(m: ReportModel): string {
  const filters = m.prompts.length > 1
    ? `<div class="filters"><span class="meta">Prompt</span><button data-prompt="*" aria-pressed="true">All</button>${m.prompts
        .map(p => `<button data-prompt="${esc(p.promptId)}" aria-pressed="false">${esc(p.title.replace(/^Reference \d+:\s*/, '').split(' — ')[0])}</button>`)
        .join('')}</div>`
    : '';
  const body = m.runsTotal === 0
    ? '<div class="card empty">No runs match. Record one with <code>d365fo-mcp benchmark run</code> or <code>benchmark ingest</code>.</div>'
    : `<h2 style="margin-top:8px">Verdict</h2>
  <p class="lede">Does the D365FO MCP server get the job done — valid output that builds and passes best practice — and what does that cost in time, credits and repair work? All prompts, all models.</p>
  ${verdictBlock(m.versus, 'all prompts', { time: promptEffects(m, 'durationMs'), aic: promptEffects(m, 'aic') })}
  ${m.prompts.length > 1 ? `<h2>Per prompt</h2><p class="lede">The same comparison for each use-case. Click a prompt to jump to its detail.</p>${scoreboard(m)}` : ''}
  <h2>MCP effect per model</h2>
  <p class="lede">With MCP relative to without, per model — a bar to the left of zero is a saving (or, for checks, a loss).</p>
  ${effectBars(m.overviewEffects, m.hosts, 'all prompts')}
  <details class="more"><summary>All prompts, medians per model</summary>${kpiRow(m.overviewKpis)}<div class="card">${overviewTable(m)}</div></details>
  ${filters}
  ${m.prompts.map(p => promptSection(p, m)).join('\n')}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.title)}</title>
<meta name="description" content="Model × MCP benchmark: valid output, run time, AI Credits and rework per model, with and without the D365FO MCP server, over time.">
<style>${CSS}</style>
</head>
<body>
<main>
<header class="hero">
  <div class="eyebrow">D365FO MCP benchmark</div>
  <h1>${esc(m.title)}</h1>
  <div class="meta">Generated ${esc(fmtTs(m.generatedAt))} UTC · ${m.runsTotal} runs · ${m.prompts.length} prompt${m.prompts.length === 1 ? '' : 's'} · ${esc(m.models.join(', ') || 'no models')}${m.span ? ` · ${esc(m.span.from.slice(0, 10))} → ${esc(m.span.to.slice(0, 10))}` : ''}${m.filters.length ? ` · filters: ${esc(m.filters.join(', '))}` : ''}${m.skippedFiles ? ` · <b>${m.skippedFiles} unreadable record file(s) skipped</b>` : ''}</div>
  <div class="legend-chips"><span class="mcp"><i></i>with MCP</span><span class="plain"><i></i>without MCP</span><span>▼ green = better with MCP · ▲ red = worse</span></div>
  <button class="toggle" type="button">Light / dark</button>
</header>
${body}
<footer>
  <p><b>AIC = AI Credits.</b> ${m.creditsNotes.length ? esc(m.creditsNotes.join(' · ')) : 'No priced runs.'} Rates live in <code>eval/benchmark/credits.json</code>.</p>
  <p><b>Valid output</b> = the sandbox builds clean after the run (xppc, full), every written XML file parses, and xppbp reports no best-practice error the clean sandbox did not already have. <b>Rework</b> = tool calls that came back as errors, builds that failed inside the run, and writes to an object it had already written.</p>
  <p>Costs are medians (p90 in the tables), rates are shares of runs. A cell is one (prompt, host, model, with/without MCP). Every chart's numbers are in a table under Details.</p>
</footer>
</main>
<script>${JS}</script>
</body>
</html>
`;
}
