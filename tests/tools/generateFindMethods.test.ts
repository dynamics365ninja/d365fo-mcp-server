import { describe, it, expect } from 'vitest';
import {
  bufferName,
  resolveKeyFields,
  buildFindMethods,
  type FindMethodTableShape,
} from '../../src/tools/smart/generateFindMethods';

const custTable: FindMethodTableShape = {
  name: 'CustTable',
  primaryIndex: 'AccountIdx',
  fields: [
    { name: 'AccountNum', extendedDataType: 'CustAccount' },
    { name: 'CustGroup', extendedDataType: 'CustGroupId' },
    { name: 'RecId', fieldType: 'Int64' },
  ],
  indexes: [
    { name: 'AccountIdx', allowDuplicates: false, fields: ['AccountNum'] },
    { name: 'GroupIdx', allowDuplicates: true, fields: ['CustGroup'] },
  ],
};

describe('bufferName', () => {
  it('lower-cases only the first character', () => {
    expect(bufferName('CustTable')).toBe('custTable');
    expect(bufferName('SalesLine')).toBe('salesLine');
  });
});

describe('resolveKeyFields', () => {
  it('prefers the declared primary index', () => {
    const keys = resolveKeyFields(custTable);
    expect(keys.map((k) => k.field)).toEqual(['AccountNum']);
    expect(keys[0].type).toBe('CustAccount'); // EDT carried through
  });

  it('honours an explicit override', () => {
    const keys = resolveKeyFields(custTable, ['CustGroup']);
    expect(keys.map((k) => k.field)).toEqual(['CustGroup']);
    expect(keys[0].type).toBe('CustGroupId');
  });

  it('falls back to the first unique index when no primary index is declared', () => {
    const keys = resolveKeyFields({ ...custTable, primaryIndex: undefined });
    expect(keys.map((k) => k.field)).toEqual(['AccountNum']);
  });

  it('returns [] when no unique index and no override (DB-only env)', () => {
    const keys = resolveKeyFields({ name: 'T', fields: [], indexes: [] });
    expect(keys).toEqual([]);
  });
});

describe('buildFindMethods', () => {
  it('generates find/exists/findRecId for a single-key table', () => {
    const code = buildFindMethods(custTable, resolveKeyFields(custTable));
    expect(code).toContain('public static CustTable find(CustAccount _accountNum, boolean _forUpdate = false)');
    expect(code).toContain('custTable.selectForUpdate(_forUpdate);');
    expect(code).toContain('where custTable.AccountNum == _accountNum;');
    expect(code).toContain('public static boolean exists(CustAccount _accountNum)');
    expect(code).toContain('public static CustTable findRecId(RefRecId _recId, boolean _forUpdate = false)');
    expect(code).toContain('where custTable.RecId == _recId;');
  });

  it('chains composite keys with && in find and exists', () => {
    const keys = resolveKeyFields(custTable, ['AccountNum', 'CustGroup']);
    const code = buildFindMethods(custTable, keys);
    expect(code).toContain('find(CustAccount _accountNum, CustGroupId _custGroup, boolean _forUpdate = false)');
    expect(code).toContain('if (_accountNum && _custGroup)');
    expect(code).toMatch(/custTable\.AccountNum == _accountNum\s*\n\s*&& custTable\.CustGroup == _custGroup;/);
  });

  it('emits only findRecId when no keys are available', () => {
    const code = buildFindMethods({ name: 'T', fields: [], indexes: [] }, []);
    expect(code).toContain('findRecId(');
    expect(code).not.toContain(' find(');
    expect(code).not.toContain('exists(');
  });

  it('respects includeExists / includeFindRecId flags', () => {
    const code = buildFindMethods(custTable, resolveKeyFields(custTable), {
      includeExists: false,
      includeFindRecId: false,
    });
    expect(code).toContain(' find(');
    expect(code).not.toContain('exists(');
    expect(code).not.toContain('findRecId(');
  });
});
