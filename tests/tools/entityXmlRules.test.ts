import { describe, it, expect } from 'vitest';
import { runRules } from '../../src/tools/analysis/validateXpp.js';

const entity = (childBody: string) => `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>ContosoRentEquipmentEntity</Name>
	<ViewMetadata>
		<Name>Metadata</Name>
		<DataSources>
			<AxQuerySimpleRootDataSource>
				<Name>ContosoRentEquipmentTable</Name>
				<Table>ContosoRentEquipmentTable</Table>
				<DataSources>
					<AxQuerySimpleEmbeddedDataSource>
						<Name>ContosoRentEquipmentLine</Name>
						<Table>ContosoRentEquipmentLine</Table>
						<DataSources />
						<DerivedDataSources />
						${childBody}
					</AxQuerySimpleEmbeddedDataSource>
				</DataSources>
				<DerivedDataSources />
			</AxQuerySimpleRootDataSource>
		</DataSources>
	</ViewMetadata>
</AxDataEntityView>`;

const staging = (cols: string[], alt = 'Yes') => `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>ContosoRentEquipmentStaging</Name>
	<Fields>
		<AxTableField><Name>DefinitionGroup</Name></AxTableField>
		<AxTableField><Name>ExecutionId</Name></AxTableField>
		<AxTableField><Name>EquipmentId</Name></AxTableField>
	</Fields>
	<Indexes>
		<AxTableIndex>
			<Name>StagingIdx</Name>
			<AlternateKey>${alt}</AlternateKey>
			<Fields>
${cols.map(c => `				<AxTableIndexField><DataField>${c}</DataField></AxTableIndexField>`).join('\n')}
			</Fields>
		</AxTableIndex>
	</Indexes>
</AxTable>`;

const rule = (xml: string, type: 'xml-any' | 'xml-table', id: string) =>
  runRules(xml, type).filter(v => v.rule === id);

describe('ENT001 entity child data source without relations (#1285)', () => {
  it('warns on UseRelations=Yes with empty Relations', () => {
    const v = rule(entity('<JoinMode>OuterJoin</JoinMode><UseRelations>Yes</UseRelations><Relations />'), 'xml-any', 'ENT001');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('warning');
    expect(v[0].excerpt).toContain('ContosoRentEquipmentLine');
  });

  it('warns when Relations element is absent', () => {
    expect(rule(entity('<UseRelations>Yes</UseRelations>'), 'xml-any', 'ENT001')).toHaveLength(1);
  });

  it('is quiet with an explicit relation', () => {
    const rel = '<UseRelations>Yes</UseRelations><Relations><AxQuerySimpleDataSourceRelation>' +
      '<Field>EquipmentId</Field><JoinDataSource>ContosoRentEquipmentTable</JoinDataSource>' +
      '<RelatedField>EquipmentId</RelatedField></AxQuerySimpleDataSourceRelation></Relations>';
    expect(rule(entity(rel), 'xml-any', 'ENT001')).toHaveLength(0);
  });

  it('is quiet without UseRelations', () => {
    expect(rule(entity('<Relations />'), 'xml-any', 'ENT001')).toHaveLength(0);
  });

  it('never fires on the root data source', () => {
    const xml = entity('').replace('<DataSources />\n\t\t\t\t<DerivedDataSources />\n\t\t\t</AxQuerySimpleRootDataSource>',
      '<UseRelations>Yes</UseRelations></AxQuerySimpleRootDataSource>');
    expect(rule(xml, 'xml-any', 'ENT001')).toHaveLength(0);
  });
});

describe('XML011 staging alternate key (#1285)', () => {
  it('warns when the alternate key has ExecutionId but no DefinitionGroup', () => {
    const v = rule(staging(['ExecutionId']), 'xml-table', 'XML011');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('warning');
  });

  it('stays quiet on (DefinitionGroup, ExecutionId): shipped single-row parameter entities use it', () => {
    expect(rule(staging(['DefinitionGroup', 'ExecutionId']), 'xml-table', 'XML011')).toHaveLength(0);
  });

  it('is quiet for DefinitionGroup, ExecutionId and a key field', () => {
    expect(rule(staging(['DefinitionGroup', 'ExecutionId', 'EquipmentId']), 'xml-table', 'XML011')).toHaveLength(0);
  });

  it('ignores non-alternate-key indexes and non-staging tables', () => {
    expect(rule(staging(['ExecutionId'], 'No'), 'xml-table', 'XML011')).toHaveLength(0);
    const plain = staging(['ExecutionId']).replace('<Name>ExecutionId</Name>', '<Name>Other</Name>');
    expect(rule(plain, 'xml-table', 'XML011')).toHaveLength(0);
  });
});
