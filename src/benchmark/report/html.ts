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
import type { ConfigKey, ConfigRow, Issue, Kpi, ModelLift, PromptSection, ReportModel, Scope, VariantQuality } from './model.js';
import { divergingBars, dumbbellChart, esc, legend, liftScatter, lineChart, type DivergingRow, type DumbbellRow, type LiftPoint, type LiftSeries, type LineSeries } from './svg.js';

const LIGHT = `
  --page: #f4f5f9; --surface: #ffffff; --surface-2: #f8f9fc; --text: #0f1222; --text-2: #4a4f66; --muted: #858aa0;
  --grid: #e4e6ef; --axis: #c5c9d8; --border: rgba(15,18,34,0.08); --shadow: 0 1px 2px rgba(15,18,34,.04), 0 8px 24px rgba(15,18,34,.06);
  --mcp: #4f46e5; --mcp-soft: #e0e7ff; --mcp-ink: #3730a3; --plain: #94a3b8; --plain-soft: #eef1f6; --plain-ink: #475569;
  --good: #047857; --good-soft: #d1fae5; --bad: #b91c1c; --bad-soft: #fee2e2; --warn: #b45309; --warn-soft: #fef3c7;
  --hero-a: #4f46e5; --hero-b: #0ea5e9;
  --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100;
  --series-5: #e87ba4; --series-6: #008300; --series-7: #4a3aa7; --series-8: #e34948; --series-other: #898781;
  --from: #a5b4c8; --to: #4f46e5; --good-mark: #10b981; --bad-mark: #ef4444;
  --seq-0: #eceae6; --seq-1: #cde2fb; --seq-2: #86b6ef; --seq-3: #2a78d6; --seq-4: #184f95;
  --seq-ink-0: #52514e; --seq-ink-1: #0d366b; --seq-ink-2: #0d366b;`;
const DARK = `
  --page: #0b0d17; --surface: #141726; --surface-2: #1a1e30; --text: #f3f4fa; --text-2: #b6bad0; --muted: #7c8199;
  --grid: #262a3f; --axis: #383d58; --border: rgba(255,255,255,0.08); --shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px rgba(0,0,0,.35);
  --mcp: #818cf8; --mcp-soft: #262a5c; --mcp-ink: #c7d2fe; --plain: #64748b; --plain-soft: #1f2436; --plain-ink: #cbd5e1;
  --good: #34d399; --good-soft: #0b3a2c; --bad: #f87171; --bad-soft: #43171a; --warn: #fbbf24; --warn-soft: #3a2a0a;
  --hero-a: #6366f1; --hero-b: #0891b2;
  --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
  --series-5: #d55181; --series-6: #008300; --series-7: #9085e9; --series-8: #e66767;
  --from: #64748b; --to: #818cf8; --good-mark: #10b981; --bad-mark: #ef4444;
  --seq-0: #262624; --seq-1: #104281; --seq-2: #1c5cab; --seq-3: #2a78d6; --seq-4: #3987e5;
  --seq-ink-0: #9a9890; --seq-ink-1: #cde2fb; --seq-ink-2: #e8f1fd;`;

