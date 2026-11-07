/**
 * XPP Config Provider
 * Reads Power Platform Tools XPP configuration files to discover
 * custom and Microsoft package paths for UDE development.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

export interface XppEnvironmentConfig {
  configName: string;
  version: string;
  customPackagesPath: string;       // ModelStoreFolder
  microsoftPackagesPath: string;    // FrameworkDirectory
  referencePackagesPaths: string[]; // ReferencePackagesPaths — all folders xppc should reference
  /** RuntimePackagesDirectory — junctions to every package root, where built module assemblies are found. */
  runtimePackagesDirectory?: string;
  xrefDbName?: string;
  xrefDbServer?: string;
  description?: string;
  fullFilename: string;             // Original filename without .json
}

interface XppConfigJson {
  ModelStoreFolder?: string;
  FrameworkDirectory?: string;
  ReferencePackagesPaths?: string[];
  RuntimePackagesDirectory?: string;
  CrossReferencesDatabaseName?: string;
  CrossReferencesDbServerName?: string;
  Description?: string;
}

export class XppConfigProvider {
  private configDir: string;
  private cache: XppEnvironmentConfig[] | null = null;

  constructor(configDir?: string) {
    this.configDir = configDir ||
      path.join(
        process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
        'Microsoft', 'Dynamics365', 'XPPConfig',
      );
  }

  /**
   * Parse a config filename into name + version.
   * Pattern: {name}___{version}.json
   */
  parseConfigFilename(filename: string): { configName: string; version: string } | null {
    // Version is typically dotted-numeric (e.g., 10.0.2428.63) but any non-empty
    // string after ___ is accepted for resilience to future format changes.
    const match = filename.match(/^(.+)___(.+)\.json$/);
    if (!match) return null;
    return { configName: match[1], version: match[2] };
  }

  /**
   * List all available XPP configs, sorted by modification time (newest first).
   */
  async listConfigs(): Promise<XppEnvironmentConfig[]> {
    if (this.cache) return [...this.cache];

    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(this.configDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const jsonFiles = entries.filter(e => e.isFile() && e.name.endsWith('.json'));

    const withStats = await Promise.all(
      jsonFiles.map(async (entry) => {
        const fullPath = path.join(this.configDir, entry.name);
        try {
          const stat = await fs.stat(fullPath);
          return { entry, mtime: stat.mtimeMs };
        } catch {
          return null;
        }
      }),
    );

    const valid = withStats.filter(Boolean) as { entry: fsSync.Dirent; mtime: number }[];
    valid.sort((a, b) => b.mtime - a.mtime);

    const configs: XppEnvironmentConfig[] = [];
    for (const { entry } of valid) {
      const parsed = this.parseConfigFilename(entry.name);
      if (!parsed) continue;

      const fullPath = path.join(this.configDir, entry.name);
      try {
        const raw = await fs.readFile(fullPath, 'utf-8');
        const json: XppConfigJson = JSON.parse(raw);

        if (!json.ModelStoreFolder || !json.FrameworkDirectory) continue;

        configs.push({
          configName: parsed.configName,
          version: parsed.version,
          customPackagesPath: json.ModelStoreFolder,
          microsoftPackagesPath: json.FrameworkDirectory,
          referencePackagesPaths: json.ReferencePackagesPaths ?? [],
          runtimePackagesDirectory: json.RuntimePackagesDirectory || undefined,
          xrefDbName: json.CrossReferencesDatabaseName,
          xrefDbServer: json.CrossReferencesDbServerName,
          description: json.Description,
          fullFilename: entry.name.replace(/\.json$/, ''),
        });
      } catch (err) {
        console.warn(`[XppConfigProvider] Skipping malformed config "${entry.name}":`, err instanceof SyntaxError ? 'invalid JSON' : String(err));
      }
    }

    this.cache = configs;
    return configs;
  }

  /**
   * Get the active XPP config.
   * If configName is provided, selects that specific config.
   * Otherwise auto-selects the newest.
   */
  async getActiveConfig(configName?: string): Promise<XppEnvironmentConfig | null> {
    const configs = await this.listConfigs();
    if (configs.length === 0) return null;

    if (configName) {
      return configs.find(c =>
        c.fullFilename === configName ||
        c.configName === configName
      ) || null;
    }

    // Warn when multiple configs exist and none is pinned, since auto-selection
    // can be unpredictable across multiple running server instances.
    if (configs.length > 1) {
      const names = configs.map(c => c.fullFilename).join(', ');
      console.warn(
        `[XppConfigProvider] XPP_CONFIG_NAME is not set and ${configs.length} configs were found ` +
        `(${names}). Auto-selecting the newest: "${configs[0].fullFilename}". ` +
        `Set XPP_CONFIG_NAME in your .env file to pin a specific config and avoid unpredictable ` +
        `behaviour when running multiple server instances.`,
      );
    }

    return configs[0]; // already sorted by mtime desc
  }

  /**
   * Check if XPP configs exist (indicates UDE environment).
   */
  async hasConfigs(): Promise<boolean> {
    const configs = await this.listConfigs();
    return configs.length > 0;
  }

  /**
   * Invalidate cached config list.
   */
  clearCache(): void {
    this.cache = null;
  }
}
