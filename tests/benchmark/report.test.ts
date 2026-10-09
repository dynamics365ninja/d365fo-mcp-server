/**
 * The report: data model, HTML and markdown from the same runs. The charts are
 * server-rendered, so the SVG can be asserted on like any other string.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_CREDITS } from '../../src/benchmark/credits.js';
import { renderHtml } from '../../src/benchmark/report/html.js';
import { renderMarkdown } from '../../src/benchmark/report/markdown.js';
import { buildReportModel } from '../../src/benchmark/report/model.js';
import { divergingBars, dumbbellChart, lineChart, niceTicks, dateTicks } from '../../src/benchmark/report/svg.js';
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

  it('leads with the MCP effect per model, and over time where a day has both cells', () => {
    const p1 = model.prompts[0];
    expect(p1.modelEffects.map(r => r.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(Math.round(p1.modelEffects[1].deltas.durationMs!.deltaPct)).toBe(-50);
    expect(Math.round(p1.modelEffects[1].deltas.outputTokens!.deltaPct)).toBe(-67);
    // sonnet ran both cells on 2026-10-01, opus on 2026-10-05: one point each.
    expect(p1.effectTrends.durationMs.map(s => [s.model, s.points.length])).toEqual([['claude-opus-5-5', 1], ['claude-sonnet-5-5', 1]]);
    expect(Math.round(p1.effectTrends.durationMs[1].points[0].value)).toBe(-50);
    // Across prompts: p2 has one cell only, so the overview equals p1's effects.
    expect(model.overviewEffects.map(r => r.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(model.overviewEffects[1].deltas.durationMs!.prompts).toBe(1);
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
    expect((p1.match(/<svg class="chart diverging"/g) ?? []).length).toBe(5); // time, out tokens, AIC, turns, checks
    expect((p1.match(/<svg class="chart dumbbell"/g) ?? []).length).toBe(5); // 4 headline + score, one host
    expect((p1.match(/<svg class="chart lines"/g) ?? []).length).toBe(8 + 5); // 4 absolute metrics × with/without + 5 effect trends
    expect(p1).toContain('<details class="more">');
    expect(p1.indexOf('chart diverging')).toBeLessThan(p1.indexOf('chart dumbbell'));
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

describe('verdict: valid output and rework', () => {
  // Three runs per side, sandbox-shaped: build, quality, rework.
  const sandboxRuns: BenchmarkRun[] = [
    ...[0, 1, 2].map(i => run({
      promptId: 'ref', mcp: true, durationMs: 300000, aic: { value: 80, source: 'host-cost' }, timestamp: `2026-10-09T1${i}:00:00.000Z`,
      build: { ok: true, errorCount: 0, errors: [], durationMs: 30000 },
      quality: { xmlInvalid: [], bp: { errors: 0, warnings: 2, findings: [] } },
      rework: { toolErrors: 1, mcpToolErrors: 1, toolErrorsByTool: {}, buildAttempts: 2, buildFailures: 1, writeOps: 10, rewrites: 0 },
      checks: [{ name: 'file the table', passed: true }, { name: 'builds clean (xppc)', passed: true }],
    })),
    ...[0, 1, 2].map(i => run({
      promptId: 'ref', mcp: false, durationMs: 200000, aic: { value: 60, source: 'host-cost' }, timestamp: `2026-10-09T1${i}:30:00.000Z`,
      build: i === 0 ? { ok: true, errorCount: 0, errors: [], durationMs: 30000 }
        : { ok: false, errorCount: 1, errors: [`Metadata Error: AxEnum/ConX/UseEnumValue: must be No: [(1,${i}),(2,3)]`], durationMs: 30000 },
      quality: { xmlInvalid: i === 2 ? ['fm-mcp/AxForm/ConX.xml'] : [], bp: i === 0 ? { errors: 1, warnings: 4, findings: ['Error BPErrorLabelIsText Report/ConX'] } : null },
      rework: { toolErrors: 3, mcpToolErrors: 0, toolErrorsByTool: {}, buildAttempts: 0, buildFailures: 0, writeOps: 12, rewrites: 2 },
      checks: [{ name: 'file the table', passed: i === 0 }, { name: 'builds clean (xppc)', passed: i === 0 }],
    })),
  ];
  const model = buildReportModel(sandboxRuns, [{ id: 'ref', title: 'Reference 1: something — detail', prompt: 'p', tags: ['reference'] }], { credits: DEFAULT_CREDITS });

  it('judges valid output, pools rework as means and costs as medians', () => {
    const v = model.versus;
    expect(v.with!.validRate).toBe(1);
    // without: one clean build but with a new BP error, one failed build, one failed build + malformed XML → 0 of 3
    expect(v.without!.validRate).toBe(0);
    expect(v.without!.buildRate).toBeCloseTo(1 / 3, 6);
    expect(v.with!.toolErrors).toBe(1);
    expect(v.without!.rewrites).toBe(2);
    expect(v.with!.timeMs).toBe(300000);
    expect(v.without!.bpErrors).toBe(1);
  });

  it('lists the checks per variant and the recurring errors with positions stripped', () => {
    const p = model.prompts[0];
    expect(p.checkRates.find(c => c.name === 'file the table')).toEqual({ name: 'file the table', withRate: 1, withoutRate: 1 / 3 });
    const top = p.issues.without[0];
    expect(top).toEqual({ kind: 'build', text: 'Metadata Error: AxEnum/ConX/UseEnumValue: must be No', count: 2 });
    expect(p.issues.without.map(i => i.kind).sort()).toEqual(['bp', 'build', 'xml']);
    expect(p.issues.with).toEqual([]);
  });

  it('opens with a verdict that says it in a sentence, and marks the better side', () => {
    const html = renderHtml(model);
    expect(html).toContain('With MCP, 3 of 3 runs delivered valid output, against 0 of 3 without');
    expect(html).toMatch(/it took 50 % longer, it cost 33 % more/);
    expect(html.indexOf('class="verdict"')).toBeLessThan(html.indexOf('<section class="prompt"'));
    expect(html).toContain('class="card vcard reveal lead good"');
    expect(html).toContain('No build error, malformed file or new BP error in any run.');
    expect(html).toContain('class="cell c-part"');
    // Numbers are complete without the script; the script only animates them.
    expect(html).toMatch(/<span data-to="100" data-dec="0" data-pre="" data-suf=" %">100 %<\/span>/);
    expect(html).toContain('prefers-reduced-motion: reduce');
  });
});

describe('verdict across prompts', () => {
  it('uses the median of per-prompt effects, not a pooled median that mixes cheap and expensive prompts', () => {
    // MCP costs more on both prompts (+50 %, +20 %), yet the pooled medians
    // (with: 15, 60 → 37.5; without: 10, 100 → 55) would read as a saving.
    const rs = [
      run({ promptId: 'a', mcp: true, aic: { value: 15, source: 'host-cost' } }),
      run({ promptId: 'a', mcp: false, aic: { value: 10, source: 'host-cost' } }),
      run({ promptId: 'b', mcp: true, aic: { value: 120, source: 'host-cost' } }),
      run({ promptId: 'b', mcp: false, aic: { value: 100, source: 'host-cost' } }),
    ];
    const html = renderHtml(buildReportModel(rs, [], { credits: DEFAULT_CREDITS }));
    const verdict = html.slice(html.indexOf('class="verdict"'), html.indexOf('class="sentence'));
    expect(verdict).toContain('median of 2 per-prompt effects');
    expect(verdict).toMatch(/data-to="35" [^>]*>\+35 %/);
    expect(html).toMatch(/it cost 35 % more \(median per prompt\)/);
  });
});

describe('renderMarkdown', () => {
  it('prints the overview and per-prompt tables with the same medians', () => {
    const md = renderMarkdown(buildReportModel(runs, specs, { credits: DEFAULT_CREDITS, now: new Date('2026-10-07T12:00:00Z') }));
    expect(md).toContain('# D365FO MCP benchmark');
    expect(md).toContain('## MCP effect per model, all prompts');
    expect(md).toMatch(/\| claude-sonnet-5-5 \| claude-code \| −50 % \| −67 % \| −60 % \|/);
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

  it('draws diverging bars from a zero baseline, coloured by polarity with a signed label', () => {
    const svg = divergingBars({
      rows: [
        { label: 'sonnet', value: -48, good: true, tip: 'sonnet: 2 s vs 4 s' },
        { label: 'opus', value: 12, good: false, tip: 'opus: worse' },
        { label: 'haiku', value: null, good: null, tip: '' },
      ],
      title: 't', format: v => `${v} %`,
    });
    // A bar left of zero carries `neg`, so the page grows it out of the zero line.
    expect(svg).toContain('class="bar good neg"');
    expect(svg).toContain('class="bar bad"');
    expect(svg).toContain('▼ -48 %');
    expect(svg).toContain('▲ 12 %');
    expect(svg).toContain('needs both cells');
    expect(svg).toContain('class="axis zero"');
  });

  it('draws a zero line when the axis goes negative', () => {
    const t0 = Date.UTC(2026, 9, 1);
    const svg = lineChart({ series: [{ name: 'a', slot: 0, points: [{ t: t0, v: -20 }], dots: [] }], title: 'x', format: String, tDomain: [t0, t0 + 1], yMax: 50, yMin: -50 });
    expect(svg).toContain('class="axis zero"');
    expect(svg).toMatch(/>-[246]0</); // negative ticks are labelled
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
