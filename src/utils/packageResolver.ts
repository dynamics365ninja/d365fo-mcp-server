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
 * 2. Falling back to filesystem scanning for directories with AOT-type folders
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

export class PackageResolver {
  private roots: string[];
  private modelToPackageMap: Map<string, ResolvedPackage> | null = null;
  /** Lowercase lookup mirror of modelToPackageMap for case-insensitive resolve(). */
  private lowercaseLookup: Map<string, ResolvedPackage> | null = null;
  private buildPromise: Promise<void> | null = null;

  constructor(roots: string[]) {
    this.roots = roots.filter(Boolean);
  }

  /**
   * Resolve a model name to its package name.
   * Returns null if the model cannot be found in any root.
   *
   * The direct probe first, because buildMap() is a sweep of the WHOLE metadata
   * root and every write path calls this. On the reference VM's 214-package
   * PackagesLocalDirectory the sweep is ~5 s with the directory metadata already
   * cached, and every write pays it again on a fresh instance — a create in
   * benchmark run d79f62a3 took 341 s and reported all of it as `(unmeasured)`.
   * `<root>/<modelName>` answers the same question in two readdirs.
   *
   * When two packages declare the same model name the sweep's answer is
   * whichever directory readdir happened to return first; the probe's is the
   * package named after the model, which is the better of the two anyway.
   */
  async resolve(modelName: string): Promise<ResolvedPackage | null> {
    const direct = await this.probeDirect(modelName);
    if (direct) return direct;

    await this.ensureBuilt();
    return this.modelToPackageMap!.get(modelName) ||
      this.lowercaseLookup!.get(modelName.toLowerCase()) ||
      null;
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
   * Invalidate the cache to force a rescan.
   */
  clearCache(): void {
    this.modelToPackageMap = null;
    this.lowercaseLookup = null;
    this.buildPromise = null;
  }

  private async ensureBuilt(): Promise<void> {
    if (this.modelToPackageMap) return;
    if (!this.buildPromise) {
      this.buildPromise = this.buildMap().catch((err) => {
        this.buildPromise = null;
        throw err;
      });
    }
    await this.buildPromise;
  }

  private async buildMap(): Promise<void> {
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

        // Strategy 2: filesystem scan (subdirs containing an AOT-type folder)
        try {
          const subEntries = await fs.readdir(pkgPath, { withFileTypes: true });
          const subDirs = subEntries
            .filter(e => e.isDirectory() || e.isSymbolicLink())
            .map(e => e.name)
            .filter(n => n !== 'Descriptor' && n !== 'bin' && !n.startsWith('.'));

          for (const subDir of subDirs) {
            const modelPath = path.join(pkgPath, subDir);
            const hasAotFolder = await this.hasAotTypeFolder(modelPath);
            if (hasAotFolder && !map.has(subDir)) {
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

    this.modelToPackageMap = map;
    this.lowercaseLookup = lcMap;
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
