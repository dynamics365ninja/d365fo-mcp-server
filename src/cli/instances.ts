/**
 * Multi-instance helpers — TypeScript counterpart of instances/*.ps1.
 * An instance is any directory under instances/ holding a d365fo-mcp.json
 * (or a legacy .env from before the setup wizard wrote JSON).
 */
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { configCandidates } from '../config/configFile.js';
import { settingByPath } from '../config/settings.js';
import { paths } from './context.js';
import { openInstanceStore, readSetting, saveStore, writeSetting } from './settingsStore.js';

const portSetting = settingByPath('server.port')!;

export interface Instance {
  name: string;
  dir: string;
  /** Legacy .env path — may not exist. */
  envFile: string;
  configFile: string;
  port: number | null;
}

export function listInstances(): Instance[] {
  if (!fs.existsSync(paths.instancesDir)) return [];
  return fs.readdirSync(paths.instancesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const dir = join(paths.instancesDir, e.name);
      // Accept either instance layout: the top-level d365fo-mcp.json, or the
      // config/ form an older build's wizard wrote. Prefer the top-level one.
      const configFile = configCandidates(dir).find(p => fs.existsSync(p)) ?? join(dir, 'd365fo-mcp.json');
      return { name: e.name, dir, envFile: join(dir, '.env'), configFile };
    })
    .filter(i => fs.existsSync(i.configFile) || fs.existsSync(i.envFile))
    .map(i => {
      const value = readSetting(openInstanceStore(i.dir), portSetting);
      return { ...i, port: typeof value === 'number' ? value : null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getInstance(name: string): Instance | undefined {
  return listInstances().find(i => i.name === name);
}

/**
 * Whether this instance's configuration sits in instances/<name>/config/, the
 * layout a build between the old wizard and #727 wrote. It keeps working —
 * configBaseDir() strips the trailing `config` folder, so ./data/… still
 * resolves to the instance folder — but every doc, script and note describes
 * the top-level form, so a user following them points D365FO_CONFIG at a file
 * that does not exist and the server silently starts on defaults.
 */
export function isLegacyInstanceLayout(inst: Instance): boolean {
  return basename(dirname(inst.configFile)).toLowerCase() === 'config';
}

/**
 * Move an instance out of the config/ layout: d365fo-mcp.json and secrets.json
 * go up one level, and the folder is removed when nothing else is left in it.
 * Returns the files that were moved (empty when there was nothing to do).
 *
 * Deliberately not called from openInstanceStore: a write hidden inside a read
 * would fire from every command, including the read-only ones. The explicit
 * callers are `instance upgrade` (which already rewrites the config) and the
 * fix line `doctor` prints.
 */
export function normalizeInstanceLayout(inst: Instance): string[] {
  if (!isLegacyInstanceLayout(inst)) return [];
  const configDir = dirname(inst.configFile);
  const moved: string[] = [];
  for (const file of ['d365fo-mcp.json', 'secrets.json']) {
    const from = join(configDir, file);
    const to = join(inst.dir, file);
    // A top-level file already there wins (listInstances prefers it); moving
    // the config/ copy over it would silently replace the live configuration.
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    fs.renameSync(from, to);
    moved.push(to);
  }
  if (fs.existsSync(configDir) && fs.readdirSync(configDir).length === 0) fs.rmdirSync(configDir);
  return moved;
}

/** Next free port: max of existing instance ports + 1, or 3001. */
export function suggestPort(instances: Instance[]): number {
  const used = instances.map(i => i.port).filter((p): p is number => p !== null);
  return used.length > 0 ? Math.max(...used) + 1 : 3001;
}

/**
 * Create instances/<name>/{d365fo-mcp.json,data,metadata} with the port and the
 * instance-local index paths pre-filled; the remaining settings are asked for
 * by the caller. Throws when the instance already exists.
 */
export function createInstance(name: string, port: number): Instance {
  const dir = join(paths.instancesDir, name);
  const envFile = join(dir, '.env');
  if (configCandidates(dir).some(p => fs.existsSync(p)) || fs.existsSync(envFile)) {
    throw new Error(`Instance '${name}' already exists.`);
  }
  fs.mkdirSync(join(dir, 'data'), { recursive: true });
  fs.mkdirSync(join(dir, 'metadata'), { recursive: true });

  // Relative paths resolve from the config file's directory, so an instance
  // folder can be moved or renamed without touching its configuration.
  const store = openInstanceStore(dir);
  writeSetting(store, portSetting, port);
  writeSetting(store, settingByPath('index.dbPath')!, './data/xpp-metadata.db');
  writeSetting(store, settingByPath('index.labelsDbPath')!, './data/xpp-metadata-labels.db');
  writeSetting(store, settingByPath('index.metadataPath')!, './metadata');
  saveStore(store);

  // store.configPath rather than a second literal: where a fresh config lands is
  // resolveConfigFiles' decision, and the two must not drift apart.
  return { name, dir, envFile, configFile: store.configPath, port };
}
