/**
 * Verify the write in the call that made it.
 *
 * The conventional loop was create → verify_d365fo_project → run_bp_check: two
 * extra round trips per object, both asking questions the writing call already
 * had the answers to.
 *
 * The negative case is the one that earns its keep: this project has a
 * documented history of writes that report ✅ and leave nothing usable behind
 * (empty security objects, tables with no fields, files absent from the
 * .rnrproj). A success message that has actually looked at the disk is a
 * different claim from one that has not.
 *
 * But a false alarm costs more than no alarm. The first version of this check
 * resolved the .rnrproj `Content Include` against the project directory and
 * compared it to the absolute .xml path, and the fixture below used to make
 * that work: project and metadata in one tree, `.xml` in the Include. Neither
 * holds in a real installation — projects live in a repo, metadata under
 * PackagesLocalDirectory, and Includes are extensionless — so the check was
 * false on every write. Twelve such warnings in one session taught the agent to
 * disregard the warning, and it then disregarded the true one. The fixture is
 * now the real layout, and the tests below are what the old fixture hid.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  verifyWrittenFile, renderWriteVerification, bridgeMessageNote,
  findReadBackMisses, renderReadBackMisses, verifyWriteIntent, modifyIntentFor, createIntentFor,
  readBackAfterModify,
} from '../../src/tools/write/inlineWriteVerification';
import type { Membership } from '../../src/workspace/projectMembership';

let base: string;
let xmlPath: string;
let orphanPath: string;
let activeProject: string;
let owningProject: string;

/** A .rnrproj whose Content Includes are model-relative and extensionless. */
function writeProject(at: string, includes: string[]): void {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(
    at,
    `<Project><PropertyGroup><Model>MyModel</Model></PropertyGroup><ItemGroup>` +
      includes.map(i => `<Content Include="${i}"><Name>x</Name></Content>`).join('') +
      `</ItemGroup></Project>`,
  );
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'inlineverify-'));

  // Metadata: <base>\packages\MyPackage\MyModel\AxTable\*.xml
  const modelDir = path.join(base, 'packages', 'MyPackage', 'MyModel', 'AxTable');
  fs.mkdirSync(modelDir, { recursive: true });
  xmlPath = path.join(modelDir, 'ContosoXyzTable.xml');
  fs.writeFileSync(xmlPath, '<AxTable><Name>ContosoXyzTable</Name></AxTable>');
  orphanPath = path.join(modelDir, 'ContosoOrphan.xml');
  fs.writeFileSync(orphanPath, '<AxTable/>');

  // Projects: a different tree entirely, as in a real repo checkout.
  activeProject = path.join(base, 'repo', 'MyModel - Active', 'MyModel - Active.rnrproj');
  owningProject = path.join(base, 'repo', 'MyModel - Owning', 'MyModel - Owning.rnrproj');
  writeProject(activeProject, ['AxTable\\SomethingElse']);
  writeProject(owningProject, ['AxTable\\ContosoXyzTable']);
});

