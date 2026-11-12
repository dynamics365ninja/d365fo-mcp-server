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
import { forceReleaseLock, withOperationLock } from '../../utils/operationLocks.js';
import { lookupErrorFix } from '../knowledge/d365foErrorHelp.js';
import { generateRuntimeMetadata } from '../xml/generateMetadata.js';
import { compileModelLabels, type CompileLabelsResult } from '../write/compileLabels.js';
import { pruneStaleCompilerMetadata } from './compilerMetadataPrune.js';
import { describeMissingODataActions, scanODataActions, type MissingODataActions } from './odataActionGuard.js';
import { describeSchemaChanges, scanSchemaChanges } from './schemaChangeGuard.js';
import { recordBuild } from '../../utils/buildMarker.js';
import { monotonicProgress, type ProgressReporter, startProgressHeartbeat } from '../../utils/progressReporter.js';
import { restartAosRuntime, type RuntimeRestartResult } from './aosRuntime.js';
import { localAosUrl } from './aosWebConfig.js';

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

interface BuildJobState {
  jobId?: string;
  // The MCP server process whose close handler finishes this build. Once it is
  // gone nothing will ever write the final state, whatever the phase says.
  ownerPid?: number;
  // A restart build's result has been handed to a caller once. Kept only so a
  // re-issued restartAos request collects it instead of restarting again; any
  // other call treats the state as consumed, like a cleared plain build.
  resultDelivered?: boolean;
  restartWorkflow?: {
    // aosUrlSource: 'aosUrl' when passed, else the web.config the root was read from.
    request: { aosUrl: string; aosUrlSource?: string; bpCheck?: boolean; dbSync?: boolean | string[]; projectPath?: string; packagePath?: string };
    stage: 'pending' | 'prerequisites' | 'restarting' | 'complete' | 'uncertain';
    bpSection?: string;
    sync?: { section: string; failed: boolean };
    result?: RuntimeRestartResult;
  };
  pid: number;
  modelName: string;       // Currently building model
  targetModel: string;     // Final target model — state file is keyed by this
  tool: string;
  startTime: string;       // Start of the CURRENT model in the queue
  // When the job began, before any xppc read a source. Unlike startTime it is
  // not reset as the queue advances: a source changed after it may be missing
  // from the result (finishedResultStillDescribesDisk).
  sourcesAsOf?: string;
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
  // The post-build actions the build was STARTED with (a restart build keeps them
  // in restartWorkflow.request instead). A build that outlives its wait window —
  // wait:false, or past waitTimeoutMs — is collected by a later call, usually with
  // the model name alone, and that call's arguments used to decide: the bpCheck
  // and dbSync asked for at the start were dropped without a word.
  postBuildRequest?: PostBuildRequest;
  // Why a build asked for as incremental ran as a full one: an incremental compile drops
  // OData actions (see odataActionGuard.ts) and does not recompile the users of a changed
  // table, EDT or enum (see schemaChangeGuard.ts). Absent when fullBuild was requested.
  autoFullBuild?: AutoFullBuildReason;
  // Declared OData actions that ODataExtends.runtime still lacks after this build.
  odataActionsMissing?: MissingODataActions[];
}

interface AutoFullBuildReason {
  /** `<AxType>/<Name>` of the elements with OData actions this build had to recompile. */
  recompiled: string[];
  /** Entities whose ODataExtends.runtime entry had already lost actions. */
  missing: MissingODataActions[];
  /** `<AxType>/<Name>` of the tables, EDTs, enums and their extensions changed since the last build. */
  schemaChanged?: string[];
}

const asksFor = (v: unknown): boolean => v === true || v === 'true';

type PostBuildRequest = { bpCheck?: boolean; dbSync?: boolean | string[]; deploy?: boolean; projectPath?: string; packagePath?: string };

/**
 * The start's scope wins over a collecting `dbSync: true`, but tables a collecting
 * call names are added to the start's list, never dropped: that call reads the
 * sync section as covering them.
 */
function mergeDbSync(started: PostBuildRequest['dbSync'], collecting: unknown): unknown {
  if (started === true) return true;
  if (!Array.isArray(started)) return collecting;
  return Array.isArray(collecting) ? [...new Set([...started, ...collecting])] : started;
}

/** What the build asked for, plus what the collecting call adds; the start's dbSync scope wins. */
function postBuildParams(started: PostBuildRequest | undefined, collecting: any): PostBuildRequest & Record<string, unknown> {
  if (!started) return collecting ?? {};
  return {
    ...collecting,
    bpCheck: started.bpCheck || asksFor(collecting?.bpCheck),
    dbSync: mergeDbSync(started.dbSync, collecting?.dbSync),
    deploy: started.deploy || asksFor(collecting?.deploy),
    projectPath: collecting?.projectPath ?? started.projectPath,
    packagePath: collecting?.packagePath ?? started.packagePath,
  };
}

// A restart may affect every model hosted by this local AOS. Keep a durable
// reservation shared by MCP processes using this temp directory until the
// outcome has been saved. Never reap it by age. It is released without a human
// only when the server that owned it is gone AND it died before the restart
// stage: up to then nothing irreversible happened to the AOS (a repeated sync is
// idempotent). A reservation whose owner died while restarting stays put — that
// interruption cannot prove whether the mutation happened.
const restartReservationPath = path.join(os.tmpdir(), 'd365build_aos_restart.json');
const restartOwner = crypto.randomUUID();
interface RestartReservation {
  jobId: string;
  targetModel: string;
  customPackagesPath: string;
  owner: string;
  /** Absent in reservations written before it existed: those are never reaped. */
  ownerPid?: number;
}

async function readRestartReservation(): Promise<RestartReservation | null> {
  try {
    return JSON.parse(await readFile(restartReservationPath, 'utf-8'));
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`AOS restart state is uncertain. Inspect ${restartReservationPath} before starting another build.`);
  }
}

/**
 * Release a reservation whose owning server died before the restart stage.
 *
 * Without this, one server restart mid-build (a client that restarts its MCP
 * server on a request timeout is enough) left a reservation no live process
 * would ever remove, and every later build of every model was refused until
 * someone deleted the file by hand. Returns a note for the caller, or '' when
 * nothing was released. Call it only while holding build admission.
 */
async function releaseAbandonedRestartReservation(): Promise<string> {
  let reservation: RestartReservation | null;
  try {
    reservation = await readRestartReservation();
  } catch {
    return ''; // unreadable: genuinely uncertain, the admission check reports it
  }
  if (!reservation || reservation.owner === restartOwner || !reservation.ownerPid || isProcessAlive(reservation.ownerPid)) {
    return '';
  }
  const state = await readBuildState(reservation.targetModel, reservation.customPackagesPath);
  const ours = !!state && state.jobId === reservation.jobId;
  // The owner is gone but its xppc may not be: that build still changes the
  // model, so a restart must keep waiting for it.
  if (ours && state!.status === 'running' && state!.pid && isProcessAlive(state!.pid)) return '';
  const stage = ours ? state!.restartWorkflow?.stage : undefined;
  if (stage === 'restarting' || stage === 'uncertain') {
    if (ours && state!.status === 'running' && state!.restartWorkflow) {
      state!.restartWorkflow.stage = 'uncertain';
      state!.restartWorkflow.result = {
        status: 'blocked',
        message: `AOS restart outcome uncertain: the MCP server that ran it (PID ${reservation.ownerPid}) exited during the restart.`,
      };
      state!.status = 'failed';
      state!.endTime = new Date().toISOString();
      await writeBuildState(state!, reservation.customPackagesPath).catch(() => {});
    }
    return '';
  }
  if (ours) await clearBuildState(reservation.targetModel, reservation.customPackagesPath);
  await unlink(restartReservationPath).catch(() => {});
  const note =
    `Released the AOS restart reservation of ${reservation.targetModel}: the MCP server that ran that build ` +
    `(PID ${reservation.ownerPid}) exited ` +
    (stage === 'complete'
      ? 'after its restart workflow had completed, before releasing it.'
      : `during the '${stage ?? 'unknown'}' stage, before any AOS restart was attempted.`);
  await buildLog('WARN', note);
  return `ℹ️ ${note}\n\n`;
}

/**
 * Whether anything is still going to finish a 'running' state. The xppc PID
 * answers while it compiles; afterwards (finalizing, and the post-build steps of
 * a restart workflow) only the owning server can, so a state whose owner exited
 * is dead even though its phase says otherwise.
 */
function buildIsLive(state: BuildJobState): boolean {
  const ownerAlive = state.ownerPid === undefined || isProcessAlive(state.ownerPid);
  if (state.restartWorkflow || state.phase === 'finalizing') return ownerAlive;
  if (!state.pid) return ownerAlive; // queue advance in flight
  return isProcessAlive(state.pid);
}

async function ownsBuild(state: BuildJobState, packagesPath: string): Promise<boolean> {
  const current = await readBuildState(state.targetModel, packagesPath);
  return !!current && current.jobId === state.jobId;
}

async function clearOwnedBuildState(state: BuildJobState, packagesPath: string): Promise<void> {
  await withOperationLock('build-aos-admission', async () => {
    if (await ownsBuild(state, packagesPath)) await clearBuildState(state.targetModel, packagesPath);
  });
}

/**
 * A finished result has just been handed to a caller. A plain build's state is
 * cleared, as it always was; a restart build's is kept but marked delivered, so
 * only a re-issued restartAos request collects it again (see resultDelivered).
 */
async function consumeFinishedState(state: BuildJobState, packagesPath: string): Promise<void> {
  if (!state.restartWorkflow) {
    await clearOwnedBuildState(state, packagesPath);
    return;
  }
  await withOperationLock('build-aos-admission', async () => {
    if (await ownsBuild(state, packagesPath)) await writeBuildState({ ...state, resultDelivered: true }, packagesPath);
  });
}

async function saveFinishedState(state: BuildJobState, packagesPath: string): Promise<void> {
  await withOperationLock('build-aos-admission', async () => {
    if (!(await ownsBuild(state, packagesPath))) return;
    await writeBuildState(state, packagesPath);
    if (state.restartWorkflow && state.restartWorkflow.stage !== 'uncertain') {
      const reservation = await readRestartReservation();
      if (reservation && reservation.jobId === state.jobId && reservation.owner === restartOwner) {
        await unlink(restartReservationPath);
      }
    }
  });
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

function logFilePath(targetModel: string, customPackagesPath: string): string {
  const hash = crypto
    .createHash('md5')
    .update(`log:${targetModel.toLowerCase()}|${customPackagesPath.toLowerCase()}`)
    .digest('hex')
    .slice(0, 10);
  return path.join(os.tmpdir(), `d365build_log_${hash}.log`);
}

/**
 * Written BY the build, so always newer than it — scanning them would make
 * every cached result look stale and rebuild forever. `Resources` is labelc's
 * output (compileModelLabels, which runs before xppc and so after the build
 * started); the label sources are under `<Model>\AxLabelFile`.
 */
const BUILD_OUTPUT_DIRS = new Set(['bin', 'xppmetadata', 'resources']);

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
  return (await scanSourceChanges(modelDir, since, budgetMs)) !== 'unchanged';
}

