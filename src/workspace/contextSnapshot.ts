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
/** How many uncommitted files to surface. */
const UNCOMMITTED_LIMIT = 25;

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
  };
  /**
   * Most-recently modified X++ object — proxy for the active file. Null when no
   * workspace/files are detected. See ActiveObject for the editor-focus caveat.
   */
  activeObject: ActiveObject | null;
  /** Most-recently edited X++ objects in the workspace (mtime desc). */
  recentObjects: RecentObject[];
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
  context: XppServerContext
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
  };
  try {
    // Off-thread + memoized — the synchronous count getters block the event
    // loop for 30-60 s on a cold 2 GB DB, which would starve the MCP transport
    // during the very first get_workspace_info call.
    const counts = await symbolIndex.getSymbolCounts();
    index.totalSymbols = counts.total;
    index.byType = counts.byType;
    index.indexedModels = Array.from(symbolIndex.getIndexedModels()).sort();
    index.lastIndexedAt = symbolIndex.getLastIndexedAt?.() ?? null;
  } catch {
    /* index may not be built yet */
  }

  // Recently-edited objects (mtime desc)
  let recentObjects: RecentObject[] = [];
  if (workspacePath) {
    try {
      const files = await workspaceScanner.scanWorkspace(workspacePath);
      recentObjects = files
        .slice()
        .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
        .slice(0, RECENT_OBJECTS_LIMIT)
        .map((f) => ({
          name: f.name,
          type: f.type,
          path: f.path,
          modifiedAt: f.lastModified.toISOString(),
        }));
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
    uncommittedFiles,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Render the snapshot's "live" portion (recent objects + uncommitted changes)
 * as markdown lines for embedding in get_workspace_info. Identity/prefix/index
 * sections are already covered by that tool, so this only adds what is new.
 */
export function renderContextSnapshotSection(snapshot: ContextSnapshot): string[] {
  const lines: string[] = ['## Context Snapshot', ''];

  if (snapshot.activeObject) {
    const a = snapshot.activeObject;
    lines.push(
      `Active object (most recently modified): ${a.name} [${a.type}] — ${a.modifiedAt.replace('T', ' ').slice(0, 16)}`,
      ''
    );
  }

  if (snapshot.recentObjects.length === 0) {
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
    lines.push('Review them with: review_workspace_changes');
  }

  return lines;
}
