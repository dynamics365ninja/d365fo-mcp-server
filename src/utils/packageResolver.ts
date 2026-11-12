/**
 * Package Resolver
 * Maps model names to package names using descriptor XML files
 * and filesystem scanning.
 *
 * In D365FO, the metadata directory structure is:
 *   {Root}/{PackageName}/{ModelName}/AxClass/...
 *   {Root}/{PackageName}/Descriptor/{ModelName}.xml
 *
 * The descriptor XML contains <ModelModule> (package name) and <Name> (model name).
 * A single package (e.g., "CustomExtensions") can contain many models
 * (e.g., "Contoso Utilities", "Contoso Reporting").
 *
 * This resolver builds a map from model name -> package info by:
 * 1. Reading descriptor XML files (primary strategy)
 * 2. Falling back to filesystem scanning for directories with AOT-type folders,
 *    in packages whose descriptors name no model
 *
 * The map is built once per set of roots and shared by every instance.
 */

import * as fs from 'fs/promises';
import { realpathSync } from 'fs';
import * as path from 'path';

/**
 * Resolve the actual on-disk casing of a path (Windows is case-insensitive but
 * VS Code and Copilot compare paths case-sensitively). Falls back to the
 * original string if the path does not exist yet.
 */
function normalizePathCase(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export interface ResolvedPackage {
  packageName: string;
  modelName: string;
  rootPath: string; // Which metadata root this was found in
}

/** One finished sweep of a set of roots. */
interface PackageMap {
  map: Map<string, ResolvedPackage>;
  /** Lowercase lookup mirror of `map` for case-insensitive resolve(). */
  lcMap: Map<string, ResolvedPackage>;
  /** When the sweep finished (Date.now()). */
  builtAt: number;
}

interface SharedPackageMap {
  promise: Promise<PackageMap>;
  /** Set once `promise` resolves. Undefined while the sweep is still running. */
  value?: PackageMap;
}

/**
 * The sweeps of this process, keyed by the joined roots.
 *
 * Module level because every caller constructs a fresh PackageResolver and throws
 * it away: a map held on the instance was rebuilt on every use, and the sweep
 * reads every package of every root. Keyed by the roots, so a changed roots
 * configuration gets a map of its own instead of the previous one.
 */
const sharedMaps = new Map<string, SharedPackageMap>();

/**
 * How old a map must be before a miss may rebuild it.
 *
 * A model that is not in the map may have been created after the sweep (in Visual
 * Studio, by a pull), so a miss is allowed one rebuild. Only when the map is older
 * than this though: a mistyped model name is a miss as well, and without the
 * interval every call with that name would sweep again.
 */
const MISS_REBUILD_INTERVAL_MS = 5_000;

/**
 * Drop every shared model-to-package map, so the next lookup that needs one
 * sweeps again. For code that changes which models exist or what a descriptor
 * declares, and for tests, which need a fresh state per case.
 */
export function clearSharedPackageMaps(): void {
  sharedMaps.clear();
}

export class PackageResolver {
  private roots: string[];
  /** Key of this instance's roots in sharedMaps. */
  private readonly sharedKey: string;
  /** The shared map this instance last used. Null until a lookup needed the sweep. */
  private modelToPackageMap: Map<string, ResolvedPackage> | null = null;

  constructor(roots: string[]) {
    this.roots = roots.filter(Boolean);
    this.sharedKey = this.roots.join('|');
  }

  /**
   * Resolve a model name to its package name.
   * Returns null if the model cannot be found in any root.
   *
   * The direct probe first, because buildMap() is a sweep of the WHOLE metadata
   * root and every write path calls this. On the reference VM's 214-package
   * PackagesLocalDirectory the sweep is ~5 s with the directory metadata already
   * cached — a create in benchmark run d79f62a3 took 341 s and reported all of it
   * as `(unmeasured)`. `<root>/<modelName>` answers the same question in two
   * readdirs.
   *
   * A model the probe cannot answer (its package has another name) is looked up
   * in the map, which is swept once per set of roots and shared by every instance
   * — see sharedMaps. A miss rebuilds the map at most once per
   * MISS_REBUILD_INTERVAL_MS, so a model created after the sweep is found without
   * a restart and a mistyped name cannot cost a sweep per call.
   *
   * When two packages declare the same model name the sweep's answer is
   * whichever directory readdir happened to return first; the probe's is the
   * package named after the model, which is the better of the two anyway.
   */
  async resolve(modelName: string): Promise<ResolvedPackage | null> {
    const direct = await this.probeDirect(modelName);
    if (direct) return direct;

    const lookup = (built: PackageMap): ResolvedPackage | null =>
      built.map.get(modelName) || built.lcMap.get(modelName.toLowerCase()) || null;

    let built = await this.ensureBuilt();
    let hit = lookup(built);
    if (!hit && Date.now() - built.builtAt >= MISS_REBUILD_INTERVAL_MS) {
      built = await this.ensureBuilt(built);
      hit = lookup(built);
    }
    return hit;
  }

  /**
   * `<root>/<modelName>` — the layout every D365FO package uses unless someone
   * deliberately named the package differently from the model.
   *
   * Reads the same two things buildMap() would for that one directory: the
   * descriptor (authoritative for both names) and, failing that, the presence of
   * an AOT folder one level down. Anything unexpected returns null and lets the
   * full sweep decide, so this can only make the common case cheaper — never
   * change what an unusual layout resolves to.
   */
  private async probeDirect(modelName: string): Promise<ResolvedPackage | null> {
    for (const rawRoot of this.roots) {
      const root = normalizePathCase(rawRoot);
      const pkgPath = path.join(root, modelName);

      try {
        const descriptorFiles = await fs.readdir(path.join(pkgPath, 'Descriptor'));
        // Exact spelling wins over a case-insensitive one. A package can declare
        // several models whose names differ only in case (ATLApplicationSuite
        // and AtlApplicationSuite both live in the reference environment), and
        // taking whichever file readdir returned first would resolve one to the
        // other's package.
        let looseHit: ResolvedPackage | null = null;
        for (const file of descriptorFiles) {
          if (!file.endsWith('.xml')) continue;
          const content = await fs.readFile(path.join(pkgPath, 'Descriptor', file), 'utf-8');
          const declared = content.match(/<Name>([^<]+)<\/Name>/)?.[1]?.trim();
          if (!declared || declared.toLowerCase() !== modelName.toLowerCase()) continue;
          const packageName = content.match(/<ModelModule>([^<]+)<\/ModelModule>/)?.[1]?.trim() || modelName;
          if (declared === modelName) return { packageName, modelName: declared, rootPath: root };
          // Case-only difference: keep the caller's spelling, which is also the
          // directory's. The descriptor is authoritative for the PACKAGE name,
          // the directory for the model's — `<root>/<package>/<model>/AxEnum`
          // has to name real directories, and Copilot compares paths as strings.
          looseHit ??= { packageName, modelName, rootPath: root };
        }
        if (looseHit) return looseHit;
      } catch {
        // No Descriptor directory here — try the filesystem shape below.
      }

      // `<root>/<modelName>/<modelName>/AxClass` etc. — package named after the model.
      if (await this.hasAotTypeFolder(path.join(pkgPath, modelName))) {
        return { packageName: modelName, modelName, rootPath: root };
      }
    }
    return null;
  }

  /**
   * Resolve with an explicit package name (bypasses lookup).
   */
  resolveWithPackage(modelName: string, packageName: string): ResolvedPackage {
    return {
      packageName,
      modelName,
      rootPath: this.roots[0] || '',
    };
  }

  /**
   * Get all known model-to-package mappings.
   */
  async getAllMappings(): Promise<Map<string, ResolvedPackage>> {
    await this.ensureBuilt();
    return new Map(this.modelToPackageMap!);
  }

  /**
   * Invalidate the cache to force a rescan. Drops the shared map of this
   * instance's roots, so every other instance on the same roots rescans too.
   */
  clearCache(): void {
    this.modelToPackageMap = null;
    sharedMaps.delete(this.sharedKey);
  }

  /**
   * The shared map of this instance's roots, swept if nobody has yet.
   *
   * `stale` asks for a newer map than the one given: the sweep restarts only if
   * `stale` is still the current one, so callers that miss at the same moment
   * share one rebuild instead of starting one each.
   */
  private async ensureBuilt(stale?: PackageMap): Promise<PackageMap> {
    let entry = sharedMaps.get(this.sharedKey);
    if (!entry || (stale && entry.value === stale)) {
      const created: SharedPackageMap = { promise: this.buildMap() };
      created.promise.then(
        (value) => { created.value = value; },
        () => {
          // A failed sweep is not kept, the next lookup tries again.
          if (sharedMaps.get(this.sharedKey) === created) sharedMaps.delete(this.sharedKey);
        },
      );
      sharedMaps.set(this.sharedKey, created);
      entry = created;
    }
    const built = await entry.promise;
    this.modelToPackageMap = built.map;
    return built;
  }

  private async buildMap(): Promise<PackageMap> {
    const map = new Map<string, ResolvedPackage>();
    const lcMap = new Map<string, ResolvedPackage>();

    for (const rawRoot of this.roots) {
      if (!rawRoot) continue;
      const root = normalizePathCase(rawRoot);

      let packageDirs: string[];
      try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        packageDirs = entries
          .filter(e => e.isDirectory() || e.isSymbolicLink())
          .map(e => e.name);
      } catch {
        continue;
      }

      for (const pkgName of packageDirs) {
        const pkgPath = path.join(root, pkgName);

        // Strategy 1: descriptor XML files
        // Lowercased names of the models this package's descriptors declare.
        const declared = new Set<string>();
        const descriptorDir = path.join(pkgPath, 'Descriptor');
        try {
          const descriptorFiles = await fs.readdir(descriptorDir);
          for (const file of descriptorFiles) {
            if (!file.endsWith('.xml')) continue;
            const filePath = path.join(descriptorDir, file);
            try {
              const content = await fs.readFile(filePath, 'utf-8');
              const nameMatch = content.match(/<Name>([^<]+)<\/Name>/);
              const moduleMatch = content.match(/<ModelModule>([^<]+)<\/ModelModule>/);

              const modelName = nameMatch?.[1]?.trim();
              const packageName = moduleMatch?.[1]?.trim() || pkgName;

              if (modelName) declared.add(modelName.toLowerCase());
              if (modelName && !map.has(modelName)) {
                const resolved = { packageName, modelName, rootPath: root };
                map.set(modelName, resolved);
                lcMap.set(modelName.toLowerCase(), resolved);
              }
            } catch {
              // Skip unreadable descriptor
            }
          }
        } catch {
          // No Descriptor directory -- fall through to filesystem scan
        }

        // Strategy 2: filesystem scan (subdirs containing an AOT-type folder).
        // The fallback for a package whose descriptors named no model: no
        // Descriptor directory, an empty one, or files that could not be read.
        // Where they did name models they are authoritative and the subfolders
        // are not opened. Opening them for every package was most of the sweep's
        // cost: each model folder is a directory of over a hundred Ax* folders,
        // and a package also carries bin, Resources, Reports and the like.
        // One exception keeps a real shape working: a folder whose name differs
        // from a declared model only in case is still registered under the
        // folder's spelling, because paths have to name real directories.
        try {
          const subEntries = await fs.readdir(pkgPath, { withFileTypes: true });
          const subDirs = subEntries
            .filter(e => e.isDirectory() || e.isSymbolicLink())
            .map(e => e.name)
            .filter(n => n !== 'Descriptor' && n !== 'bin' && !n.startsWith('.'));

          for (const subDir of subDirs) {
            if (map.has(subDir)) continue; // already known, nothing to learn
            if (declared.size > 0 && !declared.has(subDir.toLowerCase())) continue;
            const modelPath = path.join(pkgPath, subDir);
            const hasAotFolder = await this.hasAotTypeFolder(modelPath);
            if (hasAotFolder) {
              const resolved = { packageName: pkgName, modelName: subDir, rootPath: root };
              map.set(subDir, resolved);
              lcMap.set(subDir.toLowerCase(), resolved);
            }
          }
        } catch {
          // Skip unreadable package directory
        }
      }
    }

    return { map, lcMap, builtAt: Date.now() };
  }

  private static readonly AOT_FOLDERS = new Set([
    'axclass', 'axtable', 'axenum', 'axform', 'axedt', 'axview', 'axdataentityview',
  ]);

  private async hasAotTypeFolder(dirPath: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(dirPath);
      return entries.some(e => PackageResolver.AOT_FOLDERS.has(e.toLowerCase()));
    } catch {
      return false;
    }
  }
}
