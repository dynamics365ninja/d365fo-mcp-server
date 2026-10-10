/** Shared by setup-aware publication, the tool and the bridge launcher. */
export interface AxDbConfig {
  server: string;
  database: string;
  trustServerCertificate: boolean;
  commandTimeoutSeconds: number;
  maxRows: number;
}
const yes = (value?: string) => /^(true|1|yes|on)$/i.test(value?.trim() ?? '');
export function isAxDbConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return yes(env.D365FO_SQL_ENABLED) && !!env.D365FO_SQL_SERVER?.trim();
}
export function resolveAxDbConfig(env: NodeJS.ProcessEnv = process.env): AxDbConfig | undefined {
  if (!isAxDbConfigured(env)) return undefined;
  const integer = (key: string, fallback: number, max: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${key} must be between 1 and ${max}`);
    return value;
  };
  const server = env.D365FO_SQL_SERVER!.trim();
  const database = env.D365FO_SQL_DATABASE?.trim() || 'AxDB';
  if (/[;\r\n]/.test(server) || server.includes('\0') || server.length > 256 || database.length > 128 || /[\r\n]/.test(database) || database.includes('\0'))
    throw new Error('Invalid SQL server/database name; use setup values, not a connection string.');
  return { server, database,
    trustServerCertificate: yes(env.D365FO_SQL_TRUST_CERTIFICATE),
    commandTimeoutSeconds: integer('D365FO_SQL_TIMEOUT', 30, 30), maxRows: integer('D365FO_SQL_MAX_ROWS', 100, 1000) };
}
