/**
 * remove-field leaves nothing in the field groups pointing at the removed field,
 * and names what else in the file still does.
 *
 * The bridge's RemoveField takes the field out of <Fields> only. Every
 * <AxTableFieldGroupField> naming it stayed behind, so the table referenced a
 * field that no longer existed and the next build failed on the field group.
 *
 * Pinned here: group entries go (own groups and, on a table extension, the
 * extensions of base table groups), an index and a relation are reported and
 * left byte-for-byte alone, names match in any letter case, and the file keeps
 * the CRLF shape the other direct XML writers give it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { cleanRemovedFieldReferences, renderRemovedFieldCleanup } from '../../src/tools/xml/tableFieldRemoval';
import { directXmlCleanRemovedFieldReferences } from '../../src/tools/write/directXmlWriters';

/** A table as it reads AFTER the bridge removed the field `Colour` from <Fields>. */
const TABLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ContosoRentEquipmentTable</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ContosoRentEquipmentTable extends common
{
    // <DataField>Colour</DataField> in a comment is not metadata
}
]]></Declaration>
\t\t<Methods />
\t</SourceCode>
\t<TitleField1>EquipmentId</TitleField1>
\t<TitleField2>Colour</TitleField2>
\t<PrimaryIndex>EquipmentIdx</PrimaryIndex>
\t<ReplacementKey>EquipmentIdx</ReplacementKey>
\t<DeleteActions />
\t<FieldGroups>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoReport</Name>
\t\t\t<Fields>
\t\t\t\t<AxTableFieldGroupField>
\t\t\t\t\t<DataField>EquipmentId</DataField>
\t\t\t\t</AxTableFieldGroupField>
\t\t\t\t<AxTableFieldGroupField>
\t\t\t\t\t<DataField>Colour</DataField>
\t\t\t\t</AxTableFieldGroupField>
\t\t\t</Fields>
\t\t</AxTableFieldGroup>
\t\t<AxTableFieldGroup>
\t\t\t<Name>Appearance</Name>
\t\t\t<Label>@SYS1</Label>
\t\t\t<Fields>
\t\t\t\t<AxTableFieldGroupField>
\t\t\t\t\t<DataField>Colour</DataField>
\t\t\t\t</AxTableFieldGroupField>
\t\t\t</Fields>
\t\t</AxTableFieldGroup>
\t\t<AxTableFieldGroup>
\t\t\t<Name>Colour</Name>
\t\t\t<Fields>
\t\t\t\t<AxTableFieldGroupField>
\t\t\t\t\t<DataField>EquipmentId</DataField>
\t\t\t\t</AxTableFieldGroupField>
\t\t\t</Fields>
\t\t</AxTableFieldGroup>
\t</FieldGroups>
\t<Fields>
\t\t<AxTableField xmlns="" i:type="AxTableFieldString">
\t\t\t<Name>EquipmentId</Name>
\t\t\t<ExtendedDataType>Num</ExtendedDataType>
\t\t</AxTableField>
\t</Fields>
\t<FullTextIndexes />
\t<Indexes>
\t\t<AxTableIndex>
\t\t\t<Name>EquipmentIdx</Name>
\t\t\t<AlternateKey>Yes</AlternateKey>
\t\t\t<Fields>
\t\t\t\t<AxTableIndexField>
\t\t\t\t\t<DataField>EquipmentId</DataField>
\t\t\t\t</AxTableIndexField>
\t\t\t\t<AxTableIndexField>
\t\t\t\t\t<DataField>Colour</DataField>
\t\t\t\t</AxTableIndexField>
\t\t\t</Fields>
\t\t</AxTableIndex>
\t</Indexes>
\t<Mappings />
\t<Relations>
\t\t<AxTableRelation>
\t\t\t<Name>ContosoColourTable</Name>
\t\t\t<RelatedTable>ContosoColourTable</RelatedTable>
\t\t\t<Constraints>
\t\t\t\t<AxTableRelationConstraint xmlns="" i:type="AxTableRelationConstraintField">
\t\t\t\t\t<Name>Colour</Name>
\t\t\t\t\t<Field>Colour</Field>
\t\t\t\t\t<RelatedField>Colour</RelatedField>
\t\t\t\t</AxTableRelationConstraint>
\t\t\t</Constraints>
\t\t</AxTableRelation>
\t</Relations>
\t<StateMachines />
</AxTable>`;

/** The same table with the field in two groups and nowhere else. */
const GROUPS_ONLY_XML = TABLE_XML
  .replace('\t<TitleField2>Colour</TitleField2>\n', '')
  .replace(/\t\t\t\t<AxTableIndexField>\n\t\t\t\t\t<DataField>Colour<\/DataField>\n\t\t\t\t<\/AxTableIndexField>\n/, '')
  .replace(/\t<Relations>[\s\S]*<\/Relations>/, '\t<Relations />');

/** A table extension AFTER the bridge removed its own field `ContosoColour`. */
const EXTENSION_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTableExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>CustTable.ContosoExt</Name>
\t<FieldGroupExtensions>
\t\t<AxTableFieldGroupExtension>
\t\t\t<Name>AutoReport</Name>
\t\t\t<Fields>
\t\t\t\t<AxTableFieldGroupField>
\t\t\t\t\t<DataField>ContosoColour</DataField>
\t\t\t\t</AxTableFieldGroupField>
\t\t\t\t<AxTableFieldGroupField>
\t\t\t\t\t<DataField>ContosoSize</DataField>
\t\t\t\t</AxTableFieldGroupField>
\t\t\t</Fields>
\t\t</AxTableFieldGroupExtension>
\t</FieldGroupExtensions>
\t<FieldGroups>
\t\t<AxTableFieldGroup>
\t\t\t<Name>ContosoAppearance</Name>
\t\t\t<Fields>
\t\t\t\t<AxTableFieldGroupField>
\t\t\t\t\t<DataField>ContosoColour</DataField>
\t\t\t\t</AxTableFieldGroupField>
\t\t\t</Fields>
\t\t</AxTableFieldGroup>
\t</FieldGroups>
\t<FieldModifications />
\t<Fields>
\t\t<AxTableField xmlns="" i:type="AxTableFieldString">
\t\t\t<Name>ContosoSize</Name>
\t\t</AxTableField>
\t</Fields>
\t<FullTextIndexes />
\t<Indexes />
\t<Mappings />
\t<PropertyModifications />
\t<RelationExtensions />
\t<RelationModifications />
\t<Relations />
</AxTableExtension>`;

