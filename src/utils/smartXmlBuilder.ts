/**
 * Smart XML Builder
 * Helper class for building D365FO XML structures (AxTable, AxForm)
 * with proper formatting and structure
 */

import { FormPatternTemplates, FormPattern } from './formPatternTemplates.js';
import { ensureXppDocComment } from './xppDocGen.js';
import { decodeXmlEntitiesFromXppSource } from '../tools/modifyD365File.js';
import { type FieldControlMap, controlForField } from './fieldControlTypes.js';
import { renderAxTableProperties } from './axTablePropertyOrder.js';

export interface TableFieldSpec {
  name: string;
  edt?: string;
  type?: string;
  mandatory?: boolean;
  label?: string;
  /** Enum name for enum-backed fields (AxTableFieldEnum). When set, the field emits
   *  <EnumType> instead of <ExtendedDataType>. */
  enumType?: string;
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
  /** Explicit AxForm control i:type override (e.g. 'AxFormComboBoxControl' for an enum field). */
  iType?: string;
  /** Explicit <Type> value override paired with {@link iType} (e.g. 'ComboBox'). */
  typeValue?: string;
}

/**
 * Read-only view of the mined property_stats table (XppSymbolIndex satisfies
 * this structurally). Populated during build-database from standard Microsoft
 * models, so majority values track the indexed platform version — a reindex of
 * a new PU updates the defaults without touching this code.
 */
export interface MinedPropertyStats {
  getPropertyValueDistribution(
    nodeType: string,
    property: string,
    limit?: number,
  ): Array<{ value: string; count: number }>;
}

export class SmartXmlBuilder {
  /** When omitted (or the stats are empty) the builder falls back to its static, BP-validated defaults. */
  constructor(private readonly stats?: MinedPropertyStats) {}

  /** Majority value mined from standard models, or undefined when no statistics exist. */
  private minedMajority(nodeType: string, property: string): string | undefined {
    try {
      const dist = this.stats?.getPropertyValueDistribution(nodeType, property, 1) ?? [];
      return dist[0]?.value;
    } catch {
      return undefined; // stats are best-effort — never fail generation
    }
  }

