/**
 * Non-revertible-modification guard tests (d365fo_file action=modify).
 *
 * Outside a git work tree undo cannot revert a modify, so the guard keeps a copy of
 * the original even with createBackup=false. Two refinements:
 *  - the copy is taken up front as before, but REMOVED when the call ends without
 *    changing the file — every refused call used to leave a `.backup-*` behind;
 *  - a file this server session created gets none: undo deletes it outright.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
import {
  planRecoverableModification, keptBackupNote, discardBackup, settleFailedModification,
} from '../../src/tools/write/modifyBackup';
import { recordCreatedArtifact, _clearCreatedArtifactLedger } from '../../src/workspace/createdArtifactLedger';
import { resetRepeatedNoteMemory } from '../../src/utils/repeatedNotes';

const execFileAsync = util.promisify(execFile);

// Skip the git-repo cases gracefully when git is not installed (the guard
// itself treats "git missing" as "not a repo", which the non-repo cases cover).
const gitAvailable: boolean = await execFileAsync('git', ['--version'])
  .then(() => true)
  .catch(() => false);

const ORIGINAL = '<AxClass><Name>TestClass</Name></AxClass>';

async function listBackups(filePath: string): Promise<string[]> {
  const entries = await fs.readdir(path.dirname(filePath));
  const prefix = `${path.basename(filePath)}.backup-`;
  return entries.filter(e => e.startsWith(prefix));
}

describe('modify backups', () => {
  let tmpDir: string;
  let xmlFile: string;

  beforeEach(async () => {
    _clearCreatedArtifactLedger();
    resetRepeatedNoteMemory();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'modify-backup-'));
    xmlFile = path.join(tmpDir, 'AxClass', 'TestClass.xml');
    await fs.mkdir(path.dirname(xmlFile), { recursive: true });
    await fs.writeFile(xmlFile, ORIGINAL, 'utf-8');
  });

  afterEach(async () => {
    _clearCreatedArtifactLedger();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('outside git + createBackup=false → copy taken before the write, note on keep', async () => {
    const pending = (await planRecoverableModification(xmlFile, false))!;
    await fs.writeFile(xmlFile, '<AxClass><Name>Changed</Name></AxClass>', 'utf-8');

    const backups = await listBackups(xmlFile);
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(path.dirname(xmlFile), backups[0]), 'utf-8')).toBe(ORIGINAL);
    const note = keptBackupNote(pending);
    expect(note).toContain('Target is not under git');
    expect(note).toContain('cannot revert a modify');
    expect(note).toContain(backups[0]);
  });

  it('createBackup=true → the note names the copy', async () => {
    const pending = (await planRecoverableModification(xmlFile, true))!;
    expect(keptBackupNote(pending)).toBe(`\n\nℹ️ Backup: ${pending.backupPath}`);
  });

  it('a failed call that left the file unchanged removes its copy and says nothing', async () => {
    const pending = (await planRecoverableModification(xmlFile, false))!;
    expect(await settleFailedModification(pending)).toBe('');
    expect(await listBackups(xmlFile)).toHaveLength(0);
  });

  it('a failed call that changed the file first keeps its copy', async () => {
    const pending = (await planRecoverableModification(xmlFile, false))!;
    await fs.writeFile(xmlFile, '<AxClass><Name>HalfDone</Name></AxClass>', 'utf-8');

    expect(await settleFailedModification(pending)).toContain(path.basename(pending.backupPath));
    expect(await listBackups(xmlFile)).toHaveLength(1);
  });

  it('a skip discards the copy', async () => {
    await discardBackup((await planRecoverableModification(xmlFile, false))!);
    expect(await listBackups(xmlFile)).toHaveLength(0);
  });

  it('a file this session created → no copy (undo deletes it)', async () => {
    recordCreatedArtifact({ filePath: xmlFile, objectType: 'class', objectName: 'TestClass' });
    expect(await planRecoverableModification(xmlFile, false)).toBeNull();
    expect(await listBackups(xmlFile)).toHaveLength(0);
  });

  it('…unless the caller asks for one', async () => {
    recordCreatedArtifact({ filePath: xmlFile, objectType: 'class', objectName: 'TestClass' });
    expect(await planRecoverableModification(xmlFile, true)).not.toBeNull();
  });

  it.skipIf(!gitAvailable)(
    'file inside a git repo + createBackup=false → no copy',
    async () => {
      await execFileAsync('git', ['init'], { cwd: tmpDir });
      expect(await planRecoverableModification(xmlFile, false)).toBeNull();
      expect(await listBackups(xmlFile)).toHaveLength(0);
    },
  );

  it.skipIf(!gitAvailable)(
    'git work-tree result is cached per directory (second call spawns no new decision)',
    async () => {
      await execFileAsync('git', ['init'], { cwd: tmpDir });

      // Two modifies in the same directory: both must agree (cache returns the
      // same verdict) and never take a copy inside a repo.
      expect(await planRecoverableModification(xmlFile, false)).toBeNull();
      expect(await planRecoverableModification(xmlFile, false)).toBeNull();
      expect(await listBackups(xmlFile)).toHaveLength(0);
    },
  );
});
