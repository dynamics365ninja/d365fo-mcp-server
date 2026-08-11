/**
 * Migration of an existing labels database from the inline `labels.file_path`
 * column to the `label_files` lookup table.
 *
 * The fixtures below build the OLD schema by hand — a database written by a version
 * of the server before the normalisation — and then open it with the current one.
 * That is the only way to exercise the path real users hit; every other test starts
 * from the new schema, where the migration is a no-op.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex.js';
import Database from '../../src/database/sqlite.js';

const dirs: string[] = [];
const opened: XppSymbolIndex[] = [];

afterEach(() => {
  for (const idx of opened) {
    try { idx.close(); } catch { /* already closed */ }
  }
  opened.length = 0;
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  dirs.length = 0;
});

const PATH_A = 'K:\\AosService\\PackagesLocalDirectory\\Contoso\\Contoso\\AxLabelFile\\LabelResources\\en-US\\Con.en-US.label.txt';
const PATH_B = 'K:\\AosService\\PackagesLocalDirectory\\Contoso\\Contoso\\AxLabelFile\\LabelResources\\cs\\Con.cs.label.txt';

/** Write a labels DB in the pre-normalisation shape and return its path. */
function legacyLabelsDb(rows: Array<[string, string, string, string]>): { symbolsPath: string; labelsPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-labelfiles-'));
  dirs.push(dir);
  const symbolsPath = path.join(dir, 'symbols.db');
  const labelsPath = path.join(dir, 'labels.db');

  const db = new Database(labelsPath);
  db.exec(`
    CREATE TABLE labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label_id TEXT NOT NULL,
      label_file_id TEXT NOT NULL,
      model TEXT NOT NULL,
      language TEXT NOT NULL,
      text TEXT NOT NULL,
      comment TEXT,
      file_path TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_labels_unique ON labels(label_id, label_file_id, model, language);
    CREATE INDEX idx_labels_file_path ON labels(file_path);
    CREATE INDEX idx_labels_file_path_nocase ON labels(file_path COLLATE NOCASE);
    CREATE VIRTUAL TABLE labels_fts USING fts5(label_id, text, comment, content='labels', content_rowid='id');
  `);
  const insert = db.prepare(
    `INSERT INTO labels (label_id, label_file_id, model, language, text, comment, file_path)
     VALUES (?, 'Con', 'Contoso', ?, ?, NULL, ?)`,
  );
  for (const [labelId, language, text, filePath] of rows) insert.run(labelId, language, text, filePath);
  db.exec(`INSERT INTO labels_fts(rowid, label_id, text, comment) SELECT id, label_id, text, comment FROM labels`);
  db.pragma('user_version = 0');
  db.close();

  return { symbolsPath, labelsPath };
}

