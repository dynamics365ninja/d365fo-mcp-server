/**
 * Smart XML Builder
 * Helper class for building D365FO XML structures (AxTable, AxForm)
 * with proper formatting and structure
 */

export interface TableFieldSpec {
  name: string;
  edt?: string;
  type?: string;
  mandatory?: boolean;
  label?: string;
}

export interface TableIndexSpec {
  name: string;
  fields: string[];
  unique?: boolean;
  clustered?: boolean;
}

export interface TableRelationSpec {
  name: string;
  targetTable: string;
  constraints: Array<{ field: string; relatedField: string }>;
}

export interface FormDataSourceSpec {
  name: string;
  table: string;
  allowEdit?: boolean;
  allowCreate?: boolean;
  allowDelete?: boolean;
}

export interface FormControlSpec {
  name: string;
  type: 'Grid' | 'Group' | 'String' | 'Int64' | 'Real' | 'Date' | 'DateTime' | 'Button' | 'ActionPane';
  properties?: Record<string, string>;
  children?: FormControlSpec[];
}

export class SmartXmlBuilder {
  /**
   * Build AxTable XML with fields, indexes, and relations.
   * Structure validated against real D365FO AOT XML (K:\AosService\PackagesLocalDirectory).
   */
  buildTableXml(spec: {
    name: string;
    label?: string;
    tableGroup?: string;
    fields: TableFieldSpec[];
    indexes?: TableIndexSpec[];
    relations?: TableRelationSpec[];
    methods?: Array<{ name: string; source: string }>;
  }): string {
    const { name, label, tableGroup, fields, indexes, relations, methods } = spec;

    let xml = `<?xml version="1.0" encoding="utf-8"?>\n`;
    xml += `<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n`;
    xml += `\t<Name>${name}</Name>\n`;

    // <SourceCode> MUST be first child of <AxTable> — D365FO AOT requirement
    xml += `\t<SourceCode>\n`;
    xml += `\t\t<Declaration><![CDATA[\npublic class ${name} extends common\n{\n}\n]]></Declaration>\n`;
    if (methods && methods.length > 0) {
      xml += `\t\t<Methods>\n`;
      for (const method of methods) {
        xml += `\t\t\t<Method>\n`;
        xml += `\t\t\t\t<Name>${method.name}</Name>\n`;
        xml += `\t\t\t\t<Source><![CDATA[\n${method.source}\n]]></Source>\n`;
        xml += `\t\t\t</Method>\n`;
      }
      xml += `\t\t</Methods>\n`;
    } else {
      xml += `\t\t<Methods />\n`;
    }
    xml += `\t</SourceCode>\n`;

    // Table metadata (after SourceCode)
    if (label) {
      xml += `\t<Label>${this.escapeXml(label)}</Label>\n`;
    }
    xml += `\t<TableGroup>${tableGroup || 'Main'}</TableGroup>\n`;

    // TitleField1/TitleField2: first two non-RecId fields
    const titleCandidates = fields.filter(f => f.name !== 'RecId').slice(0, 2);
    if (titleCandidates[0]) xml += `\t<TitleField1>${titleCandidates[0].name}</TitleField1>\n`;
    if (titleCandidates[1]) xml += `\t<TitleField2>${titleCandidates[1].name}</TitleField2>\n`;

    // PrimaryIndex and ReplacementKey reference the unique index name
    const uniqueIdx = indexes?.find(i => i.unique);
    if (uniqueIdx) {
      xml += `\t<PrimaryIndex>${uniqueIdx.name}</PrimaryIndex>\n`;
      xml += `\t<ReplacementKey>${uniqueIdx.name}</ReplacementKey>\n`;
    }

    // Required D365FO sections — must all be present
    xml += `\t<DeleteActions />\n`;

    // 5 standard FieldGroups required by VS D365FO project system
    xml += `\t<FieldGroups>\n`;
    for (const groupName of ['AutoReport', 'AutoLookup', 'AutoSummary', 'AutoBrowse']) {
      xml += `\t\t<AxTableFieldGroup>\n`;
      xml += `\t\t\t<Name>${groupName}</Name>\n`;
      xml += `\t\t\t<Fields />\n`;
      xml += `\t\t</AxTableFieldGroup>\n`;
    }
    // AutoIdentification requires AutoPopulate=Yes
    xml += `\t\t<AxTableFieldGroup>\n`;
    xml += `\t\t\t<Name>AutoIdentification</Name>\n`;
    xml += `\t\t\t<AutoPopulate>Yes</AutoPopulate>\n`;
    xml += `\t\t\t<Fields />\n`;
    xml += `\t\t</AxTableFieldGroup>\n`;
    xml += `\t</FieldGroups>\n`;

    // Fields
    if (fields.length > 0) {
      xml += `\t<Fields>\n`;
      for (const field of fields) {
        xml += this.buildTableField(field);
      }
      xml += `\t</Fields>\n`;
    } else {
      xml += `\t<Fields />\n`;
    }

    xml += `\t<FullTextIndexes />\n`;

    // Indexes
    if (indexes && indexes.length > 0) {
      xml += `\t<Indexes>\n`;
      for (const index of indexes) {
        xml += this.buildTableIndex(index);
      }
      xml += `\t</Indexes>\n`;
    } else {
      xml += `\t<Indexes />\n`;
    }

    xml += `\t<Mappings />\n`;

    // Relations
    if (relations && relations.length > 0) {
      xml += `\t<Relations>\n`;
      for (const relation of relations) {
        xml += this.buildTableRelation(relation);
      }
      xml += `\t</Relations>\n`;
    } else {
      xml += `\t<Relations />\n`;
    }

    xml += `\t<StateMachines />\n`;
    xml += `</AxTable>\n`;
    return xml;
  }

