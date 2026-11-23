/**
 * `d365fo-mcp session` reading Claude Code transcripts (#1318).
 *
 * Every transcript here is synthetic and tiny: the shapes that matter (one
 * response written as several lines, history copied into a resumed file, a
 * helper agent's own file) are built by hand, so nothing from a real session
 * enters the repo.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeSession, mcpServerOf, priceSession } from '../../src/cli/session/analyze.js';
import { readSessionLog } from '../../src/cli/session/sessionLog.js';
import { parseRates } from '../../src/cli/commands/session.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const iso = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

interface Usage { input?: number; read?: number; write?: number; out?: number }

const usage = (u: Usage) => ({
  input_tokens: u.input ?? 0,
  cache_read_input_tokens: u.read ?? 0,
  cache_creation_input_tokens: u.write ?? 0,
  output_tokens: u.out ?? 0,
});

/** One content block of an assistant response, as its own line — the way Claude Code writes it. */
function assistantLine(id: string, t: number, content: object, u: Usage, extra: object = {}): string {
  return JSON.stringify({
    type: 'assistant', sessionId: 'session-1', timestamp: iso(t),
    message: { id, model: 'claude-test-model', role: 'assistant', content: [content], usage: usage(u) },
    ...extra,
  });
}

const toolUse = (id: string, name = 'mcp__d365fo__search') => ({ type: 'tool_use', id, name, input: {} });

function resultLine(toolUseId: string, t: number, text: string, isError = false): string {
  return JSON.stringify({
    type: 'user', sessionId: 'session-1', timestamp: iso(t),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, ...(isError ? { is_error: true } : {}) }],
    },
  });
}

const promptLine = (t: number, text = 'do the thing'): string => JSON.stringify({
  type: 'user', sessionId: 'session-1', timestamp: iso(t), message: { role: 'user', content: text },
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-claude-code-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeMain(lines: string[], name = 'session-1.jsonl'): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function writeHelper(sessionFile: string, id: string, lines: string[], meta?: object): void {
  const subDir = path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, `agent-${id}.jsonl`), `${lines.join('\n')}\n`);
  if (meta) fs.writeFileSync(path.join(subDir, `agent-${id}.meta.json`), JSON.stringify(meta));
}

/** Two requests, two sequential single calls — the smallest session with a round-trip story. */
function basicSession(): string[] {
  return [
    promptLine(0),
    assistantLine('msg_1', 1, toolUse('tu_1'), { input: 10, read: 1000, write: 200, out: 50 }),
    resultLine('tu_1', 3, 'x'.repeat(400)),
    assistantLine('msg_2', 4, toolUse('tu_2'), { input: 20, read: 1500, write: 0, out: 70 }),
    resultLine('tu_2', 5, 'y'.repeat(40)),
    assistantLine('msg_3', 6, { type: 'text', text: 'done' }, { input: 5, read: 1700, write: 0, out: 30 }),
  ];
}

