/**
 * BP-clean defaults on create: the properties and structure xppbp asks for on a
 * new table or menu item, written by d365fo_file(action="create") and
 * generate_object(mode="scaffold") so a new object starts with no warnings.
 *
 * Each expected value is the one the checker names in its own message (see
 * src/utils/bpCreateDefaults.ts and src/tools/xml/tableBpDefaults.ts).
 */

import { describe, it, expect } from 'vitest';
import {
  FULL_ACCESS,
  NO_ACCESS,
  expectedMenuItemBpDefaults,
  expectedTableBpDefaults,
  menuItemKindOf,
  tableBpInputsFromXml,
} from '../../src/utils/bpCreateDefaults';
import { applyMenuItemBpDefaults, renderMenuItemBpNote } from '../../src/tools/xml/menuItemBpDefaults';
import { applyTableBpDefaults, relationOnDeleteFromSpecs } from '../../src/tools/xml/tableBpDefaults';
import { edtRelationFromXml, fieldEdtNames, resolveEdtRelations } from '../../src/tools/xml/edtRelationResolver';
import { reconcileTableCreateProperties, renderTableCreateHonestyReport } from '../../src/tools/xml/createTablePropertyHonesty';
import { buildAxTableXml } from '../../src/tools/xml/tableXml';
import { SmartXmlBuilder } from '../../src/utils/smartXmlBuilder';
import { parseSubscriberAccessLevel, readSubscriberAccessLevel } from '../../src/utils/subscriberAccessLevel';
import { XmlTemplateGenerator } from '../../src/tools/xml/xmlTemplateGenerator';

const ALL_DENY = '\t\t<Correct>Deny</Correct>\n\t\t<Create>Deny</Create>\n\t\t<Delete>Deny</Delete>\n' +
  '\t\t<Invoke>Deny</Invoke>\n\t\t<Read>Deny</Read>\n\t\t<Update>Deny</Update>\n';

/** Top-level element names of a document, in order (one level below the root). */
function topLevelOrder(xml: string): string[] {
  return [...xml.matchAll(/^\t<(\w+)[\s/>]/gm)].map(m => m[1]);
}

// ── Rule tables ─────────────────────────────────────────────────────────────

describe('expectedTableBpDefaults', () => {
  it('Company + Read when SaveDataPerCompany is Yes or absent', () => {
    for (const saveDataPerCompany of [undefined, 'Yes']) {
      const d = expectedTableBpDefaults({ saveDataPerCompany });
      expect(d.operationalDomain).toBe('Company');
      expect(d.subscriberAccessLevel).toEqual({ Read: 'Allow' });
      expect(d.reason).toBe('SaveDataPerCompany is Yes');
    }
  });

  it('Shared + Read when SaveDataPerCompany is No', () => {
    const d = expectedTableBpDefaults({ saveDataPerCompany: 'No' });
    expect(d.operationalDomain).toBe('Shared');
    expect(d.subscriberAccessLevel).toEqual({ Read: 'Allow' });
  });

  it('Local + No Access on TempDB and InMemory', () => {
    for (const tableType of ['TempDB', 'InMemory']) {
      const d = expectedTableBpDefaults({ tableType, saveDataPerCompany: 'Yes' });
      expect(d.operationalDomain).toBe('Local');
      expect(d.subscriberAccessLevel).toEqual(NO_ACCESS);
      expect(d.reason).toBe(`TableType is ${tableType}`);
    }
  });

  it('Local + No Access on a Staging table, even with SaveDataPerCompany No', () => {
    const d = expectedTableBpDefaults({ tableGroup: 'Staging', saveDataPerCompany: 'No' });
    expect(d.operationalDomain).toBe('Local');
    expect(d.subscriberAccessLevel).toEqual(NO_ACCESS);
    expect(d.reason).toBe('TableGroup is Staging');
  });

  it('reads its inputs from the table property block only', () => {
    const xml = '<AxTable>\n\t<Name>T</Name>\n\t<TableGroup>Staging</TableGroup>\n\t<SaveDataPerCompany>No</SaveDataPerCompany>\n' +
      '\t<Fields>\n\t\t<AxTableField>\n\t\t\t<TableType>TempDB</TableType>\n\t\t</AxTableField>\n\t</Fields>\n</AxTable>';
    expect(tableBpInputsFromXml(xml)).toEqual({ tableType: undefined, tableGroup: 'Staging', saveDataPerCompany: 'No' });
  });
});

