/**
 * Reader for GitHub Copilot Chat's `main.jsonl` debug log.
 *
 * One JSON object per line:
 *   {v?, ts, dur, sid, type, name, spanId, parentSpanId?, status, attrs}
 *
 * Four properties of this format are not obvious and each one silently
 * corrupts the analysis if assumed away — they are handled here so the
 * arithmetic in analyze.ts can stay honest:
 *
 *  1. `parentSpanId` does NOT identify a turn. Every one of the audited
 *     session's 118 tool_call spans names the same parent — the single
 *     `user_message` span — so the parent chain would put them all in one
 *     turn. The `turn_start`/`turn_end` spans do carry incrementing turnIds,
 *     but they have no parentSpanId and no tool_call references their spanIds,
 *     so nothing links a call to a turn either. Turn membership is recoverable
 *     only by timestamp (see groupToolCallsByRequest in analyze.ts).
 *  2. `status` is `"ok"` on every span, including calls that plainly failed.
 *     Failure detection has to read the result text.
 *  3. `tool_call.result` and `agent_response.response` are truncated by the
 *     host, so result sizes are lower bounds. The cap is detected rather than
 *     hard-coded, since it is the host's constant and not ours.
 *  4. `toolsFile` is a blob (`{content: "…"}`), not a tool array, and the
 *     catalogue it names was not necessarily all sent — so the prompt prefix
 *     cannot be split into system-prompt vs tool-schema tokens from this log.
 *     analyze.ts measures the prefix as one total instead.
 */
import type { AgentSession, SessionRequest, SessionToolCall } from './sessionLog.js';

/** Copilot bills in AIU; `copilotUsageNanoAiu` records it in billionths. */
const NANO_PER_AIU = 1e9;

const SPAN_TYPES = new Set([
  'session_start', 'user_message', 'turn_start', 'turn_end',
  'llm_request', 'agent_response', 'tool_call', 'discovery', 'generic',
]);

/**
 * Result prefixes that mean the call failed.
 *
 * Deliberately anchored and specific. `status` cannot be used (always "ok"),
 * and a loose /error/i over the result text matches 22 of this session's 118
 * calls — search hits, label texts and BP findings that merely contain the
 * word — which would turn a 2-failure session into a 22-failure one. These
 * three are the shapes our own server and the bridge actually emit.
 */
const FAILURE_MARKERS: RegExp[] = [
  /^\s*❌/,
  /^\s*Error modifying\b/,
  /^\s*The C# bridge is not connected\b/,
];

interface Span {
  ts?: number;
  dur?: number;
  sid?: string;
  type?: string;
  name?: string;
  attrs?: Record<string, unknown>;
}

function parseSpans(lines: string[]): Span[] {
  const spans: Span[] = [];
  for (const line of lines) {
    try {
      const span = JSON.parse(line) as Span;
      if (span && typeof span === 'object' && typeof span.type === 'string') spans.push(span);
    } catch {
      // A half-written last line is normal for a log of a live session, and
      // one dropped span cannot move a 95-request fit. Skip it.
    }
  }
  return spans;
}

export function sniffCopilotChatLog(lines: string[]): boolean {
  const head = parseSpans(lines.slice(0, 20));
  if (head.length === 0) return false;
  // A majority of known span types, not all of them: a Copilot update adding a
  // span type must not make its own logs unreadable. The llm_request is the
  // load-bearing part — a log without one is not something this command can
  // analyse whatever else it is.
  const known = head.filter(s => SPAN_TYPES.has(s.type!)).length;
  return known * 2 > head.length
    && lines.slice(0, 200).some(l => l.includes('"llm_request"'));
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** `result` is normally a string; JSON-stringify anything else so length still means something. */
function resultText(attrs: Record<string, unknown> | undefined): string {
  const raw = attrs?.result;
  if (typeof raw === 'string') return raw;
  if (raw === undefined || raw === null) return '';
  return JSON.stringify(raw);
}

/**
 * The length at which the host cut results off, inferred from the data.
 *
 * The cap is a constant of the host (5,011 chars in the audited session) but
 * hard-coding it would silently stop firing the day Copilot changes it. Two or
 * more results landing on the exact same maximum length is not a coincidence —
 * that length is the cap.
 */
function detectTruncationCap(lengths: number[]): number | null {
  if (lengths.length === 0) return null;
  const max = Math.max(...lengths);
  if (max < 1000) return null; // too small to be a cap; just a chatty tool
  return lengths.filter(l => l === max).length >= 2 ? max : null;
}

export function readCopilotChatLog(lines: string[]): AgentSession {
  const spans = parseSpans(lines);

  const requests: SessionRequest[] = [];
  const rawToolCalls: Array<{ span: Span; text: string }> = [];
  let turns = 0;
  let sessionId: string | null = null;

  for (const span of spans) {
    if (!sessionId && typeof span.sid === 'string') sessionId = span.sid;
    if (span.type === 'llm_request') {
      const a = span.attrs ?? {};
      requests.push({
        ts: num(span.ts),
        model: typeof a.model === 'string' ? a.model : 'unknown',
        purpose: typeof a.debugName === 'string' ? a.debugName : '',
        inputTokens: num(a.inputTokens),
        cachedTokens: num(a.cachedTokens),
        outputTokens: num(a.outputTokens),
        // Absent means the host recorded no price; 0 means an included model.
        cost: typeof a.copilotUsageNanoAiu === 'number' ? a.copilotUsageNanoAiu / NANO_PER_AIU : null,
      });
    } else if (span.type === 'tool_call') {
      rawToolCalls.push({ span, text: resultText(span.attrs) });
    } else if (span.type === 'turn_start') {
      turns++;
    }
  }

  const cap = detectTruncationCap(rawToolCalls.map(t => t.text.length));

  const toolCalls: SessionToolCall[] = rawToolCalls.map(({ span, text }) => ({
    ts: num(span.ts),
    name: typeof span.name === 'string' ? span.name : 'unknown',
    durationMs: num(span.dur),
    resultChars: text.length,
    failed: FAILURE_MARKERS.some(re => re.test(text)),
  }));

  requests.sort((a, b) => a.ts - b.ts);
  toolCalls.sort((a, b) => a.ts - b.ts);

  return {
    format: 'copilot-chat/main.jsonl',
    sessionId,
    costUnit: 'AIU',
    requests,
    toolCalls,
    turns,
    resultTruncationCap: cap,
  };
}