const CSS = `
:root { color-scheme: light; ${LIGHT} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; ${DARK} } }
:root[data-theme="dark"] { color-scheme: dark; ${DARK} }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--page); color: var(--text); font: 14px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif; }
main { max-width: 1240px; margin: 0 auto; padding: 0 16px 56px; }
code { font: 12.5px/1.4 "Cascadia Code", Consolas, ui-monospace, monospace; }

/* hero — a dark band in both themes, the way leaderboard pages open */
.hero { position: relative; color: #e8ebf7; overflow: hidden; background: #0b1020;
  background-image: radial-gradient(900px 420px at 85% -10%, rgba(99,102,241,.35), transparent 60%), radial-gradient(700px 380px at 5% 110%, rgba(14,165,233,.22), transparent 60%),
    linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px);
  background-size: auto, auto, 32px 32px, 32px 32px; border-bottom: 1px solid rgba(255,255,255,.08); }
.hero-in { position: relative; max-width: 1240px; margin: 0 auto; padding: 44px 16px 34px; }
.hero .eyebrow { text-transform: uppercase; letter-spacing: .16em; font-size: 11.5px; color: #a5b4fc; font-weight: 700; }
.hero h1 { font: 750 38px/1.1 "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif; margin: 10px 0 10px; letter-spacing: -.02em; color: #fff; }
.hero-lede { max-width: 780px; margin: 0 0 22px; color: #c3c8e0; font-size: 15.5px; }
.hstats { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
.hstat { display: grid; padding: 10px 16px; border: 1px solid rgba(255,255,255,.1); border-radius: 12px; background: rgba(255,255,255,.04); min-width: 104px; }
.hstat b { font: 750 26px/1.1 "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif; color: #fff; font-variant-numeric: tabular-nums; }
.hstat > span { font-size: 12px; color: #9aa1c0; }
.hero .meta { font-size: 12.5px; color: #8f96b5; }
.hero .toggle { position: absolute; right: 16px; top: 22px; border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.06);
  color: #e8ebf7; border-radius: 999px; padding: 6px 14px; cursor: pointer; font: inherit; font-size: 12.5px; }
.hero .toggle:hover { background: rgba(255,255,255,.14); }
main { padding-top: 8px; }

h2 { font: 650 21px/1.25 "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif; margin: 42px 0 6px; letter-spacing: -.01em; }
h3 { font-size: 12px; margin: 26px 0 10px; font-weight: 700; color: var(--text-2); text-transform: uppercase; letter-spacing: .08em; }
.lede { color: var(--text-2); margin: 0 0 14px; max-width: 900px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px; box-shadow: var(--shadow); }
.chip { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 2px 9px; font-size: 12px; font-weight: 650; font-variant-numeric: tabular-nums; white-space: nowrap; }
.chip.good { background: var(--good-soft); color: var(--good); } .chip.bad { background: var(--bad-soft); color: var(--bad); }
.chip.neutral { background: var(--plain-soft); color: var(--plain-ink); }

/* suite tabs */
.tabs { position: sticky; top: 0; z-index: 6; display: flex; gap: 4px; margin: 22px 0 0; padding: 10px 0; background: color-mix(in srgb, var(--page) 90%, transparent); backdrop-filter: blur(8px); }
.tabs button { border: 1px solid var(--border); background: var(--surface); color: var(--text-2); border-radius: 10px; padding: 8px 16px; cursor: pointer; font: inherit; font-weight: 600; }
.tabs button small { color: var(--muted); font-weight: 500; margin-left: 4px; }
.tabs button[aria-selected="true"] { background: var(--text); color: var(--page); border-color: var(--text); }
.tabs button[aria-selected="true"] small { color: inherit; opacity: .7; }

/* model identity */
.sw { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: currentColor; flex: none; }
.sw.hollow { background: transparent; box-shadow: inset 0 0 0 2px currentColor; }
.sw.s0 { color: var(--series-1); } .sw.s1 { color: var(--series-2); } .sw.s2 { color: var(--series-3); } .sw.s3 { color: var(--series-4); }
.sw.s4 { color: var(--series-5); } .sw.s5 { color: var(--series-6); } .sw.s6 { color: var(--series-7); } .sw.s7 { color: var(--series-8); } .sw.s8 { color: var(--series-other); }
.cfg { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
.cfg b { font-weight: 650; }
.cfg small { color: var(--muted); }
.badge { display: inline-block; border-radius: 6px; padding: 1px 7px; font-size: 11px; font-weight: 700; letter-spacing: .02em; }
.badge.mcp { background: var(--mcp-soft); color: var(--mcp-ink); } .badge.plain { background: var(--plain-soft); color: var(--plain-ink); }

/* MCP lift per model */
.lifts { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
.lift { position: relative; overflow: hidden; border-top: 4px solid var(--c); }
.lift-head { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; }
.lift-head .sw { width: 12px; height: 12px; }
.lift-head small { color: var(--muted); font-weight: 500; }
.lift-big { font: 780 56px/1 "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif; margin: 14px 0 2px; letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
.lift-big .na { font-size: 18px; font-weight: 600; color: var(--muted); letter-spacing: 0; }
.lift-big .unit { font-size: 22px; margin-left: 4px; color: var(--text-2); font-weight: 650; }
.lift.good .lift-big { color: var(--good); } .lift.bad .lift-big { color: var(--bad); }
.lift-sub { color: var(--text-2); font-size: 13px; margin-bottom: 12px; }
.lrows { display: grid; gap: 0; border-top: 1px solid var(--grid); }
.lrow { display: grid; grid-template-columns: minmax(0, 1fr) auto 86px; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--grid); font-size: 13px; }
.lrow .lk { color: var(--text-2); }
.lrow .lv { font-variant-numeric: tabular-nums; white-space: nowrap; }
.lrow .lv .from { color: var(--muted); } .lrow .lv .arr { color: var(--muted); margin: 0 6px; }
.lrow .chip { justify-self: end; }
.lift-sentence { margin: 12px 0 0; color: var(--text-2); font-size: 13px; }

/* leaderboard */
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--grid); vertical-align: middle; }
th { color: var(--text-2); font-weight: 650; white-space: nowrap; font-size: 12px; }
th small { color: var(--muted); font-weight: 500; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.muted { color: var(--muted); }
td.best { font-weight: 750; color: var(--text); }
td.em { font-weight: 650; }
.scroll { overflow-x: auto; }
.board-card { margin-top: 4px; padding: 6px 18px 14px; }
.leader td { padding: 13px 10px; }
.leader.compact td { padding: 9px 10px; }
.leader .rk span { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); font-weight: 750; font-variant-numeric: tabular-nums; }
.leader .rank-1 .rk span { background: linear-gradient(135deg, #fde68a, #f59e0b); color: #3b2300; border: 0; }
.leader .rank-2 .rk span { background: linear-gradient(135deg, #e5e7eb, #9ca3af); color: #1f2937; border: 0; }
.leader .rank-3 .rk span { background: linear-gradient(135deg, #fed7aa, #c2410c); color: #fff; border: 0; }
.leader .rank-1 td { background: color-mix(in srgb, var(--mcp-soft) 30%, transparent); }
.score { min-width: 240px; display: grid; grid-template-columns: minmax(110px, 1fr) auto; grid-template-rows: auto auto; column-gap: 10px; align-items: center; }
.score small { grid-column: 1 / -1; color: var(--muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.sbar { position: relative; height: 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 7px; }
.sbar .fill { height: 100%; width: var(--w); border-radius: 6px; background: var(--c); }
.sbar.hatched .fill { background: repeating-linear-gradient(135deg, var(--c) 0 3px, color-mix(in srgb, var(--c) 35%, transparent) 3px 6px); }
.sbar .ci { position: absolute; top: 50%; height: 2px; margin-top: -1px; background: var(--text); opacity: .55; border-radius: 1px; }
.sbar .ci::before, .sbar .ci::after { content: ""; position: absolute; top: -4px; width: 2px; height: 10px; background: var(--text); }
.sbar .ci::before { left: 0; } .sbar .ci::after { right: 0; }
.sv { font: 750 18px/1 "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif; font-variant-numeric: tabular-nums; min-width: 52px; text-align: right; }

/* success vs cost */
figure.card { margin-top: 14px; }
svg .pt { stroke: var(--surface); stroke-width: 2; cursor: default; }
svg .pt.hollow { fill: var(--surface) !important; stroke-width: 2.5; }
svg .pt.hollow.s0 { stroke: var(--series-1); } svg .pt.hollow.s1 { stroke: var(--series-2); } svg .pt.hollow.s2 { stroke: var(--series-3); }
svg .pt.hollow.s3 { stroke: var(--series-4); } svg .pt.hollow.s4 { stroke: var(--series-5); } svg .pt.hollow.s5 { stroke: var(--series-6); }
svg .pt.hollow.s6 { stroke: var(--series-7); } svg .pt.hollow.s7 { stroke: var(--series-8); } svg .pt.hollow.s8 { stroke: var(--series-other); }
svg .pt:hover, svg .pt:focus { stroke: var(--text); outline: none; }
svg .lift-arrow { fill: none; stroke-width: 2; stroke-dasharray: 5 4; }
.swatch.ring { box-shadow: inset 0 0 0 2px var(--text-2); background: transparent; }
.swatch.solid { background: var(--text-2); }
.legend .swatch.s0 { background: var(--series-1); } .legend .swatch.s1 { background: var(--series-2); } .legend .swatch.s2 { background: var(--series-3); }
.legend .swatch.s3 { background: var(--series-4); } .legend .swatch.s4 { background: var(--series-5); } .legend .swatch.s5 { background: var(--series-6); }
.legend .swatch.s6 { background: var(--series-7); } .legend .swatch.s7 { background: var(--series-8); } .legend .swatch.s8 { background: var(--series-other); }

/* tasks × configurations */
.matrix th.mx-h { text-align: center; vertical-align: bottom; }
.matrix th.mx-h .cfg { flex-direction: column; gap: 4px; }
.matrix td.mx { text-align: center; min-width: 96px; border-left: 2px solid var(--surface); }
.matrix td.mx b { display: block; font-size: 15px; font-variant-numeric: tabular-nums; }
.matrix td.mx small { display: block; font-size: 11px; opacity: .85; font-variant-numeric: tabular-nums; }
.matrix .v0 { background: var(--seq-0); color: var(--seq-ink-0); } .matrix .v1 { background: var(--seq-1); color: var(--seq-ink-1); }
.matrix .v2 { background: var(--seq-2); color: var(--seq-ink-2); } .matrix .v3 { background: var(--seq-3); color: #fff; } .matrix .v4 { background: var(--seq-4); color: #fff; }
.matrix .na { color: var(--muted); }
.matrix .mx-task a { color: var(--text); text-decoration: none; font-weight: 600; }
.matrix .mx-task a:hover { text-decoration: underline; }
.matrix tr.mx-suite td { background: var(--surface-2); color: var(--text-2); font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; padding: 6px 10px; }

/* methodology */
.method { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
.method h4 { margin: 0 0 6px; font-size: 14px; }
.method p { margin: 0; color: var(--text-2); font-size: 13px; }

/* task switcher */
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
  .hero-in { padding: 28px 16px 22px; } .hero h1 { font-size: 27px; }
  .hero .toggle { position: static; margin-top: 14px; }
  .hstat { min-width: 0; flex: 1 1 40%; } .lift-big { font-size: 44px; }
  .lifts { grid-template-columns: 1fr; } .lrow { grid-template-columns: minmax(0, 1fr) auto; } .lrow .chip { grid-column: 2; }
}
.heat { display: grid; grid-template-columns: minmax(0, 1fr) minmax(52px, 70px) minmax(52px, 70px); gap: 4px 6px; align-items: center; font-size: 12.5px; }
.heat .hd { font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--text-2); text-align: center; }
.heat .hd:first-child { text-align: left; }
.heat .hd .sw { margin-right: 5px; vertical-align: -1px; }
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
.lift, .leader tbody tr { transition: transform .2s ease, box-shadow .2s ease, background .2s; }
.lift:hover { transform: translateY(-2px); }
.leader tbody tr:hover td { background: var(--surface-2); }
@media (prefers-reduced-motion: reduce) {
  .js .reveal { opacity: 1; transform: none; transition: none; }
  .js .reveal.in .fill, .js .reveal.in svg .bar, .js .reveal.in svg .line { animation: none; }
  .lift, .leader tbody tr, .filters button { transition: none; }
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

  // Suite tabs: switch the leaderboard pane, and show only that suite's tasks below.
  var tabs = document.querySelectorAll('.tabs button[data-scope]');
  function scope(id) {
    for (var t = 0; t < tabs.length; t++) tabs[t].setAttribute('aria-selected', String(tabs[t].getAttribute('data-scope') === id));
    var panes = document.querySelectorAll('.scope-pane');
    for (var p = 0; p < panes.length; p++) {
      var on = panes[p].getAttribute('data-scope') === id;
      panes[p].classList.toggle('hidden', !on);
      if (on) { var rs2 = panes[p].querySelectorAll('.reveal'); for (var q2 = 0; q2 < rs2.length; q2++) revealed(rs2[q2]); }
    }
    var suited = document.querySelectorAll('.matrix tr[data-suite], .filters button[data-suite]');
    for (var s2 = 0; s2 < suited.length; s2++) suited[s2].classList.toggle('hidden', id !== 'all' && suited[s2].getAttribute('data-suite') !== id);
    select('*');
    var secs = document.querySelectorAll('section.prompt');
    for (var s3 = 0; s3 < secs.length; s3++) if (id !== 'all' && secs[s3].getAttribute('data-suite') !== id) secs[s3].classList.add('hidden');
    try { localStorage.setItem('bench.scope', id); } catch (err) {}
  }
  for (var t2 = 0; t2 < tabs.length; t2++) tabs[t2].addEventListener('click', function (e) { scope(e.currentTarget.getAttribute('data-scope')); });
  var savedScope = null; try { savedScope = localStorage.getItem('bench.scope'); } catch (err) {}
  if (savedScope && document.querySelector('.tabs button[data-scope="' + savedScope.replace(/"/g, '') + '"]')) scope(savedScope);

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
/** AIC per valid output; null means no run of that side was valid, so no price can be put on a result. */
const perValidOf = (v: number | null) => (v === null ? 'no valid run' : formatMetric('aic', v));

// ---------------------------------------------------------------- 1. leaderboard

/** "claude-sonnet-5-5" → "Sonnet 5.5"; any other id as it is. */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)(?:-.*)?$/i.exec(id);
  return m ? `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

