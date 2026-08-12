/**
 * object_patterns(domain="form", action="validate") resolving a form by NAME —
 * the branch that goes through the symbol index instead of caller-supplied XML.
 *
 * The trap here is an indexed `file_path` that points at the extracted-metadata
 * JSON cache rather than the AOT source. symbolIndex stores
 * `<object>.sourcePath || filePath`, so any cached object written without a
 * sourcePath lands in the index pointing at the cache — and that file EXISTS, so
 * no existence check catches it. Handing it to the XML parser fails with a
 * message about malformed XML that names neither the cause nor the file.
 *
 * Refusing such a row would be the easy fix and the wrong one: the cache holds
 * the original XML in `raw`, so the form can simply be validated from it. These
 * tests pin that — same verdict from the source XML and from the cache — plus
 * the two ways the lookup can legitimately come up empty.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { validateFormPatternTool } from '../../src/tools/analysis/validateFormPattern.js';
import { FormPatternTemplates } from '../../src/utils/formPatternTemplates.js';

const FORM = 'FpvIndexedForm';

const formXml = FormPatternTemplates.buildSimpleList({
  formName: FORM,
  dsName: 'TestDS',
  dsTable: 'TestTable',
  caption: 'Test',
  gridFields: ['Field1', 'Field2'],
});

/**
 * Minimal stand-in for the symbol index. Both probes the tool makes — the
 * casing-canonicalising lookup (`.all`) and its own file_path SELECT (`.get`) —
 * are answered from the same single row, which is what a real index would do.
 */
function indexStub(filePath: string | null) {
  const row = filePath === null ? undefined : { name: FORM, type: 'form', model: 'MyModel', file_path: filePath };
  return {
    getReadDb: () => ({
      prepare: () => ({
        all: () => (row ? [row] : []),
        get: () => row,
      }),
    }),
  };
}

const call = (formName: string, symbolIndex: unknown) =>
  validateFormPatternTool({ formName }, { symbolIndex });

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fpv-indexed-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('validate_form_pattern via the symbol index', () => {
  it('validates a form whose file_path is the AOT source XML', async () => {
    const xmlFile = path.join(tmp, 'FpvIndexedForm.xml');
    await fs.writeFile(xmlFile, formXml);

    const result = await call(FORM, indexStub(xmlFile));

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain(FORM);
  });

  it('validates from the JSON metadata cache too — unwrapping `raw` rather than refusing', async () => {
    // The exact row shape that used to break this: a real, readable file that is
    // not the source. Rejecting it would report "not found" for a form the index
    // knows and whose XML is right there in the cache.
    const cacheFile = path.join(tmp, 'FpvIndexedForm.json');
    await fs.writeFile(cacheFile, JSON.stringify({ raw: formXml }));

    const result = await call(FORM, indexStub(cacheFile));

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain(FORM);
  });

  it('reports not-found when the index has no row for the name', async () => {
    const result = await call(FORM, indexStub(null));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found in the symbol index/);
  });

  it('names the path when the indexed file yields no XML', async () => {
    // A JSON cache with no `raw` — readable, parseable, and still not a form.
    const cacheFile = path.join(tmp, 'Empty.json');
    await fs.writeFile(cacheFile, JSON.stringify({ name: FORM }));

    const result = await call(FORM, indexStub(cacheFile));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(cacheFile);
  });
});