/**
 * hasSourceChangesSince with "could not tell" kept apart from "changed": 'unknown' when the time
 * budget ran out or a subtree could not be read. A caller for which a wrong "changed" is costly
 * (attaching to a running build, while xppc loads the disk) can then decide differently.
 */
export async function scanSourceChanges(
  modelDir: string,
  since: number,
  budgetMs = 3000,
): Promise<'changed' | 'unchanged' | 'unknown'> {
  const deadline = Date.now() + budgetMs;
  const stack: string[] = [modelDir];
  while (stack.length > 0) {
    if (Date.now() > deadline) return 'unknown';
    const dir = stack.pop()!;
    let entries;
    try {
      // The directory's OWN mtime is what catches a DELETION: removing a class
      // leaves no file to stat, but the parent's mtime moves. Without this a
      // deleted source reads as "unchanged" and the stale result comes back.
      // Not for the package root: its entries are the build's own bin and
      // XppMetadata, which a build creates and a full build deletes, so its
      // mtime moves during every such build — and `since` is now the build's
      // START, so that would make every result look stale.
      if (dir !== modelDir && (await stat(dir)).mtimeMs > since) return 'changed';
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable subtree: can't prove it is unchanged.
      return 'unknown';
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dir === modelDir && BUILD_OUTPUT_DIRS.has(entry.name.toLowerCase())) continue;
        stack.push(full);
        continue;
      }
      try {
        if ((await stat(full)).mtimeMs > since) return 'changed';
      } catch { /* vanished mid-scan — ignore */ }
    }
  }
  return 'unchanged';
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
  // No idea whether, or when, it finished — do not trust it.
  if (!state.endTime || !Number.isFinite(new Date(state.endTime).getTime())) return false;
  // Measured from when the build STARTED, not from when it ended: xppc reads
  // the sources at the start, and endTime is written only after runtime
  // metadata regeneration (and a restart, if one was asked for). A file
  // changed in between — tens of seconds of "finalizing" on a real VM, plus
  // the compile itself — was older than endTime, so the result of a compile
  // that never saw it came back as current. Older state files without
  // sourcesAsOf fall back to the current queue entry's startTime: the target
  // model is compiled last, so that is when its sources were read.
  const sourcesAt = new Date(state.sourcesAsOf ?? state.startTime).getTime();
  if (!Number.isFinite(sourcesAt)) return false;
  return !(await hasSourceChangesSince(path.join(customPackagesPath, targetModel), sourcesAt));
}

async function readBuildState(targetModel: string, customPackagesPath: string): Promise<BuildJobState | null> {
  try {
    const raw = await readFile(stateFilePath(targetModel, customPackagesPath), 'utf-8');
    return JSON.parse(raw) as BuildJobState;
  } catch {
    return null;
  }
}

/**
 * Another model's state record, for the pre-restart scan. writeBuildState is
 * not atomic, so one failed parse may be a write in progress: read once more
 * before calling the file unreadable. A record that stays unparseable is not
 * being written by anyone, and null lets the scan move past it.
 */
async function readTrackedBuildState(file: string): Promise<BuildJobState | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return JSON.parse(await readFile(file, 'utf-8')) as BuildJobState;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  await buildLog('WARN', `ignoring unreadable build state ${file} in the pre-restart scan`);
  return null;
}

/**
 * readBuildState for a waiter, which must tell a state that is GONE (ENOENT: its
 * result was collected, or the build was cleared) from one caught mid-write
 * (null) — writeBuildState is not atomic, so a failed parse is not an absence.
 */
async function readBuildStateForWait(targetModel: string, customPackagesPath: string): Promise<BuildJobState | null | 'gone'> {
  try {
    return JSON.parse(await readFile(stateFilePath(targetModel, customPackagesPath), 'utf-8')) as BuildJobState;
  } catch (error: any) {
    return error?.code === 'ENOENT' ? 'gone' : null;
  }
}

async function writeBuildState(state: BuildJobState, customPackagesPath: string): Promise<void> {
  await writeFile(stateFilePath(state.targetModel, customPackagesPath), JSON.stringify(state, null, 2), 'utf-8');
}

async function clearBuildState(targetModel: string, customPackagesPath: string): Promise<void> {
  await unlink(stateFilePath(targetModel, customPackagesPath)).catch(() => {});
}

/**
 * EPERM means the process exists but this one may not signal it — an elevated
 * MCP server seen from a non-elevated one. Reading that as dead let a second
 * server reap a live server's restart reservation and build state
 * (releaseAbandonedRestartReservation), as operationLocks.ts already knows.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
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
  /**
   * Do the parsed diagnostics EXPLAIN the failure — i.e. is at least one of them
   * an error? Callers used to pass `parsed.length > 0`, which counts warnings:
   * a build that failed in a shape the regexes do not match, but whose log
   * carries BP warnings, then got a 40-line tail instead of the log, and the
   * error that actually stopped it is rarely in the last 40 lines.
   */
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
  toolContext?: any;
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
 * Delete the target model's OWN compiler metadata so xppc regenerates it from source.
 *
 * xppc's "Metadata Write-Back" phase does not reliably refresh an existing
 * `<compilermetadata>\<Model>\XppMetadata` tree for elements that changed. Measured on
 * 10.0.2527.174: a class had a field removed, `-incremental` was omitted (full build), the
 * write-back phase ran (57ms, per the phase table) and the compiled `.netmodule` correctly
 * dropped the field — while `XppMetadata\<Model>\AxClass\<Class>.xml` was left untouched at a
 * previous build's timestamp, still declaring it.
 *
 * That matters far beyond the metadata tree, because `RuntimeMetadataWriter.WriteAll`
 * (see generateMetadata.ts) SERIALIZES THE COMPILER METADATA into the binary `.md` manifests the
 * AOS reads — it never looks at the authoring XML. Proof: with this tree moved aside the writer
 * fails outright with "Compiler metadata not set before serialization to runtime format". So a
 * stale XppMetadata silently yields a stale `.md`, and a deployed package whose runtime metadata
 * contradicts its own IL — declaring members the compiled code no longer has. The build reports
 * success throughout, which is what makes it dangerous: it is invisible without probing the
 * artifacts for a symbol you know you just changed.
 *
 * Removing the tree makes the write-back unconditional, since there is nothing for xppc to
 * consider current. Verified: same source, same flags, `.md` shrank by exactly the removed
 * field's declaration and the phantom member was gone from every artifact.
 *
 * Full builds only. `-incremental` deliberately compares against this baseline to decide what to
 * recompile, so clearing it there would defeat the point of an incremental build; a full build is
 * already the "make it correct from scratch" path and pays ~6s more on a model this size.
 * Incremental builds get the per-file version instead: pruneModelCompilerMetadata.
 */
async function removeModelCompilerMetadata(
  ctx: XppcBuildContext,
  modelName: string,
): Promise<void> {
  const xppMetadataDir = path.join(ctx.compilerMetadataPath, modelName, 'XppMetadata');

  try {
    await access(xppMetadataDir);
  } catch {
    // Nothing there yet (first build of this model) — the write-back has nothing to skip.
    return;
  }

  try {
    await rm(xppMetadataDir, { recursive: true, force: true });
    await buildLog('INFO', `Full build: cleared compiler metadata so xppc regenerates it — ${xppMetadataDir}`);
  } catch (err: any) {
    // A lock or permission problem here does not justify failing the build: the result is the
    // pre-existing stale-metadata behaviour, not a worse one. Say so loudly instead, because it
    // means the .md manifests this build produces may not match the compiled code.
    await buildLog(
      'WARN',
      `Could not clear ${xppMetadataDir} (${err?.message ?? err}) — runtime .md manifests may be stale for changed elements`,
    );
  }
}

/**
 * Incremental counterpart of removeModelCompilerMetadata: drop only the XppMetadata files that are
 * stale or orphaned, so this build rewrites them — see pruneStaleCompilerMetadata for why a
 * whole-tree clear is wrong here and why the source is touched. Runs for every model the queue
 * compiles incrementally, dependencies included: their metadata is what the target compiles against.
 * Never fails the build; the worst outcome of a failure is the pre-existing stale metadata.
 */
async function pruneModelCompilerMetadata(
  ctx: XppcBuildContext,
  modelName: string,
): Promise<void> {
  const started = Date.now();
  try {
    const r = await pruneStaleCompilerMetadata(ctx.compilerMetadataPath, ctx.customPackagesPath, modelName);
    const elapsed = Date.now() - started;
    if (r.stale.length > 0 || r.phantoms.length > 0) {
      const names = (files: string[]) =>
        files.slice(0, 10).map(f => path.basename(path.dirname(f)) + '/' + path.basename(f, '.xml')).join(', ') +
        (files.length > 10 ? `, … (+${files.length - 10})` : '');
      await buildLog(
        'INFO',
        `Incremental build of ${modelName}: dropped stale compiler metadata so xppc rewrites it — ` +
        `${r.stale.length} changed [${names(r.stale)}], ${r.phantoms.length} deleted [${names(r.phantoms)}] ` +
        `(${r.scanned} scanned, ${elapsed}ms)`,
      );
    }
    if (r.skippedModels.length > 0) {
      await buildLog('INFO', `Compiler metadata of ${modelName} left alone for models with no source: ${r.skippedModels.join(', ')}`);
    }
    if (r.errors.length > 0) {
      await buildLog(
        'WARN',
        `Could not check ${r.errors.length} compiler-metadata file(s) of ${modelName} — runtime .md manifests may be stale for them: ` +
        r.errors.slice(0, 5).join('; '),
      );
    }
  } catch (err: any) {
    await buildLog('WARN', `Compiler-metadata check for ${modelName} failed (${err?.message ?? err}) — runtime .md manifests may be stale for changed elements`);
  }
}

/**
 * Whether a requested incremental build of the target model has to run as a full one, as Visual
 * Studio's does, to keep its OData actions — see odataActionGuard.ts for why `-incremental` drops
 * them. Null when incremental is safe. Like the metadata prune, it never fails the build: a scan
 * that fails leaves the build incremental, and the check after it still reports lost actions.
 */
async function odataActionsNeedFullBuild(ctx: XppcBuildContext, modelName: string): Promise<AutoFullBuildReason | null> {
  try {
    const r = await scanODataActions(ctx.compilerMetadataPath, ctx.customPackagesPath, modelName);
    if (r.errors.length > 0) {
      await buildLog('WARN', `OData action check of ${modelName} could not read ${r.errors.length} file(s): ${r.errors.slice(0, 5).join('; ')}`);
    }
    if (r.recompiled.length === 0 && r.missing.length === 0) return null;
    return { recompiled: r.recompiled, missing: r.missing };
  } catch (err: any) {
    await buildLog('WARN', `OData action check of ${modelName} failed (${err?.message ?? err}) — building incrementally`);
    return null;
  }
}

/**
 * The tables, EDTs, enums and their extensions of the target model changed since its last build —
 * see schemaChangeGuard.ts for why they make the build a full one. [] when none, when the model
 * was never built, or when the scan fails: like the OData check, it never fails the build.
 */
