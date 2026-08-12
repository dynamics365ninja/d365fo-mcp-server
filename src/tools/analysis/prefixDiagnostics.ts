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
 *
 * The resolution itself lives in utils/effectivePrefix.ts, which
 * validate_object_naming reads too — the two used to resolve it separately and
 * contradict each other (#833).
 */

import {
  prefixConflictWarning, resolveEffectivePrefix, sameModel,
} from '../../utils/effectivePrefix.js';

export { modelWritesLandIn } from '../../utils/effectivePrefix.js';

export interface PrefixDiagnostics {
  /**
   * Compact default: one `Prefix : …` line, plus a note only when something is
   * actually off (a switch is in effect, or the resolved prefix contradicts the
   * configuration). Every call of get_workspace_info pays for these tokens, so
   * the confirmations that only restate the value stay in `verboseLines`.
   */
  lines: string[];
  /** Full "## Prefix Configuration" section — diagnostics=true only. */
  verboseLines: string[];
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
  const resolution = resolveEffectivePrefix(writeModel);
  const { prefix: effectivePrefix, source, configured: extensionPrefixEnv, inferred: learned } = resolution;

  const switched = !!writeModel && !!readModel && !sameModel(writeModel, readModel);

  const switchNote =
    `ℹ️  This is the prefix for WRITES, which are anchored to "${writeModel}". "${readModel}" is ` +
    `merely the active project and its own prefix may differ — see the project-switch note below.`;

  const disagreeNote =
    `⚠️  The model's own objects use "${learned?.regular}", which overrides EXTENSION_PREFIX="${extensionPrefixEnv}" — new objects will be named "${effectivePrefix}…". If that is wrong, the model's existing objects are the thing to check; set naming.prefixSource=config (env: EXTENSION_PREFIX_SOURCE=config) to pin the configured value instead.`;

  const notConfiguredNote =
    `⚠️  EXTENSION_PREFIX is not set in the server environment. The model name "${writeModel}" will be used as prefix. Add EXTENSION_PREFIX=MY (or your ISV prefix) to the .env file and restart the server.`;

  // Compact: the value, its origin, and a warning only when there is one. The
  // warnings keep the fix but drop the explanation of it — the resolved prefix
  // is one line above, so what is wrong is already visible.
  const lines = [`Prefix      : ${effectivePrefix || '(none)'}  (${source})`];
  if (switched) lines.push(switchNote);
  const conflictWarning = prefixConflictWarning(resolution);
  if (conflictWarning) {
    lines.push(`⚠️  ${conflictWarning}`);
  } else if (!learned?.regular && !extensionPrefixEnv) {
    lines.push(
      `⚠️  EXTENSION_PREFIX is not set — the model name is being used as the prefix. ` +
      `Add EXTENSION_PREFIX=MY (your ISV prefix) to .env and restart the server.`,
    );
  }

  const verboseLines = [
    `## Prefix Configuration`,
    ``,
    `EXTENSION_PREFIX: ${extensionPrefixEnv ?? '(not set — falling back to model name)'}`,
    `Effective prefix: ${effectivePrefix || '(none)'}  (source: ${source})`,
  ];
  if (switched) verboseLines.push(switchNote);
  verboseLines.push(
    resolution.conflict
      ? disagreeNote
      : learned?.regular
        ? `✅ Prefix "${effectivePrefix}" comes from the objects model "${writeModel}" already contains.`
        : extensionPrefixEnv
          ? `✅ EXTENSION_PREFIX is set — all new objects will use prefix "${effectivePrefix}".`
          : notConfiguredNote,
    ``,
  );

  return { lines, verboseLines, effectivePrefix };
}
