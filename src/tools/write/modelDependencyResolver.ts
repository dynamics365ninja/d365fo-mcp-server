/**
 * How the model a write targets stands to the workspace's model, resolved before
 * the cross-model guard runs so its refusal can tell a test model (built ON the
 * workspace model, so unreachable by an extension from it) from a shared model the
 * workspace builds on (where an extension is the right advice).
 */

import * as path from 'path';
import { getConfigManager } from '../../utils/configManager.js';
import { modelDependency, type ModelDependency } from '../../metadata/modelDescriptor.js';

/**
 * Null when the two are the same model or no descriptor says.
 *
 * Read only when the two differ, so an ordinary write pays nothing. Roots are tried
 * in order: the one in the target file's own path (`<root>/<Package>/<Model>/Ax…`),
 * then the configured custom and standard package roots.
 */
export async function resolveModelDependency(
  owningModel: string | null | undefined,
  activeModel: string | null | undefined,
  owningFilePath?: string | null,
): Promise<ModelDependency | null> {
  if (!owningModel || !activeModel || owningModel.toLowerCase() === activeModel.toLowerCase()) return null;
  try {
    const roots: Array<string | null | undefined> = [];
    const parts = (owningFilePath ?? '').split(/[\\/]/);
    const modelIdx = parts.findIndex((p, i) => p.toLowerCase() === owningModel.toLowerCase() && /^Ax/i.test(parts[i + 1] ?? ''));
    if (modelIdx >= 2) roots.push(parts.slice(0, modelIdx - 1).join(path.sep));
    const cm = getConfigManager() as Partial<ReturnType<typeof getConfigManager>>;
    roots.push(await cm.getCustomPackagesPath?.(), cm.getPackagePath?.());
    return modelDependency(roots, owningModel, activeModel);
  } catch {
    return null;
  }
}
