/**
 * buildAxMapXml (src/tools/mapXml.ts).
 *
 * Regression: eval/corpus/runs/2026-07-06T18__L1-map-basic__cb1b73d.json —
 * `map` had NO entry at all in the d365fo_file properties documentation
 * (every other objectType does), so a caller reasonably guessed field-EDT
 * property names from the sibling `table`/`table-extension` convention
 * (`edt`), which buildAxMapXml did not read (only `extendedDataType`) — the
 * EDT was silently dropped from every generated field.
 */

import { describe, it, expect } from 'vitest';
import { buildAxMapXml } from '../../src/tools/mapXml';

describe('buildAxMapXml — field EDT property name', () => {
  it('writes ExtendedDataType from the documented extendedDataType key (existing behaviour, unchanged)', () => {
    const xml = buildAxMapXml('ConDemoNoteMap', {
      fields: [{ name: 'NoteId', extendedDataType: 'Num' }],
    });
    expect(xml).toContain('<ExtendedDataType>Num</ExtendedDataType>');
  });

  it('ALSO writes ExtendedDataType from `edt` (the table/table-extension field-spec convention) — regression', () => {
    const xml = buildAxMapXml('ConDemoNoteMap', {
      fields: [{ name: 'NoteId', edt: 'Num' }],
    });
    expect(xml).toContain('<ExtendedDataType>Num</ExtendedDataType>');
  });

  it('extendedDataType wins when both are somehow given', () => {
    const xml = buildAxMapXml('ConDemoNoteMap', {
      fields: [{ name: 'NoteId', extendedDataType: 'Num', edt: 'SomethingElse' }],
    });
    expect(xml).toContain('<ExtendedDataType>Num</ExtendedDataType>');
    expect(xml).not.toContain('SomethingElse');
  });

  it('omits ExtendedDataType entirely when neither key is given (unchanged)', () => {
    const xml = buildAxMapXml('ConDemoNoteMap', {
      fields: [{ name: 'CreatedDateTime', type: 'UtcDateTime' }],
    });
    expect(xml).not.toContain('<ExtendedDataType>');
  });
});

describe('buildAxMapXml — mappingTable + mappings (documented shape, already correct)', () => {
  it('writes MappingTable + one connection per field by default', () => {
    const xml = buildAxMapXml('ConDemoNoteMap', {
      mappingTable: 'ConDemoNoteHeader',
      fields: [{ name: 'NoteId', edt: 'Num' }, { name: 'Subject', edt: 'Description' }],
    });
    expect(xml).toContain('<MappingTable>ConDemoNoteHeader</MappingTable>');
    expect(xml).toContain('<MapField>NoteId</MapField>\n\t\t\t\t\t<MapFieldTo>NoteId</MapFieldTo>');
    expect(xml).toContain('<MapField>Subject</MapField>\n\t\t\t\t\t<MapFieldTo>Subject</MapFieldTo>');
  });

  it('honours explicit mappings overriding the default 1:1 connection', () => {
    const xml = buildAxMapXml('ConDemoNoteMap', {
      mappingTable: 'ConDemoNoteHeader',
      fields: [{ name: 'NoteId', edt: 'Num' }],
      mappings: [{ mapField: 'NoteId', mapFieldTo: 'DifferentField' }],
    });
    expect(xml).toContain('<MapFieldTo>DifferentField</MapFieldTo>');
  });

  it('emits an empty <Mappings /> when mappingTable is not given', () => {
    const xml = buildAxMapXml('ConDemoNoteMap', { fields: [{ name: 'NoteId', edt: 'Num' }] });
    expect(xml).toContain('<Mappings />');
  });
});
