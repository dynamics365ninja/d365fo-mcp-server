import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { Parser } from 'xml2js';
import { getConfigManager } from '../utils/configManager.js';
import { withOperationLock } from '../utils/operationLocks.js';
import { lookupSymbolNocase, type DbLike } from '../utils/symbolLookup.js';

/**
 * AOT folders that map to syncable DB objects, and what kind of object each one
 * holds.
 *
 * There is NO separate view list: SyncEngine takes tables and views in the same
 * `-synclist`, which it reports back as `TableOrViewList`. `-viewlist` is not a
 * SyncEngine argument at all — passing it prints
 *
 *     Invalid argument -viewlist=<names> specified
 *
 * and the run CONTINUES with those names silently dropped, so a requested view
 * was never synced and nothing failed. Verified 2026-07-22 against SyncEngine
 * 7.0.30743 / platform 7.0.7858.27 on the dev VM; the parameter dump lists
 * TableOrViewList, DropTableOrViewList, TableExtensionList, CompositeEntityList
 * and ADEsList, and no view list of any kind. The `kind` below therefore only
 * drives what the tool REPORTS, never argument routing.
 */
const SYNCABLE_AOT_FOLDERS = new Map<string, SyncKind>([
  ['AxTable', 'table'],
  ['AxTableExtension', 'table'],
  ['AxView', 'view'],
  ['AxDataEntityView', 'view'],
  ['AxDataEntityViewExtension', 'view'],
]);

/** What kind of object a sync target is — reported, not routed on. */
type SyncKind = 'table' | 'view';

/** A syncable object plus what kind it is. */
interface SyncTarget {
  name: string;
  kind: SyncKind;
}

/** Max output length returned to the client (characters). */
const MAX_OUTPUT_LENGTH = 8_000;

/**
 * Redact the `-connect=...` argument when logging SyncEngine invocations so
 * SQL Server credentials never appear in plain text in server logs.
 */
function maskConnectArgs(args: string[]): string[] {
  return args.map(a => {
    if (typeof a === 'string' && a.toLowerCase().startsWith('-connect=')) {
      return '-connect=***REDACTED***';
    }
    return a;
  });
}

/**
 * Runs an executable and streams output to stderr for progress visibility.
 * Returns combined stdout+stderr and the exit code.
 */
function runWithStreaming(
  exe: string,
  args: string[],
  opts: { timeout: number; windowsHide?: boolean }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      windowsHide: opts.windowsHide ?? true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Cap in-memory buffering; a long sync can emit tens of MB. Oldest bytes
    // are dropped once the cap is hit, but progress still streams to stderr.
    const MAX_BUFFER_BYTES = 2 * 1024 * 1024; // 2 MB per stream
    const truncated = { stdout: false, stderr: false };
    let stdout = '';
    let stderr = '';
    let killed = false;
    const appendBounded = (which: 'stdout' | 'stderr', text: string) => {
      const current = which === 'stdout' ? stdout : stderr;
      const next = current + text;
      if (next.length > MAX_BUFFER_BYTES) {
        truncated[which] = true;
        const trimmed = next.slice(next.length - MAX_BUFFER_BYTES);
        if (which === 'stdout') stdout = trimmed; else stderr = trimmed;
      } else {
        if (which === 'stdout') stdout = next; else stderr = next;
      }
    };

    const timer = opts.timeout > 0
      ? setTimeout(() => {
          killed = true;
          child.kill('SIGTERM');
          setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
        }, opts.timeout)
      : undefined;

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      appendBounded('stdout', text);
      // Log progress lines so user can see activity in MCP server logs
      for (const line of text.split('\n').filter((l: string) => l.trim())) {
        console.error(`[db-sync stdout] ${line}`);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      appendBounded('stderr', text);
      for (const line of text.split('\n').filter((l: string) => l.trim())) {
        console.error(`[db-sync stderr] ${line}`);
      }
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (killed) {
        reject(Object.assign(
          new Error(`SyncEngine timed out after ${opts.timeout / 60000} minutes`),
          { stdout, stderr }
        ));
      } else {
        resolve({ stdout, stderr, code });
      }
    });
  });
}

