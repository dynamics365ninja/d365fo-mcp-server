/**
 * add-control picking the control type for a bound field.
 *
 * The regression: this used to be a guess from the field NAME, which has
 * nothing to say about enums, so an enum field became an AxFormStringControl —
 * a text box over an enum. A control's type cannot be changed in place, so
 * recovering cost an undo, a re-create and a re-modify.
 *
 * The index knows the answer: a field symbol's signature is its EDT or enum
 * type. These tests use a fake db exposing just the two shapes the resolver
 * queries, so they stay fast and DB-free.
 */

import { describe, it, expect } from 'vitest';
import { resolveControlTypeForField } from '../../src/tools/write/modifyD365File';

interface Row { [k: string]: unknown }

/**
 * Minimal stand-in for the symbol-index db.
 *
 * `fields` keys are "Table.Field" → the signature stored at index time (the
 * field's EDT or enum type). `enums` are base enum names. `edts` maps an EDT to
 * the row edt_metadata holds for it. `tables` are top-level object names that
 * exist, so the parent-name canonicalisation resolves.
 *
 * Both `get` and `all` are implemented: lookupSymbolsNocase queries with `all`
 * and a type filter spread into the params, and stubbing only `get` makes every
 * enum probe answer "no" — which is how the first draft of these tests passed
 * the EDT cases and failed the two that matter.
 */
function fakeDb(opts: {
  fields?: Record<string, string>;
  enums?: string[];
  tables?: string[];
  edts?: Record<string, { extends: string | null; enum_type: string | null; string_size: string | number | null }>;
}) {
  const fields = opts.fields ?? {};
  const enums = new Set((opts.enums ?? []).map(e => e.toLowerCase()));
  const tables = new Set((opts.tables ?? []).map(t => t.toLowerCase()));
  const edts = opts.edts ?? {};

  /** Rows lookupSymbolsNocase would return for (name, types). */
  function symbolHits(name: string, types: string[]): Row[] {
    const lower = name.toLowerCase();
    const wants = (t: string) => types.length === 0 || types.includes(t);
    if (enums.has(lower) && wants('enum')) {
      return [{ name, type: 'enum', model: 'M', extends_class: null, file_path: null }];
    }
    if (tables.has(lower) && wants('table')) {
      return [{ name, type: 'table', model: 'M', extends_class: null, file_path: null }];
    }
    return [];
  }

  /** Params for the symbols queries are (name, ...types, limit) — FTS prepends its MATCH. */
  function parseSymbolParams(sql: string, params: unknown[]): { name: string; types: string[] } {
    const rest = /symbols_fts/.test(sql) ? params.slice(1) : params;
    const [name, ...tail] = rest as string[];
    // FTS repeats the name after the MATCH term; drop it, then the trailing limit.
    const typeArgs = (/symbols_fts/.test(sql) ? tail.slice(1) : tail).slice(0, -1);
    return { name: String(name ?? ''), types: typeArgs.map(String) };
  }

  return {
    prepare(sql: string) {
      return {
        get(...params: unknown[]): Row | undefined {
          if (/FROM symbols WHERE type = 'field'/.test(sql)) {
            const [table, field] = params as [string, string];
            const sig = fields[`${table}.${field}`];
            return sig ? { signature: sig } : undefined;
          }
          if (/FROM edt_metadata/.test(sql)) {
            return edts[String(params[0])];
          }
          return undefined;
        },
        all(...params: unknown[]): Row[] {
          if (/FROM symbols s|symbols_fts/.test(sql)) {
            const { name, types } = parseSymbolParams(sql, params);
            return symbolHits(name, types);
          }
          return [];
        },
      };
    },
  };
}

