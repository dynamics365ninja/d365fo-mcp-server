/**
 * The headless runner: argv it builds, the stream it reads, the record it writes.
 * Nothing here spawns a process — the runner takes an injected ProcessRunner.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildClaudeArgs,
  mcpServerNames,
  parseStreamJson,
  quoteForCmd,
  runClaudeCode,
  toBenchmarkRun,
  type ClaudeCodeOptions,
  type ProcessRunner,
} from '../../src/benchmark/claudeCode.js';
import { DEFAULT_CREDITS } from '../../src/benchmark/credits.js';
import type { PromptSpec } from '../../src/benchmark/types.js';

const STREAM = fs.readFileSync(path.resolve(__dirname, 'fixtures/claude-code-stream.jsonl'), 'utf8');

const SPEC: PromptSpec = {
  id: 'grounding-custtable-accountnum',
  title: 'Grounding',
  prompt: 'Which EDT does CustTable.AccountNum use?',
  tags: [],
  expects: { mustMatch: ['CustAccount', 'AccountIdx'], mustNotMatch: ['I cannot verify'] },
};

function tmpMcpConfig(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-mcp-'));
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { d365fo: { command: 'node', args: ['dist/index.js'] }, other: { url: 'http://x' } } }));
  return file;
}

function baseOptions(over: Partial<ClaudeCodeOptions> = {}): ClaudeCodeOptions {
  return {
    prompt: SPEC.prompt,
    model: 'sonnet',
    mcpConfig: null,
    cwd: '/work',
    permissionMode: 'dontAsk',
    allowedTools: [],
    tools: null,
    maxTurns: null,
    maxBudgetUsd: null,
    effort: null,
    appendSystemPromptFile: null,
    addDirs: [],
    timeoutMs: 1000,
    claudeBin: 'claude',
    ...over,
  };
}

describe('buildClaudeArgs', () => {
  it('always pins the MCP set with --strict-mcp-config and never persists the session', () => {
    const args = buildClaudeArgs(baseOptions());
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--no-session-persistence');
    expect(args).not.toContain('--mcp-config');
    expect(args.slice(0, 1)).toEqual(['-p']);
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
  });

  it('adds the config and whitelists every server in it for the with-MCP cell', () => {
    const file = tmpMcpConfig();
    try {
      expect(mcpServerNames(file)).toEqual(['d365fo', 'other']);
      const args = buildClaudeArgs(baseOptions({ mcpConfig: file, allowedTools: ['Read'] }));
      expect(args[args.indexOf('--mcp-config') + 1]).toBe(file);
      const i = args.indexOf('--allowedTools');
      expect(args.slice(i + 1, i + 4)).toEqual(['Read', 'mcp__d365fo', 'mcp__other']);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('passes the optional limits through only when set', () => {
    const args = buildClaudeArgs(baseOptions({ maxTurns: 12, maxBudgetUsd: 2.5, effort: 'low', tools: '', appendSystemPromptFile: '/x/sys.md' }));
    expect(args[args.indexOf('--max-turns') + 1]).toBe('12');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('2.5');
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe('/x/sys.md');
    const bare = buildClaudeArgs(baseOptions());
    for (const flag of ['--max-turns', '--max-budget-usd', '--effort', '--tools', '--append-system-prompt-file', '--add-dir']) expect(bare).not.toContain(flag);
  });

  it('gives a sandbox cell the read-only folders with --add-dir, after every other flag', () => {
    const args = buildClaudeArgs(baseOptions({ allowedTools: ['Read', 'Edit(./**)'], addDirs: ['K:/AosService/PackagesLocalDirectory'] }));
    const i = args.indexOf('--add-dir');
    expect(args.slice(i)).toEqual(['--add-dir', 'K:/AosService/PackagesLocalDirectory']);
    expect(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 3)).toEqual(['Read', 'Edit(./**)']);
    // The edit rule carries parentheses and an asterisk: quoted for cmd, never refused.
    expect(quoteForCmd('Edit(./**)')).toBe('"Edit(./**)"');
  });
});

describe('quoteForCmd', () => {
  it('quotes anything cmd.exe would interpret, passes plain arguments through, refuses a double quote', () => {
    expect(quoteForCmd('sonnet')).toBe('sonnet');
    expect(quoteForCmd('C:\\bench out\\mcp.json')).toBe('"C:\\bench out\\mcp.json"');
    expect(quoteForCmd('C:\\x&calc.exe')).toBe('"C:\\x&calc.exe"');
    expect(quoteForCmd('')).toBe('""');
    expect(() => quoteForCmd('a"b')).toThrow(/double quote/);
  });
});

describe('parseStreamJson', () => {
  const s = parseStreamJson(STREAM);

  it('reads the init event: model and connected MCP servers', () => {
    expect(s.init?.model).toBe('claude-sonnet-5-5');
    expect(s.init?.mcpServers).toEqual([{ name: 'd365fo', status: 'connected' }]);
  });

  it('counts tool_use blocks per tool across every assistant message', () => {
    expect(s.toolCalls).toEqual({ mcp__d365fo__get_object_info: 1, mcp__d365fo__search: 1, Read: 1 });
    expect(s.assistantMessages).toBe(3);
  });

  it('keeps the result event and tolerates a non-JSON line', () => {
    expect(s.result?.total_cost_usd).toBe(0.0734);
    expect(s.result?.num_turns).toBe(3);
    expect(s.stray).toEqual(['this line is not json and must be tolerated']);
  });
});

const fakeRunner = (stdout: string, over: Partial<{ exitCode: number | null; timedOut: boolean; stderr: string }> = {}): ProcessRunner =>
  async () => ({ stdout, stderr: over.stderr ?? '', exitCode: over.exitCode ?? 0, timedOut: over.timedOut ?? false, durationMs: 50000 });

const ctx = (mcp: boolean) => ({
  spec: SPEC,
  modelRequested: 'sonnet',
  mcp,
  serverVersion: '1.20.0',
  serverGitSha: 'abc1234',
  label: 'test',
  notes: null,
  credits: DEFAULT_CREDITS,
  excerpt: true,
  timestamp: new Date('2026-10-07T10:00:00Z'),
});

describe('toBenchmarkRun', () => {
  it('folds a successful stream into a record: tokens, cost, AIC, tools, checks', async () => {
    const outcome = await runClaudeCode(baseOptions({ mcpConfig: null }), fakeRunner(STREAM));
    const run = toBenchmarkRun(outcome, ctx(true));

    expect(run.host).toBe('claude-code');
    expect(run.model).toBe('claude-sonnet-5-5');
    expect(run.modelRequested).toBe('sonnet');
    expect(run.mcp).toBe(true);
    expect(run.mcpServers).toEqual(['d365fo']);
    expect(run.outcome).toBe('completed');
    expect(run.durationMs).toBe(48210);
    expect(run.apiMs).toBe(41000);
    expect(run.requests).toBe(3);
    expect(run.toolCalls).toBe(3);
    expect(run.mcpToolCalls).toBe(2);
    // input = uncached + cache creation + cache read; cached = cache read.
    expect(run.inputTokens).toBe(62 + 3500 + 66500);
    expect(run.cachedTokens).toBe(66500);
    expect(run.outputTokens).toBe(330);
    expect(run.hostCost).toEqual({ value: 0.0734, unit: 'USD' });
    expect(run.aic).toEqual({ value: 7.34, source: 'host-cost' });
    expect(run.score).toBe(1);
    expect(run.checks.map(c => c.passed)).toEqual([true, true, true]);
    expect(run.resultExcerpt).toContain('CustAccount');
    expect(run.serverVersion).toBe('1.20.0');
    expect(run.runId).toMatch(/^2026-10-07T10-00__grounding-custtable-accountnum__claude-code__claude-sonnet-5-5__mcp__[0-9a-f]{6}$/);
  });

  it('does not stamp the server version on a without-MCP cell', async () => {
    const outcome = await runClaudeCode(baseOptions(), fakeRunner(STREAM));
    const run = toBenchmarkRun(outcome, ctx(false));
    expect(run.serverVersion).toBeNull();
    expect(run.serverGitSha).toBeNull();
    expect(run.runId).toContain('__plain__');
  });

  it('records a timeout as such, with the measured wall time and a zero score', async () => {
    const partial = STREAM.split('\n').slice(0, 3).join('\n');
    const outcome = await runClaudeCode(baseOptions(), fakeRunner(partial, { exitCode: null, timedOut: true }));
    const run = toBenchmarkRun(outcome, ctx(true));
    expect(run.outcome).toBe('timeout');
    expect(run.durationMs).toBe(50000);
    expect(run.score).toBe(0);
    expect(run.toolCalls).toBe(2);
    expect(run.notes).toContain('timeout');
  });

  it('maps the CLI error subtypes and keeps stderr in the notes', async () => {
    const err = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, duration_ms: 1000, num_turns: 5, total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 1 } });
    const run = toBenchmarkRun(await runClaudeCode(baseOptions(), fakeRunner(err, { exitCode: 1, stderr: 'boom' })), ctx(false));
    expect(run.outcome).toBe('max_turns');
    expect(run.notes).toContain('boom');
    const budget = JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, usage: {} });
    expect(toBenchmarkRun(await runClaudeCode(baseOptions(), fakeRunner(budget)), ctx(false)).outcome).toBe('budget_exceeded');
    const auth = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in', usage: {} });
    expect(toBenchmarkRun(await runClaudeCode(baseOptions(), fakeRunner(auth)), ctx(false)).outcome).toBe('error');
  });

  it('counts the sandbox checks into the score and keeps artifacts and build on the record', async () => {
    const outcome = await runClaudeCode(baseOptions(), fakeRunner(STREAM));
    const build = { ok: false, errorCount: 2, errors: ['Compile Error: x', 'Compile Error: y'], durationMs: 42000 };
    const run = toBenchmarkRun(outcome, {
      ...ctx(true),
      extraChecks: [{ name: 'file AxTable', passed: true }, { name: 'builds clean (xppc)', passed: false }],
      artifacts: ['fm-mcp/AxTable/ConX.xml'],
      build,
    });
    expect(run.checks).toHaveLength(5);
    expect(run.score).toBeCloseTo(4 / 5, 6);
    expect(run.artifacts).toEqual(['fm-mcp/AxTable/ConX.xml']);
    expect(run.build).toEqual(build);
    // An answer-only run carries neither field.
    const plain = toBenchmarkRun(outcome, ctx(true));
    expect('artifacts' in plain).toBe(false);
    expect('build' in plain).toBe(false);
  });

  it('names what the permission fence refused, by tool and file name only', async () => {
    const result = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 2, usage: {},
      permission_denials: [
        { tool_name: 'Edit', tool_use_id: 't1', tool_input: { file_path: 'K:\\AosService\\PackagesLocalDirectory\\fm-mcp\\fm-mcp\\AxReport\\ConCustOverdueReport.xml' } },
        { tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'xppc.exe' } },
      ],
    });
    const run = toBenchmarkRun(await runClaudeCode(baseOptions(), fakeRunner(result)), ctx(true));
    expect(run.notes).toContain('2 permission denial(s): Edit ConCustOverdueReport.xml, Bash');
    expect(run.notes).not.toContain('AosService');
  });

  it('warns in the notes when MCP was requested but no server connected', async () => {
    const noMcp = STREAM.replace('"status":"connected"', '"status":"failed"');
    const run = toBenchmarkRun(await runClaudeCode(baseOptions(), fakeRunner(noMcp)), ctx(true));
    expect(run.mcpServers).toEqual([]);
    expect(run.notes).toMatch(/no server reported connected/);
  });
});
