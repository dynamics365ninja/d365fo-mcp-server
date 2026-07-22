/**
 * MCP tool definition for `trigger_db_sync` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const triggerDbSyncTool = {
    name: 'trigger_db_sync',
    description: 'Run a D365FO database sync (SyncEngine.exe). ' +
      'Supports partial sync of specific tables — much faster than full-model sync. ' +
      'Use partial sync after adding/renaming fields or indexes on known tables. ' +
      'Pass projectPath to auto-extract tables from .rnrproj for smart partial sync. ' +
      'Use full sync only when unsure what changed.',
    inputSchema: {
      type: 'object',
      properties: {
        modelName: { type: 'string', description: 'Model to sync. Auto-detected from .mcp.json if omitted.' },
        tables: {
          type: 'array',
          items: { type: 'string' },
          description: 'Partial sync: sync only these tables/views (faster). Example: ["CustTable", "MyNewTable"]. Views may be listed here too — they are routed to the view list automatically. Omit for full-model sync.',
        },
        tableName: { type: 'string', description: 'Single-table shorthand — equivalent to tables=["tableName"]. Kept for backwards compatibility.' },
        projectPath: { type: 'string', description: 'Path to .rnrproj file. Auto-extracts table/view names for partial sync. Auto-detected from .mcp.json when no explicit tables given.' },
        syncViews: { type: 'boolean', description: 'FULL sync only: also sync views and data entities. Ignored for partial sync, where views are routed by name. Default: false.' },
        connectionString: { type: 'string', description: 'SQL Server connection string. Default: "Data Source=localhost;Initial Catalog=AxDB;Integrated Security=True".' },
        packagePath: { type: 'string', description: 'PackagesLocalDirectory root. Auto-detected from .mcp.json if omitted.' },
      },
      required: [],
    },
  };
