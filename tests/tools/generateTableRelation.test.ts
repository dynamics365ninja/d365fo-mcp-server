import { describe, it, expect } from 'vitest';
import { buildTableRelationXml, type TableRelationSpec } from '../../src/tools/xml/generateTableRelation';

describe('buildTableRelationXml', () => {
  const rel: TableRelationSpec = {
    name: 'ItemId',
    relatedTable: 'InventTable',
    constraints: [{ field: 'ItemId', relatedField: 'ItemId' }],
  };

  it('emits the standard relation shell with defaults', () => {
    const xml = buildTableRelationXml(rel);
    expect(xml).toContain('<Name>ItemId</Name>');
    expect(xml).toContain('<Cardinality>ZeroMore</Cardinality>');
    expect(xml).toContain('<RelatedTable>InventTable</RelatedTable>');
    expect(xml).toContain('<RelatedTableCardinality>ExactlyOne</RelatedTableCardinality>');
    expect(xml).toContain('<RelationshipType>Association</RelationshipType>');
  });

  it('emits constraints with the namespace-resetting i:type', () => {
    const xml = buildTableRelationXml(rel);
    expect(xml).toContain('<AxTableRelationConstraint xmlns="" i:type="AxTableRelationConstraintField">');
    expect(xml).toContain('<Field>ItemId</Field>');
    expect(xml).toContain('<RelatedField>ItemId</RelatedField>');
  });

  it('honours overrides and multiple constraints', () => {
    const xml = buildTableRelationXml({
      name: 'Dim',
      relatedTable: 'DimTable',
      cardinality: 'ExactlyOne',
      relationshipType: 'Composition',
      constraints: [
        { field: 'A', relatedField: 'A' },
        { field: 'B', relatedField: 'B' },
      ],
    });
    expect(xml).toContain('<Cardinality>ExactlyOne</Cardinality>');
    expect(xml).toContain('<RelationshipType>Composition</RelationshipType>');
    expect((xml.match(/<AxTableRelationConstraint/g) ?? []).length).toBe(2);
  });

  it('emits a self-closed Constraints element when there are none', () => {
    const xml = buildTableRelationXml({ name: 'X', relatedTable: 'T', constraints: [] });
    expect(xml).toContain('<Constraints />');
  });
});
