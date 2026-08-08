/**
 * What workspace detection resolved, and from which source.
 *
 * The detector used to warn from inside its own last fallback: "⚠️ Could not
 * auto-detect D365FO project from any source", printed roughly two seconds into
 * startup, before the sources it needs were up. Detection then succeeded by
 * another route — the packagePath scan, the solutions-path scan, .mcp.json — and
 * the warning stayed in the log, blaming configuration that was fine (#833).
 *
 * The detector therefore only RECORDS what it tried; whether that is worth a
 * warning is decided here, once, at the moment a caller actually needs a project
 * and every source has had its chance. A success recorded after a warning
 * retracts it, because a stale warning in a log is indistinguishable from a live
 * one.
 */

import { debugLog } from './logger.js';

export interface WorkspaceDetectionStatus {
  /** True once any source produced a model. */
  resolved: boolean;
  /** Which source won — the answer to "why this model?". */
  source: string | null;
  modelName: string | null;
  projectPath: string | null;
  /** Sources the most recent unsuccessful pass looked at, in order. */
  tried: string[];
  /** Detection passes run so far (a retry after new sources appear is a second). */
  attempts: number;
  /** True once the unresolved warning has actually been printed. */
  warned: boolean;
}

const status: WorkspaceDetectionStatus = {
  resolved: false,
  source: null,
  modelName: null,
  projectPath: null,
  tried: [],
  attempts: 0,
  warned: false,
};

/** A source produced a model. Retracts an earlier warning if one was printed. */
export function recordDetectionSuccess(
  source: string,
  modelName: string,
  projectPath?: string | null,
): void {
  // Re-recording the same answer is not a new attempt: several callers pass
  // through the same resolution and the attempt count is what the warning cites.
  if (status.resolved && status.source === source && status.modelName === modelName) return;

  const wasWarned = status.warned && !status.resolved;
  status.resolved = true;
  status.source = source;
  status.modelName = modelName;
  status.projectPath = projectPath ?? null;
  status.attempts++;
  status.warned = false;

  if (wasWarned) {
    console.error(
      `[WorkspaceDetector] ✅ Detection resolved after all: model "${modelName}" from ${source} ` +
      `— the earlier "could not auto-detect" warning no longer applies`
    );
  }
}

/**
 * A pass ended without a model. Deliberately silent: the sources it lists may
 * still come up, and reportUnresolvedDetection() decides when that has stopped
 * being plausible.
 */
export function recordDetectionFailure(tried: string[]): void {
  if (status.resolved) return;
  status.tried = tried;
  status.attempts++;
  debugLog(`[WorkspaceDetector] No project from: ${tried.join(', ') || '(no source available)'}`);
}

/** The current state — for doctor, get_workspace_info and tests. */
export function getWorkspaceDetectionStatus(): Readonly<WorkspaceDetectionStatus> {
  return { ...status };
}

/**
 * Warn that no project could be detected — once, and only while that is still
 * true. Returns true when a warning was printed.
 */
export function reportUnresolvedDetection(): boolean {
  if (status.resolved || status.warned) return false;
  status.warned = true;
  console.error(
    `[WorkspaceDetector] ⚠️ Could not auto-detect a D365FO project after ${status.attempts} ` +
    `attempt(s). Sources tried: ${status.tried.join(', ') || '(none available)'}. ` +
    `Set modelName/projectPath in .mcp.json, or D365FO_SOLUTIONS_PATH, to resolve it explicitly.`
  );
  return true;
}

/** One line for `d365fo-mcp doctor` and startup diagnostics. */
export function describeWorkspaceDetection(): string {
  if (status.resolved) {
    return `model "${status.modelName}" detected from ${status.source}` +
      (status.projectPath ? ` (${status.projectPath})` : '');
  }
  return `no D365FO project detected — tried: ${status.tried.join(', ') || '(none available)'}`;
}

/** Test isolation, and a workspace switch that starts detection over. */
export function resetWorkspaceDetectionStatus(): void {
  status.resolved = false;
  status.source = null;
  status.modelName = null;
  status.projectPath = null;
  status.tried = [];
  status.attempts = 0;
  status.warned = false;
}