/**
 * Extract syncable object names from a .rnrproj project file, tagged with the
 * SyncEngine list they belong in. Looks for Content Include entries like
 * "AxTable\MyTable", "AxView\MyView", "AxTableExtension\MyExt", etc. — the AOT
 * folder is authoritative for the table/view split.
 */
export async function extractTablesFromProject(projectPath: string): Promise<SyncTarget[]> {
  const parser = new Parser({ explicitArray: true });
  const xml = await fs.readFile(projectPath, 'utf-8');
  const parsed = await parser.parseStringPromise(xml);

  const targets: SyncTarget[] = [];
  const itemGroups: any[] = parsed?.Project?.ItemGroup ?? [];
  for (const group of itemGroups) {
    const contents: any[] = Array.isArray(group.Content) ? group.Content : [];
    for (const c of contents) {
      const inc: string | undefined = c?.$?.Include;
      if (!inc) continue;
      // Format: "AxTable\MyTableName" or "AxTableExtension\SomeExt"
      const sep = inc.includes('\\') ? '\\' : inc.includes('/') ? '/' : '\\';
      const parts = inc.split(sep);
      const kind = parts.length >= 2 ? SYNCABLE_AOT_FOLDERS.get(parts[0]) : undefined;
      if (kind) {
        // For extensions like "CustTable.MyExt", extract base table name
        const objectName = parts[1];
        const baseName = objectName.includes('.') ? objectName.split('.')[0] : objectName;
        if (baseName && !targets.some(t => t.name === baseName)) {
          targets.push({ name: baseName, kind });
        }
      }
    }
  }
  return targets;
}

/**
 * Label explicitly named objects as table or view using the symbol index, so the
 * tool can report what it actually synced. Both kinds go into the same
 * `-synclist`, so a wrong label costs nothing but an inaccurate summary; an
 * unknown name is reported as such rather than silently called a table.
 */
export function classifySyncTargets(
  names: string[],
  db: DbLike | undefined,
): { targets: SyncTarget[]; unresolved: string[] } {
  const targets: SyncTarget[] = [];
  const unresolved: string[] = [];
  for (const name of names) {
    let kind: SyncKind = 'table';
    if (db) {
      const hit = lookupSymbolNocase(db, name, ['table', 'view']);
      if (hit) {
        kind = hit.type === 'view' ? 'view' : 'table';
      } else {
        unresolved.push(name);
      }
    }
    targets.push({ name, kind });
  }
  return { targets, unresolved };
}

/**
 * Check that critical StaticMetadata files exist for the model.
 * SyncEngine hangs or crashes when these are missing.
 */
async function checkStaticMetadata(packagesRoot: string, modelName: string): Promise<string | null> {
  const binDir = path.join(packagesRoot, modelName, 'bin', 'StaticMetadata');
  try {
    await fs.access(binDir);
    return null; // OK
  } catch {
    return `⚠️ Missing StaticMetadata for model "${modelName}" at:\n${binDir}\n\n` +
      'SyncEngine will fail without compiled metadata. Run a full Rebuild from Visual Studio first:\n' +
      '  Right-click project → Rebuild\n' +
      'Then retry db sync.';
  }
}

/**
 * Build the SyncEngine command line. Pure, so the argument shape can be gated by
 * a test instead of only by a 3-minute run against a live AxDB.
 *
 * `targets` empty ⇒ full sync. Tables and views share `-synclist`; `-viewlist`
 * must never appear (see SYNCABLE_AOT_FOLDERS for the verified reason).
 */
export function buildSyncEngineArgs(opts: {
  targets: SyncTarget[];
  syncViews: boolean;
  metadataBinPath: string;
  connStr: string;
}): string[] {
  const isPartial = opts.targets.length > 0;
  const syncMode = isPartial
    ? 'PartialList'
    : opts.syncViews ? 'FullAllAndViews' : 'FullAll';

  const args = [
    `-syncmode=${syncMode}`,
    `-metadatabinaries=${opts.metadataBinPath}`,
    `-connect=${opts.connStr}`,
  ];
  if (isPartial) {
    args.push(`-synclist=${opts.targets.map(t => t.name).join(',')}`);
  } else {
    // Only for a full sync — verbose diagnostics add real overhead.
    args.push('-verbosediagnostics');
  }
  return args;
}

