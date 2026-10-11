import { describe, it, expect } from 'vitest';
import {
  assignModelSlots,
  effectSeries,
  modelEffectRows,
  formatDeltaPct,
  formatMetric,
  groupRuns,
  mcpEffects,
  quantile,
  stats,
  timeSeries,
} from '../../src/benchmark/aggregate.js';
import type { BenchmarkRun } from '../../src/benchmark/types.js';

let seq = 0;
function run(over: Partial<BenchmarkRun>): BenchmarkRun {
  seq++;
  return {
    schemaVersion: 1,
    runId: `r${seq}`,
    timestamp: '2026-10-01T10:00:00.000Z',
    promptId: 'p1',
    promptHash: 'abc',
    host: 'claude-code',
    model: 'sonnet',
    modelRequested: null,
    mcp: true,
    mcpServers: [],
    serverVersion: null,
    serverGitSha: null,
    label: null,
    durationMs: 10000,
    apiMs: null,
    requests: 3,
    toolCalls: 2,
    mcpToolCalls: 2,
    tools: {},
    inputTokens: 1000,
    cachedTokens: 500,
    outputTokens: 200,
    hostCost: null,
    aic: { value: 10, source: 'host-cost' },
    outcome: 'completed',
    score: 1,
    checks: [],
    resultChars: null,
    resultExcerpt: null,
    notes: null,
    evidence: { sessionId: null, logPath: null },
    ...over,
  };
}

describe('stats', () => {
  it('interpolates quantiles and ignores nulls', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5], 0.9)).toBe(5);
    const s = stats([3, null, 1, undefined, 2, Number.NaN])!;
    expect(s).toMatchObject({ n: 3, median: 2, min: 1, max: 3, mean: 2 });
    expect(stats([null, undefined])).toBeNull();
  });
});

describe('groupRuns', () => {
  it('groups by prompt × host × model × mcp and reports medians, completion and AIC provenance', () => {
    const groups = groupRuns([
      run({ durationMs: 10000, mcp: true }),
      run({ durationMs: 30000, mcp: true, outcome: 'timeout', score: 0 }),
      run({ durationMs: 20000, mcp: true, aic: { value: 5, source: 'rates' } }),
      run({ durationMs: 40000, mcp: false, aic: null }),
    ]);
    expect(groups.map(g => [g.model, g.mcp, g.n])).toEqual([['sonnet', true, 3], ['sonnet', false, 1]]);
    const withMcp = groups[0];
    expect(withMcp.metrics.durationMs!.median).toBe(20000);
    expect(withMcp.completed).toBe(2);
    expect(withMcp.completionRate).toBeCloseTo(2 / 3, 6);
    expect(withMcp.aicSources.sort()).toEqual(['host-cost', 'rates']);
    expect(withMcp.metrics.score!.median).toBe(100);
    expect(groups[1].metrics.aic).toBeNull();
  });

  it('keeps distinct prompt hashes visible', () => {
    const [g] = groupRuns([run({ promptHash: 'a' }), run({ promptHash: 'b' })]);
    expect(g.promptHashes.sort()).toEqual(['a', 'b']);
  });
});

describe('mcpEffects', () => {
  it('compares medians with MCP against without, per model that has both cells', () => {
    const effects = mcpEffects(groupRuns([
      run({ model: 'sonnet', mcp: true, durationMs: 10000, outputTokens: 100, score: 1 }),
      run({ model: 'sonnet', mcp: false, durationMs: 20000, outputTokens: 400, score: 0.5 }),
      run({ model: 'opus', mcp: true, durationMs: 5000 }),
    ]));
    const time = effects.find(e => e.model === 'sonnet' && e.metric === 'durationMs')!;
    expect(time.deltaPct).toBeCloseTo(-50, 6);
    expect(time.withMcp).toBe(10000);
    expect(time.withoutMcp).toBe(20000);
    expect(effects.find(e => e.model === 'sonnet' && e.metric === 'outputTokens')!.deltaPct).toBeCloseTo(-75, 6);
    expect(effects.find(e => e.model === 'sonnet' && e.metric === 'score')!.deltaPct).toBeCloseTo(100, 6);
    expect(effects.some(e => e.model === 'opus')).toBe(false);
  });

  it('leaves the delta undefined when the baseline is zero', () => {
    const [e] = mcpEffects(groupRuns([run({ mcp: true, toolCalls: 3 }), run({ mcp: false, toolCalls: 0 })])).filter(e => e.metric === 'toolCalls');
    expect(e.deltaPct).toBeNull();
    expect(formatDeltaPct(null)).toBe('—');
  });
});

