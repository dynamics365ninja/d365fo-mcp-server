/**
 * Inline post-write verification for the create/modify paths.
 *
 * The conventional loop is create → verify_d365fo_project → run_bp_check: two
 * extra round trips per object, both asking questions the writing call already
 * had the answers to. It knows the path it wrote and the project it registered
 * the file in; checking that the bytes are on disk and that the .rnrproj really
 * references them is two filesystem reads, not a round trip.
 *
 * Kept deliberately narrow. This is NOT verify_d365fo_project — that tool sweeps
 * a whole project and cross-checks every object, which is a different job and
 * still worth its own call. This answers only "did the thing I just claimed to
 * do actually land", which is precisely the question the follow-up call was
 * being spent on.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Parser } from 'xml2js';

export interface WriteVerification {
  /** The file exists on disk and is non-empty. */
  onDisk: boolean;
  /** Byte length written, when readable. */
  bytes?: number;
  /** True/false when a project path was supplied and readable; undefined otherwise. */
  inProject?: boolean;
}

/** True when `projectPath`'s .rnrproj has a Content Include resolving to `filePath`. */
async function isReferencedByProject(projectPath: string, filePath: string): Promise<boolean | undefined> {
  try {
    const xml = await fs.readFile(projectPath, 'utf-8');
    const parsed = await new Parser({ explicitArray: true }).parseStringPromise(xml);
    const projectDir = path.dirname(projectPath);
    const target = path.resolve(filePath).toLowerCase();

    for (const group of (parsed?.Project?.ItemGroup ?? []) as any[]) {
      const contents: any[] = Array.isArray(group?.Content) ? group.Content : [];
      for (const c of contents) {
        const include: string | undefined = c?.$?.Include;
        if (!include) continue;
        // Includes are project-relative, and Windows-relative at that; resolve
        // rather than string-compare, or a legitimate entry reads as missing.
        if (path.resolve(projectDir, include.replace(/\\/g, path.sep)).toLowerCase() === target) return true;
      }
    }
    return false;
  } catch {
    // Unreadable/absent project file is not evidence either way — say nothing
    // rather than report a false "not registered" on a write that was fine.
    return undefined;
  }
}

/** Check that a just-written file is where it should be. Never throws. */
export async function verifyWrittenFile(
  filePath: string | undefined,
  projectPath?: string,
): Promise<WriteVerification> {
  if (!filePath) return { onDisk: false };
  try {
    const stat = await fs.stat(filePath);
    const result: WriteVerification = { onDisk: stat.isFile() && stat.size > 0, bytes: stat.size };
    if (projectPath) result.inProject = await isReferencedByProject(projectPath, filePath);
    return result;
  } catch {
    return { onDisk: false };
  }
}

/**
 * Opt-in best-practice check on the object just written.
 *
 * Off by default and deliberately so: xppbp needs the compiler and takes
 * seconds, which is the wrong trade for the common case. But when the caller
 * knows it wants one — the last object of a feature, say — running it here
 * saves the round trip that the separate run_bp_check call costs, and this call
 * already knows the object's type and name.
 *
 * `bpCheck` is not in the wire schema; it is accepted nested in `params` like
 * every other d365fo_file knob, and documented in the op-spec. It costs no
 * schema bytes and the budget has none to spare.
 */
export async function runInlineBpCheck(
  bpCheck: unknown,
  objectType: string,
  objectName: string,
  context: unknown,
): Promise<string> {
  if (bpCheck !== true && bpCheck !== 'true') return '';
  try {
    const { runBpCheckTool } = await import('./runBpCheck.js');
    const result: any = await runBpCheckTool({ objects: [{ objectType, objectName }] }, context as any);
    const text = (result?.content ?? [])
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n')
      .trim();
    return text ? `\n\n### Best-practice check (bpCheck=true)\n${text}` : '';
  } catch (e: any) {
    // Never turn a successful write into a failure over an advisory check.
    return `\n⚠️ bpCheck requested but could not run: ${e?.message ?? e}`;
  }
}

/** One-line summary for a write response, or '' when there is nothing worth saying. */
export function renderWriteVerification(v: WriteVerification): string {
  if (!v.onDisk) {
    return `\n❌ Verification: the file is NOT on disk after a reported success — treat this write as failed.`;
  }
  const parts = [`on disk (${v.bytes} bytes)`];
  if (v.inProject === true) parts.push('referenced by the .rnrproj');
  // Only the negative is worth the bytes; `undefined` means we could not tell.
  if (v.inProject === false) {
    return `\n✅ Verified: ${parts.join(', ')}` +
           `\n⚠️ Verification: the .rnrproj does NOT reference this file — it will not compile until it does.`;
  }
  return `\n✅ Verified: ${parts.join(', ')}.`;
}
