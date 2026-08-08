import { describe, it, expect } from 'vitest';
import {
  resolveBestEdt,
  suggestEdtFromFieldName,
  isInfrastructureField,
  heuristicEdtBaseType,
  resolveEdtBaseType,
  resolveEdtEnumType,
  isEnumName,
} from '../../src/tools/smart/generateSmartTable';

/**
 * Fake read-db over a fixed list of EDT names. Handles the three query shapes
 * resolveBestEdt / validateEdtExists use: exact "= ?", "LIKE ?", and the
 * "SELECT 1 FROM edt_metadata" existence probe.
 */
function fakeDb(edts: string[]) {
  return {
    prepare(sql: string) {
      return {
        get(arg: string) {
          if (/= \?/.test(sql)) {
            const hit = edts.find(e => e.toLowerCase() === String(arg).toLowerCase());
            if (/SELECT 1/.test(sql)) return hit ? { 1: 1 } : undefined;
            return hit ? { edt_name: hit } : undefined;
          }
          return undefined;
        },
        all(arg: string) {
          const needle = String(arg).replace(/%/g, '').toLowerCase();
          return edts.filter(e => e.toLowerCase().includes(needle)).map(e => ({ edt_name: e }));
        },
      };
    },
  };
}

describe('suggestEdtFromFieldName (heuristic)', () => {
  it('maps a *date field to TransDate, not a non-existent *DateTime EDT', () => {
    expect(suggestEdtFromFieldName('FromDate')).toBe('TransDate');
    expect(suggestEdtFromFieldName('ToDate')).toBe('TransDate');
  });

  it('keeps the bare ValidFrom/ValidTo effectivity datetimes', () => {
    expect(suggestEdtFromFieldName('ValidFrom')).toBe('ValidFromDateTime');
    expect(suggestEdtFromFieldName('ValidTo')).toBe('ValidToDateTime');
  });

  it('maps rate to an amount EDT', () => {
    expect(suggestEdtFromFieldName('DailyRate')).toBe('AmountMST');
  });

  it('does NOT force *Id to RefRecId or status to NoYesId', () => {
    expect(suggestEdtFromFieldName('RentEquipmentId')).toBe('String255');
    expect(suggestEdtFromFieldName('Status')).toBe('String255');
  });
});

describe('resolveBestEdt (DB-aware)', () => {
  it('prefers a real model-prefixed EDT over a generic guess', () => {
    const db = fakeDb(['ContosoRentEquipmentId', 'RefRecId']);
    expect(resolveBestEdt('RentEquipmentId', db)).toBe('ContosoRentEquipmentId');
  });

  it('returns an exact EDT match when one exists', () => {
    const db = fakeDb(['ContosoRentEquipmentId']);
    expect(resolveBestEdt('ContosoRentEquipmentId', db)).toBe('ContosoRentEquipmentId');
  });

  it('uses the heuristic when it resolves to an existing EDT', () => {
    const db = fakeDb(['AmountMST']);
    expect(resolveBestEdt('DailyRate', db)).toBe('AmountMST');
  });

  it('falls back to the string default when nothing matches', () => {
    const db = fakeDb([]);
    expect(resolveBestEdt('Category', db)).toBe('String255');
  });

  it('does NOT grab a domain-prefixed EDT for a generic field word', () => {
    // "CovStatus" contains "Status" (conf ≥ 0.8) but is an unrelated concept —
    // a generic "Status" field must not inherit it. Regression for the fuzzy
    // containment edge that real (noisy) indexes hit but minimal fakes missed.
    expect(resolveBestEdt('Status', fakeDb(['CovStatus']))).toBe('String255');
    expect(resolveBestEdt('Type', fakeDb(['LedgerPostingType']))).toBe('String255');
    expect(resolveBestEdt('Group', fakeDb(['CustGroupId', 'VendGroup']))).toBe('String255');
  });

  it('still prefers a prefixed EDT for a SPECIFIC multi-word field', () => {
    // The generic-word guard must not regress the model-prefixed match: a
    // specific field is unambiguous enough that a prefixed EDT is correct.
    expect(resolveBestEdt('RentEquipmentId', fakeDb(['ContosoRentEquipmentId', 'CovStatus'])))
      .toBe('ContosoRentEquipmentId');
  });

  it('still returns an exact EDT match for a generic word when one exists', () => {
    // The guard only blocks FUZZY matches; an exact same-name EDT is honored.
    expect(resolveBestEdt('Category', fakeDb(['Category', 'ProjCategoryId']))).toBe('Category');
  });

  it('returns the fieldName itself when it looks like a custom PascalCase EDT not in the index', () => {
    // When a user passes a custom EDT name that was just created (not yet indexed),
    // resolveBestEdt should trust the input rather than silently defaulting to String255.
    // This only fires when no specific heuristic matches (e.g. a plain ID field).
    // The edtWarnings system in the caller validates it separately.
    const db = fakeDb([]); // empty index — custom EDT not indexed yet
    expect(resolveBestEdt('ContosoRentEquipmentId', db)).toBe('ContosoRentEquipmentId');
    expect(resolveBestEdt('ContosoRentAgreementId', db)).toBe('ContosoRentAgreementId');
    // Note: ContosoRentDailyRate still maps to AmountMST via the 'rate' heuristic — correct behavior.
    expect(resolveBestEdt('ContosoRentDailyRate', db)).toBe('AmountMST');
  });

  it('does NOT return the fieldName for generic single-word fields even if PascalCase', () => {
    // Generic single-word fields (status, category, type…) must still fall through to
    // String255 — they are not EDTs, just column names for which we cannot infer a type.
    const db = fakeDb([]);
    expect(resolveBestEdt('Status', db)).toBe('String255');
    expect(resolveBestEdt('Category', db)).toBe('String255');
  });
});

