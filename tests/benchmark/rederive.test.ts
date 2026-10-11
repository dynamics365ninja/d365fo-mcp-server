/**
 * Re-deriving a record from its kept stream and files: the derived fields
 * follow a fixed parser or check, the measured ones never move, and the record
 * says what was changed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rederiveRun } from '../../src/benchmark/rederive.js';
import type { BenchmarkRun, PromptSpec } from '../../src/benchmark/types.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-rederive-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const spec: PromptSpec = {
  id: 'ref', title: 'Ref', prompt: 'p', tags: [], workspace: { build: true },
  expects: { mustMatch: ['done'], files: [{ name: 'form', path: '/AxForm/ConX\\.xml$', contains: ['<Pattern\\b[^>]*>SimpleList</Pattern>'] }] },
};

const stream = [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls bin | grep xppc' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'xppc.exe' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Write', input: { file_path: 'K:/x/AxForm/ConX.xml' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'ok' }] } },
  { type: 'result', subtype: 'success', result: 'done', num_turns: 2, usage: {} },
].map(e => JSON.stringify(e)).join('\n');

function record(): BenchmarkRun {
  return {
    schemaVersion: 1, runId: 'r1', timestamp: '2026-10-09T12:00:00.000Z', promptId: 'ref', promptHash: 'h', host: 'claude-code',
    model: 'claude-sonnet-5-5', modelRequested: null, mcp: false, mcpServers: [], serverVersion: null, serverGitSha: null, label: 'v2',
    durationMs: 120000, apiMs: null, requests: 2, toolCalls: 2, mcpToolCalls: 0, tools: {}, inputTokens: 1, cachedTokens: 0, outputTokens: 1,
    hostCost: null, aic: { value: 50, source: 'host-cost' }, outcome: 'completed', score: 1 / 3,
    // Recorded with the old parser and the old check: a phantom build, a form check that missed xmlns="".
    checks: [{ name: 'matches done', passed: true }, { name: 'file form', passed: false }, { name: 'builds clean (xppc)', passed: false }],
    resultChars: 4, resultExcerpt: 'done', notes: null, evidence: { sessionId: null, logPath: null },
    artifacts: ['fm-mcp/AxForm/ConX.xml'], build: { ok: false, errorCount: 1, errors: ['x'], durationMs: 1 },
    rework: { toolErrors: 0, mcpToolErrors: 0, toolErrorsByTool: {}, buildAttempts: 1, buildFailures: 1, writeOps: 1, rewrites: 0 },
  };
}

describe('rederiveRun', () => {
  it('recomputes rework and file checks from the evidence, keeps the build check and every measured number', () => {
    fs.writeFileSync(path.join(dir, 'stream.jsonl'), stream);
    fs.mkdirSync(path.join(dir, 'fm-mcp', 'AxForm'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'fm-mcp', 'AxForm', 'ConX.xml'), '<AxForm><Design><Pattern xmlns="">SimpleList</Pattern></Design></AxForm>');
    const { run, changes } = rederiveRun(record(), spec, dir, new Date('2026-10-10T00:00:00Z'));
    expect(run.rework).toMatchObject({ buildAttempts: 0, buildFailures: 0, writeOps: 1 });
    expect(run.checks).toEqual([
      { name: 'matches done', passed: true },
      { name: 'file form', passed: true },
      { name: 'builds clean (xppc)', passed: false },
    ]);
    expect(run.score).toBeCloseTo(2 / 3, 6);
    expect(run.durationMs).toBe(120000);
    expect(run.aic?.value).toBe(50);
    expect(run.build?.ok).toBe(false);
    expect(changes.join(' ')).toMatch(/rework 0\/1\/1\/0 → 0\/0\/0\/0/);
    expect(run.notes).toMatch(/^re-derived 2026-10-10 from kept stream\/artifacts: .*file form → pass/);
  });

  it('leaves a record without kept evidence untouched', () => {
    const r = record();
    expect(rederiveRun(r, spec, path.join(dir, 'missing'))).toEqual({ run: r, changes: [] });
  });
});
