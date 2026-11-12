/**
 * The metadata a reference group is decided on: a form's data source tables, a table
 * field's type and EDT, its relation to RecId, an EDT's links and a table's replacement
 * key. Fixtures follow the shipped SalesTable / HcmWorker / SalesTaker shapes.
 */

import { describe, it, expect } from 'vitest';
import {
  edtLinks, formDataSourceTables, recIdRelation, replacementKey, tableField,
} from '../../src/tools/xml/surrogateForeignKey';

const SALES_TABLE = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>SalesTable</Name>
\t<Fields>
\t\t<AxTableField xmlns="" i:type="AxTableFieldString">
\t\t\t<Name>SalesId</Name>
\t\t\t<ExtendedDataType>SalesId</ExtendedDataType>
\t\t</AxTableField>
\t\t<AxTableField xmlns="" i:type="AxTableFieldInt64">
\t\t\t<Name>WorkerSalesTaker</Name>
\t\t\t<AssetClassification>Customer Content</AssetClassification>
\t\t\t<ExtendedDataType>SalesTaker</ExtendedDataType>
\t\t</AxTableField>
\t</Fields>
\t<Relations>
\t\t<AxTableRelation>
\t\t\t<Name>CustTable</Name>
\t\t\t<RelatedTable>CustTable</RelatedTable>
\t\t\t<Constraints>
\t\t\t\t<AxTableRelationConstraint xmlns="" i:type="AxTableRelationConstraintField">
\t\t\t\t\t<Name>CustAccount</Name>
\t\t\t\t\t<Field>CustAccount</Field>
\t\t\t\t\t<RelatedField>AccountNum</RelatedField>
\t\t\t\t</AxTableRelationConstraint>
\t\t\t</Constraints>
\t\t</AxTableRelation>
\t\t<AxTableRelation>
\t\t\t<Name>WorkerSalesTaker_FK</Name>
\t\t\t<Cardinality>ZeroMore</Cardinality>
\t\t\t<RelatedTable>HcmWorker</RelatedTable>
\t\t\t<Constraints>
\t\t\t\t<AxTableRelationConstraint xmlns="" i:type="AxTableRelationConstraintField">
\t\t\t\t\t<Name>WorkerSalesTaker</Name>
\t\t\t\t\t<Field>WorkerSalesTaker</Field>
\t\t\t\t\t<RelatedField>RecId</RelatedField>
\t\t\t\t</AxTableRelationConstraint>
\t\t\t</Constraints>
\t\t</AxTableRelation>
\t</Relations>
</AxTable>`;

describe('tableField', () => {
  it('returns the i:type and EDT, matching the name in any casing', () => {
    expect(tableField(SALES_TABLE, 'workersalestaker')).toEqual({ iType: 'AxTableFieldInt64', edt: 'SalesTaker' });
    expect(tableField(SALES_TABLE, 'SalesId')).toEqual({ iType: 'AxTableFieldString', edt: 'SalesId' });
  });

  it('returns null for a field the file does not have, or a file without fields', () => {
    expect(tableField(SALES_TABLE, 'ContosoNope')).toBeNull();
    expect(tableField('<AxTable><Name>T</Name></AxTable>', 'X')).toBeNull();
  });
});

describe('recIdRelation', () => {
  it('finds the relation that links the field to RecId', () => {
    expect(recIdRelation(SALES_TABLE, 'WorkerSalesTaker')).toEqual({ name: 'WorkerSalesTaker_FK', relatedTable: 'HcmWorker' });
  });

  it('ignores a relation on a natural key (CustAccount -> AccountNum)', () => {
    expect(recIdRelation(SALES_TABLE, 'CustAccount')).toBeNull();
  });
});

describe('edtLinks and replacementKey', () => {
  it('reads Extends and ReferenceTable of an EDT', () => {
    const edt = `<AxEdt xmlns:i="http://www.w3.org/2001/XMLSchema-instance" i:type="AxEdtInt64">
\t<Name>HcmWorkerRecId</Name>
\t<Extends>RefRecId</Extends>
\t<ReferenceTable>HcmWorker</ReferenceTable>
</AxEdt>`;
    expect(edtLinks(edt)).toEqual({ extends: 'RefRecId', referenceTable: 'HcmWorker' });
    expect(edtLinks('<AxEdt><Name>SalesTaker</Name><Extends>HcmWorkerRecId</Extends></AxEdt>'))
      .toEqual({ extends: 'HcmWorkerRecId', referenceTable: undefined });
  });

  it('reads a table\'s ReplacementKey, and nothing when it has none', () => {
    expect(replacementKey('<AxTable><Name>HcmWorker</Name><ReplacementKey>HcmWorker_AK2</ReplacementKey></AxTable>'))
      .toBe('HcmWorker_AK2');
    expect(replacementKey('<AxTable><Name>ContosoLog</Name></AxTable>')).toBeUndefined();
  });
});

describe('formDataSourceTables', () => {
  it('maps each data source to its table, from a form and from what an extension adds', () => {
    const form = `<AxForm><Name>SalesTable</Name><DataSources>
\t<AxFormDataSource xmlns=""><Name>SalesTable</Name><Table>SalesTable</Table></AxFormDataSource>
\t<AxFormDataSource xmlns=""><Name>SalesLine_ds</Name><Table>SalesLine</Table></AxFormDataSource>
</DataSources></AxForm>`;
    const map = formDataSourceTables(form);
    expect(map.get('salesline_ds')).toBe('SalesLine');
    expect(map.get('salestable')).toBe('SalesTable');
  });
});