describe('expectedMenuItemBpDefaults', () => {
  it('Action with ObjectType Class: No Access (the checker\'s Unexpected rule) and Local', () => {
    const d = expectedMenuItemBpDefaults('Action', 'Class');
    expect(d.subscriberAccessLevel).toEqual(NO_ACCESS);
    expect(d.operationalDomain).toBe('Local');
    expect(d.reason).toBe('the menu item type is Action and ObjectType is Class');
  });

  it('Display with ObjectType Class: every permission allowed', () => {
    expect(expectedMenuItemBpDefaults('Display', 'Class').subscriberAccessLevel).toEqual(FULL_ACCESS);
  });

  it('Display on a form (no ObjectType) and Output: Read and Shared', () => {
    for (const [kind, ot] of [['Display', undefined], ['Output', 'SSRSReport'], ['Output', 'Class']] as const) {
      const d = expectedMenuItemBpDefaults(kind, ot);
      expect(d.subscriberAccessLevel).toEqual({ Read: 'Allow' });
      expect(d.operationalDomain).toBe('Shared');
    }
  });

  it('maps root elements and objectType names to a kind', () => {
    expect(menuItemKindOf('AxMenuItemAction')).toBe('Action');
    expect(menuItemKindOf('menu-item-display')).toBe('Display');
    expect(menuItemKindOf('menu-item-output-extension')).toBeUndefined();
    expect(menuItemKindOf('table')).toBeUndefined();
  });
});

describe('parseSubscriberAccessLevel("No Access")', () => {
  it('is every permission denied', () => {
    expect(parseSubscriberAccessLevel('No Access')).toEqual({ ok: true, level: NO_ACCESS });
    expect(parseSubscriberAccessLevel('noaccess')).toEqual({ ok: true, level: NO_ACCESS });
  });
});

// ── Menu items ──────────────────────────────────────────────────────────────

describe('applyMenuItemBpDefaults', () => {
  const action = XmlTemplateGenerator.generateAxMenuItemXml('menu-item-action', 'ContosoRentPost', {
    label: '@ContosoExt:Post', targetObject: 'ContosoRentPostController',
  });

  it('gives an Action/Class item Local and No Access, in alphabetical position, children out of the root namespace', () => {
    const r = applyMenuItemBpDefaults(action);
    expect(r.xml).toContain('\t<OperationalDomain>Local</OperationalDomain>\n');
    expect(r.xml).toContain(`\t<SubscriberAccessLevel>\n${ALL_DENY.replace(/<(\w+)>/g, '<$1 xmlns="">')}\t</SubscriberAccessLevel>\n`);
    expect(topLevelOrder(r.xml)).toEqual(['Name', 'Label', 'Object', 'ObjectType', 'OperationalDomain', 'SubscriberAccessLevel']);
    expect(r.reason).toBe('the menu item type is Action and ObjectType is Class');
    expect(renderMenuItemBpNote(r)).toContain('OperationalDomain=Local');
  });

  it('gives a Display item on a form Shared and Read=Allow', () => {
    const display = XmlTemplateGenerator.generateAxMenuItemXml('menu-item-display', 'ContosoRentTable', { label: '@ContosoExt:Rent' });
    const r = applyMenuItemBpDefaults(display);
    expect(r.xml).toContain('<OperationalDomain>Shared</OperationalDomain>');
    expect(r.xml).toContain('\t<SubscriberAccessLevel>\n\t\t<Read xmlns="">Allow</Read>\n\t</SubscriberAccessLevel>\n');
    expect(topLevelOrder(r.xml)).toEqual(['Name', 'Label', 'Object', 'OperationalDomain', 'SubscriberAccessLevel']);
  });

  it('puts the elements before a sibling that sorts after them', () => {
    const xml = action.replace('</AxMenuItemAction>', '\t<ViewUserLicense>Universal</ViewUserLicense>\n</AxMenuItemAction>');
    expect(topLevelOrder(applyMenuItemBpDefaults(xml).xml).slice(-3)).toEqual(['OperationalDomain', 'SubscriberAccessLevel', 'ViewUserLicense']);
  });

  it('writes the caller\'s values instead of the defaults', () => {
    const r = applyMenuItemBpDefaults(action, { operationalDomain: 'company', subscriberAccessLevel: 'Read=Deny' });
    expect(r.xml).toContain('<OperationalDomain>Company</OperationalDomain>');
    expect(r.xml).toContain('<Read xmlns="">Deny</Read>');
    expect(r.xml).not.toContain('<Create');
    expect(r.reason).toBeUndefined();
  });

  it('reports an invalid OperationalDomain and writes the default', () => {
    const r = applyMenuItemBpDefaults(action, { operationalDomain: 'Global' });
    expect(r.xml).toContain('<OperationalDomain>Local</OperationalDomain>');
    expect(r.unhonoured[0]).toContain('operationalDomain=Global');
  });

  it('leaves values already in the document when the caller passed none', () => {
    const xml = action.replace('</AxMenuItemAction>', '\t<OperationalDomain>Company</OperationalDomain>\n</AxMenuItemAction>');
    const r = applyMenuItemBpDefaults(xml);
    expect(r.xml).toContain('<OperationalDomain>Company</OperationalDomain>');
    expect(r.applied).toEqual(['SubscriberAccessLevel=Correct=Deny, Create=Deny, Delete=Deny, Invoke=Deny, Read=Deny, Update=Deny']);
  });

  it('is idempotent and keeps CRLF line endings', () => {
    const crlf = action.replace(/\n/g, '\r\n');
    const once = applyMenuItemBpDefaults(crlf).xml;
    expect(once).not.toMatch(/[^\r]\n/);
    expect(applyMenuItemBpDefaults(once).xml).toBe(once);
  });

  it('leaves anything that is not a menu item alone', () => {
    const xml = '<AxTable>\n\t<Name>T</Name>\n</AxTable>';
    expect(applyMenuItemBpDefaults(xml).xml).toBe(xml);
  });
});

