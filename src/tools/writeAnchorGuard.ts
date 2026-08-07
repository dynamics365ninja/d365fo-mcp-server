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

import { crossModelWriteRefusal } from '../utils/crossModelWriteGuard.js';
import { getConfigManager } from '../utils/configManager.js';

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
export function scaffoldWriteRefusal(target: ScaffoldWriteTarget): string | null {
  const cm = getConfigManager() as Partial<ReturnType<typeof getConfigManager>>;
  const anchor = cm.getWriteAnchorModel?.() ?? null;
  const switched = cm.getToolProjectSwitch?.()?.forcedModel ?? null;

  return crossModelWriteRefusal({
    objectName: target.objectName,
    objectType: target.objectType,
    owningModel: target.targetModel,
    activeModel: anchor,
    toolSwitchedModel: switched,
    action: 'create',
  });
}

/** Same check, packaged as the tool result a scaffold handler returns. */
export function scaffoldWriteRefusalResult(
  target: ScaffoldWriteTarget,
): { content: Array<{ type: string; text: string }>; isError: true } | null {
  const refusal = scaffoldWriteRefusal(target);
  return refusal ? { content: [{ type: 'text', text: refusal }], isError: true } : null;
}
