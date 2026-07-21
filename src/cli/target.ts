/**
 * Target selection — commands like start/index operate either on the root
 * server (repo .env) or on one instance under instances/. Resolves a
 * positional instance name, or asks interactively when instances exist.
 */
import * as fs from 'node:fs';
import { dataRoot, paths } from './context.js';
import { Instance, listInstances } from './instances.js';
import { openInstanceStore, openStore, type SettingsStore } from './settingsStore.js';
import { askSelect } from './ui.js';

export interface Target {
  /** 'root' or the instance name */
  name: string;
  label: string;
  /** Legacy .env, when one exists — still read as a fallback by the server. */
  envFile: string | null;
  /** Structured configuration (config/d365fo-mcp.json or instances/<name>/d365fo-mcp.json). */
  store: SettingsStore;
  port: number | null;
  instance?: Instance;
}

/** Environment for a child process so it loads this target's configuration. */
export function targetEnv(target: Target): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  if (target.envFile) env.ENV_FILE = target.envFile;
  if (fs.existsSync(target.store.configPath)) env.D365FO_CONFIG = target.store.configPath;
  return Object.keys(env).length > 0 ? env : undefined;
}

export function rootTarget(): Target {
  return {
    name: 'root',
    label: 'root server',
    envFile: fs.existsSync(paths.rootEnv) ? paths.rootEnv : null,
    store: openStore(dataRoot(), paths.rootEnv),
    port: null,
  };
}

export function instanceTarget(inst: Instance): Target {
  return {
    name: inst.name,
    label: `instance '${inst.name}'`,
    envFile: fs.existsSync(inst.envFile) ? inst.envFile : null,
    store: openInstanceStore(inst.dir),
    port: inst.port,
    instance: inst,
  };
}

/**
 * Resolve the target: explicit name → that instance ('root' selects the root
 * server); no name and no instances → root; otherwise ask.
 */
export async function pickTarget(instanceName: string | undefined, message: string): Promise<Target> {
  const instances = listInstances();
  if (instanceName) {
    if (instanceName === 'root') return rootTarget();
    const inst = instances.find(i => i.name === instanceName);
    if (!inst) {
      throw new Error(`Instance '${instanceName}' not found. Available: ${instances.map(i => i.name).join(', ') || '(none)'}`);
    }
    return instanceTarget(inst);
  }
  if (instances.length === 0) return rootTarget();

  const choice = await askSelect(message, [
    { value: 'root', label: 'root server', hint: dataRoot() },
    ...instances.map(i => ({ value: i.name, label: i.name, hint: i.port !== null ? `port ${i.port}` : undefined })),
  ]);
  return choice === 'root' ? rootTarget() : instanceTarget(instances.find(i => i.name === choice)!);
}