describe('label_files migration', () => {
  it('moves inline paths into label_files and keeps every row reachable', () => {
    const { symbolsPath, labelsPath } = legacyLabelsDb([
      ['Quality', 'en-US', 'Quality tier', PATH_A],
      ['Access', 'en-US', 'Access to posting', PATH_A],
      ['Quality', 'cs', 'Úroveň kvality', PATH_B],
    ]);

    const idx = new XppSymbolIndex(symbolsPath, labelsPath);
    opened.push(idx);

    expect(idx.getLabelCount()).toBe(3);

    // Two distinct on-disk files behind three labels — the whole point of the table.
    const files = idx.labelsDb
      .prepare(`SELECT file_path FROM label_files ORDER BY file_path`)
      .all() as Array<{ file_path: string }>;
    expect(files.map(f => f.file_path).sort()).toEqual([PATH_A, PATH_B].sort());

    // The old column is gone, not merely unused.
    const columns = (idx.labelsDb.pragma('table_info(labels)') as Array<{ name: string }>).map(c => c.name);
    expect(columns).toContain('file_path_id');
    expect(columns).not.toContain('file_path');

    expect(Number(idx.labelsDb.pragma('user_version', { simple: true }))).toBe(2);
  });

  it('serves the migrated path back through every read that exposes it', () => {
    const { symbolsPath, labelsPath } = legacyLabelsDb([
      ['Quality', 'en-US', 'Quality tier', PATH_A],
      ['Quality', 'cs', 'Úroveň kvality', PATH_B],
    ]);

    const idx = new XppSymbolIndex(symbolsPath, labelsPath);
    opened.push(idx);

    expect(idx.searchLabels('Quality', { language: 'en-US' }).map(h => h.filePath)).toEqual([PATH_A]);
    expect(idx.getLabelById('@Con:Quality').map(h => h.filePath).sort()).toEqual([PATH_A, PATH_B].sort());
    expect(idx.getLabelFilePaths('Con').map(h => h.filePath).sort()).toEqual([PATH_A, PATH_B].sort());
    // '_' routes to the LIKE fallback, which is a separate SQL statement.
    expect(idx.searchLabels('Quality_tier', { language: 'en-US' })).toEqual([]);
    expect(idx.searchLabelsLike('Quality', { language: 'en-US' }).map(h => h.filePath)).toEqual([PATH_A]);
  });

  it('rebuilds labels_fts so non-en-US rows survive the rewrite', () => {
    const { symbolsPath, labelsPath } = legacyLabelsDb([
      ['Quality', 'cs', 'Úroveň kvality', PATH_B],
    ]);

    const idx = new XppSymbolIndex(symbolsPath, labelsPath);
    opened.push(idx);

    // The rewrite replaces the table labels_fts points at, so a stale index would
    // leave this empty — and the row ids are carried over precisely to avoid that.
    expect(idx.searchLabels('kvality', { language: 'cs' }).map(h => h.text)).toEqual(['Úroveň kvality']);
  });

  it('keeps removeLabelsByFile working against the migrated shape', () => {
    const { symbolsPath, labelsPath } = legacyLabelsDb([
      ['Quality', 'en-US', 'Quality tier', PATH_A],
      ['Access', 'en-US', 'Access to posting', PATH_A],
      ['Quality', 'cs', 'Úroveň kvality', PATH_B],
    ]);

    const idx = new XppSymbolIndex(symbolsPath, labelsPath);
    opened.push(idx);

    // Lowercased, as a tool argument routinely is on Windows — the NOCASE index on
    // label_files is what keeps this matching.
    expect(idx.removeLabelsByFile(PATH_A.toLowerCase())).toBe(2);
    expect(idx.getLabelCount()).toBe(1);
    expect(idx.searchLabels('Quality', { language: 'en-US' })).toEqual([]);
    expect(idx.searchLabels('kvality', { language: 'cs' })).toHaveLength(1);
  });

  it('is a no-op on the second open', () => {
    const { symbolsPath, labelsPath } = legacyLabelsDb([
      ['Quality', 'en-US', 'Quality tier', PATH_A],
    ]);

    const first = new XppSymbolIndex(symbolsPath, labelsPath);
    opened.push(first);
    first.close();

    const second = new XppSymbolIndex(symbolsPath, labelsPath);
    opened.push(second);
    let rebuilt = false;
    const real = second.rebuildLabelsFts.bind(second);
    second.rebuildLabelsFts = () => { rebuilt = true; real(); };

    const third = new XppSymbolIndex(symbolsPath, labelsPath);
    opened.push(third);

    expect(rebuilt).toBe(false);
    expect(third.getLabelCount()).toBe(1);
    expect(Number(third.labelsDb.pragma('user_version', { simple: true }))).toBe(2);
  });

  it('writes new labels into the migrated database without duplicating file rows', () => {
    const { symbolsPath, labelsPath } = legacyLabelsDb([
      ['Quality', 'en-US', 'Quality tier', PATH_A],
    ]);

    const idx = new XppSymbolIndex(symbolsPath, labelsPath);
    opened.push(idx);

    idx.bulkAddLabels(
      [
        { labelId: 'New', labelFileId: 'Con', model: 'Contoso', language: 'en-US', text: 'Brand new label', filePath: PATH_A },
        { labelId: 'Other', labelFileId: 'Con', model: 'Contoso', language: 'en-US', text: 'Another label', filePath: PATH_A },
      ],
      { skipFtsRebuild: true, keepTriggers: true },
    );

    // Same path as the migrated row: it must reuse that label_files row, not add one.
    const { n } = idx.labelsDb.prepare(`SELECT COUNT(*) AS n FROM label_files`).get() as { n: number };
    expect(n).toBe(1);
    expect(idx.getLabelCount()).toBe(3);
    expect(idx.searchLabels('Brand', { language: 'en-US' }).map(h => h.filePath)).toEqual([PATH_A]);
  });
});
