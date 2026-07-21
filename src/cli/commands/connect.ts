/**
 * `d365fo-mcp connect` — point an editor at an already-deployed server.
 *
 * This is the one flow that needs nothing but the CLI itself: scenario A from
 * docs/SETUP.md, where the whole installation is a config entry naming a remote
 * URL. It is therefore deliberately free of the git-checkout guard the other
 * commands carry — `npx d365fo-mcp connect` is the supported way to run it.
 *
 * Editor configs are merged, never rewritten: they routinely hold other MCP
 * servers, and a team member connecting to D365FO must not lose them. Claude
 * Code is handled through its own `claude mcp add-json` CLI rather than by
 * editing ~/.claude.json, which also stores session state we have no business
 * touching.
 */
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { runExe } from '../exec.js';
import { askConfirm, askSelect, askText, ensure, p } from '../ui.js';

/** Server name written into every editor config — matches the docs. */
const SERVER_NAME = 'd365fo-mcp-tools';

type ClientId = 'vs' | 'vscode' | 'cursor' | 'claude';

interface ClientTarget {
  /** Absolute path of the config file. */
  file: string;
  /** Top-level key holding the server map: Copilot uses `servers`, others `mcpServers`. */
  key: 'servers' | 'mcpServers';
}

/** Where each editor keeps its MCP configuration. */
function clientTarget(client: Exclude<ClientId, 'claude'>): ClientTarget {
  switch (client) {
    case 'vs':
      // Visual Studio reads %USERPROFILE%\.mcp.json for every solution.
      return { file: join(homedir(), '.mcp.json'), key: 'servers' };
    case 'vscode':
      // Workspace-scoped: VS Code picks up .vscode/mcp.json from the folder it opens.
      return { file: resolve(process.cwd(), '.vscode', 'mcp.json'), key: 'servers' };
    case 'cursor':
      return { file: join(homedir(), '.cursor', 'mcp.json'), key: 'mcpServers' };
  }
}

/**
 * Normalise whatever the user pasted into the MCP endpoint.
 *
 * People copy the site root from the Azure portal far more often than the
 * endpoint, so accept both and append the path when it is missing rather than
 * failing a form validation on it.
 */
export function normalizeServerUrl(input: string): { url: string; health: string } | null {
  let raw = input.trim();
  if (!raw) return null;
  // Only prepend a scheme when there is none — prefixing an ftp:// URL would
  // turn a rejectable input into a nonsense host rather than an error.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (!hasScheme) raw = `https://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;

  // Strip a trailing /mcp so both the site root and the endpoint reduce to the
  // same base: /health is served next to /mcp/, never underneath it.
  const base = parsed.pathname.replace(/\/+$/, '').replace(/\/mcp$/i, '');
  return {
    url: `${parsed.origin}${base}/mcp/`,
    health: `${parsed.origin}${base}/health`,
  };
}

interface ProbeResult {
  ok: boolean;
  /** Something answered at that address — the URL itself is therefore plausible. */
  reachable: boolean;
  detail: string;
}

