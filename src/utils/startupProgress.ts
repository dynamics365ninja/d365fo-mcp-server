/**
 * What the server is doing while it cannot answer yet.
 *
 * A first start with an empty database indexes the whole packages directory
 * before `dbReady` resolves, and that is tens of minutes on a real install.
 * Every symbol-backed tool called meanwhile is answered with "still loading,
 * retry" — and until this module existed that sentence was all there was, the
 * same characters on the first attempt and on the twentieth, with no way for a
 * user to tell a build that is progressing from a server that has died. The
 * startup path publishes its phase here and the tool handler reads it, so the
 * wait says where it has got to and roughly what is left.
 *
 * Deliberately a module-level singleton rather than something on the context:
 * the writer is a worker-message handler in the startup sequence and the reader
 * is the tool dispatcher, and threading a channel between those two would touch
 * every layer in between to carry a string.
 */

import type { IndexProgress } from '../metadata/symbolIndex.js';

interface StartupIndexState {
  progress: IndexProgress;
  /** When this phase was entered — the basis for "N min in". */
  at: number;
  /** When the build itself started, so elapsed survives a phase change. */
  startedAt: number;
}

let state: StartupIndexState | null = null;

/** Note that a first-start index build has begun (before its first phase lands). */
export function startupIndexBegan(now = Date.now()): void {
  state = {
    progress: { phase: 'scanning', modelCount: 0 },
    at: now,
    startedAt: now,
  };
}

/** Record the phase the build has reached. */
export function setStartupIndexProgress(progress: IndexProgress, now = Date.now()): void {
  state = {
    progress,
    at: now,
    startedAt: state?.startedAt ?? now,
  };
}

/**
 * Forget the build. Called on success AND on failure: a stale phase outliving
 * the build it described would make the next "still loading" answer — which
 * would then be about something else entirely — cite a model that finished
 * indexing minutes ago.
 */
export function clearStartupIndexProgress(): void {
  state = null;
}

/** The raw state, for tests and for callers that want to render it themselves. */
export function getStartupIndexProgress(): Readonly<StartupIndexState> | null {
  return state;
}

/**
 * The whole answer a tool gets when it gave up waiting for the database.
 *
 * Lives here rather than in the dispatcher because the wording is a function of
 * the startup state this module owns — and because the dispatcher's job is to
 * route, which a layering test enforces by line count.
 */
export function describeDbWait(toolName: string, now = Date.now()): string {
  const building = describeStartupIndex(now);
  if (!building) {
    return '⏳ The MCP server is still loading the X++ symbol database (30–90 s on a normal ' +
      'start; a first start that indexes metadata can take several minutes). ' +
      'Please retry the request in a few seconds.';
  }
  return `⏳ ${building}\n\nThis has to finish before ${toolName} can be answered — it is a ` +
    'one-time cost, and the next start opens the finished database in seconds. Retry when the ' +
    'model count has moved on; the server log (set LOG_FILE) carries the same progress line by line.';
}

function minutes(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 90) return `${totalSec} s`;
  return `${Math.round(totalSec / 60)} min`;
}

/**
 * One sentence describing the build in flight, or null when none is.
 *
 * Says elapsed time rather than an estimate to completion. The models are
 * indexed largest-first and differ by two orders of magnitude in size, so
 * "3 of 32 models" is not 9 % of the work and any percentage derived from it
 * would be a confident lie — the honest signal is that the count keeps moving.
 */
export function describeStartupIndex(now = Date.now()): string | null {
  if (!state) return null;
  const { progress, startedAt } = state;
  const elapsed = minutes(now - startedAt);

  switch (progress.phase) {
    case 'scanning':
      return progress.modelCount > 0
        ? `Building the symbol index: sizing ${progress.modelCount} models to pick a build order (${elapsed} in).`
        : `Building the symbol index: starting up (${elapsed} in).`;
    case 'indexing': {
      const position = progress.modelIndex && progress.modelCount
        ? ` (model ${progress.modelIndex} of ${progress.modelCount}`
        : ' (';
      return `Building the symbol index: reading ${progress.model ?? 'a model'}` +
        `${position}, ${elapsed} in). Largest models are indexed first, so the later ones go faster.`;
    }
    case 'fts':
      return `Building the symbol index: last step, rebuilding full-text search over ` +
        `${progress.modelCount} models (${elapsed} in).`;
  }
}