// ── Tables: OperationalDomain and SubscriberAccessLevel ────────────────────

/** A table as the bridge's create writes it: VS's Read=Allow, no OperationalDomain. */
const bridgeTable = (props: string, collections = '') =>
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n' +
  '\t<Name>ContosoRentLine</Name>\n' +
  '\t<SourceCode>\n\t\t<Declaration><![CDATA[\npublic class ContosoRentLine extends common\n{\n}\n]]></Declaration>\n\t\t<Methods />\n\t</SourceCode>\n' +
  '\t<Label>@ContosoExt:RentLine</Label>\n' +
  '\t<SubscriberAccessLevel>\n\t\t<Read>Allow</Read>\n\t</SubscriberAccessLevel>\n' +
  props +
  (collections || '\t<DeleteActions />\n\t<FieldGroups />\n\t<Fields />\n\t<FullTextIndexes />\n\t<Indexes />\n\t<Mappings />\n\t<Relations />\n\t<StateMachines />\n') +
  '</AxTable>\n';

describe('table create reconcile: OperationalDomain and SubscriberAccessLevel', () => {
  it('writes OperationalDomain Company between Label and SubscriberAccessLevel', () => {
    const r = reconcileTableCreateProperties(bridgeTable('\t<TableGroup>Main</TableGroup>\n'), undefined);
    expect(topLevelOrder(r.xml).slice(0, 5)).toEqual(['Name', 'SourceCode', 'Label', 'OperationalDomain', 'SubscriberAccessLevel']);
    expect(r.xml).toContain('<OperationalDomain>Company</OperationalDomain>');
    expect(readSubscriberAccessLevel(r.xml)).toEqual({ Read: 'Allow' });
    expect(renderTableCreateHonestyReport(r)).toContain('OperationalDomain=Company (xppbp expects it because SaveDataPerCompany is Yes)');
  });

  it('Shared when SaveDataPerCompany is No', () => {
    const r = reconcileTableCreateProperties(bridgeTable('\t<TableGroup>Main</TableGroup>\n\t<SaveDataPerCompany>No</SaveDataPerCompany>\n'), undefined);
    expect(r.xml).toContain('<OperationalDomain>Shared</OperationalDomain>');
  });

  it('replaces the writer\'s Read=Allow with No Access on a TempDB table and sets Local', () => {
    const r = reconcileTableCreateProperties(bridgeTable('\t<TableType>TempDB</TableType>\n'), undefined);
    expect(r.xml).toContain('<OperationalDomain>Local</OperationalDomain>');
    expect(readSubscriberAccessLevel(r.xml)).toEqual(NO_ACCESS);
    expect(r.xml).toContain(`\t<SubscriberAccessLevel>\n${ALL_DENY}\t</SubscriberAccessLevel>\n`);
  });

  it('a caller\'s TableGroup=Staging decides the defaults (applied after the caller\'s scalars)', () => {
    const r = reconcileTableCreateProperties(bridgeTable(''), { tableGroup: 'Staging', saveDataPerCompany: false });
    expect(r.xml).toContain('<TableGroup>Staging</TableGroup>');
    expect(r.xml).toContain('<OperationalDomain>Local</OperationalDomain>');
    expect(readSubscriberAccessLevel(r.xml)).toEqual(NO_ACCESS);
    expect(r.unhonoured).toEqual([]);
  });

  it('writes the caller\'s OperationalDomain and validates it', () => {
    const ok = reconcileTableCreateProperties(bridgeTable('\t<TableGroup>Main</TableGroup>\n'), { operationalDomain: 'shared' });
    expect(ok.xml).toContain('<OperationalDomain>Shared</OperationalDomain>');
    const bad = reconcileTableCreateProperties(bridgeTable('\t<TableGroup>Main</TableGroup>\n'), { operationalDomain: 'Global' });
    expect(bad.xml).not.toContain('<OperationalDomain>');
    expect(bad.unhonoured[0].detail).toContain('Valid values: Company, Shared, Local');
  });

  it('keeps an access level that is not the VS default', () => {
    const xml = bridgeTable('\t<TableType>TempDB</TableType>\n').replace('<Read>Allow</Read>', '<Read>Allow</Read>\n\t\t<Update>Allow</Update>');
    const r = reconcileTableCreateProperties(xml, undefined);
    expect(readSubscriberAccessLevel(r.xml)).toEqual({ Read: 'Allow', Update: 'Allow' });
  });
});

