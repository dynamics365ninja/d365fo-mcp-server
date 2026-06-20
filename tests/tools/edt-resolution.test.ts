import { describe, it, expect } from 'vitest';
import {
  resolveBestEdt,
  suggestEdtFromFieldName,
  isInfrastructureField,
} from '../../src/tools/generateSmartTable';

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