  /**
   * Build AxForm XML with datasources and controls.
   * Structure validated against real D365FO AOT XML (K:\AosService\PackagesLocalDirectory).
   */
  buildFormXml(spec: {
    name: string;
    label?: string;
    caption?: string;
    dataSources: FormDataSourceSpec[];
    controls?: FormControlSpec[];
  }): string {
    const { name, label, caption, dataSources, controls } = spec;

    let xml = `<?xml version="1.0" encoding="utf-8"?>\n`;
    // D365FO forms require the Microsoft.Dynamics.AX.Metadata.V6 default namespace
    xml += `<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">\n`;
    xml += `\t<Name>${name}</Name>\n`;

    // <SourceCode> with classDeclaration method is required by D365FO forms
    xml += `\t<SourceCode>\n`;
    xml += `\t\t<Methods xmlns="">\n`;
    xml += `\t\t\t<Method>\n`;
    xml += `\t\t\t\t<Name>classDeclaration</Name>\n`;
    xml += `\t\t\t\t<Source><!\[CDATA[\n    [Form]\n    public class ${name} extends FormRun\n    {\n    }\n]]></Source>\n`;
    xml += `\t\t\t</Method>\n`;
    xml += `\t\t</Methods>\n`;
    // These xmlns="" sections track form-level code overrides
    xml += `\t\t<DataSources xmlns="" />\n`;
    xml += `\t\t<DataControls xmlns="" />\n`;
    xml += `\t\t<Members xmlns="" />\n`;
    xml += `\t</SourceCode>\n`;

    if (label) {
      xml += `\t<Label>${this.escapeXml(label)}</Label>\n`;
    }

    // DataSources (outside SourceCode — form runtime datasources)
    if (dataSources.length > 0) {
      xml += `\t<DataSources>\n`;
      for (const ds of dataSources) {
        xml += this.buildFormDataSource(ds);
      }
      xml += `\t</DataSources>\n`;
    } else {
      xml += `\t<DataSources />\n`;
    }

    // Design
    const primaryDs = dataSources[0];
    xml += `\t<Design>\n`;
    if (caption || label) {
      xml += `\t\t<Caption xmlns="">${this.escapeXml(caption || label || name)}</Caption>\n`;
    }
    if (primaryDs) {
      xml += `\t\t<DataSource xmlns="">${primaryDs.name}</DataSource>\n`;
      xml += `\t\t<Pattern xmlns="">SimpleList</Pattern>\n`;
      xml += `\t\t<PatternVersion xmlns="">1.1</PatternVersion>\n`;
      xml += `\t\t<Style xmlns="">SimpleList</Style>\n`;
    }
    xml += `\t\t<Controls xmlns="">\n`;
    if (controls && controls.length > 0) {
      for (const control of controls) {
        xml += this.buildFormControl(control, 3);
      }
    }
    xml += `\t\t</Controls>\n`;
    xml += `\t</Design>\n`;

    xml += `\t<Parts />\n`;
    xml += `</AxForm>\n`;
    return xml;
  }

  /**
   * Build table field XML node.
   * D365FO uses generic <AxTableField xmlns="" i:type="AxTableFieldString"> format,
   * NOT typed element names like <AxTableFieldString>.
   */
  private buildTableField(field: TableFieldSpec): string {
    const { name, edt, type, mandatory, label } = field;

    const iType = this.getAxTableFieldType(edt, type);

    // D365FO field format: <AxTableField xmlns="" i:type="AxTableFieldString">
    let xml = `\t\t<AxTableField xmlns=""\n\t\t\t\ti:type="${iType}">\n`;
    xml += `\t\t\t<Name>${name}</Name>\n`;
    if (edt) {
      xml += `\t\t\t<ExtendedDataType>${edt}</ExtendedDataType>\n`;
    }
    if (mandatory) {
      xml += `\t\t\t<Mandatory>Yes</Mandatory>\n`;
    }
    if (label) {
      xml += `\t\t\t<Label>${this.escapeXml(label)}</Label>\n`;
    }
    xml += `\t\t</AxTableField>\n`;
    return xml;
  }

