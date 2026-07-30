/**
 * buildAxDataEntityXml (src/tools/dataEntityXml.ts).
 *
 * Regression:
 * eval/corpus/runs/2026-07-07T12__L4-bridge-drops-data-entity-primarytable-fields-on-create__cb1b73d.json
 * — d365fo_file(action="create", objectType="data-entity") unconditionally
 * hard-coded <DataManagementEnabled>Yes</DataManagementEnabled> and
 * <DataManagementStagingTable>${entityName}Staging</DataManagementStagingTable>
 * with no path that ever creates that staging table, so the very next full
 * build failed: "Metadata Error: AxDataEntityView/.../DataManagementStagingTable:
 * Table '<Name>Staging' does not exist." Every data entity this tool ever
 * created was build-broken by default.
 *
 * Follow-up: eval/corpus/runs/2026-07-30T07__L3-dualwrite-entity-mapping__1f842a6.json
 * — the first fix wrote an explicit <DataManagementEnabled>No</…> +
 * <DataManagementStagingTable /> pair instead, the sole residual golden diff of
 * that run. AOT census: 0 of 2662 shipped entities write either default form
 * (1793 write Yes + a named staging table, 869 omit both), reflection gives
 * NoYes.No / "" as the metamodel defaults, and a bridge round-trip drops both.
 * Both elements are now omitted unless the caller opts in.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAxDataEntityXml } from '../../src/tools/dataEntityXml';

const REPO_ROOT = join(__dirname, '..', '..');

/** Canonical element order derived from all 5899 shipped AxDataEntityView files — see the fixture's _provenance. */
const REFERENCE = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'axDataEntityView-element-order.json'), 'utf8'),
) as {
  canonicalOrder: string[];
  standardFieldGroups: Array<{ name: string; autoPopulate?: boolean }>;
};

/** Top-level (one-tab-indented) element names, in document order. */
function topLevelElements(xml: string): string[] {
  return [...xml.matchAll(/^\t<([A-Za-z]+)[ />]/gm)].map(m => m[1]);
}

describe('buildAxDataEntityXml — DataManagementEnabled defaulting', () => {
  it('omits both data-management elements (skeleton branch: no primaryTable/fields)', () => {
    const xml = buildAxDataEntityXml('ConSmallItemEntity');
    expect(xml).not.toContain('<DataManagementEnabled>');
    expect(xml).not.toContain('<DataManagementStagingTable');
    expect(xml).not.toContain('ConSmallItemEntityStaging');
  });

  it('omits both data-management elements (full branch: primaryTable + fields given)', () => {
    const xml = buildAxDataEntityXml('ConSmallItemEntity', {
      primaryTable: 'ConSmallItem',
      fields: [{ name: 'ItemId' }, { name: 'Name' }],
    });
    expect(xml).not.toContain('<DataManagementEnabled>');
    expect(xml).not.toContain('<DataManagementStagingTable');
    expect(xml).not.toContain('Staging<');
    // The real fix this case was originally mined for (primaryTable/fields honoured) still works.
    expect(xml).toContain('<DataField>ItemId</DataField>');
    expect(xml).toContain('<Table>ConSmallItem</Table>');
  });

  it('opts IN to data management when properties.dataManagementEnabled=true, defaulting the staging table name', () => {
    const xml = buildAxDataEntityXml('ConSmallItemEntity', {
      primaryTable: 'ConSmallItem',
      fields: [{ name: 'ItemId' }],
      dataManagementEnabled: true,
    });
    expect(xml).toContain('<DataManagementEnabled>Yes</DataManagementEnabled>');
    expect(xml).toContain('<DataManagementStagingTable>ConSmallItemEntityStaging</DataManagementStagingTable>');
  });

  it('opts IN with an explicit staging table name override', () => {
    const xml = buildAxDataEntityXml('ConSmallItemEntity', {
      primaryTable: 'ConSmallItem',
      fields: [{ name: 'ItemId' }],
      dataManagementEnabled: true,
      dataManagementStagingTable: 'ConCustomStagingTable',
    });
    expect(xml).toContain('<DataManagementStagingTable>ConCustomStagingTable</DataManagementStagingTable>');
  });

  it('an unset/false dataManagementEnabled behaves identically to omitting the property', () => {
    const withFalse = buildAxDataEntityXml('X', { dataManagementEnabled: false });
    const withOmitted = buildAxDataEntityXml('X', {});
    expect(withFalse).toBe(withOmitted);
  });
});