describe('table writers emit the defaults themselves', () => {
  it('template: Local + No Access for a staging table, Company + Read otherwise', () => {
    const staging = buildAxTableXml('ContosoRentStaging', { tableGroup: 'Staging' });
    expect(staging).toContain('<OperationalDomain>Local</OperationalDomain>');
    expect(readSubscriberAccessLevel(staging)).toEqual(NO_ACCESS);
    const main = buildAxTableXml('ContosoRentTable', { tableGroup: 'Main' });
    expect(main).toContain('<OperationalDomain>Company</OperationalDomain>');
    expect(readSubscriberAccessLevel(main)).toEqual({ Read: 'Allow' });
    expect(topLevelOrder(main).indexOf('OperationalDomain')).toBe(topLevelOrder(main).indexOf('Label') + 1);
  });

  it('SmartXmlBuilder: Local + No Access on TempDB, no parent-pointing delete actions, OnDelete on relations', () => {
    const xml = new SmartXmlBuilder().buildTableXml({
      name: 'ContosoRentTmp',
      tableType: 'TempDB',
      fields: [{ name: 'ItemId', edt: 'ItemId' }],
      relations: [{ name: 'InventTable', targetTable: 'InventTable', constraints: [{ field: 'ItemId', relatedField: 'ItemId' }] }],
    } as any);
    expect(xml).toContain('<OperationalDomain>Local</OperationalDomain>');
    expect(readSubscriberAccessLevel(xml)).toEqual(NO_ACCESS);
    expect(xml).toContain('\t<DeleteActions />');
    expect(xml).toContain('<OnDelete>Restricted</OnDelete>');
  });
});

// ── Tables: structure ───────────────────────────────────────────────────────

const field = (name: string, extra = '') =>
  `\t\t<AxTableField xmlns=""\n\t\t\ti:type="AxTableFieldString">\n\t\t\t<Name>${name}</Name>\n${extra}\t\t</AxTableField>\n`;

const structuredTable = (opts: {
  props?: string;
  fields: string;
  fieldGroups?: string;
  indexes?: string;
  relations?: string;
  deleteActions?: string;
}) =>
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n' +
  '\t<Name>ContosoRentLine</Name>\n' +
  '\t<Label>@ContosoExt:RentLine</Label>\n' +
  (opts.props ?? '') +
  (opts.deleteActions ?? '\t<DeleteActions />\n') +
  (opts.fieldGroups ?? '\t<FieldGroups>\n\t\t<AxTableFieldGroup>\n\t\t\t<Name>AutoReport</Name>\n\t\t\t<Fields />\n\t\t</AxTableFieldGroup>\n\t</FieldGroups>\n') +
  `\t<Fields>\n${opts.fields}\t</Fields>\n` +
  '\t<FullTextIndexes />\n' +
  (opts.indexes ?? '\t<Indexes />\n') +
  '\t<Mappings />\n' +
  (opts.relations ?? '\t<Relations />\n') +
  '\t<StateMachines />\n' +
  '</AxTable>\n';

const index = (name: string, fields: string[], alternateKey = false) =>
  `\t\t<AxTableIndex>\n\t\t\t<Name>${name}</Name>\n` +
  (alternateKey ? '\t\t\t<AlternateKey>Yes</AlternateKey>\n' : '') +
  `\t\t\t<Fields>\n${fields.map(f => `\t\t\t\t<AxTableIndexField>\n\t\t\t\t\t<DataField>${f}</DataField>\n\t\t\t\t</AxTableIndexField>\n`).join('')}\t\t\t</Fields>\n\t\t</AxTableIndex>\n`;

/** The child lines of one field, by name. */
function fieldBody(xml: string, name: string): string {
  return new RegExp(`<Name>${name}</Name>\\n([\\s\\S]*?)\\t\\t</AxTableField>`).exec(xml)?.[1] ?? '';
}

