/**
 * `run_bp_check` objects: ["git:<ref>"] — check only the objects that differ from a git ref.
 *
 * The ref rides in the existing `objects` parameter as a magic entry instead of a new
 * parameter, which keeps the published schema almost free. The diff is the working tree
 * against the merge base of the ref and HEAD, plus untracked files, so a commit that is not
 * pushed yet and an edit that is not committed are both covered.
 */

import { execFile } from 'child_process';
import path from 'path';
import util from 'util';

const execFileAsync = util.promisify(execFile);

export const CHANGED_SINCE_PREFIX = 'git:';

/** AOT folder → the element type xppbp takes. Folders with no xppbp type are not checkable. */
const FOLDER_TO_ELEMENT_TYPE: Record<string, string> = {
  axclass: 'class',
  axtable: 'table',
  axtableextension: 'tableextension',
  axform: 'form',
  axformextension: 'formextension',
  axenum: 'enum',
  axedt: 'edt',
  axview: 'view',
  axquery: 'query',
  axmap: 'map',
  axdataentityview: 'dataentityview',
  axreport: 'report',
  axmenu: 'menu',
  axservice: 'service',
  axmacrodictionary: 'macro',
};

/** Pull a `git:<ref>` entry out of `objects`; the remaining entries stay as they were. */
export function splitChangedSince(params: any): { ref?: string; rest: any } {
  const raw = params?.objects;
  if (raw === undefined || raw === null) return { rest: params };
  const list = Array.isArray(raw) ? raw : [raw];
  let ref: string | undefined;
  const kept: unknown[] = [];
  for (const entry of list) {
    const text = typeof entry === 'string' ? entry
      : entry && typeof entry === 'object' && typeof (entry as any).objectName === 'string'
        && !(entry as any).objectType ? (entry as any).objectName : undefined;
    if (text !== undefined && text.trim().toLowerCase().startsWith(CHANGED_SINCE_PREFIX)) {
      ref = text.trim().slice(CHANGED_SINCE_PREFIX.length).trim();
    } else {
      kept.push(entry);
    }
  }
  if (ref === undefined) return { rest: params };
  return { ref, rest: { ...params, objects: kept.length > 0 ? kept : undefined } };
}

/** A ref is passed to git as an argument, never to a shell; still refuse anything option-like. */
export function isSafeRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith('-') && !/[\s\u0000-\u001f]/.test(ref);
}

/** Objects of `modelName` named by changed file paths; other files are counted, not dropped silently. */
export function objectsFromChangedFiles(
  files: string[],
  modelName: string,
): { objects: Array<{ name: string; elementType: string }>; skipped: number } {
  const seen = new Set<string>();
  const objects: Array<{ name: string; elementType: string }> = [];
  let skipped = 0;
  for (const file of files) {
    const parts = file.split(/[\\/]+/).filter(Boolean);
    const base = parts.at(-1) ?? '';
    const folder = parts.at(-2)?.toLowerCase();
    const parent = parts.at(-3);
    if (!base.toLowerCase().endsWith('.xml') || !folder?.startsWith('ax')) continue;
    if (!parent || parent.toLowerCase() !== modelName.toLowerCase()) continue;
    const elementType = FOLDER_TO_ELEMENT_TYPE[folder];
    if (!elementType) { skipped++; continue; }
    const name = base.slice(0, -'.xml'.length);
    const key = `${elementType}:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    objects.push({ name, elementType });
  }
  return { objects, skipped };
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 20, timeout: 30_000,
  });
  return stdout;
}

/**
 * The changed files under the first candidate directory that is inside a git work tree.
 * Returns an error sentence instead of throwing: a bad ref or a missing repo is the caller's
 * answer, not a crash.
 */
export async function changedFilesSince(
  ref: string,
  candidates: Array<string | null | undefined>,
): Promise<{ files: string[]; repo: string } | { error: string }> {
  if (!isSafeRef(ref)) return { error: `"${ref}" is not a usable git ref.` };
  let repo: string | undefined;
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      repo = (await git(['rev-parse', '--show-toplevel'], dir)).trim() || undefined;
    } catch { /* not a work tree — try the next */ }
    if (repo) break;
  }
  if (!repo) {
    return { error: 'no git work tree found around the workspace, the project or the model folder, ' +
      'so there is nothing to compare with. Pass objects by name instead.' };
  }
  try {
    let base = ref;
    try { base = (await git(['merge-base', ref, 'HEAD'], repo)).trim() || ref; } catch { /* unrelated histories: diff against the ref itself */ }
    const tracked = await git(['diff', '--name-only', '--diff-filter=d', base, '--'], repo);
    const untracked = await git(['ls-files', '--others', '--exclude-standard'], repo);
    const files = [...tracked.split('\n'), ...untracked.split('\n')]
      .map(l => l.trim()).filter(Boolean).map(f => path.join(repo!, f));
    return { files, repo };
  } catch (e: any) {
    return { error: `git could not diff against "${ref}": ${String(e?.stderr || e?.message || e).trim().split('\n')[0]}` };
  }
}
