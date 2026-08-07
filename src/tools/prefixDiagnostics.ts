/**
 * The "Prefix Configuration" section of `get_workspace_info`.
 *
 * Two rules decide everything here:
 *
 * 1. The prefix is reported for the model that WRITES land in — the write anchor
 *    (see ConfigManager.getWriteAnchorModel). A tool-initiated project switch
 *    moves the active project without moving that anchor, so after one the two
 *    are different models with different prefixes; reporting the active model's
 *    prefix would state a token no write would ever apply.
 * 2. The reported value always carries its origin. The prefix can come from the
 *    model's own objects, from EXTENSION_PREFIX, or from the model name, and a
 *    bare "Effective prefix: ConFin" under "EXTENSION_PREFIX: Con" reads as
 *    approved rather than as the disagreement it is.
 */

import { resolveObjectPrefix } from '../utils/modelClassifier.js';
import { getInferredModelPrefix } from '../utils/modelPrefixInference.js';
import { crossModelWriteAllowedByConfig } from '../utils/crossModelWriteGuard.js';

/**
 * The model a write would actually land in.
 *
 * Normally the anchor: a project switch does not move writes. But when the
 * operator has allowed writes into the switched-to model in configuration, the
 * guard lets them through and they land in the ACTIVE model — so that is the
 * model whose prefix a create would apply. Reporting the anchor's prefix there
 * would be the same defect one state over.
 */
export function modelWritesLandIn(
  anchorModel: string | null,
  activeModel: string | null,
): string | null {
  if (!activeModel || sameModel(activeModel, anchorModel)) return anchorModel;
  return crossModelWriteAllowedByConfig(activeModel) ? activeModel : anchorModel;
}

/**
 * Model names compare case-insensitively everywhere else (crossModelWriteGuard's
 * eq, ConfigManager's anchor bookkeeping). Comparing them exactly here would
 * report a switch — and a whole "writes are NOT switched" section — for two
 * spellings of one model.
 */
function sameModel(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export interface PrefixDiagnostics {
  /** Lines for the "## Prefix Configuration" section, blank line included. */
  lines: string[];
  /** The prefix a write would apply — for the Extension Naming samples. */
  effectivePrefix: string;
}

/**
 * @param writeModel model writes are anchored to; the prefix is resolved for it
 * @param readModel  model reads currently come from — differs from `writeModel`
 *                   only while a tool project switch is in effect
 */
export function buildPrefixDiagnostics(
  writeModel: string | null,
  readModel: string | null,
): PrefixDiagnostics {
  const extensionPrefixEnv = process.env.EXTENSION_PREFIX?.trim() || null;
  const learned = writeModel ? getInferredModelPrefix(writeModel) : null;
  const effectivePrefix = resolveObjectPrefix(writeModel ?? '');

  // "0/13 objects" is what this said when the token came from the model's
  // extension ELEMENTS rather than its regular objects (coverage is the regular
  // objects' count, and there were none to agree). A line that contradicts
  // itself in the section built to make the prefix checkable is worse than a
  // vaguer one, so each origin now states the evidence it actually has.
  const source = learned?.regular
    ? learned.coverage > 0
      ? `inferred from ${learned.coverage}/${learned.sampleSize} objects of model "${writeModel}"`
      : `inferred from the extension elements of model "${writeModel}"`
    : extensionPrefixEnv
      ? 'EXTENSION_PREFIX'
      : 'model name (nothing configured)';

  // Compared bare, because "DEMO_" in the model and "DEMO" in the env agree.
  const bare = (s: string) => s.replace(/_+$/, '').toLowerCase();
  const disagrees =
    !!learned?.regular && !!extensionPrefixEnv &&
    bare(learned.regular) !== bare(extensionPrefixEnv);

  const switched = !!writeModel && !!readModel && !sameModel(writeModel, readModel);

  const lines = [
    `## Prefix Configuration`,
    ``,
    `EXTENSION_PREFIX: ${extensionPrefixEnv ?? '(not set — falling back to model name)'}`,
    `Effective prefix: ${effectivePrefix || '(none)'}  (source: ${source})`,
  ];

  if (switched) {
    lines.push(
      `ℹ️  This is the prefix for WRITES, which are anchored to "${writeModel}". "${readModel}" is ` +
      `merely the active project and its own prefix may differ — see the project-switch note below.`,
    );
  }

  lines.push(
    disagrees
      ? `⚠️  The model's own objects use "${learned!.regular}", which overrides EXTENSION_PREFIX="${extensionPrefixEnv}" — new objects will be named "${effectivePrefix}…". If that is wrong, the model's existing objects are the thing to check; set EXTENSION_PREFIX_SOURCE=config to pin the configured value instead.`
      : learned?.regular
        ? `✅ Prefix "${effectivePrefix}" comes from the objects model "${writeModel}" already contains.`
        : extensionPrefixEnv
          ? `✅ EXTENSION_PREFIX is set — all new objects will use prefix "${effectivePrefix}".`
          : `⚠️  EXTENSION_PREFIX is not set in the server environment. The model name "${writeModel}" will be used as prefix. Add EXTENSION_PREFIX=MY (or your ISV prefix) to the .env file and restart the server.`,
    ``,
  );

  return { lines, effectivePrefix };
}