const between = (xml: string, open: string, close: string) =>
  xml.slice(xml.indexOf(open), xml.indexOf(close) + close.length);

describe('cleanRemovedFieldReferences', () => {
  it('removes the field from both groups it was in and keeps the other entries', () => {
    const r = cleanRemovedFieldReferences(GROUPS_ONLY_XML, 'Colour')!;
    expect(r.removedFromGroups).toEqual(['AutoReport', 'Appearance']);
    expect(r.remaining).toEqual([]);
    expect(r.xml).not.toContain('<DataField>Colour</DataField>\n\t\t\t\t</AxTableFieldGroupField>');
    // The sibling entry and the group named like the field are untouched.
    expect(r.xml).toContain(
      '\t\t\t<Name>AutoReport</Name>\n\t\t\t<Fields>\n\t\t\t\t<AxTableFieldGroupField>\n' +
      '\t\t\t\t\t<DataField>EquipmentId</DataField>\n\t\t\t\t</AxTableFieldGroupField>\n\t\t\t</Fields>',
    );
    expect(r.xml).toContain('<Name>Colour</Name>');
    // A group left with no field is written the way the serializer writes it.
    expect(r.xml).toContain('\t\t\t<Label>@SYS1</Label>\n\t\t\t<Fields />\n\t\t</AxTableFieldGroup>');
    // Text inside CDATA is source code, not a reference.
    expect(r.xml).toContain('// <DataField>Colour</DataField> in a comment is not metadata');
  });

  it('reports an index, a relation and a title field, and leaves them as they were', () => {
    const r = cleanRemovedFieldReferences(TABLE_XML, 'Colour')!;
    expect(r.removedFromGroups).toEqual(['AutoReport', 'Appearance']);
    expect(r.remaining.map(x => x.kind)).toEqual(['index', 'property', 'relation']);
    expect(r.remaining[0].what).toBe(
      "index 'EquipmentIdx' has it as a field (the index is the table's PrimaryIndex and ReplacementKey)",
    );
    expect(r.remaining[0].fix).toContain('operation="remove-index"');
    expect(r.remaining[1].what).toBe('table property TitleField2 is set to it');
    expect(r.remaining[2].what).toBe("relation 'ContosoColourTable' has a constraint on it");
    expect(r.remaining[2].fix).toContain('operation="remove-relation"');

    expect(between(r.xml, '<Indexes>', '</Indexes>')).toBe(between(TABLE_XML, '<Indexes>', '</Indexes>'));
    expect(between(r.xml, '<Relations>', '</Relations>')).toBe(between(TABLE_XML, '<Relations>', '</Relations>'));
    expect(r.xml).toContain('<TitleField2>Colour</TitleField2>');

    const text = renderRemovedFieldCleanup('Colour', r);
    expect(text).toContain("Also removed 'Colour' from field groups AutoReport, Appearance");
    expect(text).toContain("index 'EquipmentIdx' has it as a field");
    expect(text).toContain("relation 'ContosoColourTable' has a constraint on it");
    expect(text).toContain('Nothing below was changed');
  });

  it('cleans a table extension: its own group and the extension of a base table group', () => {
    const r = cleanRemovedFieldReferences(EXTENSION_XML, 'ContosoColour')!;
    expect(r.removedFromGroups).toEqual(['AutoReport (extension of a base table group)', 'ContosoAppearance']);
    expect(r.remaining).toEqual([]);
    expect(r.xml).not.toContain('ContosoColour');
    expect(r.xml).toContain('<DataField>ContosoSize</DataField>');
    expect(r.xml).toContain('\t\t\t<Name>ContosoAppearance</Name>\n\t\t\t<Fields />');
  });

  it('matches the field name in any letter case', () => {
    const r = cleanRemovedFieldReferences(GROUPS_ONLY_XML, 'COLOUR')!;
    expect(r.removedFromGroups).toEqual(['AutoReport', 'Appearance']);
    expect(r.xml).not.toMatch(/<DataField>Colour<\/DataField>\s*<\/AxTableFieldGroupField>/);
  });

  it('a field in no group and referenced nowhere changes nothing and says nothing', () => {
    const r = cleanRemovedFieldReferences(GROUPS_ONLY_XML, 'Weight')!;
    expect(r.xml).toBe(GROUPS_ONLY_XML);
    expect(r.removedFromGroups).toEqual([]);
    expect(renderRemovedFieldCleanup('Weight', r)).toBe('');
  });

  it('touches nothing while the file still defines the field', () => {
    // EquipmentId is still in <Fields>: the removal did not land, so its group
    // entries are not dangling.
    expect(cleanRemovedFieldReferences(TABLE_XML, 'EquipmentId')).toBeNull();
    expect(cleanRemovedFieldReferences(TABLE_XML, 'equipmentid')).toBeNull();
  });

  it('is not for anything but a table or table extension', () => {
    expect(cleanRemovedFieldReferences('<AxForm><Name>ContosoForm</Name></AxForm>', 'Colour')).toBeNull();
  });
});

