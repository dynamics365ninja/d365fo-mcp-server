/**
 * Warning baseline per model — what `build_d365fo_project` compares a green build against
 * so the reply can say "3 new, 18 known" instead of printing the same stable warnings again.
 *
 * Kept next to the build marker (`.last-build.json`) in the data dir, one entry per model.
 * A full build replaces the baseline; an incremental build only compiles what changed, so it
 * adds to it (a warning it does not repeat is not proof that the warning is gone).
 * Everything here is best-effort bookkeeping: a failed read or write degrades to "no
 * baseline", which is exactly the old behaviour of listing every warning.
 */

import * as fs from 'fs';
import * as path from 'path';

export const WARNING_BASELINE_FILENAME = '.warning-baseline.json';

/** The fields of a parsed xppc diagnostic that identify and describe a warning. */
export interface BaselineWarning {
  severity: 'error' | 'warning';
  kind?: string;
  model?: string;
  object?: string;
  member?: string;
  line?: number;
  message: string;
}

interface BaselineEntry {
  updatedAt: string;
  warnings: string[];
}

export interface WarningDelta {
  /** Warnings absent from the baseline, in log order, deduplicated. */
  newWarnings: BaselineWarning[];
  /** Distinct warnings that were already in the baseline. */
  knownCount: number;
  /** False on the first recorded build of a model: nothing to compare against yet. */
  hadBaseline: boolean;
  /** The file that holds the known warnings. */
  file: string;
}

/** Identity of a warning: where it is and what it says, never the line number. */
export function warningKey(d: BaselineWarning): string {
  return [d.model ?? '', d.kind ?? '', d.object ?? '', d.member ?? '', d.message].join('|');
}

function baselinePath(dataDir: string): string {
  return path.join(dataDir, WARNING_BASELINE_FILENAME);
}

function readAll(dataDir: string): Record<string, BaselineEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(baselinePath(dataDir), 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, BaselineEntry>;
  } catch {
    return {};
  }
}

/**
 * Compare `warnings` with the model's baseline, then store the result as the new baseline
 * (replaced on a full build, merged otherwise). Call it for a build with zero errors only.
 */
export function updateWarningBaseline(
  dataDir: string,
  modelName: string,
  warnings: BaselineWarning[],
  fullBuild: boolean,
): WarningDelta {
  const file = baselinePath(dataDir);
  const entry = readAll(dataDir)[modelName];
  const previous = entry && Array.isArray(entry.warnings) ? new Set(entry.warnings) : undefined;
  const seen = new Set<string>();
  const newWarnings: BaselineWarning[] = [];
  let knownCount = 0;
  for (const w of warnings) {
    if (w.severity !== 'warning') continue;
    const key = warningKey(w);
    if (seen.has(key)) continue;
    seen.add(key);
    if (previous?.has(key)) knownCount++;
    else newWarnings.push(w);
  }
  const stored = fullBuild || !previous ? seen : new Set([...previous, ...seen]);
  try {
    const all = readAll(dataDir);
    all[modelName] = { updatedAt: new Date().toISOString(), warnings: [...stored].sort() };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
  } catch {
    /* bookkeeping only — never fail a build over it */
  }
  return { newWarnings, knownCount, hadBaseline: previous !== undefined, file };
}

/** The reply block for a delta; empty on the first build, where there is nothing to say. */
export function describeWarningDelta(delta: WarningDelta): string {
  if (!delta.hadBaseline) return '';
  const lines = [`Warnings: ${delta.newWarnings.length} new, ${delta.knownCount} known ` +
    `(known ones are not listed; they are kept in ${delta.file})`];
  for (const w of delta.newWarnings) {
    const where = w.object
      ? `${w.object}${w.member ? `.${w.member}` : ''}${w.line ? ` (line ${w.line})` : ''}`
      : '(no location)';
    lines.push(`  🟡 ${where}: ${w.message}`);
  }
  return lines.join('\n') + '\n';
}