const slotOf = (m: ReportModel, model: string) => m.slots.get(model) ?? 8;

function configLabel(m: ReportModel, c: ConfigKey, withHost: boolean): string {
  return `<span class="cfg"><span class="sw s${slotOf(m, c.model)}${c.mcp ? '' : ' hollow'}"></span><b>${esc(modelName(c.model))}</b>${
    c.mcp ? '<span class="badge mcp">MCP</span>' : '<span class="badge plain">no MCP</span>'}${withHost ? `<small>${esc(c.host)}</small>` : ''}</span>`;
}

const deltaPctOf = (w: number | null, wo: number | null) => (w === null || wo === null || wo === 0 ? null : ((w - wo) / wo) * 100);

/** "+78 pp" / "−70 %" chip, green when MCP is better, red when worse. */
function liftChip(d: number | null, better: Better, unit: '%' | 'pp' | 'abs'): string {
  if (d === null || !Number.isFinite(d)) return '<span class="chip neutral">—</span>';
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
  const text = unit === 'pp' ? `${sign}${Math.abs(Math.round(d))} pp` : unit === 'abs' ? `${sign}${num1(Math.abs(d))}` : formatDeltaPct(d);
  if (Math.abs(d) < (unit === 'abs' ? 0.05 : 0.5)) return `<span class="chip neutral">${esc(text)}</span>`;
  const good = better === 'lower' ? d < 0 : d > 0;
  // The arrow says which way the number moved, the colour whether that is better.
  return `<span class="chip ${good ? 'good' : 'bad'}">${d > 0 ? '↑' : '↓'} ${esc(text)}</span>`;
}