/**
 * Regression: eval/corpus/runs/2026-07-29T12__L3-dualwrite-entity-mapping__483852c.json
 * (TOOL_DEFECT, DRAFT golden). The shared AxDataEntityView writer could not express
 * the properties three coverage leaves need at once — dual-write (w2), DMF/DIXF (w2)
 * and Power Platform virtual entities (w1):
 *
 *   1. change tracking was unreachable: AllowRowVersionChangeTracking (the real
 *      MetaModel.AxDataEntityView property) had ZERO hits anywhere in src/, and the
 *      value passed to d365fo_file(action="create") was silently discarded;
 *   2. <PrimaryKey>EntityKey</PrimaryKey> and the key's own <Name>EntityKey</Name>
 *      were hard-coded, so a named business key (CustomerCode/CustomerGroupKey) was
 *      impossible — and a RecId-shaped key FAILS the dual-write case outright;
 *   3. <IsPublic>Yes</IsPublic> was hard-coded — no non-public entity was expressible;
 *   4. <SourceCode>, <FieldGroups>, <DeleteActions/>, <StateMachines/> were missing
 *      entirely, though they are present in 5859/5859 shipped entities.
 *
 * Everything below is opt-in: callers that pass none of it must stay byte-identical
 * (see the "backward compatibility" block).
 */
