/**
 * Reader for a Claude Code session transcript.
 *
 * Where: `~/.claude/projects/<project>/<sessionId>.jsonl`. Helper agents the
 * session started have files of their own next to it —
 * `<sessionId>/subagents/agent-<id>.jsonl` plus `agent-<id>.meta.json` with
 * `agentType` and `spawnDepth` — and each is read as one more agent of the
 * same session.
 *
 * One JSON object per line, `type` 'user' | 'assistant' | bookkeeping lines we
 * ignore. Properties that corrupt the numbers if assumed away (#1318):
 *
 *  1. One model response is written as SEVERAL lines — one per content block —
 *     and every line repeats the response's `message.usage`. They share
 *     `message.id`. Summing lines overstates usage ~2.5×, so a response is
 *     counted once per id. Where the repeats differ (a streamed response whose
 *     early lines carry a partial output count) the largest value per field is
 *     the final one.
 *  2. The same tool call can appear on more than one line: Claude Code also
 *     writes a copy of each request body (`api-request-blob` lines, ignored here
 *     like every other bookkeeping line). A tool call is counted once per
 *     `tool_use_id`, across the main file and every helper file.
 *  3. `input_tokens` is the UNCACHED part only. The shared shape's `inputTokens`
 *     is the whole prompt, so it is rebuilt as input + cache reads + cache
 *     writes — the other readers' definition, which analyze.ts relies on.
 *  4. No cost per request, and no server-side tool duration. Request cost is
 *     left null (analyze.ts then reports tokens only, or prices them from
 *     `--rates`); the duration is the gap between the `tool_use` line and its
 *     `tool_result` line, which includes any permission prompt, hence the
 *     'wall' duration kind. Newer versions do keep a running total for the
 *     whole session, helpers included: a `cost-state` line in the main file
 *     (the last one wins) with the cost in USD and the tokens per model. It
 *     also counts requests that are not written as assistant messages, so it
 *     is reported as `recorded`, next to the per-request figures, never mixed
 *     into them.
 *  5. Tool results are not truncated, so `resultTruncationCap` is null and
 *     carry figures are exact rather than lower bounds.
 *  6. Cache writes have two lifetimes, 5 minutes and 1 hour, priced differently.
 *     `usage.cache_creation` splits them; the 1-hour part is kept separately so
 *     `--rates` can price it at its own rate.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AgentSession, ReadContext, RecordedTotals, SessionAgent, SessionRequest, SessionToolCall,
} from './sessionLog.js';

interface Usage {
  input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_creation?: { ephemeral_1h_input_tokens?: unknown };
  output_tokens?: unknown;
}

/** Per-model totals in a `cost-state` line. `inputTokens` is the uncached part only, as in `usage`. */
interface ModelUsage {
  inputTokens?: unknown;
  cacheReadInputTokens?: unknown;
  cacheCreationInputTokens?: unknown;
  cacheCreationEphemeral1hInputTokens?: unknown;
  outputTokens?: unknown;
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: unknown;
  text?: string;
  is_error?: boolean;
}

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  /** `cost-state` lines only. */
  totalCostUSD?: unknown;
  modelUsage?: Record<string, ModelUsage>;
  message?: {
    id?: string;
    model?: string;
    content?: unknown;
    usage?: Usage;
  };
}

function parseLines(lines: string[]): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as TranscriptLine;
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      // A half-written last line is normal for a live session; skip it.
    }
  }
  return out;
}

