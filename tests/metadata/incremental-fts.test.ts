/**
 * Incremental FTS maintenance for scoped builds.
 *
 * A `custom` build touches a tiny fraction of the database (~10K of ~1.2M symbols on a real
 * instance), but the default strategy re-tokenises the WHOLE symbols table afterwards —
 * measured at 327s against 5s of actual indexing work on a cold cache, with the labels index
 * and ANALYZE each costing another ~300s. `ftsStrategy: 'incremental'` instead keeps the FTS
 * triggers live so only the touched rows are re-tokenised.
 *
 * That is only safe if the trigger-maintained index is indistinguishable from a full rebuild.
 * These tests pin exactly that, including the trap that motivated the recursive_triggers
 * pragma: rows are written with INSERT OR REPLACE, and SQLite fires delete triggers for the
 * rows a REPLACE displaces ONLY when recursive triggers are enabled — without it every
 * re-index would leave orphaned FTS entries pointing at dead rowids.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';

let tmpDir: string;

async function writeModelWithClass(root: string, model: string, className: string): Promise<void> {
  const dir = path.join(root, model, 'classes');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${className}.json`),
    JSON.stringify({ name: className, type: 'class', model }, null, 2),
  );
}

/**
 * Names reachable THROUGH the FTS index for a term.
 *
 * A plain `SELECT ... FROM symbols_fts` would not do: on an external-content table that
 * reads the content table and would pass even with a completely stale index. Only a MATCH
 * query is answered from the index itself, so it is the one probe that can see drift.
 */
function ftsSearch(index: XppSymbolIndex, term: string): string[] {
  return index.db
    .prepare('SELECT name FROM symbols_fts WHERE symbols_fts MATCH ? ORDER BY name')
    .all(term)
    .map((r: any) => r.name);
}

/**
 * FTS5's own verification that the index matches its external content table.
 * Throws SQLITE_CORRUPT when they have drifted — e.g. when an orphaned index entry
 * points at a rowid the content table no longer has.
 */
function expectFtsIntact(index: XppSymbolIndex): void {
  expect(() =>
    index.db.exec("INSERT INTO symbols_fts(symbols_fts) VALUES('integrity-check');"),
  ).not.toThrow();
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'incr-fts-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('symbols FTS: incremental strategy', () => {
  it('produces the same index a full rebuild would', async () => {
    const extracted = path.join(tmpDir, 'extracted');
    await writeModelWithClass(extracted, 'ModelA', 'ClassA');
    await writeModelWithClass(extracted, 'ModelB', 'ClassB');

    const incremental = new XppSymbolIndex(':memory:', ':memory:');
    await incremental.indexMetadataDirectory(extracted, ['ModelA', 'ModelB'], { ftsStrategy: 'incremental' });

    const rebuilt = new XppSymbolIndex(':memory:', ':memory:');
    await rebuilt.indexMetadataDirectory(extracted, ['ModelA', 'ModelB'], { ftsStrategy: 'rebuild' });

    expect(ftsSearch(incremental, 'ClassA')).toEqual(['ClassA']);
    expect(ftsSearch(incremental, 'ClassB')).toEqual(['ClassB']);
    expect(ftsSearch(incremental, 'ClassA')).toEqual(ftsSearch(rebuilt, 'ClassA'));
    expect(ftsSearch(incremental, 'class')).toEqual(ftsSearch(rebuilt, 'class'));
    expectFtsIntact(incremental);

    incremental.close?.();
    rebuilt.close?.();
  });

  it('leaves no orphaned FTS rows when a model is re-indexed over itself', async () => {
    // The INSERT OR REPLACE path: the second pass displaces every row of ModelA. Without
    // recursive triggers the displaced rows keep their symbols_fts entries, which then
    // point at rowids that no longer exist in the content table.
    const extracted = path.join(tmpDir, 'extracted');
    await writeModelWithClass(extracted, 'ModelA', 'ClassA');

    const index = new XppSymbolIndex(':memory:', ':memory:');
    await index.indexMetadataDirectory(extracted, ['ModelA'], { ftsStrategy: 'incremental' });
    await index.indexMetadataDirectory(extracted, ['ModelA'], { ftsStrategy: 'incremental' });

    // One row in, one row out — a surviving orphan would show up as a duplicate hit here
    // and as a corrupt index in the integrity check.
    expect(ftsSearch(index, 'ClassA')).toEqual(['ClassA']);
    expectFtsIntact(index);

    index.close?.();
  });

  it('drops the cleared models out of the FTS index too', async () => {
    const extracted = path.join(tmpDir, 'extracted');
    await writeModelWithClass(extracted, 'ModelA', 'ClassA');
    await writeModelWithClass(extracted, 'ModelB', 'ClassB');

    const index = new XppSymbolIndex(':memory:', ':memory:');
    await index.indexMetadataDirectory(extracted, ['ModelA', 'ModelB'], { ftsStrategy: 'incremental' });

    // Mirrors build-database: clear the scoped models, then re-index them.
    index.clearModels(['ModelA']);
    expect(ftsSearch(index, 'ClassA')).toEqual([]);
    expect(ftsSearch(index, 'ClassB')).toEqual(['ClassB']);
    expectFtsIntact(index);

    await index.indexMetadataDirectory(extracted, ['ModelA'], { ftsStrategy: 'incremental' });
    expect(ftsSearch(index, 'ClassA')).toEqual(['ClassA']);
    expect(ftsSearch(index, 'ClassB')).toEqual(['ClassB']);
    expectFtsIntact(index);

    index.close?.();
  });

  it('keeps the rebuilt strategy for an unscoped pass', async () => {
    // 'incremental' is meaningless without a scope — an unscoped pass touches every row,
    // so it must fall back to the bulk rebuild rather than paying per-row trigger cost.
    const extracted = path.join(tmpDir, 'extracted');
    await writeModelWithClass(extracted, 'ModelA', 'ClassA');

    const index = new XppSymbolIndex(':memory:', ':memory:');
    await index.indexMetadataDirectory(extracted, undefined, { ftsStrategy: 'incremental' });

    expect(ftsSearch(index, 'ClassA')).toEqual(['ClassA']);
    expectFtsIntact(index);

    index.close?.();
  });
});