async function schemaChangesNeedingFullBuild(ctx: XppcBuildContext, modelName: string): Promise<string[]> {
  try {
    const r = await scanSchemaChanges(ctx.compilerMetadataPath, ctx.customPackagesPath, modelName);
    if (r.errors.length > 0) {
      await buildLog('WARN', `Table, EDT and enum change check of ${modelName} could not read ${r.errors.length} file(s): ${r.errors.slice(0, 5).join('; ')}`);
    }
    return r.changed;
  } catch (err: any) {
    await buildLog('WARN', `Table, EDT and enum change check of ${modelName} failed (${err?.message ?? err}) — building incrementally`);
    return [];
  }
}

/**
 * Every reason a requested incremental build of the target model has to run as a full one: its
 * OData actions (odataActionsNeedFullBuild) and its changed tables, EDTs and enums
 * (schemaChangesNeedingFullBuild). Null when incremental is safe.
 */
async function incrementalNeedsFullBuild(ctx: XppcBuildContext, modelName: string): Promise<AutoFullBuildReason | null> {
  const started = Date.now();
  const [odata, schemaChanged] = await Promise.all([
    odataActionsNeedFullBuild(ctx, modelName),
    schemaChangesNeedingFullBuild(ctx, modelName),
  ]);
  if (!odata && schemaChanged.length === 0) return null;
  const reason: AutoFullBuildReason = {
    recompiled: odata?.recompiled ?? [],
    missing: odata?.missing ?? [],
    ...(schemaChanged.length > 0 ? { schemaChanged } : {}),
  };
  await buildLog('INFO', `Incremental build of ${modelName} switched to a full build (${Date.now() - started}ms): ${describeAutoFullBuild(reason)}`);
  return reason;
}

/** Declared actions ODataExtends.runtime lacks after a successful build; [] when none or unknown. */
async function odataActionsMissingAfterBuild(ctx: XppcBuildContext, modelName: string): Promise<MissingODataActions[]> {
  try {
    const r = await scanODataActions(ctx.compilerMetadataPath, ctx.customPackagesPath, modelName, { checkRecompile: false });
    if (r.missing.length > 0) {
      await buildLog('WARN', `OData actions missing from ${r.runtimeFile} after the build: ${describeMissingODataActions(r.missing)}`);
    }
    return r.missing;
  } catch (err: any) {
    await buildLog('WARN', `OData action check of ${modelName} after the build failed: ${err?.message ?? err}`);
    return [];
  }
}

function describeOdataActionsMissing(missing: MissingODataActions[], fullBuild: boolean): string {
  return `⚠️ OData actions declared in source are missing from ODataExtends.runtime: ${describeMissingODataActions(missing)}. ` +
    'The AOS reads that file at startup, so after the next restart these actions are not exposed. ' +
    (fullBuild
      ? 'A full build did not write them either: check the methods\' SysODataActionAttribute and that the entity is public.'
      : 'Run build_d365fo_project with fullBuild: true before restarting the AOS.');
}

function describeAutoFullBuild(reason: AutoFullBuildReason): string {
  const parts: string[] = [];
  if (reason.recompiled.length > 0) {
    const names = reason.recompiled.slice(0, 10).join(', ') + (reason.recompiled.length > 10 ? `, … (+${reason.recompiled.length - 10})` : '');
    parts.push(`changed elements with OData actions: ${names}`);
  }
  if (reason.missing.length > 0) {
    parts.push(`actions already missing from ODataExtends.runtime: ${describeMissingODataActions(reason.missing)}`);
  }
  const odata = parts.length > 0;
  const schemaChanged = reason.schemaChanged ?? [];
  if (schemaChanged.length > 0) parts.push(describeSchemaChanges(schemaChanged));
  return `ℹ️ Full build instead of incremental — ${parts.join('; ')}.` +
    (odata
      ? ' An incremental xppc build rewrites a recompiled entity\'s ODataExtends.runtime entry without its OData actions, ' +
        'so they would disappear from OData at the next AOS restart.'
      : '') +
    (schemaChanged.length > 0
      ? ' An incremental xppc build does not recompile the code that uses a changed table, EDT or enum, ' +
        'so it can report 0 errors where a full build fails.'
      : '');
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
  let useFullBuild = fullBuild && modelName === targetModel;

  assertSafePath(xppcExe, 'xppc.exe path');
  assertSafePath(modelName, 'Model name');
  assertSafePath(customPackagesPath, 'Custom packages path');
  assertSafePath(microsoftPackagesPath, 'Microsoft packages path');
  assertSafePath(compilerMetadataPath, 'Compiler metadata path');

  await removeStaleFrameworkCompilerMetadata(ctx, modelName);

  // Before the prune below, which deletes the metadata this compares against. Recorded on the
  // state itself — the caller's initState too — so everything that reads it reports a full build.
  if (!useFullBuild && modelName === targetModel) {
    const reason = await incrementalNeedsFullBuild(ctx, modelName);
    if (reason) {
      useFullBuild = true;
      state.fullBuild = true;
      state.autoFullBuild = reason;
    }
  }

  // Without this, xppc's write-back can leave changed elements stale in XppMetadata, and the
  // runtime .md manifests generated from it then contradict the compiled netmodule. A full build
  // clears the model's whole tree (removeModelCompilerMetadata); an incremental one may only drop
  // the stale files (pruneModelCompilerMetadata), or unchanged elements would vanish with them.
  if (useFullBuild) {
    await removeModelCompilerMetadata(ctx, modelName);
  } else {
    await pruneModelCompilerMetadata(ctx, modelName);
  }

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
  ].join('\n') + (state.autoFullBuild ? `${describeAutoFullBuild(state.autoFullBuild)}\n\n` : '');

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
    if (!(await ownsBuild(liveState, customPackagesPath))) return;
    const failed: BuildJobState = { ...liveState, status: 'failed', exitCode: -1, endTime: new Date().toISOString() };
    await saveFinishedState(failed, customPackagesPath).catch(() => {});
    await buildLog('ERROR', `xppc.exe spawn error — PID: ${pid}: ${err.message}`);
  });

  child.on('close', async (code) => {
    closeSyncFs(logFd);
    if (!(await ownsBuild(liveState, customPackagesPath))) return;
    try {
      const exitCode = code ?? -1;

      // Publish "xppc is gone, I am finishing up" BEFORE the post-build work, so
      // a waiter can tell this apart from an orphaned process and keeps waiting
      // instead of returning a stub for an already-finished build.
      const ownsFinalization = await withOperationLock('build-aos-admission', async () => {
        if (!(await ownsBuild(liveState, customPackagesPath))) return false;
        await writeBuildState({ ...liveState, phase: 'finalizing' }, customPackagesPath);
        return true;
      });
      if (!ownsFinalization) return;

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

      if (!succeeded) {
        const final: BuildJobState = {
          ...liveState,
          status: 'failed',
          exitCode,
          endTime: new Date().toISOString(),
        };
        await saveFinishedState(final, customPackagesPath).catch(() => {});
        await buildLog('ERROR', `xppc.exe FAILED — PID: ${pid} | model: ${modelName} | exit: ${exitCode} | compileErrors: ${hasCompileErrors}`);
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
      if (!(await ownsBuild(liveState, customPackagesPath))) return;
      if (metaResult.skipped) {
        await buildLog('WARN', `Runtime metadata regeneration skipped: ${metaResult.message}`);
      } else if (metaResult.success) {
        await buildLog('INFO', `Runtime metadata regenerated: ${metaResult.message}`);
        await appendFile(state.logFile, `\n✅ Runtime metadata (.md) regenerated for ${liveState.targetModel}\n`, 'utf-8').catch(() => {});
      } else {
        await buildLog('WARN', `Runtime metadata regeneration failed (build still succeeded): ${metaResult.message}`);
        await appendFile(state.logFile, `\n⚠️ Runtime metadata (.md) regeneration failed — VS build required for deployment of new classes:\n${metaResult.message}\n`, 'utf-8').catch(() => {});
      }

      // What the AOS will read at its next start. Only the target model: it is the one compiled.
      const odataActionsMissing = modelName === liveState.targetModel ? await odataActionsMissingAfterBuild(ctx, modelName) : [];
      if (!(await ownsBuild(liveState, customPackagesPath))) return;
      if (odataActionsMissing.length > 0) {
        await appendFile(state.logFile, `\n⚠️ OData actions missing from ODataExtends.runtime: ${describeMissingODataActions(odataActionsMissing)}\n`, 'utf-8').catch(() => {});
      }

      const final: BuildJobState = {
        ...liveState,
        status: 'succeeded',
        exitCode,
        endTime: new Date().toISOString(),
        ...(odataActionsMissing.length > 0 ? { odataActionsMissing } : {}),
      };
      if (final.restartWorkflow) {
        // The build verdict stays the one every build gets; a log that still
        // reports errors only withholds the restart (see finishRestartWorkflow).
        const reportedErrors = parseXppcDiagnostics(xppcErrContent).some(d => d.severity === 'error') ||
          (xppcReportedErrorCount(xppcErrContent) ?? 0) > 0;
        await finishRestartWorkflow(final, customPackagesPath, metaResult, ctx.toolContext, reportedErrors);
      }
      await saveFinishedState(final, customPackagesPath);
      await buildLog('INFO', `xppc.exe SUCCEEDED — PID: ${pid} | model: ${modelName} | ${duration}s`);
    } catch (error: any) {
      if (liveState.restartWorkflow && await ownsBuild(liveState, customPackagesPath)) {
        const current = await readBuildState(targetModel, customPackagesPath);
        if (current?.restartWorkflow) {
          current.restartWorkflow.stage = 'uncertain';
          current.restartWorkflow.result = { status: 'blocked', message: `AOS restart outcome uncertain: ${error?.message ?? error}. Inspect ${restartReservationPath} and the environment before recovery.` };
          current.status = 'failed';
          current.endTime = new Date().toISOString();
          await writeBuildState(current, customPackagesPath).catch(() => {});
        }
      }
      await buildLog('ERROR', `Build finalization failed: ${error?.message ?? error}`);
    }
  });

  return pid;
}