/**
 * Decide whether a SyncEngine run actually succeeded.
 *
 * The old test — "any line contains error/failed/exception" — reported ❌ for a
 * sync that completed cleanly, because SyncEngine logs a benign startup warning
 * on this environment (`Log level - Warning | Failed to abort paused
 * PostServiceync resumable index from last run: SqlException … Invalid column
 * name 'DEFERREDOPERATIONSTATE'`) before it does any work. Every partial sync on
 * this VM tripped it, so a green run was indistinguishable from a red one.
 *
 * SyncEngine states its own verdict: it prints `<SyncMode> finished` and
 * `Sync finished and took <n> milliseconds` only on a completed run. Take that
 * as the signal, and keep two overrides that a completion line must not hide:
 * a rejected argument (which is silently ignored — how the bogus `-viewlist`
 * went unnoticed) and an explicit failure/abort line.
 */
export function classifySyncOutcome(rawOutput: string): { succeeded: boolean; reason: string } {
  const invalidArg = rawOutput.match(/^.*Invalid argument .*$/mi)?.[0]?.trim();
  if (invalidArg) {
    // SyncEngine drops the argument and carries on, so this never fails the run
    // on its own — the caller must be told the request was not honoured.
    return { succeeded: false, reason: `SyncEngine rejected an argument: ${invalidArg}` };
  }
  const hardFailure = rawOutput.match(
    /^.*\b(sync failed|synchronization failed|aborting sync|unhandled exception|fatal error)\b.*$/mi,
  )?.[0]?.trim();
  if (hardFailure) {
    return { succeeded: false, reason: hardFailure };
  }
  const completed = /\bSync finished and took\b/i.test(rawOutput)
    || /\b(PartialList|FullAll|FullAllAndViews|PartialTables|FullTables) finished\b/i.test(rawOutput);
  return completed
    ? { succeeded: true, reason: 'SyncEngine reported completion' }
    : { succeeded: false, reason: 'SyncEngine never reported completion' };
}

/** Truncate output to avoid huge MCP responses. */
function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_LENGTH) return text;
  const half = Math.floor(MAX_OUTPUT_LENGTH / 2) - 50;
  return text.slice(0, half) +
    `\n\n... [truncated ${text.length - MAX_OUTPUT_LENGTH} chars] ...\n\n` +
    text.slice(-half);
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.