describe('applyTableBpDefaults: key fields', () => {
  it('makes PrimaryIndex and AlternateKey fields non-editable and mandatory, in canonical element order', () => {
    const xml = structuredTable({
      props: '\t<PrimaryIndex>RentIdx</PrimaryIndex>\n',
      fields: field('RentId', '\t\t\t<ExtendedDataType>ContosoRentId</ExtendedDataType>\n') + field('LineNum') + field('Note'),
      indexes: `\t<Indexes>\n${index('RentIdx', ['RentId'])}${index('LineIdx', ['RentId', 'LineNum'], true)}${index('NoteIdx', ['Note'])}\t</Indexes>\n`,
    });
    const r = applyTableBpDefaults(xml);
    expect(fieldBody(r.xml, 'RentId')).toBe(
      '\t\t\t<AllowEdit>No</AllowEdit>\n\t\t\t<ExtendedDataType>ContosoRentId</ExtendedDataType>\n\t\t\t<Mandatory>Yes</Mandatory>\n');
    expect(fieldBody(r.xml, 'LineNum')).toBe('\t\t\t<AllowEdit>No</AllowEdit>\n\t\t\t<Mandatory>Yes</Mandatory>\n');
    expect(fieldBody(r.xml, 'Note')).toBe('');
    expect(r.notes[0]).toBe('key fields AllowEdit=No, Mandatory=Yes: RentId, LineNum');
  });

  it('keeps an explicit AllowEdit=Yes or Mandatory=No', () => {
    const xml = structuredTable({
      fields: field('RentId', '\t\t\t<AllowEdit>Yes</AllowEdit>\n\t\t\t<Mandatory>No</Mandatory>\n'),
      indexes: `\t<Indexes>\n${index('RentIdx', ['RentId'], true)}\t</Indexes>\n`,
    });
    expect(fieldBody(applyTableBpDefaults(xml).xml, 'RentId')).toBe('\t\t\t<AllowEdit>Yes</AllowEdit>\n\t\t\t<Mandatory>No</Mandatory>\n');
  });

  it('covers the staging index (the checker reported StagingIdx fields)', () => {
    const xml = structuredTable({
      props: '\t<TableGroup>Staging</TableGroup>\n\t<PrimaryIndex>StagingIdx</PrimaryIndex>\n',
      fields: field('DefinitionGroup') + field('ExecutionId') + field('RentId'),
      indexes: `\t<Indexes>\n${index('StagingIdx', ['DefinitionGroup', 'ExecutionId', 'RentId'], true)}\t</Indexes>\n`,
    });
    const out = applyTableBpDefaults(xml).xml;
    for (const f of ['DefinitionGroup', 'ExecutionId', 'RentId']) {
      expect(fieldBody(out, f)).toBe('\t\t\t<AllowEdit>No</AllowEdit>\n\t\t\t<Mandatory>Yes</Mandatory>\n');
    }
  });
});

describe('applyTableBpDefaults: field groups', () => {
  it('puts every field that is in no group into AutoReport', () => {
    const xml = structuredTable({
      fields: field('RentId') + field('Note'),
      fieldGroups: '\t<FieldGroups>\n\t\t<AxTableFieldGroup>\n\t\t\t<Name>AutoReport</Name>\n\t\t\t<Fields />\n\t\t</AxTableFieldGroup>\n' +
        '\t\t<AxTableFieldGroup>\n\t\t\t<Name>Overview</Name>\n\t\t\t<Fields>\n\t\t\t\t<AxTableFieldGroupField>\n\t\t\t\t\t<DataField>RentId</DataField>\n\t\t\t\t</AxTableFieldGroupField>\n\t\t\t</Fields>\n\t\t</AxTableFieldGroup>\n\t</FieldGroups>\n',
    });
    const r = applyTableBpDefaults(xml);
    expect(r.xml).toContain('\t\t\t<Name>AutoReport</Name>\n\t\t\t<Fields>\n\t\t\t\t<AxTableFieldGroupField>\n\t\t\t\t\t<DataField>Note</DataField>\n');
    expect(r.notes).toEqual(['added to field group AutoReport (every field needs a group): Note']);
  });

  it('creates the AutoReport group when the document has no groups at all', () => {
    const r = applyTableBpDefaults(structuredTable({ fields: field('RentId'), fieldGroups: '\t<FieldGroups />\n' }));
    expect(r.xml).toContain('\t<FieldGroups>\n\t\t<AxTableFieldGroup>\n\t\t\t<Name>AutoReport</Name>\n\t\t\t<Fields>\n');
    expect(r.xml).toContain('<DataField>RentId</DataField>');
  });

  it('fills an empty AutoReport when every field is already in a custom group', () => {
    const xml = structuredTable({
      fields: field('RentId'),
      fieldGroups: '\t<FieldGroups>\n\t\t<AxTableFieldGroup>\n\t\t\t<Name>AutoReport</Name>\n\t\t\t<Fields />\n\t\t</AxTableFieldGroup>\n' +
        '\t\t<AxTableFieldGroup>\n\t\t\t<Name>Overview</Name>\n\t\t\t<Fields>\n\t\t\t\t<AxTableFieldGroupField>\n\t\t\t\t\t<DataField>RentId</DataField>\n\t\t\t\t</AxTableFieldGroupField>\n\t\t\t</Fields>\n\t\t</AxTableFieldGroup>\n\t</FieldGroups>\n',
    });
    expect(applyTableBpDefaults(xml).notes).toEqual(['AutoReport filled so it is not empty: RentId']);
  });
});

