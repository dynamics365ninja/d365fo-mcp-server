/**
 * The round-trip cost analysis from #824, as arithmetic over a normalised
 * session (see sessionLog.ts).
 *
 * Four measurements, in the order they answer "where did the money go":
 *   1. fit the host's own billing to (cached, uncached, output) tokens,
 *   2. attribute the total across those three, then split the cached share
 *      into fixed prefix and carry,
 *   3. count round trips — the single-call tool-turns are the waste,
 *   4. per-tool table, which is where a regression in one tool shows up.
 *
 * Step 1 gates steps 2 and 4: a poor fit means the log is not what we think it
 * is, and a confident attribution built on wrong rates is worse than no
 * attribution at all. `CostFit.refusal` carries the reason and every consumer
 * must check `usable` before reading rates.
 */
import type { AgentSession, RecordedTotals, SessionRequest, SessionToolCall } from './sessionLog.js';

/** Rates are expressed per million tokens, which is how every provider quotes them. */
const TOKENS_PER_MTOK = 1e6;

/**
 * Chars per token for sizing tool results. The host logs no token count for
 * tool results, so carry cost needs an estimate; ~4 is the usual English/JSON
 * figure and it reproduced the audited session's carry to within 0.1 AIU.
 * Only carry cost and the per-tool token column depend on it — the fit, the
 * total and the prefix all use the host's own counts.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Below this many billed requests the fit is a curiosity, not a measurement:
 * three unknowns need real redundancy before the residual means anything.
 */
const MIN_BILLED_REQUESTS = 8;

/**
 * Residual ceiling, as a fraction of the average request's cost. The audited
 * session came in at 8e-6 — billing reproduced essentially exactly — so 2 % is
 * loose enough to survive rounding in another host's log and tight enough that
 * a genuinely wrong model cannot sneak through.
 */
const MAX_RELATIVE_RMSE = 0.02;

/**
 * Tools whose whole job has a plural form, so N sequential single-call turns
 * on one of them is N-1 avoidable round trips. Kept to tools where the batch
 * covers the tool's primary use — `labels` has a bulk create but its searches
 * (the common case) have no batch form, and flagging those would be noise.
 */
const PLURAL_FORM_TOOLS = [
  'get_object_info', 'run_bp_check', 'verify_d365fo_project',
  'd365fo_file',    // operations[] applies many edits to one object in a call
  'get_knowledge',  // topics[] answers several lookups in a call
  'search',         // queries[] runs several searches in one call, in parallel
];

export interface CostRates {
  /** Cost unit per million tokens. */
  cached: number;
  uncached: number;
  output: number;
  /** Cache writes. Only rates given with `--rates` carry it; a fit has no such column to solve for. */
  cacheWrite?: number;
  /** 1-hour cache writes, where the host splits them out. Absent: priced at `cacheWrite`. */
  cacheWrite1h?: number;
}

/**
 * Below this share of a recorded total, the per-request figures leave out
 * enough of the session to say so. Rounding alone stays well inside it.
 */
const MIN_RECORDED_COVERAGE = 0.95;

/**
 * Where the rates come from. 'fitted' solves them from the host's recorded
 * cost; 'given' takes them from the caller (`--rates`) and prices the tokens
 * itself; 'none' is a host that records no cost and a caller who gave none —
 * the analysis is then tokens only, which is a complete answer, not a failure.
 */
export type CostMode = 'fitted' | 'given' | 'none';

export interface AnalyzeOptions {
  rates?: CostRates;
}

/** Prompt tokens that were neither read from nor written to the cache. */
function uncachedOf(r: SessionRequest): number {
  return r.inputTokens - r.cachedTokens - (r.cacheWriteTokens ?? 0);
}

/** Cache-write cost per Mtok-scaled token count: 1-hour writes at their own rate when one is given. */
function cacheWriteCost(r: SessionRequest, rates: CostRates): number {
  const all = r.cacheWriteTokens ?? 0;
  const oneHour = Math.min(r.cacheWrite1hTokens ?? 0, all);
  const rate = rates.cacheWrite ?? 0;
  return (all - oneHour) * rate + oneHour * (rates.cacheWrite1h ?? rate);
}

