/**
 * The `.backup-*` copy a modify keeps of the file it changes.
 *
 * Outside a git work tree d365fo_file(action="undo") cannot revert a modify — it only
 * deletes files created in the current session — so a copy is kept there even with
 * createBackup=false. The copy is taken BEFORE the operation runs, as it always was,
 * so a write can never land without one; what changed is that it is removed again
 * when the call ends without having changed the file. A refused operation used to
 * leave a copy of an untouched file beside the AOT source on every call — four
 * refused calls on one view, four copies.
 */

import * as fs from 'fs/promises';
import { constants as FS_CONSTANTS } from 'fs';
import path from 'path';
import util from 'util';
import { execFile } from 'child_process';
import { sayOncePerSession } from '../../utils/repeatedNotes.js';
import { lookupCreatedArtifact } from '../../workspace/createdArtifactLedger.js';

/**
 * Create file backup and verify it was written successfully.
 * Throws if the source file is missing or the copy fails, so callers
 * always know whether a valid backup exists before overwriting.
 * Returns the backup file path.
 *
 * The name carries MILLISECONDS and, if that still collides, a counter. At the old
 * one-second resolution two modifies of the same file inside the same second
 * produced the same backup name, so the second copy overwrote the first with
 * already-modified content — on a target outside git (exactly the case that forces
 * a backup, see planRecoverableModification) the original was then unrecoverable.
 * COPYFILE_EXCL is what makes the retry a claim rather than a check: it fails
 * instead of overwriting, so two callers racing on the same name cannot both win.
 */
export async function createFileBackup(filePath: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const base = `${filePath}.backup-${timestamp}`;

  for (let attempt = 0; ; attempt++) {
    const backupPath = attempt === 0 ? base : `${base}-${attempt}`;
    try {
      await fs.copyFile(filePath, backupPath, FS_CONSTANTS.COPYFILE_EXCL);
      // Confirm the backup has non-zero size before proceeding
      const stat = await fs.stat(backupPath);
      if (stat.size === 0) {
        throw new Error('Backup file was created but is empty');
      }
      return backupPath;
    } catch (error: any) {
      if (error?.code === 'EEXIST' && attempt < 100) {
        continue;
      }
      throw new Error(
        `Failed to create backup at "${backupPath}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

const execFileAsync = util.promisify(execFile);

// Directory → inside-git-work-tree result, cached for the process lifetime so
// repeated modifies don't re-spawn git for the same metadata folder.
const gitWorkTreeCache = new Map<string, boolean>();

/**
 * Cheap check whether a file lives inside a git work tree — i.e. whether
 * undo (git checkout) could revert a change to it.
 * git not installed, timeout, or any other error → treated as "not a repo".
 */
async function isInsideGitWorkTree(filePath: string): Promise<boolean> {
  const dir = path.dirname(filePath);
  const cached = gitWorkTreeCache.get(dir);
  if (cached !== undefined) return cached;
  let inside = false;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      timeout: 5_000,
      windowsHide: true,
    });
    inside = stdout.trim() === 'true';
  } catch {
    inside = false;
  }
  gitWorkTreeCache.set(dir, inside);
  return inside;
}

/** A backup taken before a modify runs, until the call decides whether to keep it. */
export interface PendingBackup {
  filePath: string;
  backupPath: string;
  /** The file's bytes at backup time — what "the call changed the file" is measured against. */
  original: Buffer;
  /** Taken because the target is outside git, not because the caller asked. */
  forced: boolean;
}

/** The modify's backup, threaded from where it is taken to where it is settled. */
export interface BackupSlot {
  pending?: PendingBackup | null;
  settled?: boolean;
}

const asBuffer = (data: Buffer | string): Buffer => (Buffer.isBuffer(data) ? data : Buffer.from(String(data)));

/**
 * Take the backup a modify needs, or none. Honors an explicit createBackup=true;
 * with createBackup=false it still takes one outside a git work tree, where the copy
 * is the only way back.
 *
 * Except for a file this server session created: undo deletes that outright (the
 * created-artifact ledger), so a copy restores nothing. That is every operations[]
 * entry on a create — one session left five copies of three files that had not
 * existed a minute earlier.
 */
export async function planRecoverableModification(
  filePath: string,
  createBackup: boolean,
): Promise<PendingBackup | null> {
  if (!createBackup) {
    if (lookupCreatedArtifact(filePath)) return null;
    if (await isInsideGitWorkTree(filePath)) return null;
  }
  const original = asBuffer(await fs.readFile(filePath));
  const backupPath = await createFileBackup(filePath);
  return { filePath, backupPath, original, forced: !createBackup };
}

/** The response line for a backup that is kept. */
export function keptBackupNote(pending: PendingBackup): string {
  if (!pending.forced) return `\n\nℹ️ Backup: ${pending.backupPath}`;
  // Keyed by the MODEL folder (<...>/<Package>/<Model>/Ax<Type>/<file>.xml), not
  // the file: "this metadata tree is not under git" is a property of the tree, so
  // once said it is said for every object in it.
  return sayOncePerSession(
    'git-backup',
    path.win32.dirname(path.win32.dirname(pending.filePath)),
    `\n\nℹ️ Target is not under git — kept a copy of the original: ${pending.backupPath}. ` +
      `Outside git, d365fo_file(action="undo") only removes files created in this session; ` +
      `it cannot revert a modify, so restore from that copy if one is needed.`,
    `\n\nℹ️ Backup: ${pending.backupPath}`,
  );
}

/** The call wrote nothing (a skip): the copy is of an unchanged file. */
export async function discardBackup(pending: PendingBackup): Promise<void> {
  try { await fs.rm(pending.backupPath, { force: true }); } catch { /* best effort — a stray copy is harmless */ }
}

/**
 * The call failed. Keep the copy only when the file changed before it did (a batch
 * half-applied, a two-step bridge write that could not roll back); a refusal left
 * the file as it was.
 */
export async function settleFailedModification(pending: PendingBackup): Promise<string> {
  let current: Buffer | null = null;
  try { current = asBuffer(await fs.readFile(pending.filePath)); } catch { /* gone — that is a change */ }
  if (current && current.equals(pending.original)) {
    await discardBackup(pending);
    return '';
  }
  return keptBackupNote(pending);
}
