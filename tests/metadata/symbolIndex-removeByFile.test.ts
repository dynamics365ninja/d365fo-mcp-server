/**
 * removeSymbolsByFile / removeLabelsByFile path-form matching (audit 2.2).
 *
 * Regression: full builds store symbols.file_path as the JSON's sourcePath —
 * CI-extracted custom models normalize it to a PackagesLocalDirectory-relative
 * forward-slash path ("Pkg/Model/AxClass/X.xml", see normalizeSourcePath in
 * scripts/extract-metadata.ts), while locally built DBs keep the absolute
 * Windows path with backslashes. The removal APIs compared with the exact
 * string the caller passed (absolute Windows path), so stale rows (deleted
 * methods, deleted files) were never removed when the stored form differed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';

const ABS_X = 'K:\\AosService\\PackagesLocalDirectory\\Pkg\\Model\\AxClass\\X.xml';
const REL_X = 'Pkg/Model/AxClass/X.xml';
const ABS_Y = 'K:\\AosService\\PackagesLocalDirectory\\Pkg\\Model\\AxClass\\Y.xml';
const REL_Z = 'Pkg/Model/AxClass/Z.xml';

let index: XppSymbolIndex;

beforeEach(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
  const sym = (name: string, filePath: string, parentName?: string) =>
    index.addSymbol({
      name,
      type: parentName ? 'method' : 'class',
      parentName,
      filePath,
      model: 'Pkg',
    } as any);

  sym('X', REL_X);              // CI build: relative forward-slash form
  sym('doStuff', REL_X, 'X');
  sym('Y', ABS_Y);              // local build: absolute Windows form
  sym('Z', REL_Z);              // unrelated object — must survive
});

afterEach(() => index.close());

const symbolCount = (name: string): number =>
  (index.db.prepare(`SELECT COUNT(*) AS n FROM symbols WHERE name = ?`).get(name) as any).n;

describe('removeSymbolsByFile', () => {
  it('deletes rows stored in relative CI form when called with the absolute Windows path', () => {
    const { deletedCount, objectNames } = index.removeSymbolsByFile(ABS_X);

    expect(deletedCount).toBe(2); // class row + method row
    expect(objectNames).toEqual(['X']);
    expect(symbolCount('X')).toBe(0);
    expect(symbolCount('doStuff')).toBe(0);
  });

  it('deletes rows stored in absolute form when called with the same absolute path', () => {
    const { deletedCount, objectNames } = index.removeSymbolsByFile(ABS_Y);

    expect(deletedCount).toBe(1);
    expect(objectNames).toEqual(['Y']);
    expect(symbolCount('Y')).toBe(0);
  });

  it('deletes rows stored in relative form when called with that relative path', () => {
    const { deletedCount } = index.removeSymbolsByFile(REL_X);

    expect(deletedCount).toBe(2);
    expect(symbolCount('X')).toBe(0);
  });

  it('leaves unrelated rows untouched', () => {
    index.removeSymbolsByFile(ABS_X);

    expect(symbolCount('Y')).toBe(1);
    expect(symbolCount('Z')).toBe(1);
  });
});

describe('removeLabelsByFile', () => {
  const REL_LABELS = 'Pkg/Model/AxLabelFile/LabelResources/en-US/PkgLabels.en-US.label.txt';
  const ABS_LABELS = 'K:\\AosService\\PackagesLocalDirectory\\Pkg\\Model\\AxLabelFile\\LabelResources\\en-US\\PkgLabels.en-US.label.txt';

  const labelCount = (labelId: string): number =>
    (index.labelsDb.prepare(`SELECT COUNT(*) AS n FROM labels WHERE label_id = ?`).get(labelId) as any).n;

  beforeEach(() => {
    index.bulkAddLabels([
      { labelId: 'RelStored', labelFileId: 'PkgLabels', model: 'Pkg', language: 'en-US', text: 'Rel', filePath: REL_LABELS },
      { labelId: 'AbsStored', labelFileId: 'PkgLabels', model: 'Pkg', language: 'en-US', text: 'Abs', filePath: ABS_LABELS },
      { labelId: 'Unrelated', labelFileId: 'OtherLabels', model: 'Pkg', language: 'en-US', text: 'Other', filePath: 'Pkg/Model/AxLabelFile/LabelResources/en-US/OtherLabels.en-US.label.txt' },
    ]);
  });

  it('deletes labels stored in either path form when called with the absolute Windows path', () => {
    const deleted = index.removeLabelsByFile(ABS_LABELS);

    expect(deleted).toBe(2); // matches both the relative- and absolute-stored rows
    expect(labelCount('RelStored')).toBe(0);
    expect(labelCount('AbsStored')).toBe(0);
    expect(labelCount('Unrelated')).toBe(1);
  });
});
