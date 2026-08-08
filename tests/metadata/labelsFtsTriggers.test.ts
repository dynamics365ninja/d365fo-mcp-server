/**
 * labels_fts must stay in sync with the labels table (audit 2.6 #25).
 *
 * Three ways it drifted:
 *
 *  1. bulkAddLabels re-created the sync triggers with a case-SENSITIVE
 *     `language = 'en-US'` while the schema's own definition tests
 *     `LOWER(language) = 'en-us'`. Microsoft packages unzipped on Linux store the
 *     locale lowercased, so after any bulk insert those rows stopped being
 *     maintained: new ones never entered the index, and — the visible half —
 *     DELETEs never removed the entries a full rebuild had already put there, so
 *     searchLabels kept returning labels that no longer exist.
 *  2. The drop/recreate had no try/finally, so a constraint violation in the insert
 *     left the triggers dropped for the rest of the connection's life.
 *  3. close() cancelled the debounced rebuild timer instead of running it, losing
 *     every label written in the ~300 ms before shutdown.
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
  for (const idx of opened) { try { idx.close(); } catch { /* already closed */ } }
  opened.length = 0;
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
  dirs.length = 0;
});

/**
 * Label ids reachable THROUGH the index. Only a MATCH query is answered from the
 * index itself — a plain SELECT on this external-content table reads `labels` and
 * would pass against a completely stale index.
 */
function ftsSearch(index: XppSymbolIndex, term: string): string[] {
  return index.labelsDb
    .prepare('SELECT label_id FROM labels_fts WHERE labels_fts MATCH ? ORDER BY label_id')
    .all(term)
    .map((r: any) => r.label_id);
}

const triggerNames = (index: XppSymbolIndex): string[] =>
  index.labelsDb
    .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`)
    .all()
    .map((r: any) => r.name);

const label = (labelId: string, language: string, text: string, filePath = 'C:/pkg/Contoso/Con.label.txt') => ({
  labelId,
  labelFileId: 'Con',
  model: 'Contoso',
  language,
  text,
  filePath,
});

describe('labels FTS triggers after a bulk insert', () => {
  it('maintains lowercase en-us rows, not only the en-US spelling', () => {
    const index = memoryIndex();
    // Bulk mode: drops the triggers, rebuilds, then re-creates them. Everything
    // after this point depends on the re-created definitions.
    index.bulkAddLabels([label('@Con:Seed', 'en-US', 'Seed')]);

    index.addLabel(label('@Con:Lower', 'en-us', 'Photosynthesis'));

    expect(ftsSearch(index, 'Photosynthesis')).toEqual(['@Con:Lower']);
  });

  it('drops a deleted lowercase en-us row out of the index instead of leaving a ghost', () => {
    const index = memoryIndex();
    const filePath = 'C:/pkg/Contoso/Ghost.label.txt';
    index.bulkAddLabels([label('@Con:Ghost', 'en-us', 'Photosynthesis', filePath)]);
    expect(ftsSearch(index, 'Photosynthesis')).toEqual(['@Con:Ghost']);

    index.removeLabelsByFile(filePath);

    // The row is gone from `labels`; if the delete trigger did not fire, the index
    // still answers with it — a hit for a label that no longer exists.
    expect(index.labelsDb.prepare('SELECT COUNT(*) AS n FROM labels').get()).toEqual({ n: 0 });
    expect(ftsSearch(index, 'Photosynthesis')).toEqual([]);
  });

  it('restores the triggers when the insert throws', () => {
    const index = memoryIndex();

    // language is NOT NULL — the transaction aborts mid-bulk, with the triggers
    // already dropped.
    expect(() =>
      index.bulkAddLabels([{ ...label('@Con:Bad', 'en-US', 'Bad'), language: null as any }]),
    ).toThrow();

    expect(triggerNames(index)).toEqual(['labels_ai', 'labels_ad', 'labels_au'].sort());
  });
});

describe('close()', () => {
  it('runs the pending debounced FTS rebuild instead of cancelling it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-labels-close-'));
    dirs.push(dir);
    const symbolsPath = path.join(dir, 'symbols.db');
    const labelsPath = path.join(dir, 'labels.db');

    const index = new XppSymbolIndex(symbolsPath, labelsPath);
    // Stand in for the bulk path's window: rows land in `labels` while the triggers
    // are down, and only the debounced rebuild will put them in the index.
    index.labelsDb.exec('DROP TRIGGER IF EXISTS labels_ai');
    index.addLabel(label('@Con:Pending', 'en-US', 'Chlorophyll'));
    expect(ftsSearch(index, 'Chlorophyll')).toEqual([]);

    index.scheduleLabelsFtsRebuild();
    index.close();

    const reopened = new XppSymbolIndex(symbolsPath, labelsPath);
    opened.push(reopened);
    expect(ftsSearch(reopened, 'Chlorophyll')).toEqual(['@Con:Pending']);
  });
});
