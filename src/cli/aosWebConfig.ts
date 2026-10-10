/**
 * The database a classic AOSService VM's own AOS uses.
 *
 * The AOS reads it from AosService\WebRoot\web.config, next to
 * PackagesLocalDirectory. Offering it in the SQL setup removes the typing of a
 * server and database name, where a typo only surfaced later as a failed query;
 * the user still confirms.
 *
 * UDE machines have no local AOS and so no web.config: callers get null.
 */
import * as fs from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { readAppSetting } from '../utils/appSettings.js';

export interface AosWebConfig {
  /** DataAccess.DbServer — often "." or the machine name. */
  dbServer?: string;
  /** DataAccess.Database — AxDB on a standard VM. */
  database?: string;
}

/** Parse the values out of a web.config document. */
export function parseAosWebConfig(xml: string): AosWebConfig {
  const get = (key: string) => readAppSetting(xml, key)?.trim() || undefined;
  return {
    dbServer: get('DataAccess.DbServer'),
    database: get('DataAccess.Database'),
  };
}

/** web.config of the AOS that serves `packagesRoot`, or null when there is none to read. */
export function readAosWebConfig(packagesRoot: string | undefined): AosWebConfig | null {
  if (!packagesRoot) return null;
  try {
    return parseAosWebConfig(fs.readFileSync(join(packagesRoot, '..', 'WebRoot', 'web.config'), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Whether a SQL server name points at this machine.
 *
 * A developer VM's SQL Server almost always presents a self-signed certificate,
 * so an encrypted connection to it fails validation unless the certificate is
 * trusted; the wizard defaults that answer to yes for a local server only.
 */
export function isLocalSqlServer(server: string, machine: string = hostname()): boolean {
  const host = server.trim().replace(/^(tcp|np|lpc):/i, '').split(/[\\,]/)[0].trim().toLowerCase();
  return ['.', '(local)', 'localhost', '127.0.0.1', '::1', machine.toLowerCase()].includes(host)
    || host.startsWith('(localdb)');
}