describe('directXmlCleanRemovedFieldReferences', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remove-field-'));
    file = path.join(dir, 'ContosoRentEquipmentTable.xml');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a CRLF file stays CRLF and only the group entries change', async () => {
    const crlf = TABLE_XML.replace(/\n/g, '\r\n');
    await fs.writeFile(file, crlf, 'utf-8');

    const result = await directXmlCleanRemovedFieldReferences(file, 'colour');
    expect(result!.removedFromGroups).toEqual(['AutoReport', 'Appearance']);
    expect(result!.message).toContain("index 'EquipmentIdx'");

    const after = await fs.readFile(file, 'utf-8');
    expect(after).not.toMatch(/[^\r]\n/);
    expect(after).toBe(cleanRemovedFieldReferences(crlf, 'Colour')!.xml);
    expect(between(after, '<Indexes>', '</Indexes>')).toBe(between(crlf, '<Indexes>', '</Indexes>'));
    expect(between(after, '<Relations>', '</Relations>')).toBe(between(crlf, '<Relations>', '</Relations>'));
  });

  it('does not rewrite the file when the field was in no group', async () => {
    const original = '﻿' + GROUPS_ONLY_XML;
    await fs.writeFile(file, original, 'utf-8');
    expect(await directXmlCleanRemovedFieldReferences(file, 'Weight')).toBeNull();
    expect(await fs.readFile(file, 'utf-8')).toBe(original);
  });

  it('reports without writing when only an index and a relation name the field', async () => {
    const onlyOthers = TABLE_XML.replace(/\t<FieldGroups>[\s\S]*<\/FieldGroups>/, '\t<FieldGroups />');
    await fs.writeFile(file, onlyOthers, 'utf-8');
    const result = await directXmlCleanRemovedFieldReferences(file, 'Colour');
    expect(result!.removedFromGroups).toEqual([]);
    expect(result!.message).not.toContain('Also removed');
    expect(result!.message).toContain("relation 'ContosoColourTable'");
    expect(await fs.readFile(file, 'utf-8')).toBe(onlyOthers);
  });

  it('a missing file is not an error', async () => {
    expect(await directXmlCleanRemovedFieldReferences(path.join(dir, 'Nope.xml'), 'Colour')).toBeNull();
  });
});
