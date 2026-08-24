/**
 * `d365fo-mcp session <log>` — the round-trip cost analyzer (#845).
 *
 * The fixture is a REDACTED DIGEST of the session #824 was derived from: every
 * number the analyzer reads and the exact character length of every tool result
 * are preserved, while prompts, arguments, results, responses and reasoning are
 * replaced with filler. The arithmetic is therefore identical to the real log's
 * while nothing identifying survives — the real log must never enter this repo.
 *
 * The expected values here are the CORRECTED figures, re-derived from the log:
 * they supersede the 37,4 AIU prefix and 69 single-call turns printed in #824.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { analyzeSession, fitCostModel, groupToolCallsByRequest } from '../../src/cli/session/analyze.js';
import { readSessionLog } from '../../src/cli/session/sessionLog.js';
import type { AgentSession, SessionRequest } from '../../src/cli/session/sessionLog.js';

const FIXTURE = resolve(__dirname, 'fixtures/copilot-session.redacted.jsonl');

const analysis = analyzeSession(readSessionLog(FIXTURE));

describe('session analyzer — the audited session', () => {
  it('reads the Copilot Chat format without being told which it is', () => {
    expect(analysis.format).toBe('copilot-chat/main.jsonl');
    expect(analysis.totals.requests).toBe(95);
    expect(analysis.roundTrips.toolCalls).toBe(118);
    expect(analysis.roundTrips.hostTurns).toBe(88);
  });

  it('totals the host-recorded cost', () => {
    expect(analysis.totals.cost).toBeCloseTo(305.18, 2);
  });

  it('fits 20 / 250 / 1000 AIU per Mtok to essentially zero residual', () => {
    expect(analysis.fit.usable).toBe(true);
    expect(analysis.fit.rates!.cached).toBeCloseTo(20, 2);
    expect(analysis.fit.rates!.uncached).toBeCloseTo(250, 1);
    expect(analysis.fit.rates!.output).toBeCloseTo(1000, 1);
    expect(analysis.fit.rmse!).toBeLessThan(1e-4);
    expect(analysis.fit.sampleSize).toBe(89);
  });

  it('excludes the free model from the fit rather than letting its zeros drag the rates', () => {
    // Six backgroundTodoAgent calls on an included model report 0 AIU. Fitting
    // them alongside the billed ones pulls the uncached rate from 250 to 164.
    expect(analysis.totals.unbilledRequests).toBe(6);
    expect(analysis.warnings.some(w => w.includes('cost nothing'))).toBe(true);
  });

  it('attributes the total across cached / uncached / output', () => {
    const at = analysis.attribution!;
    const total = analysis.totals.cost;
    expect(at.total).toBeCloseTo(total, 1);
    expect(at.cachedInput / total).toBeCloseTo(0.643, 2);
    expect(at.uncachedInput / total).toBeCloseTo(0.126, 2);
    expect(at.output / total).toBeCloseTo(0.231, 2);
  });

  it('splits the cached share into a fixed prefix and a carry cost', () => {
    const at = analysis.attribution!;
    expect(at.prefixTokens).toBe(22404);
    expect(at.fixedPrefix).toBeCloseTo(39.88, 1);
    expect(at.fixedPrefix / analysis.totals.cost).toBeCloseTo(0.131, 2);
    expect(at.carry).toBeCloseTo(37.24, 1);
    // Every one of the 89 round trips cost this much before doing any work.
    expect(at.floorPerRequest).toBeCloseTo(2.2, 1);
  });

  // 66, not the 69 published in #824: that figure came from grouping by the
  // host's turn_start/turn_end windows. This groups by the billed request that
  // issued the calls, which is the unit the cost model prices.
  it('counts the round-trip waste: 66 of 88 tool-turns issued exactly one call', () => {
    expect(analysis.roundTrips.toolTurns).toBe(88);
    expect(analysis.roundTrips.singleCallTurns).toBe(66);
    expect(analysis.roundTrips.parallelTurns).toBe(22);
    expect(analysis.roundTrips.singleCallShare).toBeCloseTo(0.75, 2);
    expect(analysis.roundTrips.callsPerToolTurn).toBeCloseTo(1.34, 2);
  });

  it('names read_file as the largest single context contributor', () => {
    // #824's headline per-tool finding: raw AOT XML read through read_file.
    expect(analysis.tools[0].name).toBe('read_file');
    expect(analysis.tools[0].calls).toBe(14);
    expect(analysis.tools[0].carry).toBeGreaterThan(10);
  });

  it('reports the host truncation cap so result-derived figures read as lower bounds', () => {
    expect(analysis.truncation.cap).toBe(5011);
    expect(analysis.truncation.results).toBe(11);
    expect(analysis.attribution!.carryIsLowerBound).toBe(true);
    expect(analysis.warnings.some(w => w.includes('LOWER BOUND'))).toBe(true);
  });

  it('detects failures from the result text, narrowly — status is "ok" on every span', () => {
    // A loose /error/i over the results matches 22 of the 118 calls (search
    // hits and BP findings that merely mention the word). Only two calls
    // actually failed, and both are d365fo_file.
    const total = analysis.failures.reduce((s, f) => s + f.count, 0);
    expect(total).toBe(2);
    expect(analysis.failures[0].name).toContain('d365fo_file');
  });

  it('flags consecutive turns reaching for the same pluralisable tool', () => {
    // The audited session ran get_object_info across turns 16-18 and 25-26,
    // five consecutive single-op d365fo_file writes, and run_bp_check across
    // turns 81-83 — 9 round trips a plural call would have collapsed. Nothing
    // here counts a turn that already batched.
    //
    // The d365fo_file run only shows up since operations[] was added to the
    // watched list: the write path is the single most serial thing real sessions
    // do (45 of 49 modifies were single-op in the sampled transcripts), and the
    // analyzer was silent about it while flagging much smaller runs.
    const runs = analysis.roundTrips.pluralOpportunities;

    expect(runs.map(r => [r.tool, r.turns, r.calls, r.wastedRoundTrips])).toEqual([
      ['get_object_info', 3, 3, 2],
      ['get_object_info', 2, 3, 1],
      ['d365fo_file', 5, 5, 4],
      ['run_bp_check', 3, 4, 2],
    ]);
  });
});

/** A synthetic session; `cost` is filled in per test to drive the fit. */
function syntheticSession(
  requests: Array<Partial<SessionRequest> & { cost: number | null }>,
): AgentSession {
  return {
    format: 'test',
    sessionId: 'test',
    costUnit: 'AIU',
    turns: requests.length,
    resultTruncationCap: null,
    toolCalls: [],
    requests: requests.map((r, i) => ({
      ts: 1000 + i,
      model: 'test-model',
      purpose: 'test',
      inputTokens: r.inputTokens ?? 0,
      cachedTokens: r.cachedTokens ?? 0,
      outputTokens: r.outputTokens ?? 0,
      cost: r.cost,
    })),
  };
}

