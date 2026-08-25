import { execFile, spawn } from 'child_process';
import util from 'util';
import path from 'path';
import { access, writeFile, readFile, unlink, appendFile, readdir, rm, stat } from 'fs/promises';
import { openSync as openSyncFs, closeSync as closeSyncFs } from 'fs';
import os from 'os';
import crypto from 'crypto';
import { getConfigManager } from '../../utils/configManager.js';
import { describePackagesRootScan, findPackagesRoot } from '../../utils/packagesRoot.js';
import { findFrameworkTool } from '../../utils/frameworkBin.js';
import { forceReleaseLock } from '../../utils/operationLocks.js';
import { lookupErrorFix } from '../knowledge/d365foErrorHelp.js';
import { generateRuntimeMetadata } from '../xml/generateMetadata.js';
import { compileModelLabels, type CompileLabelsResult } from '../write/compileLabels.js';
import { readModuleReferences } from '../../metadata/modelDescriptor.js';
import { recordBuild } from '../../utils/buildMarker.js';
import type { ProgressReporter } from '../../utils/progressReporter.js';

const execFileAsync = util.promisify(execFile);

// Build-tool file logger
async function buildLog(level: 'INFO' | 'WARN' | 'ERROR', message: string): Promise<void> {
  console.error(`[build_d365fo_project] ${message}`);
  try {
    const configManager = getConfigManager();
    const logFile = configManager.getContext()?.bridgeLogFile;
    if (!logFile) return;
    const line = `[${new Date().toISOString()}] [BuildTool] [${level}] ${message}\n`;
    await appendFile(logFile, line, 'utf-8');
  } catch {
    // Best-effort — never throw from logging
  }
}