  /**
   * Build AxTable XML with fields, indexes, and relations.
   * Structure validated against real D365FO AOT XML (K:\AosService\PackagesLocalDirectory).
   */
  buildTableXml(spec: {
    name: string;
    label?: string;
    tableGroup?: string;
    /**
     * Table storage type. Defined by the TableType property (source: MSDN).
     *   Regular / RegularTable — DEFAULT. Permanent table stored in the main database. Omit from XML (it is the default).
     *   TempDB                 — Temporary table in SQL Server's TempDB database. Dropped when no longer used
     *                            by the current method. Joins and set operations are efficient.
     *   InMemory               — Temporary ISAM file on the AOS/client tier; SQL Server has no connection to it.
     *                            Joins and set operations are usually INEFFICIENT. Equivalent to the old
     *                            "Temporary" property from AX 2009.
     * ⚠️ NEVER pass 'TempDB' or 'InMemory' as the `tableGroup` parameter —
     *    those are NOT valid TableGroup values. Use `tableType` instead.
     */
    tableType?: string;
    fields: TableFieldSpec[];
    indexes?: TableIndexSpec[];
    relations?: TableRelationSpec[];
    methods?: Array<{ name: string; source: string }>;
  }): string {
    const { name, label, tableGroup, tableType, fields, indexes, relations, methods } = spec;

    let xml = `<?xml version="1.0" encoding="utf-8"?>\n`;
    xml += `<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n`;
    xml += `\t<Name>${name}</Name>\n`;

    // <SourceCode> must be the first child of <AxTable> (D365FO AOT requirement)
    xml += `\t<SourceCode>\n`;
    xml += `\t\t<Declaration><![CDATA[\n/// <summary>\n/// The <c>${name}</c> table.\n/// </summary>\npublic class ${name} extends common\n{\n}\n]]></Declaration>\n`;
    if (methods && methods.length > 0) {
      xml += `\t\t<Methods>\n`;
      xml += methods
        .map(m => `\t\t\t<Method>\n\t\t\t\t<Name>${m.name}</Name>\n\t\t\t\t<Source><![CDATA[\n${ensureXppDocComment(decodeXmlEntitiesFromXppSource(m.source))}\n\n]]></Source>\n\t\t\t</Method>`)
        .join('\n\n') + '\n';
      xml += `\t\t</Methods>\n`;
    } else {
      xml += `\t\t<Methods />\n`;
    }
    xml += `\t</SourceCode>\n`;

    // 'RegularTable' is the default and is omitted from XML.
    const normalizedTableType = tableType && tableType.toLowerCase() !== 'regulartable' ? tableType : '';
    const isTempTable = normalizedTableType === 'TempDB' || normalizedTableType === 'InMemory';

    // 'TempDB'/'InMemory' are TableType values, not valid TableGroup values.
    if (tableGroup === 'TempDB' || tableGroup === 'InMemory') {
      throw new Error(
        `❌ Invalid TableGroup value "${tableGroup}". ` +
        `'TempDB' and 'InMemory' are values for the TableType property, NOT for TableGroup. ` +
        `Valid TableGroup values: Main | Transaction | Parameter | Group | Reference | ` +
        `Miscellaneous | WorksheetHeader | WorksheetLine | Framework. ` +
        `To create a temporary table pass tableType="${tableGroup}" and keep tableGroup empty or set it to 'Main'.`
      );
    }

    // System enum TableGroup values (source: MSDN / D365FO AOT):
    //   Miscellaneous (default), Main, Transaction, Parameter, Group,
    //   WorksheetHeader, WorksheetLine, Reference, Framework.
    // TempDB/InMemory tables default to 'Main'; regular tables default to the
    // majority value mined from the indexed standard models, else 'Main'.
    const effectiveTableGroup = tableGroup
      || (isTempTable ? 'Main' : this.minedMajority('AxTable', 'TableGroup'))
      || 'Main';

    // BP rule: CacheLookup must be set to avoid the "CacheLookup should be set" BP
    // warning. TempDB/InMemory tables are session-scoped, not in SQL Server → never cached.
    const cacheLookupMap: Record<string, string> = {
      Parameter:       'Found',
      Group:           'Found',
      Main:            'Found',
      Transaction:     'None',
      WorksheetHeader: 'None',
      WorksheetLine:   'None',
      Miscellaneous:   'NotInTTS',
      Framework:       'Found',
    };
    const cacheLookup = isTempTable
      ? 'None'
      : (cacheLookupMap[effectiveTableGroup] || 'Found');

    const titleCandidates = fields.filter(f => f.name !== 'RecId').slice(0, 2);
    const uniqueIdx = indexes?.find(i => i.unique);
    // BP rule: a table needs a ClusteredIndex to avoid the "no clustered index" warning.
    const clusteredIdx = indexes?.find(i => i.clustered) || uniqueIdx;

    // The property block is rendered in CANONICAL ORDER. It used to be written in the
    // order the BP rules were reasoned about (CacheLookup and SaveDataPerCompany
    // before TableGroup/TitleField1, ClusteredIndex after ReplacementKey) — and
    // AxTable XML DROPS a misordered property SILENTLY, so the very BP defaults this
    // builder exists to set were at risk of being discarded
    // (docs/eval-sweep-findings-2026-07-21.md #13; canonical order proven by the
    // VM-captured golden eval/goldens/L1-table-basic).
    xml += renderAxTableProperties({
      Label: label ? this.escapeXml(label) : undefined,
      TableGroup: effectiveTableGroup,
      TitleField1: titleCandidates[0]?.name,
      TitleField2: titleCandidates[1]?.name,
      CacheLookup: cacheLookup,
      ClusteredIndex: clusteredIdx?.name,
      PrimaryIndex: uniqueIdx?.name,
      ReplacementKey: uniqueIdx?.name,
      // BP rule: TempDB/InMemory tables are session-scoped, not company-scoped.
      SaveDataPerCompany: isTempTable ? 'No' : 'Yes',
      TableType: normalizedTableType || undefined,
    });

    // BP rule: relations require matching DeleteActions to avoid a BP warning.
    if (relations && relations.length > 0) {
      xml += `\t<DeleteActions>\n`;
      for (const rel of relations) {
        xml += `\t\t<AxTableDeleteAction>\n`;
        xml += `\t\t\t<Name>${rel.targetTable}</Name>\n`;
        xml += `\t\t\t<Table>${rel.targetTable}</Table>\n`;
        xml += `\t\t\t<DeleteAction>Restricted</DeleteAction>\n`;
        xml += `\t\t</AxTableDeleteAction>\n`;
      }
      xml += `\t</DeleteActions>\n`;
    } else {
      xml += `\t<DeleteActions />\n`;
    }

    // 5 standard FieldGroups required by the D365FO project system, in AOT order:
    // AutoReport, AutoLookup, AutoIdentification, AutoSummary, AutoBrowse.
    // BP rule: AutoReport must not be empty.
    const autoReportFields = fields.filter(f => f.name !== 'RecId').slice(0, 5);
    xml += `\t<FieldGroups>\n`;

    xml += `\t\t<AxTableFieldGroup>\n`;
    xml += `\t\t\t<Name>AutoReport</Name>\n`;
    if (autoReportFields.length > 0) {
      xml += `\t\t\t<Fields>\n`;
      for (const f of autoReportFields) {
        xml += `\t\t\t\t<AxTableFieldGroupField>\n`;
        xml += `\t\t\t\t\t<DataField>${f.name}</DataField>\n`;
        xml += `\t\t\t\t</AxTableFieldGroupField>\n`;
      }
      xml += `\t\t\t</Fields>\n`;
    } else {
      xml += `\t\t\t<Fields />\n`;
    }
    xml += `\t\t</AxTableFieldGroup>\n`;

    const autoLookupFields = fields.filter(f => f.name !== 'RecId').slice(0, 3);
    xml += `\t\t<AxTableFieldGroup>\n`;
    xml += `\t\t\t<Name>AutoLookup</Name>\n`;
    if (autoLookupFields.length > 0) {
      xml += `\t\t\t<Fields>\n`;
      for (const f of autoLookupFields) {
        xml += `\t\t\t\t<AxTableFieldGroupField>\n`;
        xml += `\t\t\t\t\t<DataField>${f.name}</DataField>\n`;
        xml += `\t\t\t\t</AxTableFieldGroupField>\n`;
      }
      xml += `\t\t\t</Fields>\n`;
    } else {
      xml += `\t\t\t<Fields />\n`;
    }
    xml += `\t\t</AxTableFieldGroup>\n`;
    // AutoIdentification requires AutoPopulate=Yes.
    xml += `\t\t<AxTableFieldGroup>\n`;
    xml += `\t\t\t<Name>AutoIdentification</Name>\n`;
    xml += `\t\t\t<AutoPopulate>Yes</AutoPopulate>\n`;
    xml += `\t\t\t<Fields />\n`;
    xml += `\t\t</AxTableFieldGroup>\n`;
    for (const groupName of ['AutoSummary', 'AutoBrowse']) {
      xml += `\t\t<AxTableFieldGroup>\n`;
      xml += `\t\t\t<Name>${groupName}</Name>\n`;
      xml += `\t\t\t<Fields />\n`;
      xml += `\t\t</AxTableFieldGroup>\n`;
    }
    xml += `\t</FieldGroups>\n`;

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
   * Build AxForm XML by delegating to the pattern-specific template builder.
   *
   * Each D365FO form pattern has a pre-defined, structurally validated skeleton
   * (ActionPane, QuickFilter, Grid style, etc.) derived from real AOT reference forms.
   *
   * Supported patterns: SimpleList | SimpleListDetails | DetailsMaster |
   *   DetailsTransaction | Dialog | TableOfContents | Lookup
   * Default: SimpleList (most common for new setup/configuration tables)
   */
  buildFormXml(spec: {
    name: string;
    label?: string;
    caption?: string;
    dataSources: FormDataSourceSpec[];
    controls?: FormControlSpec[];
    formPattern?: string;
    gridFields?: string[];
    sections?: Array<{ name: string; caption: string }>;
    linesDsName?: string;
    linesDsTable?: string;
  }): string {
    const { name, label, caption, dataSources, formPattern, gridFields, sections, linesDsName, linesDsTable } = spec;

    const primaryDs = dataSources[0];
    const pattern: FormPattern = formPattern
      ? FormPatternTemplates.normalizePattern(formPattern)
      : this.defaultFormPattern();

    return FormPatternTemplates.build(pattern, {
      formName: name,
      dsName: primaryDs?.name,
      dsTable: primaryDs?.table,
      caption: caption || label,
      gridFields: gridFields || [],
      sections,
      linesDsName,
      linesDsTable,
    });
  }

  /**
   * Default form pattern when the caller does not specify one: the most common
   * AxFormDesign.Pattern mined from the indexed standard models, normalized to
   * a supported template. Static fallback: SimpleList (most common for new
   * setup/configuration tables).
   */
  defaultFormPattern(): FormPattern {
    const mined = this.minedMajority('AxFormDesign', 'Pattern');
    return mined ? FormPatternTemplates.normalizePattern(mined) : 'SimpleList';
  }

  /**
   * Build AxForm XML for a specific pattern directly.
   * Convenience wrapper exposing FormPatternTemplates to callers that already
   * know the pattern (e.g. generateSmartForm.ts).
   */
  buildFormXmlForPattern(
    pattern: FormPattern,
    formName: string,
    dsName?: string,
    dsTable?: string,
    caption?: string,
    gridFields?: string[],
    sections?: Array<{ name: string; caption: string }>,
    linesDsName?: string,
    linesDsTable?: string,
  ): string {
    return FormPatternTemplates.build(pattern, {
      formName, dsName, dsTable, caption, gridFields: gridFields || [],
      sections, linesDsName, linesDsTable,
    });
  }

  /**
   * Build table field XML node.
   * D365FO uses generic <AxTableField xmlns="" i:type="AxTableFieldString"> format,
   * NOT typed element names like <AxTableFieldString>.
   */
  private buildTableField(field: TableFieldSpec): string {
    const { name, edt, type, mandatory, label, enumType } = field;

    // Enum-backed fields use AxTableFieldEnum + <EnumType>, never <ExtendedDataType>.
    const iType = enumType ? 'AxTableFieldEnum' : this.getAxTableFieldType(edt, type);

    let xml = `\t\t<AxTableField xmlns=""\n\t\t\t\ti:type="${iType}">\n`;
    xml += `\t\t\t<Name>${name}</Name>\n`;
    if (enumType) {
      xml += `\t\t\t<EnumType>${enumType}</EnumType>\n`;
    } else if (edt) {
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
   *
   * Order of precedence:
   *  1. Explicit `type` (primitive base type from DB or caller) — most accurate
   *  2. EDT name heuristics — fallback when type is not known
   */
  private getAxTableFieldType(edt?: string, type?: string): string {
    if (type) {
      const typeMap: Record<string, string> = {
        String:      'AxTableFieldString',
        Integer:     'AxTableFieldInt',
        Int64:       'AxTableFieldInt64',
        Real:        'AxTableFieldReal',
        Date:        'AxTableFieldDate',
        DateTime:    'AxTableFieldUtcDateTime',
        UtcDateTime: 'AxTableFieldUtcDateTime',
        Enum:        'AxTableFieldEnum',
        Container:   'AxTableFieldContainer',
        Guid:        'AxTableFieldGuid',
        GUID:        'AxTableFieldGuid',
      };
      const mapped = typeMap[type];
      if (mapped) return mapped;
    }

    // Fall back to EDT name heuristics
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
      xml += `\t\t\t<AlternateKey>Yes</AlternateKey>\n`;
      // BP rule: AllowDuplicates must be No for unique indexes.
      xml += `\t\t\t<AllowDuplicates>No</AllowDuplicates>\n`;
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
  public buildFormDataSource(ds: FormDataSourceSpec): string {
    const { name, table, allowEdit, allowCreate, allowDelete } = ds;

    let xml = `\t\t<AxFormDataSource xmlns="">\n`;
    xml += `\t\t\t<Name>${name}</Name>\n`;
    xml += `\t\t\t<Table>${table}</Table>\n`;
    // Empty <Fields /> means all table fields are available in the datasource.
    xml += `\t\t\t<Fields />\n`;
    xml += `\t\t\t<ReferencedDataSources />\n`;
    // AllowCreate/Edit/Delete must come after ReferencedDataSources to match AOT XML order.
    if (allowCreate === false) xml += `\t\t\t<AllowCreate>No</AllowCreate>\n`;
    if (allowEdit === false)   xml += `\t\t\t<AllowEdit>No</AllowEdit>\n`;
    if (allowDelete === false)  xml += `\t\t\t<AllowDelete>No</AllowDelete>\n`;
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
  public buildFormControl(control: FormControlSpec, indentLevel: number): string {
    const { name, type, properties, children } = control;
    const indent = '\t'.repeat(indentLevel);
    const i1 = indent + '\t';

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
    // An explicit per-control override (set by buildGridControl for typed fields)
    // wins over the coarse FormControlSpec.type mapping.
    const mapped = control.iType && control.typeValue
      ? { iType: control.iType, typeValue: control.typeValue }
      : typeMap[type] ?? { iType: 'AxFormStringControl', typeValue: 'String' };

    let xml = `${indent}<AxFormControl xmlns=""\n${indent}\ti:type="${mapped.iType}">\n`;
    xml += `${i1}<Name>${name}</Name>\n`;
    xml += `${i1}<Type>${mapped.typeValue}</Type>\n`;
    // FormControlExtension is mandatory on every control.
    xml += `${i1}<FormControlExtension\n${i1}\ti:nil="true" />\n`;

    if (properties) {
      for (const [key, value] of Object.entries(properties)) {
        xml += `${i1}<${key}>${this.escapeXml(value)}</${key}>\n`;
      }
    }

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
  buildGridControl(name: string, dataSource: string, fields: string[], fieldTypes?: FieldControlMap): FormControlSpec {
    const gridChildren: FormControlSpec[] = fields.map(field => {
      // Resolve control type per field (enum -> ComboBox, date -> Date, etc.);
      // unknown fields fall back to a string control.
      const ctl = controlForField(field, fieldTypes);
      return {
        // Prefix with dataSource to avoid name collisions when multiple grids exist.
        name: `${dataSource}_${field}`,
        type: 'String' as const,
        iType: ctl.iType,
        typeValue: ctl.typeValue,
        properties: {
          // DataField must come before DataSource to match AOT XML element order.
          DataField: field,
          DataSource: dataSource,
        },
      };
    });

    return {
      name,
      type: 'Grid',
      properties: {
        DataSource: dataSource,
        Style: 'Tabular',
      },
      children: gridChildren,
    };
  }
}

// Re-exported so callers can import pattern types from this module directly.
export { FormPatternTemplates } from './formPatternTemplates.js';
export type { FormPattern, FormTemplateOptions } from './formPatternTemplates.js';