describe('claude code reader', () => {
  it('is picked by content, without --format', () => {
    const session = readSessionLog(writeMain(basicSession()));
    expect(session.format).toBe('claude-code/transcript.jsonl');
    expect(session.sessionId).toBe('session-1');
    expect(session.costUnit).toBeNull();
    expect(session.resultTruncationCap).toBeNull();
  });

  it('rebuilds the whole prompt as uncached + cache reads + cache writes', () => {
    const session = readSessionLog(writeMain(basicSession()));
    const first = session.requests[0];
    expect(first.inputTokens).toBe(10 + 1000 + 200);
    expect(first.cachedTokens).toBe(1000);
    expect(first.cacheWriteTokens).toBe(200);
    expect(first.outputTokens).toBe(50);
  });

  it('counts a response written as several lines once', () => {
    // Three content blocks of ONE response: thinking, text, tool_use — each its own line, same usage.
    const u = { input: 10, read: 1000, write: 0, out: 50 };
    const session = readSessionLog(writeMain([
      promptLine(0),
      assistantLine('msg_1', 1, { type: 'thinking', thinking: '…' }, u),
      assistantLine('msg_1', 1, { type: 'text', text: 'looking' }, u),
      assistantLine('msg_1', 2, toolUse('tu_1'), u),
      resultLine('tu_1', 3, 'ok'),
    ]));
    expect(session.requests).toHaveLength(1);
    expect(session.requests[0].inputTokens).toBe(1010);
    expect(session.requests[0].outputTokens).toBe(50);
    expect(session.requests[0].ts).toBe(T0 + 1000);
    expect(session.toolCalls).toHaveLength(1);
  });

  it('takes the final output count when the repeats of one response disagree', () => {
    const session = readSessionLog(writeMain([
      assistantLine('msg_1', 1, { type: 'text', text: 'a' }, { input: 1, read: 100, out: 2 }),
      assistantLine('msg_1', 2, { type: 'text', text: 'b' }, { input: 1, read: 100, out: 80 }),
    ]));
    expect(session.requests).toHaveLength(1);
    expect(session.requests[0].outputTokens).toBe(80);
  });

  it('skips the synthetic messages Claude Code logs for interrupts and API errors', () => {
    const session = readSessionLog(writeMain([
      ...basicSession(),
      JSON.stringify({
        type: 'assistant', sessionId: 'session-1', timestamp: iso(9),
        message: { id: 'msg_x', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error' }], usage: usage({}) },
      }),
    ]));
    expect(session.requests).toHaveLength(3);
  });

  it('counts a tool call once when it appears on several lines, across the main file and a helper file', () => {
    const copiedCall = assistantLine('msg_1', 1, toolUse('tu_1'), { input: 10, read: 1000, out: 50 });
    const copiedResult = resultLine('tu_1', 3, 'x'.repeat(400));
    const main = writeMain([...basicSession(), copiedCall, copiedResult]);
    writeHelper(main, 'aaaa1111', [copiedCall, copiedResult], { agentType: 'general-purpose', spawnDepth: 1 });

    const session = readSessionLog(main);
    expect(session.toolCalls.map(c => c.name)).toHaveLength(2);
    expect(session.requests).toHaveLength(3);
  });

  it('reads is_error as the failure, without matching result text', () => {
    const session = readSessionLog(writeMain([
      assistantLine('msg_1', 1, toolUse('tu_1'), { input: 1, read: 100, out: 5 }),
      resultLine('tu_1', 2, 'error: this text alone says nothing'),
      assistantLine('msg_2', 3, toolUse('tu_2'), { input: 1, read: 100, out: 5 }),
      resultLine('tu_2', 4, 'cannot do that', true),
    ]));
    expect(session.toolCalls.map(c => c.failed)).toEqual([false, true]);
    expect(analyzeSession(session).failures).toEqual([{ name: 'mcp__d365fo__search', count: 1 }]);
  });

  it('measures tool time as the call-to-result gap and says it is wall time', () => {
    const session = readSessionLog(writeMain(basicSession()));
    expect(session.toolDurationKind).toBe('wall');
    expect(session.toolCalls.map(c => c.durationMs)).toEqual([2000, 1000]);
    const analysis = analyzeSession(session);
    expect(analysis.durationKind).toBe('wall');
    expect(analysis.tools[0].serverMs).toBe(3000);
  });

  it('keeps a call whose result has not been written yet, with no invented duration', () => {
    const session = readSessionLog(writeMain([
      assistantLine('msg_1', 1, toolUse('tu_1'), { input: 1, read: 100, out: 5 }),
    ]));
    expect(session.toolCalls).toHaveLength(1);
    expect(session.toolCalls[0].durationMs).toBe(0);
    expect(session.toolCalls[0].resultChars).toBe(0);
  });

  it('reads a result whose content is an array of text blocks', () => {
    const session = readSessionLog(writeMain([
      assistantLine('msg_1', 1, toolUse('tu_1'), { input: 1, read: 100, out: 5 }),
      JSON.stringify({
        type: 'user', sessionId: 'session-1', timestamp: iso(2),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'abcd' }, { type: 'text', text: 'efg' }] }] },
      }),
    ]));
    expect(session.toolCalls[0].resultChars).toBe(7);
  });

  it('keeps the values a call was given and a result printed, so chained turns can be counted (#1329)', () => {
    const readCall = { type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: 'a.xml', offset: 40189 } };
    const session = readSessionLog(writeMain([
      assistantLine('msg_1', 1, toolUse('tu_1', 'Grep'), { input: 1, read: 100, out: 5 }),
      resultLine('tu_1', 2, 'a.xml\n40189: <Node/>'),
      assistantLine('msg_2', 3, readCall, { input: 1, read: 200, out: 5 }),
      resultLine('tu_2', 4, 'ok'),
    ]));
    expect(session.toolCalls[0].resultTokens).toEqual(['40189']);
    expect(session.toolCalls[1].argTokens).toEqual(['40189']);
    expect(analyzeSession(session).roundTrips.chainedSingleCallTurns).toBe(1);
  });

  it('survives a session with no tool calls at all', () => {
    const session = readSessionLog(writeMain([
      promptLine(0),
      assistantLine('msg_1', 1, { type: 'text', text: 'hello' }, { input: 3, read: 500, out: 10 }),
    ]));
    const a = analyzeSession(session);
    expect(a.roundTrips.toolCalls).toBe(0);
    expect(a.roundTrips.toolTurns).toBe(0);
    expect(a.roundTrips.singleCallShare).toBe(0);
    expect(a.tools).toEqual([]);
    expect(a.agents).toEqual([]);
    expect(a.totals.requests).toBe(1);
  });

  it('counts a turn as something typed, not a tool result', () => {
    const session = readSessionLog(writeMain(basicSession()));
    expect(session.turns).toBe(1);
  });

  it('ignores the request copies Claude Code writes as api-request-blob lines', () => {
    // The copy repeats the tool calls and results of a request in one line of its own.
    const blob = JSON.stringify({
      type: 'api-request-blob', sessionId: 'session-1', hash: 'h1',
      message: { content: [toolUse('tu_1'), toolUse('tu_9'), { type: 'tool_result', tool_use_id: 'tu_9', content: 'zz' }] },
    });
    const session = readSessionLog(writeMain([...basicSession(), blob]));
    expect(session.requests).toHaveLength(3);
    expect(session.toolCalls).toHaveLength(2);
  });

  it('refuses a file that is not a transcript', () => {
    const file = writeMain([JSON.stringify({ hello: 'world' })]);
    expect(() => readSessionLog(file)).toThrow(/Unrecognised session log/);
  });
});