describe('buildAxDataEntityXml — element order matches the shipped AOT serializer', () => {
  it('emits top-level elements as a subsequence of the canonical order (skeleton branch)', () => {
    const xml = buildAxDataEntityXml('ConSmallItemEntity', {
      allowRowVersionChangeTracking: true,
      standardStructure: true,
    });
    const emitted = topLevelElements(xml);
    const positions = emitted.map(e => REFERENCE.canonicalOrder.indexOf(e));
    expect(positions).not.toContain(-1); // no element unknown to the shipped serializer
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('emits top-level elements as a subsequence of the canonical order (full branch, all opt-ins on)', () => {
    const xml = buildAxDataEntityXml('ConSmallItemEntity', {
      primaryTable: 'ConSmallItem',
      fields: [{ name: 'ItemId' }, { name: 'Name' }],
      allowRowVersionChangeTracking: true,
      dataManagementEnabled: true,
      standardStructure: true,
      primaryKey: 'ItemKey',
      dynamicFields: true,
    });
    const emitted = topLevelElements(xml);
    const positions = emitted.map(e => REFERENCE.canonicalOrder.indexOf(e));
    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('places AllowRowVersionChangeTracking before DataManagementEnabled and DeleteActions/FieldGroups before Fields', () => {
    const xml = buildAxDataEntityXml('E', {
      primaryTable: 'T',
      fields: [{ name: 'A' }],
      allowRowVersionChangeTracking: true,
      dataManagementEnabled: true,
      standardStructure: true,
    });
    const e = topLevelElements(xml);
    expect(e.indexOf('SourceCode')).toBeLessThan(e.indexOf('Label'));
    expect(e.indexOf('Label')).toBeLessThan(e.indexOf('AllowRowVersionChangeTracking'));
    expect(e.indexOf('AllowRowVersionChangeTracking')).toBeLessThan(e.indexOf('DataManagementEnabled'));
    expect(e.indexOf('IsPublic')).toBeLessThan(e.indexOf('PrimaryKey'));
    expect(e.indexOf('PrimaryKey')).toBeLessThan(e.indexOf('PublicCollectionName'));
    expect(e.indexOf('PublicEntityName')).toBeLessThan(e.indexOf('DeleteActions'));
    expect(e.indexOf('DeleteActions')).toBeLessThan(e.indexOf('FieldGroups'));
    expect(e.indexOf('FieldGroups')).toBeLessThan(e.indexOf('Fields'));
    expect(e.indexOf('Relations')).toBeLessThan(e.indexOf('StateMachines'));
    expect(e.indexOf('StateMachines')).toBeLessThan(e.indexOf('ViewMetadata'));
  });

  /**
   * The strongest VM-free oracle available: the L3-dualwrite-entity-mapping golden was
   * hand-authored ON the VM and verified there with a full force build (Errors: 0) and
   * a per-element BP check (0 errors). If the writer can now reproduce it, the case no
   * longer needs hand authoring.
   */
  it('reproduces the VM-verified L3-dualwrite-entity-mapping golden entity', () => {
    const golden = readFileSync(
      join(REPO_ROOT, 'eval', 'goldens', 'L3-dualwrite-entity-mapping', 'ConDemoSyncCustomerEntity.metadata.xml'),
      'utf8',
    );
    const xml = buildAxDataEntityXml('ConDemoSyncCustomerEntity', {
      label: '@TaxTransactionInquiry:HeaderNote',
      entityCategory: 'Master',
      primaryTable: 'ConDemoSyncCustomer',
      fields: [{ name: 'CustomerCode' }, { name: 'Name' }],
      primaryKeyField: 'CustomerCode',
      allowRowVersionChangeTracking: true,
      publicEntityName: 'ConDemoSyncCustomer',
      publicCollectionName: 'ConDemoSyncCustomers',
      standardStructure: true,
    });
    // Byte for byte, element order and indentation included — no normalisation
    // beyond line endings and the trailing newline.
    const normalise = (s: string) => s.replace(/\r\n/g, '\n').replace(/\s+$/, '');
    expect(normalise(xml)).toBe(normalise(golden));
  });
});

describe('buildAxDataEntityXml — change tracking (dual-write / virtual entities)', () => {
  it('emits AllowRowVersionChangeTracking=Yes when opted in', () => {
    const xml = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }], allowRowVersionChangeTracking: true });
    expect(xml).toContain('<AllowRowVersionChangeTracking>Yes</AllowRowVersionChangeTracking>');
  });

  it('accepts the legacy alias changeTrackingEnabled but never emits the legacy element', () => {
    // <ChangeTrackingEnabled> is not on MetaModel.AxDataEntityView; the deserializer
    // drops it silently (17 shipped files still carry it, all inert). Map it instead.
    const xml = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }], changeTrackingEnabled: true });
    expect(xml).toContain('<AllowRowVersionChangeTracking>Yes</AllowRowVersionChangeTracking>');
    expect(xml).not.toContain('<ChangeTrackingEnabled>');
  });

  it('accepts the string "Yes" as well as boolean true', () => {
    const asBool = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }], allowRowVersionChangeTracking: true });
    const asStr = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }], allowRowVersionChangeTracking: 'Yes' });
    expect(asStr).toBe(asBool);
  });

  it('omits the element entirely when off — no shipped entity writes AllowRowVersionChangeTracking=No', () => {
    for (const value of [undefined, false, 'No']) {
      const xml = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }], allowRowVersionChangeTracking: value });
      expect(xml).not.toContain('AllowRowVersionChangeTracking');
    }
  });
});

