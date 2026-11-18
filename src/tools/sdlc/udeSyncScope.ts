/**
 * Which database sync a UDE deployment needs, chosen from what changed.
 *
 * A deployment syncs either everything (Release package, ~20 min) or nothing (Dev package,
 * ~3 min); it cannot sync a table list. The caller used to have to guess: no sync after a table
 * change leaves the environment without it, a full sync after a class-only change wastes 20
 * minutes. Without an explicit `dbSync`, the schema files of the package (tables, views, data
 * entities, EDTs, enums and their extensions) are compared with the last deployment this server
 * made WITH a sync to the same environment: nothing newer means no sync, anything newer, or no
 * known earlier sync, means a full one.
 */
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SCHEMA_TYPES = [
  'AxTable', 'AxTableExtension', 'AxView', 'AxViewExtension', 'AxDataEntityView',
  'AxDataEntityViewExtension', 'AxEdt', 'AxEdtExtension', 'AxEnum', 'AxEnumExtension',
];

export const DEFAULT_SYNC_STATE_FILE = path.join(os.homedir(), '.d365fo-mcp', 'ude-sync-state.json');

export interface SyncDecision {
  fullSync: boolean;
  /** One sentence for the deployment reply. */
  reason: string;
}

const key = (environmentUrl: string, pkg: string) =>
  `${environmentUrl.toLowerCase().replace(/\/+$/, '')}|${pkg.toLowerCase()}`;

async function readState(file: string): Promise<Record<string, number>> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Schema files of the package changed after `since`, as `<AxType>/<Name>`. */
export async function schemaFilesChangedSince(packageDir: string, since: number): Promise<string[]> {
  const changed: string[] = [];
  let models;
  try {
    models = await readdir(packageDir, { withFileTypes: true });
  } catch {
    return changed;
  }
  for (const model of models) {
    if (!model.isDirectory() || model.name.toLowerCase() === 'xppmetadata') continue;
    for (const type of SCHEMA_TYPES) {
      let files;
      try {
        files = await readdir(path.join(packageDir, model.name, type), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.toLowerCase().endsWith('.xml')) continue;
        try {
          if ((await stat(path.join(packageDir, model.name, type, file.name))).mtimeMs > since) {
            changed.push(`${type}/${path.basename(file.name, '.xml')}`);
          }
        } catch { /* removed while scanning */ }
      }
    }
  }
  return changed.sort();
}

export async function decideSyncScope(
  environmentUrl: string, packageDir: string, stateFile: string = DEFAULT_SYNC_STATE_FILE,
): Promise<SyncDecision> {
  const last = (await readState(stateFile))[key(environmentUrl, path.basename(packageDir))];
  if (typeof last !== 'number') {
    return {
      fullSync: true,
      reason: 'No earlier deployment with a database sync to this environment is known to this server, '
        + 'so the schema state there is unknown.',
    };
  }
  const changed = await schemaFilesChangedSince(packageDir, last);
  if (changed.length === 0) {
    return {
      fullSync: false,
      reason: 'No table, view, data entity, EDT or enum changed since the last deployment with a sync '
        + `(${new Date(last).toISOString()}).`,
    };
  }
  const shown = changed.slice(0, 5).join(', ') + (changed.length > 5 ? `, … (+${changed.length - 5})` : '');
  return {
    fullSync: true,
    reason: `${changed.length} schema file(s) changed since the last deployment with a sync: ${shown}.`,
  };
}

/** Remembers that a deployment that synced the database started at `startedAt`. Best-effort. */
export async function recordSyncedDeploy(
  environmentUrl: string, pkg: string, startedAt: number, stateFile: string = DEFAULT_SYNC_STATE_FILE,
): Promise<void> {
  try {
    const state = await readState(stateFile);
    state[key(environmentUrl, pkg)] = startedAt;
    await mkdir(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    await rename(tmp, stateFile);
  } catch { /* the next deployment then syncs in full */ }
}