const reworkOf = (q: VariantQuality) => (q.toolErrors === null && q.buildFailures === null ? null : (q.toolErrors ?? 0) + (q.buildFailures ?? 0) + (q.rewrites ?? 0));

/** One sentence per model, so nobody has to assemble the finding from tiles. */
export function liftSentence(l: ModelLift): string {
  const name = modelName(l.model);
  const w = l.with, wo = l.without;
  if (!w || !wo) return `${name}: run both variants to compare them.`;
  const parts: string[] = [];
  if (w.q.judged && wo.q.judged) {
    parts.push(`${name} delivered valid output in ${w.validCount} of ${w.q.judged} runs with MCP against ${wo.validCount} of ${wo.q.judged} without`);
  } else {
    parts.push(`${name} passed ${pctOf(w.q.checksMean === null ? null : w.q.checksMean / 100)} of the checks with MCP against ${pctOf(wo.q.checksMean === null ? null : wo.q.checksMean / 100)} without`);
  }
  if (w.q.aicPerValid !== null && (wo.q.aicPerValid !== null || wo.q.validRate === 0)) {
    parts.push(wo.q.aicPerValid === null
      ? `at ${formatMetric('aic', w.q.aicPerValid)} AIC per valid output (none without)`
      : `at ${formatMetric('aic', w.q.aicPerValid)} vs ${formatMetric('aic', wo.q.aicPerValid)} AIC per valid output`);
  }
  const t = deltaPctOf(w.q.timeMs, wo.q.timeMs);
  if (t !== null) parts.push(Math.abs(t) < 3 ? 'in about the same time' : `in ${Math.abs(Math.round(t))} % ${t > 0 ? 'more' : 'less'} time`);
  return `${parts.join(', ')}.`;
}

function liftCards(m: ReportModel, scope: Scope): string {
  const withHost = new Set(scope.lifts.map(l => l.host)).size > 1;
  const cards = scope.lifts.map(l => {
    const w = l.with?.q ?? null, wo = l.without?.q ?? null;
    const judged = Boolean(w?.judged || wo?.judged);
    const headline = judged
      ? (w?.validRate ?? null) !== null && (wo?.validRate ?? null) !== null ? (w!.validRate! - wo!.validRate!) * 100 : null
      : w?.checksMean != null && wo?.checksMean != null ? w.checksMean - wo.checksMean : null;
    const row = (label: string, a: string, b: string, chip: string) =>
      `<div class="lrow"><span class="lk">${esc(label)}</span><span class="lv"><span class="from">${esc(a)}</span><span class="arr">→</span><b>${esc(b)}</b></span>${chip}</div>`;
    const rows = [
      judged
        ? row('Valid output', pctOf(wo?.validRate ?? null), pctOf(w?.validRate ?? null), liftChip(headline, 'higher', 'pp'))
        : '',
      row('Checks passed', pctOf(wo?.checksMean != null ? wo.checksMean / 100 : null), pctOf(w?.checksMean != null ? w.checksMean / 100 : null),
        liftChip(w?.checksMean != null && wo?.checksMean != null ? w.checksMean - wo.checksMean : null, 'higher', 'pp')),
      judged ? row('AIC per valid output', perValidOf(wo?.aicPerValid ?? null), perValidOf(w?.aicPerValid ?? null), liftChip(deltaPctOf(w?.aicPerValid ?? null, wo?.aicPerValid ?? null), 'lower', '%')) : '',
      row('AIC per run', formatMetric('aic', l.without?.aicMean ?? null), formatMetric('aic', l.with?.aicMean ?? null), liftChip(deltaPctOf(l.with?.aicMean ?? null, l.without?.aicMean ?? null), 'lower', '%')),
      row('Time, median', formatMetric('durationMs', wo?.timeMs ?? null), formatMetric('durationMs', w?.timeMs ?? null), liftChip(deltaPctOf(w?.timeMs ?? null, wo?.timeMs ?? null), 'lower', '%')),
      w && wo && reworkOf(w) !== null && reworkOf(wo) !== null
        ? row('Rework per run', num1(reworkOf(wo)), num1(reworkOf(w)), liftChip(reworkOf(w)! - reworkOf(wo)!, 'lower', 'abs'))
        : '',
    ].join('');
    const tone = headline === null || Math.abs(headline) < 0.5 ? '' : headline > 0 ? ' good' : ' bad';
    const big = headline === null ? '<span class="na">waiting for both variants</span>' : counter(headline, `${headline > 0 ? '+' : headline < 0 ? '−' : '±'}${Math.abs(Math.round(headline))}`, 0, headline > 0 ? '+' : '', '');
    return `<article class="card lift reveal${tone}" style="--c: var(--series-${slotOf(m, l.model) + 1}, var(--series-other))">
      <div class="lift-head"><span class="sw s${slotOf(m, l.model)}"></span>${esc(modelName(l.model))}${withHost ? ` <small>${esc(l.host)}</small>` : ''}</div>
      <div class="lift-big">${big}${headline === null ? '' : '<span class="unit">pp</span>'}</div>
      <div class="lift-sub">${judged ? 'valid output' : 'checks passed'} with the MCP server, percentage points</div>
      <div class="lrows">${rows}</div>
      <p class="lift-sentence">${esc(liftSentence(l))}</p>
    </article>`;
  });
  return `<div class="lifts">${cards.join('')}</div>`;
}