describe('buildAxDataEntityXml — entity key naming and composite business keys', () => {
  it('defaults the key name to EntityKey (unchanged)', () => {
    const xml = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }] });
    expect(xml).toContain('<PrimaryKey>EntityKey</PrimaryKey>');
    expect(xml).toMatch(/<AxDataEntityViewKey>\s*<Name>EntityKey<\/Name>/);
  });

  it('honours a caller-supplied key name in BOTH <PrimaryKey> and the key <Name>', () => {
    const xml = buildAxDataEntityXml('E', {
      primaryTable: 'T',
      fields: [{ name: 'CustomerCode' }],
      primaryKey: 'CustomerCodeKey',
      primaryKeyField: 'CustomerCode',
    });
    expect(xml).toContain('<PrimaryKey>CustomerCodeKey</PrimaryKey>');
    expect(xml).toMatch(/<AxDataEntityViewKey>\s*<Name>CustomerCodeKey<\/Name>/);
    expect(xml).not.toContain('EntityKey');
  });

  it('accepts entityKeyName as an alias for primaryKey', () => {
    const a = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }], primaryKey: 'MyKey' });
    const b = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }], entityKeyName: 'MyKey' });
    expect(b).toBe(a);
  });

  it('supports a composite business key via primaryKeyFields', () => {
    const xml = buildAxDataEntityXml('E', {
      primaryTable: 'T',
      fields: [{ name: 'CompanyCode' }, { name: 'DocumentCode' }, { name: 'Amount' }],
      primaryKey: 'DocumentKey',
      primaryKeyFields: ['CompanyCode', 'DocumentCode'],
    });
    expect(xml).toMatch(
      /<AxDataEntityViewKeyField>\s*<DataField>CompanyCode<\/DataField>\s*<\/AxDataEntityViewKeyField>\s*<AxDataEntityViewKeyField>\s*<DataField>DocumentCode<\/DataField>\s*<\/AxDataEntityViewKeyField>/,
    );
    // Amount is a mapped field but must NOT be part of the key.
    const keysBlock = /<Keys>[\s\S]*?<\/Keys>/.exec(xml)![0];
    expect(keysBlock).not.toContain('Amount');
  });

  it('primaryKeyFields wins over primaryKeyField', () => {
    const xml = buildAxDataEntityXml('E', {
      primaryTable: 'T',
      fields: [{ name: 'A' }, { name: 'B' }],
      primaryKeyField: 'A',
      primaryKeyFields: ['B'],
    });
    expect(xml).toMatch(/<AxDataEntityViewKeyField>\s*<DataField>B<\/DataField>/);
    expect(xml).not.toMatch(/<AxDataEntityViewKeyField>\s*<DataField>A<\/DataField>/);
  });
});

describe('buildAxDataEntityXml — IsPublic', () => {
  it('stays public by default', () => {
    const xml = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }] });
    expect(xml).toContain('<IsPublic>Yes</IsPublic>');
    expect(xml).toContain('<PublicCollectionName>ECollection</PublicCollectionName>');
    expect(xml).toContain('<PublicEntityName>E</PublicEntityName>');
  });

  it('isPublic:false omits IsPublic and both public names (shipped convention: 1316/1329)', () => {
    for (const branch of [{}, { primaryTable: 'T', fields: [{ name: 'A' }] }]) {
      const xml = buildAxDataEntityXml('E', { ...branch, isPublic: false });
      expect(xml).not.toContain('IsPublic');
      expect(xml).not.toContain('PublicCollectionName');
      expect(xml).not.toContain('PublicEntityName');
      // No shipped AxDataEntityView writes the NoYes default explicitly.
      expect(xml).not.toContain('<IsPublic>No</IsPublic>');
    }
  });

  it('isPublic:true is byte-identical to omitting it', () => {
    const explicit = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }], isPublic: true });
    const omitted = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }] });
    expect(explicit).toBe(omitted);
  });
});

