import { z } from 'zod';
import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs/promises';
import { getConfigManager } from '../utils/configManager.js';

const execFileAsync = util.promisify(execFile);

export const dbSyncToolDefinition = {
  name: 'trigger_db_sync',
  description: 'Triggers a database sync for a specific model or table to validate schema integrity.',
  parameters: z.object({
    modelName: z.string().describe('The name of the model to sync'),
    tableName: z.string().optional().describe('An optional specific table to sync'),
    packagePath: z.string().optional().describe('PackagesLocalDirectory root. Auto-detected if omitted.')
  })
};

export const dbSyncTool = async (params: any, _context: any) => {
  const { modelName, tableName } = params;
  try {
    const configManager = getConfigManager();
    await configManager.ensureLoaded();

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

    // SyncEngine.exe -connect=... -metadatabinaries=... -syncmode=...
    // For D365FO local dev: SyncEngine.exe -syncmode=fullall -connect=<connection> -metadatabinaries=<binpath>
    const binPath = path.join(packagesRoot, modelName, 'bin');
    const connectionString = 'Data Source=localhost;Initial Catalog=AxDB;Integrated Security=True';

    const args: string[] = [
      `-syncmode=${tableName ? 'onlysyncselectedtables' : 'fullall'}`,
      `-connect=${connectionString}`,
      `-metadatabinaries=${binPath}`
    ];
    if (tableName) {
      args.push(`-tables=${tableName}`);
    }

    console.error(`[trigger_db_sync] Running: "${syncEnginePath}" ${args.join(' ')}`);

    const { stdout, stderr } = await execFileAsync(syncEnginePath, args, {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 600_000 // 10 minutes
    });

    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    const hasErrors = /error|failed|exception/i.test(output);

    return {
      content: [{
        type: 'text',
        text: (hasErrors ? '❌ DB Sync failed' : '✅ DB Sync completed') +
          `\n\nModel: ${modelName}` +
          (tableName ? `\nTable: ${tableName}` : '') +
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
