/**
 * Start each MCP server once before the first cell and touch its index.
 *
 * Every cell spawns its own server, but the server's index is a 2.5 GB SQLite
 * file on the VM, and after an hour of other work the OS has dropped its pages.
 * The first cell of v4 then spent 476 s in three MCP calls (`search` 88 s,
 * `find_references` with `get_object_info` 187 s) that took 0.4 s in total once
 * the pages were cached — a cost an editor pays once per session, not once per
 * question. Warming up before the matrix keeps it off the first measured cell.
 */
import * as fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface WarmUpResult {
  server: string;
  ms: number;
  calls: Array<{ tool: string; ms: number; ok: boolean }>;
  error: string | null;
}

/** Read-only calls over the standard application: they page in the symbol, method and reference tables. */
export const WARM_UP_CALLS: Array<{ name: string; arguments: Record<string, unknown> }> = [
  { name: 'get_workspace_info', arguments: {} },
  { name: 'search', arguments: { queries: [{ query: 'CustTable' }, { query: 'SalesFormLetter' }, { query: 'validateWrite', type: 'method' }] } },
  { name: 'get_object_info', arguments: { objectType: 'class', name: 'SalesFormLetter', options: { members: 'names' } } },
  { name: 'find_references', arguments: { targetName: 'CustTable.find' } },
];

export async function warmUpServer(mcpConfigFile: string, server: string, timeoutMs = 10 * 60 * 1000): Promise<WarmUpResult> {
  const started = Date.now();
  const result: WarmUpResult = { server, ms: 0, calls: [], error: null };
  const entry = (JSON.parse(fs.readFileSync(mcpConfigFile, 'utf8')) as { mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> }).mcpServers?.[server];
  if (!entry) {
    result.error = `no server '${server}' in ${mcpConfigFile}`;
    return result;
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, entry.env ?? {});
  const client = new Client({ name: 'd365fo-mcp-benchmark-warmup', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args ?? [], env, stderr: 'ignore' }));
    const { tools } = await client.listTools();
    const available = new Set(tools.map(t => t.name));
    for (const call of WARM_UP_CALLS.filter(c => available.has(c.name))) {
      const t = Date.now();
      let ok = true;
      try {
        const r = await client.callTool(call, undefined, { timeout: timeoutMs });
        ok = !r.isError;
      } catch {
        ok = false;
      }
      result.calls.push({ tool: call.name, ms: Date.now() - t, ok });
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    await client.close().catch(() => undefined);
    result.ms = Date.now() - started;
  }
  return result;
}
