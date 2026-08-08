/**
 * Swapping a downloaded database must take its WAL files with it (audit 2.6 #25).
 *
 * The download validated the temp file and rename()d it over the live database,
 * leaving the PREVIOUS database's `-wal` and `-shm` sitting next to it. SQLite
 * treats a `-wal` it finds beside a database as that database's own journal, so the
 * next open replayed pages from the old generation into the freshly downloaded
 * file — reported either as corruption or, worse, as rows that quietly came back.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { swapDownloadedDatabase } from '../../src/database/download';

const dirs: string[] = [];
function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-dbswap-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
  dirs.length = 0;
});

describe('swapDownloadedDatabase', () => {
  it('removes the previous database\'s -wal and -shm', async () => {
    const dir = scratch();
    const finalPath = path.join(dir, 'xpp-metadata.db');
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(finalPath, 'OLD DATABASE');
    fs.writeFileSync(`${finalPath}-wal`, 'OLD WAL');
    fs.writeFileSync(`${finalPath}-shm`, 'OLD SHM');
    fs.writeFileSync(tmpPath, 'NEW DATABASE');

    await swapDownloadedDatabase(tmpPath, finalPath);

    expect(fs.readFileSync(finalPath, 'utf-8')).toBe('NEW DATABASE');
    expect(fs.existsSync(`${finalPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${finalPath}-shm`)).toBe(false);
  });

  it('removes the temp file\'s own companions, left by the integrity check', async () => {
    const dir = scratch();
    const finalPath = path.join(dir, 'xpp-metadata.db');
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, 'NEW DATABASE');
    fs.writeFileSync(`${tmpPath}-wal`, 'TMP WAL');
    fs.writeFileSync(`${tmpPath}-shm`, 'TMP SHM');

    await swapDownloadedDatabase(tmpPath, finalPath);

    expect(fs.readdirSync(dir)).toEqual(['xpp-metadata.db']);
  });

  it('works when there is no previous database at all', async () => {
    const dir = scratch();
    const finalPath = path.join(dir, 'xpp-metadata.db');
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, 'FIRST DOWNLOAD');

    await swapDownloadedDatabase(tmpPath, finalPath);

    expect(fs.readFileSync(finalPath, 'utf-8')).toBe('FIRST DOWNLOAD');
  });
});
