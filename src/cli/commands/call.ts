/**
 * `d365fo-mcp tools [name]` and `d365fo-mcp call <tool> [args…]` — the server's
 * tools from a terminal, for agents and scripts that work through a shell
 * instead of an MCP client.
 *
 * Both talk to a server that is already running in HTTP mode (`d365fo-mcp
 * start`) instead of loading the index themselves. A stdio server loads its own
 * copy of the symbol index (~1.5 GB) and starts the C# bridge before its first
 * answer; doing that for every command would make every call pay the cold start.
 * Over HTTP the index is loaded once, and each call goes through the same
 * dispatch an MCP client gets: the dedup cache, the bridge-readiness wait, the
 * response caps.
 *
 * `call` prints the tool's text as an MCP client hands it to the model, so an
 * agent in a shell reads the same answer. Exit codes: 0 the tool answered,
 * 1 the tool returned an error or gave no answer in time, 2 the call never
 * reached a tool (bad arguments, unknown tool, no server).
 *
 * No workspace header is sent unless --workspace is given: the server derives
 * the package and model from a workspace path, and the folder a shell happens
 * to be in is rarely a model folder.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { settingByPath } from '../../config/settings.js';
import { VERSION } from '../../version.js';
import { listInstances } from '../instances.js';
import { readSetting, readSettingOrDefault } from '../settingsStore.js';
import { instanceTarget, rootTarget, type Target } from '../target.js';
import { normalizeServerUrl } from './connect.js';

export interface ToolClientOptions {
  url?: string;
  instance?: string;
  apiKey?: string;
  workspace?: string;
  timeout?: string;
  json?: boolean;
}

export const EXIT_TOOL_ERROR = 1;
export const EXIT_NOT_CALLED = 2;

/**
 * Just above the server's own ceiling for its heaviest tools (10 minutes by
 * default), so a slow build times out on the server, which names the tool,
 * rather than here.
 */
const DEFAULT_TIMEOUT_MS = 11 * 60_000;

/** The call never reached a tool: bad arguments, unknown tool, no server. */
export class NotCalledError extends Error {}

// ── Where the server is ─────────────────────────────────────────────────────

export interface ServerAddress {
  url: string;
  apiKey?: string;
}

/**
 * The address of a server on this machine. A server with no API key binds
 * 127.0.0.1 and one with a key binds 0.0.0.0; this machine reaches both on the
 * loopback address. Not `localhost`, which can resolve to ::1 first, and a
 * 127.0.0.1 listener refuses that.
 */
export function localServerUrl(port: number, host: unknown): string {
  const h = typeof host === 'string' ? host.trim() : '';
  const reachable = h && !['0.0.0.0', '::', 'localhost'].includes(h) ? h : '127.0.0.1';
  return `http://${reachable.includes(':') ? `[${reachable}]` : reachable}:${port}/mcp/`;
}

function apiKeyOf(target: Target): string | undefined {
  const key = readSetting(target.store, settingByPath('server.apiKey')!);
  return typeof key === 'string' && key ? key : undefined;
}

/**
 * Where to send the call: --url, then D365FO_MCP_URL, then the port of the named
 * instance (or of the root server) on this machine. Never asks: an agent cannot
 * answer a prompt, so with instances present and no --instance it uses the root
 * server.
 *
 * The configured API key goes only to the configured local server. With an
 * explicit URL the key must be explicit too (--api-key or D365FO_MCP_API_KEY),
 * so a local key is never sent to some other host.
 */
export function resolveServer(opts: ToolClientOptions, env: NodeJS.ProcessEnv = process.env): ServerAddress {
  const explicitKey = opts.apiKey ?? (env.D365FO_MCP_API_KEY || undefined);
  const explicitUrl = opts.url ?? (env.D365FO_MCP_URL || undefined);
  if (explicitUrl) {
    const normalized = normalizeServerUrl(explicitUrl);
    if (!normalized) throw new NotCalledError(`Not a server URL: ${explicitUrl}`);
    return { url: normalized.url, apiKey: explicitKey };
  }

  let target: Target;
  if (opts.instance && opts.instance !== 'root') {
    const instances = listInstances();
    const inst = instances.find(i => i.name === opts.instance);
    if (!inst) {
      throw new NotCalledError(
        `Instance '${opts.instance}' not found. Available: ${instances.map(i => i.name).join(', ') || '(none)'}`,
      );
    }
    target = instanceTarget(inst);
  } else {
    target = rootTarget();
  }
  const port = target.port ?? Number(readSettingOrDefault(target.store, settingByPath('server.port')!));
  const host = readSetting(target.store, settingByPath('server.host')!);
  return { url: localServerUrl(port, host), apiKey: explicitKey ?? apiKeyOf(target) };
}

