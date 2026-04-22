import { z } from 'zod';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { Parser } from 'xml2js';
import { getConfigManager } from '../utils/configManager.js';
import { withOperationLock } from '../utils/operationLocks.js';

/** AOT folders that map to syncable DB objects (tables, table extensions, views, data entities). */
const SYNCABLE_AOT_FOLDERS = new Set([
  'AxTable', 'AxTableExtension', 'AxView', 'AxDataEntityView', 'AxDataEntityViewExtension',
]);

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

    // Bound in-memory buffering of child output. A 60-minute sync on a verbose
    // SyncEngine can emit tens of MB which previously all accumulated in RAM.
    // Once the cap is hit we drop the oldest bytes — progress is still logged
    // live to stderr, and the final client-facing output is already capped by
    // MAX_OUTPUT_LENGTH below.
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
 * Extract table/view names from a .rnrproj project file.
 * Looks for Content Include entries like "AxTable\MyTable", "AxTableExtension\MyExt", etc.
 */
async function extractTablesFromProject(projectPath: string): Promise<string[]> {
  const parser = new Parser({ explicitArray: true });
  const xml = await fs.readFile(projectPath, 'utf-8');
  const parsed = await parser.parseStringPromise(xml);

  const tables: string[] = [];
  const itemGroups: any[] = parsed?.Project?.ItemGroup ?? [];
  for (const group of itemGroups) {
    const contents: any[] = Array.isArray(group.Content) ? group.Content : [];
    for (const c of contents) {
      const inc: string | undefined = c?.$?.Include;
      if (!inc) continue;
      // Format: "AxTable\MyTableName" or "AxTableExtension\SomeExt"
      const sep = inc.includes('\\') ? '\\' : inc.includes('/') ? '/' : '\\';
      const parts = inc.split(sep);
      if (parts.length >= 2 && SYNCABLE_AOT_FOLDERS.has(parts[0])) {
        // For extensions like "CustTable.MyExt", extract base table name
        const objectName = parts[1];
        const baseName = objectName.includes('.') ? objectName.split('.')[0] : objectName;
        if (baseName && !tables.includes(baseName)) {
          tables.push(baseName);
        }
      }
    }
  }
  return tables;
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

export const dbSyncToolDefinition = {
  name: 'trigger_db_sync',
  description: 'Triggers a D365FO database sync (SyncEngine.exe). ' +
    'Supports full-model sync or partial sync of specific tables/views. ' +
    'Partial sync is faster and sufficient after adding/renaming fields, indexes, or creating a new table. ' +
    'Pass projectPath to auto-extract tables from the .rnrproj and do a smart partial sync.',
  parameters: z.object({
    modelName: z.string().optional().describe(
      'Model name to sync. Auto-detected from .mcp.json if omitted.'
    ),
    tables: z.array(z.string()).optional().describe(
      'Sync only these specific tables (partial sync). ' +
      'Use when you added/modified fields or indexes on known tables — much faster than full sync. ' +
      'Example: ["CustTable", "MyCustomTable"]. Omit for full-model sync.'
    ),
    tableName: z.string().optional().describe(
      'Single table shorthand — equivalent to tables=["tableName"]. ' +
      'Kept for backwards compatibility; prefer tables[] for multiple objects.'
    ),
    projectPath: z.string().optional().describe(
      'Path to .rnrproj file. Extracts all table/table-extension/view names from the project ' +
      'and runs a partial sync for just those objects. Auto-detected from .mcp.json if omitted ' +
      'when no explicit tables are given.'
    ),
    syncViews: z.boolean().optional().default(false).describe(
      'When true, also syncs views and data entities in addition to tables. ' +
      'Required after creating/modifying data entities or views. Default: false.'
    ),
    connectionString: z.string().optional().describe(
      'SQL Server connection string. Defaults to "Data Source=localhost;Initial Catalog=AxDB;Integrated Security=True". ' +
      'Override when AxDB is on a different server or uses SQL auth.'
    ),
    packagePath: z.string().optional().describe(
      'PackagesLocalDirectory root. Auto-detected from .mcp.json if omitted.'
    )
  })
};

export const dbSyncTool = async (params: any, _context: any) => {
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

    // ── Pre-flight: check StaticMetadata exists for the model ─────────────
    const metadataWarning = await checkStaticMetadata(packagesRoot, modelName);
    // Warning is logged but does NOT block — we pass both -metadata (source XML)
    // and -metadatabinaries so SyncEngine can fall back to source files.
    if (metadataWarning) {
      console.error(`[trigger_db_sync] ${metadataWarning}`);
    }

    // ── Resolve table list ────────────────────────────────────────────────
    // Priority: explicit tables[] / tableName > projectPath extraction > full sync
    let tableList: string[] = [
      ...(params.tables ?? []),
      ...(params.tableName ? [params.tableName] : []),
    ].filter((t: string) => t.trim().length > 0);

    let projectExtracted = false;
    if (tableList.length === 0) {
      // Try to extract tables from project file for smart partial sync
      const projectPath = params.projectPath || await configManager.getProjectPath();
      if (projectPath) {
        try {
          await fs.access(projectPath);
          const extracted = await extractTablesFromProject(projectPath);
          if (extracted.length > 0) {
            tableList = extracted;
            projectExtracted = true;
            console.error(`[trigger_db_sync] Extracted ${extracted.length} syncable objects from project: ${extracted.join(', ')}`);
          }
        } catch (e: any) {
          console.error(`[trigger_db_sync] Could not read project file ${projectPath}: ${e.message}`);
          // Fall through to full sync
        }
      }
    }

    const isPartial = tableList.length > 0;

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
      args.push(`-synclist=${tableList.join(',')}`);
      if (syncViews) {
        args.push(`-viewlist=${tableList.join(',')}`);
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

    const scopeDesc = isPartial
      ? `Partial sync — ${tableList.length} table(s): ${tableList.join(', ')}` +
        (projectExtracted ? ' (extracted from project)' : '') +
        (syncViews ? ' + views' : '')
      : `Full sync — model: ${modelName}${syncViews ? ' (tables + views)' : ''}`;

    return {
      content: [{
        type: 'text',
        text: (hasErrors ? '❌ DB Sync failed' : '✅ DB Sync completed') +
          ` (${elapsedSec}s)` +
          `\n\n${scopeDesc}` +
          `\n\n${output || '(no output)'}`
      }]
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
