/**
 * A second modify inside the same second must not overwrite the first backup
 * (audit 2.4 #22).
 *
 * The backup name was a one-second timestamp, so two modifies of the same file in
 * the same second produced the same `<file>.backup-<stamp>` path and the second
 * copy silently replaced the first — with content that had already been modified.
 * On a target outside git that backup is the ONLY recovery route (see
 * ensureRecoverableModification, which forces one exactly there), so the original
 * was gone for good.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createFileBackup } from '../../src/tools/modifyD365File';

const dirs: string[] = [];
function tempObject(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-backup-'));
  dirs.push(dir);
  const file = path.join(dir, 'ConDemoTable.xml');
  fs.writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
  dirs.length = 0;
});

describe('createFileBackup', () => {
  it('keeps the first backup when a second modify lands in the same clock tick', async () => {
    // Frozen clock: the timestamp component is identical for both calls, which is
    // what a fast agent doing add-field then add-index produces on a real disk.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-08T10:11:12.345Z'));

    const file = tempObject('<AxTable>ORIGINAL</AxTable>');
    const first = await createFileBackup(file);

    fs.writeFileSync(file, '<AxTable>MODIFIED ONCE</AxTable>');
    const second = await createFileBackup(file);

    expect(second).not.toBe(first);
    expect(fs.readFileSync(first, 'utf-8')).toBe('<AxTable>ORIGINAL</AxTable>');
    expect(fs.readFileSync(second, 'utf-8')).toBe('<AxTable>MODIFIED ONCE</AxTable>');
  });

  it('names backups at millisecond resolution', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-08T10:11:12.345Z'));

    const file = tempObject('<AxTable/>');
    expect(path.basename(await createFileBackup(file)))
      .toBe('ConDemoTable.xml.backup-2026-08-08T10-11-12-345');
  });

  it('still fails loudly when the source file is missing', async () => {
    const file = tempObject('<AxTable/>');
    fs.unlinkSync(file);

    await expect(createFileBackup(file)).rejects.toThrow(/Failed to create backup/);
  });
});