describe('labels FTS: incremental strategy', () => {
  const label = (labelId: string, model: string, text: string, language = 'en-US') => ({
    labelId,
    labelFileId: `${model}Labels`,
    model,
    language,
    text,
    filePath: `C:/pkg/${model}/${model}Labels.${language}.label.txt`,
  });

  /**
   * Label ids reachable through the index for a term. As on the symbols side, only a MATCH
   * query is answered from the index — labels_fts is external-content too.
   *
   * Reported as `id/language`: the index covers every locale, so one label id is present
   * once per translation and a bare id could not tell an en-US hit from a Czech one.
   */
  function ftsLabelSearch(index: XppSymbolIndex, term: string): string[] {
    return index.labelsDb
      .prepare(
        `SELECT l.label_id, l.language FROM labels_fts f
         JOIN labels l ON l.id = f.rowid
         WHERE labels_fts MATCH ? ORDER BY l.label_id, l.language`,
      )
      .all(term)
      .map((r: any) => `${r.label_id}/${r.language}`);
  }

  it('matches a full rebuild, and clearing a model prunes its FTS rows', () => {
    const index = new XppSymbolIndex(':memory:', ':memory:');

    index.bulkAddLabels(
      [
        label('@Cus:Hello', 'CustomModel', 'Hello'),
        label('@Cus:Bye', 'CustomModel', 'Goodbye'),
        label('@Cus:Hello', 'CustomModel', 'Ahoj', 'cs'),
        label('@Std:Keep', 'StandardModel', 'Keep me'),
      ],
      { skipFtsRebuild: true, keepTriggers: true },
    );
    // 'Hello' is the en-US text and the label id both translations share, so the Czech
    // row answers on its id — it is in the index now, which is the point.
    expect(ftsLabelSearch(index, 'Hello')).toEqual(['@Cus:Hello/cs', '@Cus:Hello/en-US']);
    expect(ftsLabelSearch(index, 'Keep')).toEqual(['@Std:Keep/en-US']);
    // The Czech text itself is reachable — it used to be indexed nowhere.
    expect(ftsLabelSearch(index, 'Ahoj')).toEqual(['@Cus:Hello/cs']);

    index.clearLabelsForModels(['CustomModel'], { ftsStrategy: 'incremental' });
    expect(ftsLabelSearch(index, 'Hello')).toEqual([]);
    expect(ftsLabelSearch(index, 'Goodbye')).toEqual([]);
    // Pruning has to reach the translations too, not just the en-US row.
    expect(ftsLabelSearch(index, 'Ahoj')).toEqual([]);
    // The untouched standard model must survive both the clear and the FTS pruning.
    expect(ftsLabelSearch(index, 'Keep')).toEqual(['@Std:Keep/en-US']);
    expect(index.labelsDb.prepare('SELECT COUNT(*) n FROM labels').get()).toEqual({ n: 1 });

    index.bulkAddLabels([label('@Cus:Hello', 'CustomModel', 'Hello again')], {
      skipFtsRebuild: true,
      keepTriggers: true,
    });
    expect(ftsLabelSearch(index, 'again')).toEqual(['@Cus:Hello/en-US']);

    // Same oracle as the symbols side: the incrementally maintained index must answer
    // exactly like one rebuilt from scratch.
    const terms = ['Hello', 'again', 'Goodbye', 'Keep', 'Ahoj'];
    const incremental = terms.map(t => ftsLabelSearch(index, t));
    index.rebuildLabelsFts();
    expect(terms.map(t => ftsLabelSearch(index, t))).toEqual(incremental);

    index.close?.();
  });

  it('leaves no orphaned FTS rows when the same label is re-inserted', () => {
    const index = new XppSymbolIndex(':memory:', ':memory:');

    index.bulkAddLabels([label('@Cus:Hello', 'CustomModel', 'First')], {
      skipFtsRebuild: true,
      keepTriggers: true,
    });
    index.bulkAddLabels([label('@Cus:Hello', 'CustomModel', 'Second')], {
      skipFtsRebuild: true,
      keepTriggers: true,
    });

    // The replaced row must be gone from the index, not merely shadowed by the new one.
    expect(ftsLabelSearch(index, 'First')).toEqual([]);
    expect(ftsLabelSearch(index, 'Second')).toEqual(['@Cus:Hello/en-US']);

    index.close?.();
  });
});