/** Same tokens, priced with the given rates: the cost a host that records none would have charged. */
export function priceSession(session: AgentSession, rates: CostRates): AgentSession {
  return {
    ...session,
    costUnit: 'units',
    requests: session.requests.map(r => ({
      ...r,
      cost: (
        r.cachedTokens * rates.cached
        + uncachedOf(r) * rates.uncached
        + cacheWriteCost(r, rates)
        + r.outputTokens * rates.output
      ) / TOKENS_PER_MTOK,
    })),
  };
}

export interface CostFit {
  usable: boolean;
  rates: CostRates | null;
  /** Root-mean-square residual, in the cost unit, per request. */
  rmse: number | null;
  /** rmse as a fraction of the mean billed request cost — the comparable number. */
  relativeRmse: number | null;
  sampleSize: number;
  /** Why attributions are withheld. Null exactly when `usable`. */
  refusal: string | null;
}

export interface CostAttribution {
  cachedInput: number;
  uncachedInput: number;
  /** Cache writes, priced above plain input. 0 for hosts that report none. */
  cacheWrite: number;
  output: number;
  total: number;
  /** Tokens re-sent on every request — measured as the first billed request's whole input. */
  prefixTokens: number;
  /** prefixTokens × billed requests × cached rate; with several agents, each agent's own first request over its own requests. */
  fixedPrefix: number;
  /** Σ over tool results of result tokens × later billed requests × cached rate. */
  carry: number;
  /** Cached-input cost per billed request: what a round trip costs before it does any work. */
  floorPerRequest: number;
  /** True when truncated results make `carry` and the per-tool tokens lower bounds. */
  carryIsLowerBound: boolean;
}

export interface RoundTripStats {
  toolCalls: number;
  /** Turns the host counted. */
  hostTurns: number;
  /** Groups of tool calls sharing one model request — the round trips that did work. */
  toolTurns: number;
  singleCallTurns: number;
  singleCallShare: number;
  parallelTurns: number;
  parallelShare: number;
  /**
   * Single-call turns whose arguments contain a value (a GUID, a number of four or more
   * digits) that first appeared in the result of the turn right before it — so they could not
   * have been issued in that turn. A LOWER BOUND on the dependent turns: a result the host cut
   * off, or a dependency that is not a literal value, goes uncounted. Null when the log has no
   * call arguments to compare.
   */
  chainedSingleCallTurns: number | null;
  callsPerToolTurn: number;
  /** Runs of consecutive turns that each reached for the same pluralisable tool. */
  pluralOpportunities: Array<{ tool: string; turns: number; calls: number; wastedRoundTrips: number }>;
  /**
   * The same counts for the tool-turns that called each MCP server. The figures
   * above include the host's own tools (file reads, searches, helper agents),
   * which in a Claude Code session are most of the calls; this is the part a
   * server's own changes can move.
   */
  byServer: ServerRoundTrips[];
}

/**
 * Round trips for one MCP server: the tool-turns that called it at least once.
 * A single-call turn here is the same as above — the turn issued exactly one
 * call in total — so a turn that called this server alongside a file read is
 * not counted as single.
 */
export interface ServerRoundTrips {
  server: string;
  calls: number;
  toolTurns: number;
  singleCallTurns: number;
  singleCallShare: number;
}

export interface ToolStat {
  name: string;
  calls: number;
  /** Time in the tool; `SessionAnalysis.durationKind` says whether that is server time or wall time. */
  serverMs: number;
  resultTokens: number;
  /** Result tokens × later requests of the same agent that had to carry them. Needs no rates. */
  carryTokens: number;
  /** Null when no rates are available — carry cost is priced with the cached rate. */
  carry: number | null;
  truncatedResults: number;
  failures: number;
}

