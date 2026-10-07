/**
 * The report: data model, HTML and markdown from the same runs. The charts are
 * server-rendered, so the SVG can be asserted on like any other string.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_CREDITS } from '../../src/benchmark/credits.js';
import { renderHtml } from '../../src/benchmark/report/html.js';
import { renderMarkdown } from '../../src/benchmark/report/markdown.js';
import { buildReportModel } from '../../src/benchmark/report/model.js';
import { dumbbellChart, lineChart, niceTicks, dateTicks } from '../../src/benchmark/report/svg.js';
import type { BenchmarkRun, PromptSpec } from '../../src/benchmark/types.js';

let seq = 0;
function run(over: Partial<BenchmarkRun>): BenchmarkRun {
  seq++;
  return {
    schemaVersion: 1, runId: `r${seq}`, timestamp: '2026-10-01T10:00:00.000Z', promptId: 'p1', promptHash: 'h1',
    host: 'claude-code', model: 'claude-sonnet-5-5', modelRequested: null, mcp: true, mcpServers: ['d365fo'],
    serverVersion: '1.20.0', serverGitSha: 'abc', label: null, durationMs: 10000, apiMs: null, requests: 3, toolCalls: 2,
    mcpToolCalls: 2, tools: { 'mcp__d365fo__search': 2 }, inputTokens: 1000, cachedTokens: 500, outputTokens: 200,
    hostCost: { value: 0.1, unit: 'USD' }, aic: { value: 10, source: 'host-cost' }, outcome: 'completed', score: 1, checks: [],
    resultChars: 50, resultExcerpt: 'The EDT is CustAccount <script>alert(1)</script>', notes: null,
    evidence: { sessionId: null, logPath: null }, ...over,
  };
}

const specs: PromptSpec[] = [
  { id: 'p1', title: 'Grounding <b>facts</b>', prompt: 'Which EDT?', tags: ['grounding'] },
  { id: 'p2', title: 'Second', prompt: 'Other', tags: [] },
];

const runs: BenchmarkRun[] = [
  run({ mcp: true, durationMs: 10000, outputTokens: 200, aic: { value: 10, source: 'host-cost' } }),
  run({ mcp: false, durationMs: 20000, outputTokens: 600, aic: { value: 25, source: 'host-cost' }, score: 0.5, timestamp: '2026-10-01T11:00:00.000Z' }),
  run({ mcp: true, model: 'claude-opus-5-5', durationMs: 8000, timestamp: '2026-10-05T10:00:00.000Z' }),
  run({ mcp: false, model: 'claude-opus-5-5', durationMs: 18000, timestamp: '2026-10-05T11:00:00.000Z', outcome: 'timeout', score: 0 }),
  run({ promptId: 'p2', promptHash: 'stale', host: 'copilot-chat', model: 'gpt-x', hostCost: { value: 300, unit: 'AIU' }, aic: { value: 300, source: 'host' }, score: null, resultExcerpt: null }),
];

describe('buildReportModel', () => {
  // promptHash('Which EDT?') differs from 'h1', so p1 drifted; p2 too.
  const model = buildReportModel(runs, specs, { credits: DEFAULT_CREDITS, now: new Date('2026-10-07T12:00:00Z'), filters: ['since 2026-09-01'] });

  it('lays out one section per prompt with groups, effects and KPIs', () => {
    expect(model.prompts.map(p => p.promptId)).toEqual(['p1', 'p2']);
    const p1 = model.prompts[0];
    expect(p1.groups).toHaveLength(4);
    expect(p1.effects.filter(e => e.metric === 'durationMs').map(e => Math.round(e.deltaPct!)).sort((a, b) => a - b)).toEqual([-56, -50]);
    expect(p1.kpis.map(k => k.label)).toContain('MCP effect on time');
    const timeKpi = p1.kpis.find(k => k.label === 'MCP effect on time')!;
    expect(timeKpi.tone).toBe('good');
    expect(timeKpi.value).toMatch(/^−5[0-9] %$/);
    expect(p1.hashDrift).toBe(true);
    expect(p1.trends.durationMs.length).toBe(4);
  });

  it('assigns colour slots per model across the whole report', () => {
    expect([...model.slots.keys()]).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-x']);
    expect(model.hosts).toEqual(['claude-code', 'copilot-chat']);
  });

  it('explains where every AIC figure came from, per host', () => {
    expect(model.creditsNotes.find(n => n.startsWith('claude-code'))).toMatch(/USD cost × 100/);
    expect(model.creditsNotes.find(n => n.startsWith('copilot-chat'))).toMatch(/billed by the host/);
  });

  it('builds the overview across prompts', () => {
    const row = model.overview.find(r => r.model === 'claude-sonnet-5-5' && r.mcp)!;
    expect(row.n).toBe(1);
    expect(model.overviewKpis[0].value).toBe('5');
  });

  it('survives an empty run set', () => {
    const empty = buildReportModel([], specs, { credits: DEFAULT_CREDITS });
    expect(empty.prompts).toEqual([]);
    expect(renderHtml(empty)).toContain('No runs match');
    expect(renderMarkdown(empty)).toContain('0 runs');
  });
});

describe('renderHtml', () => {
  const html = renderHtml(buildReportModel(runs, specs, { credits: DEFAULT_CREDITS, now: new Date('2026-10-07T12:00:00Z') }));

  it('is one self-contained document with no external resources', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<(script|link)[^>]+(src|href)=["']https?:/);
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('data-theme="dark"');
  });

  it('escapes everything that came from a record or a spec', () => {
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Grounding &lt;b&gt;facts&lt;/b&gt;');
  });

  it('draws a dumbbell per headline metric and small multiples over time, faceted per host', () => {
    const p1 = html.slice(html.indexOf('<section class="prompt" data-prompt="p1"'), html.indexOf('<section class="prompt" data-prompt="p2"'));
    expect((p1.match(/<svg class="chart dumbbell"/g) ?? []).length).toBe(5); // 4 headline + score, one host
    expect((p1.match(/<svg class="chart lines"/g) ?? []).length).toBe(8); // 4 metrics × with/without
    const mixed = renderHtml(buildReportModel([...runs, run({ host: 'copilot-chat', model: 'gpt-x', aic: { value: 1, source: 'host' } })], specs, { credits: DEFAULT_CREDITS }));
    const p1mixed = mixed.slice(mixed.indexOf('<section class="prompt" data-prompt="p1"'), mixed.indexOf('<section class="prompt" data-prompt="p2"'));
    expect((p1mixed.match(/<svg class="chart dumbbell"/g) ?? []).length).toBe(10); // × 2 hosts
    expect(p1mixed).toContain('<div class="panel-title">copilot-chat</div>');
    expect(p1).toContain('class="dot from"');
    expect(p1).toContain('class="dot to"');
    expect(p1).toContain('data-series=');
    expect(p1).toMatch(/class="legend"/);
    expect(p1).toContain('prompt text in the catalogue');
  });

  it('shows the MCP effect with a glyph as well as a colour', () => {
    expect(html).toMatch(/class="num delta good"[^>]*>▼ −5\d %/);
  });

  it('offers the prompt switcher only when there is more than one prompt', () => {
    expect(html).toContain('data-prompt="*"');
    const single = renderHtml(buildReportModel(runs.filter(r => r.promptId === 'p1'), specs, { credits: DEFAULT_CREDITS }));
    expect(single).not.toContain('data-prompt="*"');
  });
});

describe('renderMarkdown', () => {
  it('prints the overview and per-prompt tables with the same medians', () => {
    const md = renderMarkdown(buildReportModel(runs, specs, { credits: DEFAULT_CREDITS, now: new Date('2026-10-07T12:00:00Z') }));
    expect(md).toContain('# D365FO MCP benchmark');
    expect(md).toContain('| model | host | MCP | runs | prompts | completed |');
    expect(md).toMatch(/\| claude-sonnet-5-5 \| yes \| 1 \| 100 % \| 10 s \| 200 \| 10\.00 \|/);
    expect(md).toContain('With MCP vs without (medians):');
    expect(md).toMatch(/\| claude-sonnet-5-5 \| −50 % \| −67 % \| −60 % \|/);
    expect(md).toContain('⚠ prompt text changed');
    expect(md).toContain('## How AIC was obtained');
  });
});

describe('svg primitives', () => {
  it('picks round ticks that cover the range', () => {
    expect(niceTicks(0, 93)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 0.7)).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
    expect(niceTicks(0, 0)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    const d = dateTicks(Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 20));
    expect(d.length).toBeGreaterThan(2);
    expect(d.length).toBeLessThanOrEqual(7);
  });

  it('renders a dumbbell row with both ends labelled and a "no runs" row otherwise', () => {
    const svg = dumbbellChart({
      rows: [{ label: 'sonnet', from: 20000, to: 10000, fromN: 2, toN: 3 }, { label: 'opus', from: null, to: null, fromN: 0, toN: 0 }],
      title: 't', fromLabel: 'without', toLabel: 'with', format: v => `${v / 1000} s`, better: 'lower',
    });
    expect(svg).toContain('class="dot from"');
    expect(svg).toContain('class="dot to"');
    expect(svg).toContain('>20 s<');
    expect(svg).toContain('>10 s<');
    expect(svg).toContain('no runs');
    expect(svg).toContain('median of 3 runs');
  });

  it('shares one label when the two ends of a dumbbell would overlap', () => {
    const svg = dumbbellChart({
      rows: [{ label: 'sonnet', from: 100, to: 103, fromN: 1, toN: 1 }],
      title: 't', fromLabel: 'without', toLabel: 'with', format: String, better: 'lower',
    });
    expect(svg).toContain('>100 → 103<');
    // The axis still ticks at 100; what must be gone are the two separate value labels.
    expect(svg).not.toMatch(/class="value"[^>]*>(100|103)</);
  });

  it('draws a run above the axis as a clipped marker with the real value in the tooltip', () => {
    const t0 = Date.UTC(2026, 9, 1);
    const svg = lineChart({
      series: [{ name: 'a', slot: 0, points: [{ t: t0, v: 10 }], dots: [{ t: t0, v: 10 }, { t: t0 + 3600000, v: 900 }] }],
      title: 'x', format: v => `${v} s`, tDomain: [t0, t0 + 86400000], yMax: 10,
    });
    expect(svg).toContain('class="dot clipped s0"');
    expect(svg).toContain('900 s (above the axis)');
    expect((svg.match(/<circle class="dot s0"/g) ?? []).length).toBe(1);
  });

  it('renders a line per series with ≥2 points and a dot per raw run', () => {
    const t0 = Date.UTC(2026, 9, 1);
    const svg = lineChart({
      series: [
        { name: 'a', slot: 0, points: [{ t: t0, v: 1 }, { t: t0 + 86400000, v: 2 }], dots: [{ t: t0, v: 1 }, { t: t0 + 86400000, v: 2 }] },
        { name: 'b', slot: 1, points: [{ t: t0, v: 3 }], dots: [{ t: t0, v: 3 }] },
      ],
      title: 'x', format: String, tDomain: [t0, t0 + 86400000], yMax: 3,
    });
    expect((svg.match(/<path class="line s0"/g) ?? []).length).toBe(1);
    expect(svg).not.toContain('class="line s1"');
    expect((svg.match(/<circle class="dot s/g) ?? []).length).toBe(3);
    expect(svg).toContain('class="crosshair"');
  });
});
