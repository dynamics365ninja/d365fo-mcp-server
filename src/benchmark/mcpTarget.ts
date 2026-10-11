/**
 * What an MCP server in a `{"mcpServers": {...}}` file will write to, and which
 * index it keeps — read the way the server itself would read it.
 *
 * Two reasons the benchmark needs this before it lets a with-MCP cell run a
 * prompt that writes:
 *
 *   - **The write target.** A developer's .mcp.json routinely lists more than
 *     one d365fo server; on the VM this repo was built on, one of them writes
 *     into the real customer models. A sandbox run hands the cell exactly the
 *     servers named with --mcp-servers, and refuses one whose workspace is not
 *     the sandbox model.
 *   - **The index.** A create upserts the new object into the server's SQLite
 *     symbol index in place. Restoring the sandbox files does not take it out
 *     again, so the next with-MCP cell would `search` and find the previous
 *     cell's table. The benchmark re-syncs every path that moved, through the
 *     same indexOneFile the update_symbol_index tool runs.
 *
 * Precedence mirrors src/utils/loadEnv.ts: the server entry's env block, then
 * the environment the CLI inherits, then the structured config file named by
 * D365FO_CONFIG, then the path defaults anchored to the config's base folder.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { configBaseDir, defaultPathEnv, toEnvRecord, type ConfigObject } from '../config/configFile.js';
import { readJsonLenient } from '../utils/jsonRecords.js';

export interface McpServerTarget {
  name: string;
  /** D365FO_CONFIG of the entry, resolved; null when the entry names none. */
  configPath: string | null;
  /** Where the server writes (D365FO_WORKSPACE_PATH); null when it cannot be told. */
  workspacePath: string | null;
  /**
   * Which layer set workspacePath. 'inherited' is the trap: a variable in the
   * shell the benchmark runs from reaches the server through claude and beats
   * the server's own config file.
   */
  workspaceSource: 'entry' | 'inherited' | 'config' | null;
  dbPath: string | null;
  labelsDbPath: string | null;
}

interface ServerEntry {
  command?: string;
  args?: unknown[];
  env?: Record<string, unknown>;
  url?: string;
}

function readServers(mcpConfigPath: string): Record<string, ServerEntry> {
  const parsed = readJsonLenient<Record<string, unknown>>(mcpConfigPath);
  const servers = (parsed.mcpServers ?? parsed.servers) as Record<string, ServerEntry> | undefined;
  if (!servers || typeof servers !== 'object') throw new Error(`${mcpConfigPath} has no "mcpServers" object.`);
  return servers;
}

function stringEnv(env: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) if (typeof v === 'string') out[k] = v;
  return out;
}

/** The server entry's effective environment for the settings that matter here. */
export function resolveServerTarget(name: string, entry: ServerEntry, inherited: NodeJS.ProcessEnv = process.env): McpServerTarget {
  const own = stringEnv(entry.env);
  const pick = (key: string): string | undefined => own[key] ?? inherited[key];
  let fromConfig: Record<string, string> = {};
  const configName = pick('D365FO_CONFIG');
  const configPath = configName ? path.resolve(configName) : null;
  if (configPath && fs.existsSync(configPath)) {
    const baseDir = configBaseDir(configPath);
    const config = readJsonLenient<ConfigObject>(configPath);
    fromConfig = { ...defaultPathEnv(baseDir), ...toEnvRecord({ baseDir, config, secrets: null }) };
  }
  const value = (key: string): string | null => pick(key) ?? fromConfig[key] ?? null;
  const sourceOf = (key: string): McpServerTarget['workspaceSource'] =>
    own[key] !== undefined ? 'entry' : inherited[key] !== undefined ? 'inherited' : fromConfig[key] !== undefined ? 'config' : null;

  let dbPath = value('DB_PATH');
  let labelsDbPath = value('LABELS_DB_PATH');
  // No config and no explicit path: the server falls back to <dist>/../data
  // (src/index.ts). Only knowable when the entry runs a local dist/index.js.
  const script = (entry.args ?? []).find((a): a is string => typeof a === 'string' && /index\.js$/i.test(a));
  if (!dbPath && script) dbPath = path.resolve(path.dirname(script), '../data/xpp-metadata.db');
  if (!labelsDbPath && script) labelsDbPath = path.resolve(path.dirname(script), '../data/xpp-metadata-labels.db');

  return {
    name,
    configPath,
    workspacePath: value('D365FO_WORKSPACE_PATH'),
    workspaceSource: sourceOf('D365FO_WORKSPACE_PATH'),
    dbPath,
    labelsDbPath,
  };
}