describe('heuristicEdtBaseType (fallback when EDT not indexed)', () => {
  it('resolves Real/Date/Int64 from standard EDT names', () => {
    // Regression for friction #3: Qty/TransDate/RecId fell to AxTableFieldString on
    // the bridge path because their base type was undefined when not indexed.
    expect(heuristicEdtBaseType('Qty')).toBe('Real');
    expect(heuristicEdtBaseType('AmountMST')).toBe('Real');
    expect(heuristicEdtBaseType('DailyRate')).toBe('Real');
    expect(heuristicEdtBaseType('TransDate')).toBe('Date');
    expect(heuristicEdtBaseType('AcquiredDate')).toBe('Date');
    expect(heuristicEdtBaseType('RecId')).toBe('Int64');
    expect(heuristicEdtBaseType('SomeRefRecId')).toBe('Int64');
  });

  it('maps datetime names to UtcDateTime', () => {
    expect(heuristicEdtBaseType('CreatedDateTime')).toBe('UtcDateTime');
  });

  it('maps TransDateTime to UtcDateTime (regression: substring-exclusion bug)', () => {
    // Found live while implementing the eval-loop "sales credit review + audit" scenario:
    // a table field created with only `{ name: "PostedAt", edt: "TransDateTime" }` came
    // back as plain AxTableFieldString instead of AxTableFieldUtcDateTime. Root cause: the
    // old check was `e.includes('datetime') && !e.includes('transdate')` — but
    // "transdatetime".includes('transdate') is true, so the exclusion fired on the exact
    // name it should have matched, and the field silently defaulted to String.
    expect(heuristicEdtBaseType('TransDateTime')).toBe('UtcDateTime');
    expect(heuristicEdtBaseType('ModifiedDateTime')).toBe('UtcDateTime');
  });

  it('returns undefined for names with no recognizable base type', () => {
    expect(heuristicEdtBaseType('ContosoRentEquipmentId')).toBeUndefined();
    expect(heuristicEdtBaseType('Name')).toBeUndefined();
  });
});

describe('resolveEdtBaseType (indexed EDT, root-EDT ambiguity)', () => {
  // Fake edt_metadata over a {name: {extends, enum_type, string_size}} map.
  function edtMetaDb(rows: Record<string, { extends?: string | null; enum_type?: string | null; string_size?: string | number | null }>) {
    return {
      prepare(_sql: string) {
        return {
          get(arg: string) {
            const key = Object.keys(rows).find(k => k.toLowerCase() === String(arg).toLowerCase());
            if (!key) return undefined;
            const r = rows[key];
            return { extends: r.extends ?? null, enum_type: r.enum_type ?? null, string_size: r.string_size ?? null };
          },
        };
      },
    };
  }

  it('does NOT mislabel a root Date/Real EDT as String (string_size is null → undefined)', () => {
    // The #1 bug: TransDate/Qty are indexed with extends=null and no string_size.
    // Returning "String" here shadowed heuristicEdtBaseType; we must return undefined
    // so the caller's heuristic (or the bridge) resolves the real primitive.
    const db = edtMetaDb({ TransDate: {}, RealBase: {}, Qty: { extends: 'RealBase' } });
    expect(resolveEdtBaseType('TransDate', db)).toBeUndefined();
    expect(resolveEdtBaseType('Qty', db)).toBeUndefined(); // chains through RealBase → ambiguous root
  });

  it('still resolves a genuine String EDT (root with a string_size)', () => {
    const db = edtMetaDb({ Name: { string_size: 60 }, Num: { string_size: 20 } });
    expect(resolveEdtBaseType('Name', db)).toBe('String');
    expect(resolveEdtBaseType('Num', db)).toBe('String');
  });

  it('resolves enum-backed and primitive-extending EDTs', () => {
    const db = edtMetaDb({ SalesStatus: { enum_type: 'SalesStatus' }, MyAmount: { extends: 'Real' } });
    expect(resolveEdtBaseType('SalesStatus', db)).toBe('Enum');
    expect(resolveEdtBaseType('MyAmount', db)).toBe('Real');
  });

  it('returns undefined for an EDT missing from the index', () => {
    expect(resolveEdtBaseType('ContosoCustomId', edtMetaDb({}))).toBeUndefined();
  });
});

