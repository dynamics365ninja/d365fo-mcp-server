/**
 * Find the session logs of a project, so `d365fo-mcp session --host <h>` does not
 * need the path of a file whose directory is named after a hash or a mangled path (#1329).
 *
 * Two hosts, two layouts:
 *
 *  - Claude Code: `~/.claude/projects/<mangled project path>/<sessionId>.jsonl`. The
 *    folder name is the project's absolute path with every character that is not a
 *    letter or digit replaced by `-` (`K:\repos\app` → `K--repos-app`). The drive
 *    letter's case differs between Claude Code versions, so names are compared
 *    case-insensitively and every folder that matches is read.
 *    Helper agents live in `<sessionId>/subagents/` — a directory, never listed here.
 *  - Copilot Chat: `<workspaceStorage>/<hash>/GitHub.copilot-chat/debug-logs/<id>/main.jsonl`.
 *    The hash belongs to the workspace and cannot be derived from its path, so it is
 *    found by reading each `<hash>/workspace.json` and matching its `folder` URI.
 *
 * Only an exact match of the project folder is used. A workspace opened on a
 * sub-folder is a different workspace, and sweeping everything below a path would
 * pull in sessions of unrelated work.
 *
 * Nothing here parses a log; it only says which files to hand to `readSessionLog`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type SessionHost = 'claude' | 'copilot';
export const SESSION_HOSTS: readonly SessionHost[] = ['claude', 'copilot'];

/**
 * A log below this size is an empty or aborted session — the header of a chat
 * the user opened and closed — and would only add a row of zeros.
 */
export const MIN_LOG_BYTES = 2048;

export interface LocateOptions {
  host: SessionHost;
  /** Absolute path of the project / workspace folder to find sessions for. */
  project: string;
  /** How many sessions, newest first. */
  last: number;
  /** Test seams; default to the real locations. */
  homeDir?: string;
  appDataDir?: string;
}

export interface LocatedLogs {
  /** Newest first, at most `last`. */
  files: string[];
  /** Logs that matched but were under MIN_LOG_BYTES, so were left out. */
  skippedSmall: number;
  /** Where we looked, for the "nothing found" message. */
  searched: string[];
}

/** How Claude Code names a project's folder: every non-alphanumeric becomes '-'. */
export function claudeProjectFolderName(project: string): string {
  return project.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * A comparable form of a folder path: forward slashes, no leading slash before a
 * drive letter (VS Code writes `/k:/repos/x`), no trailing slash, lower case.
 */
export function pathKey(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\/([A-Za-z]:)/, '$1')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** The folder a VS Code `workspace.json` points at, or null for a multi-root or remote workspace. */
export function workspaceFolder(json: string): string | null {
  let folder: unknown;
  try {
    folder = (JSON.parse(json) as { folder?: unknown }).folder;
  } catch {
    return null;
  }
  if (typeof folder !== 'string' || !folder.startsWith('file://')) return null;
  try {
    return decodeURIComponent(folder.slice('file://'.length));
  } catch {
    return null;
  }
}

interface Candidate { file: string; mtimeMs: number; size: number }

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function candidate(file: string): Candidate | null {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? { file, mtimeMs: st.mtimeMs, size: st.size } : null;
  } catch {
    return null;
  }
}

function claudeCandidates(opts: LocateOptions, searched: string[]): Candidate[] {
  const root = path.join(opts.homeDir ?? os.homedir(), '.claude', 'projects');
  searched.push(root);
  const wanted = claudeProjectFolderName(opts.project).toLowerCase();
  const out: Candidate[] = [];
  for (const dir of listDir(root)) {
    if (!dir.isDirectory() || dir.name.toLowerCase() !== wanted) continue;
    for (const entry of listDir(path.join(root, dir.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const c = candidate(path.join(root, dir.name, entry.name));
      if (c) out.push(c);
    }
  }
  return out;
}

/**
 * Where VS Code keeps per-user data. The platform's standard location under the home
 * folder, not `%APPDATA%` / `XDG_CONFIG_HOME`: a redirected profile is the rare case,
 * and the command's fallback is simply to take the log path as an argument.
 */
function defaultAppData(homeDir: string): string {
  if (process.platform === 'win32') return path.join(homeDir, 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support');
  return path.join(homeDir, '.config');
}

function copilotCandidates(opts: LocateOptions, searched: string[]): Candidate[] {
  const appData = opts.appDataDir ?? defaultAppData(opts.homeDir ?? os.homedir());
  const wanted = pathKey(opts.project);
  const out: Candidate[] = [];
  for (const product of ['Code', 'Code - Insiders']) {
    const root = path.join(appData, product, 'User', 'workspaceStorage');
    searched.push(root);
    for (const ws of listDir(root)) {
      if (!ws.isDirectory()) continue;
      let folder: string | null = null;
      try {
        folder = workspaceFolder(fs.readFileSync(path.join(root, ws.name, 'workspace.json'), 'utf8'));
      } catch { /* a storage folder without workspace.json is not a folder workspace */ }
      if (folder === null || pathKey(folder) !== wanted) continue;
      const logs = path.join(root, ws.name, 'GitHub.copilot-chat', 'debug-logs');
      for (const session of listDir(logs)) {
        if (!session.isDirectory()) continue;
        const c = candidate(path.join(logs, session.name, 'main.jsonl'));
        if (c) out.push(c);
      }
    }
  }
  return out;
}

/** The most recent session logs of a project, newest first. */
export function locateSessionLogs(opts: LocateOptions): LocatedLogs {
  const searched: string[] = [];
  const all = opts.host === 'claude' ? claudeCandidates(opts, searched) : copilotCandidates(opts, searched);
  const big = all.filter(c => c.size >= MIN_LOG_BYTES).sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    files: big.slice(0, Math.max(1, opts.last)).map(c => c.file),
    skippedSmall: all.length - big.length,
    searched,
  };
}