/**
 * Server scripts (`…/dist/index.js`) in the config that are older than
 * `notBefore` — a with-MCP cell would measure an older server than the
 * serverGitSha its record claims. Returns the stale script paths.
 */
export function staleServerScripts(mcpConfigPath: string, notBefore: Date): string[] {
  const stale: string[] = [];
  for (const entry of Object.values(readServers(mcpConfigPath))) {
    for (const a of entry.args ?? []) {
      if (typeof a !== 'string' || !/index\.js$/i.test(a) || !fs.existsSync(a)) continue;
      if (fs.statSync(a).mtime < notBefore) stale.push(path.resolve(a));
    }
  }
  return [...new Set(stale)];
}

export function resolveMcpTargets(mcpConfigPath: string, inherited: NodeJS.ProcessEnv = process.env): McpServerTarget[] {
  return Object.entries(readServers(mcpConfigPath)).map(([name, entry]) => resolveServerTarget(name, entry, inherited));
}

/**
 * Write a copy of the config holding only `names` to `outFile`. Throws on a
 * name the file does not have — a typo must not quietly run the cell with no
 * server, which would record a "with MCP" cell that had none.
 */
export function writeFilteredMcpConfig(mcpConfigPath: string, names: string[], outFile: string): void {
  const servers = readServers(mcpConfigPath);
  const missing = names.filter(n => !(n in servers));
  if (missing.length > 0) {
    throw new Error(`--mcp-servers: ${missing.join(', ')} not in ${mcpConfigPath} (it has: ${Object.keys(servers).join(', ') || 'none'})`);
  }
  const kept = Object.fromEntries(names.map(n => [n, servers[n]]));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify({ mcpServers: kept }, null, 2)}\n`, 'utf8');
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Problems that must stop a sandbox run before any cell: a server that writes
 * elsewhere, or one whose index cannot be re-synced. Empty = safe to run.
 */
export function sandboxTargetProblems(targets: McpServerTarget[], modelDir: string): string[] {
  const problems: string[] = [];
  for (const t of targets) {
    if (!t.workspacePath) {
      problems.push(`MCP server '${t.name}' names no workspace (D365FO_WORKSPACE_PATH / workspace.path) — cannot prove it writes into the sandbox ${modelDir}.`);
    } else if (!samePath(t.workspacePath, modelDir)) {
      problems.push(
        t.workspaceSource === 'inherited'
          ? `MCP server '${t.name}' would write to ${t.workspacePath}, not the sandbox model ${modelDir}: D365FO_WORKSPACE_PATH is set in the environment the benchmark runs in, and it outranks the server's config file. Unset it in this shell, or set it in the server's "env" block.`
          : `MCP server '${t.name}' writes to ${t.workspacePath} (${t.workspaceSource === 'entry' ? 'its env block' : 'its config file'}), not the sandbox model ${modelDir}. Pick the sandbox server with --mcp-servers.`,
      );
    }
    if (!t.dbPath || !fs.existsSync(t.dbPath)) {
      problems.push(`MCP server '${t.name}': its symbol index (${t.dbPath ?? 'unknown path'}) cannot be found, so the entries a cell writes could not be cleaned before the next one.`);
    }
  }
  return problems;
}

/**
 * Index rows of the sandbox model whose files are gone — what earlier eval or
 * benchmark runs left behind when their files were removed without a re-sync.
 *
 * They are not harmless: on the VM, 27 of the 28 rows indexed for fm-mcp
 * pointed at deleted ConDemo* files, so `search` offered objects that do not
 * exist and the server's prefix inference (naming.prefixSource=model) learned
 * "ConDemo" from them — every with-MCP create of "ConCustOverdueSnapshot" came
 * out as "ConDemoConCustOverdueSnapshot", and the cell stopped to ask.
 * The plain cells never see the index, so a dirty one skews only the MCP side.
 */
export async function staleSandboxIndexFiles(target: Pick<McpServerTarget, 'dbPath'>, model: string, packagesRoot: string): Promise<string[]> {
  if (!target.dbPath || !fs.existsSync(target.dbPath)) return [];
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(target.dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT DISTINCT file_path AS p FROM symbols WHERE model = ? AND file_path IS NOT NULL').all(model) as Array<{ p: string }>;
    return rows
      .map(r => (path.isAbsolute(r.p) ? r.p : path.join(packagesRoot, r.p)))
      .filter(p => !fs.existsSync(p));
  } finally {
    db.close();
  }
}

/**
 * Extension rows of the sandbox model with no file left in the model folder.
 * extension_metadata is keyed by name + type + model, not by path, so
 * {@link staleSandboxIndexFiles} cannot see these; on the VM all 18 fm-mcp rows
 * were stale (CustTable.FmProbeExt, CustTable.ConChainAudit, …), telling a
 * with-MCP cell that CustTable already had extensions in the sandbox.
 * A row is stale when no file under `modelDir` is named after the extension.
 */
export async function pruneStaleExtensionRows(
  target: Pick<McpServerTarget, 'dbPath' | 'labelsDbPath'>,
  model: string,
  modelDir: string,
  opts: { dryRun?: boolean } = {},
): Promise<string[]> {
  if (!target.dbPath || !fs.existsSync(target.dbPath)) return [];
  const present = new Set<string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.name.toLowerCase().endsWith('.xml')) present.add(e.name.slice(0, -4).toLowerCase());
    }
  };
  if (fs.existsSync(modelDir)) walk(modelDir);
  const { XppSymbolIndex } = await import('../metadata/symbolIndex.js');
  const index = new XppSymbolIndex(target.dbPath, target.labelsDbPath ?? undefined, { backgroundIndexBuilds: false });
  try {
    const rows = index.db
      .prepare('SELECT extension_name AS name, extension_type AS type FROM extension_metadata WHERE model = ?')
      .all(model) as Array<{ name: string; type: string }>;
    const stale = rows.filter(r => !present.has(r.name.toLowerCase()));
    if (!opts.dryRun) for (const r of stale) index.removeExtensionMetadata(r.name, r.type, model);
    return stale.map(r => `${r.type} ${r.name}`);
  } finally {
    index.close();
  }
}

export type IndexSync = (target: Pick<McpServerTarget, 'dbPath' | 'labelsDbPath'>, files: string[]) => Promise<{ synced: number; failed: string[] }>;

/**
 * Re-index `files` (absolute) in the server's symbol index: a file that is gone
 * has its rows removed, one that is back is parsed again — indexOneFile, the
 * update_symbol_index tool's own routine. Loaded lazily: the server's index
 * code is heavy and every other benchmark command can do without it.
 */
export const syncSymbolIndex: IndexSync = async (target, files) => {
  if (files.length === 0 || !target.dbPath) return { synced: 0, failed: [] };
  const [{ XppSymbolIndex }, { indexOneFile }] = await Promise.all([
    import('../metadata/symbolIndex.js'),
    import('../tools/sdlc/updateSymbolIndex.js'),
  ]);
  const index = new XppSymbolIndex(target.dbPath, target.labelsDbPath ?? undefined, { backgroundIndexBuilds: false });
  const failed: string[] = [];
  let synced = 0;
  try {
    for (const file of files) {
      // indexOneFile reads nothing from the context but symbolIndex.
      const result = await indexOneFile(file, { symbolIndex: index } as unknown as Parameters<typeof indexOneFile>[1]);
      if (result.isError) failed.push(`${path.basename(file)}: ${result.text.slice(0, 200)}`);
      else synced++;
    }
  } finally {
    index.close();
  }
  return { synced, failed };
};
