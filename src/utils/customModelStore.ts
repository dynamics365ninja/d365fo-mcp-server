/**
 * "Does this model live in the custom metadata store?" — for project creation.
 *
 * On a unified developer environment (UDE) the XPP config splits metadata in two:
 * Microsoft's packages under FrameworkDirectory (getMicrosoftPackagesPath) and the
 * developer's own under ModelStoreFolder (getCustomPackagesPath). A model whose
 * package sits in the second folder is custom by where it is, whatever its name.
 * The name-based classifier (modelClassifier.isCustomModel) cannot see that: a
 * custom TEST model with no project yet, not configured, not in CUSTOM_MODELS and
 * without the EXTENSION_PREFIX read as standard, and creating its first project
 * was refused.
 *
 * Location proves something only when the two stores are separate folders. On a
 * classic VM custom and Microsoft packages share PackagesLocalDirectory, so a
 * package found there says nothing, and this answers false.
 *
 * Deliberately NOT folded into isCustomModel: that classifier also feeds the
 * cross-model write guard and every other write-path refusal, and this question
 * is asked only where a wrong "yes" costs a project file, not a model write.
 */

import * as path from 'path';
import { getConfigManager } from './configManager.js';
import { PackageResolver } from './packageResolver.js';

/** Positive answers, keyed by custom root and model (lowercased). A model does not leave the store. */
const found = new Set<string>();

/** Is `inner` the same folder as `outer`, or inside it? Case-insensitive, like Windows. */
function within(inner: string, outer: string): boolean {
  const rel = path.relative(path.resolve(outer).toLowerCase(), path.resolve(inner).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * True when the configured custom packages root (UDE ModelStoreFolder) is a
 * separate folder from the Microsoft packages root and holds `modelName`'s
 * package or descriptor. False on a classic VM, when either root is unknown, or
 * when the model is not there.
 */
export async function isModelInCustomStore(modelName: string): Promise<boolean> {
  const name = modelName.trim();
  if (!name) return false;
  const cfg = getConfigManager();
  if ((await cfg.getDevEnvironmentType().catch(() => 'traditional')) !== 'ude') return false;
  const customRoot = await cfg.getCustomPackagesPath().catch(() => null);
  const microsoftRoot = await cfg.getMicrosoftPackagesPath().catch(() => null);
  if (!customRoot || !microsoftRoot) return false;
  if (within(customRoot, microsoftRoot) || within(microsoftRoot, customRoot)) return false;

  const key = `${path.resolve(customRoot).toLowerCase()}|${name.toLowerCase()}`;
  if (found.has(key)) return true;
  const hit = await new PackageResolver([customRoot]).resolve(name).catch(() => null);
  if (hit) found.add(key);
  return !!hit;
}

/** For tests: forget the cached answers. */
export function clearCustomStoreCache(): void {
  found.clear();
}
