/**
 * `d365fo-mcp session <log>` — round-trip cost analysis of an agent session (#845).
 *
 * WHY a subcommand of its own rather than `doctor --session <log>` as #824
 * phrased it: `doctor` answers "is this installation healthy", takes no input,
 * and every line it prints is a pass/fail with a fix. This takes a file, does
 * arithmetic, and reports measurements — nothing here has a "fix" in doctor's
 * sense, its exit code means something different, and the interactive menu has
 * no file path to offer. Bolting it on would double doctor's size and blur
 * both commands' contract.
 *
 * Exit codes: 0 when the cost model fitted, 1 when the log could not be read
 * or the fit was refused — in both cases the number this command exists to
 * produce is unavailable, which a release-tracking script must notice.
 */
import { basename } from 'node:path';
import { p } from '../ui.js';
import { analyzeSession, type SessionAnalysis } from '../session/analyze.js';
import { KNOWN_FORMATS, readSessionLog } from '../session/sessionLog.js';

interface SessionOptions {
  json?: boolean;
  format?: string;
  /** How many rows of the per-tool table to print. */
  top?: string;
}

const DEFAULT_TOP = 10;

function pct(value: number): string {
  return `${(value * 100).toFixed(1)} %`;
}

function aiu(value: number, unit: string): string {
  return `${value.toFixed(2)} ${unit}`;
}