function leaderboard(m: ReportModel, scope: Scope): string {
  const withHost = new Set(scope.configs.map(c => c.host)).size > 1;
  const judged = scope.configs.some(c => c.q.judged > 0);
  const best = (f: (c: ConfigRow) => number | null, better: Better) => {
    const vs = scope.configs.map(f).filter((v): v is number => v !== null);
    return vs.length ? (better === 'lower' ? Math.min(...vs) : Math.max(...vs)) : null;
  };
  const bestPerValid = best(c => c.q.aicPerValid, 'lower');
  const bestAic = best(c => c.aicMean, 'lower');
  const bestTime = best(c => c.q.timeMs, 'lower');
  const mark = (v: number | null, b: number | null) => (v !== null && b !== null && Math.abs(v - b) < 1e-9 ? ' best' : '');
  const rows = scope.configs.map((c, i) => {
    const rate = judged ? c.q.validRate : c.q.checksMean === null ? null : c.q.checksMean / 100;
    const ci = judged ? c.validCi : null;
    const ciText = ci ? `${Math.round(ci[0] * 100)}–${Math.round(ci[1] * 100)} %` : '';
    const tip = judged
      ? `${modelName(c.model)} ${c.mcp ? 'with' : 'without'} MCP: ${c.validCount} of ${c.q.judged} runs valid${ci ? `, 95 % interval ${ciText}` : ''}`
      : `${modelName(c.model)} ${c.mcp ? 'with' : 'without'} MCP: mean checks passed`;
    return `<tr class="rank-${i + 1}">
      <td class="rk"><span>${i + 1}</span></td>
      <td>${configLabel(m, c, withHost)}</td>
      <td class="score" data-tip="${esc(tip)}"><div class="sbar${c.mcp ? '' : ' hatched'}" style="--c: var(--series-${slotOf(m, c.model) + 1}, var(--series-other))">
        <div class="fill" style="--w:${rate === null ? 0 : (rate * 100).toFixed(1)}%"></div>${ci ? `<div class="ci" style="left:${(ci[0] * 100).toFixed(1)}%;width:${((ci[1] - ci[0]) * 100).toFixed(1)}%"></div>` : ''}</div>
        <span class="sv">${rate === null ? '—' : counter(rate * 100, pctOf(rate), 0, '', ' %')}</span>
        <small>${judged ? `${c.validCount}/${c.q.judged}${ci ? ` · CI ${ciText}` : ''}` : 'checks'}</small></td>
      ${judged ? `<td class="num">${esc(pctOf(c.q.checksMean === null ? null : c.q.checksMean / 100))}</td>` : ''}
      ${judged ? `<td class="num em${mark(c.q.aicPerValid, bestPerValid)}">${esc(perValidOf(c.q.aicPerValid))}</td>` : ''}
      <td class="num${mark(c.aicMean, bestAic)}">${esc(formatMetric('aic', c.aicMean))}</td>
      <td class="num${mark(c.q.timeMs, bestTime)}">${esc(formatMetric('durationMs', c.q.timeMs))}</td>
      <td class="num">${esc(num1(reworkOf(c.q)))}</td>
      <td class="num muted">${c.q.n}</td>
    </tr>`;
  });
  return `<div class="card board-card reveal scroll"><table class="leader">
    <thead><tr><th>#</th><th>configuration</th><th>${judged ? 'valid output <small>95 % CI</small>' : 'checks passed'}</th>${judged ? '<th class="num">checks</th><th class="num">AIC / valid output</th>' : ''}<th class="num">AIC / run</th><th class="num">time <small>median</small></th><th class="num">rework / run</th><th class="num">runs</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>
    <p class="tagline">Ranked by valid output, then by the price of a valid result. <b>Valid output</b> = builds clean, well-formed XML, no new best-practice error. Hatched bar = without MCP. The thin band on a bar is its 95 % confidence interval — overlapping bands are not a reliable difference. Bold = best in column.</p></div>`;
}