describe('resolveControlTypeForField', () => {
  it('picks ComboBox for a field whose type is an enum', () => {
    const db = fakeDb({
      fields: { 'ContosoCore_ChangeLog.CtsoFin_QualityTier': 'CtsoFin_QualityTier' },
      enums: ['CtsoFin_QualityTier'],
    });
    const t = resolveControlTypeForField(
      'ContosoCore_ChangeLog', 'CtsoFin_QualityTier', db,
    );
    expect(t).toBe('ComboBox');
  });

  it('picks ComboBox for an enum-backed EDT, which resolves to the bare word "Enum"', () => {
    // resolveEdtBaseType answers 'Enum' here; 'Enum' is not a control type and
    // used to fall through to the String default.
    const db = fakeDb({
      fields: { 'SalesTable.SalesStatus': 'SalesStatus' },
      edts: { SalesStatus: { extends: null, enum_type: 'SalesStatus', string_size: null } },
    });
    expect(resolveControlTypeForField('SalesTable', 'SalesStatus', db)).toBe('ComboBox');
  });

  it('resolves an ordinary EDT to its base type', () => {
    const db = fakeDb({
      fields: { 'CustTable.AccountNum': 'CustAccount' },
      edts: { CustAccount: { extends: null, enum_type: null, string_size: 20 } },
    });
    expect(resolveControlTypeForField('CustTable', 'AccountNum', db)).toBe('String');
  });

  it('falls back to the field name when the data source is not the table name', () => {
    // The field is not found under the data source, but the field name is
    // conventionally the enum/EDT name in X++.
    const db = fakeDb({ enums: ['CtsoFin_QualityTier'] });
    expect(resolveControlTypeForField('SomeDataSource', 'CtsoFin_QualityTier', db)).toBe('ComboBox');
  });

  // A boolean flag is a CheckBox, not a two-item dropdown. Reported 2026-08-12:
  // the auto-pick returned ComboBox for a NoYes-backed EDT while the VS designer
  // emitted AxFormCheckBoxControl for the very same field, so a tool-added
  // control silently disagreed with the one sitting next to it.
  it('picks CheckBox for a NoYes-backed EDT', () => {
    const db = fakeDb({
      fields: { 'InventTestGroup.CtsoDisableProdQty': 'CtsoDisableProdQty' },
      edts: { CtsoDisableProdQty: { extends: null, enum_type: 'NoYes', string_size: null } },
    });
    expect(resolveControlTypeForField('InventTestGroup', 'CtsoDisableProdQty', db)).toBe('CheckBox');
  });

  it('picks CheckBox when the field binds the NoYes enum directly', () => {
    const db = fakeDb({
      fields: { 'CustTable.Blocked': 'NoYes' },
      enums: ['NoYes'],
    });
    expect(resolveControlTypeForField('CustTable', 'Blocked', db)).toBe('CheckBox');
  });

  it('follows an EDT chain down to NoYes', () => {
    // A custom EDT extending the standard NoYesId is still a checkbox.
    const db = fakeDb({
      fields: { 'CustTable.CtsoFlag': 'CtsoFlag' },
      edts: {
        CtsoFlag: { extends: 'NoYesId', enum_type: null, string_size: null },
        NoYesId: { extends: null, enum_type: 'NoYes', string_size: null },
      },
    });
    expect(resolveControlTypeForField('CustTable', 'CtsoFlag', db)).toBe('CheckBox');
  });

  it('leaves a non-boolean enum as a ComboBox', () => {
    const db = fakeDb({
      fields: { 'SalesTable.Posted': 'CtsoPosted' },
      edts: { CtsoPosted: { extends: null, enum_type: 'CtsoApprovalState', string_size: null } },
    });
    expect(resolveControlTypeForField('SalesTable', 'Posted', db)).toBe('ComboBox');
  });

  it('returns undefined with no field, so the caller keeps its own default', () => {
    expect(resolveControlTypeForField('CustTable', undefined, fakeDb({}))).toBeUndefined();
  });

  it('still answers without an index, via the name heuristic', () => {
    // No db at all: must not throw, and must not claim ComboBox it cannot know.
    expect(resolveControlTypeForField('CustTable', 'TransDate', undefined)).toBe('Date');
  });
});
