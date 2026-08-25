/**
 * Workspace Context Snapshot
 *
 * Phase 1 of the "context pipeline": a single, curated snapshot of what the
 * developer is currently working on. Assembled from the pieces the server
 * already knows about — the config manager (model/project/env/roots), the
 * symbol index (stats + freshness), the workspace scanner (recently edited
 * objects by mtime) and git (uncommitted X++ changes).
 *
 * This module is the shared source of truth consumed by BOTH:
 *   • the MCP resource layer (workspace://context, workspace://stats, …), and
 *   • the get_workspace_info tool (its "Context Snapshot" section).
 *
 * It is deliberately pull-based and best-effort: every external call is guarded
 * so a missing git binary, a non-repo workspace or an unbuilt index can never
 * break the caller. MCP cannot push context into the model's prompt, so the
 * value here is making a high-signal default context one cheap call away.
 */

import { execFile } from 'child_process';
import util from 'util';
import { getConfigManager } from '../utils/configManager.js';
import { getStdioSessionInfo } from '../utils/stdioSessionInfo.js';
import type { XppServerContext } from '../types/context.js';
import type { WorkspaceFile } from './workspaceScanner.js';

const execFileAsync = util.promisify(execFile);

/** How many recently-modified workspace objects to surface. */
const RECENT_OBJECTS_LIMIT = 10;
/**
 * How long a completed workspace scan answers for on the non-blocking path.
 *
 * Same 30 s as the metadata-mtime scan cache (indexStaleness.ts), and for the
 * same reason: the walk is the expensive part, and a snapshot half a minute old
 * is still an accurate answer to "what is being worked on".
 */
const RECENT_CACHE_MS = 30_000;
const recentCache = new Map<string, { at: number; objects: RecentObject[] }>();
const recentScanInFlight = new Set<string>();

/** How many uncommitted files to surface. */
const UNCOMMITTED_LIMIT = 25;

/** Drop the cached workspace scan (test isolation, or after a known write). */
export function resetRecentObjectsCache(): void {
  recentCache.clear();
  recentScanInFlight.clear();
}

export interface RecentObject {
  name: string;
  type: WorkspaceFile['type'];
  path: string;
  modifiedAt: string; // ISO 8601
}

/**
 * Best-effort "what the developer is working on now". MCP exposes workspace
 * roots, not editor focus, so this is the most-recently-modified X++ object —
 * a good proxy for the active file, not a guarantee of editor cursor state.
 */
export type ActiveObject = RecentObject;

export interface ContextSnapshot {
  model: string | null;
  modelSource: string;
  projectPath: string | null;
  workspacePath: string | null;
  envType: string;
  roots: string[];
  index: {
    totalSymbols: number;
    byType: Record<string, number>;
    indexedModels: string[];
    lastIndexedAt: string | null;
    /**
     * True when the counts are being computed off-thread and this snapshot was
     * rendered without them. Never means "zero" — see buildContextSnapshot.
     */
    countsPending: boolean;
  };
  /**
   * Most-recently modified X++ object — proxy for the active file. Null when no
   * workspace/files are detected. See ActiveObject for the editor-focus caveat.
   */
  activeObject: ActiveObject | null;
  /** Most-recently edited X++ objects in the workspace (mtime desc). */
  recentObjects: RecentObject[];
  /**
   * True when the workspace scan behind `recentObjects`/`activeObject` is still
   * running and this snapshot was rendered without it. Never means "the
   * workspace is empty" — see buildContextSnapshot.
   */
  recentPending: boolean;
  /** X++ files changed vs HEAD (uncommitted), relative to the repo root. */
  uncommittedFiles: string[];
  generatedAt: string;
}

/**
 * Run a git command, returning trimmed stdout or null on any failure
 * (git missing, not a repo, timeout). Never throws.
 */
