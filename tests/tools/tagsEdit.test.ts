/**
 * `<Tags>` writer: canonical positions per object type and element kind, insert / replace / remove,
 * several tags, line endings, and the unsupported-root refusal.
 *
 * Positions follow the serializer rule (Name, SourceCode, then scalars alphabetically, then
 * collections) and were checked by removing and re-inserting every `<Tags>` in a repository of
 * shipped, tagged XML (about 1,950 objects and elements, no diff apart from the exceptions
 * documented in tagsEdit.ts).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  combineTags, normalizeTagsInput, readElementTags, readObjectTags, resolveTagsToWrite,
  setElementTags, setObjectTags,
} from '../../src/tools/xml/tagsEdit';

const T = '\t';
const lines = (...l: string[]) => l.join('\r\n');
const pos = (xml: string, s: string) => xml.indexOf(s);

const table = lines(
  '<?xml version="1.0" encoding="utf-8"?>',
  '<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">',
  `${T}<Name>ContosoRentTable</Name>`,
  `${T}<SourceCode>`,
  `${T}${T}<Declaration><![CDATA[`,
  'public class ContosoRentTable extends common',
  '{',
  '}',
  `]]></Declaration>`,
  `${T}${T}<Methods>`,
  `${T}${T}${T}<Method>`,
  `${T}${T}${T}${T}<Name>find</Name>`,
  `${T}${T}${T}${T}<Source><![CDATA[`,
  '    public static ContosoRentTable find() { return null; }',
  ']]></Source>',
  `${T}${T}${T}</Method>`,
  `${T}${T}</Methods>`,
  `${T}</SourceCode>`,
  `${T}<Label>@ContosoExt:Rent</Label>`,
  `${T}<TableGroup>Main</TableGroup>`,
  `${T}<TitleField1>Name</TitleField1>`,
  `${T}<PrimaryIndex>NameIdx</PrimaryIndex>`,
  `${T}<Fields>`,
  `${T}${T}<AxTableField xmlns=""`,
  `${T}${T}${T}i:type="AxTableFieldString">`,
  `${T}${T}${T}<Name>Name</Name>`,
  `${T}${T}${T}<ExtendedDataType>Name</ExtendedDataType>`,
  `${T}${T}${T}<Label>@ContosoExt:Name</Label>`,
  `${T}${T}${T}<StringSize>20</StringSize>`,
  `${T}${T}</AxTableField>`,
  `${T}${T}<AxTableField xmlns=""`,
  `${T}${T}${T}i:type="AxTableFieldEnum">`,
  `${T}${T}${T}<Name>Kind</Name>`,
  `${T}${T}${T}<EnumType>ContosoKind</EnumType>`,
  `${T}${T}</AxTableField>`,
  `${T}</Fields>`,
  `${T}<Indexes>`,
  `${T}${T}<AxTableIndex>`,
  `${T}${T}${T}<Name>NameIdx</Name>`,
  `${T}${T}${T}<AllowDuplicates>No</AllowDuplicates>`,
  `${T}${T}${T}<Fields>`,
  `${T}${T}${T}${T}<AxTableIndexField>`,
  `${T}${T}${T}${T}${T}<DataField>Name</DataField>`,
  `${T}${T}${T}${T}</AxTableIndexField>`,
  `${T}${T}${T}</Fields>`,
  `${T}${T}</AxTableIndex>`,
  `${T}</Indexes>`,
  `${T}<Relations>`,
  `${T}${T}<AxTableRelation>`,
  `${T}${T}${T}<Name>Kind</Name>`,
  `${T}${T}${T}<RelatedTable>ContosoKindTable</RelatedTable>`,
  `${T}${T}${T}<Constraints>`,
  `${T}${T}${T}${T}<AxTableRelationConstraint xmlns=""`,
  `${T}${T}${T}${T}${T}i:type="AxTableRelationConstraintField">`,
  `${T}${T}${T}${T}${T}<Name>Kind</Name>`,
  `${T}${T}${T}${T}${T}<Field>Kind</Field>`,
  `${T}${T}${T}${T}${T}<RelatedField>Kind</RelatedField>`,
  `${T}${T}${T}${T}</AxTableRelationConstraint>`,
  `${T}${T}${T}</Constraints>`,
  `${T}${T}</AxTableRelation>`,
  `${T}</Relations>`,
  '</AxTable>',
);

describe('value handling', () => {
  it('normalises strings and arrays to "A, B" without duplicates', () => {
    expect(normalizeTagsInput('ABC-1;ABC-2')).toBe('ABC-1, ABC-2');
    expect(normalizeTagsInput(['ABC-1', 'ABC-1,ABC-2'])).toBe('ABC-1, ABC-2');
    expect(normalizeTagsInput('')).toBe('');
    expect(normalizeTagsInput(undefined)).toBeUndefined();
  });

  it('combines replace / add / remove', () => {
    expect(combineTags('A', 'B', 'replace')).toBe('B');
    expect(combineTags('A, B', 'B, C', 'add')).toBe('A, B, C');
    expect(combineTags('A, B', 'a', 'remove')).toBe('B');
    expect(combineTags('A', 'A', 'remove')).toBe('');
  });
});

describe('default tag resolution', () => {
  const saved = process.env.D365FO_DEFAULT_TAG;
  afterEach(() => {
    if (saved === undefined) delete process.env.D365FO_DEFAULT_TAG;
    else process.env.D365FO_DEFAULT_TAG = saved;
  });

  it('writes nothing when neither an argument nor a default is set', () => {
    delete process.env.D365FO_DEFAULT_TAG;
    expect(resolveTagsToWrite(undefined)).toEqual({ source: 'none' });
  });

  it('uses the instance default when no tags are passed', () => {
    process.env.D365FO_DEFAULT_TAG = ' ABC-9 ';
    expect(resolveTagsToWrite(undefined)).toEqual({ tags: 'ABC-9', source: 'default' });
  });

  it('lets an explicit tag win and tags="" opt out', () => {
    process.env.D365FO_DEFAULT_TAG = 'ABC-9';
    expect(resolveTagsToWrite('ABC-1')).toEqual({ tags: 'ABC-1', source: 'explicit' });
    expect(resolveTagsToWrite('')).toEqual({ source: 'opt-out' });
  });
});

describe('object-level position', () => {
  it('AxTable: after TableGroup, before TitleField1, with the other scalars and collections undisturbed', () => {
    const r = setObjectTags(table, 'ABC-1');
    expect(r.ok && r.changed).toBe(true);
    expect(r.xml).toContain(`${T}<TableGroup>Main</TableGroup>\r\n${T}<Tags>ABC-1</Tags>\r\n${T}<TitleField1>`);
    expect(r.xml.split('<Tags>').length).toBe(2);
    expect(r.xml.replace(`${T}<Tags>ABC-1</Tags>\r\n`, '')).toBe(table);
    expect(readObjectTags(r.xml)).toBe('ABC-1');
  });

  it('keeps LF files LF', () => {
    const lf = table.replace(/\r\n/g, '\n');
    const r = setObjectTags(lf, 'ABC-1');
    expect(r.xml).not.toContain('\r');
    expect(r.xml).toContain(`${T}<Tags>ABC-1</Tags>\n`);
  });

  it('replaces, adds to and removes', () => {
    const one = setObjectTags(table, 'ABC-1').xml;
    expect(readObjectTags(setObjectTags(one, 'ABC-2').xml)).toBe('ABC-2');
    expect(readObjectTags(setObjectTags(one, 'ABC-2', 'add').xml)).toBe('ABC-1, ABC-2');
    expect(setObjectTags(one, 'ABC-1', 'remove').xml).toBe(table);
    expect(setObjectTags(one, null).xml).toBe(table);
    const again = setObjectTags(one, 'ABC-1');
    expect(again.changed).toBe(false);
  });

  it('escapes the value', () => {
    expect(setObjectTags(table, 'A&B').xml).toContain('<Tags>A&amp;B</Tags>');
  });

  const root = (name: string, ...body: string[]) =>
    lines(`<${name} xmlns:i="http://www.w3.org/2001/XMLSchema-instance">`, `${T}<Name>ContosoX</Name>`, ...body.map(b => `${T}${b}`), `</${name}>`);

  const cases: Array<[string, string[], string]> = [
    ['AxEnum', ['<Label>@ContosoExt:A</Label>', '<UseEnumValue>No</UseEnumValue>', '<EnumValues />'], '<UseEnumValue>'],
    ['AxEdt', ['<Extends>Name</Extends>', '<ReferenceTable>ContosoT</ReferenceTable>', '<ArrayElements />'], '<ArrayElements'],
    ['AxMenu', ['<Label>@ContosoExt:A</Label>', '<Elements />'], '<Elements'],
    ['AxSecurityPrivilege', ['<Label>@ContosoExt:A</Label>', '<EntryPoints />'], '<EntryPoints'],
    ['AxSecurityDuty', ['<Label>@ContosoExt:A</Label>', '<Privileges />'], '<Privileges'],
    ['AxView', ['<Label>@ContosoExt:A</Label>', '<Query>ContosoQ</Query>', '<Fields />'], '<Query>'],
    ['AxDataEntityView', ['<Label>@ContosoExt:A</Label>', '<DataManagementEnabled>Yes</DataManagementEnabled>', '<Fields />'], '<DataManagementEnabled>'],
    ['AxServiceGroup', ['<AutoDeploy>Yes</AutoDeploy>', '<Services />'], '<Services'],
    ['AxTableExtension', ['<Fields />'], '<Fields'],
    ['AxMenuExtension', ['<Customizations />', '<Elements />'], '<Customizations'],
    ['AxEdtExtension', ['<IsObsolete>No</IsObsolete>', '<Visibility>Public</Visibility>', '<PropertyModifications />'], '<Visibility>'],
    ['AxMenuItemDisplay', ['<Label>@ContosoExt:A</Label>', '<Object>ContosoForm</Object>'], null as unknown as string],
  ];
  it.each(cases)('%s: Tags goes before the first later scalar or collection', (name, body, before) => {
    const xml = root(name, ...body);
    const r = setObjectTags(xml, 'ABC-1');
    expect(r.ok).toBe(true);
    const tagsAt = pos(r.xml, '<Tags>');
    expect(tagsAt).toBeGreaterThan(pos(r.xml, '<Name>'));
    if (before) expect(tagsAt).toBeLessThan(pos(r.xml, before));
    else expect(tagsAt).toBeGreaterThan(pos(r.xml, '<Object>'));
    // a second pass leaves it alone and a removal restores the original
    expect(setObjectTags(r.xml, 'ABC-1').changed).toBe(false);
    expect(setObjectTags(r.xml, null).xml).toBe(xml);
  });

  it('AxClass: after SourceCode', () => {
    const xml = root('AxClass', '<SourceCode>', `${T}<Declaration><![CDATA[class ContosoX { }]]></Declaration>`, `${T}<Methods />`, '</SourceCode>');
    const r = setObjectTags(xml, 'ABC-1');
    expect(r.xml).toContain(`${T}</SourceCode>\r\n${T}<Tags>ABC-1</Tags>\r\n</AxClass>`);
  });

  it('AxForm and AxMap: after SourceCode, before the collections', () => {
    const form = root('AxForm', '<SourceCode>', `${T}<Methods />`, '</SourceCode>', '<DataSources />', '<Design />');
    const r = setObjectTags(form, 'ABC-1').xml;
    expect(pos(r, '<Tags>')).toBeGreaterThan(pos(r, '</SourceCode>'));
    expect(pos(r, '<Tags>')).toBeLessThan(pos(r, '<DataSources'));
  });

  it('AxEnumExtension: before PropertyModifications, after EnumValues', () => {
    const xml = root('AxEnumExtension', '<EnumValues />', '<PropertyModifications />');
    const r = setObjectTags(xml, 'ABC-1').xml;
    expect(pos(r, '<Tags>')).toBeGreaterThan(pos(r, '<EnumValues'));
    expect(pos(r, '<Tags>')).toBeLessThan(pos(r, '<PropertyModifications'));
  });

  it('refuses an object type whose position is not known', () => {
    const r = setObjectTags(root('AxReport', '<Label>x</Label>'), 'ABC-1');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^unsupported/);
  });
});

describe('element-level', () => {
  it('field: after Label / StringSize in element order, before EnumType', () => {
    const str = setElementTags(table, 'field', 'Name', 'ABC-1').xml;
    const block = str.slice(pos(str, '<Name>Name</Name>'), pos(str, '</AxTableField>'));
    expect(block.indexOf('<StringSize>')).toBeLessThan(block.indexOf('<Tags>'));
    const en = setElementTags(table, 'field', 'Kind', 'ABC-1').xml;
    expect(en.indexOf('<Tags>ABC-1</Tags>')).toBeLessThan(en.indexOf('<EnumType>'));
    expect(readElementTags(en, 'field', 'Kind')).toBe('ABC-1');
    expect(readElementTags(en, 'field', 'Name')).toBeUndefined();
    expect(setElementTags(en, 'field', 'Kind', null).xml).toBe(table);
  });

  it('index: before its Fields collection, after AllowDuplicates', () => {
    const r = setElementTags(table, 'index', 'NameIdx', 'ABC-1').xml;
    expect(r).toContain(`<AllowDuplicates>No</AllowDuplicates>\r\n${T}${T}${T}<Tags>ABC-1</Tags>\r\n${T}${T}${T}<Fields>`);
  });

  it('relation: before Constraints; constraint: right after Name', () => {
    const rel = setElementTags(table, 'relation', 'Kind', 'ABC-1').xml;
    expect(rel).toContain(`<RelatedTable>ContosoKindTable</RelatedTable>\r\n${T}${T}${T}<Tags>ABC-1</Tags>\r\n${T}${T}${T}<Constraints>`);
    const con = setElementTags(table, 'constraint', 'Kind', 'ABC-1', 'replace', 'Kind').xml;
    expect(con).toContain(`<Name>Kind</Name>\r\n${T}${T}${T}${T}${T}<Tags>ABC-1</Tags>\r\n${T}${T}${T}${T}${T}<Field>`);
  });

  it('method: after Source', () => {
    const r = setElementTags(table, 'method', 'find', 'ABC-1').xml;
    expect(r).toContain(`]]></Source>\r\n${T}${T}${T}${T}<Tags>ABC-1</Tags>\r\n${T}${T}${T}</Method>`);
  });

  it('enum value: after Label, before Value', () => {
    const en = lines(
      '<AxEnum xmlns:i="http://www.w3.org/2001/XMLSchema-instance">',
      `${T}<Name>ContosoKind</Name>`,
      `${T}<EnumValues>`,
      `${T}${T}<AxEnumValue>`,
      `${T}${T}${T}<Name>A</Name>`,
      `${T}${T}${T}<Label>@ContosoExt:A</Label>`,
      `${T}${T}${T}<Value>1</Value>`,
      `${T}${T}</AxEnumValue>`,
      `${T}</EnumValues>`,
      '</AxEnum>',
    );
    const r = setElementTags(en, 'enum-value', 'A', 'ABC-1').xml;
    expect(r).toContain(`<Label>@ContosoExt:A</Label>\r\n${T}${T}${T}<Tags>ABC-1</Tags>\r\n${T}${T}${T}<Value>1</Value>`);
  });

  it('reports a missing element instead of writing', () => {
    const r = setElementTags(table, 'field', 'Nope', 'ABC-1');
    expect(r.ok).toBe(false);
    expect(r.xml).toBe(table);
  });
});