  /**
   * Map EDT/type hint to D365FO AxTableField i:type attribute value.
   * Based on real XML analysis from K:\AosService\PackagesLocalDirectory.
   */
  private getAxTableFieldType(edt?: string, type?: string): string {
    if (edt) {
      const e = edt.toLowerCase();
      if (e === 'recid' || e.endsWith('recid') || e.includes('refrecid')) return 'AxTableFieldInt64';
      if (e.includes('utcdatetime') || (e.includes('datetime') && !e.includes('transdate'))) return 'AxTableFieldUtcDateTime';
      if ((e.includes('date') && !e.includes('time') && !e.includes('update'))) return 'AxTableFieldDate';
      if (e.includes('amount') || e.includes('mst') || e.includes('price') || e.includes('qty')
          || e.includes('percent') || e === 'real') return 'AxTableFieldReal';
      if (e === 'noyesid' || e.endsWith('noyesid') || e === 'noyes') return 'AxTableFieldEnum';
      if ((e.endsWith('int') || e.includes('count') || e.includes('level'))
          && !e.includes('account') && !e.includes('name')) return 'AxTableFieldInt';
    }
    if (type) {
      const typeMap: Record<string, string> = {
        String: 'AxTableFieldString',
        Integer: 'AxTableFieldInt',
        Int64: 'AxTableFieldInt64',
        Real: 'AxTableFieldReal',
        Date: 'AxTableFieldDate',
        DateTime: 'AxTableFieldUtcDateTime',
        Enum: 'AxTableFieldEnum',
        Container: 'AxTableFieldContainer',
        Guid: 'AxTableFieldGuid',
      };
      return typeMap[type] || 'AxTableFieldString';
    }
    return 'AxTableFieldString';
  }

  /**
   * Build table index XML node.
   * D365FO uses <AlternateKey>Yes</AlternateKey> for unique indexes — NOT <AllowDuplicates>No>.
   */
  private buildTableIndex(index: TableIndexSpec): string {
    const { name, fields, unique } = index;

    let xml = `\t\t<AxTableIndex>\n`;
    xml += `\t\t\t<Name>${name}</Name>\n`;
    if (unique) {
      // AlternateKey=Yes marks the index as a unique surrogate/alternate key
      xml += `\t\t\t<AlternateKey>Yes</AlternateKey>\n`;
    }
    xml += `\t\t\t<Fields>\n`;
    for (const fieldName of fields) {
      xml += `\t\t\t\t<AxTableIndexField>\n`;
      xml += `\t\t\t\t\t<DataField>${fieldName}</DataField>\n`;
      xml += `\t\t\t\t</AxTableIndexField>\n`;
    }
    xml += `\t\t\t</Fields>\n`;
    xml += `\t\t</AxTableIndex>\n`;
    return xml;
  }

  /**
   * Build table relation XML node.
   * Constraints use <AxTableRelationConstraint xmlns="" i:type="AxTableRelationConstraintField">.
   */
  private buildTableRelation(relation: TableRelationSpec): string {
    const { name, targetTable, constraints } = relation;

    let xml = `\t\t<AxTableRelation>\n`;
    xml += `\t\t\t<Name>${name}</Name>\n`;
    xml += `\t\t\t<Cardinality>ZeroMore</Cardinality>\n`;
    xml += `\t\t\t<RelatedTable>${targetTable}</RelatedTable>\n`;
    xml += `\t\t\t<RelatedTableCardinality>ExactlyOne</RelatedTableCardinality>\n`;
    xml += `\t\t\t<RelationshipType>Association</RelationshipType>\n`;
    xml += `\t\t\t<Constraints>\n`;
    for (const constraint of constraints) {
      // Constraints require xmlns="" and i:type to override the default XML namespace
      xml += `\t\t\t\t<AxTableRelationConstraint xmlns=""\n\t\t\t\t\t\ti:type="AxTableRelationConstraintField">\n`;
      xml += `\t\t\t\t\t<Name>${constraint.field}</Name>\n`;
      xml += `\t\t\t\t\t<Field>${constraint.field}</Field>\n`;
      xml += `\t\t\t\t\t<RelatedField>${constraint.relatedField}</RelatedField>\n`;
      xml += `\t\t\t\t</AxTableRelationConstraint>\n`;
    }
    xml += `\t\t\t</Constraints>\n`;
    xml += `\t\t</AxTableRelation>\n`;
    return xml;
  }

