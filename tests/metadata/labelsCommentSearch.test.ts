/**
 * labels(action="search") must match the developer comment, including a comment
 * such as a ticket tag ("TICKET-101") whose hyphen FTS5 cannot parse as a bare word.
 * The hyphenated query used to raise an FTS syntax error, fall through to the LIKE
 * scan, and that scan only looked at text and label id — so the comment was never
 * searched and the answer was "No labels found".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';

let index: XppSymbolIndex;
const row = (labelId: string, language: string, text: string, comment?: string) => ({
  labelId, labelFileId: 'ContosoExt', model: 'ContosoExt', language, text, comment,
  filePath: `C:\pkg\ContosoExt\AxLabelFile\LabelResources\${language}\ContosoExt.${language}.label.txt`,
});

beforeEach(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
  index.bulkAddLabels([
    row('Tagged', 'en-US', 'Posting profile', 'TICKET-101'),
    row('TaggedFi', 'fi', 'Kirjausprofiili', 'TICKET-101'),
    row('Other', 'en-US', 'Other text', 'TICKET-200 something'),
    row('NoComment', 'en-US', 'Plain text'),
  ]);
});

describe('searchLabels comment matching', () => {
  it('finds a label by a hyphenated comment tag', () => {
    expect(index.searchLabels('TICKET-101').map(r => r.labelId)).toEqual(['Tagged']);
  });

  it('finds it in another language too', () => {
    expect(index.searchLabels('TICKET-101', { language: 'fi' }).map(r => r.labelId)).toEqual(['TaggedFi']);
  });

  it('does not match a different tag sharing the prefix', () => {
    expect(index.searchLabels('TICKET-10').map(r => r.labelId)).toEqual([]);
    expect(index.searchLabels('TICKET-200').map(r => r.labelId)).toEqual(['Other']);
  });

  it('still finds a comment with a plain word query', () => {
    expect(index.searchLabels('something').map(r => r.labelId)).toEqual(['Other']);
  });

  it('LIKE fallback (punctuation-only / underscore queries) also reads the comment', () => {
    index.bulkAddLabels([row('Under', 'en-US', 'Under', 'TICKET_9 note')]);
    expect(index.searchLabels('TICKET_9').map(r => r.labelId)).toEqual(['Under']);
  });
});