async function finishRestartWorkflow(
  state: BuildJobState,
  packagesPath: string,
  metadata: { success: boolean; skipped?: boolean; message: string },
  context: any,
  /** The xppc log reports errors that the build verdict does not count. */
  reportedErrors = false,
): Promise<void> {
  const workflow = state.restartWorkflow!;
  const persistIntent = async () => {
    if (!(await ownsBuild(state, packagesPath))) throw new Error('Build ownership changed');
    const reservation = await readRestartReservation();
    if (!reservation || reservation.jobId !== state.jobId || reservation.owner !== restartOwner) throw new Error('Restart ownership changed');
    // Do not publish succeeded until every requested stage has settled.
    await writeBuildState({ ...state, status: 'running', phase: 'finalizing' }, packagesPath);
  };
  // The build succeeded, so the requested BP check and sync run exactly as they
  // would without restartAos. Only the restart itself depends on what follows:
  // a blocked restart used to skip them too, leaving a table change unsynced
  // with nothing in the result to say so.
  workflow.stage = 'prerequisites';
  await persistIntent();
  workflow.bpSection = await runPostBuildBpCheck(workflow.request, state.targetModel, context, `${state.logFile}.bp.txt`);
  workflow.sync = await runPostBuildDbSync(workflow.request, state.targetModel, context);
  const syncRequested = workflow.request.dbSync === true || Array.isArray(workflow.request.dbSync);
  if (reportedErrors) {
    // Restarting the AOS onto a model whose log reports errors would load
    // exactly what the compiler complained about.
    workflow.result = { status: 'blocked', message: 'AOS restart blocked: the xppc log reports errors (see the diagnostics above).' };
  } else if (!metadata.success || metadata.skipped) {
    workflow.result = { status: 'blocked', message: `AOS restart blocked: runtime metadata was not generated. ${metadata.message}` };
  } else if (!state.fullBuild && state.odataActionsMissing?.length) {
    // The restart is what takes them out of OData; a full build puts them back first. After a
    // full build that still lacks them a restart cannot make things worse, so it goes ahead.
    workflow.result = {
      status: 'blocked',
      message: `AOS restart blocked: OData actions are missing from ODataExtends.runtime (${describeMissingODataActions(state.odataActionsMissing)}). ` +
        'Rebuild with fullBuild: true, restartAos: true.',
    };
  } else if (syncRequested && (workflow.sync.failed || !workflow.sync.section ||
    // An empty selection or response cannot establish that requested sync ran.
    (Array.isArray(workflow.request.dbSync) && !workflow.request.dbSync.some(t => typeof t === 'string' && t.trim())))) {
    workflow.result = { status: 'blocked', message: 'AOS restart blocked: requested database sync did not succeed.' };
  } else {
    workflow.stage = 'restarting';
    await persistIntent();
    workflow.result = await restartAosRuntime(workflow.request.aosUrl);
  }
  workflow.stage = workflow.result?.status === 'failed' ? 'uncertain' : 'complete';
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
  /** Keeps the client informed during a post-build deployment, which takes minutes. */
  onProgress?: ProgressReporter,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const succeeded  = finalState.status === 'succeeded';
  const workflow = finalState.restartWorkflow;
  const runtimeWarning = !!workflow && workflow.result?.status !== 'ready';
  // What was restarted and why that root, in the result itself: the build log
  // goes to the server's stderr, which the caller never sees.
  const runtimeFacts = workflow?.result
    ? [
      `Environment root: ${workflow.request.aosUrl} (from ${workflow.request.aosUrlSource ?? 'aosUrl'})`,
      ...(workflow.result.host
        ? [`Host: ${workflow.result.host}${workflow.result.replacementPid ? ` -> PID ${workflow.result.replacementPid}` : ''}`]
        : []),
      `Status: ${workflow.result.status}`,
    ].join('\n') + '\n'
    : '';
  const runtimeSection = workflow
    ? `\n\n--- AOS restart ---\n${runtimeFacts}${runtimeWarning ? '⚠️ ' : ''}${workflow.result?.message ?? 'AOS restart was not attempted because the build failed.'}`
    : '';
  const logTail       = await readLogTail(finalState.logFile);
  const hasWarnings   = succeeded && logTail.split(/\r?\n/).some(l => /Warning:\s/.test(l) && DIAG_LINE_TEST.test(l.trim()));
  const odataMissing  = succeeded ? finalState.odataActionsMissing ?? [] : [];
  const statusIcon    = !succeeded ? '❌ Build FAILED' : runtimeWarning ? '⚠️ Build succeeded; AOS requires attention' :
    odataMissing.length > 0 ? '⚠️ Build succeeded; OData actions missing' : hasWarnings ? '⚠️ Build succeeded with warnings' : '✅ Build succeeded';
  const buildMode     = finalState.autoFullBuild ? 'full build, switched from incremental' : finalState.fullBuild ? 'full build' : 'incremental';
  const odataSection  = (finalState.autoFullBuild ? `\n${describeAutoFullBuild(finalState.autoFullBuild)}\n` : '') +
    (odataMissing.length > 0 ? `\n${describeOdataActionsMissing(odataMissing, !!finalState.fullBuild)}\n` : '');
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
    : await renderFailureLog(finalState.logFile, parsed.some(d => d.severity === 'error'));

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
  const postParams = postBuildParams(finalState.postBuildRequest, params);
  const bpSection = workflow ? workflow.bpSection ?? ''
    : succeeded ? await withHeartbeat(onProgress, `🔍 ${targetModel} built; running the best-practice check`,
      () => runPostBuildBpCheck(postParams, targetModel, context, `${finalState.logFile}.bp.txt`)) : '';
  // Same shape, same reason, for the database sync: a table change is not
  // finished until AxDB is synchronised, and that sync always follows a
  // successful build. Gated on `succeeded` for the same reason bpCheck is —
  // syncing metadata the compiler just rejected is worse than not syncing.
  // On UDE a deployment replaces the local sync: there is no local database, and the sync
  // runs in the environment as part of the deployment (dbSync = Release package, full sync).
  const deploying = !workflow && asksFor(postParams.deploy);
  // What this render does, for a call that waited on the same build but did not render it
  // (resultCollectedElsewhere): it runs whatever it asked for that is not in this list.
  if (finalState.jobId) {
    recordPostBuildRan(finalState.jobId, {
      succeeded,
      bpCheck: workflow ? !!workflow.request.bpCheck : asksFor(postParams.bpCheck),
      dbSync: syncScope(workflow ? workflow.request.dbSync : postParams.dbSync),
      deploy: deploying,
    });
  }
  const sync: { section: string; failed: boolean; synced?: SyncedScope } = workflow
    ? workflow.sync ?? { section: '', failed: false } : succeeded && !deploying
    ? await withHeartbeat(onProgress, `🗄️ ${targetModel} built; synchronizing the database`,
      () => runPostBuildDbSync(postParams, targetModel, context))
    : { section: '', failed: false };
  // `dbSync: true` from the start wins the merge over this call's table list (mergeDbSync), and
  // syncs the project's tables. A table this call named outside the project is synced now. This
  // call's own `true` means the start's scope, as in mergeDbSync, so only a list is checked.
  const askedTables = Array.isArray(params?.dbSync) ? syncScope(params.dbSync) : undefined;
  if (askedTables && !workflow && succeeded && !deploying && !sync.failed) {
    const left = remainingSync(askedTables, syncScope(postParams.dbSync), sync.synced);
    if (left !== undefined) {
      const extra = await withHeartbeat(onProgress, `🗄️ ${targetModel} built; synchronizing the database`,
        () => runPostBuildDbSync({ ...postParams, dbSync: left }, targetModel, context));
      sync.section += extra.section;
      sync.failed = extra.failed;
      sync.synced = extra.failed ? sync.synced : addSynced(sync.synced, extra.synced);
    }
  }
  const ranRecord = finalState.jobId ? postBuildRanByJob.get(finalState.jobId) : undefined;
  if (ranRecord) ranRecord.dbSynced = sync.synced;
  const deployment = deploying && succeeded
    ? await runPostBuildDeploy(postParams, targetModel, `${finalState.logFile}.deploy.log`, onProgress)
    : { section: '', failed: false };
  const syncSection = sync.section + deployment.section;

  return {
    content: [{
      type: 'text',
      text: `${statusIcon} (${finalState.tool}, ${buildMode}, ${duration}s)\n\nModel: ${targetModel}\n` +
        odataSection +
        incrementalScopeCaveat(succeeded, !!finalState.fullBuild) + '\n' +
        (unexplained ? `${unexplained}\n\n` : '') +
        (structured ? `${structured}\n\n` : '') +
        `${logContent || '(no output)'}` + bpSection + syncSection + runtimeSection,
    }],
    // A failed sync is an error even though the compile passed: the caller asked
    // for "build and sync", and half of that did not happen.
    ...((!succeeded || sync.failed || deployment.failed || runtimeWarning) ? { isError: true } : {}),
  };
}

/**
 * Runs a post-build step that reports no progress of its own, sending a heartbeat meanwhile.
 * build_d365fo_project reports its own progress, so the dispatcher's heartbeat does not cover
 * it, and a minutes-long BP check or sync would otherwise outlast a client's request timeout.
 */
async function withHeartbeat<T>(onProgress: ProgressReporter | undefined, message: string, step: () => Promise<T>): Promise<T> {
  const stop = onProgress ? startProgressHeartbeat(onProgress, message, PROGRESS_INTERVAL_MS) : undefined;
  try {
    return await step();
  } finally {
    stop?.();
  }
}

/**
 * Deployment of the model's package to its UDE environment, after a successful build, when
 * `deploy: true` (udeDeploy.ts). `dbSync` (true or a list) selects a Release package with a full
 * sync; the deployment cannot sync a table list, so a list syncs everything too.
 */
async function runPostBuildDeploy(
  params: any,
  targetModel: string,
  logFile: string,
  onProgress?: ProgressReporter,
): Promise<{ section: string; failed: boolean }> {
  try {
    const deploy = await import('./udeDeploy.js');
    const check = await deploy.checkDeployPrerequisites(getConfigManager(), params);
    if (!check.ok) return { section: `\n\n--- Deployment (deploy) — FAILED, the build did not ---\n❌ ${check.message.replace(/ Nothing was built\./, ' Nothing was deployed.')}`, failed: true };
    const paths = await deploy.udePackagePaths();
    if (!paths) return { section: '\n\n--- Deployment (deploy) — FAILED, the build did not ---\n❌ The XPP config names no packages folders. Nothing was deployed.', failed: true };
    const fullSync = params?.dbSync === true || params?.dbSync === 'true' || Array.isArray(params?.dbSync);
    const result = await deploy.deployModelToUde({
      modelName: targetModel, ...paths, dataverse: check.dataverse, fullSync, logFile, onProgress,
    });
    const listNote = Array.isArray(params?.dbSync)
      ? '\nℹ️ A deployment syncs the whole database; the dbSync table list was not used to narrow it.'
      : '';
    return { section: result.section + (result.failed ? '' : listNote), failed: result.failed };
  } catch (e: any) {
    return { section: `\n\n⚠️ deploy requested but could not run: ${e?.message ?? e}`, failed: true };
  }
}

/**
 * Past this size a build result carries a summary of the BP check, not its text.
 *
 * run_bp_check prints xppbp's raw output, then every finding again as a
 * moniker-checked list — on a model with ~5,000 warnings that put 2.7 MB into
 * one build result (build_d365fo_project is uncapped), past what an MCP client
 * shows inline, burying the compile verdict. The complete text is kept in a file
 * next to the build log, and run_bp_check returns it on request.
 */
const BP_SECTION_CHAR_LIMIT = 12_000;
const BP_SUMMARY_RULES = 25;
const BP_SAMPLE_FINDINGS = 15;

