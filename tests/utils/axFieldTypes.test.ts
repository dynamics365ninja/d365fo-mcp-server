/**
 * The one canonical field base-type map (src/utils/axFieldTypes.ts).
 *
 * Audit §3 item 14 (with 8 and 16 in the same cluster): five private copies of
 * this dictionary disagreed on spelling and every one of them was case-sensitive
 * with a `|| 'String'` fallback, so a type the caller named correctly could still
 * be written as a String field and reported as success.
 *
 * The element names asserted here are the metamodel's own, read by reflection
 * over Microsoft.Dynamics.AX.Metadata.dll — notably AxMapFieldBoolean does NOT
 * exist, which the old mapXml dictionary emitted.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  AX_FIELD_BASE_TYPES,
  axMapFieldElement,
  axTableFieldElement,
  baseTypeFromEdtName,
  normalizeFieldBaseType,
} from '../../src/utils/axFieldTypes';
import { axTableFieldType } from '../../src/tools/xml/generateTableFields';
import { buildAxMapXml } from '../../src/tools/xml/mapXml';

describe('normalizeFieldBaseType', () => {
  it('accepts Integer and Int as the same type (the mapXml divergence)', () => {
    expect(normalizeFieldBaseType('Integer')).toBe('Integer');
    expect(normalizeFieldBaseType('Int')).toBe('Integer');
    expect(axTableFieldElement('Integer')).toBe('AxTableFieldInt');
    expect(axMapFieldElement('Integer')).toBe('AxMapFieldInt');
  });

  it('is case-insensitive for every canonical type', () => {
    for (const t of AX_FIELD_BASE_TYPES) {
      expect(normalizeFieldBaseType(t.toLowerCase()), t).toBe(t);
      expect(normalizeFieldBaseType(t.toUpperCase()), t).toBe(t);
      expect(normalizeFieldBaseType(`  ${t} `), t).toBe(t);
    }
  });

  it('accepts a pasted i:type element name', () => {
    expect(normalizeFieldBaseType('AxTableFieldInt64')).toBe('Int64');
    expect(normalizeFieldBaseType('AxMapFieldUtcDateTime')).toBe('UtcDateTime');
  });

  it('returns undefined — never String — for a name that is not a field type', () => {
    for (const bogus of ['Iteger', 'Boolean', 'Nonsense', '', '   ', undefined, null, 42]) {
      expect(normalizeFieldBaseType(bogus as any), String(bogus)).toBeUndefined();
    }
  });

  it('keeps the EDT-name heuristics that the three table copies shared', () => {
    expect(baseTypeFromEdtName('CustRefRecId')).toBe('Int64');
    expect(baseTypeFromEdtName('CreatedDateTime')).toBe('UtcDateTime');
    expect(baseTypeFromEdtName('TransDate')).toBe('Date');
    expect(baseTypeFromEdtName('AmountMST')).toBe('Real');
    expect(baseTypeFromEdtName('NoYesId')).toBe('Enum');
    expect(baseTypeFromEdtName('ItemId')).toBeUndefined();
  });
});

describe('map fields use the same map as table fields (audit 14)', () => {
  it('type:"Integer" produces AxMapFieldInt, not AxMapFieldString', () => {
    const xml = buildAxMapXml('ConDemoMap', { fields: [{ name: 'Qty', type: 'Integer' }] });
    expect(xml).toContain('i:type="AxMapFieldInt"');
    expect(xml).not.toContain('AxMapFieldString');
  });

  it('lower-case spellings work too', () => {
    const xml = buildAxMapXml('ConDemoMap', { fields: [{ name: 'Id', type: 'guid' }] });
    expect(xml).toContain('i:type="AxMapFieldGuid"');
  });

  it('refuses a type that names no metamodel element instead of writing String', () => {
    expect(() => buildAxMapXml('ConDemoMap', { fields: [{ name: 'X', type: 'Nonsense' }] }))
      .toThrow(/not a D365FO field type/);
    // AxMapFieldBoolean is not a metamodel type — it used to be emitted verbatim.
    expect(() => buildAxMapXml('ConDemoMap', { fields: [{ name: 'Flag', type: 'Boolean' }] }))
      .toThrow(/no boolean field type/);
  });

  it('table and map agree on every canonical type (one map, two families)', () => {
    for (const t of AX_FIELD_BASE_TYPES) {
      const suffix = axTableFieldElement(t).replace('AxTableField', '');
      expect(axMapFieldElement(t), t).toBe(`AxMapField${suffix}`);
    }
  });
});

describe('the divergent copies are gone', () => {
  const sources = [
    'src/tools/write/createD365File.ts',
    'src/tools/xml/generateTableFields.ts',
    'src/tools/xml/mapXml.ts',
    'src/utils/smartXmlBuilder.ts',
    // Added when the generate/create unification landed: fieldTypeToAxType moved
    // out of createD365File.ts into this shared builder, carrying its own copy of
    // the dictionary with it. Without this entry the sixth copy would have slipped
    // through the guard silently.
    'src/tools/xml/tableXml.ts',
  ];

  it('no file re-declares a private base-type dictionary', () => {
    for (const f of sources) {
      const src = readFileSync(f, 'utf8');
      // The tell of a private copy: a literal mapping String → the i:type element.
      expect(src, `${f} still carries its own type dictionary`)
        .not.toMatch(/String:\s*'Ax(Table|Map)Field/);
    }
  });

  it('generateTableFields still resolves through the shared map', () => {
    expect(axTableFieldType(undefined, 'integer')).toBe('AxTableFieldInt');
    expect(axTableFieldType('TransDate')).toBe('AxTableFieldDate');
    expect(axTableFieldType(undefined, undefined, 'NoYes')).toBe('AxTableFieldEnum');
  });
});