describe('tokens-only analysis (no cost recorded, no --rates)', () => {
  const analysis = analyzeSession(readSessionLogOf(basicSession()));

  it('reports tokens and round trips, and no cost model', () => {
    expect(analysis.costMode).toBe('none');
    expect(analysis.costUnit).toBeNull();
    expect(analysis.attribution).toBeNull();
    expect(analysis.totals.requests).toBe(3);
    expect(analysis.totals.billedRequests).toBe(0);
    expect(analysis.totals.inputTokens).toBe(1210 + 1520 + 1705);
    expect(analysis.totals.cachedTokens).toBe(1000 + 1500 + 1700);
    expect(analysis.totals.cacheWriteTokens).toBe(200);
    expect(analysis.totals.outputTokens).toBe(150);
    expect(analysis.roundTrips.toolTurns).toBe(2);
    expect(analysis.roundTrips.singleCallTurns).toBe(2);
  });

  it('measures carry in tokens: each result is carried by every later request', () => {
    // tu_1 (100 tokens) is carried by msg_2 and msg_3; tu_2 (10 tokens) by msg_3.
    const byName = analysis.tools.find(t => t.name === 'mcp__d365fo__search')!;
    expect(byName.resultTokens).toBe(110);
    expect(byName.carryTokens).toBe(100 * 2 + 10 * 1);
    expect(byName.carry).toBeNull();
  });
});