async function gitSafe(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 10,
      timeout: 15_000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * List uncommitted X++ metadata files (.xml) relative to the repo containing
 * `workspacePath`. Best-effort: returns [] when git is unavailable or the
 * workspace is not a git repo.
 */
async function getUncommittedXppFiles(workspacePath: string | null): Promise<string[]> {
  if (!workspacePath) return [];
  // diff HEAD covers staged+unstaged tracked changes; ls-files -o adds untracked files.
  const tracked = await gitSafe(['diff', 'HEAD', '--name-only'], workspacePath);
  const untracked = await gitSafe(
    ['ls-files', '--others', '--exclude-standard'],
    workspacePath
  );
  if (tracked === null && untracked === null) return [];

  const files = new Set<string>();
  for (const block of [tracked, untracked]) {
    if (!block) continue;
    for (const line of block.split('\n')) {
      const rel = line.trim();
      if (rel && rel.toLowerCase().endsWith('.xml')) files.add(rel);
    }
  }
  return Array.from(files).slice(0, UNCOMMITTED_LIMIT);
}

/**
 * Build the curated workspace context snapshot. Every section degrades
 * gracefully — a failure in one source leaves the others intact.
 */
export async function buildContextSnapshot(
  context: XppServerContext,
  opts: { blocking?: boolean } = {},
): Promise<ContextSnapshot> {
  const configManager = getConfigManager();
  const { symbolIndex, workspaceScanner } = context;

  // Identity (model / project / env)
  let model: string | null = null;
  let modelSource = 'unknown';
  let projectPath: string | null = null;
  let envType = 'unknown';
  try {
    const diag = await configManager.getWorkspaceInfoDiagnostics();
    model = diag.modelName;
    modelSource = diag.modelSource;
    projectPath = diag.projectPath;
  } catch {
    /* diagnostics best-effort */
  }
  try {
    envType = await configManager.getDevEnvironmentType();
  } catch {
    /* env type best-effort */
  }

  const workspacePath =
    configManager.getWorkspacePath() ||
    process.env.D365FO_WORKSPACE_PATH ||
    null;

  const roots = getStdioSessionInfo().lastRoots ?? [];

  // Index stats + freshness
  const index = {
    totalSymbols: 0,
    byType: {} as Record<string, number>,
    indexedModels: [] as string[],
    lastIndexedAt: null as string | null,
    countsPending: false,
  };
  try {
    // Off-thread and memoized, but NOT free: `getSymbolCounts()` is a full index
    // scan on a cold cache — the comment on getSymbolCount in symbolIndex.ts puts
    // it at 30–60 s on a large production DB — and awaiting it here is what made
    // the FIRST get_workspace_info of a session pay for it (31.5 s average over
    // 31 real calls; the tool is neither bridge-gated nor DB-gated, so the cost
    // was inside it). `getCachedSymbolCounts()` exists precisely so a request path
    // never blocks on the scan.
    //
    // So: serve the memoized value when there is one, otherwise kick the
    // computation off and SAY that it is running. `blocking: true`
    // (diagnostics=true) still waits, because the full picture is what
    // diagnostics is for.
    const counts = opts.blocking
      ? await symbolIndex.getSymbolCounts()
      : symbolIndex.getCachedSymbolCounts?.() ?? null;
    if (counts) {
      index.totalSymbols = counts.total;
      index.byType = counts.byType;
    } else {
      index.countsPending = true;
      // Not awaited: it memoizes itself, so the next snapshot has the number.
      void symbolIndex.getSymbolCounts().catch(() => { /* counts are best-effort */ });
    }
    index.indexedModels = Array.from(symbolIndex.getIndexedModels()).sort();
    index.lastIndexedAt = symbolIndex.getLastIndexedAt?.() ?? null;
  } catch {
    /* index may not be built yet */
  }

  // Recently-edited objects (mtime desc).
  //
  // scanWorkspace globs `**/*.xml` under the workspace root and stats every hit
  // — unbounded, and on a packages-rooted workspace that is minutes, not
  // milliseconds. It has its own cache, but the FIRST call of a session pays the
  // whole walk, on the response path, in the tool a session starts with. So the
  // default read takes the scanner's cached answer if it has one and otherwise
  // says the scan is running; `blocking: true` (diagnostics=true) waits.
  let recentObjects: RecentObject[] = [];
  let recentPending = false;
  if (workspacePath) {
    const toRecent = (files: WorkspaceFile[]): RecentObject[] => files
      .slice()
      .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
      .slice(0, RECENT_OBJECTS_LIMIT)
      .map((f) => ({
        name: f.name,
        type: f.type,
        path: f.path,
        modifiedAt: f.lastModified.toISOString(),
      }));
    try {
      const cached = recentCache.get(workspacePath);
      if (opts.blocking) {
        recentObjects = toRecent(await workspaceScanner.scanWorkspace(workspacePath));
        recentCache.set(workspacePath, { at: Date.now(), objects: recentObjects });
      } else if (cached && Date.now() - cached.at < RECENT_CACHE_MS) {
        recentObjects = cached.objects;
      } else {
        recentPending = true;
        // Not awaited. The result lands in the cache above, so the NEXT call
        // shows it — the information is deferred, never dropped.
        if (!recentScanInFlight.has(workspacePath)) {
          recentScanInFlight.add(workspacePath);
          void workspaceScanner.scanWorkspace(workspacePath)
            .then(files => { recentCache.set(workspacePath, { at: Date.now(), objects: toRecent(files) }); })
            .catch(() => { /* scanning best-effort */ })
            .finally(() => { recentScanInFlight.delete(workspacePath); });
        }
      }
    } catch {
      /* scanning best-effort */
    }
  }

  // Uncommitted X++ changes
  const uncommittedFiles = await getUncommittedXppFiles(workspacePath);

  return {
    model,
    modelSource,
    projectPath,
    workspacePath,
    envType,
    roots,
    index,
    activeObject: recentObjects[0] ?? null,
    recentObjects,
    recentPending,
    uncommittedFiles,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Render the snapshot's "live" portion (recent objects + uncommitted changes)
 * as markdown lines for embedding in get_workspace_info. Identity/prefix/index
 * sections are already covered by that tool, so this only adds what is new.
 */
/** How many recent objects the compact rendering names before summarising. */
const COMPACT_RECENT_SHOWN = 3;

/**
 * The same "live" portion as renderContextSnapshotSection, folded into at most
 * two lines for get_workspace_info's default output. Names only enough recent
 * objects to orient the agent — the full list, with timestamps and every
 * uncommitted path, stays behind diagnostics=true and changes=true.
 */
export function renderContextSnapshotCompact(snapshot: ContextSnapshot): string[] {
  const lines: string[] = [];

  if (snapshot.recentPending) {
    // One line, first call of a session only. Silence here would read as "you
    // have edited nothing", which is a different — and wrong — statement.
    lines.push('Recent edits: workspace scan running in the background (call again for the list)');
  } else if (snapshot.recentObjects.length > 0) {
    const shown = snapshot.recentObjects
      .slice(0, COMPACT_RECENT_SHOWN)
      .map(o => `${o.name} [${o.type}]`);
    const rest = snapshot.recentObjects.length - shown.length;
    lines.push(`Recent edits: ${shown.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}`);
  }

  if (snapshot.uncommittedFiles.length > 0) {
    lines.push(
      `Uncommitted : ${snapshot.uncommittedFiles.length} X++ file(s) — get_workspace_info(changes=true)`
    );
  }

  return lines;
}

export function renderContextSnapshotSection(snapshot: ContextSnapshot): string[] {
  const lines: string[] = ['## Context Snapshot', ''];

  // Said rather than omitted: a snapshot rendered before the off-thread count
  // finished used to show nothing here, which reads as "the index is empty".
  if (snapshot.index.countsPending) {
    lines.push(
      'Indexed symbols: still being computed in the background — call again for the number ' +
      '(get_workspace_info(diagnostics=true) waits for it).',
      '',
    );
  } else if (snapshot.index.totalSymbols > 0) {
    lines.push(
      `Indexed symbols: ${snapshot.index.totalSymbols.toLocaleString('en-US')} ` +
      `across ${snapshot.index.indexedModels.length} model(s)`,
      '',
    );
  }

  if (snapshot.activeObject) {
    const a = snapshot.activeObject;
    lines.push(
      `Active object (most recently modified): ${a.name} [${a.type}] — ${a.modifiedAt.replace('T', ' ').slice(0, 16)}`,
      ''
    );
  }

  if (snapshot.recentPending) {
    lines.push(
      'Recently edited objects: _workspace scan still running — call again, ' +
      'or get_workspace_info(diagnostics=true) to wait for it_',
    );
  } else if (snapshot.recentObjects.length === 0) {
    lines.push('Recently edited objects: _none detected in the workspace_');
  } else {
    lines.push('Recently edited objects (most recent first):');
    for (const obj of snapshot.recentObjects) {
      const when = obj.modifiedAt.replace('T', ' ').slice(0, 16);
      lines.push(`  • ${obj.name.padEnd(40)} ${obj.type.padEnd(8)} ${when}`);
    }
  }

  lines.push('');
  if (snapshot.uncommittedFiles.length === 0) {
    lines.push('Uncommitted X++ changes: _none (or workspace is not a git repo)_');
  } else {
    lines.push(`Uncommitted X++ changes (${snapshot.uncommittedFiles.length}):`);
    for (const f of snapshot.uncommittedFiles) {
      lines.push(`  • ${f}`);
    }
    lines.push('');
    lines.push('Review them with: get_workspace_info(changes=true)');
  }

  return lines;
}
