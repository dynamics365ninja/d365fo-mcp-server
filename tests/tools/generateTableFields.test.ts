import { describe, it, expect } from 'vitest';
import {
  axTableFieldType,
  buildFieldXml,
  buildFieldGroupXml,
  parseFieldsHint,
  resolveField,
} from '../../src/tools/xml/generateTableFields';

describe('axTableFieldType', () => {
  it('honours an explicit base type', () => {
    expect(axTableFieldType('SomeEdt', 'Real')).toBe('AxTableFieldReal');
    expect(axTableFieldType(undefined, 'Int64')).toBe('AxTableFieldInt64');
    expect(axTableFieldType(undefined, 'Date')).toBe('AxTableFieldDate');
  });

  it('prefers enum when enumType is set', () => {
    expect(axTableFieldType('NoYesId', undefined, 'NoYes')).toBe('AxTableFieldEnum');
  });

  it('falls back to EDT name heuristics', () => {
    expect(axTableFieldType('TransAmount')).toBe('AxTableFieldReal');
    expect(axTableFieldType('CreatedDateTime')).toBe('AxTableFieldUtcDateTime');
    expect(axTableFieldType('SomeRecId')).toBe('AxTableFieldInt64');
  });

  it('defaults to String', () => {
    expect(axTableFieldType('CustName')).toBe('AxTableFieldString');
  });
});

describe('buildFieldXml', () => {
  it('emits an EDT-backed field', () => {
    const xml = buildFieldXml({ name: 'AccountNum', edt: 'CustAccount', mandatory: true, type: 'String' });
    expect(xml).toContain('<AxTableField xmlns="" i:type="AxTableFieldString">');
    expect(xml).toContain('<Name>AccountNum</Name>');
    expect(xml).toContain('<ExtendedDataType>CustAccount</ExtendedDataType>');
    expect(xml).toContain('<Mandatory>Yes</Mandatory>');
  });

  it('emits an enum-backed field with EnumType, never ExtendedDataType', () => {
    const xml = buildFieldXml({ name: 'Blocked', enumType: 'NoYes' });
    expect(xml).toContain('i:type="AxTableFieldEnum"');
    expect(xml).toContain('<EnumType>NoYes</EnumType>');
    expect(xml).not.toContain('ExtendedDataType');
  });

  it('escapes labels', () => {
    const xml = buildFieldXml({ name: 'F', edt: 'X', label: 'A & B <c>' });
    expect(xml).toContain('A &amp; B &lt;c&gt;');
  });
});

describe('buildFieldGroupXml', () => {
  it('lists the given fields', () => {
    const xml = buildFieldGroupXml('OverviewGroup', ['AccountNum', 'Name']);
    expect(xml).toContain('<Name>OverviewGroup</Name>');
    expect(xml).toContain('<DataField>AccountNum</DataField>');
    expect(xml).toContain('<DataField>Name</DataField>');
  });
});

describe('parseFieldsHint', () => {
  it('splits on commas, semicolons and newlines', () => {
    expect(parseFieldsHint('AccountNum, Name;\nAmount')).toEqual(['AccountNum', 'Name', 'Amount']);
  });
  it('drops empties', () => {
    expect(parseFieldsHint('A,,  ,B')).toEqual(['A', 'B']);
  });
});

describe('resolveField (no DB → heuristics only)', () => {
  it('keeps the field name as a fallback EDT when no index is available', () => {
    const { field } = resolveField({ name: 'CustAccount' }, null);
    // db=null → resolveBestEdt is skipped, name is used, base type heuristic applies
    expect(field.edt).toBe('CustAccount');
    expect(axTableFieldType(field.edt, field.type, field.enumType)).toBe('AxTableFieldString');
  });

  it('respects an explicit enumType', () => {
    const { field } = resolveField({ name: 'Status', enumType: 'MyStatus' }, null);
    expect(field.enumType).toBe('MyStatus');
    expect(field.edt).toBeUndefined();
  });

  it('derives a Real base type for amount-like EDTs via heuristic', () => {
    const { field } = resolveField({ name: 'LineAmount', edt: 'AmountMST' }, null);
    expect(axTableFieldType(field.edt, field.type, field.enumType)).toBe('AxTableFieldReal');
  });
});