/**
 * The host's own session total, and how much of it the per-request figures
 * account for. Coverage is per-request tokens ÷ recorded tokens, per class;
 * null for a class the host recorded none of.
 */
export interface RecordedSummary extends RecordedTotals {
  coverage: {
    cachedTokens: number | null;
    cacheWriteTokens: number | null;
    outputTokens: number | null;
  };
}

/** One row per agent of a multi-agent session; empty when the log cannot tell agents apart. */
export interface AgentStat {
  id: string;
  type: string;
  spawnDepth: number | null;
  requests: number;
  toolCalls: number;
  /** Round trips are counted per agent: each helper has its own turns. */
  toolTurns: number;
  singleCallTurns: number;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Null in tokens-only mode. */
  cost: number | null;
}

export interface SessionAnalysis {
  format: string;
  sessionId: string | null;
  /** Null in tokens-only mode. */
  costUnit: string | null;
  costMode: CostMode;
  /** What `ToolStat.serverMs` measures — 'wall' includes any permission prompt. */
  durationKind: 'server' | 'wall';
  totals: {
    cost: number;
    requests: number;
    billedRequests: number;
    unbilledRequests: number;
    inputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    /** The 1-hour part of `cacheWriteTokens`; 0 when the host does not split them. */
    cacheWrite1hTokens: number;
    outputTokens: number;
    wallMs: number;
  };
  /** The host's own session total (Claude Code's `cost-state`); null when it keeps none. */
  recorded: RecordedSummary | null;
  models: string[];
  fit: CostFit;
  /** Null exactly when `fit.usable` is false. */
  attribution: CostAttribution | null;
  roundTrips: RoundTripStats;
  /** Only with more than one agent. */
  agents: AgentStat[];
  tools: ToolStat[];
  truncation: { cap: number | null; results: number };
  failures: Array<{ name: string; count: number }>;
  warnings: string[];
}

/**
 * Least squares with no intercept, three unknowns, via the normal equations.
 *
 * Three variables and a well-conditioned design matrix — a full QR would buy
 * nothing here, and the normal equations keep the whole fit readable. Returns
 * null when the system is singular, which is what a session that never varied
 * its token mix looks like.
 */
function solveNormalEquations(rows: Array<{ x: [number, number, number]; y: number }>): [number, number, number] | null {
  const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (const row of rows) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) a[i][j] += row.x[i] * row.x[j];
      b[i] += row.x[i] * row.y;
    }
  }
  const m = a.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let pivot = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    if (Math.abs(m[pivot][c]) < 1e-15) return null;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/** Requests the host actually charged for. An included model reports 0 and carries no price information. */
function billedRequests(requests: SessionRequest[]): SessionRequest[] {
  return requests.filter(r => r.cost !== null && r.cost > 0);
}

/**
 * Fit cost = cached·rc + uncached·ru + output·ro over the billed requests.
 *
 * The uncached term MUST be `inputTokens − cachedTokens`. Feeding `inputTokens`
 * raw makes the design matrix collinear with the cached column and the solver
 * happily returns −229.99 / 249.99 / 1000.00 at exactly the same residual — a
 * perfect fit with a negative price for reading cache. Hence the explicit
 * subtraction here and the negative-rate refusal below.
 */
