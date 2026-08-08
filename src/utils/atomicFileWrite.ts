/**
 * Crash-safe, serialized replacement of files the direct-XML write path edits.
 *
 * Every direct-XML fallback in modifyD365File is a read-modify-write over a whole
 * AOT file. Two failure modes follow from doing that with a plain fs.writeFile:
 *
 *  - Truncation. writeFile opens the target with O_TRUNC, so a crash, a full disk
 *    or a killed process between the truncate and the last chunk leaves a partial
 *    XML file. The object's only copy on disk is then unparseable to both the
 *    compiler and the bridge, and there is nothing left to recover it from.
 *  - Lost updates. Two edits of the same file that overlap both read the same
 *    original and the later write discards the earlier one's element outright.
 *    `d365fo_file` is deliberately excluded from the in-flight call dedup (writes
 *    must never be coalesced), so concurrent identical modifies do reach here.
 *
 * writeFileAtomic closes the first by writing a sibling temp file and renaming it
 * over the target — rename is atomic, so a reader sees either the whole old file or
 * the whole new one. withFileLock closes the second by serializing whole
 * read-modify-write sequences per path.
 *
 * Scope: in-process. This does not coordinate with a second server process or with
 * Visual Studio holding the same file — that would need the filesystem locks in
 * operationLocks.ts, which are far too heavy for a per-file edit.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Lock key for a path. Separators are normalised and the whole thing lowercased so
 * `C:\Pkg\A.xml`, `C:/pkg/a.xml` and `c:\pkg\A.xml` serialize against each other —
 * on Windows they are one file. On a case-sensitive filesystem this only ever
 * over-serializes, which is the safe direction.
 */
function lockKey(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
}

const fileLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with exclusive access to `filePath` relative to other withFileLock
 * callers. Queued in FIFO order; a rejection in one holder does not poison the
 * queue, and the map entry is dropped once the last waiter is done so a long-lived
 * process does not accumulate one entry per file ever edited.
 */
export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(filePath);
  const previous = fileLocks.get(key) ?? Promise.resolve();
  // .then(fn, fn): the next holder must run whether the previous one resolved or
  // threw, otherwise one failed edit deadlocks every later edit of that file.
  const current = previous.then(fn, fn);
  const queued = current.catch(() => {});
  fileLocks.set(key, queued);
  void queued.then(() => {
    if (fileLocks.get(key) === queued) fileLocks.delete(key);
  });
  return current;
}

let tempCounter = 0;

/**
 * Replace `filePath`'s contents by writing a temp sibling and renaming it over the
 * target. The temp file is a sibling (not in os.tmpdir()) because rename is only
 * atomic within one filesystem, and the package directory is routinely on a
 * different volume than the temp directory.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${(tempCounter++).toString(36)}`;
  try {
    await fs.writeFile(tempPath, content, 'utf-8');
    await renameWithRetry(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Windows fails a rename onto a file another process has open (an editor, an
 * indexer, an anti-virus scanner) with EPERM/EBUSY/EACCES, and those holders let go
 * within milliseconds. Retrying briefly avoids turning a transient handle into a
 * failed modify; if it still will not budge we write in place, because losing
 * atomicity is strictly better than losing the edit — that is what the code did
 * unconditionally before.
 */
async function renameWithRetry(tempPath: string, filePath: string): Promise<void> {
  const transient = new Set(['EPERM', 'EBUSY', 'EACCES']);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tempPath, filePath);
      return;
    } catch (error: any) {
      if (!transient.has(error?.code) || attempt >= 4) {
        if (!transient.has(error?.code)) throw error;
        console.error(
          `[atomicFileWrite] rename onto ${filePath} kept failing with ${error.code} — ` +
          `falling back to a non-atomic in-place write`,
        );
        const content = await fs.readFile(tempPath, 'utf-8');
        await fs.writeFile(filePath, content, 'utf-8');
        await fs.rm(tempPath, { force: true }).catch(() => {});
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}
