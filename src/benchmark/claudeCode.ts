/**
 * Headless runner — one benchmark cell through `claude -p`.
 *
 * Claude Code's print mode is the one host that can be driven unattended with
 * the MCP server switched on or off by a flag, so it is what `benchmark run`
 * automates. `--output-format stream-json` is used rather than `json` because
 * only the stream carries the per-call `tool_use` blocks — the single `result`
 * event has the cost, the tokens and the turn count, but not WHICH tools ran,
 * and "how many MCP calls did it take" is the number this benchmark exists to
 * compare.
 *
 * Two flags make the cells comparable:
 *   --strict-mcp-config   always — otherwise the user's own ~/.claude.json
 *                         servers leak into the "without MCP" cell;
 *   --no-session-persistence — a benchmark run must not litter the resume list.
 *
 * The prompt goes in on stdin, not argv: it can be long, it can contain quotes,
 * and on Windows the CLI is a .cmd shim that needs a shell, where argv quoting
 * is exactly the thing that goes wrong.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { evaluateChecks, promptHash } from './prompts.js';
import { computeAic } from './credits.js';
import { buildRunId } from './store.js';
import {
  BENCHMARK_SCHEMA_VERSION,
  type BenchmarkOutcome,
  type BuildResult,
  type CheckResult,
  type BenchmarkRun,
  type CreditsConfig,
  type PromptSpec,
} from './types.js';

export interface ClaudeCodeOptions {
  prompt: string;
  model: string;
  /** Path of an MCP config JSON (`{"mcpServers": {...}}`); null = the cell runs without MCP. */
  mcpConfig: string | null;
  cwd: string;
  permissionMode: string;
  /** Extra --allowedTools entries; the MCP servers' own tools are added automatically. */
  allowedTools: string[];
  /** --tools value (built-in set); null leaves the default. '' disables all built-ins. */
  tools: string | null;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  effort: string | null;
  appendSystemPromptFile: string | null;
  /** --add-dir entries: folders the file tools may read (and edit, where an Edit rule allows it). */
  addDirs: string[];
  timeoutMs: number;
  claudeBin: string;
}

/** Server names declared in an MCP config file — what --allowedTools needs to whitelist. */
export function mcpServerNames(mcpConfigPath: string): string[] {
  const parsed = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')) as Record<string, unknown>;
  const servers = (parsed.mcpServers ?? parsed.servers) as Record<string, unknown> | undefined;
  return servers && typeof servers === 'object' ? Object.keys(servers) : [];
}

export function buildClaudeArgs(opts: ClaudeCodeOptions): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', opts.model,
    '--no-session-persistence',
    '--strict-mcp-config',
    '--permission-mode', opts.permissionMode,
  ];
  const allowed = [...opts.allowedTools];
  if (opts.mcpConfig) {
    args.push('--mcp-config', opts.mcpConfig);
    // `mcp__<server>` with no tool suffix allows every tool of that server.
    for (const name of mcpServerNames(opts.mcpConfig)) allowed.push(`mcp__${name}`);
  }
  if (allowed.length > 0) args.push('--allowedTools', ...allowed);
  if (opts.tools !== null) args.push('--tools', opts.tools);
  if (opts.maxTurns !== null) args.push('--max-turns', String(opts.maxTurns));
  if (opts.maxBudgetUsd !== null) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.appendSystemPromptFile) args.push('--append-system-prompt-file', opts.appendSystemPromptFile);
  if (opts.addDirs.length > 0) args.push('--add-dir', ...opts.addDirs);
  return args;
}

/** The `result` event of a print-mode stream, fields as Claude Code emits them. */
export interface ResultEvent {
  subtype?: string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  modelUsage?: Record<
    string,
    { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }
  >;
  permission_denials?: unknown[];
}

export interface StreamSummary {
  init: { model: string | null; mcpServers: Array<{ name: string; status: string }>; tools: string[] } | null;
  /** tool_use blocks per tool name, MCP prefix and all. */
  toolCalls: Record<string, number>;
  assistantMessages: number;
  result: ResultEvent | null;
  /** Lines that were not JSON — a crash trace, a deprecation warning. Kept for the record's notes. */
  stray: string[];
}