function scatterBlock(m: ReportModel, scope: Scope): string {
  const judged = scope.configs.some(c => c.q.judged > 0);
  const rateOf = (c: ConfigRow) => (judged ? c.q.validRate : c.q.checksMean === null ? null : c.q.checksMean / 100);
  const point = (c: ConfigRow | null): LiftPoint | null => {
    const y = c ? rateOf(c) : null;
    if (!c || c.aicMean === null || y === null) return null;
    return { x: c.aicMean, y, tip: `${modelName(c.model)} ${c.mcp ? 'with' : 'without'} MCP — ${pctOf(y)} ${judged ? 'valid' : 'checks'}, ${formatMetric('aic', c.aicMean)} AIC per run, ${perValidOf(c.q.aicPerValid)} per valid output` };
  };
  const series: LiftSeries[] = scope.lifts.map(l => ({ label: modelName(l.model), slot: slotOf(m, l.model), with: point(l.with), without: point(l.without) }));
  const svg = liftScatter({ series, title: `${judged ? 'Valid output' : 'Checks passed'} against AI Credits per run, ${scope.label}`, xLabel: 'AI Credits per run (mean)', formatX: v => formatMetric('aic', v) });
  return `<figure class="card reveal"><figcaption>${judged ? 'Valid output' : 'Checks passed'} vs cost<small>one colour per model · ○ without MCP → ● with MCP</small></figcaption>${svg}
    <ul class="legend">${scope.lifts.map(l => `<li><span class="swatch s${slotOf(m, l.model)}"></span>${esc(modelName(l.model))}</li>`).join('')}<li><span class="swatch ring"></span>without MCP</li><li><span class="swatch solid"></span>with MCP</li></ul></figure>`;
}

function matrixBlock(m: ReportModel): string {
  if (m.matrix.length === 0 || m.configKeys.length === 0) return '';
  const withHost = new Set(m.configKeys.map(c => c.host)).size > 1;
  const head = m.configKeys.map(c => `<th class="mx-h">${configLabel(m, c, withHost)}</th>`).join('');
  let lastSuite = '';
  const multiSuite = new Set(m.matrix.map(r => r.suite)).size > 1;
  const rows = m.matrix.map(r => {
    const group = multiSuite && r.suite !== lastSuite
      ? `<tr class="mx-suite" data-suite="${esc(r.suite)}"><td colspan="${m.configKeys.length + 1}">${esc(r.suite.charAt(0).toUpperCase() + r.suite.slice(1))}</td></tr>` : '';
    lastSuite = r.suite;
    const cells = r.cells.map((c, i) => {
      if (!c) return '<td class="mx na">—</td>';
      const judged = c.q.judged > 0;
      const rate = judged ? c.q.validRate : c.q.checksMean === null ? null : c.q.checksMean / 100;
      const step = rate === null ? 'na' : rate >= 0.999 ? 'v4' : rate >= 0.66 ? 'v3' : rate >= 0.33 ? 'v2' : rate > 0.001 ? 'v1' : 'v0';
      const k = m.configKeys[i];
      const main = judged ? `${c.validCount}/${c.q.judged}` : pctOf(rate);
      const sub = judged ? perValidOf(c.q.aicPerValid) : formatMetric('aic', c.aicMean);
      const tip = `${r.title} — ${modelName(k.model)} ${k.mcp ? 'with' : 'without'} MCP: ${judged ? `${c.validCount} of ${c.q.judged} runs valid, ${perValidOf(c.q.aicPerValid)} AIC per valid output` : `${pctOf(rate)} of checks`}, ${formatMetric('aic', c.aicMean)} AIC per run, ${formatMetric('durationMs', c.q.timeMs)} median`;
      return `<td class="mx ${step}" data-tip="${esc(tip)}"><b>${esc(main)}</b><small>${esc(sub)}${judged ? ' / valid' : ' / run'}</small></td>`;
    });
    return `${group}<tr data-suite="${esc(r.suite)}"><td class="mx-task"><a href="#p-${esc(r.promptId)}" data-goto="${esc(r.promptId)}">${esc(shortTitle(r.title))}</a></td>${cells.join('')}</tr>`;
  });
  return `<div class="card reveal scroll"><table class="matrix"><thead><tr><th>task</th>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>
  <p class="tagline">Cell = runs with valid output out of runs (for a read-only task: checks passed), and the AI Credits one valid result cost. Darker = more often valid. Click a task for its detail.</p></div>`;
}

