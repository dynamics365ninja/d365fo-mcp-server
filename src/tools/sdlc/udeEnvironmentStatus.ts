/**
 * What the UDE environment is doing, for get_workspace_info: the operation it is running now,
 * how the last deploy ended, and whether local files are newer than that deploy.
 *
 * Read-only and silent on every failure: not a UDE, no Dataverse URL, not signed in (this never
 * opens a sign-in page), a slow or throttled environment all yield "no section", never an error.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { getDataverseAccessToken, readDataverseSettings } from '../../utils/dataverseAuth.js';
import { recentOperations, type DataverseClient, type OperationRecord } from './udeSysTest.js';
import { DEFAULT_SYNC_STATE_FILE, lastRecordedDeploy } from './udeSyncScope.js';

const STATUS_TIMEOUT_MS = 4_000;

export interface UdeStatusDeps {
  client: DataverseClient;
  /** Folder of the package holding the workspace model; undefined when unknown. */
  packageDir?: string;
  stateFile?: string;
}

/** Files of the package modified after `since`, as `<AxType>/<Name>`; XppMetadata is skipped. */
export async function filesChangedSince(packageDir: string, since: number): Promise<string[]> {
  const changed: string[] = [];
  let models;
  try {
    models = await readdir(packageDir, { withFileTypes: true });
  } catch {
    return changed;
  }
  for (const model of models) {
    if (!model.isDirectory() || /^(xppmetadata|descriptor)$/i.test(model.name)) continue;
    let types;
    try {
      types = await readdir(path.join(packageDir, model.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const type of types) {
      if (!type.isDirectory() || !type.name.startsWith('Ax')) continue;
      let files;
      try {
        files = await readdir(path.join(packageDir, model.name, type.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.toLowerCase().endsWith('.xml')) continue;
        try {
          if ((await stat(path.join(packageDir, model.name, type.name, file.name))).mtimeMs > since) {
            changed.push(`${type.name}/${path.basename(file.name, '.xml')}`);
          }
        } catch { /* removed while scanning */ }
      }
    }
  }
  return changed.sort();
}

const stamp = (iso: string) => iso.slice(0, 16).replace('T', ' ') + ' UTC';
const isDeploy = (o: OperationRecord) => /deploy/i.test(o.name);

/** The status lines (at most three), or [] when nothing is known. */
export async function udeEnvironmentStatusLines(deps: UdeStatusDeps): Promise<string[]> {
  const ops = await recentOperations(deps.client);
  const lines: string[] = [];
  const running = ops.filter(o => o.active).reverse();
  lines.push(running.length > 0
    ? `Running now      : ${running.map(o => `${o.name} (since ${stamp(o.startedAt)})`).join(', ')}` +
      ' - one operation at a time: others wait, and the web endpoint may answer HTTP 503'
    : 'Running now      : nothing');
  const last = ops.find(o => !o.active && isDeploy(o));
  if (last) {
    lines.push(`Last deploy      : ${last.status ?? 'finished'}, ${stamp(last.endedAt ?? last.startedAt)}`);
  }
  if (deps.packageDir) {
    // Our own record of when a deploy was sent is the better reference; the environment's
    // start time of the last deploy is the fallback.
    const recorded = await lastRecordedDeploy(
      deps.client.url, path.basename(deps.packageDir), deps.stateFile ?? DEFAULT_SYNC_STATE_FILE);
    const since = recorded ?? (last ? Date.parse(last.startedAt) : undefined);
    if (since !== undefined && Number.isFinite(since)) {
      const newer = await filesChangedSince(deps.packageDir, since);
      lines.push(newer.length === 0
        ? 'Local vs deploy  : no local file is newer than the last deploy'
        : `Local vs deploy  : ${newer.length} local file(s) newer than the last deploy, so tests run against an ` +
          `older build: ${newer.slice(0, 3).join(', ')}${newer.length > 3 ? ', ...' : ''}`);
    }
  }
  return lines;
}

/**
 * The section for the real environment, or [] on anything but a signed-in UDE. Bounded in time
 * so the first call of a session is never held up by a slow environment. `override` is for tests.
 */
export async function udeEnvironmentSection(
  packageDirOf: () => Promise<string | undefined>,
  override?: Partial<UdeStatusDeps>,
  timeoutMs: number = STATUS_TIMEOUT_MS,
): Promise<string[]> {
  try {
    const settings = readDataverseSettings();
    if (!settings && !override?.client) return [];
    const client: DataverseClient = override?.client ?? {
      url: settings!.url,
      getToken: () => getDataverseAccessToken(settings!, undefined, { silentOnly: true }),
    };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<string[]>(resolve => { timer = setTimeout(() => resolve([]), timeoutMs); });
    try {
      const work = (async () => udeEnvironmentStatusLines({
        ...override, client, packageDir: override?.packageDir ?? await packageDirOf().catch(() => undefined),
      }))().catch(() => [] as string[]);
      const lines = await Promise.race([work, timeout]);
      return lines.length > 0 ? ['', '## UDE environment', ...lines] : [];
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return [];
  }
}