/** Turn a failed connect into what to do about it. */
export function describeConnectFailure(url: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const status = /\bHTTP (\d{3})\b/.exec(message)?.[1];
  if (status === '401' || status === '403') {
    return `The server at ${url} refused the request (HTTP ${status}). Pass its key with --api-key, ` +
      'or set server.apiKey for the local server.';
  }
  if (status === '503') {
    return `The server at ${url} is still starting (HTTP 503): it answers once the index is loaded. Try again in a minute.`;
  }
  if (status) return `The server at ${url} answered HTTP ${status}: ${message}`;
  return `No server answers at ${url}. Start one with \`d365fo-mcp start\` (it loads the index once and ` +
    'stays up for every call), or point at another one with --url.';
}

async function withClient<T>(address: ServerAddress, workspace: string | undefined, fn: (client: Client) => Promise<T>): Promise<T> {
  const headers: Record<string, string> = {};
  if (address.apiKey) headers['X-Api-Key'] = address.apiKey;
  if (workspace) headers['X-Workspace-Folder'] = workspace;
  const transport = new StreamableHTTPClientTransport(new URL(address.url), { requestInit: { headers } });
  const client = new Client({ name: 'd365fo-mcp-cli', version: VERSION });
  // The server has no GET stream for server-initiated messages; the SDK reports
  // that 404 here and carries on, and so does a one-shot call.
  client.onerror = () => {};
  try {
    await client.connect(transport);
  } catch (err) {
    throw new NotCalledError(describeConnectFailure(address.url, err));
  }
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

function unknownTool(name: string, tools: Tool[]): string {
  return `Unknown tool '${name}'. This server publishes: ${tools.map(t => t.name).join(', ')}`;
}

// ── Arguments ───────────────────────────────────────────────────────────────

/** The slice of JSON Schema the tool input schemas use. */
export interface ArgSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, ArgSchema>;
  required?: string[];
  items?: ArgSchema;
  enum?: unknown[];
  default?: unknown;
  anyOf?: ArgSchema[];
  oneOf?: ArgSchema[];
  additionalProperties?: unknown;
}

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const JSON_LITERAL = /^(true|false|null|-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?)$/;

/** The one JSON type a schema allows, or undefined when it allows several or says nothing. */
function schemaType(schema: ArgSchema | undefined): string | undefined {
  if (!schema) return undefined;
  const declared = (Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []).filter(t => t !== 'null');
  if (declared.length === 1) return declared[0];
  if (declared.length > 1) return undefined;
  const branches = [...new Set((schema.anyOf ?? schema.oneOf ?? []).map(schemaType).filter(Boolean))];
  return branches.length === 1 ? branches[0] : undefined;
}

function propertiesOf(schema: ArgSchema | undefined): Record<string, ArgSchema> | undefined {
  if (!schema) return undefined;
  if (schema.properties) return schema.properties;
  const branch = (schema.anyOf ?? schema.oneOf ?? []).find(b => b.properties);
  return branch?.properties;
}

