/**
 * Server-rendered SVG charts for the benchmark report.
 *
 * Rendered in TypeScript, not in the page: the arithmetic is then the same
 * arithmetic the tests cover and the markdown summary prints, and the page
 * needs only a few lines of script for hover. Every colour is a CSS variable
 * (`var(--series-N)`), so one stylesheet themes light and dark.
 *
 * Mark specs follow the dataviz skill: marks ≤ 24 px, 2 px lines, ≥ 8 px
 * markers with a 2 px surface ring, hairline solid grid, text in text tokens
 * only — the data colour never touches a glyph.
 */

export const esc = (s: unknown): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Round-number tick positions covering [0, max] (or [min, max] when min < 0). */
export function niceTicks(min: number, max: number, count = 5): number[] {
  const lo = Math.min(0, min);
  const hi = max <= lo ? lo + 1 : max;
  const span = hi - lo;
  const rough = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  // Index arithmetic, not accumulation: 0.2 added four times is 0.8000000000000002
  // and the tick that should cover the maximum would be dropped.
  const first = Math.floor(lo / step);
  const last = Math.ceil(hi / step - 1e-9);
  const ticks: number[] = [];
  for (let i = first; i <= last; i++) ticks.push(Number((i * step).toFixed(10)));
  return ticks;
}

export interface DumbbellRow {
  label: string;
  /** Value without MCP (the start of the dumbbell). */
  from: number | null;
  /** Value with MCP (the end). */
  to: number | null;
  fromN: number;
  toN: number;
}

export interface DumbbellOptions {
  rows: DumbbellRow[];
  title: string;
  fromLabel: string;
  toLabel: string;
  format: (v: number) => string;
  width?: number;
  /** Lower is better flips which end reads as the win. */
  better: 'lower' | 'higher';
}

const LABEL_COL = 190;
const ROW_H = 34;
/** Ends closer than this get one shared label. */
const CLOSE_ENDS_PX = 48;

/**
 * One row per model, the plain cell at the light end and the MCP cell at the
 * dark end of one hue — "before → after per item" from the form table. Direct
 * labels sit at both ends because the whole point of the row is the two values.
 */
export function dumbbellChart(o: DumbbellOptions): string {
  const width = o.width ?? 640;
  const padR = 90;
  const plotX = LABEL_COL;
  const plotW = width - plotX - padR;
  const values = o.rows.flatMap(r => [r.from, r.to]).filter((v): v is number => v !== null);
  const ticks = niceTicks(0, values.length ? Math.max(...values) : 1);
  const xMax = ticks[ticks.length - 1] || 1;
  const x = (v: number) => plotX + (v / xMax) * plotW;
  const top = 10;
  const plotH = o.rows.length * ROW_H;
  const height = top + plotH + 36;

  const parts: string[] = [];
  parts.push(`<svg class="chart dumbbell" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(o.title)}">`);
  parts.push(`<title>${esc(o.title)}</title>`);
  for (const t of ticks) {
    const gx = x(t);
    parts.push(`<line class="grid" x1="${gx.toFixed(1)}" y1="${top}" x2="${gx.toFixed(1)}" y2="${top + plotH}"/>`);
    parts.push(`<text class="tick" x="${gx.toFixed(1)}" y="${top + plotH + 18}" text-anchor="middle">${esc(o.format(t))}</text>`);
  }
  o.rows.forEach((row, i) => {
    const cy = top + i * ROW_H + ROW_H / 2;
    parts.push(`<text class="label" x="${plotX - 10}" y="${cy + 4}" text-anchor="end">${esc(row.label)}</text>`);
    if (row.from === null && row.to === null) {
      parts.push(`<text class="muted" x="${plotX + 6}" y="${cy + 4}">no runs</text>`);
      return;
    }
    if (row.from !== null && row.to !== null) {
      parts.push(`<line class="connector" x1="${x(row.from).toFixed(1)}" y1="${cy}" x2="${x(row.to).toFixed(1)}" y2="${cy}"/>`);
    }
    const dot = (v: number, cls: string, name: string, n: number) => {
      const tip = `${name}: ${o.format(v)} (median of ${n} run${n === 1 ? '' : 's'})`;
      parts.push(
        `<circle class="dot ${cls}" cx="${x(v).toFixed(1)}" cy="${cy}" r="6" tabindex="0" data-tip="${esc(tip)}"><title>${esc(tip)}</title></circle>`,
      );
    };
    if (row.from !== null) dot(row.from, 'from', o.fromLabel, row.fromN);
    if (row.to !== null) dot(row.to, 'to', o.toLabel, row.toN);
    // Direct labels: value beside each end, pushed outward so they never overlap
    // the other dot. Two ends closer than a label's width share ONE label to the
    // right ("5 → 9") instead of two that would print over each other.
    const labelFor = (v: number, other: number | null) => {
      const rightOf = other === null || v >= other;
      const lx = rightOf ? x(v) + 10 : x(v) - 10;
      return `<text class="value" x="${lx.toFixed(1)}" y="${cy + 4}" text-anchor="${rightOf ? 'start' : 'end'}">${esc(o.format(v))}</text>`;
    };
    if (row.from !== null && row.to !== null && Math.abs(x(row.from) - x(row.to)) < CLOSE_ENDS_PX) {
      const lx = Math.max(x(row.from), x(row.to)) + 10;
      parts.push(`<text class="value" x="${lx.toFixed(1)}" y="${cy + 4}">${esc(`${o.format(row.from)} → ${o.format(row.to)}`)}</text>`);
    } else {
      if (row.from !== null) parts.push(labelFor(row.from, row.to));
      if (row.to !== null) parts.push(labelFor(row.to, row.from));
    }
  });
  parts.push(`<line class="axis" x1="${plotX}" y1="${top + plotH}" x2="${plotX + plotW}" y2="${top + plotH}"/>`);
  parts.push('</svg>');
  return parts.join('');
}

