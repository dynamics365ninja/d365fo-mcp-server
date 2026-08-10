/**
 * The cross-model write guard, for the writers that do not go through
 * `d365fo_file`.
 *
 * `create`, `modify` and `labels(create)` each call crossModelWriteRefusal()
 * themselves, with the write anchor as the model to measure against. The scaffold
 * generators — `generate_object(mode="scaffold")` for table / form / report —
 * never did: they resolve a model from the ACTIVE project and write the file
 * straight to disk (fs.writeFileSync), so a project switch moved them wholesale
 * into the switched-to model with nothing in the way. Whole tables and forms are
 * exactly what the demo produced in a model the user never had open, which makes
 * this the one write path where the anchor mattered most and was absent.
 *
 * The refusal text is the same one d365fo_file produces, so an agent that has
 * seen it once recognises it here.
 */

import { crossModelWriteRefusal } from '../../utils/crossModelWriteGuard.js';
import { getConfigManager } from '../../utils/configManager.js';

/**
 * The write anchor, resolved the way every guard must resolve it.
 *
 * Async because the synchronous getter returns null until the background
 * .rnrproj scan lands, and a null anchor makes the guard stand down — which
 * left the guard decided by a race.
 *
 * Defensive on purpose: a ConfigManager without the async method falls back to
 * the sync getter, and one with neither yields '' — the guard's own "nothing to
 * compare against" case, not a crash inside a write.
 */
export async function resolveAnchorModel(cm: {
  resolveWriteAnchorModel?: () => Promise<string | null>;
  getWriteAnchorModel?: () => string | null;
}): Promise<string> {
  try {
    const resolved = await cm.resolveWriteAnchorModel?.();
    if (resolved) return resolved;
  } catch {
    /* fall through to the sync getter */
  }
  return cm.getWriteAnchorModel?.() ?? '';
}

export interface ScaffoldWriteTarget {
  /** Final object name, prefix and suffix already applied. */
  objectName: string;
  /** d365fo_file objectType this scaffold produces: 'table' | 'form' | 'report'. */
  objectType: string;
  /** Model the generator resolved and is about to write into. */
  targetModel: string | null | undefined;
}

/**
 * The refusal to return, or null when the write may proceed.
 *
 * Resolves the anchor defensively: a caller (or a test) whose ConfigManager does
 * not expose getWriteAnchorModel yields no anchor, and the guard then has nothing
 * to compare against and stays silent — never a refusal on a guess.
 */
export async function scaffoldWriteRefusal(target: ScaffoldWriteTarget): Promise<string | null> {
  return crossModelWriteRefusal(await scaffoldWriteCheck(target));
}

/**
 * The check this scaffold is measured by. Exposed so a caller that proceeds can
 * also ask for standDownNotice() without resolving the anchor twice.
 *
 * The anchor is RESOLVED, not read: the synchronous getter returns null until the
 * background .rnrproj scan lands, and a null anchor makes the guard stand down.
 */
export async function scaffoldWriteCheck(target: ScaffoldWriteTarget) {
  const cm = getConfigManager() as Partial<ReturnType<typeof getConfigManager>>;
  const anchor = (await resolveAnchorModel(cm)) || null;
  const switched = cm.getToolProjectSwitch?.()?.forcedModel ?? null;

  return {
    objectName: target.objectName,
    objectType: target.objectType,
    owningModel: target.targetModel,
    activeModel: anchor,
    toolSwitchedModel: switched,
    action: 'create' as const,
  };
}

/** Same check, packaged as the tool result a scaffold handler returns. */
export async function scaffoldWriteRefusalResult(
  target: ScaffoldWriteTarget,
): Promise<{ content: Array<{ type: string; text: string }>; isError: true } | null> {
  const refusal = await scaffoldWriteRefusal(target);
  return refusal ? { content: [{ type: 'text', text: refusal }], isError: true } : null;
}
