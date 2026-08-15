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
import { settingByPath } from '../config/settings.js';
import { readSetting, saveStore, writeSetting, type SettingsStore } from './settingsStore.js';

const xppConfigNameSetting = settingByPath('environment.xppConfigName')!;
const envTypeSetting = settingByPath('environment.type')!;

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

/** Pinned config name of a target, from its JSON config or legacy .env. */
function pinnedConfigName(store: SettingsStore): string | null {
  const value = readSetting(store, xppConfigNameSetting);
  return typeof value === 'string' && value ? value : null;
}

/**
 * The full {@link XppConfig} a UDE target resolves to: the pinned one, or the
 * newest available when nothing is pinned. Null for a traditional target, when
 * no config exists at all, and — deliberately — when the pin names a config
 * that is gone.
 *
 * Mirrors XppConfigProvider.getActiveConfig exactly, including that last case:
 * it matches either form of the name and returns null rather than substituting
 * a different environment. A pin that no longer resolves is the
 * stale-after-UDE-upgrade state isXppConfigStale() flags and `instance upgrade`
 * exists to fix; answering it with the newest config would have a caller
 * extract from 10.0.2500 and stamp the result as this target's, while its index
 * and server still reference the old pin.
 */
export function resolvePinnedXppConfig(store: SettingsStore): XppConfig | null {
  if (readSetting(store, envTypeSetting) === 'traditional') return null;
  const configs = listXppConfigs();
  if (configs.length === 0) return null;
  const configName = pinnedConfigName(store);
  if (!configName) return configs[0];
  return configs.find(c => c.fullName === configName || c.name === configName) ?? null;
}

/**
 * Is this target a UDE target at all — i.e. does a null from
 * {@link resolvePinnedXppConfig} mean "its pin does not resolve" rather than
 * "this is a traditional install"?
 *
 * That function returns null for three different reasons and a caller cannot
 * tell them apart, which matters because the two answers call for opposite
 * behaviour: a traditional target legitimately falls back to detecting the
 * packages root on this box, while for a UDE target that fallback throws away
 * the very guarantee the null was there to provide (see resolveSource in
 * commands/bpCatalog.ts, and the docblock above).
 *
 * Mirrors the detection settings.ts documents for an unset environment.type:
 * UDE when XPP config files exist in %LOCALAPPDATA%\Microsoft\Dynamics365\
 * XPPConfig. So a box with no configs at all is traditional — the one case
 * where falling through is correct — and anything else with an explicit
 * `traditional` type is taken at its word.
 */
export function isUdeTarget(store: SettingsStore): boolean {
  if (readSetting(store, envTypeSetting) === 'traditional') return false;
  return listXppConfigs().length > 0;
}

/**
 * Expand a short config name (e.g. "myenv-dev") to the newest full versioned
 * name ("myenv-dev___10.0.2345.153") so a later staleness check is a plain
 * file-exists test, and persist the expansion. No-op for traditional
 * environments, full names, or when nothing matches.
 * Returns the expansion that happened, or null.
 */
export function normalizeXppConfigName(store: SettingsStore): { from: string; to: string } | null {
  if (readSetting(store, envTypeSetting) === 'traditional') return null;
  const current = pinnedConfigName(store);
  if (!current || /___/.test(current)) return null;

  const match = listXppConfigs().filter(c => c.name === current);
  if (match.length === 0) return null;

  const full = match[0].fullName;
  writeSetting(store, xppConfigNameSetting, full);
  saveStore(store);
  return { from: current, to: full };
}

/**
 * True when the pinned config name no longer resolves to a file — i.e. the UDE
 * was upgraded since the instance was configured and its database is stale.
 * Only meaningful after normalizeXppConfigName.
 */
export function isXppConfigStale(store: SettingsStore): boolean {
  if (readSetting(store, envTypeSetting) === 'traditional') return false;
  const configName = pinnedConfigName(store);
  if (!configName) return false;
  const dir = xppConfigDir();
  if (!dir || !fs.existsSync(dir)) return false;
  return !fs.existsSync(join(dir, `${configName}.json`));
}
