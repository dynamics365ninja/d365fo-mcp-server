/**
 * Direct-XML writes must be atomic and serialized (audit 2.4 #21).
 *
 * Every direct-XML fallback in modifyD365File is a read-modify-write over a whole
 * AOT file, and both halves were unguarded:
 *
 *  - fs.writeFile opens the target with O_TRUNC, so a crash between the truncate
 *    and the last chunk leaves a half-written XML — unparseable to the compiler and
 *    to the bridge, with no second copy anywhere.
 *  - Nothing serialized two edits of the same file. `d365fo_file` is deliberately
 *    outside the in-flight call dedup (writes must never be coalesced), so
 *    concurrent modifies do overlap, and the later write discards whatever element
 *    the earlier one added.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from '../../src/utils/atomicFileWrite';

const dirs: string[] = [];
function tempFile(contents = 'original'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-atomic-'));
  dirs.push(dir);
  const file = path.join(dir, 'ConDemoTable.xml');
  fs.writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
  dirs.length = 0;
});

describe('writeFileAtomic', () => {
  it('replaces the target by rename rather than truncating it in place', async () => {
    const file = tempFile();
    const before = fs.statSync(file).ino;

    await writeFileAtomic(file, 'patched');

    // A rename swaps the directory entry for a different file, so the inode
    // changes; an in-place write keeps it. This is the observable difference
    // between "a reader always sees a whole file" and "a reader can see a
    // truncated one", and it is the reason a crash mid-write is survivable.
    expect(fs.readFileSync(file, 'utf-8')).toBe('patched');
    expect(fs.statSync(file).ino).not.toBe(before);
  });

  it('leaves no temp files behind', async () => {
    const file = tempFile();
    await writeFileAtomic(file, 'patched');

    expect(fs.readdirSync(path.dirname(file))).toEqual(['ConDemoTable.xml']);
  });

  it('leaves the original intact when the write fails', async () => {
    const file = tempFile();
    // A directory where the temp sibling would go: the temp write fails and the
    // target is never opened at all.
    fs.mkdirSync(path.join(path.dirname(file), 'blocked'));
    const unwritable = path.join(path.dirname(file), 'blocked');

    await expect(writeFileAtomic(unwritable, 'patched')).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf-8')).toBe('original');
  });
});

describe('withFileLock', () => {
  /** A read-modify-write with an await in the middle — the shape every direct-XML editor has. */
  async function appendUnderLock(file: string, marker: string): Promise<void> {
    await withFileLock(file, async () => {
      const content = await fs.promises.readFile(file, 'utf-8');
      await new Promise(r => setTimeout(r, 20)); // patching / regex work
      await writeFileAtomic(file, `${content}\n${marker}`);
    });
  }

  it('keeps both concurrent edits instead of letting the later write win', async () => {
    const file = tempFile('<AxTable/>');

    await Promise.all([appendUnderLock(file, 'FIRST'), appendUnderLock(file, 'SECOND')]);

    const result = fs.readFileSync(file, 'utf-8');
    expect(result).toContain('FIRST');
    expect(result).toContain('SECOND');
  });

  it('does not deadlock the file after a holder throws', async () => {
    const file = tempFile();

    await expect(withFileLock(file, async () => { throw new Error('patch failed'); })).rejects.toThrow('patch failed');

    await expect(withFileLock(file, async () => 'next edit ran')).resolves.toBe('next edit ran');
  });

  it('serializes the same file across separator and case spellings', async () => {
    const file = tempFile('<AxTable/>');
    const alias = file.replace(/\\/g, '/').toUpperCase();

    await Promise.all([appendUnderLock(file, 'FIRST'), appendUnderLock(alias, 'SECOND')]);

    const result = fs.readFileSync(file, 'utf-8');
    expect(result).toContain('FIRST');
    expect(result).toContain('SECOND');
  });
});
