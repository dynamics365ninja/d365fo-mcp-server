import { z } from 'zod';
import { execFile, spawn } from 'child_process';
import util from 'util';
import path from 'path';
import { access, writeFile, readFile, unlink, appendFile, readdir } from 'fs/promises';
import { openSync as openSyncFs, closeSync as closeSyncFs } from 'fs';
import os from 'os';
import crypto from 'crypto';
import { getConfigManager } from '../utils/configManager.js';
import { forceReleaseLock } from '../utils/operationLocks.js';
import { lookupErrorFix } from './d365foErrorHelp.js';

const execFileAsync = util.promisify(execFile);

// ---------------------------------------------------------------------------
// Build-tool file logger
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

function assertSafePath(value: string, label: string): void {
  if (/[&|<>^`!;$%"'\n\r]/.test(value)) {
    throw new Error(
      `${label} contains potentially dangerous characters and cannot be used in a build command: ${value}`
    );
  }
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

// xppc.exe writes this prefix on error lines in the -log file (standalone/non-VS mode)
const XPPC_COMPILE_ERROR_RE = /^Compile Error:/m;

// When xppc reports stale symbols from a previous incremental build, a full build is needed
const XPPC_STALE_SYMBOL_RE = /has not been successfully compiled since it was last changed|Do a Full Build/i;

// ---------------------------------------------------------------------------
// Structured compiler diagnostics
// xppc -log lines have the form (observed in standalone/UDE mode):
//   Compile Error: Class Method dynamics://MyModel/MyClass/myMethod: [(28,27),(28,28)]: ';' expected.
// i.e.  <severity>: <element kind> dynamics://<model>/<object>[/<member>]: [(line,col)[,(line,col)]]: <message>
// ---------------------------------------------------------------------------

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

const XPPC_DIAG_LINE_RE =
  /^(Compile Fatal Error|Compile Error|Compile Warning|Generation Warning|Best Practice Warning):\s*(?:(.*?)\s+)?dynamics:\/\/([^/\s:]+)\/([^/\s:]+)(?:\/([^\s:]+))?\s*:?\s*\[\((\d+),(\d+)\)(?:,\(\d+,\d+\))?\]\s*:\s*(.*)$/;

/** Parse xppc log content into structured diagnostics. */
export function parseXppcDiagnostics(logContent: string): XppcDiagnostic[] {
  const diagnostics: XppcDiagnostic[] = [];
  for (const rawLine of logContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = XPPC_DIAG_LINE_RE.exec(line);
    if (m) {
      diagnostics.push({
        severity: m[1].includes('Error') ? 'error' : 'warning',
        kind: m[2] || undefined,
        model: m[3],
        object: m[4],
        member: m[5] || undefined,
        line: Number(m[6]),
        column: Number(m[7]),
        message: m[8].trim(),
      });
      continue;
    }
    // Fallback: severity prefix without the dynamics:// location part
    const simple = /^(Compile Fatal Error|Compile Error|Compile Warning|Generation Warning):\s*(.+)$/.exec(line);
    if (simple) {
      diagnostics.push({
        severity: simple[1].includes('Error') ? 'error' : 'warning',
        message: simple[2].trim(),
      });
    }
  }
  return diagnostics;
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
    lines.push('Fix the errors with modify_d365fo_file (use the object/line references above), then rebuild.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Build job state
// ---------------------------------------------------------------------------

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
  exitCode?: number;
  endTime?: string;
  fullBuild?: boolean;
  // Multi-model queue (only set when buildReferencedModels: true)
  buildQueue?: string[];        // All models in topological order (deps first, target last)
  queueIndex?: number;          // Index into buildQueue for the currently-building model
  queueResults?: QueueResult[]; // Results for already-completed models in the queue
}

// ---------------------------------------------------------------------------
// State file / log file paths
// State file is keyed by targetModel so it remains findable throughout
// a multi-model build even while a dependency is building.
// Each model in the queue gets its own log file (keyed by targetModel + index).
// ---------------------------------------------------------------------------

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

// Return the last N lines of a log file (used while a build is running).
async function readLogTail(logFile: string, lines = 60): Promise<string> {
  try {
    const content = await readFile(logFile, 'utf-8');
    const all = content.split(/\r?\n/);
    return all.slice(-lines).join('\n').trim();
  } catch {
    return '(log not yet available)';
  }
}

// Read the entire log without truncation — used for diagnostics parsing only.
async function readWholeLog(logFile: string): Promise<string> {
  try {
    return await readFile(logFile, 'utf-8');
  } catch {
    return '';
  }
}

// Return up to maxLines of a log file, showing head+tail when truncated.
// Used when reporting a failed build so the full diagnostic context is visible.
async function readFullLog(logFile: string, maxLines = 300): Promise<string> {
  try {
    const content = await readFile(logFile, 'utf-8');
    const all = content.split(/\r?\n/);
    if (all.length <= maxLines) return content.trim();
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

// ---------------------------------------------------------------------------
// Parse model name from .rnrproj XML
// ---------------------------------------------------------------------------

async function getModelFromRnrproj(projectPath: string): Promise<string | null> {
  try {
    const content = await readFile(projectPath, 'utf-8');
    const match = content.match(/<Model>\s*([^<]+)\s*<\/Model>/i);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Locate xppc.exe
// ---------------------------------------------------------------------------

async function findXppcExe(microsoftPackagesPath: string | null): Promise<string | null> {
  const candidates: string[] = [];

  if (microsoftPackagesPath) {
    candidates.push(path.join(microsoftPackagesPath, 'bin', 'xppc.exe'));
  }

  // Search AppData for any installed UDE version
  const appDataLocal = process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local');
  const d365Base = path.join(appDataLocal, 'Microsoft', 'Dynamics365');
  try {
    const versions = await readdir(d365Base);
    for (const ver of versions.sort().reverse()) {
      candidates.push(path.join(d365Base, ver, 'PackagesLocalDirectory', 'bin', 'xppc.exe'));
    }
  } catch { /* ignore */ }

  // CHE well-known locations
  candidates.push(
    'C:\\AOSService\\PackagesLocalDirectory\\bin\\xppc.exe',
    'K:\\AOSService\\PackagesLocalDirectory\\bin\\xppc.exe',
    'J:\\AOSService\\PackagesLocalDirectory\\bin\\xppc.exe',
    'I:\\AOSService\\PackagesLocalDirectory\\bin\\xppc.exe',
  );

  for (const c of candidates) {
    try { await access(c); return c; } catch { /* next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dependency resolution
// Reads <ModuleReferences> from the target model's descriptor, recursively
// follows custom/ISV dependencies (models present in customPackagesPath),
// and returns a topologically sorted build order (deepest dep first, target
// last). Microsoft standard models (only in microsoftPackagesPath) are
// silently skipped.
// ---------------------------------------------------------------------------

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

    // Read descriptor
    const descriptorPath = path.join(customPackagesPath, modelName, 'Descriptor', `${modelName}.xml`);
    let content: string;
    try {
      content = await readFile(descriptorPath, 'utf-8');
    } catch {
      // No descriptor — still include this model but can't follow its deps
      order.push(modelName);
      return;
    }

    // Extract all <d2p1:string> entries inside <ModuleReferences>
    const refs = Array.from(content.matchAll(/<d2p1:string>\s*([^<\s]+)\s*<\/d2p1:string>/g))
      .map(m => m[1].trim())
      .filter(Boolean);

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

// ---------------------------------------------------------------------------
// Kill orphaned build processes
// ---------------------------------------------------------------------------

async function killOrphanedBuildProcesses(): Promise<void> {
  await execFileAsync('taskkill', ['/F', '/IM', 'xppc.exe'], { timeout: 10_000, windowsHide: true })
    .then(({ stdout }) => console.error(`[build_d365fo_project] killed xppc.exe: ${stdout.trim() || '(no output)'}`))
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Build context — passed through the entire queue so the close handler can
// launch the next model without re-resolving paths.
// ---------------------------------------------------------------------------

interface XppcBuildContext {
  xppcExe: string;
  customPackagesPath: string;
  microsoftPackagesPath: string;
  extraReferenceFolders: string[];
}

// ---------------------------------------------------------------------------
// Core spawn — queue-aware
// Spawns xppc.exe for state.modelName, writes the updated state (with real
// PID) to disk, and wires up close/error handlers. The close handler
// automatically advances the queue when a dependency finishes successfully.
// Returns the PID of the spawned process.
// ---------------------------------------------------------------------------

async function spawnXppcForState(ctx: XppcBuildContext, state: BuildJobState): Promise<number> {
  const { xppcExe, customPackagesPath, microsoftPackagesPath, extraReferenceFolders } = ctx;
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

  const outputPath = path.join(customPackagesPath, modelName, 'bin');
  const xppcErrLog = state.logFile.replace('.log', '.xppc.err');

  // Clear stale diagnostic files from a previous run
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
    `-compilermetadata=${microsoftPackagesPath}`,
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

  const logFd = openSyncFs(state.logFile, 'w');

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

    // Read the -log file (authoritative source of X++ compiler errors)
    let xppcErrContent = '';
    try {
      xppcErrContent = await readFile(xppcErrLog, 'utf-8');
    } catch { /* no -log file = no diagnostics */ }

    const hasCompileErrors = XPPC_COMPILE_ERROR_RE.test(xppcErrContent);
    const hasStaleSymbol   = XPPC_STALE_SYMBOL_RE.test(xppcErrContent);
    // A build succeeds only when xppc exits 0 AND the -log has no Compile Error lines.
    // xppc may exit 0 even when it emits errors (observed in UDE standalone mode).
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

export const buildProjectToolDefinition = {
  name: 'build_d365fo_project',
  description: [
    'Builds a D365FO model using the X++ compiler (xppc.exe) and returns compiler errors.',
    'Compiles the entire model — equivalent to building the full model in Visual Studio.',
    'By default the tool waits for the build to finish before returning, so call it ONCE per request',
    '(do NOT poll — a single call returns the final success/failure result).',
    'Set wait:false for fire-and-forget mode where the tool returns immediately after spawning the build',
    'and subsequent calls report current status (legacy behaviour).',
    'Use force:true to kill a stuck build and restart.',
    'Use fullBuild:true to omit -incremental and recompile all elements — fixes "stale symbol" errors.',
    'Use buildReferencedModels:true to also build custom/ISV dependencies before the target model',
    '(reads ModuleReferences from the model descriptor; skips Microsoft standard models; builds in topological order).',
  ].join(' '),
  parameters: z.object({
    modelName: z.string().optional().describe(
      'D365FO model name to build (e.g. MyCustomModel). Auto-detected from workspace if omitted.',
    ),
    projectPath: z.string().optional().describe(
      '(Legacy) Absolute path to a .rnrproj file — used only to extract the model name when modelName is not provided.',
    ),
    force: z.boolean().optional().describe(
      'Kill any running build processes for this model and restart.',
    ),
    fullBuild: z.boolean().optional().describe(
      'Full recompile of the TARGET model only: omits -incremental so xppc recompiles all elements. ' +
      'When buildReferencedModels is also set, dependency models still run incremental. ' +
      'Use when xppc reports "model element has not been successfully compiled since it was last changed".',
    ),
    buildReferencedModels: z.boolean().optional().describe(
      'Before building the target model, also build all custom/ISV models it depends on ' +
      '(from <ModuleReferences> in the model descriptor). ' +
      'Skips Microsoft standard models. Builds in topological dependency order.',
    ),
    wait: z.boolean().optional().default(true).describe(
      'When true (default), the tool BLOCKS until the build finishes and returns the final result in a single call. ' +
      'Do not call again to poll — the agent should make exactly one tool call per requested build. ' +
      'When false, the tool returns immediately after spawning xppc and the caller is responsible for polling ' +
      'with a follow-up call (legacy fire-and-forget behaviour).',
    ),
    waitTimeoutMs: z.number().int().positive().optional().describe(
      'Maximum time (ms) to block when wait:true before returning a "still running" snapshot. ' +
      'Defaults to 30 minutes. The build itself continues in the background; subsequent calls will pick up the result.',
    ),
  }),
};

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
    const logContent = succeeded
      ? await readLogTail(relevantLogFile)
      : await readFullLog(relevantLogFile);
    const structured = succeeded
      ? ''
      : formatStructuredDiagnostics(parseXppcDiagnostics(await readWholeLog(relevantLogFile)));

    return {
      content: [{
        type: 'text',
        text: `${statusIcon} — ${allResults.length} models, ${totalDuration}s total\n\n${modelLines}\n\n` +
          (structured ? `${structured}\n\n` : '') +
          `--- Log (${relevantResult?.modelName ?? targetModel}) ---\n${logContent}`,
      }],
      ...(succeeded ? {} : { isError: true }),
    };
  }

  const logTail       = await readLogTail(finalState.logFile);
  const logContent    = succeeded ? logTail : await readFullLog(finalState.logFile);
  const hasWarnings   = succeeded && /^(Generation Warning|Compile Warning):/m.test(logTail);
  const statusIcon    = !succeeded ? '❌ Build FAILED' : hasWarnings ? '⚠️ Build succeeded with warnings' : '✅ Build succeeded';
  const buildMode     = finalState.fullBuild ? 'full build (target), incremental (deps)' : 'incremental';
  const duration      = finalState.endTime
    ? Math.round((new Date(finalState.endTime).getTime() - new Date(finalState.startTime).getTime()) / 1000)
    : '?';
  const structured    = succeeded
    ? ''
    : formatStructuredDiagnostics(parseXppcDiagnostics(await readWholeLog(finalState.logFile)));

  return {
    content: [{
      type: 'text',
      text: `${statusIcon} (${finalState.tool}, ${buildMode}, ${duration}s)\n\nModel: ${targetModel}\n\n` +
        (structured ? `${structured}\n\n--- Raw log ---\n` : '') +
        `${logContent || '(no output)'}`,
    }],
    ...((!succeeded) ? { isError: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Block until the build for `targetModel` reaches a non-running state, the
// tracked process is no longer alive, or `timeoutMs` elapses. Returns the
// final state when finished, or null when the timeout was hit.
// ---------------------------------------------------------------------------

async function waitForBuildCompletion(
  targetModel: string,
  customPackagesPath: string,
  timeoutMs: number,
): Promise<BuildJobState | null> {
  const deadline = Date.now() + timeoutMs;
  // Poll roughly every second; xppc builds typically take many seconds to
  // many minutes, so a 1 s cadence is fine and keeps responsiveness high.
  const pollIntervalMs = 1000;
  let lastState: BuildJobState | null = null;
  while (Date.now() < deadline) {
    const state = await readBuildState(targetModel, customPackagesPath);
    if (state) {
      lastState = state;
      if (state.status !== 'running') return state;
      // Process disappeared without writing a final state — give the close
      // handler up to ~2 s to settle, then return whatever we have so the
      // caller can surface a sensible "exited unexpectedly" message.
      if (state.pid && !isProcessAlive(state.pid)) {
        for (let i = 0; i < 4; i++) {
          await new Promise(r => setTimeout(r, 500));
          const refreshed = await readBuildState(targetModel, customPackagesPath);
          if (refreshed && refreshed.status !== 'running') return refreshed;
        }
        return state;
      }
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  // Timed out — return null so the caller emits a "still running" snapshot.
  return lastState && lastState.status !== 'running' ? lastState : null;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export const buildProjectTool = async (params: any, _context: any) => {
  try {
    const force                 = params.force                === true;
    const fullBuild             = params.fullBuild            === true;
    const buildReferencedModels = params.buildReferencedModels === true;

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

    // Priority 3: CHE fallback — probe well-known PackagesLocalDirectory locations
    if (!microsoftPackagesPath) {
      for (const candidate of [
        'C:\\AOSService\\PackagesLocalDirectory',
        'K:\\AOSService\\PackagesLocalDirectory',
        'J:\\AOSService\\PackagesLocalDirectory',
        'I:\\AOSService\\PackagesLocalDirectory',
      ]) {
        try { await access(candidate); microsoftPackagesPath = candidate; break; } catch { /* next */ }
      }
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
            `For CHE: ensure PackagesLocalDirectory exists at C:\\AOSService\\PackagesLocalDirectory (or K:\\, J:\\, I:\\)`,
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
      // If the caller requests a DIFFERENT build mode than what's cached (e.g. incremental → fullBuild),
      // and the build is not currently running, discard the stale cached state and fall through
      // to start a fresh build with the requested mode.
      const buildModeChanged = existingState.status !== 'running' && fullBuild && !existingState.fullBuild;
      if (buildModeChanged) {
        await clearBuildState(targetModel, customPackagesPath);
        // intentional fall-through to "start new build" below
      } else {

      const alive   = isProcessAlive(existingState.pid);
      const logTail = await readLogTail(existingState.logFile);

      if (existingState.status === 'running' && alive) {
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
          const timeoutMs: number = (typeof params.waitTimeoutMs === 'number' && params.waitTimeoutMs > 0)
            ? params.waitTimeoutMs
            : 30 * 60 * 1000;
          const finalState = await waitForBuildCompletion(targetModel, customPackagesPath, timeoutMs);
          if (finalState && finalState.status !== 'running') {
            await clearBuildState(targetModel, customPackagesPath);
            return await renderFinishedBuildResult(finalState, targetModel);
          }
          // Timed out — emit a "still running" snapshot so the caller can choose
          // to extend the wait window with another call.
          const tailLog = await readLogTail(existingState.logFile);
          return {
            content: [{
              type: 'text',
              text:
                `⏳ ${queueProgress} (PID: ${existingState.pid}, running ${elapsed}s; wait timeout reached)${completedLine}\n\n` +
                `Build continues in background. Call again to collect the final result, ` +
                `or pass waitTimeoutMs to extend the wait window.\n\n` +
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

      // Build finished — return result and clear state
      await clearBuildState(targetModel, customPackagesPath);
      return await renderFinishedBuildResult(existingState, targetModel);
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
    // Log build parameters
    // ------------------------------------------------------------------
    await buildLog('INFO', `Starting build — model: ${targetModel} | fullBuild: ${fullBuild} | queue: ${buildQueue.length}`);
    await buildLog('INFO', `  xppc.exe:              ${xppcExe}`);
    await buildLog('INFO', `  customPackagesPath:    ${customPackagesPath}`);
    await buildLog('INFO', `  microsoftPackagesPath: ${microsoftPackagesPath}`);
    if (extraReferenceFolders.length > 0) {
      await buildLog('INFO', `  extraReferenceFolders: ${extraReferenceFolders.join(', ')}`);
    }

    // ------------------------------------------------------------------
    // Build context (shared across the entire queue)
    // ------------------------------------------------------------------
    const ctx: XppcBuildContext = {
      xppcExe,
      customPackagesPath,
      microsoftPackagesPath,
      extraReferenceFolders,
    };

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
      const timeoutMs: number = (typeof params.waitTimeoutMs === 'number' && params.waitTimeoutMs > 0)
        ? params.waitTimeoutMs
        : 30 * 60 * 1000; // 30 minutes default — covers full builds with referenced models
      const finalState = await waitForBuildCompletion(targetModel, customPackagesPath, timeoutMs);
      if (finalState && finalState.status !== 'running') {
        await clearBuildState(targetModel, customPackagesPath);
        return await renderFinishedBuildResult(finalState, targetModel);
      }
      // Timed out — leave the build running so a follow-up call can collect it.
      const elapsed = Math.round((Date.now() - new Date(initState.startTime).getTime()) / 1000);
      const tailLog = await readLogTail(firstLogFile);
      return {
        content: [{
          type: 'text',
          text: [
            `⏳ ${modeLabel} still running after ${elapsed}s (timeout reached, build continues in background)`,
            ``,
            `Target: ${targetModel}${queueDetail}`,
            `Log:    ${firstLogFile}`,
            ``,
            `Call **build_d365fo_project** again to collect the final result. ` +
            `Or pass waitTimeoutMs to extend the wait window in a single call.`,
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