export function fitCostModel(requests: SessionRequest[]): CostFit {
  const billed = billedRequests(requests);
  const refuse = (reason: string): CostFit => ({
    usable: false, rates: null, rmse: null, relativeRmse: null, sampleSize: billed.length, refusal: reason,
  });

  if (billed.length < MIN_BILLED_REQUESTS) {
    return refuse(
      `only ${billed.length} billed request(s) — at least ${MIN_BILLED_REQUESTS} are needed to fit three rates`,
    );
  }

  const rows = billed.map(r => ({
    x: [
      r.cachedTokens / TOKENS_PER_MTOK,
      uncachedOf(r) / TOKENS_PER_MTOK,
      r.outputTokens / TOKENS_PER_MTOK,
    ] as [number, number, number],
    y: r.cost!,
  }));

  const solution = solveNormalEquations(rows);
  if (!solution) {
    return refuse('the token mix never varied enough to separate the three rates (singular system)');
  }

  let squaredError = 0;
  for (const row of rows) {
    const predicted = solution[0] * row.x[0] + solution[1] * row.x[1] + solution[2] * row.x[2];
    squaredError += (predicted - row.y) ** 2;
  }
  const rmse = Math.sqrt(squaredError / rows.length);
  const meanCost = rows.reduce((sum, r) => sum + r.y, 0) / rows.length;
  const relativeRmse = meanCost > 0 ? rmse / meanCost : Infinity;

  const [cached, uncached, output] = solution;
  if (cached < 0 || uncached < 0 || output < 0) {
    return {
      usable: false,
      rates: { cached, uncached, output },
      rmse,
      relativeRmse,
      sampleSize: billed.length,
      refusal:
        `a fitted rate came out negative (${cached.toFixed(2)} / ${uncached.toFixed(2)} / ${output.toFixed(2)} per Mtok) — ` +
        'the log\'s token classes do not mean what this model assumes',
    };
  }
  if (relativeRmse > MAX_RELATIVE_RMSE) {
    return {
      usable: false,
      rates: { cached, uncached, output },
      rmse,
      relativeRmse,
      sampleSize: billed.length,
      refusal:
        `residual is ${(relativeRmse * 100).toFixed(1)} % of the average request cost (ceiling ${(MAX_RELATIVE_RMSE * 100).toFixed(0)} %) — ` +
        'the recorded cost is not a linear function of these token counts',
    };
  }

  return { usable: true, rates: { cached, uncached, output }, rmse, relativeRmse, sampleSize: billed.length, refusal: null };
}

/**
 * Group tool calls into the round trip that issued them.
 *
 * By timestamp, never by `parentSpanId`: in Copilot's log every tool_call names
 * the same `user_message` as its parent, so the parent chain says nothing about
 * turns. A tool call belongs to the last request that started before it — which
 * is exactly the request that asked for it, and exactly the request whose
 * prompt was billed to get it.
 *
 * Grouping by the host's own `turn_start`/`turn_end` windows instead is
 * possible and gives a slightly different answer — 69 single-call turns rather
 * than 66 on the audited session, which is the figure #824 published. The
 * request grouping is used here because the unit being priced is the billed
 * round trip, not the host's UI turn: calls that land after a `turn_end` but
 * before the next request were still paid for by that request.
 */
export function groupToolCallsByRequest(
  requests: SessionRequest[],
  toolCalls: SessionToolCall[],
): SessionToolCall[][] {
  const ordered = [...requests].sort((a, b) => a.ts - b.ts);
  const groups = new Map<number, SessionToolCall[]>();
  for (const call of toolCalls) {
    let owner = -1;
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i].ts <= call.ts) owner = i; else break;
    }
    const bucket = groups.get(owner);
    if (bucket) bucket.push(call); else groups.set(owner, [call]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
}

/**
 * How many single-call turns visibly depend on the turn before them. Turn i depends on
 * turn i-1 when one of its arguments is a value that turn i-1's results showed for the first
 * time: had it been issued alongside i-1, the model could not have known it yet. A value that
 * any earlier call already carried, in arguments or results, is not counted — the model could
 * have used it a turn sooner.
 */