describe('applyTableBpDefaults: EDT relations', () => {
  const edtRelations = { CustAccount: { table: 'CustTable', relatedField: 'AccountNum' }, ItemId: { table: 'InventTable', relatedField: 'ItemId' } };

  it('adds the table relation the EDT describes, named after the related table', () => {
    const xml = structuredTable({
      fields: field('CustAccount', '\t\t\t<ExtendedDataType>CustAccount</ExtendedDataType>\n\t\t\t<Mandatory>Yes</Mandatory>\n'),
    });
    const r = applyTableBpDefaults(xml, { edtRelations });
    expect(r.xml).toContain(
      '\t<Relations>\n\t\t<AxTableRelation>\n\t\t\t<Name>CustTable</Name>\n\t\t\t<Cardinality>ZeroMore</Cardinality>\n' +
      '\t\t\t<OnDelete>Restricted</OnDelete>\n\t\t\t<RelatedTable>CustTable</RelatedTable>\n' +
      '\t\t\t<RelatedTableCardinality>ExactlyOne</RelatedTableCardinality>\n\t\t\t<RelationshipType>Association</RelationshipType>\n');
    expect(r.xml).toContain('\t\t\t\t\t<Field>CustAccount</Field>\n\t\t\t\t\t<RelatedField>AccountNum</RelatedField>\n');
    expect(r.notes).toContain('table relations for EDT relations: CustAccount → CustTable.AccountNum');
  });

  it('adds it on a TempDB table too', () => {
    const xml = structuredTable({ props: '\t<TableType>TempDB</TableType>\n', fields: field('ItemId', '\t\t\t<ExtendedDataType>ItemId</ExtendedDataType>\n') });
    expect(applyTableBpDefaults(xml, { edtRelations }).xml).toContain('<RelatedTable>InventTable</RelatedTable>');
  });

  it('skips a field with IgnoreEDTRelation=Yes and a field a relation already constrains', () => {
    const existing = '\t<Relations>\n\t\t<AxTableRelation>\n\t\t\t<Name>Item</Name>\n\t\t\t<Cardinality>ZeroMore</Cardinality>\n\t\t\t<OnDelete>Cascade</OnDelete>\n' +
      '\t\t\t<RelatedTable>InventTable</RelatedTable>\n\t\t\t<RelatedTableCardinality>ZeroOne</RelatedTableCardinality>\n\t\t\t<RelationshipType>Association</RelationshipType>\n' +
      '\t\t\t<Constraints>\n\t\t\t\t<AxTableRelationConstraint xmlns=""\n\t\t\t\t\ti:type="AxTableRelationConstraintField">\n\t\t\t\t\t<Name>ItemId</Name>\n\t\t\t\t\t<Field>ItemId</Field>\n\t\t\t\t\t<RelatedField>ItemId</RelatedField>\n\t\t\t\t</AxTableRelationConstraint>\n\t\t\t</Constraints>\n\t\t</AxTableRelation>\n\t</Relations>\n';
    const xml = structuredTable({
      fields: field('ItemId', '\t\t\t<ExtendedDataType>ItemId</ExtendedDataType>\n') +
        field('CustAccount', '\t\t\t<ExtendedDataType>CustAccount</ExtendedDataType>\n\t\t\t<IgnoreEDTRelation>Yes</IgnoreEDTRelation>\n'),
      relations: existing,
    });
    const r = applyTableBpDefaults(xml, { edtRelations });
    expect(r.xml.match(/<AxTableRelation>/g)).toHaveLength(1);
    expect(r.xml).toContain('<OnDelete>Cascade</OnDelete>');
  });

  it('names the relation after the field when the table name is taken', () => {
    const xml = structuredTable({
      fields: field('ItemId', '\t\t\t<ExtendedDataType>ItemId</ExtendedDataType>\n') + field('SubstituteItemId', '\t\t\t<ExtendedDataType>ItemId</ExtendedDataType>\n'),
    });
    const out = applyTableBpDefaults(xml, { edtRelations }).xml;
    expect(out).toContain('<Name>InventTable</Name>');
    expect(out).toContain('\t\t\t<Name>SubstituteItemId</Name>\n\t\t\t<Cardinality>');
  });
});