function assertSafePath(value: string, label: string): void {
  if (/[&|<>^`!;$%"'\n\r]/.test(value)) {
    throw new Error(
      `${label} contains potentially dangerous characters and cannot be used in a build command: ${value}`
    );
  }
}

// xppc.exe writes this prefix on error lines in the -log file (standalone/non-VS mode)
const XPPC_COMPILE_ERROR_RE = /^Compile Error:/m;

// When xppc reports stale symbols from a previous incremental build, a full build is needed
const XPPC_STALE_SYMBOL_RE = /has not been successfully compiled since it was last changed|Do a Full Build/i;

// xppc -log line format:
//   Compile Error: Class Method dynamics://MyModel/MyClass/myMethod: [(28,27),(28,28)]: ';' expected.
// i.e.  <severity>: <element kind> dynamics://<model>/<object>[/<member>]: [(line,col)[,(line,col)]]: <message>

export interface XppcDiagnostic {
  severity: 'error' | 'warning';
  /** Element kind as reported by xppc, e.g. "Class Method", "Table Field" */
  kind?: string;
  model?: string;
  object?: string;
  member?: string;
  line?: number;
  column?: number;
  message: string;
}

/**
 * The severity prefix every xppc diagnostic line opens with, as a family rather
 * than a list of literals: xppc also emits `Metadata` and
 * `FormPatternValidation` errors, which a five-literal list reported as zero —
 * a FAILED build with no stated cause.
 */
const DIAG_PREFIX = String.raw`(?:([A-Za-z][A-Za-z ]{0,30}?)\s)?(Fatal Error|Error|Warning)`;

/** Prefix-only test, for deciding which log lines are worth keeping in an excerpt. */
export const DIAG_LINE_TEST = new RegExp(String.raw`^${DIAG_PREFIX}:\s`);

/** `<Kind> <Severity>: [<elementKind> ]dynamics://Model/Object[/Member]: [(l,c)…]: message` */
const XPPC_DIAG_DYNAMICS_RE = new RegExp(
  String.raw`^${DIAG_PREFIX}:\s*(?:(.*?)\s+)?dynamics:\/\/([^/\s:]+)\/([^/\s:]+)(?:\/([^\s:]+))?\s*:?\s*\[\((\d+),(\d+)\)(?:,\(\d+,\d+\))?\]\s*:\s*(.*)$`,
);

/** `<Kind> <Severity>: AxFormExtension/Name/Design/Controls/…: message` — no line/col. */
const XPPC_DIAG_PATH_RE = new RegExp(
  String.raw`^${DIAG_PREFIX}:\s*(Ax[A-Za-z]+)\/([^\s:]+)\s*:\s*(.*)$`,
);

/** `<Kind> <Severity>: message` */
const XPPC_DIAG_PLAIN_RE = new RegExp(String.raw`^${DIAG_PREFIX}:\s*(.+)$`);

/** xppc's own tally at the end of the log, to catch a parser shortfall. */
const XPPC_ERROR_TOTAL_RE = /^Errors:\s*(\d+)\s*$/m;

/** Errors xppc counted in this log, or null when it printed no tally. */
export function xppcReportedErrorCount(logContent: string): number | null {
  const m = XPPC_ERROR_TOTAL_RE.exec(logContent);
  return m ? Number(m[1]) : null;
}

/** Parse xppc log content into structured diagnostics. */
export function parseXppcDiagnostics(logContent: string): XppcDiagnostic[] {
  const diagnostics: XppcDiagnostic[] = [];
  for (const rawLine of logContent.split(/\r?\n/)) {
    const line = rawLine.trim();

    const dyn = XPPC_DIAG_DYNAMICS_RE.exec(line);
    if (dyn) {
      diagnostics.push({
        severity: dyn[2].includes('Error') ? 'error' : 'warning',
        kind: dyn[3] || dyn[1] || undefined,
        model: dyn[4],
        object: dyn[5],
        member: dyn[6] || undefined,
        line: Number(dyn[7]),
        column: Number(dyn[8]),
        message: dyn[9].trim(),
      });
      continue;
    }

    const pathForm = XPPC_DIAG_PATH_RE.exec(line);
    if (pathForm) {
      // "AxFormExtension/MyForm.Ext/Design/Controls/Grid/Foo" — the element is the
      // first segment, the rest locates the member inside it.
      const [objectName, ...rest] = pathForm[4].split('/');
      diagnostics.push({
        severity: pathForm[2].includes('Error') ? 'error' : 'warning',
        kind: pathForm[1] || undefined,
        model: pathForm[3],
        object: objectName,
        member: rest.length > 0 ? rest.join('/') : undefined,
        message: pathForm[5].trim(),
      });
      continue;
    }

    const plain = XPPC_DIAG_PLAIN_RE.exec(line);
    if (plain) {
      diagnostics.push({
        severity: plain[2].includes('Error') ? 'error' : 'warning',
        kind: plain[1] || undefined,
        message: plain[3].trim(),
      });
    }
  }
  return diagnostics;
}

/**
 * What to say when the compiler failed and this parser cannot show why.
 *
 * A FAILED headline over a list of warnings reads as though the warnings are
 * the cause, and invites deleting whatever is nearest to clear the red. Name
 * the gap instead. Returns '' when the parsed errors do explain the failure.
 */
export function renderUnexplainedFailure(
  parsed: XppcDiagnostic[],
  logContent: string,
): string {
  const parsedErrors = parsed.filter(d => d.severity === 'error').length;
  const reported = xppcReportedErrorCount(logContent);

  if (parsedErrors > 0 && (reported === null || parsedErrors >= reported)) return '';

  const lines: string[] = [];
  if (parsedErrors === 0) {
    lines.push(
      `⚠️ The build FAILED but this server parsed **no error diagnostic** from the log` +
      (reported !== null ? ` (xppc's own tally says: Errors: ${reported})` : '') + '.',
    );
    lines.push(
      `Any warnings listed below are NOT the failure — do not treat them as the cause. ` +
      `Read the raw log at the end of this response; the failing line is in there in a ` +
      `format this parser did not recognise.`,
    );
  } else {
    lines.push(
      `⚠️ xppc counted ${reported} error(s) but only ${parsedErrors} could be parsed into the list below. ` +
      `The rest are in the raw log.`,
    );
  }
  lines.push(
    `⛔ Do NOT delete, undo or unregister an object to make the build pass. A green build ` +
    `you obtained by removing the thing you were asked to create is a failed task, not a fixed one. ` +
    `If you cannot find the cause, say so and ask.`,
  );
  return lines.join('\n');
}

/**
 * Render diagnostics as a numbered, machine-actionable block. Errors come
 * first; duplicate messages are collapsed; the first few distinct errors are
 * enriched with a fix hint from the get_d365fo_error_help knowledge base so
 * the model can correct everything in one round.
 */
export function formatStructuredDiagnostics(diagnostics: XppcDiagnostic[], maxItems = 25): string {
  if (diagnostics.length === 0) return '';
  const errors = diagnostics.filter(d => d.severity === 'error');
  const warnings = diagnostics.filter(d => d.severity === 'warning');
  const ordered = [...errors, ...warnings];

  const seen = new Set<string>();
  const lines: string[] = [
    `📋 Structured diagnostics: ${errors.length} error(s), ${warnings.length} warning(s)`,
    '',
  ];
  let shown = 0;
  let enriched = 0;
  for (const d of ordered) {
    const key = `${d.object ?? ''}|${d.member ?? ''}|${d.line ?? ''}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (shown >= maxItems) {
      lines.push(`… and ${ordered.length - shown} more (see raw log below).`);
      break;
    }
    shown++;
    const location = d.object
      ? `${d.object}${d.member ? `.${d.member}` : ''}${d.line ? ` (line ${d.line}, col ${d.column})` : ''}`
      : '(no location)';
    lines.push(`${shown}. ${d.severity === 'error' ? '🔴' : '🟡'} ${location}: ${d.message}`);
    // Enrich the first few distinct errors with a known fix
    if (d.severity === 'error' && enriched < 3) {
      const help = lookupErrorFix(d.message);
      if (help) {
        enriched++;
        lines.push(`   💡 ${help.title}: ${help.fix[0]}`);
      }
    }
  }
  if (errors.length > 0) {
    lines.push('');
    lines.push('Fix the errors with d365fo_file(action="modify") (use the object/line references above), then rebuild.');
  }
  return lines.join('\n');
}

interface QueueResult {
  modelName: string;
  status: 'succeeded' | 'failed';
  duration: number;
  logFile: string;
}

interface BuildJobState {
  pid: number;
  modelName: string;       // Currently building model
  targetModel: string;     // Final target model — state file is keyed by this
  tool: string;
  startTime: string;
  logFile: string;         // Log for the CURRENT model in the queue
  status: 'running' | 'succeeded' | 'failed';
  // What a 'running' state is actually doing. 'finalizing' means xppc has
  // already exited and the in-process close handler is doing post-build work
  // (runtime metadata regeneration, up to ~90 s) before it can write the final
  // result. Without this a waiter sees a dead PID, concludes the build was
  // orphaned and returns a "still running" stub for a build that in fact
  // succeeded seconds ago — the 185 s double-call of #829.
  phase?: 'compiling' | 'finalizing';
  exitCode?: number;
  endTime?: string;
  fullBuild?: boolean;
  // Multi-model queue (only set when buildReferencedModels: true)
  buildQueue?: string[];        // All models in topological order (deps first, target last)
  queueIndex?: number;          // Index into buildQueue for the currently-building model
  queueResults?: QueueResult[]; // Results for already-completed models in the queue
}

// State file is keyed by targetModel so it remains findable throughout a
// multi-model build even while a dependency is building. Each model in the
// queue gets its own log file (keyed by targetModel + index).

function stateFilePath(targetModel: string, customPackagesPath: string): string {
  const hash = crypto
    .createHash('md5')
    .update(`${targetModel.toLowerCase()}|${customPackagesPath.toLowerCase()}`)
    .digest('hex')
    .slice(0, 10);
  return path.join(os.tmpdir(), `d365build_state_${hash}.json`);
}

function logFilePath(targetModel: string, queueIndex: number, customPackagesPath: string): string {
  const hash = crypto
    .createHash('md5')
    .update(`log:${targetModel.toLowerCase()}|${queueIndex}|${customPackagesPath.toLowerCase()}`)
    .digest('hex')
    .slice(0, 10);
  return path.join(os.tmpdir(), `d365build_log_${hash}.log`);
}

/**
 * Written BY the build, so always newer than it — scanning them would make
 * every cached result look stale and rebuild forever.
 */
const BUILD_OUTPUT_DIRS = new Set(['bin', 'xppmetadata']);

/**
 * True when any source file in the model package changed after `since` (epoch
 * ms). Short-circuits on the first hit, so the "something changed" case — the
 * one that must not be missed — is also the fast one.
 *
 * On a blown time budget or an unreadable tree it returns TRUE. Both failure
 * directions are not equal: a needless rebuild costs minutes, while a wrongly
 * reused result reports a compile that never happened.
 */
export async function hasSourceChangesSince(
  modelDir: string,
  since: number,
  budgetMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  const stack: string[] = [modelDir];
  while (stack.length > 0) {
    if (Date.now() > deadline) return true;
    const dir = stack.pop()!;
    let entries;
    try {
      // The directory's OWN mtime is what catches a DELETION: removing a class
      // leaves no file to stat, but the parent's mtime moves. Without this a
      // deleted source reads as "unchanged" and the stale result comes back.
      if ((await stat(dir)).mtimeMs > since) return true;
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable subtree: can't prove it is unchanged.
      return true;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dir === modelDir && BUILD_OUTPUT_DIRS.has(entry.name.toLowerCase())) continue;
        stack.push(full);
        continue;
      }
      try {
        if ((await stat(full)).mtimeMs > since) return true;
      } catch { /* vanished mid-scan — ignore */ }
    }
  }
  return false;
}

/**
 * Whether a finished build result still describes what is on disk.
 *
 * A finished state left on disk used to be returned verbatim to the NEXT
 * call, which then read as that call's own result. Observed 2026-07-28 while
 * capturing the L2-coc-inherited-method golden: a wrapper was edited to a
 * deliberately uncompilable signature, and the following build reported
 * "✅ Build succeeded / Errors: 0" with byte-identical phase timings from the
 * previous run. The poisoned file was written at 15:05:46; the build log had
 * last been touched at 15:05:04 — 42 s EARLIER. Nothing had been compiled.
 *
 * That is the worst failure this tool can have: pass@build is the gate the
 * whole eval loop leans on, and a green that describes a tree nobody compiled
 * is indistinguishable from a real one without checking log timestamps by hand.
 */
export async function finishedResultStillDescribesDisk(
  state: BuildJobState,
  targetModel: string,
  customPackagesPath: string,
): Promise<boolean> {
  if (!state.endTime) return false; // no idea when it finished — do not trust it
  const endedAt = new Date(state.endTime).getTime();
  if (!Number.isFinite(endedAt)) return false;
  return !(await hasSourceChangesSince(path.join(customPackagesPath, targetModel), endedAt));
}

async function readBuildState(targetModel: string, customPackagesPath: string): Promise<BuildJobState | null> {
  try {
    const raw = await readFile(stateFilePath(targetModel, customPackagesPath), 'utf-8');
    return JSON.parse(raw) as BuildJobState;
  } catch {
    return null;
  }
}

async function writeBuildState(state: BuildJobState, customPackagesPath: string): Promise<void> {
  await writeFile(stateFilePath(state.targetModel, customPackagesPath), JSON.stringify(state, null, 2), 'utf-8');
}

async function clearBuildState(targetModel: string, customPackagesPath: string): Promise<void> {
  await unlink(stateFilePath(targetModel, customPackagesPath)).catch(() => {});
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Last N lines of a log file (used while a build is running). */
async function readLogTail(logFile: string, lines = 60): Promise<string> {
  try {
    const content = await readFile(logFile, 'utf-8');
    const all = content.split(/\r?\n/);
    return all.slice(-lines).join('\n').trim();
  } catch {
    return '(log not yet available)';
  }
}

/**
 * Log excerpt for a SUCCEEDED build.
 *
 * A green build returned the raw 60-line tail, which is almost entirely xppc's
 * phase-timing table — measured at ~2.6 KB of a ~3.1 KB response — and nothing
 * downstream reads a timing row. Keep the lines a green build can still say
 * something with: the diagnostic (warning) lines, and the trailing summary counts.
 *
 * The input is deliberately the same 60-line tail the raw version returned, so
 * the warnings verdict computed from that tail is unchanged by this trim; a
 * warning that never reached the tail was already invisible before.
 */
export function trimSucceededLog(logTail: string, keepTail = 12): string {
  const all = logTail.split(/\r?\n/);
  // Nothing to win on a log that is already short.
  if (all.length <= keepTail + 8) return logTail;

  const summaryFrom = all.length - keepTail;
  const diagnostics: string[] = [];
  let omitted = 0;
  for (let i = 0; i < summaryFrom; i++) {
    if (isWorthKeeping(all[i])) diagnostics.push(all[i]);
    else omitted++;
  }
  if (omitted === 0) return logTail;

  return (
    `[${omitted} phase-timing line(s) omitted — build succeeded]\n` +
    [...diagnostics, ...all.slice(summaryFrom)].join('\n').trim()
  );
}

/**
 * Which lines of a GREEN build's tail survive the trim.
 *
 * DIAG_LINE_TEST is anchored and case-sensitive — it wants `[Kind ]Error: ` or
 * `[Kind ]Warning: ` at the start of the line, which is exactly xppc's shape and
 * nothing else. Verified: it keeps `Metadata Warning:`, `Compile Error:`,
 * `BEST PRACTICE Warning:` and a bare `Warning:`, and drops a lowercase
 * `warning:` and the MSBuild shape `MyTable.xpp(12,3): warning CS1234:`.
 *
 * On the FAILURE path that is harmless — non-matching lines still arrive through
 * the head/tail fallback. On this path they are dropped outright, so a warning in
 * a shape xppc does not normally emit would vanish from a green build entirely;
 * hasWarnings uses the same test, so it would not even set the ⚠️ icon.
 *
 * The costs are not symmetric: a handful of extra lines is nothing, a silently
 * dropped warning is the thing this function must not do. So anything that
 * MENTIONS an error or a warning is kept too, whatever its shape.
 */
function isWorthKeeping(line: string): boolean {
  return DIAG_LINE_TEST.test(line.trim()) || /\b(error|warning)s?\b/i.test(line);
}

/**
 * The log section of a FAILED build's response.
 *
 * `build_d365fo_project` is deliberately 'uncapped' in the response capper, and
 * a failure used to return BOTH the structured diagnostics (up to 25) AND up to
 * 300 lines of raw log — measured at the host's logging cap on all 43 build
 * calls in a 1,400-call sample, 13 of them failures. Every byte of that lands in
 * the context and is re-billed on every later request in the session.
 *
 * So the raw log is included in full only in the case it is actually evidence
 * for: the parser produced NO structured diagnostic, so the raw text is the only
 * statement of why the build failed (this is the case renderUnexplainedFailure
 * points at — "read the raw log at the end of this response"). When diagnostics
 * WERE parsed they already carry object, member, line, column and message, and
 * the raw log restates them inside a phase table; a short tail is enough to see
 * the summary counts, and the path is enough to read the rest on demand.
 */
export async function renderFailureLog(
  logFile: string,
  hasStructuredDiagnostics: boolean,
): Promise<string> {
  if (!hasStructuredDiagnostics) return await readFullLog(logFile);
  const tail = await readLogTail(logFile, FAILURE_TAIL_LINES);
  return `[last ${FAILURE_TAIL_LINES} lines — the diagnostics above are parsed from the same log; ` +
    `full log: ${logFile}]\n${tail}`;
}

/** How much of a failed build's log is worth carrying once the diagnostics are parsed. */
const FAILURE_TAIL_LINES = 40;

/** Read the entire log without truncation — used for diagnostics parsing only. */
async function readWholeLog(logFile: string): Promise<string> {
  try {
    return await readFile(logFile, 'utf-8');
  } catch {
    return '';
  }
}

/** First and last line of the verbatim xppc invocation written at the top of every build log. */
const INVOCATION_HEADER_START = '=== xppc invocation ===';
const INVOCATION_HEADER_END   = '=======================';

/**
 * Line indices of that invocation header, or [] if the log does not start with one.
 *
 * The header exists so a failed build can be traced back to the arguments that produced it —
 * which root `-compilermetadata` pointed at, above all. A failed build is also the only time
 * readFullLog takes its diagnostic-window path, and that path returns windows plus a tail, so
 * without this the header reached the response only for logs short enough to be returned whole.
 */
function invocationHeaderRange(all: string[]): number[] {
  if (all[0]?.trim() !== INVOCATION_HEADER_START) return [];
  const end = all.findIndex((line, i) => i > 0 && line.trim() === INVOCATION_HEADER_END);
  if (end === -1) return [];
  // Bounded: a long extraReferenceFolders list must not crowd out the diagnostics.
  const last = Math.min(end, 60);
  return Array.from({ length: last + 1 }, (_, i) => i);
}

/**
 * Log excerpt for a failed build that always includes diagnostic lines. A
 * naive head+tail can miss errors when long phase-timing tables precede them,
 * so instead: find every diagnostic line, include a context window around
 * each, always include the invocation header and the trailing summary lines,
 * and cap the number of diagnostic windows shown (MAX_DIAGS) to bound the
 * response size.
 */
export async function readFullLog(logFile: string, maxLines = 300): Promise<string> {
  const CONTEXT = 3;     // lines before/after each diagnostic
  const TAIL_LINES = 30; // always-included trailing lines
  const MAX_DIAGS = 30;  // cap on diagnostic windows to bound response size

  try {
    const content = await readFile(logFile, 'utf-8');
    const all = content.split(/\r?\n/);
    if (all.length <= maxLines) return content.trim();

    const diagIndices: number[] = [];
    for (let i = 0; i < all.length; i++) {
      if (DIAG_LINE_TEST.test(all[i].trim())) diagIndices.push(i);
    }

    if (diagIndices.length > 0) {
      const totalDiags = diagIndices.length;
      const shownDiags = diagIndices.slice(0, MAX_DIAGS);

      const included = new Set<number>();
      for (const i of invocationHeaderRange(all)) included.add(i);
      for (const idx of shownDiags) {
        for (let i = Math.max(0, idx - CONTEXT); i <= Math.min(all.length - 1, idx + CONTEXT); i++) {
          included.add(i);
        }
      }
      for (let i = Math.max(0, all.length - TAIL_LINES); i < all.length; i++) {
        included.add(i);
      }

      const sorted = [...included].sort((a, b) => a - b);
      const header = totalDiags > shownDiags.length
        ? `[Phase table omitted — first ${shownDiags.length} of ${totalDiags} diagnostic line(s) with context shown below]\n`
        : `[Phase table omitted — ${totalDiags} diagnostic line(s) with context shown below]\n`;
      const out: string[] = [header];
      let prev = -1;
      for (const i of sorted) {
        if (prev !== -1 && i > prev + 1) {
          out.push(`... (${i - prev - 1} lines omitted) ...`);
        }
        out.push(all[i]);
        prev = i;
      }
      return out.join('\n').trim();
    }

    // No diagnostic lines found — fall back to head+tail.
    const half = Math.floor(maxLines / 2);
    return (
      `[First ${half} lines]\n` +
      all.slice(0, half).join('\n') +
      `\n\n... (${all.length - maxLines} lines omitted) ...\n\n` +
      `[Last ${half} lines]\n` +
      all.slice(-half).join('\n').trim()
    );
  } catch {
    return '(log not available)';
  }
}

async function getModelFromRnrproj(projectPath: string): Promise<string | null> {
  try {
    const content = await readFile(projectPath, 'utf-8');
    const match = content.match(/<Model>\s*([^<]+)\s*<\/Model>/i);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

async function findXppcExe(microsoftPackagesPath: string | null): Promise<string | null> {
  return findFrameworkTool(microsoftPackagesPath, 'xppc.exe');
}

/**
 * Reads <ModuleReferences> from the target model's descriptor, recursively
 * follows custom/ISV dependencies (models present in customPackagesPath), and
 * returns a topologically sorted build order (deepest dep first, target
 * last). Microsoft standard models (only in microsoftPackagesPath) are
 * silently skipped.
 */
async function resolveBuildQueue(
  targetModel: string,
  customPackagesPath: string,
  _microsoftPackagesPath: string,
): Promise<string[]> {
  const visited = new Set<string>();
  const order: string[] = [];

  async function visit(modelName: string): Promise<void> {
    if (visited.has(modelName.toLowerCase())) return;
    visited.add(modelName.toLowerCase());

    // Shared reader: resolve_references reads the same element to decide type
    // visibility, and one parser keeps the two from drifting apart.
    const refs = await readModuleReferences(customPackagesPath, modelName);
    if (refs === null) {
      // No descriptor — still include this model but can't follow its deps
      order.push(modelName);
      return;
    }

    // Visit custom/ISV dependencies first (skip Microsoft standard models)
    for (const ref of refs) {
      if (visited.has(ref.toLowerCase())) continue;
      try {
        await access(path.join(customPackagesPath, ref));
        await visit(ref); // Recurse into custom dep
      } catch {
        // Not found in customPackagesPath → Microsoft standard → skip
      }
    }

    order.push(modelName); // Post-order DFS = topological sort
  }

  await visit(targetModel);
  return order; // Dependencies first, targetModel last
}

async function killOrphanedBuildProcesses(): Promise<void> {
  await execFileAsync('taskkill', ['/F', '/IM', 'xppc.exe'], { timeout: 10_000, windowsHide: true })
    .then(({ stdout }) => console.error(`[build_d365fo_project] killed xppc.exe: ${stdout.trim() || '(no output)'}`))
    .catch(() => {});
}

/**
 * The label-compilation outcome as it should appear at the top of the build
 * log. A clean run is silent — nothing was wrong, and a note per build would
 * only crowd out the compiler output. A FAILED run is loud and says what it
 * costs, because the symptom it produces (`BPErrorUnknownLabel` on a label
 * that plainly exists, plus the `BPUnusedStrFmtArgument` warnings that cascade
 * from it) otherwise reads as broken source code.
 */
export function describeLabelCompilation(modelName: string, result: CompileLabelsResult): string {
  if (result.success) {
    return result.skipped ? '' : `✅ Labels compiled for ${modelName} — ${result.message}\n\n`;
  }
  return [
    `⚠️ Label compilation FAILED for ${modelName} — ${result.message}`,
    `   Labels stay uncompiled, so references to them can be reported as`,
    `   BPErrorUnknownLabel (with BPUnusedStrFmtArgument cascading from them)`,
    `   even though the source is correct. Fix labelc before trusting those.`,
    '',
    '',
  ].join('\n');
}

/** Passed through the entire queue so the close handler can launch the next model without re-resolving paths. */
interface XppcBuildContext {
  xppcExe: string;
  customPackagesPath: string;
  microsoftPackagesPath: string;
  /**
   * The `-compilermetadata` root — where xppc READS the compiler metadata of
   * referenced modules and, in its "Metadata Write-Back" phase, WRITES its own
   * back. The write-back half is easy to miss, and it is why this is not simply
   * `microsoftPackagesPath`: pointing it at the framework directory made every
   * build deposit `<FrameworkDirectory>\<CustomModel>\XppMetadata`, leaving
   * customer model names in a directory shared by every environment on the box.
   *
   * Pointing it at the model store instead is what VS does. Microsoft's own
   * compiler metadata still resolves, because the framework directory is passed
   * as a `-referenceFolder` (verified against 10.0.2645.90: a full compile of a
   * customer model succeeded with `Errors: 0` and no unresolved-metadata
   * diagnostic, and the write-back landed in the model store rather than the
   * framework directory).
   *
   * It also removes an asymmetry that could only hurt `-incremental`, which is
   * the DEFAULT here: VS wrote its baseline to the model store and nothing
   * copied it back, so an MCP build following a VS build compared against
   * metadata predating it. Both tools now share one baseline.
   */
  compilerMetadataPath: string;
  extraReferenceFolders: string[];
}

/** Windows path comparison: case-insensitive, trailing separator and `.`/`..` normalised away. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Delete the compiler-metadata stub an earlier build left in the framework directory.
 *
 * While `-compilermetadata` pointed at the framework directory, every build of a customer
 * model deposited `<FrameworkDirectory>\<Model>\XppMetadata` there. Now that the write-back
 * goes to the model store, those trees are never refreshed again — and the framework
 * directory is still passed as a `-referenceFolder`, so xppc keeps finding a `<Model>` folder
 * that looks like a package and holds metadata frozen at the last build before the switch.
 * That is how "has not been successfully compiled since it was last changed" gets reported
 * for source that was just compiled cleanly. Anything else enumerating the framework
 * directory keeps seeing phantom customer models for the same reason.
 *
 * Deliberately narrow, because the framework directory is shared by every environment on the
 * box: only when the two roots actually differ (UDE), only for a model that really lives in
 * the model store, and only when the folder holds nothing but XppMetadata — i.e. it is a
 * write-back stub and not a package deployed there on purpose. Anything unexpected is left
 * alone and reported; a build is never failed over it.
 */
async function removeStaleFrameworkCompilerMetadata(
  ctx: XppcBuildContext,
  modelName: string,
): Promise<void> {
  const { microsoftPackagesPath, customPackagesPath, compilerMetadataPath } = ctx;

  // CHE: one root, so the stub IS the live metadata.
  if (samePath(microsoftPackagesPath, compilerMetadataPath)) return;
  if (samePath(microsoftPackagesPath, customPackagesPath)) return;

  const stubDir = path.join(microsoftPackagesPath, modelName);
  try {
    // Only a model whose authoritative copy is in the model store — never one that is
    // genuinely installed in the framework directory and merely also named here.
    await access(path.join(customPackagesPath, modelName));
    const entries = await readdir(stubDir);
    if (entries.length === 0) return;
    if (entries.some(e => e.toLowerCase() !== 'xppmetadata')) {
      await buildLog(
        'INFO',
        `Left ${stubDir} alone — it holds more than XppMetadata (${entries.join(', ')}), so it is not a stale write-back stub`,
      );
      return;
    }
    await rm(stubDir, { recursive: true, force: true });
    await buildLog('INFO', `Removed stale compiler-metadata stub left by an earlier build: ${stubDir}`);
  } catch (err: any) {
    // ENOENT on either probe is the normal case: no stub, or the model is not in the
    // model store. Anything else (a lock, a permission) is worth saying out loud once.
    if (err?.code !== 'ENOENT') {
      await buildLog('WARN', `Could not clean up ${stubDir}: ${err?.message ?? err}`);
    }
  }
}

/**
 * Spawns xppc.exe for state.modelName, writes the updated state (with real
 * PID) to disk, and wires up close/error handlers. The close handler
 * automatically advances the queue when a dependency finishes successfully.
 * Returns the PID of the spawned process.
 */
async function spawnXppcForState(ctx: XppcBuildContext, state: BuildJobState): Promise<number> {
  const { xppcExe, customPackagesPath, microsoftPackagesPath, compilerMetadataPath, extraReferenceFolders } = ctx;
  const { modelName, fullBuild, targetModel } = state;

  // fullBuild only applies to the TARGET model — dependencies always run
  // incremental. They are already compiled; a full rebuild of every dep in
  // the chain would be very slow and is only needed when a dep itself has
  // stale symbols, which the user can fix by building that model directly.
  const useFullBuild = fullBuild && modelName === targetModel;

  assertSafePath(xppcExe, 'xppc.exe path');
  assertSafePath(modelName, 'Model name');
  assertSafePath(customPackagesPath, 'Custom packages path');
  assertSafePath(microsoftPackagesPath, 'Microsoft packages path');
  assertSafePath(compilerMetadataPath, 'Compiler metadata path');

  await removeStaleFrameworkCompilerMetadata(ctx, modelName);

  const outputPath = path.join(customPackagesPath, modelName, 'bin');
  const xppcErrLog = state.logFile.replace('.log', '.xppc.err');

  await unlink(xppcErrLog).catch(() => {});

  // Deduplicate reference folders
  const seenRefFolders = new Set<string>();
  const referenceFolderArgs: string[] = [];
  for (const folder of [microsoftPackagesPath, customPackagesPath, ...extraReferenceFolders]) {
    const norm = folder.toLowerCase();
    if (!seenRefFolders.has(norm)) {
      seenRefFolders.add(norm);
      referenceFolderArgs.push(`-referenceFolder=${folder}`);
    }
  }

  const xppcArgs = [
    `-metadata=${customPackagesPath}`,
    // Not microsoftPackagesPath — see XppcBuildContext.compilerMetadataPath.
    `-compilermetadata=${compilerMetadataPath}`,
    `-modelmodule=${modelName}`,
    ...referenceFolderArgs,
    `-output=${outputPath}`,
    // Full build = omit -incremental (xppc recompiles all elements).
    // Only applied to the target model — deps always run incremental.
    ...(useFullBuild ? [] : ['-incremental']),
    `-log=${xppcErrLog}`,
    // -verbose surfaces metadata loading errors (XML failures, missing refs)
    // that are otherwise silently swallowed in non-VS standalone mode.
    '-verbose',
  ];

  await buildLog('INFO', `xppc.exe args: ${xppcArgs.join(' ')}`);

  // Labels first — see compileLabels.ts. xppc and xppbp resolve @Model:Id
  // against the compiled resource assembly, so compiling labels afterwards
  // would leave THIS build reporting unknown-label errors for labels that are
  // perfectly well defined, and only clear them on the next one.
  const labelResult = await compileModelLabels(microsoftPackagesPath, customPackagesPath, modelName, !!useFullBuild);
  const labelHeader = describeLabelCompilation(modelName, labelResult);
  if (labelResult.skipped && labelResult.success) {
    await buildLog('INFO', `labelc skipped for ${modelName}: ${labelResult.message}`);
  } else if (labelResult.success) {
    await buildLog('INFO', `labelc compiled ${modelName} labels: ${labelResult.message}`);
  } else {
    await buildLog('WARN', `labelc did not compile ${modelName} labels: ${labelResult.message}`);
  }

  // The invocation, verbatim, at the top of the log. buildLog() already reports
  // it, but only to stderr and to bridgeLogFile — and bridgeLogFile only exists
  // when D365FO_BRIDGE_LOG_FILE is configured. Neither is the file anyone opens
  // when auditing a build afterwards, so a question as basic as "which root did
  // -compilermetadata point at" could not be answered from the build log at all.
  // Recording it here makes a regression in these arguments directly greppable.
  // The markers are shared with invocationHeaderRange(), which keeps these lines in the
  // excerpt readFullLog returns for a failed build — the case the header is written for.
  const invocationHeader = [
    INVOCATION_HEADER_START,
    xppcExe,
    ...xppcArgs.map(arg => `  ${arg}`),
    INVOCATION_HEADER_END,
    '',
    '',
  ].join('\n');

  // Truncate the log with the invocation and label outcome, then append xppc's
  // output to it, so a single tail read shows the whole build in the order it
  // happened.
  await writeFile(state.logFile, invocationHeader + labelHeader, 'utf-8');
  const logFd = openSyncFs(state.logFile, 'a');

  const child = spawn(xppcExe, xppcArgs, {
    detached: false,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();

  const pid = child.pid!;

  // Write state with actual PID immediately so polls see it
  const liveState: BuildJobState = { ...state, pid };
  await writeBuildState(liveState, customPackagesPath);

  await buildLog('INFO', `xppc.exe launched — PID: ${pid} | model: ${modelName} | log: ${state.logFile}`);

  child.on('error', async (err) => {
    closeSyncFs(logFd);
    const failed: BuildJobState = { ...liveState, status: 'failed', exitCode: -1, endTime: new Date().toISOString() };
    await writeBuildState(failed, customPackagesPath).catch(() => {});
    await buildLog('ERROR', `xppc.exe spawn error — PID: ${pid}: ${err.message}`);
  });

  child.on('close', async (code) => {
    closeSyncFs(logFd);
    const exitCode = code ?? -1;

    // Publish "xppc is gone, I am finishing up" BEFORE the post-build work, so
    // a waiter can tell this apart from an orphaned process and keeps waiting
    // instead of returning a stub for an already-finished build.
    await writeBuildState({ ...liveState, phase: 'finalizing' }, customPackagesPath).catch(() => {});

    // Read the -log file (authoritative source of X++ compiler errors)
    let xppcErrContent = '';
    try {
      xppcErrContent = await readFile(xppcErrLog, 'utf-8');
    } catch { /* no -log file = no diagnostics */ }

    const hasCompileErrors = XPPC_COMPILE_ERROR_RE.test(xppcErrContent);
    const hasStaleSymbol   = XPPC_STALE_SYMBOL_RE.test(xppcErrContent);
    // xppc can exit 0 while still emitting Compile Error lines, so success
    // requires both exit 0 AND no Compile Error lines in the -log.
    const succeeded = exitCode === 0 && !hasCompileErrors;

    // Append compiler diagnostics to the main log so a single tail read finds everything
    if (xppcErrContent.trim()) {
      let diagnostics = '\n--- xppc compiler diagnostics ---\n' + xppcErrContent + '\n';
      if (hasStaleSymbol) {
        diagnostics +=
          '\n💡 STALE SYMBOL DETECTED: Call build_d365fo_project with fullBuild: true\n' +
          '   to recompile all symbols from scratch.\n';
      }
      await appendFile(state.logFile, diagnostics, 'utf-8').catch(() => {});
    } else if (!succeeded) {
      // No diagnostics at all — the failure happened before the compiler ran
      await appendFile(
        state.logFile,
        '\n⚠️  No compiler diagnostics from xppc — build failed before compilation started.\n' +
        '   Possible causes: missing metadata path, missing referenced model, or a\n' +
        '   malformed XML file that slipped past pre-validation (e.g. in the Descriptor).\n',
        'utf-8',
      ).catch(() => {});
    }

    const duration = Math.round((Date.now() - new Date(liveState.startTime).getTime()) / 1000);
    const newResult: QueueResult = {
      modelName,
      status: succeeded ? 'succeeded' : 'failed',
      duration,
      logFile: state.logFile,
    };
    const allResults: QueueResult[] = [...(liveState.queueResults ?? []), newResult];

    if (!succeeded) {
      // Failure — stop the queue and finalise
      const final: BuildJobState = {
        ...liveState,
        status: 'failed',
        exitCode,
        endTime: new Date().toISOString(),
        queueResults: allResults,
      };
      await writeBuildState(final, customPackagesPath).catch(() => {});
      await buildLog('ERROR', `xppc.exe FAILED — PID: ${pid} | model: ${modelName} | exit: ${exitCode} | compileErrors: ${hasCompileErrors}`);
      return;
    }

    // Success — advance queue if there are more models
    if (
      liveState.buildQueue &&
      liveState.queueIndex !== undefined &&
      liveState.queueIndex + 1 < liveState.buildQueue.length
    ) {
      const nextIdx   = liveState.queueIndex + 1;
      const nextModel = liveState.buildQueue[nextIdx];
      const nextLog   = logFilePath(liveState.targetModel, nextIdx, customPackagesPath);

      const nextState: BuildJobState = {
        ...liveState,
        pid: 0,           // will be updated by the recursive spawnXppcForState call
        modelName: nextModel,
        queueIndex: nextIdx,
        queueResults: allResults,
        logFile: nextLog,
        status: 'running',
        startTime: new Date().toISOString(),
        exitCode: undefined,
        endTime: undefined,
      };
      await writeBuildState(nextState, customPackagesPath);
      await buildLog('INFO', `Queue advancing: ${nextIdx + 1}/${liveState.buildQueue.length} — ${nextModel}`);

      spawnXppcForState(ctx, nextState).catch(async (err) => {
        await buildLog('ERROR', `Failed to spawn next model ${nextModel}: ${err.message}`);
        const errState: BuildJobState = {
          ...nextState,
          status: 'failed',
          exitCode: -1,
          endTime: new Date().toISOString(),
          queueResults: [...allResults, { modelName: nextModel, status: 'failed', duration: 0, logFile: nextLog }],
        };
        await writeBuildState(errState, customPackagesPath).catch(() => {});
      });
      return;
    }

    // xppc produces the compiled .netmodule but does not update the binary .md
    // manifests the AOS uses to resolve class names at runtime — regenerate them
    // here, otherwise newly added classes stay invisible to D365 after deployment.
    const metaResult = await generateRuntimeMetadata(
      microsoftPackagesPath,
      customPackagesPath,
      liveState.targetModel,
      compilerMetadataPath,
    );
    if (metaResult.skipped) {
      await buildLog('WARN', `Runtime metadata regeneration skipped: ${metaResult.message}`);
    } else if (metaResult.success) {
      await buildLog('INFO', `Runtime metadata regenerated: ${metaResult.message}`);
      await appendFile(state.logFile, `\n✅ Runtime metadata (.md) regenerated for ${liveState.targetModel}\n`, 'utf-8').catch(() => {});
    } else {
      await buildLog('WARN', `Runtime metadata regeneration failed (build still succeeded): ${metaResult.message}`);
      await appendFile(state.logFile, `\n⚠️ Runtime metadata (.md) regeneration failed — VS build required for deployment of new classes:\n${metaResult.message}\n`, 'utf-8').catch(() => {});
    }

    // All models built — finalise as succeeded
    const final: BuildJobState = {
      ...liveState,
      status: 'succeeded',
      exitCode,
      endTime: new Date().toISOString(),
      queueResults: allResults,
    };
    await writeBuildState(final, customPackagesPath).catch(() => {});
    await buildLog('INFO', `xppc.exe SUCCEEDED — PID: ${pid} | model: ${modelName} | ${duration}s`);
  });

  return pid;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.

// ---------------------------------------------------------------------------
// Render the final result of a finished build (succeeded or failed) as the
// MCP response payload. Shared between the "existing finished state" branch
// and the wait-for-completion branch so both code paths produce identical
// output. Caller is responsible for calling clearBuildState() afterwards
// when appropriate.
// ---------------------------------------------------------------------------

async function renderFinishedBuildResult(
  finalState: BuildJobState,
  targetModel: string,
  /** Where to leave the last-build note; omitted when no symbol index is attached. */
  dataDir?: string,
  /** The tool's own arguments, for the opt-in post-build BP check. */
  params?: any,
  context?: any,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const succeeded  = finalState.status === 'succeeded';
  const isQueued   = !!(finalState.buildQueue && finalState.buildQueue.length > 1);
  const allResults = finalState.queueResults ?? [];

  if (isQueued) {
    const totalDuration = allResults.reduce((sum, r) => sum + r.duration, 0);
    const statusIcon    = succeeded ? '✅ Build complete' : '❌ Build failed';
    const modelLines    = allResults
      .map(r => `  ${r.status === 'succeeded' ? '✅' : '❌'} ${r.modelName}: ${r.duration}s`)
      .join('\n');

    const relevantResult = succeeded
      ? allResults[allResults.length - 1]
      : allResults.find(r => r.status === 'failed');
    const relevantLogFile = relevantResult?.logFile ?? finalState.logFile;
    const wholeLog = succeeded ? '' : await readWholeLog(relevantLogFile);
    const parsed = succeeded ? [] : parseXppcDiagnostics(wholeLog);
    const structured = succeeded ? '' : formatStructuredDiagnostics(parsed);
    const unexplained = succeeded ? '' : renderUnexplainedFailure(parsed, wholeLog);
    // Parse FIRST: how much raw log is worth carrying depends on whether the
    // diagnostics already explain the failure — see renderFailureLog.
    const logContent = succeeded
      ? trimSucceededLog(await readLogTail(relevantLogFile))
      : await renderFailureLog(relevantLogFile, parsed.length > 0);

    return {
      content: [{
        type: 'text',
        text: `${statusIcon} — ${allResults.length} models, ${totalDuration}s total\n\n${modelLines}\n\n` +
          (unexplained ? `${unexplained}\n\n` : '') +
          (structured ? `${structured}\n\n` : '') +
          `--- Log (${relevantResult?.modelName ?? targetModel}) ---\n${logContent}`,
      }],
      ...(succeeded ? {} : { isError: true }),
    };
  }

  const logTail       = await readLogTail(finalState.logFile);
  const hasWarnings   = succeeded && logTail.split(/\r?\n/).some(l => /Warning:\s/.test(l) && DIAG_LINE_TEST.test(l.trim()));
  const statusIcon    = !succeeded ? '❌ Build FAILED' : hasWarnings ? '⚠️ Build succeeded with warnings' : '✅ Build succeeded';
  const buildMode     = finalState.fullBuild ? 'full build (target), incremental (deps)' : 'incremental';
  const duration      = finalState.endTime
    ? Math.round((new Date(finalState.endTime).getTime() - new Date(finalState.startTime).getTime()) / 1000)
    : '?';
  const wholeLog      = succeeded ? '' : await readWholeLog(finalState.logFile);
  const parsed        = succeeded ? [] : parseXppcDiagnostics(wholeLog);
  const structured    = succeeded ? '' : formatStructuredDiagnostics(parsed);
  const unexplained   = succeeded ? '' : renderUnexplainedFailure(parsed, wholeLog);
  // Parse FIRST: how much raw log is worth carrying depends on whether the
  // diagnostics already explain the failure — see renderFailureLog.
  const logContent    = succeeded
    ? trimSucceededLog(logTail)
    : await renderFailureLog(finalState.logFile, parsed.length > 0);

  // The note run_bp_check and verify_d365fo_project read, so a green verdict from a
  // tool that compiles nothing can say whether anything ever did.
  if (dataDir) {
    recordBuild(dataDir, targetModel, {
      builtAt: new Date().toISOString(),
      fullBuild: !!finalState.fullBuild,
      succeeded,
    });
  }

  // "compile, then check best practices" was the second most common pair in the
  // sampled sessions (10 build -> run_bp_check hand-offs). Opt-in, and only on a
  // green build: when the compile failed, the compiler errors ARE the answer and
  // a BP report on half-built metadata is noise.
  const bpSection = succeeded ? await runPostBuildBpCheck(params, targetModel, context) : '';
  // Same shape, same reason, for the database sync: a table change is not
  // finished until AxDB is synchronised, and that sync always follows a
  // successful build. Gated on `succeeded` for the same reason bpCheck is —
  // syncing metadata the compiler just rejected is worse than not syncing.
  const sync = succeeded
    ? await runPostBuildDbSync(params, targetModel, context)
    : { section: '', failed: false };
  const syncSection = sync.section;

  return {
    content: [{
      type: 'text',
      text: `${statusIcon} (${finalState.tool}, ${buildMode}, ${duration}s)\n\nModel: ${targetModel}\n` +
        incrementalScopeCaveat(succeeded, !!finalState.fullBuild) + '\n' +
        (unexplained ? `${unexplained}\n\n` : '') +
        (structured ? `${structured}\n\n` : '') +
        `${logContent || '(no output)'}` + bpSection + syncSection,
    }],
    // A failed sync is an error even though the compile passed: the caller asked
    // for "build and sync", and half of that did not happen.
    ...((!succeeded || sync.failed) ? { isError: true } : {}),
  };
}

/**
 * Model-wide BP check appended to a successful build when bpCheck:true.
 *
 * Advisory by construction: any failure here is reported as a line, never as a
 * failed build — the compile already succeeded and that verdict stands.
 */
async function runPostBuildBpCheck(
  params: any,
  targetModel: string,
  context: any,
): Promise<string> {
  if (params?.bpCheck !== true && params?.bpCheck !== 'true') return '';
  try {
    const { runBpCheckTool } = await import('./runBpCheck.js');
    const result: any = await runBpCheckTool(
      { modelName: targetModel, projectPath: params?.projectPath, packagePath: params?.packagePath },
      context,
    );
    const text = (result?.content ?? [])
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n')
      .trim();
    return text ? `\n\n--- Best practices (bpCheck=true) ---\n${text}` : '';
  } catch (e: any) {
    return `\n\n⚠️ bpCheck requested but could not run: ${e?.message ?? e}`;
  }
}

/**
 * Database sync appended to a successful build when `dbSync` is set.
 *
 * Folded in from the retired `trigger_db_sync` tool, on the `bpCheck`
 * precedent above and with the same advisory contract: a sync failure is
 * reported as a section, never as a failed build, because the compile verdict
 * already stands.
 *
 * `dbSync: true` lets dbSyncTool derive the partial-sync list from the project
 * (its ordinary behaviour when no `tables` are named); `dbSync: ["CustTable"]`
 * syncs exactly those.
 */
async function runPostBuildDbSync(
  params: any,
  targetModel: string,
  context: any,
): Promise<{ section: string; failed: boolean }> {
  const requested = params?.dbSync;
  const tables = Array.isArray(requested)
    ? requested.filter((t: unknown) => typeof t === 'string' && t.trim().length > 0)
    : undefined;
  if (!Array.isArray(requested) && requested !== true && requested !== 'true') return { section: '', failed: false };
  try {
    const { dbSyncTool } = await import('./dbSync.js');
    const result: any = await dbSyncTool(
      {
        modelName: targetModel,
        projectPath: params?.projectPath,
        packagePath: params?.packagePath,
        ...(tables && tables.length > 0 ? { tables } : {}),
      },
      context,
    );
    const text = (result?.content ?? [])
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n')
      .trim();
    if (!text) return { section: '', failed: false };
    // dbSyncTool sets isError when the sync fails. Dropping it put a ❌ at the
    // bottom of a response headed ✅ Build succeeded, with the flag unset — and
    // since trigger_db_sync is no longer published, this is the only sync path
    // a caller has.
    const failed = result?.isError === true;
    const heading = failed
      ? '--- Database sync (dbSync) — FAILED, the build did not ---'
      : '--- Database sync (dbSync) ---';
    return { section: `\n\n${heading}\n${text}`, failed };
  } catch (e: any) {
    return { section: `\n\n⚠️ dbSync requested but could not run: ${e?.message ?? e}`, failed: true };
  }
}

/**
 * What a clean INCREMENTAL build does and does not prove.
 *
 * `-incremental` is documented by xppc as "Compile only the elements that have
 * been changed", so an element it considers unchanged is never recompiled and
 * its metadata errors are never reported. A model with real metadata errors
 * therefore builds green incrementally — which is how a run scored pass@build
 * on a model that does not actually compile. Only a full build sees everything,
 * so a green incremental result has to say what it covered.
 */
function incrementalScopeCaveat(succeeded: boolean, fullBuild: boolean): string {
  if (!succeeded || fullBuild) return '';
  return '\nℹ️ Incremental: only CHANGED elements were compiled. A clean result here is not proof ' +
    'the model compiles — unchanged elements with metadata errors are not revisited. ' +
    'Use fullBuild: true before trusting a green build (e.g. to score a task as done).\n';
}

// ---------------------------------------------------------------------------
// Block until the build for `targetModel` reaches a non-running state, the
// tracked process is confirmed gone without a result, or `timeoutMs` elapses.
//
// Outcomes:
//   { outcome: 'finished',  state }  — build reached succeeded/failed
//   { outcome: 'orphaned',  state }  — process vanished, no result was written
//   { outcome: 'timeout',   state }  — wait window expired, build still running
// ---------------------------------------------------------------------------

/** How often the waiter emits an MCP progress notification while blocking. */
const PROGRESS_INTERVAL_MS = 10_000;

/**
 * Default wait window. Long on purpose: with progress streaming the caller is
 * not sitting in silence, and a timeout short enough to fire on a normal build
 * is the worst of both worlds — it blocks for minutes AND still hands back a
 * "call me again" stub that costs another round trip (#829).
 */
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

function resolveWaitTimeoutMs(params: any): number {
  return (typeof params.waitTimeoutMs === 'number' && params.waitTimeoutMs > 0)
    ? params.waitTimeoutMs
    : DEFAULT_WAIT_TIMEOUT_MS;
}

/**
 * How long a dead PID is tolerated before the build is called orphaned. The
 * close handler runs in THIS process and finishes with runtime-metadata
 * regeneration (two execFile calls capped at 30 s + 60 s), so 'finalizing'
 * gets a window that comfortably covers it; anything else — an orphan from a
 * previous server process, a killed xppc — is only given time to settle.
 */
const FINALIZING_GRACE_MS = 5 * 60_000;
const ORPHAN_GRACE_MS = 30_000;

interface WaitOutcome {
  outcome: 'finished' | 'orphaned' | 'timeout';
  state: BuildJobState | null;
}

async function waitForBuildCompletion(
  targetModel: string,
  customPackagesPath: string,
  timeoutMs: number,
  onProgress?: ProgressReporter,
  startedAt: number = Date.now(),
): Promise<WaitOutcome> {
  const deadline = Date.now() + timeoutMs;
  // Poll roughly every second; xppc builds typically take many seconds to
  // many minutes, so a 1 s cadence is fine and keeps responsiveness high.
  const pollIntervalMs = 1000;
  let lastState: BuildJobState | null = null;
  // When the tracked PID was first seen dead — reset whenever it is alive again
  // (a queue advance briefly runs with pid 0 between models).
  let pidDeadSince: number | null = null;
  // 0 = emit on the very first poll. The first update is worth its cost: it
  // confirms the build is actually under way and starts the client's
  // timeout-reset clock immediately rather than PROGRESS_INTERVAL_MS later.
  let lastProgressAt = 0;

  while (Date.now() < deadline) {
    const state = await readBuildState(targetModel, customPackagesPath);
    if (state) {
      lastState = state;
      if (state.status !== 'running') return { outcome: 'finished', state };

      // pid 0 means a queue advance is in flight (the next model has not been
      // spawned yet) — transient, never an orphan.
      const finalizing = state.phase === 'finalizing';
      const settled = !finalizing && (!state.pid || isProcessAlive(state.pid));
      if (settled) {
        pidDeadSince = null;
      } else {
        if (pidDeadSince === null) pidDeadSince = Date.now();
        const grace = finalizing ? FINALIZING_GRACE_MS : ORPHAN_GRACE_MS;
        if (Date.now() - pidDeadSince > grace) return { outcome: 'orphaned', state };
      }

      // Report while we wait. This is the whole point of streaming: clients that
      // pass a progressToken reset their request timeout on each notification,
      // so a long build finishes inside this single call.
      if (onProgress && Date.now() - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        lastProgressAt = Date.now();
        await onProgress(describeBuildProgress(state, startedAt), Math.round((Date.now() - startedAt) / 1000));
      }
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  return { outcome: 'timeout', state: lastState };
}

/** One-line "what is happening right now" for a progress notification. */
function describeBuildProgress(state: BuildJobState, startedAt: number): string {
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const queue = state.buildQueue && state.buildQueue.length > 1
    ? ` (${(state.queueIndex ?? 0) + 1}/${state.buildQueue.length})`
    : '';
  const what = state.phase === 'finalizing'
    ? 'finalizing (runtime metadata)'
    : state.fullBuild ? 'full build' : 'incremental';
  return `🔨 Building ${state.modelName}${queue} — ${what}, ${elapsed}s elapsed`;
}

/**
 * What to do after a wait window expires. The old text ("call again to collect
 * the final result") made the follow-up poll the obvious move, which is a whole
 * extra round trip for a build that is still compiling. Name a concrete
 * waitTimeoutMs instead, so a caller that wants to keep waiting can do it in one
 * call rather than guessing a number.
 */
function renderWaitTimeoutGuidance(elapsedSec: number, timeoutMs: number): string {
  // Twice what has already elapsed, rounded up to a whole minute and never
  // below 10 — enough headroom that the next call is very unlikely to time out.
  const suggestMin = Math.max(10, Math.ceil((elapsedSec * 2) / 60));
  return [
    `The build is NOT finished and nothing is lost — it keeps compiling in the background.`,
    `Waited ${elapsedSec}s of the ${Math.round(timeoutMs / 1000)}s window.`,
    `To keep waiting in a single call: build_d365fo_project { waitTimeoutMs: ${suggestMin * 60_000} }  (${suggestMin} min).`,
    `Calling again without waitTimeoutMs re-attaches to the same build — it does not start a second one.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export const buildProjectTool = async (params: any, context: any, onProgress?: ProgressReporter) => {
  const dataDir: string | undefined = context?.symbolIndex?.dataDir;
  try {
    const force                 = params.force                === true;
    const fullBuild             = params.fullBuild            === true;
    // Disabled: rebuilding referenced models drags in every custom/ISV
    // dependency on each build and slows the whole run down for no benefit —
    // dependencies are expected to already be compiled. The parameter is
    // accepted but always ignored.
    const buildReferencedModels = false;

    const configManager = getConfigManager();
    await configManager.ensureLoaded();

    // ------------------------------------------------------------------
    // Resolve D365FO package paths
    // Supports UDE (Unified Developer Experience) and CHE (Cloud-Hosted Env).
    // ------------------------------------------------------------------
    let customPackagesPath:    string | null = null;
    let microsoftPackagesPath: string | null = null;
    let extraReferenceFolders: string[] = [];

    // Priority 1: XPP config (UDE) — authoritative source for all paths
    const xppConfig = await configManager.getActiveXppConfig();
    if (xppConfig) {
      customPackagesPath    = xppConfig.customPackagesPath;
      microsoftPackagesPath = xppConfig.microsoftPackagesPath;
      extraReferenceFolders = xppConfig.referencePackagesPaths ?? [];
    }

    // Priority 2: configManager explicit methods (.mcp.json overrides)
    if (!customPackagesPath)    customPackagesPath    = await configManager.getCustomPackagesPath();
    if (!microsoftPackagesPath) microsoftPackagesPath = await configManager.getMicrosoftPackagesPath() ?? configManager.getPackagePath();

    // Priority 3: CHE fallback — scan the machine's drives for AosService
    if (!microsoftPackagesPath) {
      microsoftPackagesPath = findPackagesRoot();
    }

    // In CHE, custom and Microsoft packages share the same PackagesLocalDirectory
    if (!customPackagesPath && microsoftPackagesPath) customPackagesPath = microsoftPackagesPath;

    if (!customPackagesPath || !microsoftPackagesPath) {
      return {
        content: [{
          type: 'text',
          text: [
            `❌ Cannot resolve D365FO package paths.`,
            ``,
            `Custom packages path:    ${customPackagesPath ?? '(not found)'}`,
            `Microsoft packages path: ${microsoftPackagesPath ?? '(not found)'}`,
            ``,
            `For UDE: ensure an XPP config is present at %LOCALAPPDATA%\\Microsoft\\Dynamics365\\XPPConfig\\`,
            `For CHE: ensure <drive>:\\AosService\\PackagesLocalDirectory exists. ${describePackagesRootScan()}`,
          ].join('\n'),
        }],
        isError: true,
      };
    }

    // ------------------------------------------------------------------
    // Resolve model name
    // ------------------------------------------------------------------
    let modelName: string | null = params.modelName || configManager.getModelName();

    if (!modelName && params.projectPath) {
      modelName = await getModelFromRnrproj(params.projectPath);
    }

    if (!modelName) {
      return {
        content: [{
          type: 'text',
          text: [
            `❌ Cannot determine model name.`,
            ``,
            `Provide modelName parameter, or configure it in .mcp.json / D365FO_MODEL_NAME env var.`,
          ].join('\n'),
        }],
        isError: true,
      };
    }

    const targetModel = modelName;

    // ------------------------------------------------------------------
    // Check for an existing background build (keyed by targetModel)
    // ------------------------------------------------------------------
    const existingState = await readBuildState(targetModel, customPackagesPath);

    if (existingState && !force) {
      // fullBuild:true is a request to RECOMPILE, not a request for the newest
      // available result — so a FINISHED state can never satisfy it, not even a
      // finished full build. Discard it and compile for real. (#829: an explicit
      // {fullBuild:true} came back as "Collected the result of the build that
      // ended 19:27:58 … nothing was recompiled by this call".)
      const fullBuildNeedsFreshRun = existingState.status !== 'running' && fullBuild;
      if (fullBuildNeedsFreshRun) {
        await buildLog('INFO', `fullBuild:true — discarding finished state for ${targetModel} and recompiling`);
        await clearBuildState(targetModel, customPackagesPath);
        // intentional fall-through to "start new build" below
      } else {

      // A 'finalizing' state has no live PID by definition — xppc exited and the
      // close handler is still doing post-build work — but it is very much a
      // running build, not an orphan.
      const alive   = existingState.phase === 'finalizing' || isProcessAlive(existingState.pid);
      const logTail = await readLogTail(existingState.logFile);

      if (existingState.status === 'running' && alive) {
        // The running build is INCREMENTAL but the caller asked for a full
        // recompile: attaching to it would answer a fullBuild:true request with
        // something that is not a full build. Say so plainly instead of
        // pretending it was honoured. (#829)
        if (fullBuild && existingState.fullBuild !== true) {
          const runningFor = Math.round((Date.now() - new Date(existingState.startTime).getTime()) / 1000);
          return {
            content: [{
              type: 'text',
              text: [
                `⛔ fullBuild DECLINED — nothing was recompiled by this call.`,
                ``,
                `An INCREMENTAL build of ${targetModel} (PID: ${existingState.pid}) has been running for ${runningFor}s.`,
                `Waiting for it would return an incremental result, which is not what fullBuild:true asks for.`,
                ``,
                `Choose one:`,
                `  • build_d365fo_project { fullBuild: true, force: true } — kill the running build and start the full one now`,
                `  • build_d365fo_project { fullBuild: true } again once the incremental build has finished`,
              ].join('\n'),
            }],
          };
        }
        const elapsed       = Math.round((Date.now() - new Date(existingState.startTime).getTime()) / 1000);
        const isQueued      = !!(existingState.buildQueue && existingState.buildQueue.length > 1);
        const queueProgress = isQueued
          ? `Building ${(existingState.queueIndex ?? 0) + 1}/${existingState.buildQueue!.length}: ${existingState.modelName}`
          : `Model: ${existingState.modelName}`;
        const completedLine = (existingState.queueResults ?? []).length > 0
          ? '\nCompleted: ' + existingState.queueResults!
              .map(r => `${r.status === 'succeeded' ? '✅' : '❌'} ${r.modelName} (${r.duration}s)`)
              .join(', ')
          : '';
        // When wait:true (default) and a build is already running for this
        // model, attach to it and block until completion instead of returning
        // a snapshot — this matches the "single call per build" contract.
        const waitForFinish = params.wait !== false;
        if (waitForFinish) {
          const timeoutMs = resolveWaitTimeoutMs(params);
          // A malformed startTime must not leak NaN into a progress payload.
          const stateStartedAt = new Date(existingState.startTime).getTime();
          const startedAt = Number.isFinite(stateStartedAt) ? stateStartedAt : Date.now();
          const wait = await waitForBuildCompletion(
            targetModel, customPackagesPath, timeoutMs, onProgress, startedAt,
          );
          if (wait.outcome === 'finished' && wait.state) {
            await clearBuildState(targetModel, customPackagesPath);
            return await renderFinishedBuildResult(wait.state, targetModel, dataDir, params, context);
          }
          const tailLog = await readLogTail(existingState.logFile);
          if (wait.outcome === 'orphaned') {
            await clearBuildState(targetModel, customPackagesPath);
            return {
              content: [{
                type: 'text',
                text: `❌ Build process (PID: ${existingState.pid}) disappeared without reporting a result.\n\nModel: ${targetModel}${completedLine}\n\nRe-run with force: true to start a clean build.\n\n--- Log ---\n${tailLog}`,
              }],
              isError: true,
            };
          }
          // Timed out — emit a "still running" snapshot so the caller can choose
          // to extend the wait window with another call.
          return {
            content: [{
              type: 'text',
              text:
                `⏳ ${queueProgress} (PID: ${existingState.pid}, running ${elapsed}s; wait timeout reached)${completedLine}\n\n` +
                renderWaitTimeoutGuidance(elapsed, timeoutMs) + '\n\n' +
                `--- Latest log ---\n${tailLog}`,
            }],
          };
        }
        return {
          content: [{
            type: 'text',
            text: `⏳ ${queueProgress} (PID: ${existingState.pid}, running ${elapsed}s)${completedLine}\n\nCall again to refresh.\n\n--- Latest log ---\n${logTail}`,
          }],
        };
      }

      if (existingState.status === 'running' && !alive) {
        // Process has exited but the async close handler may still be writing the final state.
        // Wait up to 2 s for it to settle.
        let finalState = existingState;
        for (let i = 0; i < 4; i++) {
          await new Promise(resolve => setTimeout(resolve, 500));
          const refreshed = await readBuildState(targetModel, customPackagesPath);
          if (refreshed && refreshed.status !== 'running') { finalState = refreshed; break; }
        }
        if (finalState.status !== 'running') {
          existingState.status   = finalState.status;
          existingState.exitCode = finalState.exitCode;
          existingState.endTime  = finalState.endTime;
          existingState.queueResults = finalState.queueResults;
        } else {
          await clearBuildState(targetModel, customPackagesPath);
          return {
            content: [{
              type: 'text',
              text: `❌ Build process (PID: ${existingState.pid}) exited unexpectedly without reporting a result.\n\nModel: ${targetModel}\n\n--- Log ---\n${logTail}`,
            }],
            isError: true,
          };
        }
      }

      // Build finished. It may be this caller collecting the result they were
      // handed off ("call again to collect"), or a fresh build request that
      // merely arrived after an old state file. Only the disk can tell them
      // apart: if sources changed since the build ended, the cached result
      // describes a tree that no longer exists and must not be replayed as
      // this call's success.
      const stillCurrent = await finishedResultStillDescribesDisk(
        existingState, targetModel, customPackagesPath,
      );
      await clearBuildState(targetModel, customPackagesPath);
      if (stillCurrent) {
        const result = await renderFinishedBuildResult(existingState, targetModel, dataDir, params, context);
        // Say plainly that nothing was compiled just now, so a reader can never
        // mistake a collected result for a fresh one.
        const collected =
          `ℹ️  Collected the result of the build that ended ${existingState.endTime} ` +
          `(no source changes since — nothing was recompiled by this call).\n\n`;
        return {
          ...result,
          content: [{ type: 'text', text: collected + (result.content[0]?.text ?? '') }],
        };
      }
      // Sources moved on — fall through and build for real.
      await buildLog(
        'WARN',
        `discarding finished build state for ${targetModel}: sources changed after ${existingState.endTime}`,
      );
      } // end else (buildModeChanged)
    }

    // ------------------------------------------------------------------
    // force=true: kill existing processes and clear state
    // ------------------------------------------------------------------
    if (force) {
      await buildLog('WARN', `force=true — killing orphaned build processes for model: ${targetModel}`);
      if (existingState?.pid) {
        try { process.kill(existingState.pid, 'SIGTERM'); } catch { /* already gone */ }
      }
      await killOrphanedBuildProcesses();
      await clearBuildState(targetModel, customPackagesPath);
      await forceReleaseLock(`build:${targetModel}`);
    }

    // ------------------------------------------------------------------
    // Find xppc.exe
    // ------------------------------------------------------------------
    const xppcExe = await findXppcExe(microsoftPackagesPath);
    if (!xppcExe) {
      return {
        content: [{
          type: 'text',
          text: `❌ Cannot find xppc.exe.\n\nLooked in: ${microsoftPackagesPath}\\bin\\xppc.exe\n\nEnsure the D365FO UDE tools are installed.`,
        }],
        isError: true,
      };
    }

    // ------------------------------------------------------------------
    // Resolve build queue
    // ------------------------------------------------------------------
    let buildQueue: string[];
    if (buildReferencedModels) {
      buildQueue = await resolveBuildQueue(targetModel, customPackagesPath, microsoftPackagesPath);
      await buildLog('INFO', `Build queue (${buildQueue.length}): ${buildQueue.join(' → ')}`);
    } else {
      buildQueue = [targetModel];
    }

    const firstModel   = buildQueue[0];
    const firstLogFile = logFilePath(targetModel, 0, customPackagesPath);

    // ------------------------------------------------------------------
    // Build context (shared across the entire queue)
    // ------------------------------------------------------------------
    const ctx: XppcBuildContext = {
      xppcExe,
      customPackagesPath,
      microsoftPackagesPath,
      // The model store, so the write-back stays with the source it describes.
      // In CHE the two roots are the same path anyway, so this is a no-op there.
      compilerMetadataPath: customPackagesPath,
      extraReferenceFolders,
    };

    // ------------------------------------------------------------------
    // Log build parameters
    // ------------------------------------------------------------------
    // Read from ctx, not from the variables it was built out of: this line exists to answer
    // "which root did -compilermetadata point at", and a copy of the expression would keep
    // reporting the old answer the moment the field is derived any other way.
    await buildLog('INFO', `Starting build — model: ${targetModel} | fullBuild: ${fullBuild} | queue: ${buildQueue.length}`);
    await buildLog('INFO', `  xppc.exe:              ${ctx.xppcExe}`);
    await buildLog('INFO', `  customPackagesPath:    ${ctx.customPackagesPath}`);
    await buildLog('INFO', `  microsoftPackagesPath: ${ctx.microsoftPackagesPath}`);
    await buildLog('INFO', `  compilerMetadataPath:  ${ctx.compilerMetadataPath} (xppc write-back target)`);
    if (ctx.extraReferenceFolders.length > 0) {
      await buildLog('INFO', `  extraReferenceFolders: ${ctx.extraReferenceFolders.join(', ')}`);
    }

    // ------------------------------------------------------------------
    // Initial state
    // ------------------------------------------------------------------
    const initState: BuildJobState = {
      pid: 0,             // updated by spawnXppcForState
      modelName: firstModel,
      targetModel,
      tool: 'xppc.exe',
      startTime: new Date().toISOString(),
      logFile: firstLogFile,
      status: 'running',
      fullBuild,
      buildQueue: buildQueue.length > 1 ? buildQueue : undefined,
      queueIndex: buildQueue.length > 1 ? 0 : undefined,
      queueResults: [],
    };

    await writeBuildState(initState, customPackagesPath);
    const pid = await spawnXppcForState(ctx, initState);

    // ------------------------------------------------------------------
    // Return "build started" message OR wait for completion
    // ------------------------------------------------------------------
    // When deps are included: full build applies only to the target model
    const modeLabel = fullBuild
      ? (buildQueue.length > 1 ? 'Full build (target), incremental (deps)' : 'Full build')
      : 'Incremental build';
    const queueDetail = buildQueue.length > 1
      ? `\n\nBuilding ${buildQueue.length} models in order:\n` +
        buildQueue.map((m, i) => `  ${i + 1}. ${m}${m === targetModel ? ' (target)' : ' (dependency)'}`).join('\n')
      : '';

    // wait defaults to true — single call returns the final result. When the
    // caller passes wait:false explicitly we keep the legacy fire-and-forget
    // behaviour for compatibility with callers that intentionally poll.
    const waitForFinish = params.wait !== false;

    if (waitForFinish) {
      const timeoutMs = resolveWaitTimeoutMs(params);
      const startedAt = new Date(initState.startTime).getTime();
      const wait = await waitForBuildCompletion(
        targetModel, customPackagesPath, timeoutMs, onProgress, startedAt,
      );
      if (wait.outcome === 'finished' && wait.state) {
        await clearBuildState(targetModel, customPackagesPath);
        return await renderFinishedBuildResult(wait.state, targetModel, dataDir, params, context);
      }
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const tailLog = await readLogTail(wait.state?.logFile ?? firstLogFile);
      if (wait.outcome === 'orphaned') {
        await clearBuildState(targetModel, customPackagesPath);
        return {
          content: [{
            type: 'text',
            text: [
              `❌ ${modeLabel} process (PID: ${pid}) disappeared after ${elapsed}s without reporting a result.`,
              ``,
              `Target: ${targetModel}${queueDetail}`,
              `Log:    ${firstLogFile}`,
              ``,
              `Re-run with force: true to start a clean build.`,
              ``,
              `--- Latest log ---`,
              tailLog,
            ].join('\n'),
          }],
          isError: true,
        };
      }
      // Timed out — leave the build running so a follow-up call can collect it.
      return {
        content: [{
          type: 'text',
          text: [
            `⏳ ${modeLabel} still running after ${elapsed}s (wait window of ${Math.round(timeoutMs / 1000)}s reached, build continues in background)`,
            ``,
            `Target: ${targetModel}${queueDetail}`,
            `Log:    ${firstLogFile}`,
            ``,
            renderWaitTimeoutGuidance(elapsed, timeoutMs),
            ``,
            `--- Latest log ---`,
            tailLog,
          ].join('\n'),
        }],
      };
    }

    // Legacy fire-and-forget mode: return immediately after spawning.
    return {
      content: [{
        type: 'text',
        text: [
          `🔨 ${modeLabel} started (xppc.exe PID: ${pid})`,
          ``,
          `Target: ${targetModel}${queueDetail}`,
          `Log:    ${firstLogFile}`,
          ``,
          `Call **build_d365fo_project** again to check status and see output.`,
        ].join('\n'),
      }],
    };

  } catch (error: any) {
    await buildLog('ERROR', `Unhandled error in build_d365fo_project: ${error?.message}`);
    return {
      content: [{ type: 'text', text: `❌ Internal error: ${error?.message ?? String(error)}` }],
      isError: true,
    };
  }
};