export function parseStreamJson(text: string): StreamSummary {
  const summary: StreamSummary = { init: null, toolCalls: {}, assistantMessages: 0, result: null, stray: [] };
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      summary.stray.push(trimmed.slice(0, 300));
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'system' && ev.subtype === 'init') {
      const servers = Array.isArray(ev.mcp_servers) ? ev.mcp_servers : [];
      summary.init = {
        model: typeof ev.model === 'string' ? ev.model : null,
        mcpServers: servers
          .filter((s: any) => s && typeof s.name === 'string')
          .map((s: any) => ({ name: s.name, status: typeof s.status === 'string' ? s.status : 'unknown' })),
        tools: Array.isArray(ev.tools) ? ev.tools.filter((t: unknown) => typeof t === 'string') : [],
      };
    } else if (ev.type === 'assistant') {
      summary.assistantMessages++;
      const content = ev.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'tool_use' && typeof block.name === 'string') {
            summary.toolCalls[block.name] = (summary.toolCalls[block.name] ?? 0) + 1;
          }
        }
      }
    } else if (ev.type === 'result') {
      summary.result = ev as ResultEvent;
    }
  }
  return summary;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export type ProcessRunner = (
  bin: string,
  args: string[],
  io: { cwd: string; stdin: string; timeoutMs: number },
) => Promise<ProcessResult>;

/**
 * Quote one argument for the Windows shell the .cmd shim forces on us.
 *
 * cmd.exe re-parses the joined command line, so every argument that carries a
 * character cmd gives meaning to — not just whitespace — goes in double quotes,
 * inside which `&|<>^` are literal. A double quote inside an argument cannot
 * be made safe for both cmd and the C runtime behind it, and no model id, path
 * or tool name legitimately contains one, so it is refused outright.
 */
export function quoteForCmd(arg: string): string {
  if (arg.includes('"')) throw new Error(`Argument contains a double quote, which cannot be passed safely through cmd.exe: ${arg}`);
  return arg === '' || /[\s&|<>^()%!]/.test(arg) ? `"${arg}"` : arg;
}

/**
 * Spawn the CLI. CLAUDECODE / CLAUDE_CODE_ENTRYPOINT are unset so a benchmark
 * started from inside a Claude Code session is not refused as a nested one.
 * Auto-memory is switched off: a cell that saved "the table is called X" would
 * hand the answer to every later cell run from the same folder.
 */
