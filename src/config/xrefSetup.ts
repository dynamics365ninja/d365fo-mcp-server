/**
 * How to give the bridge its cross-reference database. One definition for every
 * place that has to say it (find_references when it falls back, and doctor), so
 * they cannot drift apart. It names both places the settings can live: the
 * server reads the `env` block of .mcp.json first, and the config file only
 * after it, so advice naming only the config file is incomplete.
 */

import { settingByPath } from './settings.js';

/**
 * The advice as a lowercase clause ("set …"), for the caller to lead in to.
 * `code` formats setting names and values: backticks for Markdown (the
 * default), identity for plain terminal output.
 */
export function xrefSetupAdvice(code: (s: string) => string = s => `\`${s}\``): string {
  const name = settingByPath('bridge.xrefDbName')!;
  const server = settingByPath('bridge.xrefDbServer')!;
  return `set ${code(name.env!)} to the cross-reference database (usually ${code('DYNAMICSXREFDB')}), ` +
    `and ${code(server.env!)} if SQL Server is not on this machine. Put them in the ${code('env')} block ` +
    `of ${code('.mcp.json')}, or set ${code(name.path!)} / ${code(server.path!)} in the config file. ` +
    `Then restart the MCP server.`;
}
