/**
 * Stale-row deletion must be case-insensitive and follow symlinks (audit 2.4 #19).
 *
 * removeSymbolsByFile/removeLabelsByFile compared file_path with SQLite's default
 * BINARY collation — i.e. case-SENSITIVELY — against a Windows filesystem that is
 * not. The indexer stores `K:\AosService\PackagesLocalDirectory\…` while a tool
 * argument routinely arrives as `k:\aosservice\…`, so the DELETE matched nothing,
 * reported 0 rows, and every symbol of a reverted or deleted file stayed
 * searchable. The same blindness applied to a model directory reached through a
 * symlink: the caller's spelling and the indexer's spelling were two different
 * strings for one file.
 *
 * The index that makes the NOCASE lookup affordable is pinned here too — without
 * it the delete is the full-table scan idx_symbols_file_path exists to avoid
 * (319 s + 173 s on the 2 GB production DB, see tests/metadata/filePathIndex).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';

const STORED = 'K:\\AosService\\PackagesLocalDirectory\\Contoso\\Contoso\\AxClass\\ConDemoHelper.xml';
const CALLER_LOWERCASE = 'k:\\aosservice\\packageslocaldirectory\\contoso\\contoso\\axclass\\condemohelper.xml';

const opened: XppSymbolIndex[] = [];
const dirs: string[] = [];

function memoryIndex(): XppSymbolIndex {
  const idx = new XppSymbolIndex(':memory:', ':memory:');
  opened.push(idx);
  return idx;
}

function fileIndex(): XppSymbolIndex {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-nocase-'));
  dirs.push(dir);
  const idx = new XppSymbolIndex(path.join(dir, 'symbols.db'), path.join(dir, 'labels.db'));
  opened.push(idx);
  return idx;
}

afterEach(() => {
  for (const idx of opened) { try { idx.close(); } catch { /* already closed */ } }
  opened.length = 0;
  // Windows keeps a handle on an open SQLite file — tolerate a failed removal.
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
  dirs.length = 0;
});

describe('removeSymbolsByFile — path casing', () => {
  it('deletes rows stored with different casing than the caller passed', () => {
    const idx = memoryIndex();
    idx.addSymbol({ name: 'ConDemoHelper', type: 'class', filePath: STORED, model: 'Contoso' } as any);
    idx.addSymbol({ name: 'run', type: 'method', parentName: 'ConDemoHelper', filePath: STORED, model: 'Contoso' } as any);

    const { deletedCount, objectNames } = idx.removeSymbolsByFile(CALLER_LOWERCASE);

    expect(deletedCount).toBe(2);
    expect(objectNames).toEqual(['ConDemoHelper']);
    expect(idx.db.prepare('SELECT COUNT(*) AS n FROM symbols').get()).toEqual({ n: 0 });
  });

  it('still leaves a genuinely different file alone', () => {
    const idx = memoryIndex();
    idx.addSymbol({ name: 'ConDemoHelper', type: 'class', filePath: STORED, model: 'Contoso' } as any);
    idx.addSymbol({
      name: 'ConOtherHelper',
      type: 'class',
      filePath: 'K:\\AosService\\PackagesLocalDirectory\\Contoso\\Contoso\\AxClass\\ConOtherHelper.xml',
      model: 'Contoso',
    } as any);

    expect(idx.removeSymbolsByFile(CALLER_LOWERCASE).deletedCount).toBe(1);
    expect(idx.db.prepare('SELECT COUNT(*) AS n FROM symbols').get()).toEqual({ n: 1 });
  });
});

describe('removeLabelsByFile — path casing', () => {
  it('deletes label rows stored with different casing than the caller passed', () => {
    const idx = memoryIndex();
    const stored = 'K:\\AosService\\PackagesLocalDirectory\\Contoso\\Contoso\\AxLabelFile\\LabelResources\\en-US\\Con.en-US.label.txt';
    idx.bulkAddLabels([
      { labelId: '@Con:Hello', labelFileId: 'Con', model: 'Contoso', language: 'en-US', text: 'Hello', filePath: stored },
    ]);

    expect(idx.removeLabelsByFile(stored.toLowerCase())).toBe(1);
    expect(idx.labelsDb.prepare('SELECT COUNT(*) AS n FROM labels').get()).toEqual({ n: 0 });
  });
});

describe('removeSymbolsByFile — symlinked model directory', () => {
  it('deletes rows stored under the resolved path when called through the symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-symlink-'));
    dirs.push(root);

    // The shape this reproduces: PackagesLocalDirectory/<Model> is a junction to a
    // repo checkout, so the indexer walked the real path while the tool holds the
    // path it was given, through the link.
    const realModel = path.join(root, 'repo', 'Contoso', 'AxClass');
    fs.mkdirSync(realModel, { recursive: true });
    const realFile = path.join(realModel, 'ConDemoHelper.xml');
    fs.writeFileSync(realFile, '<AxClass/>');

    const linkRoot = path.join(root, 'PackagesLocalDirectory');
    try {
      fs.symlinkSync(path.join(root, 'repo'), linkRoot, 'junction');
    } catch {
      return; // no symlink privilege on this host — the casing tests still cover #19
    }
    const linkedFile = path.join(linkRoot, 'Contoso', 'AxClass', 'ConDemoHelper.xml');

    const idx = memoryIndex();
    idx.addSymbol({ name: 'ConDemoHelper', type: 'class', filePath: fs.realpathSync(realFile), model: 'Contoso' } as any);

    expect(idx.removeSymbolsByFile(linkedFile).deletedCount).toBe(1);
  });
});

describe('NOCASE file_path index', () => {
  it('exists so the case-insensitive delete is a lookup, not a table scan', () => {
    const idx = fileIndex();

    expect(
      idx.db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_symbols_file_path_nocase'`).get(),
    ).toBeTruthy();
    expect(
      idx.labelsDb.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_labels_file_path_nocase'`).get(),
    ).toBeTruthy();

    // Enough rows that the planner has a real choice — on a handful it picks a
    // scan whether or not the index exists.
    idx.db.transaction(() => {
      for (let i = 0; i < 2000; i++) {
        idx.addSymbol({
          name: `Filler${i}`,
          type: 'class',
          filePath: `K:\\AosService\\PackagesLocalDirectory\\Other\\Other\\AxClass\\Filler${i}.xml`,
          model: 'Other',
        } as any);
      }
    })();
    idx.db.exec('ANALYZE;');

    const plan = idx.db
      .prepare(`EXPLAIN QUERY PLAN DELETE FROM symbols WHERE file_path COLLATE NOCASE IN (?, ?)`)
      .all(STORED, CALLER_LOWERCASE) as Array<{ detail: string }>;

    expect(plan.some(r => r.detail.includes('idx_symbols_file_path_nocase'))).toBe(true);
    expect(plan.some(r => /^SCAN symbols/.test(r.detail))).toBe(false);
  });
});
