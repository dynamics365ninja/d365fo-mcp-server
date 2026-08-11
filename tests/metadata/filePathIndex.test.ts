/**
 * symbols.file_path / labels.file_path must be indexed.
 *
 * removeSymbolsByFile() is the first thing every update_symbol_index,
 * undo_last_modification and resync runs, and it looks rows up by file_path.
 * Unindexed, both of its statements scan the whole table — measured on the 2 GB
 * production DB at 319 s (the SELECT) + 173 s (the DELETE) to index a SINGLE
 * newly created object, against 0 ms once the index exists. That is why indexing
 * one object felt like a full rebuild, and it is a regression worth pinning:
 * the index is invisible in behaviour and easy to drop by accident.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex.js';

const dirs: string[] = [];
const opened: XppSymbolIndex[] = [];
function tempIndex(): XppSymbolIndex {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-file-path-index-'));
  dirs.push(dir);
  const idx = new XppSymbolIndex(path.join(dir, 'symbols.db'), path.join(dir, 'labels.db'));
  opened.push(idx);
  return idx;
}

afterEach(() => {
  // Windows keeps a lock on an open SQLite file, so close before removing —
  // and tolerate a failed removal rather than failing an otherwise green test.
  for (const idx of opened) { try { idx.close(); } catch { /* already closed */ } }
  opened.length = 0;
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
  dirs.length = 0;
});

describe('file_path indexes', () => {
  it('creates them on a fresh database', () => {
    const idx = tempIndex();

    const symbolIdx = idx.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_symbols_file_path'`)
      .get();
    // Labels reach their path through label_files now, so the indexed column is the
    // foreign key, and the path text itself is indexed once on the lookup table.
    const labelIdx = idx.labelsDb
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_labels_file_path_id'`)
      .get();
    const labelFilesIdx = idx.labelsDb
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_label_files_path'`)
      .get();

    expect(symbolIdx).toBeTruthy();
    expect(labelIdx).toBeTruthy();
    expect(labelFilesIdx).toBeTruthy();
  });

  it('makes removeSymbolsByFile look up by index instead of scanning', () => {
    const idx = tempIndex();
    const filePath = 'K:\\AosService\\PackagesLocalDirectory\\Contoso\\Contoso\\AxEnum\\ConDemoModStatus.xml';

    // Enough rows that the planner has a real choice to make — on a handful of
    // rows it picks a scan whether or not the index exists, so a tiny fixture
    // would let the regression through.
    idx.db.transaction(() => {
      for (let i = 0; i < 2000; i++) {
        idx.addSymbol({
          name: `Filler${i}`,
          type: 'class',
          filePath: `K:\\AosService\\PackagesLocalDirectory\\Other\\Other\\AxClass\\Filler${i}.xml`,
          model: 'Other',
        });
      }
      idx.addSymbol({ name: 'ConDemoModStatus', type: 'enum', filePath, model: 'Contoso' });
    })();
    idx.db.exec('ANALYZE;');

    // The plan is the assertion: "SCAN symbols" here means every future
    // single-object index call re-reads the entire table.
    const plan = idx.db
      .prepare(`EXPLAIN QUERY PLAN SELECT DISTINCT name FROM symbols WHERE file_path IN (?, ?) AND parent_name IS NULL`)
      .all(filePath, filePath) as Array<{ detail: string }>;

    expect(plan.some(r => r.detail.includes('idx_symbols_file_path'))).toBe(true);
    expect(plan.some(r => /^SCAN symbols/.test(r.detail))).toBe(false);

    expect(idx.removeSymbolsByFile(filePath).deletedCount).toBe(1);
  });
});