describe('resolveEdtEnumType (recover the enum name behind an Enum-based EDT)', () => {
  function edtMetaDb(rows: Record<string, { extends?: string | null; enum_type?: string | null }>) {
    return {
      prepare(_sql: string) {
        return {
          get(arg: string) {
            const key = Object.keys(rows).find(k => k.toLowerCase() === String(arg).toLowerCase());
            if (!key) return undefined;
            const r = rows[key];
            return { extends: r.extends ?? null, enum_type: r.enum_type ?? null };
          },
        };
      },
    };
  }

  it('resolves the underlying enum name for a directly enum-backed EDT', () => {
    // Regression: resolveEdtBaseType('Posted', db) correctly returns the literal string
    // "Enum", but createD365File's field-type resolution had no way to learn WHICH enum
    // (NoYes) — so a field created with only `{ name, edt: "Posted" }` got `type: 'Enum'`
    // with no `enumType`, and the bridge silently emitted AxTableFieldString instead of
    // AxTableFieldEnum. This helper closes that gap.
    const db = edtMetaDb({ Posted: { enum_type: 'NoYes' } });
    expect(resolveEdtEnumType('Posted', db)).toBe('NoYes');
  });

  it('follows the EDT chain to find the enum on an indirectly enum-backed EDT', () => {
    const db = edtMetaDb({
      Posted: { enum_type: 'NoYes' },
      MyPostedFlag: { extends: 'Posted' },
    });
    expect(resolveEdtEnumType('MyPostedFlag', db)).toBe('NoYes');
  });

  it('returns undefined for a non-enum EDT', () => {
    const db = edtMetaDb({ TransDate: {}, MyAmount: { extends: 'Real' } });
    expect(resolveEdtEnumType('TransDate', db)).toBeUndefined();
    expect(resolveEdtEnumType('MyAmount', db)).toBeUndefined();
  });

  it('returns undefined for an EDT missing from the index', () => {
    expect(resolveEdtEnumType('ContosoCustomId', edtMetaDb({}))).toBeUndefined();
  });
});

describe('isEnumName (enum vs EDT detection)', () => {
  function enumDb(enums: string[]) {
    // The nocase symbol lookup (utils/symbolLookup) probes via .all().
    return {
      prepare(_sql: string) {
        return {
          all(...args: unknown[]) {
            const hit = enums.find(e => e.toLowerCase() === String(args[0]).toLowerCase());
            return hit
              ? [{ name: hit, type: 'enum', model: 'Test', extends_class: null, file_path: null }]
              : [];
          },
          get() { return undefined; },
        };
      },
    };
  }
  it('detects an indexed enum name', () => {
    // Regression for friction #2: an enum-backed field was created as
    // AxTableFieldString + EDT instead of AxTableFieldEnum.
    expect(isEnumName('ContosoRentEquipmentStatus', enumDb(['ContosoRentEquipmentStatus']))).toBe(true);
  });
  it('returns false for a name that is not an indexed enum', () => {
    expect(isEnumName('CustAccount', enumDb(['ContosoRentEquipmentStatus']))).toBe(false);
  });
});

describe('isInfrastructureField', () => {
  it('flags cross-cutting framework/audit fields', () => {
    expect(isInfrastructureField('MCRHoldCode')).toBe(true);
    expect(isInfrastructureField('modifiedDateTime')).toBe(true);
  });

  it('does not flag ordinary business fields', () => {
    expect(isInfrastructureField('Name')).toBe(false);
    expect(isInfrastructureField('DailyRate')).toBe(false);
  });
});