describe('buildAxDataEntityXml — canonical structure (SourceCode / FieldGroups / DeleteActions / StateMachines)', () => {
  it('standardStructure emits all four, with the default declaration and the five standard field groups', () => {
    const xml = buildAxDataEntityXml('ConDemoEntity', { primaryTable: 'T', fields: [{ name: 'A' }], standardStructure: true });
    expect(xml).toContain('<Declaration><![CDATA[\npublic class ConDemoEntity extends common\n{\n}\n]]></Declaration>');
    expect(xml).toContain('\t\t<Methods />\n');
    expect(xml).toContain('\t<DeleteActions />\n');
    expect(xml).toContain('\t<StateMachines />\n');
    for (const g of REFERENCE.standardFieldGroups) {
      expect(xml).toContain(`<Name>${g.name}</Name>`);
    }
    expect(xml).toMatch(/<Name>AutoIdentification<\/Name>\s*<AutoPopulate>Yes<\/AutoPopulate>\s*<Fields \/>/);
  });

  it('honours a caller-supplied declaration and methods', () => {
    const xml = buildAxDataEntityXml('ConDemoImportTargetEntity', {
      primaryTable: 'T',
      fields: [{ name: 'DocumentCode' }],
      declaration: 'public class ConDemoImportTargetEntity extends common\n{\n}',
      methods: [
        { name: 'validateWrite', source: '    public boolean validateWrite()\n    {\n        return super();\n    }' },
        { name: 'postLoad', source: '    public void postLoad()\n    {\n        super();\n    }' },
      ],
    });
    expect(xml).toContain('<Name>validateWrite</Name>');
    expect(xml).toContain('<Name>postLoad</Name>');
    expect(xml).toContain('public boolean validateWrite()');
    expect(xml).not.toContain('<Methods />');
    // Passing methods implies the canonical skeleton.
    expect(xml).toContain('\t<DeleteActions />\n');
  });

  it('honours caller-supplied field groups, including an empty list', () => {
    const withCustom = buildAxDataEntityXml('E', {
      primaryTable: 'T',
      fields: [{ name: 'A' }],
      fieldGroups: [{ name: 'AutoReport', fields: ['A'] }],
    });
    expect(withCustom).toMatch(
      /<AxTableFieldGroup>\s*<Name>AutoReport<\/Name>\s*<Fields>\s*<AxTableFieldGroupField>\s*<DataField>A<\/DataField>/,
    );
    expect(withCustom).not.toContain('AutoBrowse');

    const empty = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }], fieldGroups: [] });
    expect(empty).toContain('\t<FieldGroups />\n');
  });

  it('dynamicFields marks the root query data source', () => {
    const xml = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }], dynamicFields: true });
    expect(xml).toMatch(/<AxQuerySimpleRootDataSource>\s*<Name>T<\/Name>\s*<DynamicFields>Yes<\/DynamicFields>\s*<Table>T<\/Table>/);
  });
});