export const dbSyncTool = async (params: any, context: any) => {
  const { syncViews = false } = params;
  try {
    const configManager = getConfigManager();
    await configManager.ensureLoaded();

    const modelName = params.modelName || configManager.getModelName();
    if (!modelName) {
      return {
        content: [{ type: 'text', text: '❌ No model name provided and none found in .mcp.json. Pass modelName explicitly.' }],
        isError: true
      };
    }

    const packagesRoot = params.packagePath
      || configManager.getPackagePath()
      || 'K:\\AosService\\PackagesLocalDirectory';

    // SyncEngine.exe location
    const syncEnginePath = path.join(packagesRoot, 'Bin', 'SyncEngine.exe');
    try {
      await fs.access(syncEnginePath);
    } catch {
      return {
        content: [{ type: 'text', text: `❌ SyncEngine.exe not found at: ${syncEnginePath}\n\nMake sure PackagesLocalDirectory is correctly configured in .mcp.json (packagePath).` }],
        isError: true
      };
    }

    // Pre-flight check; warning is logged but does not block the sync.
    const metadataWarning = await checkStaticMetadata(packagesRoot, modelName);
    if (metadataWarning) {
      console.error(`[trigger_db_sync] ${metadataWarning}`);
    }

    // Resolve object list: explicit tables[]/tableName > projectPath extraction > full sync
    const explicitNames: string[] = [
      ...(params.tables ?? []),
      ...(params.tableName ? [params.tableName] : []),
    ].filter((t: string) => t.trim().length > 0);

    let syncTargets: SyncTarget[] = [];
    let unresolvedNames: string[] = [];
    let projectExtracted = false;
    if (explicitNames.length > 0) {
      // The caller names objects without saying what they are; the symbol index
      // decides which SyncEngine list each belongs in.
      let db: DbLike | undefined;
      try {
        db = context?.symbolIndex?.getReadDb?.();
      } catch {
        /* index unavailable — everything falls back to the table list */
      }
      ({ targets: syncTargets, unresolved: unresolvedNames } =
        classifySyncTargets(explicitNames, db));
    } else {
      // Try to extract syncable objects from the project file for smart partial sync
      const projectPath = params.projectPath || await configManager.getProjectPath();
      if (projectPath) {
        try {
          await fs.access(projectPath);
          const extracted = await extractTablesFromProject(projectPath);
          if (extracted.length > 0) {
            syncTargets = extracted;
            projectExtracted = true;
            console.error(`[trigger_db_sync] Extracted ${extracted.length} syncable objects from project: ${extracted.map(t => t.name).join(', ')}`);
          }
        } catch (e: any) {
          console.error(`[trigger_db_sync] Could not read project file ${projectPath}: ${e.message}`);
          // Fall through to full sync
        }
      }
    }

    const partialTables = syncTargets.filter(t => t.kind === 'table').map(t => t.name);
    const partialViews = syncTargets.filter(t => t.kind === 'view').map(t => t.name);
    const isPartial = syncTargets.length > 0;

    // SyncEngine needs the PackagesLocalDirectory root — it reads StaticMetadata
    // from every model's bin folder, not just the current model's.
    const args = buildSyncEngineArgs({
      targets: syncTargets,
      syncViews,
      metadataBinPath: packagesRoot,
      connStr: params.connectionString
        || 'Data Source=localhost;Initial Catalog=AxDB;Integrated Security=True',
    });

    console.error(`[trigger_db_sync] Running: "${syncEnginePath}" ${maskConnectArgs(args).join(' ')}`);

    // Timeouts: partial 15 min, full 60 min
    const timeoutMs = isPartial ? 15 * 60_000 : 60 * 60_000;

    const startTime = Date.now();
    const { stdout, stderr } = await withOperationLock(
      'dbsync',  // single lock key — SyncEngine can't run in parallel on same DB
      () => runWithStreaming(syncEnginePath, args, {
        timeout: timeoutMs,
        windowsHide: true,
      }),
    );
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);

    const rawOutput = [stdout, stderr].filter(Boolean).join('\n').trim();
    const output = truncateOutput(rawOutput);
    const verdict = classifySyncOutcome(rawOutput);
    const hasErrors = !verdict.succeeded;

    const scopeParts: string[] = [];
    if (partialTables.length > 0) {
      scopeParts.push(`${partialTables.length} table(s): ${partialTables.join(', ')}`);
    }
    if (partialViews.length > 0) {
      scopeParts.push(`${partialViews.length} view(s): ${partialViews.join(', ')}`);
    }
    // Names the index has never seen are still passed to SyncEngine (it resolves
    // against the compiled metadata, not our index), but say so — a typo and a
    // genuinely new object look identical from here.
    const unresolvedNote = unresolvedNames.length > 0
      ? `\n⚠️ Not in the symbol index — synced anyway, but unverifiable from here: ` +
        `${unresolvedNames.join(', ')}. Run \`update_symbol_index\` if these are new objects.`
      : '';
    const scopeDesc = isPartial
      ? `Partial sync — ${scopeParts.join('; ')}` +
        (projectExtracted ? ' (extracted from project)' : '') +
        unresolvedNote
      : `Full sync — model: ${modelName}${syncViews ? ' (tables + views)' : ''}`;

    return {
      content: [{
        type: 'text',
        text: (hasErrors ? `❌ DB Sync failed — ${verdict.reason}` : '✅ DB Sync completed') +
          ` (${elapsedSec}s)` +
          `\n\n${scopeDesc}` +
          `\n\n${output || '(no output)'}`
      }],
      isError: hasErrors,
    };
  } catch (error: any) {
    console.error('Error syncing DB:', error);
    const rawOutput = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    return {
      content: [{ type: 'text', text: '❌ DB Sync failed:\n\n' + truncateOutput(rawOutput) }],
      isError: true
    };
  }
};
