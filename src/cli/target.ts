/**
 * Target selection — commands like start/index operate either on the root
 * server (repo .env) or on one instance under instances/. Resolves a
 * positional instance name, or asks interactively when instances exist.
 */
import * as fs from 'node:fs';
import { paths, repoRoot } from './context.js';
import { Instance, listInstances } from './instances.js';
import { askSelect } from './ui.js';

export interface Target {
  /** 'root' or the instance name */
  name: string;
  label: string;
  /** null → root default config (loadEnv falls back to repo .env) */
  envFile: string | null;
  port: number | null;
  instance?: Instance;
}

export function rootTarget(): Target {
  return { name: 'root', label: 'root server (.env)', envFile: fs.existsSync(paths.rootEnv) ? paths.rootEnv : null, port: null };
}

export function instanceTarget(inst: Instance): Target {
  return { name: inst.name, label: `instance '${inst.name}'`, envFile: inst.envFile, port: inst.port, instance: inst };
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
    { value: 'root', label: 'root server', hint: repoRoot },
    ...instances.map(i => ({ value: i.name, label: i.name, hint: i.port !== null ? `port ${i.port}` : undefined })),
  ]);
  return choice === 'root' ? rootTarget() : instanceTarget(instances.find(i => i.name === choice)!);
}