function int(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function overviewNote(a: SessionAnalysis): string {
  const lines = [
    `format        ${a.format}`,
    `session       ${a.sessionId ?? '(not recorded)'}`,
    `models        ${a.models.join(', ')}`,
    `requests      ${a.totals.requests} (${a.totals.billedRequests} billed, ${a.totals.unbilledRequests} free)`,
    `tool calls    ${a.roundTrips.toolCalls} in ${a.roundTrips.toolTurns} tool-turns (host counted ${a.roundTrips.hostTurns} turns)`,
    // Prompt tokens are per request, so re-read context is counted every time
    // it is re-read. That double counting IS the subject of this report.
    `prompt sent   ${int(a.totals.inputTokens)} tokens, ${int(a.totals.cachedTokens)} of them from cache`,
    `written       ${int(a.totals.outputTokens)} tokens`,
    `wall time     ${(a.totals.wallMs / 60000).toFixed(1)} min`,
  ];
  return lines.join('\n');
}

function fitNote(a: SessionAnalysis): string {
  const r = a.fit.rates;
  const rates = r
    ? `rates         ${r.cached.toFixed(2)} cached / ${r.uncached.toFixed(2)} uncached / ${r.output.toFixed(2)} output ${a.costUnit} per Mtok`
    : 'rates         not fitted';
  const residual = a.fit.rmse !== null && a.fit.relativeRmse !== null
    ? `residual      RMSE ${a.fit.rmse.toExponential(2)} ${a.costUnit}/request (${(a.fit.relativeRmse * 100).toFixed(4)} % of the average request)`
    : 'residual      n/a';
  return [rates, residual, `sample        ${a.fit.sampleSize} billed requests`].join('\n');
}

function attributionNote(a: SessionAnalysis): string {
  const at = a.attribution!;
  const total = a.totals.cost;
  const share = (v: number) => `${aiu(v, a.costUnit).padStart(11)} ${pct(v / total).padStart(7)}`;
  return [
    `TOTAL        ${aiu(total, a.costUnit)}`,
    '',
    `cached input ${share(at.cachedInput)}  context re-read every round trip`,
    `uncached in  ${share(at.uncachedInput)}  genuinely new prompt tokens`,
    `output       ${share(at.output)}  tokens the model wrote`,
    '',
    'of the cached input:',
    `  prefix     ${share(at.fixedPrefix)}  ${int(at.prefixTokens)} tokens × ${a.totals.billedRequests} requests`,
    `  carry      ${share(at.carry)}  tool results carried by later requests`,
    ...(at.carryIsLowerBound ? ['             (carry is a LOWER BOUND — results were truncated)'] : []),
    '',
    `floor        ${aiu(at.floorPerRequest, a.costUnit)} per round trip, before any work is done`,
  ].join('\n');
}

function roundTripNote(a: SessionAnalysis): string {
  const rt = a.roundTrips;
  const lines = [
    `tool-turns   ${rt.toolTurns} for ${rt.toolCalls} calls — ${rt.callsPerToolTurn.toFixed(2)} calls per turn`,
    `single-call  ${rt.singleCallTurns} of ${rt.toolTurns} turns (${pct(rt.singleCallShare)}) issued exactly ONE call`,
    `parallel     ${rt.parallelTurns} of ${rt.toolTurns} turns (${pct(rt.parallelShare)}) batched 2+ calls`,
  ];
  if (a.attribution) {
    // The single-call turns are the round-trip waste #824 named; pricing them
    // at the floor says what batching them would have been worth.
    const wasted = rt.singleCallTurns * a.attribution.floorPerRequest;
    lines.push(`floor there  ~${aiu(wasted, a.costUnit)} sits in those single-call turns`);
  }
  return lines.join('\n');
}

/**
 * Column widths are tight because clack's note box wraps past ~75 characters,
 * and a wrapped table row is unreadable. Tool names keep the host's
 * `mcp_<server>_` prefix — it is the only thing separating our tools from the
 * editor's built-ins, which is precisely the comparison this table is for.
 */
const TOOL_NAME_WIDTH_CAP = 38;

function toolTable(a: SessionAnalysis, top: number): string {
  const shown = a.tools.slice(0, top);
  const width = Math.min(TOOL_NAME_WIDTH_CAP, Math.max(12, ...shown.map(t => t.name.length)));
  const header = 'tool'.padEnd(width + 1) + 'calls'.padStart(6) + 'srv s'.padStart(8)
    + 'res tok'.padStart(9) + 'carry'.padStart(9);
  const rows = shown.map(t =>
    t.name.slice(0, width).padEnd(width + 1)
    + String(t.calls).padStart(6)
    + (t.serverMs / 1000).toFixed(1).padStart(8)
    + int(t.resultTokens).padStart(9)
    + (t.carry === null ? '—' : t.carry.toFixed(2)).padStart(9),
  );
  if (a.tools.length > top) rows.push(`… ${a.tools.length - top} more tool(s)`);
  return [header, '-'.repeat(header.length), ...rows].join('\n');
}

function printHuman(a: SessionAnalysis, logPath: string, top: number): void {
  p.intro(`d365fo-mcp session — ${basename(logPath)}`);
  p.note(overviewNote(a), 'Session');

  for (const w of a.warnings) p.log.warn(w);

  p.note(fitNote(a), 'Cost model');
  if (!a.fit.usable) {
    // The whole point of the residual is that a bad one invalidates every
    // number downstream of it. Print the reason and stop, rather than a
    // confident attribution built on rates we just showed to be wrong.
    p.log.error(`Fit refused: ${a.fit.refusal}`);
    p.log.info(
      'Attribution, prefix and carry cost are withheld — they are all priced with the fitted rates.\n' +
      '   fix: check that the log is a complete session from a single billed model, and that its\n' +
      '        inputTokens include the cached tokens rather than excluding them.',
    );
  } else {
    p.note(attributionNote(a), `Where the ${a.costUnit} went`);
  }

  p.note(roundTripNote(a), 'Round trips');
  if (a.roundTrips.pluralOpportunities.length > 0) {
    const saved = a.roundTrips.pluralOpportunities.reduce((s, o) => s + o.wastedRoundTrips, 0);
    p.log.warn(
      `${a.roundTrips.pluralOpportunities.length} run(s) of consecutive turns reaching for the same pluralisable tool ` +
      `— ${saved} round trip(s) avoidable:\n` +
      a.roundTrips.pluralOpportunities.map(o => `   ${o.tool}: ${o.calls} call(s) spread over ${o.turns} turns`).join('\n') +
      '\n   fix: pass objects:[…] — get_object_info, run_bp_check and verify_d365fo_project all take one call for many objects',
    );
  }

  p.note(toolTable(a, top), `Per tool, by carry cost (carry in ${a.costUnit})`);

  if (a.failures.length > 0) {
    const total = a.failures.reduce((s, f) => s + f.count, 0);
    const wasted = a.attribution ? ` (~${aiu(total * a.attribution.floorPerRequest, a.costUnit)} of floor, all of it wasted)` : '';
    p.log.warn(
      `${total} failed tool call(s)${wasted}:\n` +
      a.failures.map(f => `   ${f.name} × ${f.count}`).join('\n') +
      '\n   fix: a failed call costs a full round trip and buys nothing — check whether the tool can auto-correct the input instead',
    );
  }
  if (a.truncation.cap !== null) {
    p.log.info(
      `${a.truncation.results} result(s) were cut off at the host log's ${int(a.truncation.cap)}-char cap — ` +
      'result tokens and carry cost above are lower bounds.',
    );
  }

  p.outro(a.fit.usable
    ? `${aiu(a.totals.cost, a.costUnit)} total · ${a.roundTrips.singleCallTurns}/${a.roundTrips.toolTurns} single-call tool-turns`
    : 'Cost model did not fit — see above.');
}

export async function sessionCommand(logPath: string | undefined, opts: SessionOptions = {}): Promise<void> {
  if (!logPath) {
    p.log.error('Usage: d365fo-mcp session <log> [--json] [--format <id>]');
    p.log.info(`Known formats: ${KNOWN_FORMATS.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  let analysis: SessionAnalysis;
  try {
    analysis = analyzeSession(readSessionLog(logPath, opts.format));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, log: logPath, error: message }, null, 2)}\n`);
    else p.log.error(message);
    process.exitCode = 1;
    return;
  }

  if (opts.json) {
    // Shape is the tracking contract: schemaVersion changes when a consumer
    // would have to be updated, so a release-over-release comparison can fail
    // loudly instead of silently comparing different things.
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, log: logPath, ...analysis }, null, 2)}\n`);
  } else {
    const requested = opts.top ? parseInt(opts.top, 10) : NaN;
    printHuman(analysis, logPath, Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_TOP);
  }

  if (!analysis.fit.usable) process.exitCode = 1;
}