export const spawnProcess: ProcessRunner = (bin, args, io) =>
  new Promise(resolve => {
    const started = Date.now();
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    const win = process.platform === 'win32';
    const child = spawn(bin, win ? args.map(quoteForCmd) : args, {
      cwd: io.cwd,
      env,
      shell: win,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000).unref();
    }, io.timeoutMs);
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${err.message}`.trim(), exitCode: null, timedOut, durationMs: Date.now() - started });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut, durationMs: Date.now() - started });
    });
    child.stdin.on('error', () => { /* the CLI exited before reading the prompt; `close` reports it */ });
    child.stdin.end(io.stdin, 'utf8');
  });

export interface ClaudeCodeOutcome {
  summary: StreamSummary;
  process: ProcessResult;
}

export async function runClaudeCode(opts: ClaudeCodeOptions, run: ProcessRunner = spawnProcess): Promise<ClaudeCodeOutcome> {
  const result = await run(opts.claudeBin, buildClaudeArgs(opts), { cwd: opts.cwd, stdin: opts.prompt, timeoutMs: opts.timeoutMs });
  return { summary: parseStreamJson(result.stdout), process: result };
}

export interface RecordContext {
  spec: PromptSpec;
  modelRequested: string;
  mcp: boolean;
  serverVersion: string | null;
  serverGitSha: string | null;
  label: string | null;
  notes: string | null;
  credits: CreditsConfig;
  /** Keep the opening of the answer in the record (default true). */
  excerpt: boolean;
  timestamp: Date;
  /** Sandbox runs: checks scored outside the answer (files written, the build), counted into `score`. */
  extraChecks?: CheckResult[];
  /** Sandbox runs: what the cell wrote, relative to the sandbox package. */
  artifacts?: string[];
  build?: BuildResult | null;
}

const EXCERPT_CHARS = 400;

function outcomeOf(o: ClaudeCodeOutcome): BenchmarkOutcome {
  if (o.process.timedOut) return 'timeout';
  const r = o.summary.result;
  if (!r) return 'error';
  const subtype = r.subtype ?? '';
  if (subtype.includes('max_turns')) return 'max_turns';
  if (subtype.includes('budget')) return 'budget_exceeded';
  if (r.is_error || subtype.startsWith('error')) return 'error';
  return 'completed';
}

/** Fold a finished cell into the record the store keeps. Pure: no I/O, so it is testable from a captured stream. */
export function toBenchmarkRun(o: ClaudeCodeOutcome, ctx: RecordContext): BenchmarkRun {
  const r = o.summary.result;
  const usage = r?.usage ?? {};
  const byModel = r?.modelUsage ?? {};
  const modelIds = Object.keys(byModel).filter(m => m && m !== '<synthetic>');

  // modelUsage is the per-model breakdown; usage is the same totals in one
  // row. Prefer the breakdown when present — on a fallback-model run it is the
  // only place the second model shows up.
  let input = 0, cached = 0, output = 0;
  if (modelIds.length > 0) {
    for (const m of modelIds) {
      const u = byModel[m];
      cached += u.cacheReadInputTokens ?? 0;
      input += (u.inputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0);
      output += u.outputTokens ?? 0;
    }
  } else {
    cached = usage.cache_read_input_tokens ?? 0;
    input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + cached;
    output = usage.output_tokens ?? 0;
  }

  const model = modelIds.length > 0 ? modelIds.join('+') : (o.summary.init?.model ?? ctx.modelRequested);
  const outcome = outcomeOf(o);
  const answer = typeof r?.result === 'string' ? r.result : null;
  const answerChecks = evaluateChecks(ctx.spec, answer).checks;
  const checks = [...answerChecks, ...(ctx.extraChecks ?? [])];
  const score = checks.length === 0 ? null : checks.filter(c => c.passed).length / checks.length;
  const tools = o.summary.toolCalls;
  const toolCalls = Object.values(tools).reduce((s, n) => s + n, 0);
  const mcpToolCalls = Object.entries(tools).filter(([n]) => n.startsWith('mcp__')).reduce((s, [, n]) => s + n, 0);
  const hostCost = typeof r?.total_cost_usd === 'number' ? { value: r.total_cost_usd, unit: 'USD' } : null;

  const noteParts: string[] = [];
  if (ctx.notes) noteParts.push(ctx.notes);
  if (ctx.mcp && o.summary.init && o.summary.init.mcpServers.every(s => s.status !== 'connected')) {
    noteParts.push('MCP requested but no server reported connected — treat this cell as "without MCP" when reading it');
  }
  if (outcome !== 'completed') {
    const tail = (o.process.stderr || o.summary.stray.join(' | ')).trim().split(/\r?\n/).slice(-3).join(' | ');
    noteParts.push(`${outcome}: exit ${o.process.exitCode ?? 'n/a'}${r?.subtype ? `, ${r.subtype}` : ''}${tail ? ` — ${tail.slice(0, 300)}` : ''}`);
  }

  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    runId: buildRunId(ctx.timestamp, ctx.spec.id, 'claude-code', model, ctx.mcp),
    timestamp: ctx.timestamp.toISOString(),
    promptId: ctx.spec.id,
    promptHash: promptHash(ctx.spec.prompt),
    host: 'claude-code',
    model,
    modelRequested: ctx.modelRequested === model ? null : ctx.modelRequested,
    mcp: ctx.mcp,
    mcpServers: (o.summary.init?.mcpServers ?? []).filter(s => s.status === 'connected').map(s => s.name),
    serverVersion: ctx.mcp ? ctx.serverVersion : null,
    serverGitSha: ctx.mcp ? ctx.serverGitSha : null,
    label: ctx.label,
    durationMs: typeof r?.duration_ms === 'number' && !o.process.timedOut ? r.duration_ms : o.process.durationMs,
    apiMs: typeof r?.duration_api_ms === 'number' ? r.duration_api_ms : null,
    requests: typeof r?.num_turns === 'number' ? r.num_turns : o.summary.assistantMessages,
    toolCalls,
    mcpToolCalls,
    tools,
    inputTokens: input,
    cachedTokens: cached,
    outputTokens: output,
    hostCost,
    aic: computeAic(ctx.credits, { model, hostCost, inputTokens: input, cachedTokens: cached, outputTokens: output }),
    outcome,
    // A run that did not finish scores 0 when the prompt has checks: it did not deliver.
    score: score === null ? null : outcome === 'completed' ? score : 0,
    checks,
    resultChars: answer === null ? null : answer.length,
    resultExcerpt: ctx.excerpt && answer !== null ? answer.slice(0, EXCERPT_CHARS) : null,
    notes: noteParts.length > 0 ? noteParts.join(' · ') : null,
    evidence: { sessionId: r?.session_id ?? null, logPath: null },
    ...(ctx.artifacts !== undefined ? { artifacts: ctx.artifacts } : {}),
    ...(ctx.build !== undefined ? { build: ctx.build } : {}),
  };
}
