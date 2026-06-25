/**
 * Tests for field type → form control type resolution.
 */

import { describe, it, expect } from 'vitest';
import {
  controlForTableField,
  controlForField,
  parseTableFieldControls,
  DEFAULT_CONTROL,
} from '../../src/utils/fieldControlTypes';

describe('controlForTableField', () => {
  it('maps base scalar field types to their form controls', () => {
    expect(controlForTableField('AxTableFieldString')).toEqual({ iType: 'AxFormStringControl', typeValue: 'String' });
    expect(controlForTableField('AxTableFieldReal')).toEqual({ iType: 'AxFormRealControl', typeValue: 'Real' });
    expect(controlForTableField('AxTableFieldDate')).toEqual({ iType: 'AxFormDateControl', typeValue: 'Date' });
    expect(controlForTableField('AxTableFieldInt')).toEqual({ iType: 'AxFormIntegerControl', typeValue: 'Integer' });
    expect(controlForTableField('AxTableFieldInt64')).toEqual({ iType: 'AxFormInt64Control', typeValue: 'Int64' });
    expect(controlForTableField('AxTableFieldUtcDateTime')).toEqual({ iType: 'AxFormDateTimeControl', typeValue: 'DateTime' });
  });

  it('maps a non-NoYes enum to a ComboBox', () => {
    expect(controlForTableField('AxTableFieldEnum', 'SalesStatus')).toEqual({
      iType: 'AxFormComboBoxControl',
      typeValue: 'ComboBox',
    });
  });

  it('maps a NoYes enum to a CheckBox', () => {
    expect(controlForTableField('AxTableFieldEnum', 'NoYes')).toEqual({
      iType: 'AxFormCheckBoxControl',
      typeValue: 'CheckBox',
    });
  });

  it('falls back to a string control for unknown field types', () => {
    expect(controlForTableField('AxTableFieldSomethingNew')).toEqual(DEFAULT_CONTROL);
  });
});

describe('parseTableFieldControls', () => {
  const tableXml = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>DemoTable</Name>
  <Fields>
    <AxTableField xmlns=""
        i:type="AxTableFieldString">
      <Name>AccountNum</Name>
    </AxTableField>
    <AxTableField xmlns=""
        i:type="AxTableFieldEnum">
      <Name>Status</Name>
      <EnumType>SalesStatus</EnumType>
    </AxTableField>
    <AxTableField xmlns=""
        i:type="AxTableFieldEnum">
      <Name>Blocked</Name>
      <EnumType>NoYes</EnumType>
    </AxTableField>
    <AxTableField xmlns=""
        i:type="AxTableFieldReal">
      <Name>Amount</Name>
    </AxTableField>
    <AxTableField xmlns=""
        i:type="AxTableFieldDate">
      <Name>DueDate</Name>
    </AxTableField>
  </Fields>
</AxTable>`;

  const map = parseTableFieldControls(tableXml);

  it('parses every field with its correct control type (case-insensitive key)', () => {
    expect(map.get('accountnum')).toEqual({ iType: 'AxFormStringControl', typeValue: 'String' });
    expect(map.get('status')).toEqual({ iType: 'AxFormComboBoxControl', typeValue: 'ComboBox' });
    expect(map.get('blocked')).toEqual({ iType: 'AxFormCheckBoxControl', typeValue: 'CheckBox' });
    expect(map.get('amount')).toEqual({ iType: 'AxFormRealControl', typeValue: 'Real' });
    expect(map.get('duedate')).toEqual({ iType: 'AxFormDateControl', typeValue: 'Date' });
  });

  it('returns an empty map for non-table content', () => {
    expect(parseTableFieldControls('<not-a-table/>').size).toBe(0);
  });
});

describe('controlForField', () => {
  const map = new Map([['status', { iType: 'AxFormComboBoxControl', typeValue: 'ComboBox' }]]);

  it('resolves a mapped field', () => {
    expect(controlForField('Status', map).typeValue).toBe('ComboBox');
  });

  it('defaults to a string control when the field or map is absent', () => {
    expect(controlForField('Unknown', map)).toEqual(DEFAULT_CONTROL);
    expect(controlForField('Status', undefined)).toEqual(DEFAULT_CONTROL);
  });
});