export function sniffClaudeCodeLog(lines: string[]): boolean {
  // Bookkeeping lines (snapshots, queue operations) can precede the first
  // message, so look a little way in. The usage block is the load-bearing part:
  // a transcript without one has nothing for this command to measure.
  for (const line of lines.slice(0, 200)) {
    if (!line.includes('"usage"')) continue;
    for (const l of parseLines([line])) {
      if (l.type === 'assistant' && l.message && typeof l.message === 'object'
        && l.message.usage && typeof l.message.usage === 'object') return true;
    }
  }
  return false;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function time(value: string | undefined): number {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function blocks(content: unknown): Block[] {
  return Array.isArray(content) ? content.filter((b): b is Block => !!b && typeof b === 'object') : [];
}

/** A tool result's content is a string, or an array of blocks whose text parts are what the model reads. */
function resultChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  return blocks(content).reduce((sum, b) => sum + (typeof b.text === 'string' ? b.text.length : 0), 0);
}

interface Source {
  agent: SessionAgent;
  lines: string[];
}

/** Helper files live in `<dir>/<sessionId>/subagents/`, possibly nested for helpers of helpers. */
function findHelperFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/^agent-.+\.jsonl$/.test(e.name)) found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}

function helperAgent(file: string): SessionAgent {
  const id = path.basename(file, '.jsonl').replace(/^agent-/, '');
  let type = 'unknown';
  let spawnDepth: number | null = null;
  try {
    const meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as {
      agentType?: unknown; spawnDepth?: unknown;
    };
    if (typeof meta.agentType === 'string') type = meta.agentType;
    if (typeof meta.spawnDepth === 'number') spawnDepth = meta.spawnDepth;
  } catch {
    // No meta file: the helper is still an agent worth counting, just unnamed.
  }
  return { id, type, spawnDepth };
}

interface RawRequest {
  agent: string;
  ts: number;
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
}

/** The session total from a `cost-state` line, or null when the line is not usable. */
function recordedTotals(line: TranscriptLine): RecordedTotals | null {
  if (typeof line.totalCostUSD !== 'number' || !Number.isFinite(line.totalCostUSD)) return null;
  const models = line.modelUsage && typeof line.modelUsage === 'object' ? Object.values(line.modelUsage) : [];
  const sum = (field: keyof ModelUsage): number => models.reduce((s, m) => s + num(m?.[field]), 0);
  const uncached = sum('inputTokens');
  const cached = sum('cacheReadInputTokens');
  const cacheWrite = sum('cacheCreationInputTokens');
  return {
    cost: line.totalCostUSD,
    unit: 'USD',
    inputTokens: uncached + cached + cacheWrite,
    cachedTokens: cached,
    cacheWriteTokens: cacheWrite,
    cacheWrite1hTokens: sum('cacheCreationEphemeral1hInputTokens'),
    outputTokens: sum('outputTokens'),
  };
}

