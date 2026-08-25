/**
 * Non-revertible-modification guard tests (d365fo_file action=modify).
 *
 * undo_last_modification restores files via `git checkout`, which only works
 * when the target lives inside a git work tree. ensureRecoverableModification
 * therefore force-enables the pre-modify backup when the file is NOT under
 * git, so a bad modify with createBackup=false is never unrecoverable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
import { ensureRecoverableModification } from '../../src/tools/write/modifyD365File';

const execFileAsync = util.promisify(execFile);

// Skip the git-repo cases gracefully when git is not installed (the guard
// itself treats "git missing" as "not a repo", which the non-repo cases cover).
const gitAvailable: boolean = await execFileAsync('git', ['--version'])
  .then(() => true)
  .catch(() => false);

async function listBackups(filePath: string): Promise<string[]> {
  const entries = await fs.readdir(path.dirname(filePath));
  const prefix = `${path.basename(filePath)}.backup-`;
  return entries.filter(e => e.startsWith(prefix));
}

describe('ensureRecoverableModification', () => {
  let tmpDir: string;
  let xmlFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'modify-backup-'));
    xmlFile = path.join(tmpDir, 'AxClass', 'TestClass.xml');
    await fs.mkdir(path.dirname(xmlFile), { recursive: true });
    await fs.writeFile(xmlFile, '<AxClass><Name>TestClass</Name></AxClass>', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('file outside a git repo + createBackup=false → backup forced and note returned', async () => {
    const note = await ensureRecoverableModification(xmlFile, false);

    const backups = await listBackups(xmlFile);
    expect(backups).toHaveLength(1);
    expect(note).toContain('Target is not under git');
    expect(note).toContain('d365fo_file(action="undo") would not work here');
    expect(note).toContain(backups[0]);
  });

  it('createBackup=true → backup created, no forced-backup note', async () => {
    const note = await ensureRecoverableModification(xmlFile, true);

    expect(await listBackups(xmlFile)).toHaveLength(1);
    expect(note).toBe('');
  });

  it.skipIf(!gitAvailable)(
    'file inside a git repo + createBackup=false → no backup, no note',
    async () => {
      await execFileAsync('git', ['init'], { cwd: tmpDir });

      const note = await ensureRecoverableModification(xmlFile, false);

      expect(await listBackups(xmlFile)).toHaveLength(0);
      expect(note).toBe('');
    },
  );

  it.skipIf(!gitAvailable)(
    'git work-tree result is cached per directory (second call spawns no new decision)',
    async () => {
      await execFileAsync('git', ['init'], { cwd: tmpDir });

      // Two modifies in the same directory: both must agree (cache returns the
      // same verdict) and never force a backup inside a repo.
      expect(await ensureRecoverableModification(xmlFile, false)).toBe('');
      expect(await ensureRecoverableModification(xmlFile, false)).toBe('');
      expect(await listBackups(xmlFile)).toHaveLength(0);
    },
  );
});