describe('buildAxDataEntityXml — backward compatibility (byte-identical without the new properties)', () => {
  // Frozen copies of the output this builder produced before the opt-in properties
  // were added (commit 7e5c59d). Any drift here is a silent break for every existing caller.
  // One deliberate deviation since: the two DataManagementEnabled=No/empty default lines
  // are gone from the skeleton (see the header — 0 of 2662 shipped entities write them).
  const BASELINE_SKELETON = `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConSmallItemEntity</Name>
\t<Label>ConSmallItemEntity</Label>
\t<EntityCategory>Transaction</EntityCategory>
\t<IsPublic>Yes</IsPublic>
\t<PublicCollectionName>ConSmallItemEntityCollection</PublicCollectionName>
\t<PublicEntityName>ConSmallItemEntity</PublicEntityName>
\t<Fields />
\t<Keys />
\t<Mappings />
\t<Ranges />
\t<Relations />
\t<ViewMetadata />
</AxDataEntityView>
`;

  const BASELINE_FULL = `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConSmallItemEntity</Name>
\t<Label>@Lbl:X</Label>
\t<DataManagementEnabled>Yes</DataManagementEnabled>
\t<DataManagementStagingTable>ConSmallItemEntityStaging</DataManagementStagingTable>
\t<EntityCategory>Master</EntityCategory>
\t<IsPublic>Yes</IsPublic>
\t<PrimaryKey>EntityKey</PrimaryKey>
\t<PublicCollectionName>ConSmallItemEntityCollection</PublicCollectionName>
\t<PublicEntityName>ConSmallItemEntity</PublicEntityName>
\t<Fields>
\t\t<AxDataEntityViewField xmlns=""
\t\t\ti:type="AxDataEntityViewMappedField">
\t\t\t<Name>ItemId</Name>
\t\t\t<DataField>ItemId</DataField>
\t\t\t<DataSource>ConSmallItem</DataSource>
\t\t</AxDataEntityViewField>
\t\t<AxDataEntityViewField xmlns=""
\t\t\ti:type="AxDataEntityViewMappedField">
\t\t\t<Name>Name</Name>
\t\t\t<DataField>ItemName</DataField>
\t\t\t<DataSource>ConSmallItem</DataSource>
\t\t</AxDataEntityViewField>
\t</Fields>
\t<Keys>
\t\t<AxDataEntityViewKey>
\t\t\t<Name>EntityKey</Name>
\t\t\t<Fields>
\t\t\t\t<AxDataEntityViewKeyField>
\t\t\t\t\t<DataField>ItemId</DataField>
\t\t\t\t</AxDataEntityViewKeyField>
\t\t\t</Fields>
\t\t</AxDataEntityViewKey>
\t</Keys>
\t<Mappings />
\t<Ranges />
\t<Relations />
\t<ViewMetadata>
\t\t<Name>Metadata</Name>
\t\t<SourceCode>
\t\t\t<Methods>
\t\t\t\t<Method>
\t\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t\t<Source><![CDATA[
[Query]
public class Metadata extends QueryRun
{
}
]]></Source>
\t\t\t\t</Method>
\t\t\t</Methods>
\t\t</SourceCode>
\t\t<DataSources>
\t\t\t<AxQuerySimpleRootDataSource>
\t\t\t\t<Name>ConSmallItem</Name>
\t\t\t\t<Table>ConSmallItem</Table>
\t\t\t\t<DataSources />
\t\t\t\t<DerivedDataSources />
\t\t\t\t<Fields>
\t\t\t\t\t<AxQuerySimpleDataSourceField>
\t\t\t\t\t\t<Name>ItemId</Name>
\t\t\t\t\t\t<Field>ItemId</Field>
\t\t\t\t\t</AxQuerySimpleDataSourceField>
\t\t\t\t\t<AxQuerySimpleDataSourceField>
\t\t\t\t\t\t<Name>ItemName</Name>
\t\t\t\t\t\t<Field>ItemName</Field>
\t\t\t\t\t</AxQuerySimpleDataSourceField>
\t\t\t\t</Fields>
\t\t\t\t<Ranges />
\t\t\t\t<GroupBy />
\t\t\t\t<Having />
\t\t\t\t<OrderBy />
\t\t\t</AxQuerySimpleRootDataSource>
\t\t</DataSources>
\t</ViewMetadata>
</AxDataEntityView>
`;

  it('skeleton branch is byte-identical to the pre-change output', () => {
    expect(buildAxDataEntityXml('ConSmallItemEntity')).toBe(BASELINE_SKELETON);
    expect(buildAxDataEntityXml('ConSmallItemEntity', {})).toBe(BASELINE_SKELETON);
  });

  it('full branch is byte-identical to the pre-change output', () => {
    const xml = buildAxDataEntityXml('ConSmallItemEntity', {
      primaryTable: 'ConSmallItem',
      fields: [{ name: 'ItemId' }, { name: 'Name', dataField: 'ItemName' }],
      label: '@Lbl:X',
      entityCategory: 'Master',
      primaryKeyField: 'ItemId',
      dataManagementEnabled: true,
    });
    expect(xml).toBe(BASELINE_FULL);
  });

  it('none of the new elements leak in when the caller opts into nothing', () => {
    const xml = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }] });
    const emitted = topLevelElements(xml);
    for (const el of ['SourceCode', 'DeleteActions', 'FieldGroups', 'StateMachines', 'AllowRowVersionChangeTracking']) {
      expect(emitted).not.toContain(el);
    }
    expect(xml).not.toContain('DynamicFields');
    // ViewMetadata's nested <SourceCode> is pre-existing and must survive.
    expect(xml).toContain('\t\t<SourceCode>');
  });
});