/** "Daily 1: carry a field … — find the hook" → "Carry a field …". */
function shortTitle(title: string): string {
  const t = title.replace(/^(Reference|Daily)\s+\d+:\s*/i, '').split(' — ')[0];
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function scopePanes(m: ReportModel): string {
  const tabs = m.scopes.length > 1
    ? `<div class="tabs" role="tablist">${m.scopes.map((s, i) => `<button role="tab" data-scope="${esc(s.id)}" aria-selected="${i === 0}">${esc(s.label)} <small>${s.promptIds.length}</small></button>`).join('')}</div>`
    : '';
  const panes = m.scopes.map((s, i) => `<div class="scope-pane${i === 0 ? '' : ' hidden'}" data-scope="${esc(s.id)}">
    <h2>MCP effect per model</h2>
    <p class="lede">The same model with and without the D365FO MCP server, ${esc(s.label.toLowerCase())} (${s.promptIds.length} task${s.promptIds.length === 1 ? '' : 's'}, ${s.runs} runs).</p>
    ${liftCards(m, s)}
    <h2>Leaderboard</h2>
    ${leaderboard(m, s)}
    ${scatterBlock(m, s)}
  </div>`);
  return `${tabs}${panes.join('')}`;
}

function methodology(m: ReportModel): string {
  const repeats = Math.max(0, ...m.scopes[0]?.configs.map(c => c.repeats) ?? [0]);
  return `<div class="method">
    <div class="card reveal"><h4>Tasks</h4><p>Everyday Dynamics 365 F&amp;O work: <b>reference</b> tasks name every object to build (enums, table and form extensions, CoC, SysOperation, SSRS, security); <b>daily</b> tasks name none, so the agent has to find the hook, the entity or the call chain first. Every task's checks and ground truth are in <code>eval/benchmark/prompts/</code>.</p></div>
    <div class="card reveal"><h4>Same tools, one difference</h4><p>Each run is a fresh headless agent session with no memory. Both variants may read the standard application, write only to a throwaway sandbox package, search the web and run one build command. The only difference is the MCP server. The sandbox is restored from a snapshot after every run.</p></div>
    <div class="card reveal"><h4>Scoring</h4><p><b>Valid output</b>: after the run the sandbox is compiled (labels, then a full xppc build), every written XML file must parse, and xppbp must report no best-practice error the clean sandbox did not have. <b>Checks</b>: the files and answer the task asks for. <b>Rework</b>: tool errors, failed builds and repair writes on the way.</p></div>
    <div class="card reveal"><h4>Cost and statistics</h4><p><b>AI Credits</b> per run are the host's cost converted at a fixed rate; <b>per valid output</b> = all runs' credits ÷ valid runs, so a cheap run with broken output counts as spent, not saved. Up to ${repeats} run${repeats === 1 ? '' : 's'} per task and configuration; the valid-output rate carries a 95 % Wilson interval; time is a median.</p></div>
  </div>`;
}

// ---------------------------------------------------------------- 3. per task

function heatClass(rate: number | null): string {
  if (rate === null) return 'c-na';
  return rate >= 0.999 ? 'c-full' : rate <= 0.001 ? 'c-none' : 'c-part';
}

interface TaskCol { label: string; get: (c: ConfigRow) => number | null; show: (v: number | null) => string; better: Better; when: boolean }

/** The task's own leaderboard: one row per configuration, best value per column marked. */
function taskTable(m: ReportModel, p: PromptSection): string {
  const present = m.configKeys.map((k, i) => ({ k, c: p.configs[i] })).filter((x): x is { k: ConfigKey; c: ConfigRow } => x.c !== null);
  if (present.length === 0) return '';
  const withHost = new Set(present.map(x => x.k.host)).size > 1;
  const judged = present.some(x => x.c.q.judged > 0);
  const best = (f: (c: ConfigRow) => number | null, better: Better) => {
    const vs = present.map(x => f(x.c)).filter((v): v is number => v !== null);
    return vs.length ? (better === 'lower' ? Math.min(...vs) : Math.max(...vs)) : null;
  };
  const all: TaskCol[] = [
    { label: 'valid output', get: c => c.q.validRate, show: pctOf, better: 'higher', when: judged },
    { label: 'checks', get: c => (c.q.checksMean === null ? null : c.q.checksMean / 100), show: pctOf, better: 'higher', when: true },
    { label: 'AIC / valid output', get: c => c.q.aicPerValid, show: perValidOf, better: 'lower', when: judged },
    { label: 'AIC / run', get: c => c.aicMean, show: v => formatMetric('aic', v), better: 'lower', when: true },
    { label: 'time, median', get: c => c.q.timeMs, show: v => formatMetric('durationMs', v), better: 'lower', when: true },
    { label: 'failed builds / run', get: c => c.q.buildFailures, show: num1, better: 'lower', when: judged },
    { label: 'tool errors / run', get: c => c.q.toolErrors, show: num1, better: 'lower', when: true },
    { label: 'new BP warnings / run', get: c => c.q.bpWarnings, show: num1, better: 'lower', when: judged },
  ];
  const cols = all.filter(c => c.when);
  const bests = cols.map(col => best(col.get, col.better));
  const rows = present.map(({ k, c }) => `<tr><td>${configLabel(m, k, withHost)}</td>${cols
    .map((col, j) => {
      const v = col.get(c);
      const isBest = v !== null && bests[j] !== null && Math.abs(v - bests[j]!) < 1e-9 && present.length > 1;
      const extra = col.label === 'valid output' ? ` <small>${c.validCount}/${c.q.judged}</small>` : '';
      return `<td class="num${isBest ? ' best' : ''}">${esc(col.show(v))}${extra}</td>`;
    })
    .join('')}<td class="num muted">${c.q.n}</td></tr>`);
  return `<div class="card reveal scroll"><table class="leader compact"><thead><tr><th>configuration</th>${cols.map(c => `<th class="num">${esc(c.label)}</th>`).join('')}<th class="num">runs</th></tr></thead><tbody>${rows.join('')}</tbody></table>
  <p class="tagline">Bold = best in column. Rates are shares of runs, time a median, rework and BP counts means per run.</p></div>`;
}

function checkMatrixBlock(m: ReportModel, p: PromptSection): string {
  if (p.checkMatrix.length === 0) return '';
  const cols = m.configKeys.map((k, i) => ({ k, i })).filter(x => p.configs[x.i] !== null);
  const shorten = (n: string) => n.replace(/^file /, '').replace(/^matches /, 'answer ~ ').replace(/^avoids /, 'answer ≁ ');
  const head = cols.map(({ k }) => `<div class="hd" title="${esc(`${modelName(k.model)} ${k.mcp ? 'with' : 'without'} MCP`)}"><span class="sw s${slotOf(m, k.model)}${k.mcp ? '' : ' hollow'}"></span>${k.mcp ? 'MCP' : 'plain'}</div>`).join('');
  const rows = p.checkMatrix.map(r => `<div class="name" title="${esc(r.name)}">${esc(shorten(r.name))}</div>${cols
    .map(({ k, i }) => `<div class="cell ${heatClass(r.rates[i])}" data-tip="${esc(`${modelName(k.model)} ${k.mcp ? 'with' : 'without'} MCP: ${pctOf(r.rates[i])} of runs passed`)}">${esc(pctOf(r.rates[i]))}</div>`)
    .join('')}`);
  return `<div class="card reveal scroll"><h3 style="margin-top:0">Checks — share of runs that passed</h3>
  <div class="heat" style="grid-template-columns: minmax(160px, 1fr) repeat(${cols.length}, minmax(56px, 72px))"><div class="hd">check</div>${head}${rows.join('')}</div></div>`;
}

function issueList(issues: Issue[], cls: string, title: string): string {
  const body = issues.length === 0
    ? '<p class="none">No build error, malformed file or new BP error in any run.</p>'
    : `<ul>${issues.map(i => `<li><span class="n">${i.count}×</span><span><span class="kind">${i.kind === 'bp' ? 'BP' : i.kind}</span>${esc(i.text)}</span></li>`).join('')}</ul>`;
  return `<div><h4 class="${cls}">${esc(title)}</h4>${body}</div>`;
}

function issuesBlock(p: PromptSection, models: number): string {
  if (!p.versus.with?.judged && !p.versus.without?.judged) return '';
  const all = models > 1 ? ', all models' : '';
  return `<div class="card reveal"><h3 style="margin-top:0">What broke — recurring errors</h3><div class="issues">
    ${issueList(p.issues.with, 'mcp', `with MCP${all}`)}${issueList(p.issues.without, 'plain', `without MCP${all}`)}</div></div>`;
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
      <td>${esc(fmtTs(r.timestamp))}</td><td>${esc(modelName(r.model))}${r.host !== p.hosts[0] || p.hosts.length > 1 ? ` <span class="tagline">${esc(r.host)}</span>` : ''}</td>
      <td>${r.mcp ? '<span class="badge mcp">MCP</span>' : '<span class="badge plain">no MCP</span>'}</td><td>${esc(r.outcome)}</td>
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
  return `<section class="prompt" data-prompt="${esc(p.promptId)}" data-suite="${esc(p.suite)}" id="p-${esc(p.promptId)}">
  <div class="phead"><h2>${esc(p.title)}</h2><div class="tagline">${p.runs.length} runs · ${esc(p.hosts.join(', '))}</div></div>
  <div class="tagline"><code>${esc(p.promptId)}</code> ${p.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
  ${drift}
  ${promptText}
  ${taskTable(m, p)}
  ${checkMatrixBlock(m, p)}
  ${issuesBlock(p, m.models.length)}
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
    ? `<div class="filters"><span class="meta">Task</span><button data-prompt="*" aria-pressed="true">All</button>${m.prompts
        .map(p => `<button data-prompt="${esc(p.promptId)}" data-suite="${esc(p.suite)}" aria-pressed="false">${esc(shortTitle(p.title))}</button>`)
        .join('')}</div>`
    : '';
  const all = m.scopes[0];
  const repeats = all ? Math.max(0, ...all.configs.map(c => c.repeats)) : 0;
  const stat = (n: number | string, label: string) => `<div class="hstat"><b>${typeof n === 'number' ? counter(n, String(n), 0) : esc(n)}</b><span>${esc(label)}</span></div>`;
  const body = m.runsTotal === 0
    ? '<div class="card empty">No runs match. Record one with <code>d365fo-mcp benchmark run</code> or <code>benchmark ingest</code>.</div>'
    : `${scopePanes(m)}
  <h2>Tasks × configurations</h2>
  <p class="lede">Every task for every configuration: how often the output was valid, and what one valid result cost.</p>
  ${matrixBlock(m)}
  <h2>Task details</h2>
  <p class="lede">Each task's own leaderboard, which checks fail where, the errors that recur, and every run.</p>
  ${filters}
  ${m.prompts.map(p => promptSection(p, m)).join('\n')}
  <h2>Methodology</h2>
  ${methodology(m)}
  <details class="more"><summary>All tasks, medians per configuration and the MCP effect per metric</summary>
    ${effectBars(m.overviewEffects, m.hosts, 'all prompts')}
    ${kpiRow(m.overviewKpis)}<div class="card">${overviewTable(m)}</div>
  </details>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.title)}</title>