afterAll(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const table = (name: string, siblings: string[] = []) => ({
  axFolder: 'AxTable',
  objectName: name,
  siblingProjectPaths: siblings,
});

describe('verifyWrittenFile — disk', () => {
  it('confirms a file that is really on disk', async () => {
    const v = await verifyWrittenFile(xmlPath);
    expect(v.onDisk).toBe(true);
    expect(v.bytes).toBeGreaterThan(0);
  });

  it('reports a missing file as not on disk', async () => {
    expect((await verifyWrittenFile(path.join(base, 'nope.xml'))).onDisk).toBe(false);
  });

  it('treats an empty file as not written', async () => {
    const empty = path.join(base, 'empty.xml');
    fs.writeFileSync(empty, '');
    expect((await verifyWrittenFile(empty)).onDisk).toBe(false);
  });

  it('never throws on a bad path', async () => {
    await expect(verifyWrittenFile(undefined)).resolves.toMatchObject({ onDisk: false });
  });
});

describe('verifyWrittenFile — project membership', () => {
  it('matches an extensionless, model-relative Include across separate trees', async () => {
    // The regression: the project lives in a repo, the file under packages, and
    // the Include is "AxTable\ContosoXyzTable". Any path resolution says no.
    const v = await verifyWrittenFile(xmlPath, owningProject, table('ContosoXyzTable'));
    expect(v.membership?.status).toBe('active');
  });

  it('reports a file registered in a sibling project as registered, not missing', async () => {
    const v = await verifyWrittenFile(
      xmlPath, activeProject, table('ContosoXyzTable', [owningProject]),
    );
    expect(v.membership?.status).toBe('other');
    expect(v.membership?.owners).toEqual([owningProject]);
  });

  it('reports missing only when no project of the model has it', async () => {
    const v = await verifyWrittenFile(
      orphanPath, activeProject, table('ContosoOrphan', [owningProject]),
    );
    expect(v.membership?.status).toBe('missing');
  });

  it('ignores case drift between the file name and the Include', async () => {
    // The generators write "…CtsoFinExtension" where the XML says
    // "…CtsoFINExtension"; VS does not care and neither should this.
    const v = await verifyWrittenFile(xmlPath, owningProject, table('contosoXYZtable'));
    expect(v.membership?.status).toBe('active');
  });

  it('says nothing about the project when the .rnrproj is unreadable', async () => {
    const v = await verifyWrittenFile(
      xmlPath, path.join(base, 'missing.rnrproj'), table('ContosoXyzTable'),
    );
    expect(v.membership?.status).toBe('unknown');
  });

  it('asks nothing when the caller supplies no membership target', async () => {
    const v = await verifyWrittenFile(xmlPath, owningProject);
    expect(v.membership).toBeUndefined();
  });
});

const m = (status: Membership['status'], owners: string[] = []): Membership => ({ status, owners });

describe('renderWriteVerification', () => {
  it('contradicts the ✅ when the file is not there', () => {
    const text = renderWriteVerification({ onDisk: false });
    expect(text).toContain('NOT on disk');
    expect(text).toMatch(/treat this write as failed/i);
  });

  it('warns only when no project of the model references the file', () => {
    const text = renderWriteVerification({
      onDisk: true, bytes: 120, membership: m('missing'), axFolder: 'AxTable', objectName: 'T',
    });
    expect(text).toMatch(/no \.rnrproj of this model/i);
    // xppc compiles the whole model folder: membership is about Visual Studio, not the build.
    expect(text).toMatch(/still compiles/i);
    expect(text).not.toMatch(/will not compile/i);
    expect(text).toMatch(/addToProject=true/);
  });

  // 'other' is neither a pass nor a build failure. The element compiles — a
  // sibling project references it — but the project being worked in does not
  // contain what was just changed, and an object may belong to several projects
  // of one model, so the fix is to add it here too rather than to accept the gap.
  it('names the sibling project and points at the gap, without crying missing', () => {
    const text = renderWriteVerification({
      onDisk: true,
      bytes: 120,
      membership: m('other', ['K:\\repo\\MyModel - Sibling.rnrproj']),
      axFolder: 'AxTable',
      objectName: 'T',
    });
    expect(text).toContain('MyModel - Sibling');
    expect(text).toMatch(/not by the active project/i);
    expect(text).toMatch(/addToProject=true/);
    expect(text).not.toMatch(/do not add it again/i);
    expect(text).not.toMatch(/will not compile/i);
  });

  // A clean write is silent: "✅ Verified: on disk (N bytes), referenced by the
  // .rnrproj." restated the ✅ headline on every write.
  it('says nothing when the file is on disk and the active project has it', () => {
    expect(renderWriteVerification({
      onDisk: true, bytes: 120, membership: m('active', ['p.rnrproj']),
    })).toBe('');
  });

  it('says nothing when it could not tell about the project', () => {
    expect(renderWriteVerification({ onDisk: true, bytes: 120, membership: m('unknown') })).toBe('');
    expect(renderWriteVerification({ onDisk: true, bytes: 120 })).toBe('');
  });
});

describe('bridgeMessageNote', () => {
  const FILE = 'K:\\PackagesLocalDirectory\\ContosoExt\\ContosoExt\\AxTable\\ContosoRentTable.xml';

  it('drops a bare "✅ … via <Api>" confirmation that restates the headline', () => {
    expect(bridgeMessageNote("✅ Field 'RentAmount' added via IMetaTableProvider.Update", FILE)).toBe('');
    expect(bridgeMessageNote(`✅ Created via IMetaClassProvider.Create — file: ${FILE}`, FILE)).toBe('');
  });

  it('keeps what the message adds beyond the confirmation', () => {
    // An unapplied-property suffix on an otherwise bare confirmation.
    expect(bridgeMessageNote(
      `✅ Created via IMetaClassProvider.Create — file: ${FILE}\n⚠️ NOT applied — this object type has nowhere to store them: Label`,
      FILE,
    )).toBe('\n⚠️ NOT applied — this object type has nowhere to store them: Label');
    // Defaults the bridge chose are information, not a restatement.
    expect(bridgeMessageNote(
      "✅ Relation 'CustTable' added via IMetaTableProvider.Update (Cardinality=ZeroMore, RelatedTableCardinality=ZeroOne, RelationshipType=Association)",
      FILE,
    )).toContain('Cardinality=ZeroMore');
    // An idempotent no-op is something the agent must know.
    expect(bridgeMessageNote("ℹ️ 'ContosoRentDuty' is already in <Duties> — nothing written (idempotent).", FILE))
      .toContain('already in <Duties>');
  });

  it('drops a "File: <path>" the reply already prints, and keeps the rest of the line', () => {
    expect(bridgeMessageNote(`✅ Property 'Label' set via direct XML fallback (no bridge path). File: ${FILE}`, FILE))
      .toBe("\n✅ Property 'Label' set via direct XML fallback (no bridge path).");
  });

  it('says nothing for an empty message', () => {
    expect(bridgeMessageNote(undefined)).toBe('');
    expect(bridgeMessageNote('')).toBe('');
  });
});

// ── Read-back comparison (#1161) ─────────────────────────────────────────────
// "✅ applied" over a file that does not hold what was asked for. The comparison
// is over the file's own text, so it answers for every object type, and it only
// speaks when it is certain: a false "NOT in the file" teaches the caller to
// ignore the true one.

const ENTITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ContosoRentEquipmentEntity</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ContosoRentEquipmentEntity extends common
{
    // <Fields><AxDataEntityViewField><Name>InsideCData</Name></AxDataEntityViewField></Fields>
}
]]></Declaration>
\t\t<Methods>
\t\t\t<Method>
\t\t\t\t<Name>validateWrite</Name>
\t\t\t\t<Source><![CDATA[
    public boolean validateWrite()
    {
        return true;
    }
]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t</SourceCode>
\t<Label>@ContosoExt:RentEquipment</Label>
\t<DataManagementEnabled>Yes</DataManagementEnabled>
\t<DataManagementStagingTable>ContosoRentEquipmentStaging</DataManagementStagingTable>
\t<EntityCategory>Master</EntityCategory>
\t<IsPublic>Yes</IsPublic>
\t<PrimaryKey>EntityKey</PrimaryKey>
\t<PublicCollectionName>Rent &amp; Equipment</PublicCollectionName>
\t<!-- <ConfigurationKey>ContosoCommentedKey</ConfigurationKey> -->
\t<FieldGroups>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoReport</Name>
\t\t\t<Fields />
\t\t</AxTableFieldGroup>
\t</FieldGroups>
\t<Fields>
\t\t<AxDataEntityViewField xmlns=""
\t\t\ti:type="AxDataEntityViewMappedField">
\t\t\t<Name>EquipmentId</Name>
\t\t\t<DataField>EquipmentId</DataField>
\t\t\t<DataSource>ContosoRentEquipmentTable</DataSource>
\t\t</AxDataEntityViewField>
\t</Fields>
\t<Keys />
\t<Relations>
\t\t<AxDataEntityViewRelation>
\t\t\t<Name>Owner</Name>
\t\t\t<Constraints>
\t\t\t\t<AxDataEntityViewRelationConstraint>
\t\t\t\t\t<Name>OwnerAccount</Name>
\t\t\t\t</AxDataEntityViewRelationConstraint>
\t\t\t</Constraints>
\t\t</AxDataEntityViewRelation>
\t</Relations>
\t<ViewMetadata>
\t\t<Name>Metadata</Name>
\t\t<DataSources>
\t\t\t<AxQuerySimpleRootDataSource>
\t\t\t\t<Name>ContosoRentEquipmentTable</Name>
\t\t\t\t<Fields>
\t\t\t\t\t<AxQuerySimpleDataSourceField>
\t\t\t\t\t\t<Name>NestedOnly</Name>
\t\t\t\t\t</AxQuerySimpleDataSourceField>
\t\t\t\t</Fields>
\t\t\t\t<Methods>
\t\t\t\t\t<Method>
\t\t\t\t\t\t<Name>init</Name>
\t\t\t\t\t</Method>
\t\t\t\t</Methods>
\t\t\t</AxQuerySimpleRootDataSource>
\t\t</DataSources>
\t</ViewMetadata>
</AxDataEntityView>`;

describe('findReadBackMisses: top-level properties', () => {
  it('says nothing when the property holds the requested value', () => {
    expect(findReadBackMisses(ENTITY_XML, {
      properties: { DataManagementStagingTable: 'ContosoRentEquipmentStaging', EntityCategory: 'Master' },
    })).toEqual([]);
  });

  it('matches the element name and the value without case, and trims both', () => {
    expect(findReadBackMisses(ENTITY_XML, {
      properties: { dataManagementStagingTable: '  contosorentequipmentstaging ', entitycategory: 'MASTER' },
    })).toEqual([]);
  });

  it('treats true/false, Yes/No and 1/0 as the same boolean', () => {
    for (const yes of ['true', 'Yes', 'TRUE', '1']) {
      expect(findReadBackMisses(ENTITY_XML, { properties: { IsPublic: yes } })).toEqual([]);
    }
    const literal = ENTITY_XML.replace('<IsPublic>Yes</IsPublic>', '<IsPublic>true</IsPublic>');
    expect(findReadBackMisses(literal, { properties: { IsPublic: 'Yes' } })).toEqual([]);
    expect(findReadBackMisses(ENTITY_XML, { properties: { IsPublic: 'false' } })).toHaveLength(1);
    expect(findReadBackMisses(ENTITY_XML, { properties: { IsPublic: '0' } })).toHaveLength(1);
  });

  it('does not read 1 as Yes against a value that is not a boolean', () => {
    const xml = ENTITY_XML.replace('<EntityCategory>Master</EntityCategory>', '<StringSize>10</StringSize>');
    expect(findReadBackMisses(xml, { properties: { StringSize: '1' } })).toHaveLength(1);
    expect(findReadBackMisses(xml, { properties: { StringSize: '10' } })).toEqual([]);
  });

  it('decodes XML entities before comparing', () => {
    expect(findReadBackMisses(ENTITY_XML, { properties: { PublicCollectionName: 'Rent & Equipment' } })).toEqual([]);
  });

  it('reports a property whose element holds another value', () => {
    const misses = findReadBackMisses(ENTITY_XML, { properties: { dataManagementStagingTable: 'ContosoOtherStaging' } });
    expect(misses).toEqual([{
      kind: 'property-differs',
      what: 'DataManagementStagingTable=ContosoOtherStaging',
      found: 'the file holds "ContosoRentEquipmentStaging"',
    }]);
  });

  it('reports an absent property only when the caller says it must exist', () => {
    const intent = { properties: { ConfigurationKey: 'ContosoRentKey' } };
    // Absence can be a serializer-omitted default, so by itself it is not a miss…
    expect(findReadBackMisses(ENTITY_XML, intent)).toEqual([]);
    // …and the commented-out element is not the property either.
    const misses = findReadBackMisses(ENTITY_XML, { ...intent, mustExist: ['configurationkey'] });
    expect(misses).toHaveLength(1);
    expect(misses[0].kind).toBe('property-absent');
    expect(misses[0].what).toBe('ConfigurationKey=ContosoRentKey');
    expect(misses[0].found).toContain('<ConfigurationKey>');
  });

  it('never reports an absent Yes/No or enum value that is not in mustExist', () => {
    expect(findReadBackMisses(ENTITY_XML, {
      properties: { IsReadOnly: 'No', AllowRowVersionChangeTracking: 'false', TableGroup: 'Miscellaneous' },
      mustExist: ['ConfigurationKey'],
    })).toEqual([]);
  });

  it('leaves a label-valued property alone unless a label id was requested', () => {
    // Raw text is turned into a label id by the writer: a different value is correct.
    expect(findReadBackMisses(ENTITY_XML, { properties: { label: 'Rent equipment' } })).toEqual([]);
    expect(findReadBackMisses(ENTITY_XML, { properties: { label: '@ContosoExt:RentEquipment' } })).toEqual([]);
    expect(findReadBackMisses(ENTITY_XML, { properties: { label: '@ContosoExt:Other' } })).toHaveLength(1);
  });

  it('only compares TOP-LEVEL elements, not one of the same name deeper down', () => {
    // <ViewMetadata><Name>Metadata</Name> is not the object's Name.
    expect(findReadBackMisses(ENTITY_XML, { properties: { Name: 'ContosoRentEquipmentEntity' } })).toEqual([]);
    expect(findReadBackMisses(ENTITY_XML, { properties: { DataField: 'Other' } })).toEqual([]);
  });

  it('skips an empty requested value', () => {
    expect(findReadBackMisses(ENTITY_XML, { properties: { EntityCategory: '  ' }, mustExist: ['EntityCategory'] })).toEqual([]);
  });
});

describe('findReadBackMisses: named children', () => {
  it('finds every kind of added child where the document keeps it', () => {
    expect(findReadBackMisses(ENTITY_XML, {
      present: [
        { kind: 'field', name: 'equipmentid' },
        { kind: 'method', name: 'ValidateWrite' },
        { kind: 'field-group', name: 'AutoReport' },
        { kind: 'relation', name: 'Owner' },
        { kind: 'data-source', name: 'ContosoRentEquipmentTable' },
      ],
    })).toEqual([]);
  });

  it('reports an added child that is not in a collection of its kind', () => {
    const misses = findReadBackMisses(ENTITY_XML, {
      present: [
        { kind: 'field', name: 'RentalRate' },
        { kind: 'method', name: 'insert' },
        { kind: 'index', name: 'EquipmentIdx' },
        { kind: 'enum-value', name: 'Rented' },
        { kind: 'control', name: 'RentGrid' },
      ],
    });
    expect(misses.map(m => m.kind)).toEqual(Array(5).fill('child-absent'));
    expect(misses.map(m => m.what)).toEqual([
      'field "RentalRate"', 'method "insert"', 'index "EquipmentIdx"', 'enum-value "Rented"', 'control "RentGrid"',
    ]);
  });

  it('does not take a name from another collection, a comment or X++ source for the child', () => {
    // "Owner" is a relation, "AutoReport" a field group, "InsideCData" is X++ text.
    const misses = findReadBackMisses(ENTITY_XML, {
      present: [
        { kind: 'field', name: 'Owner' },
        { kind: 'field', name: 'AutoReport' },
        { kind: 'field', name: 'InsideCData' },
        { kind: 'relation', name: 'OwnerAccount' },
      ],
    });
    expect(misses).toHaveLength(4);
  });

  it('counts an added child as present anywhere in a collection of its kind', () => {
    // Nested under a data source: not certain to be wrong, so not reported.
    expect(findReadBackMisses(ENTITY_XML, {
      present: [{ kind: 'field', name: 'NestedOnly' }, { kind: 'method', name: 'init' }],
    })).toEqual([]);
  });

  it('reports a removed child that is still in the object\'s own collection', () => {
    const misses = findReadBackMisses(ENTITY_XML, {
      absent: [{ kind: 'field', name: 'EQUIPMENTID' }, { kind: 'method', name: 'validateWrite' }],
    });
    expect(misses.map(m => m.kind)).toEqual(['child-still-present', 'child-still-present']);
    expect(misses[0].what).toBe('removal of field "EQUIPMENTID"');
    expect(misses[0].found).toContain('<Fields>');
  });

  it('does not call a removal failed over a same-named child nested elsewhere', () => {
    expect(findReadBackMisses(ENTITY_XML, {
      absent: [
        { kind: 'field', name: 'NestedOnly' },
        { kind: 'method', name: 'init' },
        { kind: 'field', name: 'RentalRate' },
      ],
    })).toEqual([]);
  });

  it('reads a self-closed collection as empty', () => {
    const misses = findReadBackMisses(ENTITY_XML, { present: [{ kind: 'index', name: 'Any' }], absent: [{ kind: 'index', name: 'Any' }] });
    expect(misses.map(m => m.kind)).toEqual(['child-absent']);
  });
});

describe('findReadBackMisses: documents it cannot be sure about', () => {
  const intent = {
    properties: { ConfigurationKey: 'ContosoRentKey' },
    mustExist: ['ConfigurationKey'],
    present: [{ kind: 'field' as const, name: 'RentalRate' }],
  };

  it('says nothing without an intent or without a document', () => {
    expect(findReadBackMisses(ENTITY_XML, null)).toEqual([]);
    expect(findReadBackMisses(ENTITY_XML, {})).toEqual([]);
    expect(findReadBackMisses('', intent)).toEqual([]);
  });

  it('says nothing about a document with no top-level <Name>', () => {
    expect(findReadBackMisses('<Project><ItemGroup /></Project>', intent)).toEqual([]);
    expect(findReadBackMisses('not xml at all', intent)).toEqual([]);
  });

  it('does not judge children in a document that does not close its elements', () => {
    const truncated = ENTITY_XML.slice(0, ENTITY_XML.indexOf('<Keys />'));
    const misses = findReadBackMisses(truncated, intent);
    expect(misses.map(m => m.kind)).toEqual(['property-absent']);
  });
});

describe('renderReadBackMisses', () => {
  it('is empty when everything matched', () => {
    expect(renderReadBackMisses([])).toBe('');
  });

  it('is one block naming every miss', () => {
    const text = renderReadBackMisses(findReadBackMisses(ENTITY_XML, {
      properties: { ConfigurationKey: 'ContosoRentKey', EntityCategory: 'Document' },
      mustExist: ['ConfigurationKey'],
      present: [{ kind: 'field', name: 'RentalRate' }],
      absent: [{ kind: 'field', name: 'EquipmentId' }],
    }));
    expect(text).toMatch(/^\n\n⚠️ Read-back: 4 requested item\(s\) are NOT in the file/);
    expect(text).toContain('ConfigurationKey=ContosoRentKey');
    expect(text).toContain('EntityCategory=Document: the file holds "Master"');
    expect(text).toContain('field "RentalRate"');
    expect(text).toContain('removal of field "EquipmentId"');
    expect(text).toContain('Nothing was rolled back');
  });
});

describe('modifyIntentFor', () => {
  it('names the child an add or remove operation is about', () => {
    expect(modifyIntentFor('add-field', 'data-entity-extension', { fieldName: ' ContosoTier ' }))
      .toEqual({ present: [{ kind: 'field', name: 'ContosoTier' }] });
    expect(modifyIntentFor('remove-field', 'table', { fieldName: 'ContosoTier' }))
      .toEqual({ absent: [{ kind: 'field', name: 'ContosoTier' }] });
    expect(modifyIntentFor('add-index', 'table', { indexName: 'TierIdx' })?.present?.[0].kind).toBe('index');
    expect(modifyIntentFor('remove-index', 'table', { indexName: 'TierIdx' })?.absent?.[0].kind).toBe('index');
    expect(modifyIntentFor('add-field-group', 'table', { fieldGroupName: 'Tier' })?.present?.[0].kind).toBe('field-group');
    expect(modifyIntentFor('remove-field-group', 'table', { fieldGroupName: 'Tier' })?.absent?.[0].kind).toBe('field-group');
    expect(modifyIntentFor('add-relation', 'table', { relationName: 'Owner' })?.present?.[0].kind).toBe('relation');
    expect(modifyIntentFor('remove-relation', 'table', { relationName: 'Owner' })?.absent?.[0].kind).toBe('relation');
    expect(modifyIntentFor('add-enum-value', 'enum', { enumValueName: 'Rented' })?.present?.[0].kind).toBe('enum-value');
    expect(modifyIntentFor('remove-enum-value', 'enum', { enumValueName: 'Rented' })?.absent?.[0].kind).toBe('enum-value');
    expect(modifyIntentFor('remove-method', 'class', { methodName: 'run' })?.absent?.[0].kind).toBe('method');
  });

  it('takes add-method names from the caller and never checks classDeclaration', () => {
    expect(modifyIntentFor('add-method', 'class', { methodName: 'ignored' }, ['run', 'classDeclaration']))
      .toEqual({ present: [{ kind: 'method', name: 'run' }] });
    expect(modifyIntentFor('add-method', 'class', { methodName: 'run' })).toBeNull();
    // A control override is stored as <Name>clicked</Name> under the control.
    expect(modifyIntentFor('add-method', 'form', {}, ['PostButton.clicked'])).toBeNull();
  });

  it('has no intent for a name it cannot place, or an operation it does not cover', () => {
    expect(modifyIntentFor('add-field', 'table', {})).toBeNull();
    expect(modifyIntentFor('remove-method', 'form', { methodName: 'CustTable.init' })).toBeNull();
    expect(modifyIntentFor('add-control', 'form', { controlName: 'RentGrid' })).toBeNull();
    expect(modifyIntentFor('replace-code', 'class', { oldCode: 'a', newCode: 'b' })).toBeNull();
  });

  it('compares modify-property only for a plain top-level property', () => {
    expect(modifyIntentFor('modify-property', 'data-entity', { propertyPath: 'ConfigurationKey', propertyValue: 'ContosoRentKey' }))
      .toEqual({ properties: { ConfigurationKey: 'ContosoRentKey' } });
    expect(modifyIntentFor('modify-property', 'data-entity', { propertyPath: 'IsPublic', propertyValue: true }))
      .toEqual({ properties: { IsPublic: 'true' } });
    // No mustExist: an absent element can be the default the serializer omits.
    expect(modifyIntentFor('modify-property', 'table', { propertyPath: 'TableGroup', propertyValue: 'Main' })?.mustExist).toBeUndefined();
    for (const [objectType, args] of [
      ['form', { propertyPath: 'Caption', propertyValue: '@ContosoExt:Rent' }],
      ['form-extension', { propertyPath: 'Visible', propertyValue: 'No' }],
      ['model-descriptor', { propertyPath: 'Description', propertyValue: 'x' }],
      ['table', { propertyPath: 'Visible', propertyValue: 'No', controlName: 'RentGrid' }],
      ['table', { propertyPath: 'RentGrid.Visible', propertyValue: 'No' }],
      ['table', { propertyPath: 'SubscriberAccessLevel', propertyValue: 'Read' }],
      ['table', { propertyPath: 'PrimaryIndex', propertyValue: '' }],
      ['table', { propertyPath: 'PrimaryIndex' }],
    ] as const) {
      expect(modifyIntentFor('modify-property', objectType, args)).toBeNull();
    }
  });
});

describe('readBackAfterModify', () => {
  const single = () => null;
  const entityFile = () => {
    const file = path.join(base, 'ContosoRentEquipmentEntityModify.xml');
    fs.writeFileSync(file, ENTITY_XML);
    return file;
  };

  it('looks for a single added method under the operation\'s methodName', async () => {
    const file = entityFile();
    expect(await readBackAfterModify(file, 'add-method', 'data-entity',
      { methodName: 'validateWrite', sourceCode: 'public boolean validateWrite() { return true; }' }, '', single)).toBe('');
    expect(await readBackAfterModify(file, 'add-method', 'data-entity',
      { methodName: 'insert', sourceCode: 'public void insert() { }' }, '', single)).toContain('method "insert"');
  });

  it('looks for every method of a source that carries several, not for methodName', async () => {
    const text = await readBackAfterModify(entityFile(), 'add-method', 'data-entity',
      { methodName: 'ignored', sourceCode: 'two methods' }, '', () => ['validateWrite', null, 'insert']);
    expect(text).toContain('method "insert"');
    expect(text).not.toContain('ignored');
    expect(text).not.toContain('validateWrite');
  });

  it('stays silent when the reply already says the value is not in the file', async () => {
    const already = '\n\n❌ Verification: "EntityCategory=Document" is NOT in the file after a reported success.';
    const args = { propertyPath: 'EntityCategory', propertyValue: 'Document' };
    expect(await readBackAfterModify(entityFile(), 'modify-property', 'data-entity', args, already, single)).toBe('');
    expect(await readBackAfterModify(entityFile(), 'modify-property', 'data-entity', args, '', single))
      .toContain('EntityCategory=Document');
  });

  it('never throws', async () => {
    const boom = () => { throw new Error('splitter failed'); };
    expect(await readBackAfterModify(entityFile(), 'add-method', 'class', { sourceCode: 'x' }, '', boom)).toBe('');
  });
});

describe('createIntentFor', () => {
  it('compares the scalar properties and leaves collections out', () => {
    const intent = createIntentFor('data-entity', {
      configurationKey: 'ContosoRentKey', isPublic: true, stringSize: 20,
      fields: [{ name: 'EquipmentId' }], methods: undefined, tags: null,
    });
    expect(intent?.properties).toEqual({ configurationKey: 'ContosoRentKey', isPublic: 'true', stringSize: '20' });
    expect(intent?.mustExist).toContain('configurationKey');
    expect(intent?.mustExist).toContain('dataManagementStagingTable');
  });

  it('leaves a table to its own reconciliation', () => {
    expect(createIntentFor('table', { configurationKey: 'ContosoRentKey' })).toBeNull();
  });

  it('skips identity, the base type, the BP-default properties and keys already reported', () => {
    expect(createIntentFor('edt', { name: 'X', extends: 'Name', operationalDomain: 'Shared', subscriberAccessLevel: 'Read' })).toBeNull();
    expect(createIntentFor('data-entity', { formRef: 'ContosoRentForm', entityCategory: 'Master' }, ['FormRef'])?.properties)
      .toEqual({ entityCategory: 'Master' });
  });

  it('has no intent without properties', () => {
    expect(createIntentFor('class', undefined)).toBeNull();
    expect(createIntentFor('class', {})).toBeNull();
    expect(createIntentFor('class', ['x'])).toBeNull();
  });
});

describe('verifyWriteIntent', () => {
  it('reads the file and renders the misses, and stays silent on a match', async () => {
    const file = path.join(base, 'ContosoRentEquipmentEntity.xml');
    fs.writeFileSync(file, ENTITY_XML);
    expect(await verifyWriteIntent(file, { properties: { EntityCategory: 'Master' } })).toBe('');
    expect(await verifyWriteIntent(file, { present: [{ kind: 'field', name: 'RentalRate' }] }))
      .toContain('field "RentalRate"');
  });

  it('never throws: no path, no intent or an unreadable file say nothing', async () => {
    expect(await verifyWriteIntent(undefined, { present: [{ kind: 'field', name: 'X' }] })).toBe('');
    expect(await verifyWriteIntent(path.join(base, 'ContosoMissing.xml'), { present: [{ kind: 'field', name: 'X' }] })).toBe('');
    expect(await verifyWriteIntent(path.join(base, 'ContosoMissing.xml'), null)).toBe('');
  });
});
