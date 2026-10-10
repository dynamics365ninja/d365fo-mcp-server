import type { Setting } from './settings.js';

export const SQL_SETTINGS: Setting[] = [
  { path: 'sql.enabled', env: 'D365FO_SQL_ENABLED', section: 'sql', tier: 'advanced', type: 'boolean',
    label: 'Enable AxDB SQL', description: 'Enable the optional, read-only SQL tool after configuring its server. Blank server always disables SQL.', default: false },
  { path: 'sql.server', env: 'D365FO_SQL_SERVER', section: 'sql', tier: 'basic', type: 'string',
    label: 'SQL Server for AxDB (leave empty to disable SQL)', description: 'Optional server or named instance; enter localhost for a local developer SQL Server. Leaving it empty skips SQL setup.',
    placeholder: 'localhost or localhost\\INSTANCE', validate: value => /[;\r\n]/.test(value) || value.includes('\0') ? 'Enter a server/instance name, not a connection string.' : undefined },
  { path: 'sql.database', env: 'D365FO_SQL_DATABASE', section: 'sql', tier: 'basic', type: 'string',
    label: 'SQL database name', description: 'Database to query on this server. This is separate from the metadata index and cross-reference database.', default: 'AxDB', required: true,
    validate: value => value.trim().length > 128 ? 'Database names must be at most 128 characters.' : undefined },
  { path: 'sql.trustServerCertificate', env: 'D365FO_SQL_TRUST_CERTIFICATE', section: 'sql', tier: 'basic', type: 'boolean',
    label: 'Trust the local SQL Server certificate?', description: 'Use for a developer SQL Server with a self-signed certificate. The connection remains encrypted.', default: false },
  { path: 'sql.commandTimeoutSeconds', env: 'D365FO_SQL_TIMEOUT', section: 'sql', tier: 'advanced', type: 'int',
    label: 'SQL command timeout in seconds (1–30)', description: 'Maximum time for each SQL command; a batch also has a total time budget.', default: 30 },
  { path: 'sql.maxRows', env: 'D365FO_SQL_MAX_ROWS', section: 'sql', tier: 'advanced', type: 'int',
    label: 'SQL query row limit (1–1000)', description: 'Default returned row limit. Large results are explicitly marked truncated.', default: 100 },
];
