/**
 * Host-agnostic shape of an agent session, plus the reader that sniffs which
 * host wrote a log.
 *
 * The cost method in #824 needs only per-request token classes and the tool
 * calls between requests — nothing host-specific — so every host format is
 * reduced to this one shape and the arithmetic in analyze.ts never learns
 * which editor produced the log. Copilot Chat's `main.jsonl` is the only
 * format we have a worked example for; a second reader is a new module and a
 * new entry in `READERS`, not a change to the analysis.
 */
import * as fs from 'node:fs';
import { readCopilotChatLog, sniffCopilotChatLog } from './copilotChatLog.js';

/** One model call. Token counts are as the host recorded them. */
export interface SessionRequest {
  /** epoch ms the request started — the only ordering we can trust. */
  ts: number;
  model: string;
  /** Host's own label for the call, e.g. 'panel/editAgent'. Free text. */
  purpose: string;
  /** Total prompt tokens, cached ones included. */
  inputTokens: number;
  /** Prompt tokens served from the provider's cache. */
  cachedTokens: number;
  outputTokens: number;
  /**
   * What the host says it was billed, in `costUnit`. `null` when the host
   * records no cost at all; `0` is a real answer (an included model).
   */
  cost: number | null;
}

export interface SessionToolCall {
  ts: number;
  /** Tool name exactly as the host logged it, MCP prefix and all. */
  name: string;
  /** Server-side duration in ms. */
  durationMs: number;
  /** Length of the logged result — see `resultTruncationCap` before trusting it. */
  resultChars: number;
  /** Content-based, deliberately narrow — see copilotChatLog.ts for why. */
  failed: boolean;
}

export interface AgentSession {
  /** Human-readable format id, printed so a surprising parse is visible. */
  format: string;
  sessionId: string | null;
  /** Billing unit of `SessionRequest.cost`, e.g. 'AIU'. */
  costUnit: string;
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
}

interface Reader {
  format: string;
  sniff: (lines: string[]) => boolean;
  read: (lines: string[]) => AgentSession;
}

const READERS: Reader[] = [
  { format: 'copilot-chat/main.jsonl', sniff: sniffCopilotChatLog, read: readCopilotChatLog },
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
export function readSessionLog(path: string, formatHint?: string): AgentSession {
  if (!fs.existsSync(path)) {
    throw new Error(`No such log: ${path}`);
  }
  const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) throw new Error(`Log is empty: ${path}`);

  if (formatHint) {
    const chosen = READERS.find(r => r.format === formatHint);
    if (!chosen) {
      throw new Error(`Unknown --format '${formatHint}'. Known formats: ${READERS.map(r => r.format).join(', ')}`);
    }
    return chosen.read(lines);
  }

  const reader = READERS.find(r => r.sniff(lines));
  if (!reader) {
    throw new Error(
      `Unrecognised session log: ${path}\n` +
      `Known formats: ${READERS.map(r => r.format).join(', ')}.\n` +
      'For GitHub Copilot Chat the file is %APPDATA%/Code/User/workspaceStorage/*/GitHub.copilot-chat/debug-logs/<sessionId>/main.jsonl ' +
      '(newest directory = most recent session), and it only exists while chat debug logging is on.',
    );
  }
  return reader.read(lines);
}

export const KNOWN_FORMATS = READERS.map(r => r.format);