function readSessionLogOf(lines: string[]) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'session-claude-code-'));
  try {
    const file = path.join(d, 's.jsonl');
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return readSessionLog(file);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

describe('--rates', () => {
  it('parses four non-negative numbers', () => {
    expect(parseRates('0.5, 5,6.25,25')).toEqual({ cached: 0.5, uncached: 5, cacheWrite: 6.25, output: 25 });
  });

  it('takes an optional fifth number as the 1-hour cache-write rate', () => {
    expect(parseRates('0.5,5,6.25,25,10')).toEqual({ cached: 0.5, uncached: 5, cacheWrite: 6.25, output: 25, cacheWrite1h: 10 });
  });

  it.each(['1,2,3', '1,2,3,4,5,6', 'a,b,c,d', '1,2,,4', '1,2,3,-4', '1,2,3,4,-5', ''])('rejects %j', raw => {
    expect(() => parseRates(raw)).toThrow(/Invalid --rates/);
  });

  it('prices every token class separately, the cache writes at their own rate', () => {
    const session = readSessionLog(writeMain([
      assistantLine('msg_1', 1, { type: 'text', text: 'hi' }, { input: 100, read: 2000, write: 300, out: 40 }),
    ]));
    const priced = priceSession(session, { cached: 1, uncached: 10, cacheWrite: 20, output: 100 });
    // (2000×1 + 100×10 + 300×20 + 40×100) per Mtok
    expect(priced.requests[0].cost).toBeCloseTo((2000 + 1000 + 6000 + 4000) / 1e6, 10);
  });

  it('prices 1-hour cache writes at the fifth rate, and at the cache-write rate without one', () => {
    const line = JSON.stringify({
      type: 'assistant', sessionId: 'session-1', timestamp: iso(1),
      message: {
        id: 'msg_1', model: 'claude-test-model', role: 'assistant', content: [{ type: 'text', text: 'hi' }],
        usage: {
          ...usage({ input: 0, read: 0, write: 300, out: 0 }),
          cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
        },
      },
    });
    const session = readSessionLog(writeMain([line]));
    expect(session.requests[0].cacheWriteTokens).toBe(300);
    expect(session.requests[0].cacheWrite1hTokens).toBe(200);
    expect(analyzeSession(session).totals.cacheWrite1hTokens).toBe(200);

    const base = { cached: 1, uncached: 10, cacheWrite: 20, output: 100 };
    expect(priceSession(session, { ...base, cacheWrite1h: 32 }).requests[0].cost).toBeCloseTo((100 * 20 + 200 * 32) / 1e6, 10);
    expect(priceSession(session, base).requests[0].cost).toBeCloseTo((300 * 20) / 1e6, 10);
  });

  it('turns a tokens-only session into a priced one with a full attribution', () => {
    const rates = { cached: 1, uncached: 10, cacheWrite: 20, output: 100 };
    const a = analyzeSession(readSessionLogOf(basicSession()), { rates });
    expect(a.costMode).toBe('given');
    expect(a.fit.usable).toBe(true);
    const at = a.attribution!;
    expect(at.cacheWrite).toBeCloseTo((200 * 20) / 1e6, 10);
    expect(at.cachedInput).toBeCloseTo(4200 / 1e6, 10);
    expect(at.uncachedInput).toBeCloseTo((35 * 10) / 1e6, 10);
    expect(at.output).toBeCloseTo((150 * 100) / 1e6, 10);
    expect(at.total).toBeCloseTo(a.totals.cost, 10);
    // Tool carry is priced with the cached rate: 210 result-token-carries × 1 per Mtok.
    expect(a.tools[0].carry).toBeCloseTo(210 / 1e6, 10);
  });
});

describe('helper agents', () => {
  function sessionWithHelper(): string {
    const main = writeMain([
      promptLine(0),
      assistantLine('msg_m1', 1, toolUse('tu_agent', 'Agent'), { input: 10, read: 5000, out: 20 }),
      assistantLine('msg_m2', 30, { type: 'text', text: 'done' }, { input: 10, read: 5200, out: 20 }),
      resultLine('tu_agent', 29, 'helper finished'),
    ]);
    writeHelper(main, 'bbbb2222', [
      assistantLine('msg_h1', 2, toolUse('tu_h1'), { input: 5, read: 900, out: 10 }, { isSidechain: true }),
      resultLine('tu_h1', 3, 'a'.repeat(80)),
      assistantLine('msg_h2', 4, toolUse('tu_h2'), { input: 5, read: 1000, out: 10 }, { isSidechain: true }),
      assistantLine('msg_h2', 4, toolUse('tu_h3'), { input: 5, read: 1000, out: 10 }, { isSidechain: true }),
      resultLine('tu_h2', 6, 'b'.repeat(80)),
      resultLine('tu_h3', 6, 'c'.repeat(80)),
    ], { agentType: 'Contoso-reviewer', spawnDepth: 1 });
    return main;
  }

  it('reads the helper file next to the log with its type from the meta file', () => {
    const session = readSessionLog(sessionWithHelper());
    expect(session.agents).toEqual([
      { id: 'main', type: 'main', spawnDepth: 0 },
      { id: 'bbbb2222', type: 'Contoso-reviewer', spawnDepth: 1 },
    ]);
    expect(session.requests.filter(r => r.agent === 'bbbb2222')).toHaveLength(2);
  });

  it('prints one row per agent and counts round trips per agent', () => {
    const a = analyzeSession(readSessionLog(sessionWithHelper()));
    expect(a.agents.map(g => g.id)).toEqual(['main', 'bbbb2222']);
    const [main, helper] = a.agents;
    expect(main.requests).toBe(2);
    expect(main.toolCalls).toBe(1);
    expect(main.singleCallTurns).toBe(1);
    expect(helper.requests).toBe(2);
    expect(helper.toolCalls).toBe(3);
    // Two helper turns: one single call, one parallel pair.
    expect(helper.toolTurns).toBe(2);
    expect(helper.singleCallTurns).toBe(1);
    // Whole session = the sum over agents, not one pooled timestamp grouping.
    expect(a.roundTrips.toolTurns).toBe(3);
    expect(a.roundTrips.singleCallTurns).toBe(2);
    expect(helper.inputTokens).toBe(905 + 1005);
    expect(a.totals.requests).toBe(4);
  });

  it("carries a helper's results only on that helper's own later requests", () => {
    const a = analyzeSession(readSessionLog(sessionWithHelper()));
    // tu_h1 (20 tokens) is carried by the helper's second request only — never by
    // the orchestrator's request that comes later in wall-clock time.
    const helperResult = a.tools.find(t => t.name === 'mcp__d365fo__search')!;
    expect(helperResult.carryTokens).toBe(20 * 1);
  });

  it('leaves the helpers out with subagents: false', () => {
    const session = readSessionLog(sessionWithHelper(), undefined, { subagents: false });
    expect(session.agents).toEqual([{ id: 'main', type: 'main', spawnDepth: 0 }]);
    expect(session.requests).toHaveLength(2);
    expect(analyzeSession(session).agents).toEqual([]);
  });

  it('names a helper with no meta file by its id', () => {
    const main = writeMain(basicSession());
    writeHelper(main, 'cccc3333', [assistantLine('msg_h1', 2, { type: 'text', text: 'x' }, { input: 1, read: 10, out: 1 })]);
    const session = readSessionLog(main);
    expect(session.agents![1]).toEqual({ id: 'cccc3333', type: 'unknown', spawnDepth: null });
  });
});

describe('round trips per MCP server', () => {
  it.each([
    ['mcp__d365fo__search', 'd365fo'],
    ['mcp__d365fo-mcp-tools__get_object_info', 'd365fo-mcp-tools'],
    ['mcp__plugin_contoso-agents_microsoft-learn__microsoft_docs_search', 'plugin_contoso-agents_microsoft-learn'],
    ['mcp_d365fo-mcp-tools_get_object_info', 'd365fo-mcp-tools'],
    ['Read', null],
    ['Agent', null],
  ])('names the server of %j', (name, server) => {
    expect(mcpServerOf(name)).toBe(server);
  });

  it("counts only the turns that called the server, single meaning one call in the whole turn", () => {
    const a = analyzeSession(readSessionLogOf([
      promptLine(0),
      // Two host-only single-call turns: they count in the overall figure, not the server's.
      assistantLine('msg_1', 1, toolUse('tu_1', 'Read'), { input: 1, read: 100, out: 5 }),
      resultLine('tu_1', 2, 'a'),
      assistantLine('msg_2', 3, toolUse('tu_2', 'Grep'), { input: 1, read: 100, out: 5 }),
      resultLine('tu_2', 4, 'b'),
      // A server call on its own: single.
      assistantLine('msg_3', 5, toolUse('tu_3'), { input: 1, read: 100, out: 5 }),
      resultLine('tu_3', 6, 'c'),
      // A server call next to a file read: one turn, not single.
      assistantLine('msg_4', 7, toolUse('tu_4'), { input: 1, read: 100, out: 5 }),
      assistantLine('msg_4', 7, toolUse('tu_5', 'Read'), { input: 1, read: 100, out: 5 }),
      resultLine('tu_4', 8, 'd'),
      resultLine('tu_5', 8, 'e'),
      // Two server calls batched: not single.
      assistantLine('msg_5', 9, toolUse('tu_6'), { input: 1, read: 100, out: 5 }),
      assistantLine('msg_5', 9, toolUse('tu_7'), { input: 1, read: 100, out: 5 }),
      resultLine('tu_6', 10, 'f'),
      resultLine('tu_7', 10, 'g'),
    ]));
    expect(a.roundTrips.toolTurns).toBe(5);
    expect(a.roundTrips.singleCallTurns).toBe(3);
    expect(a.roundTrips.byServer).toEqual([
      { server: 'd365fo', calls: 4, toolTurns: 3, singleCallTurns: 1, singleCallShare: 1 / 3 },
    ]);
  });

  it('is empty when no MCP server was called', () => {
    const a = analyzeSession(readSessionLogOf([
      assistantLine('msg_1', 1, toolUse('tu_1', 'Read'), { input: 1, read: 100, out: 5 }),
      resultLine('tu_1', 2, 'a'),
    ]));
    expect(a.roundTrips.byServer).toEqual([]);
  });
});

describe("the host's recorded session total (cost-state)", () => {
  /** A running total, as Claude Code writes it: `inputTokens` is the uncached part only. */
  const costState = (cost: number, u: { input: number; read: number; write: number; write1h?: number; out: number }) =>
    JSON.stringify({
      type: 'cost-state', sessionId: 'session-1', totalCostUSD: cost,
      modelUsage: {
        'claude-test-model': {
          inputTokens: u.input, outputTokens: u.out, cacheReadInputTokens: u.read,
          cacheCreationInputTokens: u.write, cacheCreationEphemeral1hInputTokens: u.write1h ?? 0, costUSD: cost,
        },
      },
    });

  it('reads the last cost-state line as the recorded total, prompt rebuilt as a whole', () => {
    const session = readSessionLog(writeMain([
      ...basicSession(),
      costState(0.5, { input: 1, read: 10, write: 1, out: 1 }),
      costState(1.25, { input: 40, read: 4200, write: 200, write1h: 50, out: 150 }),
    ]));
    expect(session.recorded).toEqual({
      cost: 1.25, unit: 'USD',
      inputTokens: 40 + 4200 + 200, cachedTokens: 4200, cacheWriteTokens: 200, cacheWrite1hTokens: 50, outputTokens: 150,
    });
    // Not per request: the requests stay unpriced and the report stays tokens only.
    expect(session.requests.every(r => r.cost === null)).toBe(true);
    expect(analyzeSession(session).costMode).toBe('none');
  });

  it('reports full coverage and no warning when the requests account for the whole total', () => {
    const a = analyzeSession(readSessionLogOf([...basicSession(), costState(1.25, { input: 35, read: 4200, write: 200, out: 150 })]));
    expect(a.recorded!.coverage).toEqual({ cachedTokens: 1, cacheWriteTokens: 1, outputTokens: 1 });
    expect(a.warnings).toEqual([]);
  });

  it('warns when the host recorded more than the requests in the log show', () => {
    const a = analyzeSession(readSessionLogOf([...basicSession(), costState(2, { input: 500, read: 6000, write: 200, out: 150 })]));
    expect(a.recorded!.coverage.cachedTokens).toBeCloseTo(4200 / 6000, 10);
    expect(a.warnings).toHaveLength(1);
    expect(a.warnings[0]).toMatch(/70 % of the cache reads the host recorded .*2\.00 USD.*understate/);
  });

  it('is left out when the helpers are left out, because the total includes them', () => {
    const main = writeMain([...basicSession(), costState(1, { input: 1, read: 1, write: 1, out: 1 })]);
    expect(readSessionLog(main, undefined, { subagents: false }).recorded).toBeUndefined();
    expect(analyzeSession(readSessionLog(main, undefined, { subagents: false })).recorded).toBeNull();
  });

  it("ignores a helper file's cost-state line: the main file's total already covers it", () => {
    const main = writeMain(basicSession());
    writeHelper(main, 'dddd4444', [
      assistantLine('msg_h1', 2, { type: 'text', text: 'x' }, { input: 1, read: 10, out: 1 }),
      costState(9, { input: 1, read: 10, write: 0, out: 1 }),
    ]);
    expect(readSessionLog(main).recorded).toBeUndefined();
  });
});

describe('copilot logs are unchanged by the new fields', () => {
  it('still reads as server-timed, with no agents and no cache writes', () => {
    const session = readSessionLog(path.resolve(__dirname, 'fixtures/copilot-session.redacted.jsonl'));
    expect(session.format).toBe('copilot-chat/main.jsonl');
    expect(session.toolDurationKind).toBe('server');
    const a = analyzeSession(session);
    expect(a.costMode).toBe('fitted');
    expect(a.agents).toEqual([]);
    expect(a.totals.cacheWriteTokens).toBe(0);
    expect(a.totals.cacheWrite1hTokens).toBe(0);
    expect(a.recorded).toBeNull();
    expect(a.attribution!.cacheWrite).toBe(0);
  });
});