describe('timeSeries', () => {
  it('folds same-day repeats into a daily median and keeps every run as a dot', () => {
    const series = timeSeries([
      run({ timestamp: '2026-10-01T08:00:00Z', outputTokens: 100 }),
      run({ timestamp: '2026-10-01T18:00:00Z', outputTokens: 300 }),
      run({ timestamp: '2026-10-03T09:00:00Z', outputTokens: 150 }),
      run({ timestamp: '2026-10-03T09:00:00Z', outputTokens: 500, mcp: false }),
    ], 'outputTokens');
    expect(series.map(s => s.mcp)).toEqual([true, false]);
    expect(series[0].points.map(p => p.value)).toEqual([200, 150]);
    expect(series[0].points[0].runIds).toHaveLength(2);
    expect(series[0].raw).toHaveLength(3);
    expect(series[1].points).toHaveLength(1);
  });

  it('skips runs that do not carry the metric', () => {
    expect(timeSeries([run({ aic: null })], 'aic')).toEqual([]);
    expect(timeSeries([run({ score: null })], 'score')).toEqual([]);
  });
});

describe('effectSeries / modelEffectRows', () => {
  it('yields a delta only for days that have both cells, from the daily medians', () => {
    const series = effectSeries([
      run({ timestamp: '2026-10-01T08:00:00Z', mcp: true, durationMs: 10000 }),
      run({ timestamp: '2026-10-01T09:00:00Z', mcp: true, durationMs: 14000 }),
      run({ timestamp: '2026-10-01T10:00:00Z', mcp: false, durationMs: 24000 }),
      run({ timestamp: '2026-10-02T10:00:00Z', mcp: true, durationMs: 1 }), // no without-cell that day
      run({ timestamp: '2026-10-03T10:00:00Z', mcp: true, durationMs: 30000, model: 'opus' }),
      run({ timestamp: '2026-10-03T11:00:00Z', mcp: false, durationMs: 20000, model: 'opus' }),
    ], 'durationMs');
    expect(series.map(s => [s.model, s.points.length])).toEqual([['opus', 1], ['sonnet', 1]]);
    expect(series[1].points[0].value).toBeCloseTo(-50, 6); // median(10k,14k)=12k vs 24k
    expect(series[1].points[0].runIds).toHaveLength(3);
    expect(series[0].points[0].value).toBeCloseTo(50, 6);
  });

  it('folds per-prompt effects into one row per model with the median delta', () => {
    const rows = modelEffectRows(mcpEffects(groupRuns([
      run({ promptId: 'a', mcp: true, durationMs: 10 }), run({ promptId: 'a', mcp: false, durationMs: 20 }),
      run({ promptId: 'b', mcp: true, durationMs: 30 }), run({ promptId: 'b', mcp: false, durationMs: 20 }),
      run({ promptId: 'c', mcp: true, durationMs: 15 }), run({ promptId: 'c', mcp: false, durationMs: 20 }),
      run({ promptId: 'a', mcp: true, durationMs: 5, model: 'opus' }),
    ])));
    expect(rows.map(r => r.model)).toEqual(['sonnet']); // opus has no without-cell anywhere
    const d = rows[0].deltas.durationMs!;
    expect(d.deltaPct).toBeCloseTo(-25, 6); // median of −50, +50, −25
    expect(d.prompts).toBe(3);
    expect(d.nWith).toBe(3);
    expect(rows[0].deltas.score).not.toBeNull();
  });
});

describe('model slots and formatting', () => {
  it('assigns one slot per model in sorted order and folds the ninth into Other', () => {
    const slots = assignModelSlots(['z', 'a', 'a', 'm']);
    expect([...slots.entries()]).toEqual([['a', 0], ['m', 1], ['z', 2]]);
    const many = assignModelSlots(Array.from({ length: 10 }, (_, i) => `m${String(i).padStart(2, '0')}`));
    expect(many.get('m07')).toBe(7);
    expect(many.get('m08')).toBe(8);
    expect(many.get('m09')).toBe(8);
  });

  it('formats metrics for people', () => {
    expect(formatMetric('durationMs', 9500)).toBe('9.5 s');
    expect(formatMetric('durationMs', 45000)).toBe('45 s');
    expect(formatMetric('durationMs', 150000)).toBe('2.5 min');
    expect(formatMetric('outputTokens', 12345.6)).toBe('12,346');
    expect(formatMetric('aic', 7.346)).toBe('7.35');
    expect(formatMetric('aic', 305.18)).toBe('305');
    expect(formatMetric('score', 66.6)).toBe('67 %');
    expect(formatMetric('aic', null)).toBe('—');
    expect(formatDeltaPct(-23.4)).toBe('−23 %');
    expect(formatDeltaPct(4.56)).toBe('+4.6 %');
    expect(formatDeltaPct(0)).toBe('±0.0 %');
  });
});
