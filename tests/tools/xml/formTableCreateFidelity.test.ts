/**
 * Two defects that a green suite could not see, because each one produces XML
 * that is well-formed and only fails inside xppc — and then fails on the WRONG
 * object. Both were found by capturing L3-form-event-handler-class on the VM
 * (table + SimpleList form over it, built with xppc 7.0.7996.33):
 *
 *   Metadata Error: AxForm/.../Grid/DataGroup: Field group 'Overview' does not exist.
 *   Metadata Error: AxForm/.../Grid_ConDueDate/DataField: Data type mismatch.
 *
 * The first is the TABLE builder dropping `properties.fieldGroups`; the second
 * is the FORM builder never resolving field control types even though the
 * templates accept them and generate_object supplies them. Both errors name the
 * form, which is why neither was traced back for so long.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildAxTableXml, buildAxTableFieldGroupsXml, buildAxTableIndexesXml } from '../../../src/tools/xml/tableXml';
import { buildAxFormXml } from '../../../src/tools/xml/formXml';
import {
  getFieldControlMapFromDisk, findTableXmlPath, resetTableXmlIndexCache,
  parseTableFieldGroupNames, tableDeclaresFieldGroup,
} from '../../../src/utils/fieldControlTypes';

const AUTO_GROUPS = ['AutoReport', 'AutoLookup', 'AutoIdentification', 'AutoSummary', 'AutoBrowse'];

/** Names of the <AxTableFieldGroup> entries, in document order. */
const groupNames = (xml: string): string[] =>
  [...xml.matchAll(/<AxTableFieldGroup>\s*<Name>([^<]+)<\/Name>/g)].map(m => m[1]);

describe('buildAxTableFieldGroupsXml', () => {
  it('always emits the five Auto* groups, AutoIdentification with AutoPopulate', () => {
    const xml = buildAxTableFieldGroupsXml([]);
    expect(groupNames(xml)).toEqual(AUTO_GROUPS);
    expect(xml).toContain('<Name>AutoIdentification</Name>\n\t\t\t<AutoPopulate>Yes</AutoPopulate>');
  });

  it('appends caller groups after the Auto* ones, with their label and fields', () => {
    const xml = buildAxTableFieldGroupsXml([
      { name: 'Overview', label: '@SYS101239', fields: ['ConCallId', 'ConDueDate'] },
    ]);
    expect(groupNames(xml)).toEqual([...AUTO_GROUPS, 'Overview']);
    expect(xml).toContain('<Label>@SYS101239</Label>');
    expect(xml).toContain('<DataField>ConCallId</DataField>');
    expect(xml).toContain('<DataField>ConDueDate</DataField>');
  });

  it('drops a caller group that would duplicate an Auto* name', () => {
    // The metadata layer rejects the duplicate; silently keeping one Auto group
    // would be worse than ignoring the caller's.
    const xml = buildAxTableFieldGroupsXml([{ name: 'autobrowse', fields: ['X'] }]);
    expect(groupNames(xml)).toEqual(AUTO_GROUPS);
  });

  it('escapes a label that is raw text rather than a label id', () => {
    const xml = buildAxTableFieldGroupsXml([{ name: 'G', label: 'Notes & more' }]);
    expect(xml).toContain('Notes &amp; more');
  });
});

describe('buildAxTableXml — properties.fieldGroups reaches the file', () => {
  it('writes the caller group the form template will reference', () => {
    const xml = buildAxTableXml('ConDemoServiceCall', {
      fields: [{ name: 'ConCallId', edt: 'Name' }],
      fieldGroups: [{ name: 'Overview', fields: ['ConCallId'] }],
    });
    // The regression: this used to be a hardcoded literal with only the Auto* five.
    expect(groupNames(xml)).toEqual([...AUTO_GROUPS, 'Overview']);
  });

  it('still emits exactly the Auto* five when no groups are asked for', () => {
    const xml = buildAxTableXml('ConDemoNoGroups', { fields: [{ name: 'A', edt: 'Name' }] });
    expect(groupNames(xml)).toEqual(AUTO_GROUPS);
  });
});