export interface LineSeries {
  name: string;
  /** Categorical slot 0..8 (8 = "Other"). */
  slot: number;
  points: Array<{ t: number; v: number }>;
  dots: Array<{ t: number; v: number }>;
}

export interface LineChartOptions {
  series: LineSeries[];
  title: string;
  format: (v: number) => string;
  width?: number;
  height?: number;
  /** Shared x domain across small multiples. */
  tDomain: [number, number];
  /** Shared y max across small multiples. Dots above it are drawn clipped at the top edge. */
  yMax: number;
  /** Axis floor; default 0. A negative floor gets an emphasised zero line (for a chart of deltas). */
  yMin?: number;
  /** Format for the y ticks when it differs from the value format (e.g. a signed percentage). */
  tickFormat?: (v: number) => string;
}

function fmtDate(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Evenly spaced date ticks, at most `count`, snapped to UTC midnight. */
export function dateTicks(t0: number, t1: number, count = 5): number[] {
  const day = 24 * 3600 * 1000;
  const start = Math.floor(t0 / day) * day;
  const end = Math.ceil(t1 / day) * day;
  const days = Math.max(1, Math.round((end - start) / day));
  const step = Math.max(1, Math.ceil(days / count)) * day;
  const ticks: number[] = [];
  for (let t = start; t <= end; t += step) ticks.push(t);
  return ticks;
}

/**
 * A multi-series line chart: one line per model, the daily median; individual
 * runs as dots. Hover data travels in `data-series` so the page script can draw
 * a crosshair with every series' value at that date.
 */
export function lineChart(o: LineChartOptions): string {
  const width = o.width ?? 480;
  const height = o.height ?? 240;
  const padL = 56, padR = 16, padT = 12, padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const [t0, t1raw] = o.tDomain;
  const t1 = t1raw > t0 ? t1raw : t0 + 24 * 3600 * 1000;
  const floor = Math.min(0, o.yMin ?? 0);
  const ticks = niceTicks(floor, o.yMax);
  const yMax = ticks[ticks.length - 1] || 1;
  const yMin = ticks[0];
  const span = yMax - yMin || 1;
  const x = (t: number) => padL + ((t - t0) / (t1 - t0)) * plotW;
  const y = (v: number) => padT + plotH - ((Math.max(yMin, Math.min(v, yMax)) - yMin) / span) * plotH;
  const tickFmt = o.tickFormat ?? o.format;

  const parts: string[] = [];
  parts.push(`<svg class="chart lines" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(o.title)}" data-plot="${padL},${padT},${plotW},${plotH}" data-t0="${t0}" data-t1="${t1}">`);
  parts.push(`<title>${esc(o.title)}</title>`);
  for (const tick of ticks) {
    const zero = tick === 0 && yMin < 0;
    parts.push(`<line class="${zero ? 'axis zero' : 'grid'}" x1="${padL}" y1="${y(tick).toFixed(1)}" x2="${padL + plotW}" y2="${y(tick).toFixed(1)}"/>`);
    parts.push(`<text class="tick" x="${padL - 8}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end">${esc(tickFmt(tick))}</text>`);
  }
  for (const t of dateTicks(t0, t1)) {
    if (t < t0 - 1 || t > t1 + 1) continue;
    parts.push(`<text class="tick" x="${x(t).toFixed(1)}" y="${height - 8}" text-anchor="middle">${esc(fmtDate(t).slice(5))}</text>`);
  }
  if (yMin >= 0) parts.push(`<line class="axis" x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}"/>`);
  for (const s of o.series) {
    const cls = `s${s.slot}`;
    if (s.points.length > 1) {
      const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
      parts.push(`<path class="line ${cls}" d="${d}"/>`);
    }
    for (const p of s.dots) {
      if (p.v > yMax) {
        // Off the axis (a timeout among 30-second runs): a triangle on the top
        // edge with the real value in the tooltip, never a silently dropped run.
        const tip = `${s.name} · ${fmtDate(p.t)}: ${o.format(p.v)} (above the axis)`;
        const cx = x(p.t), top = padT;
        parts.push(`<path class="dot clipped ${cls}" d="M${(cx - 5).toFixed(1)} ${top + 9} L${(cx + 5).toFixed(1)} ${top + 9} L${cx.toFixed(1)} ${top} Z" tabindex="0" data-tip="${esc(tip)}"><title>${esc(tip)}</title></path>`);
        continue;
      }
      const tip = `${s.name} · ${fmtDate(p.t)}: ${o.format(p.v)}`;
      parts.push(`<circle class="dot ${cls}" cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4" tabindex="0" data-tip="${esc(tip)}"><title>${esc(tip)}</title></circle>`);
    }
  }
  parts.push(`<line class="crosshair" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" style="display:none"/>`);
  const hover = o.series.map(s => ({ name: s.name, slot: s.slot, points: s.points.map(p => [p.t, p.v, o.format(p.v)]) }));
  parts.push(`<desc data-series="${esc(JSON.stringify(hover))}"></desc>`);
  parts.push('</svg>');
  return parts.join('');
}

/** Legend swatches: a short line-key per model, text in text tokens. */
export function legend(items: Array<{ name: string; slot: number }>): string {
  return `<ul class="legend">${items
    .map(i => `<li><span class="key s${i.slot}"></span>${esc(i.name)}</li>`)
    .join('')}</ul>`;
}

export interface DivergingRow {
  label: string;
  /** Signed value; null = no comparison possible for this row. */
  value: number | null;
  /** Whether this value is an improvement — decides good/bad colouring. */
  good: boolean | null;
  tip: string;
}

export interface DivergingOptions {
  rows: DivergingRow[];
  title: string;
  format: (v: number) => string;
  width?: number;
  /** Shared symmetric axis extent (abs); defaults to the rows' own max. */
  extent?: number;
}

/**
 * Horizontal bars growing from a zero baseline, one per model: the chart for
 * "how much does MCP change this metric for each model". Colour carries ONLY
 * polarity (better / worse, the status pair), the label carries the sign too,
 * and the model name is the row — identity never rides on hue here.
 * Marks: 14 px thick, 4 px rounded data end, square at the baseline.
 */
export function divergingBars(o: DivergingOptions): string {
  const width = o.width ?? 420;
  const padR = 70, padL = 70;
  const plotX = LABEL_COL - 40;
  const plotW = width - plotX - padR - padL + 70;
  const values = o.rows.map(r => r.value).filter((v): v is number => v !== null && Number.isFinite(v));
  const extent = Math.max(o.extent ?? 0, ...values.map(Math.abs), 1);
  const ticks = niceTicks(-extent, extent, 4);
  const lim = Math.max(Math.abs(ticks[0]), Math.abs(ticks[ticks.length - 1])) || 1;
  const x0 = plotX + plotW / 2;
  const x = (v: number) => x0 + (Math.max(-lim, Math.min(lim, v)) / lim) * (plotW / 2);
  const top = 8;
  const barH = 14;
  const plotH = o.rows.length * ROW_H;
  const height = top + plotH + 30;

  const parts: string[] = [];
  parts.push(`<svg class="chart diverging" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(o.title)}">`);
  parts.push(`<title>${esc(o.title)}</title>`);
  for (const t of ticks) {
    if (Math.abs(t) > lim) continue;
    const gx = x(t);
    parts.push(`<line class="${t === 0 ? 'axis zero' : 'grid'}" x1="${gx.toFixed(1)}" y1="${top}" x2="${gx.toFixed(1)}" y2="${top + plotH}"/>`);
    parts.push(`<text class="tick" x="${gx.toFixed(1)}" y="${top + plotH + 16}" text-anchor="middle">${esc(o.format(t))}</text>`);
  }
  o.rows.forEach((row, i) => {
    const cy = top + i * ROW_H + ROW_H / 2;
    parts.push(`<text class="label" x="${plotX - 10}" y="${cy + 4}" text-anchor="end">${esc(row.label)}</text>`);
    if (row.value === null || !Number.isFinite(row.value)) {
      parts.push(`<text class="muted" x="${(x0 + 8).toFixed(1)}" y="${cy + 4}">needs both cells</text>`);
      return;
    }
    const v = row.value;
    const xe = x(v);
    const left = Math.min(x0, xe);
    const w = Math.max(Math.abs(xe - x0), 1);
    const r = 4;
    // Rounded at the data end only: path instead of rect so the baseline side stays square.
    const d = v >= 0
      ? `M${x0.toFixed(1)} ${(cy - barH / 2).toFixed(1)} h${(w - r).toFixed(1)} a${r} ${r} 0 0 1 ${r} ${r} v${barH - 2 * r} a${r} ${r} 0 0 1 -${r} ${r} h-${(w - r).toFixed(1)} Z`
      : `M${x0.toFixed(1)} ${(cy - barH / 2).toFixed(1)} h-${(w - r).toFixed(1)} a${r} ${r} 0 0 0 -${r} ${r} v${barH - 2 * r} a${r} ${r} 0 0 0 ${r} ${r} h${(w - r).toFixed(1)} Z`;
    // `neg` lets the page grow a left-pointing bar out of the zero line, not toward it.
    const cls = `${row.good === null ? 'neutral' : row.good ? 'good' : 'bad'}${v < 0 ? ' neg' : ''}`;
    parts.push(`<path class="bar ${cls}" d="${d}" tabindex="0" data-tip="${esc(row.tip)}"><title>${esc(row.tip)}</title></path>`);
    const lx = v >= 0 ? left + w + 6 : left - 6;
    const glyph = row.good === null ? '' : row.good ? '▼ ' : '▲ ';
    parts.push(`<text class="value" x="${lx.toFixed(1)}" y="${cy + 4}" text-anchor="${v >= 0 ? 'start' : 'end'}">${esc(glyph + o.format(v))}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

// ---------------------------------------------------------------- success vs cost

export interface LiftPoint {
  /** Cost axis value (AIC per run). */
  x: number;
  /** Valid-output rate, 0..1. */
  y: number;
  tip: string;
}

export interface LiftSeries {
  label: string;
  slot: number;
  without: LiftPoint | null;
  with: LiftPoint | null;
}

export interface LiftScatterOptions {
  series: LiftSeries[];
  title: string;
  xLabel: string;
  formatX: (v: number) => string;
  width?: number;
  height?: number;
}

/**
 * Success against cost, the shape benchmark leaderboards use for "how good, at
 * what price": one colour per model, a hollow ring without MCP, a filled dot
 * with it, and an arrow between them — the MCP server's effect is the arrow.
 * Up is better, left is cheaper.
 */
export function liftScatter(o: LiftScatterOptions): string {
  const W = o.width ?? 1000;
  const H = o.height ?? 360;
  const L = 56, R = 130, T = 18, B = 46;
  const pw = W - L - R, ph = H - T - B;
  const pts = o.series.flatMap(s => [s.with, s.without].filter((p): p is LiftPoint => p !== null));
  if (pts.length === 0) return '<div class="empty">no priced runs</div>';
  const xTicks = niceTicks(0, Math.max(...pts.map(p => p.x)) * 1.08, 5);
  const xMax = xTicks[xTicks.length - 1] || 1;
  const sx = (v: number) => L + (v / xMax) * pw;
  const sy = (v: number) => T + (1 - v) * ph;
  const out: string[] = [];
  out.push(`<svg class="chart scatter" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title)}"><title>${esc(o.title)}</title>`);
  out.push('<defs>');
  for (const s of o.series) {
    out.push(`<marker id="arrow-s${s.slot}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="s${s.slot}"/></marker>`);
  }
  out.push('</defs>');
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    out.push(`<line class="grid" x1="${L}" x2="${L + pw}" y1="${sy(t).toFixed(1)}" y2="${sy(t).toFixed(1)}"/>`);
    out.push(`<text class="tick" x="${L - 8}" y="${(sy(t) + 4).toFixed(1)}" text-anchor="end">${Math.round(t * 100)} %</text>`);
  }
  for (const t of xTicks) {
    out.push(`<line class="grid" x1="${sx(t).toFixed(1)}" x2="${sx(t).toFixed(1)}" y1="${T}" y2="${T + ph}"/>`);
    out.push(`<text class="tick" x="${sx(t).toFixed(1)}" y="${T + ph + 18}" text-anchor="middle">${esc(o.formatX(t))}</text>`);
  }
  out.push(`<line class="axis" x1="${L}" x2="${L + pw}" y1="${T + ph}" y2="${T + ph}"/>`);
  out.push(`<text class="muted" x="${L + pw / 2}" y="${H - 6}" text-anchor="middle">${esc(o.xLabel)}</text>`);
  out.push(`<text class="muted" x="${L + 6}" y="${T + 12}">↖ better: more valid output, fewer credits</text>`);
  for (const s of o.series) {
    if (!s.with || !s.without) continue;
    const x1 = sx(s.without.x), y1 = sy(s.without.y), x2 = sx(s.with.x), y2 = sy(s.with.y);
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 18) continue;
    // Stop short of both markers so the arrowhead sits on the ring, not under the dot.
    const k1 = 10 / len, k2 = 12 / len;
    out.push(`<line class="lift-arrow s${s.slot}" x1="${(x1 + (x2 - x1) * k1).toFixed(1)}" y1="${(y1 + (y2 - y1) * k1).toFixed(1)}" x2="${(x2 - (x2 - x1) * k2).toFixed(1)}" y2="${(y2 - (y2 - y1) * k2).toFixed(1)}" marker-end="url(#arrow-s${s.slot})"/>`);
  }
  for (const s of o.series) {
    if (s.without) out.push(`<circle class="pt hollow s${s.slot}" cx="${sx(s.without.x).toFixed(1)}" cy="${sy(s.without.y).toFixed(1)}" r="7" tabindex="0" data-tip="${esc(s.without.tip)}"/>`);
    if (s.with) {
      const x = sx(s.with.x), y = sy(s.with.y);
      out.push(`<circle class="pt s${s.slot}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" tabindex="0" data-tip="${esc(s.with.tip)}"/>`);
      out.push(`<text class="label" x="${(x + 12).toFixed(1)}" y="${(y + 4).toFixed(1)}">${esc(s.label)}</text>`);
    } else if (s.without) {
      out.push(`<text class="label" x="${(sx(s.without.x) + 12).toFixed(1)}" y="${(sy(s.without.y) + 4).toFixed(1)}">${esc(s.label)}</text>`);
    }
  }
  out.push('</svg>');
  return out.join('');
}
