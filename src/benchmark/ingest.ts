/**
 * A benchmark record from an agent-host debug log — the path for hosts that
 * cannot be driven headlessly (Copilot Chat in VS / VS Code on the VM).
 *
 * Reuses the `session` command's readers: whatever `readSessionLog` can parse
 * becomes a record here, with the same token classes and the host's own cost.
 * The prompt is named by the caller — the log holds the real prompt text, and
 * the record deliberately does not (see "Never commit a raw log" in
 * docs/TESTING.md): only the catalogue id and hash go in.
 */
import type { AgentSession } from '../cli/session/sessionLog.js';
import { computeAic } from './credits.js';
import { promptHash } from './prompts.js';
import { buildRunId } from './store.js';
import { BENCHMARK_SCHEMA_VERSION, type BenchmarkRun, type CreditsConfig, type PromptSpec } from './types.js';

export interface IngestContext {
  spec: PromptSpec;
  /** Force the MCP flag; null = detect from `mcp_`-prefixed tool calls. */
  mcp: boolean | null;
  /** Manual grade 0..1, since nothing automatic can read the answer out of a Copilot log. */
  score: number | null;
  label: string | null;
  notes: string | null;
  logPath: string | null;
  serverVersion: string | null;
  serverGitSha: string | null;
  credits: CreditsConfig;
}

/** 'copilot-chat/main.jsonl' → 'copilot-chat'; any other reader keeps its id up to the slash. */
export function hostOfFormat(format: string): string {
  return format.split('/')[0] || format;
}

const MCP_TOOL_PREFIX = /^mcp_/;

export function sessionToBenchmarkRun(session: AgentSession, ctx: IngestContext): BenchmarkRun {
  const { requests, toolCalls } = session;
  const billed = requests.filter(r => r.cost !== null && r.cost > 0);
  const models = [...new Set((billed.length > 0 ? billed : requests).map(r => r.model))];
  const model = models.length > 0 ? models.join('+') : 'unknown';

  const timestamps = [...requests.map(r => r.ts), ...toolCalls.map(t => t.ts)];
  const start = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
  const wallMs = timestamps.length > 0 ? Math.max(...timestamps) - start : 0;

  const tools: Record<string, number> = {};
  for (const call of toolCalls) tools[call.name] = (tools[call.name] ?? 0) + 1;
  const mcpToolCalls = toolCalls.filter(c => MCP_TOOL_PREFIX.test(c.name)).length;
  const mcp = ctx.mcp ?? mcpToolCalls > 0;

  const input = requests.reduce((s, r) => s + r.inputTokens, 0);
  const cached = requests.reduce((s, r) => s + r.cachedTokens, 0);
  const output = requests.reduce((s, r) => s + r.outputTokens, 0);
  const costs = requests.filter(r => r.cost !== null);
  const hostCost = costs.length > 0 ? { value: costs.reduce((s, r) => s + (r.cost ?? 0), 0), unit: session.costUnit } : null;

  const failures = toolCalls.filter(c => c.failed).length;
  const noteParts: string[] = [];
  if (ctx.notes) noteParts.push(ctx.notes);
  if (failures > 0) noteParts.push(`${failures} failed tool call(s) in the log`);
  if (session.resultTruncationCap !== null) noteParts.push('host truncated tool results in the log');

  const host = hostOfFormat(session.format);
  const ts = new Date(start);
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    runId: buildRunId(ts, ctx.spec.id, host, model, mcp),
    timestamp: ts.toISOString(),
    promptId: ctx.spec.id,
    promptHash: promptHash(ctx.spec.prompt),
    host,
    model,
    modelRequested: null,
    mcp,
    // The log names tools, not servers: strip the host prefix and tool to get the server names.
    mcpServers: [...new Set(toolCalls.map(c => c.name).filter(n => MCP_TOOL_PREFIX.test(n)).map(n => n.replace(/^mcp_/, '').split('_')[0]))],
    serverVersion: mcp ? ctx.serverVersion : null,
    serverGitSha: mcp ? ctx.serverGitSha : null,
    label: ctx.label,
    durationMs: wallMs,
    apiMs: null,
    requests: requests.length,
    toolCalls: toolCalls.length,
    mcpToolCalls,
    tools,
    inputTokens: input,
    cachedTokens: cached,
    outputTokens: output,
    hostCost,
    aic: computeAic(ctx.credits, { model, hostCost, inputTokens: input, cachedTokens: cached, outputTokens: output }),
    outcome: 'completed',
    score: ctx.score,
    checks: [],
    resultChars: null,
    resultExcerpt: null,
    notes: noteParts.length > 0 ? noteParts.join(' · ') : null,
    evidence: { sessionId: session.sessionId, logPath: ctx.logPath },
  };
}