describe('field control types resolved from disk', () => {
  const roots: string[] = [];
  afterEach(() => {
    resetTableXmlIndexCache();
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  /** A packages root holding one package/model with one AxTable document. */
  const rootWithTable = (table: string, fieldsXml: string): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pld-'));
    roots.push(root);
    const dir = path.join(root, 'MyPackage', 'MyModel', 'AxTable');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${table}.xml`),
      `<?xml version="1.0" encoding="utf-8"?>\n<AxTable>\n\t<Name>${table}</Name>\n\t<Fields>\n${fieldsXml}\n\t</Fields>\n</AxTable>\n`);
    return root;
  };

  const field = (name: string, iType: string, enumType?: string) =>
    `\t\t<AxTableField xmlns="" i:type="${iType}">\n\t\t\t<Name>${name}</Name>\n` +
    (enumType ? `\t\t\t<EnumType>${enumType}</EnumType>\n` : '') + `\t\t</AxTableField>`;

  it('finds a table by name regardless of case, without the symbol index', () => {
    const root = rootWithTable('ConDemoServiceCall', field('A', 'AxTableFieldString'));
    expect(findTableXmlPath('condemoservicecall', [root])).toContain('ConDemoServiceCall.xml');
    expect(findTableXmlPath('NoSuchTable', [root])).toBeUndefined();
  });

  it('maps each field to the control its AxTableField type calls for', () => {
    const root = rootWithTable('T', [
      field('S', 'AxTableFieldString'),
      field('D', 'AxTableFieldDate'),
      field('N', 'AxTableFieldInt'),
      field('Flag', 'AxTableFieldEnum', 'NoYes'),
      field('Status', 'AxTableFieldEnum', 'SalesStatus'),
    ].join('\n'));

    const map = getFieldControlMapFromDisk('T', [root]);
    expect(map.get('s')).toEqual({ iType: 'AxFormStringControl', typeValue: 'String' });
    expect(map.get('d')).toEqual({ iType: 'AxFormDateControl', typeValue: 'Date' });
    expect(map.get('n')).toEqual({ iType: 'AxFormIntegerControl', typeValue: 'Integer' });
    expect(map.get('flag')).toEqual({ iType: 'AxFormCheckBoxControl', typeValue: 'CheckBox' });
    expect(map.get('status')).toEqual({ iType: 'AxFormComboBoxControl', typeValue: 'ComboBox' });
  });

  it('returns an empty map for a table it cannot find, so callers fall back to String', () => {
    const root = rootWithTable('T', field('A', 'AxTableFieldString'));
    expect(getFieldControlMapFromDisk('Missing', [root]).size).toBe(0);
  });
});

describe('buildAxFormXml — grid columns carry the field\'s own control type', () => {
  it('honours a caller-supplied fieldTypes map over anything on disk', () => {
    const xml = buildAxFormXml('ConDemoServiceCallForm', {
      pattern: 'SimpleList',
      dataSource: 'ConDemoServiceCall',
      gridFields: ['ConCallId', 'ConDueDate'],
      fieldTypes: new Map([
        ['concallid', { iType: 'AxFormStringControl', typeValue: 'String' }],
        ['condue' + 'date', { iType: 'AxFormDateControl', typeValue: 'Date' }],
      ]),
    });

    // The regression: every column used to come out AxFormStringControl, and a
    // date column then failed the build with "DataField: Data type mismatch".
    expect(xml).toMatch(/i:type="AxFormDateControl">\s*<Name>Grid_ConDueDate<\/Name>\s*<Type>Date<\/Type>/);
    expect(xml).toMatch(/i:type="AxFormStringControl">\s*<Name>Grid_ConCallId<\/Name>/);
  });

  it('falls back to String controls when the table cannot be resolved at all', () => {
    const xml = buildAxFormXml('ConDemoOrphanForm', {
      pattern: 'SimpleList',
      dataSource: 'ConDemoTableThatDoesNotExistAnywhere',
      gridFields: ['SomeField'],
    });
    expect(xml).toContain('<Name>Grid_SomeField</Name>');
    expect(xml).toContain('AxFormStringControl');
  });
});

/**
 * The third collection the plain table builder dropped. Unlike field groups this
 * one had no way back: `createTablePropertyHonesty` offered `add-index` as the
 * repair, and that operation needs the C# bridge — so a create running on the
 * template path could not produce an index at all.
 */
describe('buildAxTableIndexesXml', () => {
  it('emits an empty element when nothing was asked for', () => {
    expect(buildAxTableIndexesXml([])).toBe('	<Indexes />');
  });

  it('writes a unique index the way AllowDuplicates spells it', () => {
    const xml = buildAxTableIndexesXml([
      { name: 'NoteIdx', fields: ['NoteId'], allowDuplicates: false },
    ]);
    expect(xml).toContain('<Name>NoteIdx</Name>');
    expect(xml).toContain('<AllowDuplicates>No</AllowDuplicates>');
    expect(xml).toContain('<DataField>NoteId</DataField>');
  });

  it('accepts both field spellings, because both are documented elsewhere', () => {
    // `["A"]` is what add-index and the bridge normalizer take; reading only
    // `fieldName` turned it into <DataField>undefined</DataField> — an index
    // that deserializes and points at nothing.
    const xml = buildAxTableIndexesXml([
      { name: 'Mixed', fields: ['A', { fieldName: 'B' }, { name: 'C' }, { dataField: 'D' }] },
    ]);
    for (const f of ['A', 'B', 'C', 'D']) expect(xml).toContain(`<DataField>${f}</DataField>`);
    expect(xml).not.toContain('undefined');
  });

  it('drops a field entry that names nothing rather than writing undefined', () => {
    const xml = buildAxTableIndexesXml([{ name: 'Idx', fields: [{ direction: 'Descending' } as never] }]);
    expect(xml).toContain('<Fields />');
    expect(xml).not.toContain('undefined');
  });

  it('omits AllowDuplicates when the caller did not say, rather than guessing', () => {
    const xml = buildAxTableIndexesXml([{ name: 'Idx', fields: ['A'] }]);
    expect(xml).not.toContain('AllowDuplicates');
  });

  it('reaches the written table document', () => {
    const xml = buildAxTableXml('ConDemoNoteHeader', {
      fields: [{ name: 'NoteId', edt: 'Num' }],
      indexes: [{ name: 'NoteIdx', fields: ['NoteId'], allowDuplicates: false }],
    });
    expect(xml).not.toContain('<Indexes />');
    expect(xml).toContain('<Name>NoteIdx</Name>');
  });
});

/**
 * `<DataGroup>` on a grid or group control is resolved against that control's
 * datasource table. Naming a group the table does not declare is a build error
 * that an INCREMENTAL build passes silently — which is how three captured
 * goldens ended up carrying a dangling one.
 */
describe('grid DataGroup is only emitted when the group is really there', () => {
  const roots: string[] = [];
  afterEach(() => {
    resetTableXmlIndexCache();
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  const rootWithGroups = (table: string, groups: string[]): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pld-dg-'));
    roots.push(root);
    const dir = path.join(root, 'Pkg', 'Model', 'AxTable');
    fs.mkdirSync(dir, { recursive: true });
    const groupXml = groups
      .map(g => ['  <AxTableFieldGroup>', `    <Name>${g}</Name>`, '    <Fields />', '  </AxTableFieldGroup>'].join('\n'))
      .join('\n');
    fs.writeFileSync(path.join(dir, `${table}.xml`), [
      '<AxTable>',
      `  <Name>${table}</Name>`,
      '  <FieldGroups>',
      groupXml,
      '  </FieldGroups>',
      '</AxTable>',
      '',
    ].join('\n'));
    return root;
  };

  it('reads the group names a table declares', () => {
    const root = rootWithGroups('T', ['AutoReport', 'Overview']);
    const file = findTableXmlPath('T', [root])!;
    expect([...parseTableFieldGroupNames(fs.readFileSync(file, 'utf-8'))]).toContain('overview');
    expect(tableDeclaresFieldGroup('T', 'Overview', [root])).toBe(true);
    expect(tableDeclaresFieldGroup('T', 'Nope', [root])).toBe(false);
  });

  it('answers undefined — not false — for a table it cannot read', () => {
    // Absence of evidence is not evidence of absence: dropping the binding on a
    // failed read would break every form built without the packages root in reach.
    const root = rootWithGroups('T', ['Overview']);
    expect(tableDeclaresFieldGroup('Missing', 'Overview', [root])).toBeUndefined();
  });

  it('keeps the binding when the table declares the group', () => {
    const xml = buildAxFormXml('F', {
      pattern: 'SimpleList', dataSource: 'ConDemoNoteHeader', gridFields: ['NoteId'],
    });
    // Holds on both routes, which is the point: on a machine with the sandbox in
    // reach the table declares Overview, and on one without it the answer is
    // "could not tell" and the historical default stands. Only a positive
    // "the table does not have it" may drop the binding.
    expect(xml).toContain('<DataGroup>Overview</DataGroup>');
  });

  it('pairs every DataGroup it writes with a sibling DataSource', () => {
    // A group control whose DataGroup has no DataSource cannot resolve the group,
    // and the build says "Field group 'Overview' does not exist" while pointing
    // at the control rather than the missing sibling.
    for (const pattern of ['SimpleList', 'SimpleListDetails', 'DetailsMaster']) {
      const xml = buildAxFormXml('F', { pattern, dataSource: 'ConDemoNoteHeader', gridFields: ['NoteId'] });
      const groups = xml.split('<DataGroup>').slice(1);
      for (const after of groups) {
        expect(after.slice(0, 200), `${pattern}: DataGroup without a sibling DataSource`)
          .toContain('<DataSource>');
      }
    }
  });
});
