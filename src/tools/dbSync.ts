import { z } from 'zod';
import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs/promises';
import { getConfigManager } from '../utils/configManager.js';

const execFileAsync = util.promisify(execFile);

export const dbSyncToolDefinition = {
  name: 'trigger_db_sync',
  description: 'Triggers a D365FO database sync (SyncEngine.exe). ' +
    'Supports full-model sync or partial sync of specific tables/views. ' +
    'Partial sync is faster and sufficient after adding/renaming fields, indexes, or creating a new table.',
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

    // Merge tables[] and tableName (backwards-compat)
    const tableList: string[] = [
      ...(params.tables ?? []),
      ...(params.tableName ? [params.tableName] : []),
    ].filter((t: string) => t.trim().length > 0);

    const isPartial = tableList.length > 0;

    const binPath = path.join(packagesRoot, modelName, 'bin');
    const connStr = params.connectionString
      || 'Data Source=localhost;Initial Catalog=AxDB;Integrated Security=True';

    const syncMode = isPartial ? 'onlysyncselectedtables' : 'fullall';
    const args: string[] = [
      `-syncmode=${syncMode}`,
      `-connect=${connStr}`,
      `-metadatabinaries=${binPath}`
    ];
    if (isPartial) {
      args.push(`-tables=${tableList.join(',')}`);
    }
    if (syncViews) {
      // SyncEngine supports -syncmode=fullalltablesandviews for full sync with views,
      // or we add the -views flag for partial sync
      if (isPartial) {
        args.push(`-views=${tableList.join(',')}`);
      } else {
        // Replace syncmode to include views
        args[0] = '-syncmode=fullalltablesandviews';
      }
    }

    console.error(`[trigger_db_sync] Running: "${syncEnginePath}" ${args.join(' ')}`);

    const { stdout, stderr } = await execFileAsync(syncEnginePath, args, {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 600_000 // 10 minutes
    });

    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    const hasErrors = /error|failed|exception/i.test(output);

    const scopeDesc = isPartial
      ? `Partial sync — tables: ${tableList.join(', ')}${syncViews ? ' + views' : ''}`
      : `Full sync — model: ${modelName}${syncViews ? ' (tables + views)' : ''}`;

    return {
      content: [{
        type: 'text',
        text: (hasErrors ? '❌ DB Sync failed' : '✅ DB Sync completed') +
          `\n\n${scopeDesc}` +
          `\n\n${output || '(no output)'}`
      }]
    };
  } catch (error: any) {
    console.error('Error syncing DB:', error);
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    return {
      content: [{ type: 'text', text: '❌ DB Sync failed:\n\n' + output }],
      isError: true
    };
  }
};
