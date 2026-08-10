/**
 * create_label must not re-tokenise the whole labels index.
 *
 * Run 6639b2df spent 211 s of a 733 s run inside `rebuildLabelsFts()`. create_label wrote
 * its rows with the FTS triggers dropped and then scheduled a debounced full rebuild —
 * `delete-all` plus a re-INSERT of every row of the 1.2 GB labels DB — for the two labels
 * it had just added. node:sqlite is synchronous, so the server answered no tool call at all
 * for ~105 s after each create_label; the MCP client saw the stall attributed to whatever
 * call came next, and the server's own slow-call metric never fired because the time was
 * spent outside any handler.
 *
 * The contract this pins: after a label write the new rows are reachable through
 * labels_fts (so nothing is traded away for the speed), and no full rebuild is scheduled.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';

let index: XppSymbolIndex;

beforeEach(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
});

afterEach(() => index.close());

const entry = (labelId: string, text: string, language = 'en-US') => ({
  labelId,
  labelFileId: 'AslFinSK',
  model: 'AslFinanceSK',
  language,
  text,
  filePath: `K:/pkg/AslFinanceSK/AslFinSK.${language}.label.txt`,
});

/** Only a MATCH query is answered from the index — labels_fts is external-content. */
const ftsHits = (term: string): string[] =>
  index.labelsDb
    .prepare(
      `SELECT l.label_id FROM labels_fts f JOIN labels l ON l.id = f.rowid
       WHERE labels_fts MATCH ? ORDER BY l.label_id`,
    )
    .all(term)
    .map((r: any) => r.label_id);

describe('create_label label indexing', () => {
  it('indexes new labels through the triggers, with no rebuild scheduled', () => {
    // Seed, so the "rebuild everything" path would have observable work to do.
    index.bulkAddLabels([entry('Existing', 'Photosynthesis')], {
      skipFtsRebuild: true,
      keepTriggers: true,
    });

    // Exactly the call create_label makes.
    index.bulkAddLabels(
      [
        entry('QualityTier', 'Quality tier'),
        entry('QualityTierDowngradeNotAllowed', 'The quality tier cannot be decreased.'),
        entry('QualityTier', 'Úroveň kvality', 'cs'),
      ],
      { skipFtsRebuild: true, keepTriggers: true },
    );

    expect(ftsHits('tier')).toEqual(['QualityTier', 'QualityTierDowngradeNotAllowed']);
    expect(ftsHits('kvality')).toEqual(['QualityTier']);
    expect(ftsHits('Photosynthesis')).toEqual(['Existing']);

    // No debounced full rebuild is pending: close() flushes one if it is, and the index
    // must already be complete without that flush.
    expect((index as any)._labelsFtsTimer).toBeNull();
  });

  it('matches what a full rebuild would have produced', () => {
    index.bulkAddLabels([entry('First', 'Original text')], {
      skipFtsRebuild: true,
      keepTriggers: true,
    });
    // INSERT OR REPLACE on the same key: the displaced row must leave the index too,
    // or the old text stays findable forever.
    index.bulkAddLabels([entry('First', 'Replacement text')], {
      skipFtsRebuild: true,
      keepTriggers: true,
    });

    const terms = ['Original', 'Replacement', 'text'];
    const incremental = terms.map(ftsHits);
    expect(incremental[0]).toEqual([]);

    index.rebuildLabelsFts();
    expect(terms.map(ftsHits)).toEqual(incremental);
  });
});