export function readClaudeCodeLog(lines: string[], ctx: ReadContext): AgentSession {
  const main: SessionAgent = { id: 'main', type: 'main', spawnDepth: 0 };
  const sources: Source[] = [{ agent: main, lines }];

  if (ctx.subagents) {
    const dir = path.join(path.dirname(ctx.path), path.basename(ctx.path, '.jsonl'), 'subagents');
    for (const file of findHelperFiles(dir)) {
      const helperLines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim().length > 0);
      sources.push({ agent: helperAgent(file), lines: helperLines });
    }
  }

  const requests = new Map<string, RawRequest>();
  const calls = new Map<string, { agent: string; ts: number; name: string }>();
  const results = new Map<string, { ts: number; chars: number; failed: boolean }>();
  let sessionId: string | null = null;
  let turns = 0;
  let recorded: RecordedTotals | null = null;

  for (const [sourceIndex, source] of sources.entries()) {
    const agent = source.agent.id;
    for (const [lineIndex, line] of parseLines(source.lines).entries()) {
      if (!sessionId && typeof line.sessionId === 'string') sessionId = line.sessionId;
      // A running total: each line replaces the one before. Only the main file
      // keeps it, and it already includes the helpers.
      if (line.type === 'cost-state' && agent === 'main') {
        recorded = recordedTotals(line) ?? recorded;
        continue;
      }
      const ts = time(line.timestamp);
      const msg = line.message;
      if (!msg || typeof msg !== 'object') continue;

      if (line.type === 'assistant') {
        // Interrupts and API errors are logged as '<synthetic>' messages with
        // zeroed usage; they are not model calls.
        if (msg.usage && typeof msg.usage === 'object' && msg.model !== '<synthetic>') {
          const key = typeof msg.id === 'string' ? msg.id : `${sourceIndex}:${lineIndex}`;
          const u = msg.usage;
          const seen = requests.get(key);
          const next = {
            input: num(u.input_tokens),
            cacheRead: num(u.cache_read_input_tokens),
            cacheWrite: num(u.cache_creation_input_tokens),
            cacheWrite1h: num(u.cache_creation?.ephemeral_1h_input_tokens),
            output: num(u.output_tokens),
          };
          if (seen) {
            seen.ts = Math.min(seen.ts, ts);
            seen.input = Math.max(seen.input, next.input);
            seen.cacheRead = Math.max(seen.cacheRead, next.cacheRead);
            seen.cacheWrite = Math.max(seen.cacheWrite, next.cacheWrite);
            seen.cacheWrite1h = Math.max(seen.cacheWrite1h, next.cacheWrite1h);
            seen.output = Math.max(seen.output, next.output);
          } else {
            requests.set(key, { agent, ts, model: typeof msg.model === 'string' ? msg.model : 'unknown', ...next });
          }
        }
        for (const b of blocks(msg.content)) {
          if (b.type === 'tool_use' && typeof b.id === 'string' && !calls.has(b.id)) {
            calls.set(b.id, { agent, ts, name: typeof b.name === 'string' ? b.name : 'unknown' });
          }
        }
      } else if (line.type === 'user') {
        const content = blocks(msg.content);
        let hasResult = false;
        for (const b of content) {
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            hasResult = true;
            if (!results.has(b.tool_use_id)) {
              results.set(b.tool_use_id, { ts, chars: resultChars(b.content), failed: b.is_error === true });
            }
          }
        }
        // A turn is something the person typed, in the main conversation: not a
        // tool result, not a harness-injected message, not a helper's prompt.
        const typed = typeof msg.content === 'string' || content.some(b => b.type === 'text');
        if (agent === 'main' && !hasResult && typed && !line.isMeta && !line.isSidechain) turns++;
      }
    }
  }

  const sessionRequests: SessionRequest[] = [...requests.values()].map(r => ({
    ts: r.ts,
    agent: r.agent,
    model: r.model,
    purpose: r.agent === 'main' ? 'main' : `helper ${r.agent}`,
    inputTokens: r.input + r.cacheRead + r.cacheWrite,
    cachedTokens: r.cacheRead,
    cacheWriteTokens: r.cacheWrite,
    cacheWrite1hTokens: Math.min(r.cacheWrite1h, r.cacheWrite),
    outputTokens: r.output,
    cost: null,
  }));

  const toolCalls: SessionToolCall[] = [...calls.entries()].map(([id, call]) => {
    const result = results.get(id);
    return {
      ts: call.ts,
      agent: call.agent,
      name: call.name,
      // No result yet (a live session) leaves the duration at 0 rather than inventing one.
      durationMs: result ? Math.max(0, result.ts - call.ts) : 0,
      resultChars: result?.chars ?? 0,
      failed: result?.failed ?? false,
    };
  });

  sessionRequests.sort((a, b) => a.ts - b.ts);
  toolCalls.sort((a, b) => a.ts - b.ts);

  return {
    format: 'claude-code/transcript.jsonl',
    sessionId,
    costUnit: null,
    toolDurationKind: 'wall',
    agents: sources.map(s => s.agent),
    requests: sessionRequests,
    toolCalls,
    turns,
    resultTruncationCap: null,
    // The total covers the helpers too, so it only matches a read that includes them.
    ...(recorded && ctx.subagents ? { recorded } : {}),
  };
}