function parseJson(value: string, key: string): unknown {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new NotCalledError(`'${key}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function coerce(value: string, schema: ArgSchema | undefined, key: string): unknown {
  const type = schemaType(schema);
  switch (type) {
    case 'string':
      return value;
    case 'integer':
    case 'number': {
      const n = Number(value);
      if (value.trim() === '' || !Number.isFinite(n) || (type === 'integer' && !Number.isInteger(n))) {
        throw new NotCalledError(`'${key}' must be ${type === 'integer' ? 'an integer' : 'a number'}, got '${value}'`);
      }
      return n;
    }
    case 'boolean':
      if (/^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true';
      throw new NotCalledError(`'${key}' must be true or false, got '${value}'`);
    case 'array':
      if (value.trim().startsWith('[')) return parseJson(value, key);
      return value.trim() === '' ? [] : value.split(',').map(v => coerce(v.trim(), schema?.items, key));
    case 'object': {
      const parsed = value.trim().startsWith('{') ? parseJson(value, key) : undefined;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new NotCalledError(`'${key}' must be a JSON object, or set its fields one by one as ${key}.<field>=…`);
      }
      return parsed;
    }
    default: {
      // No single type to go by, as for the fields of a free-form `options`
      // object: send what is plainly a JSON value as one (true, 25, {…}), and
      // anything else as text. `0012` stays text, being no valid JSON number.
      const t = value.trim();
      return t.startsWith('{') || t.startsWith('[') || JSON_LITERAL.test(t) ? parseJson(t, key) : value;
    }
  }
}

/**
 * Turn the words after the tool name into its arguments.
 *
 * One JSON object is passed through as it is. Otherwise every word is
 * `key=value`, `a.b=value` sets a field of a nested object, and the tool's input
 * schema decides the type: numbers, booleans, comma-separated arrays, JSON for
 * objects. Where it names no type (a free-form object's fields), true/false and
 * numbers go as JSON values. A key the schema does not list is refused with the
 * ones it does, because a misspelt argument would otherwise be dropped without a
 * word and the call answered as if it had not been given; inside a free-form
 * object there is no list to check against.
 */
export function parseToolArgs(words: string[], schema?: ArgSchema): Record<string, unknown> {
  if (words.length === 0) return {};
  if (words.length === 1 && words[0].trim().startsWith('{')) {
    const parsed = parseJson(words[0], 'arguments');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new NotCalledError('JSON arguments must be one object, e.g. \'{"query":"CustTable"}\'');
    }
    return parsed as Record<string, unknown>;
  }

  const args: Record<string, unknown> = {};
  for (const word of words) {
    const eq = word.indexOf('=');
    if (eq <= 0) {
      throw new NotCalledError(`Expected key=value, got '${word}' (or pass all arguments as one JSON object)`);
    }
    const key = word.slice(0, eq).trim();
    const path = key.split('.');
    if (path.some(part => !part || RESERVED_KEYS.has(part))) throw new NotCalledError(`Bad argument name '${key}'`);

    let node = args;
    let nodeSchema = schema;
    path.forEach((part, i) => {
      const known = propertiesOf(nodeSchema);
      if (known && !Object.hasOwn(known, part) && nodeSchema?.additionalProperties !== true) {
        const where = i === 0 ? '' : ` in '${path.slice(0, i).join('.')}'`;
        throw new NotCalledError(`Unknown argument '${part}'${where}. Known: ${Object.keys(known).join(', ')}`);
      }
      const partSchema = known?.[part];
      if (i === path.length - 1) {
        if (Object.hasOwn(node, part)) throw new NotCalledError(`'${key}' is given twice`);
        node[part] = coerce(word.slice(eq + 1), partSchema, key);
        return;
      }
      const next = node[part];
      if (next === undefined) node[part] = {};
      else if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        throw new NotCalledError(`'${key}' conflicts with '${path.slice(0, i + 1).join('.')}' given earlier`);
      }
      node = node[part] as Record<string, unknown>;
      nodeSchema = partSchema;
    });
  }
  return args;
}

// ── Output ──────────────────────────────────────────────────────────────────

/** The result as an MCP client hands it to the model: the text items, in order. */
export function formatToolResult(result: CallToolResult): string {
  const parts = (result.content ?? []).map(item => {
    switch (item.type) {
      case 'text':
        return item.text;
      case 'image':
      case 'audio':
        return `[${item.type} ${item.mimeType}, ${Math.round((item.data.length * 3) / 4)} bytes — use --json for the data]`;
      case 'resource':
        return 'text' in item.resource && typeof item.resource.text === 'string'
          ? item.resource.text
          : `[resource ${item.resource.uri} — use --json for the data]`;
      case 'resource_link':
        return `[resource ${item.uri}]`;
      default:
        return `[${(item as { type?: string }).type ?? 'unknown'} content — use --json]`;
    }
  });
  if (parts.length === 0 && result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent, null, 2);
  }
  return parts.join('\n\n');
}

/** First sentence of a description's first line, without markdown emphasis. */
function summary(description: string | undefined, max = 110): string {
  const line = (description ?? '').split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
  const plain = line.replace(/\*\*|__|`/g, '').replace(/^#+\s*/, '');
  const end = plain.search(/[.!?](\s|$)/);
  const sentence = end >= 0 ? plain.slice(0, end + 1) : plain;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** One line per tool, for `d365fo-mcp tools`. */
export function summarizeTools(tools: Tool[]): string {
  const width = Math.max(0, ...tools.map(t => t.name.length));
  const lines = tools.map(t => `${t.name.padEnd(width)}  ${summary(t.description)}`);
  return [
    ...lines,
    '',
    'Arguments of one tool: d365fo-mcp tools <name>',
    'Call one:              d365fo-mcp call <name> key=value …',
  ].join('\n');
}

function typeLabel(schema: ArgSchema): string {
  const type = schemaType(schema) ?? (Array.isArray(schema.type) ? schema.type.join(' | ') : 'any');
  if (type === 'array' && schema.items) return `array of ${schemaType(schema.items) ?? 'any'}`;
  return type;
}

function argumentLines(schema: ArgSchema | undefined, prefix: string, depth: number): string[] {
  const props = propertiesOf(schema);
  if (!props) return [];
  const required = new Set(schema?.required ?? []);
  return Object.entries(props).flatMap(([name, prop]) => {
    const notes = [typeLabel(prop), ...(required.has(name) ? ['required'] : [])];
    const extra: string[] = [];
    if (prop.enum?.length) {
      const shown = prop.enum.slice(0, 12).map(String).join(', ');
      extra.push(`one of: ${shown}${prop.enum.length > 12 ? ', …' : ''}`);
    }
    if (prop.default !== undefined) extra.push(`default: ${JSON.stringify(prop.default)}`);
    const text = [summary(prop.description, 140), ...extra].filter(Boolean).join(' · ');
    const line = `  ${prefix}${name} (${notes.join(', ')})${text ? `  ${text}` : ''}`;
    const nested = depth < 2 && schemaType(prop) === 'object' ? argumentLines(prop, `${prefix}${name}.`, depth + 1) : [];
    return [line, ...nested];
  });
}

/** Full description and arguments of one tool, for `d365fo-mcp tools <name>`. */
export function describeTool(tool: Tool): string {
  const schema = tool.inputSchema as ArgSchema;
  const args = argumentLines(schema, '', 1);
  const example = (schema.required ?? []).map(r => `${r}=…`).join(' ');
  return [
    tool.name,
    '',
    (tool.description ?? '').trim(),
    '',
    args.length > 0 ? 'Arguments:' : 'Arguments: none',
    ...args,
    '',
    `Call: d365fo-mcp call ${tool.name}${example ? ` ${example}` : ''}`,
  ].join('\n');
}

// ── Commands ────────────────────────────────────────────────────────────────

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new NotCalledError(`--timeout must be a number of seconds, got '${raw}'`);
  return Math.round(seconds * 1000);
}

/** Where the commands print: the answer to stdout, anything about the call itself to stderr. */
export const output = {
  answer: (text: string): void => { process.stdout.write(text); },
  problem: (text: string): void => { process.stderr.write(text); },
};

function writeOut(text: string): void {
  output.answer(text.endsWith('\n') ? text : `${text}\n`);
}

function fail(err: unknown, timeoutMs?: number): void {
  if (err instanceof NotCalledError) {
    output.problem(`${err.message}\n`);
    process.exitCode = EXIT_NOT_CALLED;
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/timed out|timeout/i.test(message) && timeoutMs !== undefined) {
    output.problem(
      `No answer within ${Math.round(timeoutMs / 1000)} s (${message}). The call may still be running on the ` +
      'server: check what a write did before repeating it. Raise the limit with --timeout <seconds>.\n',
    );
  } else {
    output.problem(`${message}\n`);
  }
  process.exitCode = EXIT_TOOL_ERROR;
}

export async function toolsCommand(name: string | undefined, opts: ToolClientOptions): Promise<void> {
  try {
    const address = resolveServer(opts);
    const tools = await withClient(address, opts.workspace, listAllTools);
    if (!name) {
      writeOut(opts.json ? JSON.stringify(tools, null, 2) : summarizeTools(tools));
      return;
    }
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new NotCalledError(unknownTool(name, tools));
    writeOut(opts.json ? JSON.stringify(tool, null, 2) : describeTool(tool));
  } catch (err) {
    fail(err);
  }
}

export async function callCommand(toolName: string | undefined, words: string[], opts: ToolClientOptions): Promise<void> {
  let timeoutMs: number | undefined;
  try {
    if (!toolName) {
      throw new NotCalledError(
        "Usage: d365fo-mcp call <tool> [key=value … | '{json}'] [--json]. List the tools with: d365fo-mcp tools",
      );
    }
    timeoutMs = parseTimeout(opts.timeout);
    const address = resolveServer(opts);
    const result = await withClient(address, opts.workspace, async client => {
      // Looked up first so an unknown name never reaches the server (exit 2, with
      // the names it does publish), and so key=value words get their types and a
      // misspelt key is caught. One JSON object is still passed through as given.
      const tools = await listAllTools(client);
      const tool = tools.find(t => t.name === toolName);
      if (!tool) throw new NotCalledError(unknownTool(toolName, tools));
      const args = parseToolArgs(words, tool.inputSchema as ArgSchema);
      return (await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: timeoutMs })) as CallToolResult;
    });
    writeOut(opts.json ? JSON.stringify(result, null, 2) : formatToolResult(result));
    if (result.isError) process.exitCode = EXIT_TOOL_ERROR;
  } catch (err) {
    fail(err, timeoutMs);
  }
}
