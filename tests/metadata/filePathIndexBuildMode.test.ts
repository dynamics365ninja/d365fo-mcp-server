/**
 * How the deferred file_path indexes get built — worker thread or inline.
 *
 * `d365fo-mcp setup` died holding a database lock: build-database.ts sets
 * locking_mode = EXCLUSIVE on the writer, but the XppSymbolIndex constructor had
 * already handed the file_path index builds to worker threads, and each of those
 * opens its OWN write connection to the same file. EXCLUSIVE and a second writer
 * cannot coexist, so whoever lost the race failed with SQLITE_BUSY.
 *
 * closeReadPool(), which the build script dutifully calls first, only drains the
 * read pool — it never knew about the workers.
 *
 * The old tests could not catch this: they run on tiny databases, where isLarge()
 * is false and the worker never starts. Hence largeDbThresholdBytes — with it at
 * 0 every build takes the "large" path, and the mode becomes observable: an index
 * that exists the instant the synchronous call returns was built inline; one that
 * does not was handed to a thread.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex, type XppSymbolIndexOptions } from '../../src/metadata/symbolIndex.js';

const dirs: string[] = [];
const opened: XppSymbolIndex[] = [];

function tempIndex(options: XppSymbolIndexOptions): XppSymbolIndex {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-index-build-mode-'));
  dirs.push(dir);
  const idx = new XppSymbolIndex(path.join(dir, 'symbols.db'), path.join(dir, 'labels.db'), options);
  opened.push(idx);
  return idx;
}

function hasIndex(db: any, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
}

afterEach(() => {
  for (const idx of opened) { try { idx.close(); } catch { /* already closed */ } }
  opened.length = 0;
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
  dirs.length = 0;
});

describe('file_path index build mode', () => {
  it('hands a large database to a worker by default (the behaviour the server wants)', () => {
    const idx = tempIndex({ largeDbThresholdBytes: 0 });

    // Nothing synchronous built it, so it is not there yet — that is the whole
    // point of the worker, and the reason it collides with an EXCLUSIVE lock.
    expect(hasIndex(idx.db, 'idx_symbols_file_path')).toBe(false);
    expect(idx.hasPendingIndexBuilds()).toBe(true);
  });

  it('builds inline with backgroundIndexBuilds: false, however large the database', () => {
    const idx = tempIndex({ largeDbThresholdBytes: 0, backgroundIndexBuilds: false });

    expect(hasIndex(idx.db, 'idx_symbols_file_path')).toBe(true);
    expect(hasIndex(idx.db, 'idx_symbols_file_path_nocase')).toBe(true);
    expect(hasIndex(idx.labelsDb, 'idx_labels_file_path_id')).toBe(true);
    // No second write connection exists, so nothing can contend with EXCLUSIVE.
    expect(idx.hasPendingIndexBuilds()).toBe(false);
  });

  it('skips the builds entirely with deferFilePathIndexes, until the caller asks', () => {
    const idx = tempIndex({
      largeDbThresholdBytes: 0,
      backgroundIndexBuilds: false,
      deferFilePathIndexes: true,
    });

    expect(hasIndex(idx.db, 'idx_symbols_file_path')).toBe(false);
    expect(idx.hasPendingIndexBuilds()).toBe(false);

    idx.ensureFilePathIndexes();

    expect(hasIndex(idx.db, 'idx_symbols_file_path')).toBe(true);
    expect(hasIndex(idx.labelsDb, 'idx_labels_file_path_id')).toBe(true);
  });

  it('never dispatches a worker off WAL, even when background builds are enabled', () => {
    // The build scripts' pragmas: no WAL to write through, and the writer holds the
    // file exclusively. A worker here is unserviceable by construction, so the
    // journal mode — not just the opt-out flag — has to veto it.
    const idx = tempIndex({ largeDbThresholdBytes: 0, deferFilePathIndexes: true });
    idx.closeReadPool();
    idx.db.pragma('journal_mode = MEMORY');
    idx.db.pragma('locking_mode = EXCLUSIVE');
    idx.labelsDb.pragma('journal_mode = MEMORY');
    idx.labelsDb.pragma('locking_mode = EXCLUSIVE');

    idx.ensureFilePathIndexes();

    expect(hasIndex(idx.db, 'idx_symbols_file_path')).toBe(true);
    expect(hasIndex(idx.labelsDb, 'idx_labels_file_path_id')).toBe(true);
    expect(idx.hasPendingIndexBuilds()).toBe(false);
  });

  it('keeps the small-database default: inline, no worker, no flags needed', () => {
    const idx = tempIndex({});

    expect(hasIndex(idx.db, 'idx_symbols_file_path')).toBe(true);
    expect(idx.hasPendingIndexBuilds()).toBe(false);
  });
});

/**
 * The crash was in a build script, and no unit test can run a 2 GB rebuild — so
 * pin the contract at the source level instead: any script that takes an
 * EXCLUSIVE lock must have opted out of background index builds.
 */
describe('build scripts and the EXCLUSIVE lock', () => {
  const scripts = ['scripts/build-database.ts', 'scripts/build-fts.ts'];

  for (const rel of scripts) {
    it(`${rel} opts out of background index builds before locking EXCLUSIVE`, () => {
      const src = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

      expect(src).toContain('locking_mode = EXCLUSIVE');
      expect(src).toContain('backgroundIndexBuilds: false');
      // And it must actually build the indexes it deferred, or the production DB
      // ships without them and every single-object re-index scans the whole table.
      expect(src).toContain('deferFilePathIndexes: true');
      expect(src).toContain('ensureFilePathIndexes()');

      // Order matters: the opt-out is a constructor argument, so it has to appear
      // before the pragma that would otherwise race the worker it prevents.
      expect(src.indexOf('backgroundIndexBuilds: false'))
        .toBeLessThan(src.indexOf('locking_mode = EXCLUSIVE'));
    });
  }
});
