/**
 * Host-agnostic shape of an agent session, plus the reader that sniffs which
 * host wrote a log.
 *
 * The cost method in #824 needs only per-request token classes and the tool
 * calls between requests — nothing host-specific — so every host format is
 * reduced to this one shape and the arithmetic in analyze.ts never learns
 * which editor produced the log. Copilot Chat's `main.jsonl` was the first
 * format; Claude Code's transcript is the second — each a new module and a new
 * entry in `READERS`, not a change to the analysis.
 */
import * as fs from 'node:fs';
import { readCopilotChatLog, sniffCopilotChatLog } from './copilotChatLog.js';
import { readClaudeCodeLog, sniffClaudeCodeLog } from './claudeCodeLog.js';

/** One model call. Token counts are as the host recorded them. */
export interface SessionRequest {
  /** epoch ms the request started — the only ordering we can trust. */
  ts: number;
  model: string;
  /** Host's own label for the call, e.g. 'panel/editAgent'. Free text. */
  purpose: string;
  /** Total prompt tokens, cached ones and cache writes included. */
  inputTokens: number;
  /** Prompt tokens served from the provider's cache. */
  cachedTokens: number;
  /**
   * Prompt tokens written to the provider's cache, which is priced above plain
   * input. Included in `inputTokens`. Absent (= 0) for hosts that do not
   * report it, Copilot among them.
   */
  cacheWriteTokens?: number;
  /**
   * The part of `cacheWriteTokens` written with the 1-hour lifetime, which is
   * priced above a 5-minute write. Absent (= 0) when the host does not split them.
   */
  cacheWrite1hTokens?: number;
  outputTokens: number;
  /**
   * What the host says it was billed, in `costUnit`. `null` when the host
   * records no cost at all; `0` is a real answer (an included model).
   */
  cost: number | null;
  /** Which agent made the call — 'main' or a helper's id. Absent in a single-agent log. */
  agent?: string;
}

export interface SessionToolCall {
  ts: number;
  /** Which agent issued the call; see `SessionRequest.agent`. */
  agent?: string;
  /** Tool name exactly as the host logged it, MCP prefix and all. */
  name: string;
  /** Duration in ms; what it measures is `AgentSession.toolDurationKind`. */
  durationMs: number;
  /** Length of the logged result — see `resultTruncationCap` before trusting it. */
  resultChars: number;
  /** Content-based, deliberately narrow — see copilotChatLog.ts for why. */
  failed: boolean;
}

/**
 * The host's own running total for the whole session, where it keeps one.
 * It is one figure for the session, not per request, so it cannot be fitted;
 * it is reported next to the per-request figures, and comparing the two shows
 * how much of the session the log's requests account for.
 */
export interface RecordedTotals {
  cost: number;
  unit: string;
  /** Whole prompt, as in `SessionRequest.inputTokens`: uncached + cache reads + cache writes. */
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
}

/** One agent of a multi-agent session: the main agent or a helper it started. */
export interface SessionAgent {
  id: string;
  /** The helper's declared type; 'main' for the session's own agent. */
  type: string;
  spawnDepth: number | null;
}

export interface AgentSession {
  /** Human-readable format id, printed so a surprising parse is visible. */
  format: string;
  sessionId: string | null;
  /** Billing unit of `SessionRequest.cost`, e.g. 'AIU'. Null when the host records no cost at all. */
  costUnit: string | null;
  /**
   * What `SessionToolCall.durationMs` measures. 'server' is the host's own
   * timing of the tool; 'wall' is the gap between the call and its result,
   * which also contains any permission prompt the user had to answer.
   */
  toolDurationKind: 'server' | 'wall';
  /** Present when the log can tell agents apart; requests and calls then carry `agent`. */
  agents?: SessionAgent[];
  requests: SessionRequest[];
  toolCalls: SessionToolCall[];
  /** Turns the host itself counted, which need not equal the tool-turns. */
  turns: number;
  /**
   * Character length at which the host truncated logged tool results, or null
   * when nothing was truncated. Every token figure derived from result sizes
   * is a LOWER BOUND once this is set.
   */
  resultTruncationCap: number | null;
  /**
   * The host's session total, when it keeps one and the whole session was read.
   * Absent for Copilot (its cost is per request) and for a partial read.
   */
  recorded?: RecordedTotals;
}

export interface ReadOptions {
  /** Read helper-agent files that sit next to the log. Default true; only Claude Code has any. */
  subagents?: boolean;
}

/** What a reader may need beyond the log's own lines: where it lives, for the files next to it. */
export interface ReadContext {
  path: string;
  subagents: boolean;
}

interface Reader {
  format: string;
  sniff: (lines: string[]) => boolean;
  read: (lines: string[], ctx: ReadContext) => AgentSession;
}

const READERS: Reader[] = [
  { format: 'copilot-chat/main.jsonl', sniff: sniffCopilotChatLog, read: readCopilotChatLog },
  { format: 'claude-code/transcript.jsonl', sniff: sniffClaudeCodeLog, read: readClaudeCodeLog },
];

/**
 * Read a session log, choosing the reader by content rather than by filename —
 * hosts all call the file something different, and `main.jsonl` is not a name
 * anyone would guess.
 *
 * Fails loudly on an unrecognised log. Guessing here would produce a confident
 * cost number from a file that is not a session at all, which is the one
 * outcome this command exists to prevent.
 */
export function readSessionLog(path: string, formatHint?: string, opts: ReadOptions = {}): AgentSession {
  if (!fs.existsSync(path)) {
    throw new Error(`No such log: ${path}`);
  }
  const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) throw new Error(`Log is empty: ${path}`);
  const ctx: ReadContext = { path, subagents: opts.subagents !== false };

  if (formatHint) {
    const chosen = READERS.find(r => r.format === formatHint);
    if (!chosen) {
      throw new Error(`Unknown --format '${formatHint}'. Known formats: ${READERS.map(r => r.format).join(', ')}`);
    }
    return chosen.read(lines, ctx);
  }

  const reader = READERS.find(r => r.sniff(lines));
  if (!reader) {
    throw new Error(
      `Unrecognised session log: ${path}\n` +
      `Known formats: ${READERS.map(r => r.format).join(', ')}.\n` +
      'For GitHub Copilot Chat the file is %APPDATA%/Code/User/workspaceStorage/*/GitHub.copilot-chat/debug-logs/<sessionId>/main.jsonl ' +
      '(newest directory = most recent session), and it only exists while chat debug logging is on.\n' +
      'For Claude Code the file is ~/.claude/projects/<project>/<sessionId>.jsonl.',
    );
  }
  return reader.read(lines, ctx);
}

export const KNOWN_FORMATS = READERS.map(r => r.format);