describe('applyTableBpDefaults: relation properties and delete actions', () => {
  /** A relation as the bridge's AddRelation writes it: Name and RelatedTable only. */
  const bareRelation = (name: string, table: string, f: string) =>
    `\t\t<AxTableRelation>\n\t\t\t<Name>${name}</Name>\n\t\t\t<RelatedTable>${table}</RelatedTable>\n` +
    `\t\t\t<Constraints>\n\t\t\t\t<AxTableRelationConstraint xmlns=""\n\t\t\t\t\ti:type="AxTableRelationConstraintField">\n` +
    `\t\t\t\t\t<Name>${f}</Name>\n\t\t\t\t\t<Field>${f}</Field>\n\t\t\t\t\t<RelatedField>${f}</RelatedField>\n\t\t\t\t</AxTableRelationConstraint>\n\t\t\t</Constraints>\n\t\t</AxTableRelation>\n`;

  it('completes a bare relation: Cardinality, OnDelete, RelatedTableCardinality, RelationshipType in canonical order', () => {
    const xml = structuredTable({
      fields: field('UnitId'),
      relations: `\t<Relations>\n${bareRelation('UnitOfMeasure', 'UnitOfMeasure', 'UnitId')}\t</Relations>\n`,
    });
    const r = applyTableBpDefaults(xml);
    expect(r.xml).toContain(
      '\t\t\t<Name>UnitOfMeasure</Name>\n\t\t\t<Cardinality>ZeroMore</Cardinality>\n\t\t\t<OnDelete>Restricted</OnDelete>\n' +
      '\t\t\t<RelatedTable>UnitOfMeasure</RelatedTable>\n\t\t\t<RelatedTableCardinality>ZeroOne</RelatedTableCardinality>\n' +
      '\t\t\t<RelationshipType>Association</RelationshipType>\n\t\t\t<Constraints>');
    expect(r.notes).toContain('relation OnDelete: UnitOfMeasure=Restricted');
  });

  it('adds OnDelete to a foreign-key relation that has the rest (the case the checker flagged)', () => {
    const fk = '\t<Relations>\n\t\t<AxTableRelation xmlns=""\n\t\t\ti:type="AxTableRelationForeignKey">\n\t\t\t<Name>UnitOfMeasure</Name>\n' +
      '\t\t\t<Cardinality>ZeroMore</Cardinality>\n\t\t\t<RelatedTable>UnitOfMeasure</RelatedTable>\n\t\t\t<RelatedTableCardinality>ZeroOne</RelatedTableCardinality>\n' +
      '\t\t\t<RelationshipType>Association</RelationshipType>\n\t\t\t<Constraints />\n\t\t</AxTableRelation>\n\t</Relations>\n';
    const out = applyTableBpDefaults(structuredTable({ fields: field('UnitId'), relations: fk })).xml;
    expect(out).toContain('\t\t\t<Cardinality>ZeroMore</Cardinality>\n\t\t\t<OnDelete>Restricted</OnDelete>\n\t\t\t<RelatedTable>');
  });

  it('honours the caller\'s relations[].onDelete', () => {
    const xml = structuredTable({ fields: field('RentId'), relations: `\t<Relations>\n${bareRelation('Header', 'ContosoRentTable', 'RentId')}\t</Relations>\n` });
    const onDelete = relationOnDeleteFromSpecs([{ name: 'Header', relatedTable: 'ContosoRentTable', onDelete: 'cascade' }]);
    expect(applyTableBpDefaults(xml, { relationOnDelete: onDelete }).xml).toContain('<OnDelete>Cascade</OnDelete>');
  });

  it('removes a writer\'s parent-pointing delete action, only when asked', () => {
    const deleteActions = '\t<DeleteActions>\n\t\t<AxTableDeleteAction>\n\t\t\t<Name>InventTable</Name>\n\t\t\t<DeleteAction>Restricted</DeleteAction>\n' +
      '\t\t\t<Table>InventTable</Table>\n\t\t</AxTableDeleteAction>\n\t</DeleteActions>\n';
    const xml = structuredTable({
      fields: field('ItemId'),
      deleteActions,
      relations: `\t<Relations>\n${bareRelation('InventTable', 'InventTable', 'ItemId')}\t</Relations>\n`,
    });
    expect(applyTableBpDefaults(xml).xml).toContain('<AxTableDeleteAction>');
    const r = applyTableBpDefaults(xml, { dropWriterDeleteActions: true });
    expect(r.xml).toContain('\t<DeleteActions />\n');
    expect(r.notes.at(-1)).toContain('removed 1 delete action(s) on related parent table(s) (InventTable)');
  });

  it('keeps a delete action that names its relation', () => {
    const deleteActions = '\t<DeleteActions>\n\t\t<AxTableDeleteAction>\n\t\t\t<Name>Lines</Name>\n\t\t\t<DeleteAction>Cascade</DeleteAction>\n' +
      '\t\t\t<Relation>InventTable</Relation>\n\t\t\t<Table>InventTable</Table>\n\t\t</AxTableDeleteAction>\n\t</DeleteActions>\n';
    const xml = structuredTable({ fields: field('ItemId'), deleteActions, relations: `\t<Relations>\n${bareRelation('InventTable', 'InventTable', 'ItemId')}\t</Relations>\n` });
    expect(applyTableBpDefaults(xml, { dropWriterDeleteActions: true }).xml).toContain('<Name>Lines</Name>');
  });
});

describe('applyTableBpDefaults: document handling', () => {
  it('is idempotent', () => {
    const xml = structuredTable({
      props: '\t<PrimaryIndex>RentIdx</PrimaryIndex>\n',
      fields: field('RentId', '\t\t\t<ExtendedDataType>ItemId</ExtendedDataType>\n'),
      indexes: `\t<Indexes>\n${index('RentIdx', ['RentId'])}\t</Indexes>\n`,
    });
    const opts = { edtRelations: { ItemId: { table: 'InventTable', relatedField: 'ItemId' } } };
    const once = applyTableBpDefaults(xml, opts);
    const twice = applyTableBpDefaults(once.xml, opts);
    expect(twice.xml).toBe(once.xml);
    expect(twice.notes).toEqual([]);
  });

  it('keeps CRLF line endings', () => {
    const xml = structuredTable({ fields: field('RentId'), fieldGroups: '\t<FieldGroups />\n' }).replace(/\n/g, '\r\n');
    const out = applyTableBpDefaults(xml).xml;
    expect(out).toContain('<DataField>RentId</DataField>');
    expect(out).not.toMatch(/[^\r]\n/);
  });

  it('leaves anything that is not an AxTable alone', () => {
    expect(applyTableBpDefaults('<AxClass>\n\t<Name>C</Name>\n</AxClass>').notes).toEqual([]);
  });
});

