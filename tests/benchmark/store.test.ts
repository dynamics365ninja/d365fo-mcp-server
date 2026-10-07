import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRunId, countRunFiles, filterRuns, isBenchmarkRun, loadRuns, safeFragment, writeRun } from '../../src/benchmark/store.js';
import type { BenchmarkRun } from '../../src/benchmark/types.js';

function run(over: Partial<BenchmarkRun>): BenchmarkRun {
  return {
    schemaVersion: 1, runId: 'x', timestamp: '2026-10-01T10:00:00.000Z', promptId: 'p1', promptHash: 'h', host: 'claude-code',
    model: 'claude-sonnet-5-5', modelRequested: null, mcp: true, mcpServers: [], serverVersion: null, serverGitSha: null, label: null,
    durationMs: 1, apiMs: null, requests: 1, toolCalls: 0, mcpToolCalls: 0, tools: {}, inputTokens: 0, cachedTokens: 0, outputTokens: 0,
    hostCost: null, aic: null, outcome: 'completed', score: null, checks: [], resultChars: null, resultExcerpt: null, notes: null,
    evidence: { sessionId: null, logPath: null }, ...over,
  };
}

describe('store', () => {
  it('builds a Windows-safe, sortable run id', () => {
    const id = buildRunId(new Date('2026-10-07T12:03:45Z'), 'coc salesline', 'claude-code', 'claude-sonnet-5-5[1m]', true);
    expect(id).toMatch(/^2026-10-07T12-03__coc-salesline__claude-code__claude-sonnet-5-5-1m__mcp__[0-9a-f]{6}$/);
    expect(id).not.toMatch(/[:\s\[\]]/);
    expect(safeFragment('***')).toBe('x');
  });

  it('writes, refuses to overwrite, and reads back in time order, skipping junk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-store-'));
    try {
      writeRun(dir, run({ runId: 'b', timestamp: '2026-10-02T00:00:00.000Z' }));
      writeRun(dir, run({ runId: 'a', timestamp: '2026-10-01T00:00:00.000Z' }));
      expect(() => writeRun(dir, run({ runId: 'a' }))).toThrow(/already exists/);
      fs.writeFileSync(path.join(dir, 'junk.json'), '{ nope');
      fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ schemaVersion: 99 }));
      fs.writeFileSync(path.join(dir, 'bom.json'), '﻿' + JSON.stringify(run({ runId: 'c', timestamp: '2026-10-03T00:00:00.000Z' })));
      expect(loadRuns(dir).map(r => r.runId)).toEqual(['a', 'b', 'c']);
      expect(countRunFiles(dir)).toBe(5);
      expect(loadRuns(path.join(dir, 'missing'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates the shape it reads', () => {
    expect(isBenchmarkRun(run({}))).toBe(true);
    expect(isBenchmarkRun({ ...run({}), timestamp: 'yesterday' })).toBe(false);
    expect(isBenchmarkRun({ ...run({}), mcp: 'yes' })).toBe(false);
    expect(isBenchmarkRun(null)).toBe(false);
  });

  it('filters by prompt, host, model substring, label and inclusive dates', () => {
    const runs = [
      run({ runId: '1', promptId: 'p1', timestamp: '2026-10-01T10:00:00Z', label: 'rel' }),
      run({ runId: '2', promptId: 'p2', host: 'copilot-chat', model: 'gpt-5', timestamp: '2026-10-05T23:30:00Z' }),
      run({ runId: '3', promptId: 'p1', model: 'claude-opus-5-5', timestamp: '2026-10-09T00:00:00Z' }),
    ];
    const ids = (f: Parameters<typeof filterRuns>[1]) => filterRuns(runs, f).map(r => r.runId);
    expect(ids({ prompt: 'p1' })).toEqual(['1', '3']);
    expect(ids({ host: 'copilot-chat' })).toEqual(['2']);
    expect(ids({ model: 'OPUS' })).toEqual(['3']);
    expect(ids({ label: 'rel' })).toEqual(['1']);
    expect(ids({ since: '2026-10-05', until: '2026-10-05' })).toEqual(['2']);
    expect(ids({ since: '2026-10-02' })).toEqual(['2', '3']);
    expect(() => filterRuns(runs, { since: 'tomorrow' })).toThrow(/Not a date/);
  });
});