/** GET /health so a typo or an asleep App Service is caught before anything is written. */
async function probe(health: string, apiKey?: string): Promise<ProbeResult> {
  try {
    const res = await fetch(health, {
      headers: apiKey ? { 'X-Api-Key': apiKey } : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string; symbols?: number };
    if (res.ok) {
      const symbols = typeof body.symbols === 'number' ? `${body.symbols.toLocaleString('en-US')} symbols` : 'reachable';
      return { ok: true, reachable: true, detail: symbols };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reachable: true, detail: `authentication rejected (HTTP ${res.status}) — check the API key` };
    }
    // A cold App Service answers 503 while it downloads the index; that is not a misconfiguration.
    if (res.status === 503) {
      return { ok: false, reachable: true, detail: `starting up (HTTP 503${body.status ? `: ${body.status}` : ''}) — the URL is right, it needs a minute` };
    }
    return { ok: false, reachable: true, detail: `HTTP ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reachable: false,
      detail: msg.includes('timeout') || msg.includes('abort') ? 'no answer within 20 s' : msg,
    };
  }
}

/** The server entry itself — HTTP transport plus the key, when the server wants one. */
function serverEntry(url: string, apiKey: string | undefined, alwaysLoad: boolean): Record<string, unknown> {
  return {
    type: 'http',
    url,
    ...(apiKey ? { headers: { 'X-Api-Key': apiKey } } : {}),
    // Without it Claude Code defers the tools and may answer X++ questions from
    // built-in search instead (docs/CLAUDE_CODE_SETUP.md).
    ...(alwaysLoad ? { alwaysLoad: true } : {}),
  };
}

interface MergeOutcome {
  json: string;
  replaced: boolean;
  siblings: string[];
}

/**
 * Merge the entry into an existing config. Returns null when the file exists
 * but cannot be parsed — overwriting it would destroy the user's other servers,
 * so the caller stops and asks them to fix it by hand.
 */
export function mergeConfig(
  existing: string | null,
  key: 'servers' | 'mcpServers',
  name: string,
  entry: Record<string, unknown>,
): MergeOutcome | null {
  let doc: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      doc = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  const current = doc[key];
  const servers: Record<string, unknown> =
    typeof current === 'object' && current !== null && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};

  const replaced = name in servers;
  servers[name] = entry;
  doc[key] = servers;

  return {
    json: JSON.stringify(doc, null, 2) + '\n',
    replaced,
    siblings: Object.keys(servers).filter(k => k !== name),
  };
}

/** Register with Claude Code through its own CLI — never by editing ~/.claude.json. */
async function connectClaudeCode(entry: Record<string, unknown>): Promise<void> {
  const payload = JSON.stringify(entry);
  const args = ['mcp', 'add-json', '--scope', 'user', SERVER_NAME, payload];
  p.log.step('Registering with Claude Code (claude mcp add-json)…');
  const code = await runExe('claude', args).catch(() => 1);
  if (code === 0) {
    p.log.success(`Registered as '${SERVER_NAME}' in Claude Code (user scope).`);
    return;
  }
  p.log.warn('Could not run the Claude Code CLI — run this yourself:');
  p.note(`claude mcp add-json --scope user ${SERVER_NAME} '${payload}'`, 'Claude Code');
}

export interface ConnectOptions {
  client?: string;
  apiKey?: string;
  yes?: boolean;
  /** Write even when the server cannot be reached (deployed but currently down). */
  force?: boolean;
}

export async function connectCommand(urlArg: string | undefined, opts: ConnectOptions): Promise<void> {
  p.intro('d365fo-mcp connect — use an already-deployed server');

  // 1. Where the server lives.
  const rawUrl = urlArg ?? await askText({
    message: 'URL of the deployed server',
    placeholder: 'https://your-server.azurewebsites.net',
    required: true,
  });
  const target = normalizeServerUrl(rawUrl);
  if (!target) {
    p.log.error(`Not a usable URL: ${rawUrl}`);
    process.exitCode = 1;
    return;
  }
  p.log.info(`Endpoint: ${target.url}`);

  // 2. The key, when the deployment enforces one.
  let apiKey = opts.apiKey?.trim() || undefined;
  if (!apiKey && !opts.yes) {
    if (await askConfirm('Does the server require an API key? (ask whoever deployed it)', false)) {
      apiKey = ensure(await p.password({
        message: 'API key (X-Api-Key)',
        validate: (v?: string) => (v?.trim() ? undefined : 'Required'),
      })).trim();
    }
  }

  // 3. Prove it answers before touching any config file.
  p.log.step('Checking the server…');
  const health = await probe(target.health, apiKey);
  if (health.ok) {
    p.log.success(`Server responded (${health.detail}).`);
  } else {
    p.log.warn(`Server did not answer cleanly: ${health.detail}`);
    // Nothing at all answered — almost always a typo. Non-interactive runs stop
    // here rather than leave a config pointing at an address that does not
    // exist; --force is the way to say the server is merely down right now.
    if (!health.reachable && opts.yes && !opts.force) {
      p.log.error('Nothing answered at that address — not writing a config for it. Re-run with --force to override.');
      process.exitCode = 1;
      return;
    }
    if (!opts.yes && !opts.force && !await askConfirm('Write the configuration anyway?', false)) {
      p.outro('Nothing written.');
      return;
    }
  }

  // 4. Which editor.
  const client = (opts.client as ClientId | undefined) ?? await askSelect<ClientId>('Which editor should use it?', [
    { value: 'vs', label: 'Visual Studio', hint: '%USERPROFILE%\\.mcp.json — all solutions' },
    { value: 'vscode', label: 'VS Code', hint: '.vscode/mcp.json in the current folder' },
    { value: 'claude', label: 'Claude Code', hint: 'registered via the claude CLI' },
    { value: 'cursor', label: 'Cursor', hint: '~/.cursor/mcp.json' },
  ]);
  if (!['vs', 'vscode', 'cursor', 'claude'].includes(client)) {
    p.log.error(`Unknown client '${client}' — expected vs, vscode, cursor or claude.`);
    process.exitCode = 1;
    return;
  }

  const entry = serverEntry(target.url, apiKey, client === 'claude');

  if (client === 'claude') {
    await connectClaudeCode(entry);
    p.outro('Done — restart Claude Code to pick up the server.');
    return;
  }

  // 5. Merge into the editor config.
  const { file, key } = clientTarget(client);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const merged = mergeConfig(existing, key, SERVER_NAME, entry);
  if (!merged) {
    p.log.error(`${file} exists but is not valid JSON — fix or move it, then re-run.`);
    process.exitCode = 1;
    return;
  }

  if (merged.replaced && !opts.yes) {
    if (!await askConfirm(`'${SERVER_NAME}' is already configured in ${file} — replace it?`)) {
      p.outro('Nothing written.');
      return;
    }
  }

  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, merged.json, 'utf8');
  p.log.success(`${merged.replaced ? 'Updated' : 'Added'} '${SERVER_NAME}' in ${file}`);
  if (merged.siblings.length > 0) {
    p.log.info(`Left untouched: ${merged.siblings.join(', ')}`);
  }
  if (apiKey) {
    p.log.warn('The API key is stored in that file as plain text — do not commit it.');
  }

  p.note(
    client === 'vs'
      ? 'Restart Visual Studio, then switch Copilot Chat to Agent Mode.\n' +
        'Copilot also needs .github/copilot-instructions.md in a parent of\n' +
        'your solution folders — see docs/SETUP.md.'
      : 'Reload the window to pick up the new server.',
    'Next',
  );
  p.outro('Connected — no clone, no build, no index.');
}
