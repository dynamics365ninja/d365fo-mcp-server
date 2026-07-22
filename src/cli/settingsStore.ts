/**
 * CLI-side view of the structured configuration.
 *
 * Wraps src/config/configFile.ts with the bits only the CLI needs: reading the
 * effective value of a setting (config → secrets → legacy .env → default),
 * writing single values, and migrating an existing .env into the JSON shape so
 * a returning user is never asked twice for something they already configured.
 */
import * as fs from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  getAtPath,
  resolveConfigFiles,
  setAtPath,
  writeConfigFile,
  writeSecretsFile,
  type ConfigObject,
} from '../config/configFile.js';
import { SETTINGS, parseValue, type Setting } from '../config/settings.js';
import { readEnvValue } from './envFile.js';

export interface SettingsStore {
  /** Directory holding d365fo-mcp.json / secrets.json. */
  dir: string;
  /** Project directory relative path settings resolve from (repo root, or the instance folder). */
  baseDir: string;
  configPath: string;
  secretsPath: string;
  config: ConfigObject;
  secrets: ConfigObject;
  /** Legacy .env consulted as a fallback when a value is missing from the JSON. */
  legacyEnvFile: string | null;
}

/**
 * Open the store for a base directory (repo root, or an instance folder).
 * `legacyEnvFile` is the .env that used to hold the same settings, if any.
 */
export function openStore(baseDir: string, legacyEnvFile: string | null, fallbackConfigPath?: string): SettingsStore {
  // allowEnvOverride: false — the CLI opens several stores in one process, so a
  // D365FO_CONFIG inherited from the shell must not redirect all of them.
  const files = resolveConfigFiles(baseDir, { allowEnvOverride: false, fallbackConfigPath });
  return {
    dir: files.dir,
    baseDir: files.baseDir,
    configPath: files.configPath,
    secretsPath: files.secretsPath,
    config: files.config ?? {},
    secrets: files.secrets ?? {},
    legacyEnvFile: legacyEnvFile && fs.existsSync(legacyEnvFile) ? legacyEnvFile : null,
  };
}

/** Store rooted at an instance folder: instances/<name>/d365fo-mcp.json. */
export function openInstanceStore(instanceDir: string): SettingsStore {
  // A fresh instance has no config yet; write it to the top-level instance
  // layout (not the config/ repo layout) so listInstances() can find it.
  return openStore(instanceDir, join(instanceDir, '.env'), join(instanceDir, 'd365fo-mcp.json'));
}

/** Effective value of a setting, or undefined when nothing configures it. */
export function readSetting(store: SettingsStore, setting: Setting): unknown {
  const fromJson = getAtPath(setting.tier === 'secret' ? store.secrets : store.config, setting.path);
  if (fromJson !== undefined && fromJson !== null && fromJson !== '') return fromJson;
  if (store.legacyEnvFile) {
    const raw = readEnvValue(store.legacyEnvFile, setting.env);
    if (raw !== null && raw !== '') return parseValue(setting, stripInlineComment(raw));
  }
  return undefined;
}

/** Effective value, falling back to the documented default. */
export function readSettingOrDefault(store: SettingsStore, setting: Setting): unknown {
  const value = readSetting(store, setting);
  return value === undefined ? setting.default : value;
}

/** Value as the wizard should pre-fill it in a text prompt. */
export function initialText(store: SettingsStore, setting: Setting): string {
  const value = readSettingOrDefault(store, setting);
  if (value === undefined || value === null) return '';
  return Array.isArray(value) ? value.join(',') : String(value);
}

/** Absolute form of a `path`-typed setting, or `fallback` when it is unset. */
export function readPath(store: SettingsStore, setting: Setting, fallback: string): string {
  const value = readSetting(store, setting) ?? setting.default;
  if (typeof value !== 'string' || !value) return fallback;
  return isAbsolute(value) ? value : resolve(store.baseDir, value);
}

export function writeSetting(store: SettingsStore, setting: Setting, value: unknown): void {
  setAtPath(setting.tier === 'secret' ? store.secrets : store.config, setting.path, value);
}

export function saveStore(store: SettingsStore): void {
  writeConfigFile(store.configPath, store.config);
  writeSecretsFile(store.secretsPath, store.secrets);
}

/**
 * Copy every setting present in a legacy .env into the JSON config, so the
 * first `setup` run after upgrading starts from the values already in use.
 * Returns the settings that were carried over.
 */
export function migrateLegacyEnv(store: SettingsStore): Setting[] {
  if (!store.legacyEnvFile) return [];
  const migrated: Setting[] = [];
  for (const setting of SETTINGS) {
    // Never move a secret into the JSON automatically — the user decides
    // whether it lands in secrets.json or stays an environment variable.
    if (setting.tier === 'secret') continue;
    if (getAtPath(store.config, setting.path) !== undefined) continue;
    const raw = readEnvValue(store.legacyEnvFile, setting.env);
    if (raw === null) continue;
    const cleaned = stripInlineComment(raw);
    if (!cleaned) continue;
    const parsed = parseValue(setting, cleaned);
    if (parsed === undefined || (Array.isArray(parsed) && parsed.length === 0)) continue;
    // A value the registry no longer offers (the retired
    // D365FO_DEV_ENVIRONMENT_TYPE=auto, say) is left behind rather than carried
    // into the new config, where it would show up as an unpickable choice.
    if (setting.type === 'enum' && !setting.choices?.some(c => c.value === parsed)) continue;
    setAtPath(store.config, setting.path, parsed);
    migrated.push(setting);
  }
  return migrated;
}

/**
 * Settings a legacy .env still defines with a value different from the JSON.
 * The JSON wins at runtime, so these are worth reporting rather than fixing.
 */
export function conflictingLegacyValues(store: SettingsStore): { setting: Setting; envValue: string; configValue: string }[] {
  if (!store.legacyEnvFile) return [];
  const out: { setting: Setting; envValue: string; configValue: string }[] = [];
  for (const setting of SETTINGS) {
    const raw = readEnvValue(store.legacyEnvFile, setting.env);
    if (raw === null) continue;
    const envValue = stripInlineComment(raw);
    if (!envValue) continue;
    const json = getAtPath(setting.tier === 'secret' ? store.secrets : store.config, setting.path);
    if (json === undefined || json === null || json === '') continue;
    const configValue = Array.isArray(json) ? json.join(',') : String(json);
    if (configValue !== envValue) out.push({ setting, envValue, configValue });
  }
  return out;
}

/**
 * Drop a trailing `# comment` from a .env value.
 * .env.example documents defaults inline ("PORT=8080   # HTTP listen port"),
 * and dotenv keeps everything after the value, so migration must not carry the
 * comment into the JSON.
 */
function stripInlineComment(raw: string): string {
  const m = raw.match(/^\s*("[^"]*"|'[^']*'|[^#]*)/);
  const value = (m ? m[1] : raw).trim();
  return value.replace(/^(['"])(.*)\1$/, '$2').trim();
}
