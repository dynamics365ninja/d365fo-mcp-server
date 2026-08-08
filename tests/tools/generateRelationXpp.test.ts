import { describe, it, expect } from 'vitest';
import {
  buildRelationSelect,
  buildRelationQuery,
  buildRelationXpp,
  type RelationShape,
} from '../../src/tools/smart/generateRelationXpp';

const custRel: RelationShape = {
  name: 'CustTable',
  relatedTable: 'CustTable',
  constraints: [{ field: 'CustAccount', relatedField: 'AccountNum' }],
};

const compositeRel: RelationShape = {
  name: 'InventDim',
  relatedTable: 'InventDim',
  constraints: [
    { field: 'InventDimId', relatedField: 'InventDimId' },
    { relatedField: 'DataAreaId', value: 'curext()' },
  ],
};

describe('buildRelationSelect', () => {
  it('builds a select joining related table on field == relatedField', () => {
    const code = buildRelationSelect('SalesLine', custRel);
    expect(code).toContain('CustTable custTable;');
    expect(code).toContain('select firstonly custTable');
    expect(code).toContain('where custTable.AccountNum == salesLine.CustAccount;');
  });

  it('chains composite + fixed-value constraints', () => {
    const code = buildRelationSelect('SalesLine', compositeRel);
    expect(code).toContain('inventDim.InventDimId == salesLine.InventDimId');
    expect(code).toContain('&& inventDim.DataAreaId == curext()');
  });
});

describe('buildRelationQuery', () => {
  it('emits addRange driven by the source buffer', () => {
    const code = buildRelationQuery('SalesLine', custRel);
    expect(code).toContain('QueryBuildDataSource qbdsCustTable = query.addDataSource(tableNum(CustTable));');
    expect(code).toContain('qbdsCustTable.addRange(fieldNum(CustTable, AccountNum))');
    expect(code).toContain('.value(queryValue(salesLine.CustAccount));');
  });

  it('uses literal value for fixed-value constraints', () => {
    const code = buildRelationQuery('SalesLine', compositeRel);
    expect(code).toContain('.value(queryValue(curext()));');
  });
});

describe('buildRelationXpp', () => {
  it('includes both forms with a heading when style=both', () => {
    const code = buildRelationXpp('SalesLine', custRel, 'both');
    expect(code).toContain('// Relation: CustTable → CustTable');
    expect(code).toContain('select firstonly custTable');
    expect(code).toContain('// As a query range:');
    expect(code).toContain('QueryBuildDataSource');
  });

  it('omits the query form when style=select', () => {
    const code = buildRelationXpp('SalesLine', custRel, 'select');
    expect(code).toContain('select firstonly');
    expect(code).not.toContain('QueryBuildDataSource');
  });
});