describe('the whole create reconcile on a template table', () => {
  it('produces every default in one pass', () => {
    const xml = buildAxTableXml('ContosoRentLine', {
      tableGroup: 'Transaction',
      primaryIndex: 'RentIdx',
      fields: [{ name: 'RentId', edt: 'ContosoRentId' }, { name: 'ItemId', edt: 'ItemId' }],
      indexes: [{ name: 'RentIdx', fields: ['RentId'], alternateKey: true }],
    });
    const r = reconcileTableCreateProperties(xml, undefined, {
      edtRelations: { ItemId: { table: 'InventTable', relatedField: 'ItemId' } },
    });
    expect(r.xml).toContain('<OperationalDomain>Company</OperationalDomain>');
    expect(fieldBody(r.xml, 'RentId')).toContain('<AllowEdit>No</AllowEdit>');
    expect(r.xml).toMatch(/<Name>AutoReport<\/Name>\n\t\t\t<Fields>\n[\s\S]*<DataField>RentId<\/DataField>[\s\S]*<DataField>ItemId<\/DataField>/);
    expect(r.xml).toContain('<RelatedTable>InventTable</RelatedTable>');
    const report = renderTableCreateHonestyReport(r);
    expect(report).toContain('📋 BP defaults written after the create:');
    expect(report).toContain('table relations for EDT relations: ItemId → InventTable.ItemId');
  });
});

// ── EDT relation resolution ─────────────────────────────────────────────────

describe('edtRelationFromXml', () => {
  it('reads <Relations> when the EDT has no ReferenceTable (CustAccount → CustTable.AccountNum)', () => {
    const xml = '<AxEdt xmlns:i="" xmlns="" i:type="AxEdtString">\n\t<Name>CustAccount</Name>\n\t<Extends>CustVendAC</Extends>\n' +
      '\t<Relations>\n\t\t<AxEdtRelation>\n\t\t\t<RelatedField>AccountNum</RelatedField>\n\t\t\t<Table>CustTable</Table>\n\t\t</AxEdtRelation>\n\t</Relations>\n\t<TableReferences />\n</AxEdt>';
    expect(edtRelationFromXml(xml)).toEqual({ table: 'CustTable', relatedField: 'AccountNum' });
  });

  it('falls back to <TableReferences>, then to the legacy ReferenceTable with the EDT name', () => {
    const tr = '<AxEdt>\n\t<Name>ContosoRentId</Name>\n\t<Relations />\n\t<TableReferences>\n\t\t<AxEdtTableReference>\n\t\t\t<RelatedField>RentId</RelatedField>\n\t\t\t<Table>ContosoRentTable</Table>\n\t\t</AxEdtTableReference>\n\t</TableReferences>\n</AxEdt>';
    expect(edtRelationFromXml(tr)).toEqual({ table: 'ContosoRentTable', relatedField: 'RentId' });
    const legacy = '<AxEdt>\n\t<Name>ContosoRentId</Name>\n\t<ReferenceTable>ContosoRentTable</ReferenceTable>\n</AxEdt>';
    expect(edtRelationFromXml(legacy)).toEqual({ table: 'ContosoRentTable', relatedField: 'ContosoRentId' });
  });

  it('is undefined for an EDT without a relation', () => {
    expect(edtRelationFromXml('<AxEdt>\n\t<Name>Description</Name>\n\t<Relations />\n</AxEdt>')).toBeUndefined();
  });

  it('lists the EDTs of a table\'s fields, not of anything else', () => {
    const xml = structuredTable({ fields: field('A', '\t\t\t<ExtendedDataType>ItemId</ExtendedDataType>\n') + field('B', '\t\t\t<ExtendedDataType>ItemId</ExtendedDataType>\n') });
    expect(fieldEdtNames(xml)).toEqual(['ItemId']);
  });

  it('resolves nothing without an index, and uses edt_metadata when no XML is stored', async () => {
    expect(await resolveEdtRelations(['ItemId'], undefined)).toEqual({});
    const db = {
      prepare: (sql: string) => ({
        get: () => (sql.includes('edt_metadata') ? { reference_table: 'InventTable' } : undefined),
        all: () => [],
      }),
    };
    expect(await resolveEdtRelations(['ItemId'], db)).toEqual({ ItemId: { table: 'InventTable', relatedField: 'ItemId' } });
  });
});