function sumChained(perAgent: Array<number | null>): number | null {
  const known = perAgent.filter((n): n is number => n !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

export function chainedSingleCallTurns(groups: SessionToolCall[][]): number | null {
  if (!groups.some(g => g.some(c => c.argTokens !== undefined))) return null;
  const seenEarlier = new Set<string>();
  let previousResults = new Set<string>();
  let chained = 0;
  groups.forEach((group, i) => {
    const args = group.flatMap(c => c.argTokens ?? []);
    if (i > 0 && group.length === 1 && args.some(t => previousResults.has(t) && !seenEarlier.has(t))) chained++;
    for (const t of previousResults) seenEarlier.add(t);
    for (const t of args) seenEarlier.add(t);
    previousResults = new Set(group.flatMap(c => c.resultTokens ?? []));
  });
  return chained;
}

/**
 * The MCP server a tool belongs to, from the name the host logged; null for the
 * host's own tools. Claude Code writes `mcp__<server>__<tool>`, where a
 * plugin-bundled server's name itself has single underscores
 * (`mcp__plugin_<plugin>_<server>__<tool>`); Copilot writes `mcp_<server>_<tool>`.
 */
export function mcpServerOf(name: string): string | null {
  const claude = /^mcp__(.+?)__./.exec(name);
  if (claude) return claude[1];
  const copilot = /^mcp_([A-Za-z0-9-]+)_./.exec(name);
  return copilot ? copilot[1] : null;
}

/** Round trips per MCP server, over the tool-turns already grouped per agent. */
function roundTripsByServer(turnGroups: SessionToolCall[][]): ServerRoundTrips[] {
  const byServer = new Map<string, ServerRoundTrips>();
  for (const group of turnGroups) {
    const servers = new Map<string, number>();
    for (const call of group) {
      const server = mcpServerOf(call.name);
      if (server) servers.set(server, (servers.get(server) ?? 0) + 1);
    }
    for (const [server, calls] of servers) {
      let stat = byServer.get(server);
      if (!stat) {
        stat = { server, calls: 0, toolTurns: 0, singleCallTurns: 0, singleCallShare: 0 };
        byServer.set(server, stat);
      }
      stat.calls += calls;
      stat.toolTurns++;
      if (group.length === 1) stat.singleCallTurns++;
    }
  }
  const out = [...byServer.values()];
  for (const s of out) s.singleCallShare = s.toolTurns > 0 ? s.singleCallTurns / s.toolTurns : 0;
  return out.sort((a, b) => b.calls - a.calls);
}

/** Strip the host's `mcp_<server>_` prefix so tool names match our own schema names. */
function bareToolName(name: string): string {
  // Copilot writes `mcp_<server>_<tool>`, Claude Code `mcp__<server>__<tool>`.
  return name.replace(/^mcp_{1,2}[A-Za-z0-9-]+__?/, '');
}

/**
 * Runs of consecutive turns that each reached for the same pluralisable tool.
 *
 * Counted per TURN, not per call: two calls inside one turn already went out in
 * a single round trip, which is the outcome the plural forms exist to produce.
 * A run of N turns is N-1 round trips that one `objects:[…]` call would have
 * saved — the pattern #825/#826 added the plural forms for, and the one thing
 * in this report a prompt change can fix directly.
 */
function pluralOpportunities(turnGroups: SessionToolCall[][]): RoundTripStats['pluralOpportunities'] {
  const runs: RoundTripStats['pluralOpportunities'] = [];
  let current: { tool: string; turns: number; calls: number } | null = null;
  const flush = () => {
    if (current && current.turns >= 2) {
      runs.push({ tool: current.tool, turns: current.turns, calls: current.calls, wastedRoundTrips: current.turns - 1 });
    }
    current = null;
  };
  for (const group of turnGroups) {
    // A turn can touch several tools; continue the run this turn's calls can
    // continue, and start a fresh one for the first pluralisable tool otherwise.
    const bare = group.map(c => bareToolName(c.name)).filter(n => PLURAL_FORM_TOOLS.includes(n));
    const continued = current && bare.includes(current.tool) ? current.tool : null;
    if (continued && current) {
      current.turns++;
      current.calls += bare.filter(n => n === continued).length;
      continue;
    }
    flush();
    if (bare.length > 0) current = { tool: bare[0], turns: 1, calls: bare.filter(n => n === bare[0]).length };
  }
  flush();
  return runs;
}

const agentKey = (x: { agent?: string }): string => x.agent ?? 'main';

const pct0 = (value: number): string => `${Math.round(value * 100)} %`;

export function analyzeSession(input: AgentSession, opts: AnalyzeOptions = {}): SessionAnalysis {
  // Given rates price every request themselves and replace whatever the host
  // recorded — the only way to get a cost out of a host that records none.
  const session = opts.rates ? priceSession(input, opts.rates) : input;
  const costMode: CostMode = opts.rates ? 'given' : session.costUnit === null ? 'none' : 'fitted';
  const { requests, toolCalls } = session;
  // With no cost there is no "billed" subset: every request is a round trip
  // that re-read the context, which is what the token figures count.
  const billed = costMode === 'none' ? requests : billedRequests(requests);
  const warnings: string[] = [];

  const totalCost = requests.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  const timestamps = [...requests.map(r => r.ts), ...toolCalls.map(t => t.ts)];
  const wallMs = timestamps.length > 0 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;

  let fit: CostFit;
  if (costMode === 'given') {
    fit = { usable: true, rates: opts.rates!, rmse: 0, relativeRmse: 0, sampleSize: billed.length, refusal: null };
  } else if (costMode === 'none') {
    fit = {
      usable: false, rates: null, rmse: null, relativeRmse: null, sampleSize: 0,
      refusal: 'this host records no cost per request — pass --rates <cached>,<uncached>,<cacheWrite>,<output>[,<cacheWrite1h>] to price the tokens',
    };
  } else {
    fit = fitCostModel(requests);
  }

  const unbilled = requests.length - billed.length;
  if (costMode === 'fitted') {
    const billedModels = [...new Set(billed.map(r => r.model))];
    if (billedModels.length > 1) {
      warnings.push(
        `${billedModels.length} billed models in one session (${billedModels.join(', ')}) — ` +
        'the fitted rates are a blend, so per-model figures cannot be read off them',
      );
    }
    if (unbilled > 0) {
      const unbilledModels = [...new Set(requests.filter(r => !(r.cost !== null && r.cost > 0)).map(r => r.model))];
      warnings.push(
        `${unbilled} request(s) cost nothing (${unbilledModels.join(', ')}) — excluded from the fit, ` +
        'they carry no price information but do still consume wall time',
      );
    }
  }

  // Which requests still had to carry a tool result. Per agent: a helper's
  // results live in the helper's context, not in the orchestrator's.
  const billedTsByAgent = new Map<string, number[]>();
  for (const r of billed) {
    const list = billedTsByAgent.get(agentKey(r));
    if (list) list.push(r.ts); else billedTsByAgent.set(agentKey(r), [r.ts]);
  }
  for (const list of billedTsByAgent.values()) list.sort((a, b) => a - b);
  const laterBilled = (agent: string, ts: number): number => {
    const billedTs = billedTsByAgent.get(agent) ?? [];
    let lo = 0, hi = billedTs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (billedTs[mid] > ts) hi = mid; else lo = mid + 1;
    }
    return billedTs.length - lo;
  };

  const resultTokens = (call: SessionToolCall) => Math.ceil(call.resultChars / CHARS_PER_TOKEN);

  // Attribution — only when the rates can be trusted.
  let attribution: CostAttribution | null = null;
  if (fit.usable && fit.rates) {
    const rate = fit.rates;
    let cachedInput = 0, uncachedInput = 0, cacheWrite = 0, output = 0;
    for (const r of billed) {
      cachedInput += (r.cachedTokens / TOKENS_PER_MTOK) * rate.cached;
      uncachedInput += (uncachedOf(r) / TOKENS_PER_MTOK) * rate.uncached;
      cacheWrite += cacheWriteCost(r, rate) / TOKENS_PER_MTOK;
      output += (r.outputTokens / TOKENS_PER_MTOK) * rate.output;
    }
    // The prompt prefix is measured as the FIRST billed request's whole input:
    // system prompt + tool schemas + the opening message, before any tool
    // result exists to inflate it. It cannot be split into system vs tools —
    // the host logs the tool catalogue as an opaque blob and does not record
    // how much of it was actually sent. Each agent has a prefix of its own.
    const prefixTokens = billed[0]?.inputTokens ?? 0;
    let fixedPrefix = 0;
    const firstByAgent = new Map<string, { input: number; count: number }>();
    for (const r of billed) {
      const seen = firstByAgent.get(agentKey(r));
      if (seen) seen.count++; else firstByAgent.set(agentKey(r), { input: r.inputTokens, count: 1 });
    }
    for (const { input: first, count } of firstByAgent.values()) {
      fixedPrefix += (first / TOKENS_PER_MTOK) * rate.cached * count;
    }
    let carry = 0;
    for (const call of toolCalls) {
      carry += (resultTokens(call) / TOKENS_PER_MTOK) * rate.cached * laterBilled(agentKey(call), call.ts);
    }
    attribution = {
      cachedInput,
      uncachedInput,
      cacheWrite,
      output,
      total: cachedInput + uncachedInput + cacheWrite + output,
      prefixTokens,
      fixedPrefix,
      carry,
      floorPerRequest: billed.length > 0 ? cachedInput / billed.length : 0,
      carryIsLowerBound: session.resultTruncationCap !== null,
    };
  }

  // Round trips — per agent, because each agent has its own request sequence
  // and one global timestamp grouping would pool concurrent helpers' calls
  // into whichever request happened to start last.
  const agentKeys = [...new Set([...requests, ...toolCalls].map(agentKey))];
  const groupsByAgent = new Map<string, SessionToolCall[][]>();
  for (const key of agentKeys) {
    groupsByAgent.set(key, groupToolCallsByRequest(
      requests.filter(r => agentKey(r) === key),
      toolCalls.filter(c => agentKey(c) === key),
    ));
  }
  const turnGroups = [...groupsByAgent.values()].flat();
  const singleCallTurns = turnGroups.filter(g => g.length === 1).length;
  const roundTrips: RoundTripStats = {
    toolCalls: toolCalls.length,
    hostTurns: session.turns,
    toolTurns: turnGroups.length,
    singleCallTurns,
    singleCallShare: turnGroups.length > 0 ? singleCallTurns / turnGroups.length : 0,
    parallelTurns: turnGroups.length - singleCallTurns,
    parallelShare: turnGroups.length > 0 ? (turnGroups.length - singleCallTurns) / turnGroups.length : 0,
    chainedSingleCallTurns: sumChained([...groupsByAgent.values()].map(chainedSingleCallTurns)),
    callsPerToolTurn: turnGroups.length > 0 ? toolCalls.length / turnGroups.length : 0,
    pluralOpportunities: [...groupsByAgent.values()].flatMap(g => pluralOpportunities(g)),
    byServer: roundTripsByServer(turnGroups),
  };

  // Per-agent table.
  const agents: AgentStat[] = [];
  if (session.agents && session.agents.length > 1) {
    for (const agent of session.agents) {
      const reqs = requests.filter(r => agentKey(r) === agent.id);
      const calls = toolCalls.filter(c => agentKey(c) === agent.id);
      const groups = groupToolCallsByRequest(reqs, calls);
      agents.push({
        id: agent.id,
        type: agent.type,
        spawnDepth: agent.spawnDepth,
        requests: reqs.length,
        toolCalls: calls.length,
        toolTurns: groups.length,
        singleCallTurns: groups.filter(g => g.length === 1).length,
        inputTokens: reqs.reduce((s, r) => s + r.inputTokens, 0),
        cachedTokens: reqs.reduce((s, r) => s + r.cachedTokens, 0),
        cacheWriteTokens: reqs.reduce((s, r) => s + (r.cacheWriteTokens ?? 0), 0),
        outputTokens: reqs.reduce((s, r) => s + r.outputTokens, 0),
        cost: costMode === 'none' ? null : reqs.reduce((s, r) => s + (r.cost ?? 0), 0),
      });
    }
  }

  // Per-tool table.
  const byTool = new Map<string, ToolStat>();
  for (const call of toolCalls) {
    let stat = byTool.get(call.name);
    if (!stat) {
      stat = {
        name: call.name, calls: 0, serverMs: 0, resultTokens: 0, carryTokens: 0,
        carry: fit.usable ? 0 : null, truncatedResults: 0, failures: 0,
      };
      byTool.set(call.name, stat);
    }
    const later = laterBilled(agentKey(call), call.ts);
    stat.calls++;
    stat.serverMs += call.durationMs;
    stat.resultTokens += resultTokens(call);
    stat.carryTokens += resultTokens(call) * later;
    if (stat.carry !== null && fit.rates) {
      stat.carry += (resultTokens(call) / TOKENS_PER_MTOK) * fit.rates.cached * later;
    }
    if (session.resultTruncationCap !== null && call.resultChars >= session.resultTruncationCap) stat.truncatedResults++;
    if (call.failed) stat.failures++;
  }
  const sortKey = (t: ToolStat): number => costMode === 'none' ? t.carryTokens : (t.carry ?? t.resultTokens);
  const tools = [...byTool.values()].sort((a, b) => sortKey(b) - sortKey(a));

  const truncatedResults = tools.reduce((sum, t) => sum + t.truncatedResults, 0);
  if (truncatedResults > 0) {
    warnings.push(
      `${truncatedResults} tool result(s) hit the host log's ${session.resultTruncationCap!.toLocaleString('en-US')}-char cap — ` +
      'result tokens and carry cost are LOWER BOUNDS',
    );
  }

  const failures = tools
    .filter(t => t.failures > 0)
    .map(t => ({ name: t.name, count: t.failures }))
    .sort((a, b) => b.count - a.count);

  const totalCached = requests.reduce((s, r) => s + r.cachedTokens, 0);
  const totalCacheWrite = requests.reduce((s, r) => s + (r.cacheWriteTokens ?? 0), 0);
  const totalOutput = requests.reduce((s, r) => s + r.outputTokens, 0);
  let recorded: RecordedSummary | null = null;
  if (session.recorded) {
    const rec = session.recorded;
    const share = (mine: number, theirs: number): number | null => (theirs > 0 ? mine / theirs : null);
    recorded = {
      ...rec,
      coverage: {
        cachedTokens: share(totalCached, rec.cachedTokens),
        cacheWriteTokens: share(totalCacheWrite, rec.cacheWriteTokens),
        outputTokens: share(totalOutput, rec.outputTokens),
      },
    };
    // The host counts requests the log does not show; say so rather than let
    // the per-request totals pass for the whole session.
    const short = ([
      ['cache reads', recorded.coverage.cachedTokens],
      ['cache writes', recorded.coverage.cacheWriteTokens],
      ['output', recorded.coverage.outputTokens],
    ] as const).filter(([, c]) => c !== null && c < MIN_RECORDED_COVERAGE);
    if (short.length > 0) {
      warnings.push(
        `the log's requests hold ${short.map(([name, c]) => `${pct0(c!)} of the ${name}`).join(', ')} ` +
        `the host recorded for this session (${rec.cost.toFixed(2)} ${rec.unit}) — ` +
        'token figures here, and any cost priced from them, understate the session',
      );
    }
  }

  return {
    format: session.format,
    sessionId: session.sessionId,
    costUnit: session.costUnit,
    costMode,
    durationKind: session.toolDurationKind,
    totals: {
      cost: totalCost,
      requests: requests.length,
      billedRequests: costMode === 'none' ? 0 : billed.length,
      unbilledRequests: costMode === 'none' ? 0 : unbilled,
      inputTokens: requests.reduce((s, r) => s + r.inputTokens, 0),
      cachedTokens: totalCached,
      cacheWriteTokens: totalCacheWrite,
      cacheWrite1hTokens: requests.reduce((s, r) => s + (r.cacheWrite1hTokens ?? 0), 0),
      outputTokens: totalOutput,
      wallMs,
    },
    recorded,
    models: [...new Set(requests.map(r => r.model))],
    fit,
    attribution,
    roundTrips,
    agents,
    tools,
    truncation: { cap: session.resultTruncationCap, results: truncatedResults },
    failures,
    warnings,
  };
}