<meta name="description" content="Leaderboard of coding agents on everyday Dynamics 365 F&amp;O tasks, with and without the D365FO MCP server: valid output, AI Credits, time and rework per model.">
<style>${CSS}</style>
</head>
<body>
<header class="hero">
  <div class="hero-in">
    <div class="eyebrow">Benchmark · Dynamics 365 Finance &amp; Operations · X++</div>
    <h1>${esc(m.title)}</h1>
    <p class="hero-lede">Coding agents on everyday F&amp;O development tasks, with and without the D365FO MCP server — scored on output that compiles, passes best practice and does what the task asked.</p>
    <div class="hstats">${stat(m.prompts.length, m.prompts.length === 1 ? 'task' : 'tasks')}${stat(m.models.length, m.models.length === 1 ? 'model' : 'models')}${stat(m.configKeys.length, 'configurations')}${stat(m.runsTotal, 'runs')}${repeats ? stat(repeats, repeats === 1 ? 'run per cell' : 'runs per cell') : ''}</div>
    <div class="meta">${esc(m.models.map(modelName).join(' · ') || 'no models')} · ${esc(m.hosts.join(', '))}${m.span ? ` · ${esc(m.span.from.slice(0, 10))} → ${esc(m.span.to.slice(0, 10))}` : ''}${m.filters.length ? ` · ${esc(m.filters.join(', '))}` : ''} · generated ${esc(fmtTs(m.generatedAt))} UTC${m.skippedFiles ? ` · <b>${m.skippedFiles} unreadable record file(s) skipped</b>` : ''}</div>
    <button class="toggle" type="button">Light / dark</button>
  </div>
</header>
<main>
${body}
<footer>
  <p><b>AIC = AI Credits.</b> ${m.creditsNotes.length ? esc(m.creditsNotes.join(' · ')) : 'No priced runs.'} Rates live in <code>eval/benchmark/credits.json</code>.</p>
  <p>Records: <code>eval/benchmark/runs/</code> · prompts and checks: <code>eval/benchmark/prompts/</code> · method: <code>docs/BENCHMARK.md</code>. Every number on this page is computed from the records by <code>d365fo-mcp benchmark report</code>.</p>
</footer>
</main>
<script>${JS}</script>
</body>
</html>
`;
}
