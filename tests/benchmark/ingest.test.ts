/**
 * A Copilot Chat session becomes a benchmark record through the same reader the
 * `session` command uses, with the host's own AI-credit figure as AIC.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { DEFAULT_CREDITS } from '../../src/benchmark/credits.js';
import { hostOfFormat, sessionToBenchmarkRun } from '../../src/benchmark/ingest.js';
import { isBenchmarkRun } from '../../src/benchmark/store.js';
import { readSessionLog } from '../../src/cli/session/sessionLog.js';

const FIXTURE = resolve(__dirname, '../cli/fixtures/copilot-session.redacted.jsonl');
const spec = { id: 'coc-salesline-validatewrite', title: 't', prompt: 'p', tags: [] };

describe('ingest from a Copilot Chat log', () => {
  const session = readSessionLog(FIXTURE);
  const run = sessionToBenchmarkRun(session, {
    spec, mcp: null, score: 0.75, label: 'audit', notes: null, logPath: 'abc/main.jsonl',
    serverVersion: '1.20.0', serverGitSha: 'deadbee', credits: DEFAULT_CREDITS,
  });

  it('produces a valid record with the host figures', () => {
    expect(isBenchmarkRun(run)).toBe(true);
    expect(run.host).toBe('copilot-chat');
    expect(run.requests).toBe(95);
    expect(run.toolCalls).toBe(118);
    expect(run.hostCost?.unit).toBe('AIU');
    expect(run.hostCost?.value).toBeCloseTo(305.18, 2);
    expect(run.aic).toEqual({ value: run.hostCost!.value, source: 'host' });
    expect(run.score).toBe(0.75);
    expect(run.outcome).toBe('completed');
    expect(run.evidence.sessionId).toBe(session.sessionId);
    expect(run.resultExcerpt).toBeNull();
  });

  it('detects MCP from the mcp_-prefixed tool calls and names the servers', () => {
    expect(run.mcp).toBe(true);
    expect(run.mcpToolCalls).toBeGreaterThan(0);
    expect(run.mcpToolCalls).toBeLessThan(run.toolCalls);
    expect(run.mcpServers.length).toBeGreaterThan(0);
    expect(run.serverVersion).toBe('1.20.0');
    const forced = sessionToBenchmarkRun(session, { spec, mcp: false, score: null, label: null, notes: null, logPath: null, serverVersion: '1', serverGitSha: null, credits: DEFAULT_CREDITS });
    expect(forced.mcp).toBe(false);
    expect(forced.serverVersion).toBeNull();
  });

  it('sums the token classes and measures wall time from first to last event', () => {
    expect(run.inputTokens).toBe(session.requests.reduce((s, r) => s + r.inputTokens, 0));
    expect(run.cachedTokens).toBe(session.requests.reduce((s, r) => s + r.cachedTokens, 0));
    expect(run.outputTokens).toBe(session.requests.reduce((s, r) => s + r.outputTokens, 0));
    expect(run.durationMs).toBeGreaterThan(60000);
    expect(run.timestamp).toBe(new Date(Math.min(...session.requests.map(r => r.ts), ...session.toolCalls.map(t => t.ts))).toISOString());
  });

  it('names the host from the reader format', () => {
    expect(hostOfFormat('copilot-chat/main.jsonl')).toBe('copilot-chat');
    expect(hostOfFormat('other')).toBe('other');
  });
});
