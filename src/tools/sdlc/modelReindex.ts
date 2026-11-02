/**
 * update_symbol_index({ model }) — bring one custom model's index rows in line with
 * its folder on disk.
 *
 * The file form needs the caller to know WHICH files changed. After a git pull, a
 * branch switch or a Visual Studio session the agent does not, so it either listed
 * files one by one (27 calls in one audited ISV session) or worked on a stale index
 * until the next full build. The staleness check in get_workspace_info could see
 * the problem but only name the newest file.
 *
 * Changed files are found by comparing each file's mtime with the mtime recorded
 * when it was last indexed (indexed_files), not with last_indexed_at: that is one
 * global timestamp every write bumps, so a file changed before an unrelated write
 * would look indexed. A model with no recorded rows yet is read in full once.
 */

import fs from 'fs';
import path from 'path';
import type { XppServerContext } from '../../types/context.js';
import { bridgeRefreshProvider } from '../../bridge/index.js';
import { isCustomModel } from '../../utils/modelClassifier.js';
import { getConfigManager } from '../../utils/configManager.js';
import { resetMetadataMtimeCache } from '../../utils/indexStaleness.js';
import { indexOneFile, isAotFolder } from './updateSymbolIndex.js';

/** Build output and VCS folders — the same ones the staleness scan skips. */
const SKIPPED_DIRS = new Set(['bin', '.git', 'xppmetadata']);

/** How many re-indexed object names the reply lists before summarising. */
const LISTED_NAMES = 10;

/**
 * The model's metadata folder (`…\<Package>\<Model>`).
 *
 * The index is asked first, because it holds the exact path of every file it has
 * read for the model. A model it has never seen is looked for under the configured
 * package roots, as `<root>\<Package>\<Model>` with any package name.
 */
export async function resolveModelFolder(
  model: string,
  context: XppServerContext,
): Promise<string | null> {
  for (const fp of context.symbolIndex.getModelFilePaths?.(model) ?? []) {
    if (!path.isAbsolute(fp)) continue;
    const parts = fp.split(/[\\/]/);
    const aotIdx = parts.findIndex(p => isAotFolder(p));
    if (aotIdx >= 2 && parts[aotIdx - 1].toLowerCase() === model.toLowerCase()) {
      const folder = parts.slice(0, aotIdx).join(path.sep);
      if (fs.existsSync(folder)) return folder;
    }
  }

  let roots: Array<string | null> = [];
  try {
    const info = await getConfigManager().getWorkspaceInfoDiagnostics();
    roots = [info.customPackagesPath, info.packagePath];
  } catch { /* no configuration — nothing more to try */ }
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    let packages: fs.Dirent[] = [];
    try { packages = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const pkg of packages) {
      if (!pkg.isDirectory()) continue;
      const candidate = path.join(root, pkg.name, model);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    }
  }
  return null;
}

/** Every file update_symbol_index can index: XML in an Ax* folder, and label text files. */
export function listModelFiles(folder: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, inAotFolder: boolean): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name.toLowerCase())) continue;
        walk(full, inAotFolder || isAotFolder(entry.name));
      } else if (entry.name.toLowerCase().endsWith('.label.txt')
        || (inAotFolder && entry.name.toLowerCase().endsWith('.xml'))) {
        files.push(full);
      }
    }
  };
  walk(folder, false);
  return files;
}

export async function reindexModel(model: string, context: XppServerContext) {
  const fail = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

  // A Microsoft model is tens of thousands of files and changes only with a platform
  // update, which is what build-database is for.
  if (!isCustomModel(model)) {
    return fail(
      `❌ "${model}" is not a custom model, so update_symbol_index(model) will not walk it. ` +
      `Standard models change with a platform update — rebuild them with build-database. ` +
      `If it IS yours, add it to CUSTOM_MODELS.`,
    );
  }

  const folder = await resolveModelFolder(model, context);
  if (!folder) {
    return fail(
      `❌ No folder found for model "${model}": the index holds no file of it, and no ` +
      `<package>\\${model} folder exists under the configured package paths. Check the spelling ` +
      `with get_workspace_info, or pass filePath for individual files.`,
    );
  }

  const started = Date.now();
  const { symbolIndex } = context;
  const onDisk = listModelFiles(folder);
  const recorded = symbolIndex.getIndexedFileMtimes?.(model) ?? new Map<string, number>();
  const firstPass = recorded.size === 0;

  const changed = onDisk.filter(fp => {
    const was = recorded.get(fp.toLowerCase());
    if (was === undefined) return true;
    try { return fs.statSync(fp).mtimeMs !== was; } catch { return false; }
  });

  // Rows for files that are gone: what the symbols table holds for the model, plus
  // files recorded but never symbolised (an empty label file). Only absolute paths
  // under this folder qualify — a relative or foreign path cannot be judged here,
  // and treating it as deleted would drop rows that are still true.
  const folderKey = folder.toLowerCase() + path.sep;
  const known = new Set<string>();
  for (const fp of symbolIndex.getModelFilePaths?.(model) ?? []) known.add(fp);
  const deleted = [...known].filter(fp =>
    path.isAbsolute(fp) && fp.toLowerCase().startsWith(folderKey) && !fs.existsSync(fp));

  if (changed.length === 0 && deleted.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `✅ Model **${model}** is already indexed: ${onDisk.length} file(s) checked, none changed ` +
          `since they were indexed (${Date.now() - started} ms). No bridge refresh was needed.`,
      }],
    };
  }

  context.workspaceScanner?.invalidate?.();
  let bridgeNote: string;
  try {
    const refreshed = await bridgeRefreshProvider(context.bridge);
    bridgeNote = refreshed ? `Bridge provider refreshed in ${refreshed.elapsedMs} ms.` : 'Bridge provider not available (skipped).';
  } catch (e: any) {
    bridgeNote = `Bridge refresh skipped: ${e?.message ?? e}`;
  }

  const failures: string[] = [];
  const names: string[] = [];
  for (const fp of [...changed, ...deleted]) {
    const result = await indexOneFile(fp, context);
    if (result.isError) failures.push(result.text);
    else if (!result.skipped) names.push(path.basename(fp).replace(/\.(label\.txt|xml)$/i, ''));
  }
  resetMetadataMtimeCache();

  const listed = names.slice(0, LISTED_NAMES).join(', ') +
    (names.length > LISTED_NAMES ? `, … and ${names.length - LISTED_NAMES} more` : '');
  const lines = [
    `✅ Model **${model}** re-indexed from ${folder} in ${Date.now() - started} ms.`,
    '',
    `Checked : ${onDisk.length} file(s)`,
    `Indexed : ${changed.length} changed or new` +
      (firstPass ? ' (first pass for this model: no file had been recorded yet, so all were read once)' : ''),
    `Removed : ${deleted.length} deleted from disk`,
    ...(names.length > 0 && !firstPass ? [`Objects : ${listed}`] : []),
    bridgeNote,
  ];
  if (failures.length > 0) {
    lines.push('', `⚠️ ${failures.length} file(s) failed:`, ...failures.slice(0, LISTED_NAMES));
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    ...(failures.length > 0 && failures.length === changed.length + deleted.length ? { isError: true } : {}),
  };
}