/** Requests whose cost is generated exactly by the given rates. */
function pricedRequests(rates: { cached: number; uncached: number; output: number }, n = 20) {
  return Array.from({ length: n }, (_, i) => {
    const cached = 10_000 + i * 1_500;
    const uncached = 4_000 + ((i * 37) % 900);
    const output = 100 + ((i * 53) % 400);
    return {
      inputTokens: cached + uncached,
      cachedTokens: cached,
      outputTokens: output,
      cost: (cached * rates.cached + uncached * rates.uncached + output * rates.output) / 1e6,
    };
  });
}

describe('session analyzer — refusing to guess', () => {
  it('withholds attributions when the residual is large', () => {
    // Costs with no linear relationship to the token counts at all.
    const rows = pricedRequests({ cached: 20, uncached: 250, output: 1000 })
      .map((r, i) => ({ ...r, cost: i % 2 === 0 ? 0.2 : 9.5 }));
    const result = analyzeSession(syntheticSession(rows));

    expect(result.fit.usable).toBe(false);
    expect(result.fit.refusal).toContain('residual');
    expect(result.attribution).toBeNull();
    // The counts do not depend on the fit, so they must survive the refusal.
    expect(result.totals.billedRequests).toBe(20);
    expect(result.tools.every(t => t.carry === null)).toBe(true);
  });

  it('withholds attributions when a fitted rate is negative', () => {
    // The degenerate shape from the hand analysis: reading cache priced below
    // zero. It fits beautifully and means nothing.
    const rows = pricedRequests({ cached: -50, uncached: 300, output: 1000 });
    const result = analyzeSession(syntheticSession(rows));

    expect(result.fit.usable).toBe(false);
    expect(result.fit.refusal).toContain('negative');
    expect(result.attribution).toBeNull();
  });

  it('withholds attributions when there are too few billed requests to fit three rates', () => {
    const result = fitCostModel(syntheticSession(pricedRequests({ cached: 20, uncached: 250, output: 1000 }, 5)).requests);

    expect(result.usable).toBe(false);
    expect(result.refusal).toContain('billed request');
  });

  it('recovers the generating rates when the log is what we think it is', () => {
    const result = fitCostModel(syntheticSession(pricedRequests({ cached: 20, uncached: 250, output: 1000 })).requests);

    expect(result.usable).toBe(true);
    expect(result.rates!.cached).toBeCloseTo(20, 4);
    expect(result.rates!.uncached).toBeCloseTo(250, 4);
    expect(result.rates!.output).toBeCloseTo(1000, 4);
  });

  it('rejects an unrecognised log instead of guessing a number from it', () => {
    expect(() => readSessionLog(resolve(__dirname, '../../package.json')))
      .toThrow(/Unrecognised session log/);
  });

  it('says which file is missing', () => {
    expect(() => readSessionLog(resolve(__dirname, 'fixtures/nope.jsonl'))).toThrow(/No such log/);
  });
});

describe('session analyzer — turn grouping', () => {
  it('groups tool calls by the last request that started before them', () => {
    // Never by parentSpanId: in the Copilot log every tool_call names the same
    // user_message span as its parent, so the parent chain would put all 118
    // calls in a single turn.
    const requests = syntheticSession([
      { cost: 1, inputTokens: 10 }, { cost: 1, inputTokens: 10 }, { cost: 1, inputTokens: 10 },
    ]).requests;
    const call = (ts: number, name: string) => ({ ts, name, durationMs: 1, resultChars: 4, failed: false });
    const groups = groupToolCallsByRequest(requests, [
      call(1000, 'a'), call(1001, 'b'), call(1002, 'c'), call(1003, 'd'),
    ]);

    expect(groups.map(g => g.map(c => c.name))).toEqual([['a'], ['b'], ['c', 'd']]);
  });

  it('ignores tool calls that precede every request', () => {
    const requests = syntheticSession([{ cost: 1, inputTokens: 10 }]).requests;
    const groups = groupToolCallsByRequest(requests, [
      { ts: 1, name: 'early', durationMs: 1, resultChars: 4, failed: false },
      { ts: 2000, name: 'late', durationMs: 1, resultChars: 4, failed: false },
    ]);

    expect(groups.map(g => g.map(c => c.name))).toEqual([['early'], ['late']]);
  });
});
