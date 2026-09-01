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
import {
  resolveMembership, renderMembership, axFolderForObjectType, type Membership,
} from '../../workspace/projectMembership.js';
import { getConfigManager } from '../../utils/configManager.js';
import {
  findControlElementOrderViolations,
  formatElementOrderViolations,
} from '../../validation/formControlElementOrder.js';

/**
 * The model's other .rnrproj, or none — never a throw.
 *
 * Everything in this module is advisory: the write has already happened and
 * succeeded by the time any of it runs, so a diagnostic that raises turns a good
 * write into a reported failure. That is not hypothetical — this call is
 * evaluated as an ARGUMENT to verifyWrittenFile, outside its try, so an
 * exception here skips the verification entirely and surfaces as the write
 * failing. Degrading to "no siblings known" costs a less specific message and
 * nothing else.
 */
function projectsForModelSafe(modelName: string | null | undefined): string[] {
  try {
    return getConfigManager().getProjectsForModel?.(modelName) ?? [];
  } catch {
    return [];
  }
}

/**
 * The membership question for an object, with the model's other projects filled
 * in. Call sites pass the model they just wrote into; everything else is looked
 * up here so a caller cannot forget the siblings and silently get the old
 * active-project-only answer back.
 */
export function membershipOf(
  objectType: string,
  objectName: string,
  modelName: string | null | undefined,
): { axFolder: string; objectName: string; siblingProjectPaths: string[] } {
  return {
    axFolder: axFolderForObjectType(objectType),
    objectName,
    siblingProjectPaths: projectsForModelSafe(modelName),
  };
}

export interface WriteVerification {
  /** The file exists on disk and is non-empty. */
  onDisk: boolean;
  /** Byte length written, when readable. */
  bytes?: number;
  /**
   * Where the object is registered across the projects of its model. Undefined
   * when no project could be read — see projectMembership.ts for why this is a
   * membership question and not a path comparison.
   */
  membership?: Membership;
  /** AOT folder and name the membership answer is about, for the message. */
  axFolder?: string;
  objectName?: string;
}

/**
 * Check that a just-written file is where it should be. Never throws.
 *
 * `siblingProjectPaths` are the other .rnrproj of the same model. Supply them
 * and an object referenced by one of those is reported as such rather than as
 * missing — the distinction matters, because only one of the two stops the
 * build, and they call for different fixes.
 */
export async function verifyWrittenFile(
  filePath: string | undefined,
  projectPath?: string,
  membershipOf?: { axFolder: string; objectName: string; siblingProjectPaths?: readonly string[] },
): Promise<WriteVerification> {
  if (!filePath) return { onDisk: false };
  try {
    const stat = await fs.stat(filePath);
    const result: WriteVerification = { onDisk: stat.isFile() && stat.size > 0, bytes: stat.size };
    if (membershipOf && (projectPath || membershipOf.siblingProjectPaths?.length)) {
      result.membership = await resolveMembership(
        membershipOf.axFolder,
        membershipOf.objectName,
        projectPath,
        membershipOf.siblingProjectPaths ?? [],
      );
      result.axFolder = membershipOf.axFolder;
      result.objectName = membershipOf.objectName;
    }
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
    const { runBpCheckTool } = await import('../sdlc/runBpCheck.js');
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

/**
 * "Send the rest of the edits together" — the line that turns the dominant waste
 * pattern into one call.
 *
 * 45 of 273 sampled tool calls were consecutive single-op modifies, and 40 of 49
 * modifies were single-op even though operations[] already existed: the gap is
 * discovery, not capability, so the hint names the concrete call.
 *
 * `objectName` MUST be the name the object actually carries after prefix
 * normalization. Passing the requested name instead hands back a follow-up call
 * aimed at an object that does not exist.
 */
export function renderBatchEditHint(objectType: string, objectName: string, opts?: { afterCreate?: boolean }): string {
  if (!objectName) return '';
  return opts?.afterCreate
    ? `Further edits to "${objectName}" go in ONE call: d365fo_file(action="modify", ` +
      `objectType="${objectType}", objectName="${objectName}", operations:[…]) — not one call per edit.\n`
    : `\nMore edits to "${objectName}"? Send them together: operations:[{operation:"…"}, …] in ONE modify call.`;
}

/** One-line summary for a write response, or '' when there is nothing worth saying. */
export function renderWriteVerification(v: WriteVerification): string {
  if (!v.onDisk) {
    return `\n❌ Verification: the file is NOT on disk after a reported success — treat this write as failed.`;
  }
  const parts = [`on disk (${v.bytes} bytes)`];
  if (v.membership?.status === 'active') parts.push('referenced by the .rnrproj');
  const verified = `\n✅ Verified: ${parts.join(', ')}`;
  // Only 'other' and 'missing' have something to add; 'active' and 'unknown'
  // are the quiet cases, and quiet is what makes the loud ones mean anything.
  const note = v.membership
    ? renderMembership(v.membership, v.axFolder ?? '', v.objectName ?? '')
    : '';
  return note ? verified + note : `${verified}.`;
}

/**
 * Post-write element-order check for a form document (#989).
 *
 * `create` can only pass through a defect the caller supplied, and it is gated
 * BEFORE the write. `modify` is different in kind: the direct XML writers insert
 * elements into an existing document, and an insertion at the wrong offset IS
 * this defect — the same class as the nesting-scope trap behind #927/#928. So
 * the interesting failure here is one this server just introduced, and it can
 * only be seen after the operation has applied (through IMetadataProvider.Update()
 * or the XML fallback, neither of which can be dry-run).
 *
 * Hence a report rather than a gate. The write has happened; the caller needs to
 * know the file on disk now contains something the compiler will not see, and
 * which tool undoes it.
 *
 * Advisory like everything else in this module: a check that throws must not
 * turn a successful write into a reported failure.
 */
export async function verifyFormElementOrder(
  filePath: string | undefined,
  objectType: string,
): Promise<string> {
  if (!filePath || (objectType !== 'form' && objectType !== 'form-extension')) return '';
  try {
    const xml = await fs.readFile(filePath, 'utf-8');
    const dropped = findControlElementOrderViolations(xml).filter(v => v.kind === 'order');
    if (dropped.length === 0) return '';
    return (
      `\n\n⛔ **The file on disk now has ${dropped.length} element(s) the metadata deserializer ` +
      `will DROP silently** — they are in the file and the compiler will not see them:\n` +
      `${formatElementOrderViolations(dropped)}\n` +
      `This is a defect in the write, not in your request. Undo it with ` +
      `\`undo_last_modification\`, and please report the operation that produced it.`
    );
  } catch {
    return '';
  }
}
