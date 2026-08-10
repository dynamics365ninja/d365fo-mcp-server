/**
 * search(scope="extensions") — model scoping, index plan, and the type filter.
 *
 * Run 6639b2df spent 122.8 s in one such call. The query was
 * `name LIKE '%validateWrite%'` over the whole symbols table with no model predicate:
 * unindexable by construction, so every call scanned all 1.19 M rows. It also mislabelled
 * its output — Microsoft rows satisfying the `*Extension` name convention were reported
 * under "matches in custom extensions" — and answered as if no `type` filter had been
 * passed, because the tool schema dropped it before it reached the index.
 *
 * These tests pin the three properties that fix depends on:
 *   1. `model IN (custom models)` drives the query, so the plan is a seek not a scan;
 *   2. standard-model rows never appear, whatever their name;
 *   3. `types` filters without costing the index — the unary + in `+type IN (...)` is
 *      load-bearing, since ~1 M of 1.19 M production rows are methods and the planner
 *      will happily prefer idx_type_name and re-scan almost the whole table.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';

let index: XppSymbolIndex;
let previousCustomModels: string | undefined;

const sym = (name: string, type: string, model: string, parentName?: string) =>
  index.addSymbol({ name, type, parentName, filePath: `/${model}/${name}.xml`, model } as any);

beforeAll(() => {
  previousCustomModels = process.env.CUSTOM_MODELS;
  process.env.CUSTOM_MODELS = 'CustomFin,CustomReg';

  index = new XppSymbolIndex(':memory:', ':memory:');

  // Custom extension objects and their members.
  sym('CustTableCustomFin_Extension', 'class-extension', 'CustomFin');
  sym('validateWrite', 'method', 'CustomFin', 'CustTableCustomFin_Extension');
  sym('CustTable.CustomFinExtension', 'table-extension', 'CustomFin');
  sym('validateWrite', 'method', 'CustomReg', 'VendTableCustomReg_Extension');
  sym('VendTableCustomReg_Extension', 'class-extension', 'CustomReg');

  // A plain custom class: right model, but not extension-shaped.
  sym('CustomFinHelper', 'class', 'CustomFin');
  sym('validateWrite', 'method', 'CustomFin', 'CustomFinHelper');

  // A literal-underscore name and a no-underscore one, both in scope. Only the first
  // contains the literal text "e_Extension"; both match the LIKE pattern '%e_Extension%'
  // when '_' is left as a wildcard.
  sym('AslTable_Extension', 'class-extension', 'CustomFin');
  sym('AslTableXExtension', 'class-extension', 'CustomFin');

  // Microsoft rows. `validateWriteExtension` is the exact shape that leaked into the
  // production run's results: a method whose own name ends in "Extension".
  sym('validateWriteExtension', 'method', 'ApplicationSuite', 'CatCartLine');
  sym('CustTableApp_Extension', 'class-extension', 'ApplicationSuite');
});

afterAll(() => {
  index.close();
  if (previousCustomModels === undefined) delete process.env.CUSTOM_MODELS;
  else process.env.CUSTOM_MODELS = previousCustomModels;
});

const names = (rows: Array<{ name: string; model?: string }>) =>
  rows.map(r => `${r.model}:${r.name}`).sort();

describe('searchCustomExtensions', () => {
  it('finds members of custom extensions and excludes standard models', () => {
    const hits = index.searchCustomExtensions('validateWrite');

    expect(names(hits as any)).toEqual([
      'CustomFin:validateWrite',
      'CustomReg:validateWrite',
    ]);
    // The Microsoft row is the regression: it used to be returned, captioned as custom.
    expect(hits.some(h => h.name === 'validateWriteExtension')).toBe(false);
    // A method on a non-extension custom class is in a custom model but not in an
    // extension — the scope is "extensions", not "everything custom".
    expect(hits.every(h => h.parentName?.includes('_Extension'))).toBe(true);
  });

  it('honours the type filter without losing the model index', () => {
    expect(index.searchCustomExtensions('CustTable', undefined, 20, ['class-extension'])
      .map(h => h.name)).toEqual(['CustTableCustomFin_Extension']);

    // Same query, wrong type → empty, rather than the unfiltered answer the dropped
    // argument used to produce.
    expect(index.searchCustomExtensions('CustTable', undefined, 20, ['method'])).toEqual([]);
  });

  it('narrows by model prefix', () => {
    expect(index.searchCustomExtensions('validateWrite', 'CustomReg').map(h => h.model))
      .toEqual(['CustomReg']);
    expect(index.searchCustomExtensions('validateWrite', 'Nope')).toEqual([]);
  });

  it('seeks on idx_symbols_model, with and without a type filter', () => {
    // The plan IS the assertion: "SCAN symbols" means every extension search re-reads
    // the whole table, which is what cost 122.8 s in production.
    const planOf = (sql: string, params: any[]) =>
      (index.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
        .map(r => r.detail)
        .join('\n');

    const base = `
      SELECT * FROM symbols
      WHERE model IN (?, ?)
        AND name LIKE ? ESCAPE '\\'
        AND (name LIKE '%\\_Extension' ESCAPE '\\' OR parent_name LIKE '%\\_Extension' ESCAPE '\\')`;

    const withoutType = planOf(`${base} ORDER BY name LIMIT ?`,
      ['CustomFin', 'CustomReg', '%validateWrite%', 20]);
    expect(withoutType).toContain('idx_symbols_model');
    expect(withoutType).not.toMatch(/^SCAN symbols/m);

    const withType = planOf(`${base} AND +type IN (?) ORDER BY name LIMIT ?`,
      ['CustomFin', 'CustomReg', '%validateWrite%', 'method', 20]);
    expect(withType).toContain('idx_symbols_model');
    expect(withType).not.toMatch(/^SCAN symbols/m);
  });

  it('escapes LIKE metacharacters in the query', () => {
    // Unescaped, '_' is a single-character wildcard: '%e_Extension%' also matches
    // AslTableXExtension. Only AslTable_Extension contains the text the caller typed.
    expect(index.searchCustomExtensions('e_Extension').map(h => h.name))
      .toEqual(['AslTable_Extension']);
  });
});
