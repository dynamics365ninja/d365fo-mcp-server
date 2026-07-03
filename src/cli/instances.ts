/**
 * Multi-instance helpers — TypeScript counterpart of instances/*.ps1.
 * An instance is any directory under instances/ containing a .env file.
 */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { paths } from './context.js';
import { readEnvValue } from './envFile.js';

export interface Instance {
  name: string;
  dir: string;
  envFile: string;
  port: number | null;
}

export function listInstances(): Instance[] {
  if (!fs.existsSync(paths.instancesDir)) return [];
  return fs.readdirSync(paths.instancesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const dir = join(paths.instancesDir, e.name);
      const envFile = join(dir, '.env');
      return { name: e.name, dir, envFile };
    })
    .filter(i => fs.existsSync(i.envFile))
    .map(i => {
      const raw = readEnvValue(i.envFile, 'PORT');
      const port = raw && /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
      return { ...i, port };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getInstance(name: string): Instance | undefined {
  return listInstances().find(i => i.name === name);
}

/** Next free port: max of existing instance ports + 1, or 3001. */
export function suggestPort(instances: Instance[]): number {
  const used = instances.map(i => i.port).filter((p): p is number => p !== null);
  return used.length > 0 ? Math.max(...used) + 1 : 3001;
}

/**
 * Create instances/<name>/{.env,data,metadata} from the .env.template
 * (with __PORT__ substituted). Throws when the instance already exists
 * or the template is missing.
 */
export function createInstance(name: string, port: number): Instance {
  if (!fs.existsSync(paths.instanceTemplate)) {
    throw new Error(`Template not found: ${paths.instanceTemplate}`);
  }
  const dir = join(paths.instancesDir, name);
  const envFile = join(dir, '.env');
  if (fs.existsSync(envFile)) {
    throw new Error(`Instance '${name}' already exists.`);
  }
  fs.mkdirSync(join(dir, 'data'), { recursive: true });
  fs.mkdirSync(join(dir, 'metadata'), { recursive: true });
  const content = fs.readFileSync(paths.instanceTemplate, 'utf8').replaceAll('__PORT__', String(port));
  fs.writeFileSync(envFile, content);
  return { name, dir, envFile, port };
}
