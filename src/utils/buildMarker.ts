/**
 * Build marker — the note `build_d365fo_project` leaves for the tools that report a
 * verdict without compiling anything.
 *
 * Why it exists: run_bp_check and verify_d365fo_project both answer confidently and
 * neither one compiles. xppbp does not diagnose the SYS-class compiler errors (an
 * `if (ret) { ret = next foo(); }` in a CoC method is SYS10028, and xppbp is silent),
 * and verify only proves a file is on disk and in the .rnrproj. Benchmark run
 * f2e7b71a skipped the build entirely, was told "✅ BP Check passed — 0 with findings"
 * plus a fully green verification table, and shipped a class that does not compile.
 *
 * Nothing here blocks anything. It records when a model last built cleanly so those
 * tools can say "and nothing has compiled this since you changed it" instead of
 * implying a green light they never checked for.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Written next to the metadata databases, one entry per model. */
export const BUILD_MARKER_FILENAME = '.last-build.json';

export interface ModelBuildRecord {
  /** ISO timestamp of the build that produced this record. */
  builtAt: string;
  /** Whether it was a full build; an incremental green is not proof the model compiles. */
  fullBuild: boolean;
  /** True only for a build with zero errors. Warnings still count as succeeded. */
  succeeded: boolean;
}

export type BuildMarker = Record<string, ModelBuildRecord>;

function markerPath(dataDir: string): string {
  return path.join(dataDir, BUILD_MARKER_FILENAME);
}

function readAll(dataDir: string): BuildMarker {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath(dataDir), 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as BuildMarker;
  } catch {
    // No marker yet, or unreadable — the caller degrades to "never built here".
    return {};
  }
}

/**
 * Record the outcome of a build. Best-effort: a build succeeds even if this write
 * fails, so callers do not need to handle an error here.
 */
export function recordBuild(dataDir: string, modelName: string, record: ModelBuildRecord): void {
  try {
    const all = readAll(dataDir);
    all[modelName] = record;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(markerPath(dataDir), JSON.stringify(all, null, 2));
  } catch {
    /* diagnostics only — never fail a build over its own bookkeeping */
  }
}

/** The last recorded build for `modelName`, or undefined if it never built here. */
export function readBuildRecord(dataDir: string, modelName: string): ModelBuildRecord | undefined {
  const rec = readAll(dataDir)[modelName];
  if (!rec || typeof rec.builtAt !== 'string') return undefined;
  return {
    builtAt: rec.builtAt,
    fullBuild: rec.fullBuild === true,
    succeeded: rec.succeeded === true,
  };
}

/**
 * One line describing whether this model has been compiled since the objects were
 * last written — the caveat a non-compiling verdict carries.
 *
 * `files` is optional because the callers differ: verify_d365fo_project already
 * resolves each object's path and can prove staleness, while run_bp_check only knows
 * names. With no paths the answer is coarser ("nothing has built this model") but it
 * is the case that actually went wrong, so it is worth saying either way.
 *
 * Phrased as a statement of fact rather than an instruction: the caller is reporting
 * its own result, and this is what that result does not cover.
 */
export function describeBuildFreshness(dataDir: string, modelName: string, files: string[] = []): string {
  let newestWrite = 0;
  for (const f of files) {
    try {
      const t = fs.statSync(f).mtimeMs;
      if (t > newestWrite) newestWrite = t;
    } catch {
      /* the caller already reports missing files */
    }
  }

  const rec = readBuildRecord(dataDir, modelName);
  if (!rec || !rec.succeeded) {
    return (
      `⚠️ Not compiled — no successful build of ${modelName} is recorded on this machine. ` +
      'This is not a compile check: xppbp does not diagnose SYS-class compiler errors ' +
      '(SYS10028 "next must be called once and unconditionally" is the common one). ' +
      'Run build_d365fo_project(fullBuild: true) before scoring the task done.'
    );
  }

  const builtAt = Date.parse(rec.builtAt);
  if (newestWrite > 0 && (Number.isNaN(builtAt) || builtAt < newestWrite)) {
    return (
      `⚠️ Stale — ${modelName} last built ${rec.builtAt}, but these objects were written after that. ` +
      'Nothing has compiled the current state; run build_d365fo_project(fullBuild: true).'
    );
  }

  return rec.fullBuild
    ? `✅ Compiled — full build of ${modelName} succeeded at ${rec.builtAt}.`
    : `ℹ️ Last build of ${modelName} (${rec.builtAt}) was INCREMENTAL — only changed elements were compiled. ` +
        'Use build_d365fo_project(fullBuild: true) before trusting a green result.';
}