export function summarizeBpOutput(
  text: string,
  findings: Array<{ moniker: string | null; target: string; severity?: string; path?: string }>,
  savedTo?: string,
): string {
  const verdict = text.split('\n')[0].trim();
  // Errors lead, whatever their count: one BP error among thousands of warnings is
  // the finding that fails a pipeline, and ranking by count alone pushed it past the
  // rule cut and out of the sample, leaving only a number in the totals line. The
  // terse line shape carries no severity, so a BPError moniker counts as one too.
  const isError = (f: { moniker: string | null; severity?: string }) =>
    f.severity?.toLowerCase() === 'error' || /^BPError/i.test(f.moniker ?? '');
  const byRule = new Map<string, { count: number; severity?: string; error: boolean }>();
  for (const f of findings) {
    const rule = f.moniker ?? '(rule not named on the line)';
    const entry = byRule.get(rule) ?? { count: 0, severity: f.severity, error: false };
    entry.count++;
    entry.severity ??= f.severity;
    entry.error ||= isError(f);
    byRule.set(rule, entry);
  }
  const rules = [...byRule.entries()].sort((a, b) => Number(b[1].error) - Number(a[1].error) || b[1].count - a[1].count);
  const sample = [...findings.filter(isError), ...findings.filter(f => !isError(f))].slice(0, BP_SAMPLE_FINDINGS);
  // run_bp_check's caveat that BPErrorUnknownLabel may come from a failed label
  // compile, not from the source: it qualifies the findings below, so it stays.
  const labelCaveat = text.match(/^⚠️ Labels could not be compiled.*$/m)?.[0].trim();
  // Pipeline parity (bpPipelineParity.ts): which findings are reproduced pipeline rules,
  // and how many are label false positives. Both change how the counts below are read.
  const reproduced = findings.filter(f => /^BPCheck(Table|MenuItem)(OperationalDomain|SubscriberAccessLevel)Property/.test(f.moniker ?? '')).length;
  const reproducedNote = /^Reproduced pipeline rules/m.test(text) && reproduced > 0
    ? `${reproduced} finding(s) are reproduced pipeline rules (OperationalDomain/SubscriberAccessLevel): this xppbp lacks them, the Azure DevOps build reports them.`
    : undefined;
  const labelArtifacts = [...text.matchAll(/^Likely label false positives: (\d+) BPErrorUnknownLabel and (\d+) BPUnusedStrFmtArgument/gm)]
    .reduce((n, m) => n + Number(m[1]) + Number(m[2]), 0);
  const labelArtifactNote = labelArtifacts > 0
    ? `${labelArtifacts} BPErrorUnknownLabel/BPUnusedStrFmtArgument finding(s) name labels that exist in the model's label files: likely false positives, do not create those labels again.`
    : undefined;
  // xppbp's own tally is the total; the parser recognises only BP-moniker lines
  // (not CodeAnalysis ones, for instance), so its count can be lower.
  const total = (label: string) => [...text.matchAll(new RegExp(`^\\s*${label}\\s*:\\s*(\\d+)\\s*$`, 'gim'))].at(-1)?.[1];
  const totals = [['Errors', total('Errors')], ['Warnings', total('Warnings')]]
    .filter(([, n]) => n !== undefined).map(([label, n]) => `${label} ${n}`).join(', ');
  const lines = [
    verdict,
    '',
    ...(totals ? [`xppbp totals: ${totals}.`] : []),
    ...(labelCaveat ? [labelCaveat] : []),
    ...(reproducedNote ? [reproducedNote] : []),
    ...(labelArtifactNote ? [labelArtifactNote] : []),
    `Counted below: ${findings.length} finding(s) the parser recognises (BP rule lines), across ${rules.length} rule(s). ` +
      `The full output (${text.split('\n').length} lines) is too large for a build result` +
      (savedTo ? ` and is saved to: ${savedTo}` : '') +
      '. For the complete list, call run_bp_check with this modelName.',
  ];
  if (rules.length > 0) {
    lines.push('', 'Findings by rule:');
    for (const [rule, { count, severity }] of rules.slice(0, BP_SUMMARY_RULES)) {
      lines.push(`  ${count} × ${rule}${severity ? ` (${severity})` : ''}`);
    }
    if (rules.length > BP_SUMMARY_RULES) lines.push(`  … and ${rules.length - BP_SUMMARY_RULES} more rule(s)`);
    lines.push('', `First ${sample.length} finding(s), errors first:`);
    for (const f of sample) {
      lines.push(`  • ${f.moniker ?? '(rule not named)'}: ${f.path ?? f.target}`);
    }
  }
  return lines.join('\n');
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
  /** Where to keep the complete output when the build result carries only a summary. */
  fullOutputFile?: string,
): Promise<string> {
  if (params?.bpCheck !== true && params?.bpCheck !== 'true') return '';
  try {
    const bp = await import('./runBpCheck.js');
    const result: any = await bp.runBpCheckTool(
      { modelName: targetModel, projectPath: params?.projectPath, packagePath: params?.packagePath },
      context,
    );
    const text = (result?.content ?? [])
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n')
      .trim();
    if (!text) return '';
    if (text.length <= BP_SECTION_CHAR_LIMIT) return `\n\n--- Best practices (bpCheck=true) ---\n${text}`;
    let saved: string | undefined;
    if (fullOutputFile) {
      saved = await writeFile(fullOutputFile, text, 'utf-8').then(() => fullOutputFile, () => undefined);
    }
    let findings: ReturnType<typeof bp.parseBpFindings> = [];
    try { findings = bp.parseBpFindings(text); } catch { /* the summary still gives the verdict and the file */ }
    return `\n\n--- Best practices (bpCheck=true) — summary ---\n${summarizeBpOutput(text, findings, saved)}`;
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
 * syncs exactly those. `synced` is what a successful sync covered, as dbSyncTool
 * reports it: `true` asks for the project's tables, which is not every table.
 */
async function runPostBuildDbSync(
  params: any,
  targetModel: string,
  context: any,
): Promise<{ section: string; failed: boolean; synced?: SyncedScope }> {
  const requested = params?.dbSync;
  const tables = Array.isArray(requested)
    ? requested.filter((t: unknown) => typeof t === 'string' && t.trim().length > 0)
    : undefined;
  if (!Array.isArray(requested) && requested !== true && requested !== 'true') return { section: '', failed: false };
  // `dbSync: []` fell through with `tables` undefined, which dbSyncTool reads as
  // "derive the scope from the project" — so asking to sync NOTHING synced
  // everything. An empty list is a caller mistake; say so rather than guess.
  if (Array.isArray(requested) && (tables?.length ?? 0) === 0) {
    return {
      section: '\n\n⚠️ dbSync was an empty list, so nothing was synced. Pass `dbSync: true` to sync ' +
        'the project scope, or name the tables: `dbSync: ["CustTable"]`.',
      failed: false,
    };
  }
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
    const synced = failed ? undefined : syncedScope(result?.syncedScope);
    return { section: `\n\n${heading}\n${text}`, failed, ...(synced ? { synced } : {}) };
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
  // 'gone': the state this call waited on was collected by another call, or
  // cleared/replaced — it will never finish for THIS waiter.
  outcome: 'finished' | 'orphaned' | 'timeout' | 'gone';
  state: BuildJobState | null;
}

async function waitForBuildCompletion(
  targetModel: string,
  customPackagesPath: string,
  timeoutMs: number,
  onProgress?: ProgressReporter,
  startedAt: number = Date.now(),
  /** The job this call waits on; a state that disappears or changes job ends the wait. */
  jobId?: string,
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
    const read = await readBuildStateForWait(targetModel, customPackagesPath);
    // Two calls can wait on one build (a client gave up on the first and asked
    // again). Whichever sees it finish first consumes the state; the other used
    // to find nothing to read and poll on until its whole wait window ran out.
    // Only a state this wait has SEEN can be gone: a file never read here is no
    // evidence that anyone consumed it.
    if (lastState && (read === 'gone' || (jobId && read?.jobId && read.jobId !== jobId))) {
      return { outcome: 'gone', state: lastState };
    }
    const state = read === 'gone' ? null : read;
    if (state) {
      lastState = state;
      if (state.status !== 'running') return { outcome: 'finished', state };

      // pid 0 means a queue advance is in flight (the next model has not been
      // spawned yet) — transient, never an orphan.
      const finalizing = state.phase === 'finalizing';
      // A restart workflow finalizes for as long as its server lives (sync,
      // restart, readiness), so only the owner's death makes it an orphan.
      const settled = state.restartWorkflow
        ? buildIsLive(state)
        : !finalizing && (!state.pid || isProcessAlive(state.pid));
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

/**
 * Finished results handed to a caller by THIS process, by jobId, so a second
 * call waiting on the same build gets the same result instead of a timeout.
 * Shared, never re-rendered: rendering runs the post-build bpCheck and dbSync,
 * and those must run once per build.
 */
const deliveredResults = new Map<string, Promise<BuildToolResult>>();
const DELIVERED_RESULT_TTL_MS = 10 * 60_000;

/**
 * Registers `result` for other waiters. Call it before the state is consumed:
 * a waiter that sees the state gone looks the result up straight away.
 */
function shareDeliveredResult(state: BuildJobState, result: Promise<BuildToolResult>): Promise<BuildToolResult> {
  const jobId = state.jobId;
  if (jobId) {
    deliveredResults.set(jobId, result);
    // Kept for a while after the render FINISHES, not after it starts: a render that deploys
    // with a full sync takes about 20 minutes, and its waiters read both maps only then.
    result.catch(() => {}).finally(() => {
      setTimeout(() => {
        deliveredResults.delete(jobId);
        postBuildRanByJob.delete(jobId);
      }, DELIVERED_RESULT_TTL_MS).unref();
    });
  }
  return result;
}

/**
 * The calls of this process waiting on a build, by jobId, from when they start waiting until
 * they return. Until then one of them may render the build or run steps of its own on its result
 * (runRemainingPostBuild), reading the package's bin. buildAgainAfterRunningBuild waits for all
 * of them before a new compile rewrites bin — including a call that has not yet noticed the
 * build finished, and steps a call has not reached yet.
 */
const callsOnJob = new Map<string, Set<Promise<void>>>();

/** Registers a call waiting on `jobId`; the returned function ends that registration. */
function joinBuildJob(jobId: string | undefined): () => void {
  if (!jobId) return () => {};
  let leave!: () => void;
  const done = new Promise<void>(resolve => { leave = resolve; });
  const calls = callsOnJob.get(jobId) ?? new Set<Promise<void>>();
  callsOnJob.set(jobId, calls);
  calls.add(done);
  return () => {
    leave();
    calls.delete(done);
    if (calls.size === 0 && callsOnJob.get(jobId) === calls) callsOnJob.delete(jobId);
  };
}

/** Consumes a finished state and renders it once, sharing the result with other waiters. */
function deliverFinishedState(
  state: BuildJobState, customPackagesPath: string,
  render: () => Promise<BuildToolResult>,
): Promise<BuildToolResult> {
  return shareDeliveredResult(state, (async () => {
    await consumeFinishedState(state, customPackagesPath);
    return render();
  })());
}

/** A dbSync scope: true (the project's), a table list, or undefined when no sync. */
type SyncScope = true | string[] | undefined;

function syncScope(value: unknown): SyncScope {
  if (value === true || value === 'true') return true;
  if (Array.isArray(value)) return value.filter((t): t is string => typeof t === 'string');
  return undefined;
}

/** What a sync covered, as dbSyncTool reports it: everything, or the objects it synced. */
type SyncedScope = 'full' | string[];

function syncedScope(value: unknown): SyncedScope | undefined {
  if (value === 'full') return 'full';
  if (Array.isArray(value)) return value.filter((t): t is string => typeof t === 'string');
  return undefined;
}

function addSynced(a: SyncedScope | undefined, b: SyncedScope | undefined): SyncedScope | undefined {
  if (a === 'full' || b === 'full') return 'full';
  if (!a || !b) return a ?? b;
  return [...new Set([...a, ...b])];
}

/**
 * The part of `asked` that a run asked for `ran` did not cover. `synced` is what that run
 * actually synced, when known. `true` is the project's tables, not every table: it covers a
 * repeat of `true`, but a table list only through what it synced — without that record the
 * list is not covered, since syncing a table again is harmless and leaving it unsynced is not.
 */
function remainingSync(asked: SyncScope, ran: SyncScope, synced?: SyncedScope): SyncScope {
  if (asked === undefined || synced === 'full') return undefined;
  if (asked === true) return ran === true ? undefined : asked;
  const done = new Set((synced ?? (Array.isArray(ran) ? ran : [])).map(t => t.toLowerCase()));
  const left = asked.filter(t => !done.has(t.toLowerCase()));
  return left.length > 0 ? left : undefined;
}

type StepResult = { section: string; failed: boolean };

/** The post-build steps one render of a build ran (see renderFinishedBuildResult). */
interface PostBuildRan {
  succeeded: boolean;
  bpCheck: boolean;
  /** The sync scope — in the environment when `deploy`, else the local SyncEngine run. */
  dbSync: SyncScope;
  /** What the local syncs of this build covered, once they finished (see remainingSync). */
  dbSynced?: SyncedScope;
  deploy: boolean;
  /**
   * Steps that calls which attached to this build started after it (runRemainingPostBuild), by
   * step key: a second such call that needs the same step waits for this one rather than
   * running it again — two deployments, or two BP checks writing one report file.
   */
  started: Map<string, Promise<StepResult>>;
}

/** By jobId, for as long as the shared result is kept (shareDeliveredResult removes it). */
const postBuildRanByJob = new Map<string, PostBuildRan>();

function recordPostBuildRan(jobId: string, ran: Omit<PostBuildRan, 'started'>): void {
  postBuildRanByJob.set(jobId, { ...ran, started: new Map() });
}

/**
 * Runs the post-build steps a call asked for that the call which rendered the build did not
 * run. Only the rendering call runs post-build steps, with ITS request (merged with what the
 * build was started with), so a call that attached to the running build with other options —
 * `deploy: true` onto someone's plain build — would otherwise get the shared result without
 * them, and test code that was never deployed. Steps the render already ran are not repeated,
 * and one that another such call already started is waited for, not run again (ran.started).
 */
async function runRemainingPostBuild(
  params: any, ran: PostBuildRan, targetModel: string, logFile: string, context: any, onProgress?: ProgressReporter,
): Promise<{ section: string; failed: boolean; ranHere: string[] }> {
  const none = { section: '', failed: false, ranHere: [] as string[] };
  if (!ran.succeeded || !params) return none;
  const ranHere: string[] = [];
  let section = '';
  let failed = false;
  /** Runs the step under `key`, or joins the run another waiting call started; registered before any await. */
  const step = async (label: string, keys: string[], run: () => Promise<StepResult>) => {
    const existing = keys.map(k => ran.started.get(k)).find(Boolean);
    const result = existing ?? run();
    if (!existing) ran.started.set(keys[0], result);
    const { section: text, failed: stepFailed } = await result;
    section += text;
    failed ||= stepFailed;
    ranHere.push(existing ? `${label}, run by another call waiting on this build` : label);
  };

  if (asksFor(params.bpCheck) && !ran.bpCheck) {
    await step('bpCheck', ['bpCheck'], async () => ({
      section: await withHeartbeat(onProgress, `🔍 ${targetModel} built; running the best-practice check`,
        () => runPostBuildBpCheck(params, targetModel, context, `${logFile}.bp.txt`)),
      failed: false,
    }));
  }
  const asked = syncScope(params.dbSync);
  if (asksFor(params.deploy)) {
    // A deployment without sync does not satisfy a request for one with it; one with sync
    // satisfies both.
    if (!ran.deploy || (asked !== undefined && ran.dbSync === undefined)) {
      const withSync = asked !== undefined;
      await step(withSync ? 'deploy with dbSync' : 'deploy', withSync ? ['deploy:sync'] : ['deploy', 'deploy:sync'],
        () => runPostBuildDeploy(params, targetModel, `${logFile}.deploy.log`, onProgress));
    }
  } else {
    // A sync that ran in the environment, as part of a deployment, is not a local one.
    const left = ran.deploy ? remainingSync(asked, undefined) : remainingSync(asked, ran.dbSync, ran.dbSynced);
    if (left !== undefined) {
      await step('dbSync', [`dbSync:${JSON.stringify(left)}`], () =>
        withHeartbeat(onProgress, `🗄️ ${targetModel} built; synchronizing the database`,
          () => runPostBuildDbSync({ ...params, dbSync: left }, targetModel, context)));
    }
  }
  return { section, failed, ranHere };
}

/** What a waiter answers when the build it waited on was consumed by another call. */
async function resultCollectedElsewhere(
  jobId: string | undefined, last: BuildJobState, targetModel: string,
  params?: any, context?: any, onProgress?: ProgressReporter,
): Promise<BuildToolResult> {
  const shared = jobId ? deliveredResults.get(jobId) : undefined;
  if (shared) {
    try {
      const result = await shared;
      const ran = jobId ? postBuildRanByJob.get(jobId) : undefined;
      const extra = ran
        ? await runRemainingPostBuild(params, ran, targetModel, last.logFile, context, onProgress)
        : { section: '', failed: false, ranHere: [] as string[] };
      // No record of what the render ran: the steps only this call asked for are unknown.
      const unknown = ran ? { text: '', isError: false } : unconfirmedSteps(params, last);
      const note = 'ℹ️  Another call waiting on this build collected its result first. This is that same ' +
        'result — nothing was recompiled. Post-build steps that call ran are not repeated' +
        (extra.ranHere.length > 0 ? `; the ones only this call asked for ran now (${extra.ranHere.join(', ')}).` : '.') +
        '\n\n';
      return {
        ...result,
        content: [{ type: 'text', text: note + (result.content[0]?.text ?? '') + extra.section + unknown.text }],
        ...(result.isError || extra.failed || unknown.isError ? { isError: true } : {}),
      };
    } catch { /* say what this call knows on its own */ }
  }
  const tailLog = await readLogTail(last.logFile);
  const unknown = unconfirmedSteps(params, last);
  return {
    content: [{
      type: 'text',
      text: [
        `ℹ️  The build of ${targetModel} is no longer tracked: another call collected its result ` +
          `(possibly in another MCP server process), or the build was cleared or replaced.`,
        `Its result cannot be shown here. Call build_d365fo_project again to get a result of your own.` +
          unknown.text,
        ``,
        `--- Latest log ---`,
        tailLog,
      ].join('\n'),
    }],
    ...(unknown.isError ? { isError: true } : {}),
  };
}

/**
 * The post-build steps a call asked for that nothing confirms ran — when the build it waited on
 * was rendered by a call whose record of steps is not available here (another process). The
 * steps the build was STARTED with did run (every render merges that request); a missing
 * deploy or sync, which the next step relies on, makes the result an error.
 */
function unconfirmedSteps(params: any, last: BuildJobState): { text: string; isError: boolean } {
  const stored = last.restartWorkflow?.request ?? last.postBuildRequest;
  const asked = [
    ...(asksFor(params?.bpCheck) && !stored?.bpCheck ? ['bpCheck'] : []),
    ...(remainingSync(syncScope(params?.dbSync), syncScope(stored?.dbSync)) !== undefined ? ['dbSync'] : []),
    ...(asksFor(params?.deploy) && !(stored as PostBuildRequest | undefined)?.deploy ? ['deploy'] : []),
  ];
  if (asked.length === 0) return { text: '', isError: false };
  return {
    text: `\n\n⚠️ Not confirmed: ${asked.join(', ')}, which this call asked for, may not have run. Call ` +
      'build_d365fo_project again with them before relying on it.',
    isError: asked.some(s => s !== 'bpCheck'),
  };
}

/**
 * A build of this model is running, but its sources changed after it started, so it may not
 * compile them. Attaching would hand this call that build's result as its own — the same
 * "green for a tree nobody compiled" that finishedResultStillDescribesDisk prevents for a
 * finished build. Two compiles of one model cannot run at once, so: wait for the running build,
 * give its own callers a moment to collect it, then compile again in this call.
 *
 * The wait for the running build and the new build each get the full wait window.
 */
async function buildAgainAfterRunningBuild(
  running: BuildJobState, targetModel: string, customPackagesPath: string,
  params: any, context: any, onProgress: ProgressReporter | undefined, timeoutMs: number, startedAt: number,
): Promise<BuildToolResult> {
  await buildLog('INFO', `sources of ${targetModel} changed after the running build (PID ${running.pid}) started; ` +
    'waiting for it, then building again');
  const prior = await waitForBuildCompletion(targetModel, customPackagesPath, timeoutMs, onProgress, startedAt, running.jobId);
  if (prior.outcome === 'timeout') {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    return {
      content: [{
        type: 'text',
        text: `⏳ Model: ${targetModel} — a build that started before your latest changes is still running ` +
          `(PID: ${running.pid}, ${elapsed}s). It may not include them, so nothing has been compiled for them yet; ` +
          'this call would compile again once it finishes.\n\n' +
          `Call build_d365fo_project again (with a larger waitTimeoutMs) to wait for it and compile.`,
      }],
    };
  }
  if (prior.outcome === 'orphaned' && prior.state && !prior.state.restartWorkflow) {
    // Its process died without a result: clear it, or the next call reports that death
    // instead of compiling.
    await clearOwnedBuildState(prior.state, customPackagesPath);
  } else {
    // Let the callers waiting on the earlier build collect it (they poll every second) before
    // the next call, finding its sources out of date, clears it.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const read = await readBuildStateForWait(targetModel, customPackagesPath);
      if (read === 'gone' || (read && read.jobId !== running.jobId)) break;
      await new Promise(r => setTimeout(r, 250));
    }
  }
  // Collected means its render has only STARTED: the BP check, sync or deployment it runs, and
  // the steps other waiting calls run on its result afterwards, read the package's bin, which a
  // new compile rewrites. Wait for every call of this process on that build (callsOnJob), and
  // for its render when a call that did not wait on it collected it. Calls in other processes
  // are not known here.
  const render = running.jobId ? deliveredResults.get(running.jobId) : undefined;
  const calls = running.jobId ? [...(callsOnJob.get(running.jobId) ?? [])] : [];
  if (render || calls.length > 0) {
    await withHeartbeat(onProgress, `🔨 ${targetModel}: waiting for the earlier build's post-build steps`, async () => {
      await render?.catch(() => {});
      await Promise.allSettled(calls);
    });
  }
  const fresh = await buildProjectTool(params, context, onProgress);
  // Whatever that call did — compiled, or reported why it could not — it did it for the sources
  // as they are now.
  const note = `ℹ️  A build of ${targetModel} that started before your latest changes was running. It was left ` +
    'to finish, and this call then requested a build of the current sources:\n\n';
  return { ...fresh, content: [{ type: 'text', text: note + (fresh.content[0]?.text ?? '') }] };
}

/** One-line "what is happening right now" for a progress notification. */
function describeBuildProgress(state: BuildJobState, startedAt: number): string {
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const what = state.phase === 'finalizing'
    ? restartStageLabel(state) ?? 'finalizing (runtime metadata)'
    : state.fullBuild ? 'full build' : 'incremental';
  return `🔨 Building ${state.modelName} — ${what}, ${elapsed}s elapsed`;
}

/**
 * What a restart workflow is doing after the compile, or undefined before it.
 *
 * Those steps (best-practice check, DB sync, then the restart and up to three
 * minutes of readiness polling) all ran under "finalizing (runtime metadata)",
 * and a wait that timed out during them said the build "keeps compiling". A
 * caller whose client had given up could not tell a slow compile from an AOS
 * restart in flight — the one moment a second restartAos call must not be read
 * as a request for another restart.
 */
function restartStageLabel(state: BuildJobState): string | undefined {
  switch (state.restartWorkflow?.stage) {
    case 'prerequisites': return 'compiled; running the requested best-practice check / database sync before the AOS restart';
    case 'restarting': return 'compiled; restarting the AOS and waiting until it answers (up to 3 min)';
    default: return undefined;
  }
}

/**
 * What to do after a wait window expires. The old text ("call again to collect
 * the final result") made the follow-up poll the obvious move, which is a whole
 * extra round trip for a build that is still compiling. Name a concrete
 * waitTimeoutMs instead, so a caller that wants to keep waiting can do it in one
 * call rather than guessing a number.
 */
function renderWaitTimeoutGuidance(elapsedSec: number, timeoutMs: number, state?: BuildJobState | null): string {
  // Twice what has already elapsed, rounded up to a whole minute and never
  // below 10 — enough headroom that the next call is very unlikely to time out.
  const suggestMin = Math.max(10, Math.ceil((elapsedSec * 2) / 60));
  const stage = state && state.phase === 'finalizing' ? restartStageLabel(state) : undefined;
  return [
    stage
      ? `The build is NOT finished and nothing is lost: it ${stage.replace(/^compiled; /, 'compiled and is now ')}. ` +
        `It continues in the background, and collecting the result later does not restart the AOS again.`
      : `The build is NOT finished and nothing is lost — it keeps compiling in the background.`,
    `Waited ${elapsedSec}s of the ${Math.round(timeoutMs / 1000)}s window.`,
    `To keep waiting in a single call: build_d365fo_project { waitTimeoutMs: ${suggestMin * 60_000} }  (${suggestMin} min).`,
    `Calling again without waitTimeoutMs re-attaches to the same build — it does not start a second one.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

// Serialize admission only, not the compiler or wait window. This closes the
// force/start race with reserving a restart, including across MCP processes.
type BuildToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

export const buildProjectTool = async (params: any, context: any, reportProgress?: ProgressReporter): Promise<BuildToolResult> => {
  // One increasing progress value for the whole call: the compile wait, post-build steps and a
  // compile-again each count seconds from their own start (see monotonicProgress).
  const onProgress = reportProgress && monotonicProgress(reportProgress);
  // A deployment that cannot happen is refused before the compile, and the sign-in happens now
  // rather than after a build of several minutes. Outside the admission lock: a sign-in in the
  // browser can take minutes, and that lock holds up every build start, of every model.
  if (asksFor(params?.deploy)) {
    const refusal = await deployRefusal(params, onProgress);
    if (refusal) return { content: [{ type: 'text', text: `❌ ${refusal}` }], isError: true };
  }
  let result!: ReturnType<typeof buildProjectInternal>;
  let released = '';
  await withOperationLock('build-aos-admission', async () => {
    released = await releaseAbandonedRestartReservation();
    let release!: () => void;
    const admitted = new Promise<void>(resolve => { release = resolve; });
    result = buildProjectInternal(params, context, onProgress, release).finally(release);
    await admitted;
  });
  const response = await result;
  if (!released || !response.content[0]) return response;
  return { ...response, content: [{ ...response.content[0], text: released + response.content[0].text }, ...response.content.slice(1)] };
};

/** Why `deploy` cannot run, or undefined once the prerequisites hold and the user is signed in. */
async function deployRefusal(params: any, onProgress?: ProgressReporter): Promise<string | undefined> {
  try {
    const configManager = getConfigManager();
    await configManager.ensureLoaded();
    const { checkDeployPrerequisites, signInForDeploy } = await import('./udeDeploy.js');
    const check = await checkDeployPrerequisites(configManager, params);
    if (!check.ok) return check.message;
    return await withHeartbeat(onProgress, '🔑 Signing in to the Dataverse environment for the deployment',
      () => signInForDeploy(check.dataverse));
  } catch (error: any) {
    return `deploy could not be prepared: ${error?.message ?? error}. Nothing was built.`;
  }
}

const buildProjectInternal = async (params: any, context: any, onProgress: ProgressReporter | undefined, releaseAdmission: () => void): Promise<BuildToolResult> => {
  const dataDir: string | undefined = context?.symbolIndex?.dataDir;
  try {
    const force                 = params.force                === true;
    const fullBuild             = params.fullBuild            === true;
    // An explicit aosUrl is validated up front; without one, the local AOS's
    // web.config is read once the packages root is known (below).
    if (params.restartAos === true && params.aosUrl !== undefined) {
      let url: URL;
      try { url = new URL(params.aosUrl); } catch { throw new Error('restartAos requires an HTTP(S) aosUrl environment root.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('restartAos requires an HTTP(S) aosUrl environment root without credentials, query or fragment.');
      }
    }
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

    // restartAos without aosUrl: the root the local AOS itself serves, from the
    // web.config beside its PackagesLocalDirectory. UDE has none — explicit only.
    let aosUrl: string | undefined = params.aosUrl;
    let aosUrlSource = 'aosUrl';
    if (params.restartAos === true && aosUrl === undefined) {
      const local = await localAosUrl([microsoftPackagesPath, customPackagesPath]);
      if (!local) {
        throw new Error(
          'restartAos requires aosUrl: no AosService\\WebRoot\\web.config beside the packages folder names the local AOS ' +
          '(a UDE machine has none). Pass the environment root explicitly.',
        );
      }
      aosUrl = local.url;
      aosUrlSource = local.source;
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
    const reservation = await readRestartReservation();
    if (reservation && (reservation.owner !== restartOwner || reservation.targetModel.toLowerCase() !== targetModel.toLowerCase() ||
      !samePath(reservation.customPackagesPath, customPackagesPath) || reservation.jobId !== existingState?.jobId || force || fullBuild ||
      existingState?.restartWorkflow?.stage === 'uncertain')) {
      return {
        content: [{ type: 'text', text: `⚠️ AOS restart workflow is active or uncertain; new/forced builds are blocked. ${existingState?.restartWorkflow?.result?.message ?? ''} Inspect ${restartReservationPath} and the environment before recovery. No restart or sync was replayed.` }],
        isError: true,
      };
    }

    if (existingState && !force) {
      // fullBuild:true is a request to RECOMPILE, not a request for the newest
      // available result — so a FINISHED state can never satisfy it, not even a
      // finished full build. Discard it and compile for real. (#829: an explicit
      // {fullBuild:true} came back as "Collected the result of the build that
      // ended 19:27:58 … nothing was recompiled by this call".)
      // A delivered restart result is kept only for a re-issued restartAos
      // request; anything else gets what a plain build gives after its result
      // was collected — a fresh compile.
      const fullBuildNeedsFreshRun = existingState.status !== 'running' &&
        (fullBuild || (params.restartAos === true && !existingState.restartWorkflow) ||
          (!!existingState.resultDelivered && params.restartAos !== true));
      if (fullBuildNeedsFreshRun) {
        await buildLog('INFO', `discarding finished state for ${targetModel} and recompiling`);
        await clearBuildState(targetModel, customPackagesPath);
        // intentional fall-through to "start new build" below
      } else {

      // A 'finalizing' state has no live PID by definition — xppc exited and the
      // close handler is still doing post-build work — but it is very much a
      // running build, not an orphan.
      const alive   = existingState.restartWorkflow
        ? buildIsLive(existingState)
        : existingState.phase === 'finalizing' || isProcessAlive(existingState.pid);
      const logTail = await readLogTail(existingState.logFile);

      if (existingState.status === 'running' && alive) {
        if (params.restartAos === true && !existingState.restartWorkflow) {
          return { content: [{ type: 'text', text: '⚠️ AOS restart was not requested when this build started. Wait for it to finish, then start a new build with restartAos:true.' }], isError: true };
        }
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
        const modelLine = `Model: ${existingState.modelName}`;
        // When wait:true (default) and a build is already running for this
        // model, attach to it and block until completion instead of returning
        // a snapshot — this matches the "single call per build" contract.
        const waitForFinish = params.wait !== false;
        if (waitForFinish) {
          // The scan reads the whole model tree: not while holding admission, which every
          // build start of every model waits on.
          releaseAdmission();
          // Sources changed since that build started: its result would not be this call's.
          // Measured from the start, as for a finished build: xppc reads sources during the compile.
          const sourcesAt = new Date(existingState.sourcesAsOf ?? existingState.startTime).getTime();
          const sources = Number.isFinite(sourcesAt)
            ? await scanSourceChanges(path.join(customPackagesPath, targetModel), sourcesAt)
            : 'unknown';
          const timeoutMs = resolveWaitTimeoutMs(params);
          // A malformed startTime must not leak NaN into a progress payload.
          const stateStartedAt = new Date(existingState.startTime).getTime();
          const startedAt = Number.isFinite(stateStartedAt) ? stateStartedAt : Date.now();
          if (sources === 'changed') {
            return await buildAgainAfterRunningBuild(
              existingState, targetModel, customPackagesPath, params, context, onProgress, timeoutMs, startedAt,
            );
          }
          // Could not tell (the scan ran out of time while xppc loads the disk, or a folder could
          // not be read): compiling again would double a large model's build on a guess, so attach,
          // and say the result may not cover edits made after that build started.
          const attachNote = sources === 'unknown'
            ? `ℹ️  A build of ${targetModel} started at ${existingState.startTime} was already running, and whether ` +
              'its sources changed since could not be checked in time. This is that build\'s result: build again if ' +
              'you edited files after it started.\n\n'
            : '';
          const withAttachNote = (result: BuildToolResult): BuildToolResult => attachNote
            ? { ...result, content: [{ type: 'text', text: attachNote + (result.content[0]?.text ?? '') }] }
            : result;
          const leaveJob = joinBuildJob(existingState.jobId);
          try {
            const wait = await waitForBuildCompletion(
              targetModel, customPackagesPath, timeoutMs, onProgress, startedAt, existingState.jobId,
            );
            if (wait.outcome === 'finished' && wait.state) {
              const finished = wait.state;
              return withAttachNote(await deliverFinishedState(finished, customPackagesPath,
                () => renderFinishedBuildResult(finished, targetModel, dataDir, params, context, onProgress)));
            }
            if (wait.outcome === 'gone') {
              return withAttachNote(await resultCollectedElsewhere(
                existingState.jobId, wait.state ?? existingState, targetModel, params, context, onProgress));
            }
            const tailLog = await readLogTail(existingState.logFile);
            if (wait.outcome === 'orphaned') {
              if (wait.state && !wait.state.restartWorkflow) await clearOwnedBuildState(wait.state, customPackagesPath);
              return {
                content: [{
                  type: 'text',
                  text: `❌ Build process (PID: ${existingState.pid}) disappeared without reporting a result.\n\nModel: ${targetModel}\n\nRe-run with force: true to start a clean build.\n\n--- Log ---\n${tailLog}`,
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
                  `⏳ ${modelLine} (PID: ${existingState.pid}, running ${elapsed}s; wait timeout reached)\n\n` +
                  renderWaitTimeoutGuidance(elapsed, timeoutMs, wait.state) + '\n\n' +
                  `--- Latest log ---\n${tailLog}`,
              }],
            };
          } finally {
            leaveJob();
          }
        }
        return {
          content: [{
            type: 'text',
            text: `⏳ ${modelLine} (PID: ${existingState.pid}, running ${elapsed}s)` +
              (existingState.phase === 'finalizing' && restartStageLabel(existingState) ? `\nNow: ${restartStageLabel(existingState)}` : '') +
              `\n\nCall again to refresh.\n\n--- Latest log ---\n${logTail}`,
          }],
        };
      }

      if (existingState.status === 'running' && !alive) {
        // The close handler needs admission to publish finalizing. Never hold
        // it while waiting for that handler to settle.
        releaseAdmission();
        // Process has exited but the async close handler may still be writing the final state.
        // Wait up to 2 s for it to settle.
        for (let i = 0; i < 4; i++) {
          await new Promise(resolve => setTimeout(resolve, 500));
          const refreshed = await readBuildState(targetModel, customPackagesPath);
          // A dead restart workflow stays 'finalizing' forever; re-entering on
          // that phase would recurse without end.
          if (refreshed && (refreshed.jobId !== existingState.jobId || refreshed.status !== 'running' ||
            (refreshed.phase === 'finalizing' && !refreshed.restartWorkflow))) {
            return buildProjectTool(params, context, onProgress);
          }
        }
        // A restart state is left for releaseAbandonedRestartReservation: only
        // its stage can say whether the AOS may already have been restarted.
        if (!existingState.restartWorkflow) await clearOwnedBuildState(existingState, customPackagesPath);
        return {
          content: [{
            type: 'text',
            text: `❌ Build process (PID: ${existingState.pid}) exited unexpectedly without reporting a result.\n\nModel: ${targetModel}\n\n--- Log ---\n${logTail}`,
          }],
          isError: true,
        };
      }

      // Build finished. It may be this caller collecting the result they were
      // handed off ("call again to collect"), or a fresh build request that
      // merely arrived after an old state file. Only the disk can tell them
      // apart: if sources changed since the build started, the cached result
      // describes a tree that no longer exists and must not be replayed as
      // this call's success.
      const stillCurrent = await finishedResultStillDescribesDisk(
        existingState, targetModel, customPackagesPath,
      );
      if (!stillCurrent) await clearBuildState(targetModel, customPackagesPath);
      if (stillCurrent) {
        // Admission is still held here, so write directly rather than through
        // consumeFinishedState, which takes it.
        if (existingState.restartWorkflow && !existingState.resultDelivered) {
          await writeBuildState({ ...existingState, resultDelivered: true }, customPackagesPath);
        }
        // Shared before the state is cleared: a call still waiting on this
        // build finds the result the moment it sees the state gone.
        const result = await shareDeliveredResult(existingState, (async () => {
          if (!existingState.restartWorkflow) await clearBuildState(targetModel, customPackagesPath);
          releaseAdmission();
          return renderFinishedBuildResult(existingState, targetModel, dataDir, params, context, onProgress);
        })());
        // Say plainly that nothing was compiled just now, so a reader can never
        // mistake a collected result for a fresh one.
        const collected =
          `ℹ️  Collected the result of the build that ended ${existingState.endTime} ` +
          `(no source changes since it started — nothing was recompiled by this call).\n\n`;
        return {
          ...result,
          content: [{ type: 'text', text: collected + (result.content[0]?.text ?? '') }],
        };
      }
      // Sources moved on — fall through and build for real.
      await buildLog(
        'WARN',
        `discarding finished build state for ${targetModel}: sources changed after ${existingState.sourcesAsOf ?? existingState.startTime}`,
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

    // Only the target model is compiled: rebuilding referenced models dragged in
    // every custom/ISV dependency on each build for no benefit, so dependencies
    // are expected to be compiled already. A buildReferencedModels argument from
    // an older client is ignored (#1122).
    const jobLogFile = logFilePath(targetModel, customPackagesPath);

    // ------------------------------------------------------------------
    // Build context (shared across the entire queue)
    // ------------------------------------------------------------------
    const ctx: XppcBuildContext = {
      toolContext: context,
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
    await buildLog('INFO', `Starting build — model: ${targetModel} | fullBuild: ${fullBuild}`);
    await buildLog('INFO', `  xppc.exe:              ${ctx.xppcExe}`);
    await buildLog('INFO', `  customPackagesPath:    ${ctx.customPackagesPath}`);
    await buildLog('INFO', `  microsoftPackagesPath: ${ctx.microsoftPackagesPath}`);
    await buildLog('INFO', `  compilerMetadataPath:  ${ctx.compilerMetadataPath} (xppc write-back target)`);
    if (ctx.extraReferenceFolders.length > 0) {
      await buildLog('INFO', `  extraReferenceFolders: ${ctx.extraReferenceFolders.join(', ')}`);
    }
    if (params.restartAos === true) {
      await buildLog('INFO', `  restartAos:            ${aosUrl} (from ${aosUrlSource})`);
    }

    // ------------------------------------------------------------------
    // Initial state
    // ------------------------------------------------------------------
    const jobStartedAt = new Date().toISOString();
    const initState: BuildJobState = {
      jobId: crypto.randomUUID(),
      ownerPid: process.pid,
      ...(params.restartAos === true ? { restartWorkflow: {
        request: {
          aosUrl: aosUrl!,
          aosUrlSource,
          bpCheck: params.bpCheck === true || params.bpCheck === 'true',
          dbSync: Array.isArray(params.dbSync) ? [...params.dbSync] : params.dbSync === true || params.dbSync === 'true',
          projectPath: params.projectPath,
          packagePath: params.packagePath,
        },
        stage: 'pending' as const,
      } } : {}),
      pid: 0,             // updated by spawnXppcForState
      modelName: targetModel,
      targetModel,
      tool: 'xppc.exe',
      startTime: jobStartedAt,
      sourcesAsOf: jobStartedAt,
      ...(params.restartAos !== true && (asksFor(params.bpCheck) || params.dbSync === 'true' || params.dbSync === true || Array.isArray(params.dbSync) || asksFor(params.deploy))
        ? { postBuildRequest: {
            bpCheck: asksFor(params.bpCheck),
            dbSync: Array.isArray(params.dbSync) ? [...params.dbSync] : asksFor(params.dbSync),
            deploy: asksFor(params.deploy),
            projectPath: params.projectPath,
            packagePath: params.packagePath,
          } }
        : {}),
      logFile: jobLogFile,
      status: 'running',
      fullBuild,
    };

    if (initState.restartWorkflow) {
      // A build admitted earlier may still be changing assemblies/metadata on
      // this host. The reservation stops later starts; this check covers the
      // opposite admission order, using the existing durable job records.
      for (const name of await readdir(os.tmpdir())) {
        if (!/^d365build_state_[a-f0-9]+\.json$/.test(name)) continue;
        const tracked = await readTrackedBuildState(path.join(os.tmpdir(), name));
        // Unreadable, or a 'running' record nothing will ever finish (its xppc
        // and its server are gone): neither is changing this host any more, and
        // blocking on them would block every restart until someone cleans up.
        if (!tracked || tracked.status !== 'running' || !buildIsLive(tracked)) continue;
        throw new Error(`AOS restart blocked: tracked build ${tracked.targetModel ?? tracked.modelName} is still running or finalizing. Collect or recover that build before retrying.`);
      }
      await writeFile(restartReservationPath, JSON.stringify({
        jobId: initState.jobId!, targetModel, customPackagesPath, owner: restartOwner, ownerPid: process.pid,
      } satisfies RestartReservation), { encoding: 'utf-8', flag: 'wx' });
    }
    let pid: number;
    try {
      await writeBuildState(initState, customPackagesPath);
      pid = await spawnXppcForState(ctx, initState);
    } catch (error) {
      // Nothing was spawned, so nothing will ever finish this job: a 'running'
      // state and a restart reservation left behind would hold every later
      // build (of every model, for the reservation) until the server restarts.
      // Admission is still held here: clear directly, not via clearOwnedBuildState.
      if (await ownsBuild(initState, customPackagesPath).catch(() => false)) {
        await clearBuildState(targetModel, customPackagesPath);
      }
      if (initState.restartWorkflow) {
        const reservation = await readRestartReservation().catch(() => null);
        if (reservation && reservation.jobId === initState.jobId && reservation.owner === restartOwner) {
          await unlink(restartReservationPath).catch(() => {});
        }
      }
      throw error;
    }
    releaseAdmission();

    // ------------------------------------------------------------------
    // Return "build started" message OR wait for completion
    // ------------------------------------------------------------------
    // initState, not fullBuild: the launch may already have switched it to a full build.
    const modeLabel = initState.fullBuild ? 'Full build' : 'Incremental build';

    // wait defaults to true — single call returns the final result. When the
    // caller passes wait:false explicitly we keep the legacy fire-and-forget
    // behaviour for compatibility with callers that intentionally poll.
    const waitForFinish = params.wait !== false;

    if (waitForFinish) {
      const timeoutMs = resolveWaitTimeoutMs(params);
      const startedAt = new Date(initState.startTime).getTime();
      // Registered for the job while it waits: see callsOnJob.
      const leaveJob = joinBuildJob(initState.jobId);
      try {
        const wait = await waitForBuildCompletion(
          targetModel, customPackagesPath, timeoutMs, onProgress, startedAt, initState.jobId,
        );
        if (wait.outcome === 'finished' && wait.state) {
          const finished = wait.state;
          return await deliverFinishedState(finished, customPackagesPath,
            () => renderFinishedBuildResult(finished, targetModel, dataDir, params, context, onProgress));
        }
        if (wait.outcome === 'gone') {
          return await resultCollectedElsewhere(initState.jobId, wait.state ?? initState, targetModel, params, context, onProgress);
        }
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        const tailLog = await readLogTail(wait.state?.logFile ?? jobLogFile);
        if (wait.outcome === 'orphaned') {
          if (wait.state && !wait.state.restartWorkflow) await clearOwnedBuildState(wait.state, customPackagesPath);
          return {
            content: [{
              type: 'text',
              text: [
                `❌ ${modeLabel} process (PID: ${pid}) disappeared after ${elapsed}s without reporting a result.`,
                ``,
                `Target: ${targetModel}`,
                `Log:    ${jobLogFile}`,
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
              `Target: ${targetModel}`,
              `Log:    ${jobLogFile}`,
              ``,
              renderWaitTimeoutGuidance(elapsed, timeoutMs, wait.state),
              ``,
              `--- Latest log ---`,
              tailLog,
            ].join('\n'),
          }],
        };
      } finally {
        leaveJob();
      }
    }

    // Legacy fire-and-forget mode: return immediately after spawning.
    return {
      content: [{
        type: 'text',
        text: [
          `🔨 ${modeLabel} started (xppc.exe PID: ${pid})`,
          ``,
          `Target: ${targetModel}`,
          `Log:    ${jobLogFile}`,
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
