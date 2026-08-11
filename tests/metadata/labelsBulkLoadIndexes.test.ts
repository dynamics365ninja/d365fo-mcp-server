/**
 * Bulk-load index deferral + the FTS maintenance that has to survive it.
 *
 * The build scripts drop the `labels` read-accelerator indexes for the insert pass
 * and rebuild them afterwards, which is only safe if three things hold: the UNIQUE
 * index stays live (it is what INSERT OR REPLACE dedupes through), the dropped set
 * comes back exactly, and label search returns the same rows either way.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex.js';

const LABEL_INDEXES = [
  'idx_labels_id',
  'idx_labels_file_id',
  'idx_labels_model',
  'idx_labels_language',
  'idx_labels_language_lower',
];

function indexNames(index: XppSymbolIndex): string[] {
  return (
    index.labelsDb
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_labels%' ORDER BY name`)
      .all() as Array<{ name: string }>
  ).map(r => r.name);
}

function entry(n: number, overrides: Partial<Record<string, string>> = {}) {
  return {
    labelId: `@Fm:Label${n}`,
    labelFileId: 'FmLabels',
    model: 'FleetManagement',
    language: 'en-US',
    text: `posting profile ${n}`,
    comment: `comment ${n}`,
    filePath: `K:\\PLD\\FleetManagement\\FleetManagement\\AxLabelFile\\LabelResources\\en-US\\FmLabels.en-US.label.txt`,
    ...overrides,
  };
}

describe('labels bulk-load index deferral', () => {
  let index: XppSymbolIndex;

  beforeEach(() => {
    index = new XppSymbolIndex(':memory:', ':memory:');
  });

  afterEach(() => {
    index.close();
  });

  it('keeps idx_labels_unique live so INSERT OR REPLACE still dedupes', () => {
    index.dropLabelSecondaryIndexes();

    expect(indexNames(index)).toContain('idx_labels_unique');

    // Same (label_id, label_file_id, model, language) twice — the second must replace
    // the first, not add a row. Without the UNIQUE index this silently duplicates and
    // the CREATE UNIQUE INDEX below would fail.
    index.bulkAddLabels([entry(1), entry(1, { text: 'replaced text' })], {
      skipFtsRebuild: true,
    });

    expect(index.getLabelCount()).toBe(1);
    expect(() => index.createLabelSecondaryIndexes()).not.toThrow();
  });

  it('drops only the read accelerators and restores exactly that set', () => {
    const before = indexNames(index);
    for (const name of LABEL_INDEXES) expect(before).toContain(name);

    const dropped = index.dropLabelSecondaryIndexes();
    expect(dropped).toEqual(expect.arrayContaining(LABEL_INDEXES));
    expect(dropped).not.toContain('idx_labels_unique');

    const during = indexNames(index);
    for (const name of LABEL_INDEXES) expect(during).not.toContain(name);

    index.createLabelSecondaryIndexes(dropped);
    expect(indexNames(index).sort()).toEqual(before.sort());
  });

  it('only recreates the indexes it was told about', () => {
    index.dropLabelSecondaryIndexes();
    index.createLabelSecondaryIndexes(['idx_labels_model']);

    const names = indexNames(index);
    expect(names).toContain('idx_labels_model');
    expect(names).not.toContain('idx_labels_language_lower');
  });

  it('returns the same search results whether or not the indexes were deferred', () => {
    const rows = Array.from({ length: 50 }, (_unused, i) => entry(i));

    const dropped = index.dropLabelSecondaryIndexes();
    index.bulkAddLabels(rows, { skipFtsRebuild: true });
    index.createLabelSecondaryIndexes(dropped);
    index.rebuildLabelsFts();
    const deferred = index.searchLabels('posting', { language: 'en-US', limit: 100 });

    const plain = new XppSymbolIndex(':memory:', ':memory:');
    try {
      plain.bulkAddLabels(rows, { skipFtsRebuild: true });
      plain.rebuildLabelsFts();
      const direct = plain.searchLabels('posting', { language: 'en-US', limit: 100 });

      expect(deferred.length).toBe(50);
      expect(deferred.map(r => r.labelId).sort()).toEqual(direct.map(r => r.labelId).sort());
    } finally {
      plain.close();
    }
  });
});

describe('renameLabelInIndex keeps FTS current without a full rebuild', () => {
  let index: XppSymbolIndex;

  beforeEach(() => {
    index = new XppSymbolIndex(':memory:', ':memory:');
    // keepTriggers, as create_label does — the triggers must be live afterwards for
    // the rename to be reflected in labels_fts.
    index.bulkAddLabels([entry(1, { text: 'unique posting phrase' })], {
      skipFtsRebuild: true,
      keepTriggers: true,
    });
  });

  afterEach(() => {
    index.close();
  });

  it('finds the label under its new id and not the old one, with no explicit rebuild', () => {
    expect(index.searchLabels('posting', { language: 'en-US' }).map(r => r.labelId)).toEqual([
      '@Fm:Label1',
    ]);

    index.renameLabelInIndex('@Fm:Label1', '@Fm:Renamed', 'FmLabels', 'FleetManagement');

    const hits = index.searchLabels('posting', { language: 'en-US' });
    expect(hits.map(r => r.labelId)).toEqual(['@Fm:Renamed']);

    // The FTS row for the old id must be gone, not merely shadowed by the join.
    const stale = index.labelsDb
      .prepare(`SELECT COUNT(*) AS n FROM labels_fts WHERE labels_fts MATCH ?`)
      .get('"@Fm:Label1"') as { n: number };
    expect(stale.n).toBe(0);
  });
});
