/**
 * labels_fts must cover every indexed language, not only en-US.
 *
 * The index used to be filtered to en-US in three places (the three sync triggers,
 * rebuildLabelsFts, and an early return in searchLabels). On a build configured with
 * LABEL_LANGUAGES=en-US,cs,sk,de that left three quarters of the rows unreachable
 * through the index, and searchLabels answered those languages with a LIKE scan of
 * the whole labels table instead — 152 s for a four-term `cs` query against 1.4 M
 * rows, run synchronously so the whole MCP server stalled behind it.
 *
 * Indexing every language makes the language predicate load-bearing: without it a
 * `cs` search returns the en-US and de rows that share a token.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';

const opened: XppSymbolIndex[] = [];
const dirs: string[] = [];

function memoryIndex(): XppSymbolIndex {
  const idx = new XppSymbolIndex(':memory:', ':memory:');
  opened.push(idx);
  return idx;
}

afterEach(() => {
  for (const idx of opened) {
    try {
      idx.close();
    } catch {
      /* already closed */
    }
  }
  opened.length = 0;
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* locked */
    }
  }
  dirs.length = 0;
});

const label = (labelId: string, language: string, text: string, filePath = 'C:/pkg/Contoso/Con.label.txt') => ({
  labelId,
  labelFileId: 'Con',
  model: 'Contoso',
  language,
  text,
  filePath,
});

/** The four locales this workspace actually ships. */
const FOUR_LOCALES = [
  label('@Con:Tier', 'en-US', 'Quality tier'),
  label('@Con:Tier', 'cs', 'Úroveň kvality'),
  label('@Con:Tier', 'sk', 'Úroveň kvality SK'),
  label('@Con:Tier', 'de', 'Qualitätsstufe'),
];

describe('searchLabels across languages', () => {
  it('finds a Czech label by a Czech word', () => {
    const index = memoryIndex();
    index.bulkAddLabels(FOUR_LOCALES);

    const hits = index.searchLabels('kvality', { language: 'cs' });

    expect(hits.map(h => h.text)).toEqual(['Úroveň kvality']);
  });

  it('finds a German label whose only distinguishing token is non-ASCII', () => {
    const index = memoryIndex();
    index.bulkAddLabels(FOUR_LOCALES);

    // 'Qualitätsstufe' has no ASCII-only token. The old [a-zA-Z0-9] sanitisation
    // test would have routed this to the LIKE scan even once the rows were indexed.
    expect(index.searchLabels('Qualitätsstufe', { language: 'de' }).map(h => h.text)).toEqual(['Qualitätsstufe']);
  });

  it('does not leak other languages into a scoped search', () => {
    const index = memoryIndex();
    index.bulkAddLabels([
      ...FOUR_LOCALES,
      // 'Tier' is a German word here and an English one in '@Con:Tier'/'Quality tier'.
      label('@Con:Animal', 'de', 'Tier'),
    ]);

    const de = index.searchLabels('Tier', { language: 'de' });

    // Both German rows match — @Con:Animal on its text, @Con:Tier on its label_id,
    // which is an indexed FTS column too. What must not appear is the en-US row
    // 'Quality tier', which matches the same token in a language nobody asked for.
    expect(de.every(h => h.language === 'de')).toBe(true);
    expect(de.map(h => h.text).sort()).toEqual(['Qualitätsstufe', 'Tier']);

    expect(index.searchLabels('Tier', { language: 'en-US' }).map(h => h.text)).toEqual(['Quality tier']);
  });

  it('still defaults to en-US when no language is passed', () => {
    const index = memoryIndex();
    index.bulkAddLabels(FOUR_LOCALES);

    expect(index.searchLabels('quality').map(h => h.language)).toEqual(['en-US']);
  });

  it('accepts the lowercase locale spelling Linux-unzipped packages carry', () => {
    const index = memoryIndex();
    index.bulkAddLabels([label('@Con:Lower', 'en-us', 'Photosynthesis')]);

    expect(index.searchLabels('Photosynthesis', { language: 'en-US' }).map(h => h.labelId)).toEqual(['@Con:Lower']);
  });

  it('keeps a non-en-US row in sync when it is deleted', () => {
    const index = memoryIndex();
    const filePath = 'C:/pkg/Contoso/Ghost.label.txt';
    index.bulkAddLabels([label('@Con:Ghost', 'cs', 'Fotosyntéza', filePath)]);
    expect(index.searchLabels('Fotosyntéza', { language: 'cs' })).toHaveLength(1);

    index.removeLabelsByFile(filePath);

    // Before the fix the labels_ad trigger skipped non-en-US rows, so a deleted
    // Czech label stayed in the index only if a rebuild happened to follow.
    expect(index.searchLabels('Fotosyntéza', { language: 'cs' })).toEqual([]);
  });

  it('indexes a label added one row at a time, not only via bulk', () => {
    const index = memoryIndex();
    index.addLabel(label('@Con:Single', 'sk', 'Prístup do Finstatu'));

    expect(index.searchLabels('Prístup', { language: 'sk' }).map(h => h.labelId)).toEqual(['@Con:Single']);
  });
});

describe('labels_fts language-coverage migration', () => {
  it('re-tokenises a database whose index was built en-US-only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-labels-migrate-'));
    dirs.push(dir);
    const symbolsPath = path.join(dir, 'symbols.db');
    const labelsPath = path.join(dir, 'labels.db');

    const index = new XppSymbolIndex(symbolsPath, labelsPath);
    index.bulkAddLabels(FOUR_LOCALES);
    // Recreate the pre-fix state: an index holding en-US rows only, and a
    // user_version that predates the coverage change.
    index.labelsDb.exec(`INSERT INTO labels_fts(labels_fts) VALUES('delete-all')`);
    index.labelsDb.exec(`
      INSERT INTO labels_fts(rowid, label_id, text, comment)
      SELECT id, label_id, text, comment FROM labels WHERE LOWER(language) = 'en-us'
    `);
    index.labelsDb.pragma('user_version = 0');
    expect(index.searchLabels('kvality', { language: 'cs' })).toEqual([]);
    index.close();

    const reopened = new XppSymbolIndex(symbolsPath, labelsPath);
    opened.push(reopened);

    expect(reopened.searchLabels('kvality', { language: 'cs' }).map(h => h.text)).toEqual(['Úroveň kvality']);
    expect(Number(reopened.labelsDb.pragma('user_version', { simple: true }))).toBe(1);
  });

  it('does not rebuild a database that is already migrated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-labels-nomigrate-'));
    dirs.push(dir);
    const symbolsPath = path.join(dir, 'symbols.db');
    const labelsPath = path.join(dir, 'labels.db');

    const index = new XppSymbolIndex(symbolsPath, labelsPath);
    index.bulkAddLabels(FOUR_LOCALES);
    index.close();

    const reopened = new XppSymbolIndex(symbolsPath, labelsPath);
    opened.push(reopened);
    let rebuilt = false;
    const spy = reopened.rebuildLabelsFts.bind(reopened);
    reopened.rebuildLabelsFts = () => {
      rebuilt = true;
      spy();
    };
    // A second open must not pay the O(all labels) re-tokenisation again.
    const third = new XppSymbolIndex(symbolsPath, labelsPath);
    opened.push(third);

    expect(rebuilt).toBe(false);
    expect(Number(third.labelsDb.pragma('user_version', { simple: true }))).toBe(1);
  });
});
