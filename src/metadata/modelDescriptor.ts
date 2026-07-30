/**
 * Model descriptor reader — `<PackagesLocalDirectory>/<Package>/Descriptor/<Model>.xml`.
 *
 * `<ModuleReferences>` is the only statement of what a model may see: xppc
 * resolves types against the referenced packages, not against everything
 * installed, so an indexed type can still be invisible to the model being
 * compiled. The visible set is the model's own package plus its DIRECT
 * references — walking the closure would mark such a type visible again and
 * hide the defect this exists to catch.
 *
 * Not a compiler: a table in a referenced package can still need a further
 * reference because a third package contributes a table extension to it.
 *
 * build_d365fo_project reads the same element to order its build queue and
 * calls straight into `parseModuleReferences`.
 */

import { readFile } from 'fs/promises';
import { existsSync, readFileSync, readdirSync } from 'fs';
import * as path from 'path';

/**
 * Extract every `<d2p1:string>` entry of a descriptor's `<ModuleReferences>`.
 * The sibling `<ModelReferences>` is `i:nil` in every descriptor observed on a
 * real box, so the flat scan cannot pick up entries from it.
 */
export function parseModuleReferences(descriptorXml: string): string[] {
  return Array.from(descriptorXml.matchAll(/<d2p1:string>\s*([^<\s]+)\s*<\/d2p1:string>/g))
    .map(m => m[1].trim())
    .filter(Boolean);
}

/**
 * Read a model's direct module references, or null when it has no readable
 * descriptor — which callers must treat as unknown, never as "references nothing".
 */
export async function readModuleReferences(
  packagesPath: string,
  modelName: string,
): Promise<string[] | null> {
  try {
    return parseModuleReferences(
      await readFile(path.join(packagesPath, modelName, 'Descriptor', `${modelName}.xml`), 'utf-8'),
    );
  } catch {
    return null;
  }
}

/** The PackagesLocalDirectory root contained in a package or workspace path. */
export function packagesRootFromPath(candidate: string | undefined | null): string | null {
  if (!candidate) return null;
  const m = /^(.+[\\/]PackagesLocalDirectory)(?:[\\/]|$)/i.exec(candidate.replace(/\//g, '\\'));
  return m ? m[1] : null;
}

export interface ModelVisibility {
  /** Target model, for diagnostics. */
  model: string;
  /** PackagesLocalDirectory root the indexed file paths are relative to. */
  packagesRoot: string;
  /** Lower-cased package folder names the model may reference (incl. its own). */
  visiblePackages: ReadonlySet<string>;
  /**
   * Package folder owning an indexed file, or null when the path is not under
   * this packages root. Null means "cannot tell" and must silence the check.
   */
  packageOf(filePath: string): string | null;
}

/**
 * Locate `<Model>.xml`. `<root>/<Model>/Descriptor/<Model>.xml` is the common
 * layout and costs one stat; ISV models inside a differently-named package fall
 * back to a single bounded sweep of the root's package folders.
 */
function findDescriptor(packagesRoot: string, modelName: string): { file: string; pkg: string } | null {
  const direct = path.join(packagesRoot, modelName, 'Descriptor', `${modelName}.xml`);
  if (existsSync(direct)) return { file: direct, pkg: modelName };
  let entries: string[];
  try {
    entries = readdirSync(packagesRoot);
  } catch {
    return null;
  }
  for (const pkg of entries) {
    const file = path.join(packagesRoot, pkg, 'Descriptor', `${modelName}.xml`);
    if (existsSync(file)) return { file, pkg };
  }
  return null;
}

/** Cache key → resolved visibility (or null when it could not be resolved). */
const visibilityCache = new Map<string, ModelVisibility | null>();

/**
 * Build (and memoise) the visibility oracle for `modelName`; null whenever the
 * answer would be a guess. Callers must then skip the check — a missing
 * descriptor turning into a wall of errors is worse than the gap it closes.
 */
export function getModelVisibility(
  packagesRoot: string | null | undefined,
  modelName: string | null | undefined,
): ModelVisibility | null {
  if (!packagesRoot || !modelName) return null;
  const key = `${packagesRoot.toLowerCase()}|${modelName.toLowerCase()}`;
  const cached = visibilityCache.get(key);
  if (cached !== undefined) return cached;

  const built = buildModelVisibility(packagesRoot, modelName);
  visibilityCache.set(key, built);
  return built;
}

/** Uncached form — exported for tests, which need a fresh fixture each time. */
export function buildModelVisibility(
  packagesRoot: string | null | undefined,
  modelName: string | null | undefined,
): ModelVisibility | null {
  if (!packagesRoot || !modelName) return null;
  const found = findDescriptor(packagesRoot, modelName);
  if (!found) return null;

  let refs: string[];
  try {
    refs = parseModuleReferences(readFileSync(found.file, 'utf-8'));
  } catch {
    return null;
  }

  const visiblePackages = new Set<string>([found.pkg.toLowerCase()]);
  for (const ref of refs) visiblePackages.add(ref.toLowerCase());

  const rootPrefix = packagesRoot.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() + '\\';
  return {
    model: modelName,
    packagesRoot,
    visiblePackages,
    packageOf(filePath: string): string | null {
      if (!filePath) return null;
      const norm = filePath.replace(/\//g, '\\');
      // Case-insensitive: index and config disagree on the root's casing
      // (`K:\AOSService\…` vs `K:\AosService\…`) for the same directory.
      if (!norm.toLowerCase().startsWith(rootPrefix)) return null;
      const segment = norm.slice(rootPrefix.length).split('\\')[0];
      return segment || null;
    },
  };
}

/** Test seam — drops the memoised visibility oracles. */
export function clearModelVisibilityCache(): void {
  visibilityCache.clear();
}
