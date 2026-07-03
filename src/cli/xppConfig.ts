/**
 * XPP config discovery (UDE / Power Platform Tools) — TypeScript counterpart
 * of scripts/select-xpp-config.ps1 and the helpers in instances/*.ps1.
 *
 * Configs live in %LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig as
 * "<name>___<version>.json"; Windows-only by nature — callers on other
 * platforms get an empty list.
 */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { getValue, readDevEnvType, readEnvValue, setValue } from './envFile.js';

export interface XppConfig {
  /** Filename without .json, e.g. "contoso-dev___10.0.2428.63" */
  fullName: string;
  /** Environment name before the ___ separator */
  name: string;
  version: string;
  file: string;
  mtimeMs: number;
  modelStoreFolder?: string;
  frameworkDirectory?: string;
}

export function xppConfigDir(): string | null {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  return join(localAppData, 'Microsoft', 'Dynamics365', 'XPPConfig');
}

/** All versioned configs, newest first. Empty when the directory is absent. */
export function listXppConfigs(): XppConfig[] {
  const dir = xppConfigDir();
  if (!dir || !fs.existsSync(dir)) return [];
  const configs: XppConfig[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const m = entry.match(/^(.+)___(.+)\.json$/);
    if (!m) continue;
    const file = join(dir, entry);
    let modelStoreFolder: string | undefined;
    let frameworkDirectory: string | undefined;
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      modelStoreFolder = json.ModelStoreFolder;
      frameworkDirectory = json.FrameworkDirectory;
    } catch { /* unreadable config — still list it */ }
    configs.push({
      fullName: entry.replace(/\.json$/, ''),
      name: m[1],
      version: m[2],
      file,
      mtimeMs: fs.statSync(file).mtimeMs,
      modelStoreFolder,
      frameworkDirectory,
    });
  }
  return configs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Expand a short XPP_CONFIG_NAME (e.g. "myenv-dev") in an .env file to the
 * newest full versioned name ("myenv-dev___10.0.2345.153") so a later
 * staleness check is a plain file-exists test. No-op for traditional
 * environments, full names, or when nothing matches.
 * Returns the expansion that happened, or null.
 */
export function normalizeXppConfigName(envFile: string): { from: string; to: string } | null {
  if (readDevEnvType(envFile) === 'traditional') return null;
  const current = readEnvValue(envFile, 'XPP_CONFIG_NAME');
  if (!current || /___/.test(current)) return null;

  const match = listXppConfigs().filter(c => c.name === current);
  if (match.length === 0) return null;

  const full = match[0].fullName;
  const content = fs.readFileSync(envFile, 'utf8');
  fs.writeFileSync(envFile, setValue(content, 'XPP_CONFIG_NAME', full));
  return { from: current, to: full };
}

/**
 * True when the pinned XPP_CONFIG_NAME no longer resolves to a file —
 * i.e. the UDE was upgraded since the instance was configured and its
 * database is stale. Only meaningful after normalizeXppConfigName.
 */
export function isXppConfigStale(envFile: string): boolean {
  if (readDevEnvType(envFile) === 'traditional') return false;
  const configName = readEnvValue(envFile, 'XPP_CONFIG_NAME');
  if (!configName) return false;
  const dir = xppConfigDir();
  if (!dir || !fs.existsSync(dir)) return false;
  return !fs.existsSync(join(dir, `${configName}.json`));
}

// Re-export for callers that work on content strings in tests.
export { getValue as _getValue };
