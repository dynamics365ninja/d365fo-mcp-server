import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { Parser } from 'xml2js';
import { getConfigManager } from '../utils/configManager.js';
import { withOperationLock } from '../utils/operationLocks.js';
import { lookupSymbolNocase, type DbLike } from '../utils/symbolLookup.js';

/**
 * AOT folders that map to syncable DB objects, and which SyncEngine list each
 * one belongs in. `-synclist` takes tables; `-viewlist` takes views and data
 * entity views. SyncEngine aborts with "Invalid argument -viewlist=…" when a
 * table name appears in the view list, so the split is not cosmetic
 * (docs/eval-sweep-findings-2026-07-21.md, "Open — writers").
 */
const SYNCABLE_AOT_FOLDERS = new Map<string, SyncKind>([
  ['AxTable', 'table'],
  ['AxTableExtension', 'table'],
  ['AxView', 'view'],
  ['AxDataEntityView', 'view'],
  ['AxDataEntityViewExtension', 'view'],
]);

/** Which SyncEngine list an object belongs in. */
type SyncKind = 'table' | 'view';

/** A syncable object plus the list it belongs in. */
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
 * Classify explicitly named objects into the table/view lists using the symbol
 * index. Unknown names stay tables: that is the pre-existing behaviour and the
 * only safe default for an object created this session and not yet indexed —
 * SyncEngine ignores a name it cannot resolve in `-synclist`, but rejects the
 * whole invocation when `-viewlist` names a non-view.
 *
 * Returns the classified targets plus any names the index could not resolve, so
 * the caller can say so instead of silently guessing.
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
    const metadataBinPath = packagesRoot;
    const connStr = params.connectionString
      || 'Data Source=localhost;Initial Catalog=AxDB;Integrated Security=True';

    let syncMode: string;
    if (isPartial) {
      syncMode = 'PartialList';
    } else if (syncViews) {
      syncMode = 'FullAllAndViews';
    } else {
      syncMode = 'FullAll';
    }

    const args: string[] = [
      `-syncmode=${syncMode}`,
      `-metadatabinaries=${metadataBinPath}`,
      `-connect=${connStr}`,
    ];
    // Only add verbosediagnostics for full sync (adds overhead)
    if (!isPartial) {
      args.push('-verbosediagnostics');
    }
    if (isPartial) {
      // Tables and views go in SEPARATE lists. Putting a table name in -viewlist
      // makes SyncEngine abort with "Invalid argument -viewlist=…", so an empty
      // side is omitted entirely rather than mirrored from the other one.
      if (partialTables.length > 0) {
        args.push(`-synclist=${partialTables.join(',')}`);
      }
      if (partialViews.length > 0) {
        args.push(`-viewlist=${partialViews.join(',')}`);
      }
    }

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
    const hasErrors = /\b(error|failed|exception)\b/i.test(rawOutput) &&
      !/0 error/i.test(rawOutput);  // "0 errors" is success

    const scopeParts: string[] = [];
    if (partialTables.length > 0) {
      scopeParts.push(`${partialTables.length} table(s): ${partialTables.join(', ')}`);
    }
    if (partialViews.length > 0) {
      scopeParts.push(`${partialViews.length} view(s): ${partialViews.join(', ')}`);
    }
    // Say so when a name was synced as a table only because the index had never
    // heard of it — the alternative is a silent misclassification.
    const unresolvedNote = unresolvedNames.length > 0
      ? `\n⚠️ Not in the symbol index, synced as table(s): ${unresolvedNames.join(', ')}.` +
        ' If any of these is a view, run `update_symbol_index` first.'
      : '';
    const scopeDesc = isPartial
      ? `Partial sync — ${scopeParts.join('; ')}` +
        (projectExtracted ? ' (extracted from project)' : '') +
        unresolvedNote
      : `Full sync — model: ${modelName}${syncViews ? ' (tables + views)' : ''}`;

    return {
      content: [{
        type: 'text',
        text: (hasErrors ? '❌ DB Sync failed' : '✅ DB Sync completed') +
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