  /**
   * Build form datasource XML node.
   * D365FO: <AxFormDataSource xmlns=""> required to override default form namespace.
   */
  private buildFormDataSource(ds: FormDataSourceSpec): string {
    const { name, table, allowEdit, allowCreate, allowDelete } = ds;

    // xmlns="" resets the default namespace (AxForm root has xmlns="Microsoft.Dynamics.AX.Metadata.V6")
    let xml = `\t\t<AxFormDataSource xmlns="">\n`;
    xml += `\t\t\t<Name>${name}</Name>\n`;
    xml += `\t\t\t<Table>${table}</Table>\n`;
    if (allowEdit === false) xml += `\t\t\t<AllowEdit>No</AllowEdit>\n`;
    if (allowCreate === false) xml += `\t\t\t<AllowCreate>No</AllowCreate>\n`;
    if (allowDelete === false) xml += `\t\t\t<AllowDelete>No</AllowDelete>\n`;
    // Empty <Fields /> means all table fields are available in the datasource
    xml += `\t\t\t<Fields />\n`;
    xml += `\t\t\t<ReferencedDataSources />\n`;
    xml += `\t\t\t<DataSourceLinks />\n`;
    xml += `\t\t\t<DerivedDataSources />\n`;
    xml += `\t\t</AxFormDataSource>\n`;
    return xml;
  }

  /**
   * Build form control XML node (recursive).
   * D365FO: <AxFormControl xmlns="" i:type="AxFormStringControl"> with required Type and
   * FormControlExtension properties. xmlns="" resets default form namespace.
   */
  private buildFormControl(control: FormControlSpec, indentLevel: number): string {
    const { name, type, properties, children } = control;
    const indent = '\t'.repeat(indentLevel);
    const i1 = indent + '\t';

    // Map FormControlSpec.type to D365FO i:type attribute and <Type> element value
    const typeMap: Record<string, { iType: string; typeValue: string }> = {
      Grid:       { iType: 'AxFormGridControl',       typeValue: 'Grid' },
      Group:      { iType: 'AxFormGroupControl',      typeValue: 'Group' },
      String:     { iType: 'AxFormStringControl',     typeValue: 'String' },
      Int64:      { iType: 'AxFormInt64Control',      typeValue: 'Int64' },
      Real:       { iType: 'AxFormRealControl',       typeValue: 'Real' },
      Date:       { iType: 'AxFormDateControl',       typeValue: 'Date' },
      DateTime:   { iType: 'AxFormDateTimeControl',   typeValue: 'DateTime' },
      Button:     { iType: 'AxFormButtonControl',     typeValue: 'Button' },
      ActionPane: { iType: 'AxFormActionPaneControl', typeValue: 'ActionPane' },
    };
    const mapped = typeMap[type] ?? { iType: 'AxFormStringControl', typeValue: 'String' };

    // All AxFormControl nodes need xmlns="" to override the AxForm default namespace
    let xml = `${indent}<AxFormControl xmlns=""\n${indent}\ti:type="${mapped.iType}">\n`;
    xml += `${i1}<Name>${name}</Name>\n`;
    xml += `${i1}<Type>${mapped.typeValue}</Type>\n`;
    // FormControlExtension is mandatory on every control
    xml += `${i1}<FormControlExtension\n${i1}\ti:nil="true" />\n`;

    // Additional D365FO properties (DataField, DataSource, etc.)
    if (properties) {
      for (const [key, value] of Object.entries(properties)) {
        xml += `${i1}<${key}>${this.escapeXml(value)}</${key}>\n`;
      }
    }

    // Child controls
    if (children && children.length > 0) {
      xml += `${i1}<Controls>\n`;
      for (const child of children) {
        xml += this.buildFormControl(child, indentLevel + 2);
      }
      xml += `${i1}</Controls>\n`;
    }

    xml += `${indent}</AxFormControl>\n`;
    return xml;
  }

  /**
   * Escape XML special characters
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Generate primary key index for table
   */
  buildPrimaryKeyIndex(tableName: string, fields: string[]): TableIndexSpec {
    return {
      name: `${tableName}Idx`,
      fields,
      unique: true,
      clustered: false,
    };
  }

  /**
   * Generate form grid control with fields
   */
  buildGridControl(name: string, dataSource: string, fields: string[]): FormControlSpec {
    const gridChildren: FormControlSpec[] = fields.map(field => ({
      name: field,
      type: 'String',
      properties: {
        DataSource: dataSource,
        DataField: field,
      },
    }));

    return {
      name,
      type: 'Grid',
      properties: {
        DataSource: dataSource,
      },
      children: gridChildren,
    };
  }
}
