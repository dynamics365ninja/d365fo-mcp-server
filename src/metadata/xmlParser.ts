/**
 * X++ Metadata XML Parser
 * Parses D365 F&O AOT XML files (AxClass, AxTable, etc.)
 */

import * as fs from 'fs/promises';
import { Parser } from 'xml2js';
import type {
  XppParseResult,
  XppClassInfo,
  XppTableInfo,
  XppViewInfo,
  XppMethodInfo,
  XppParameterInfo,
  XppFieldInfo,
  XppIndexInfo,
  XppRelationInfo,
  XppViewFieldInfo,
  XppViewRelationFieldInfo,
  XppViewRelationInfo,
} from './types.js';
import { EnhancedXppParser } from './enhancedParser.js';
import { walkFormDesign, collectPatternNodes } from './formPatternMiner.js';
import {
  parseXppDeclaration,
  parseXppClassHeader,
  blankCommentsAndStrings,
  type XppDeclaration,
  type XppClassHeader,
} from './xppDeclaration.js';

export class XppMetadataParser {
  private parser: Parser;
  private enhancedParser: EnhancedXppParser;

  constructor() {
    this.parser = new Parser({
      explicitArray: false,
      mergeAttrs: true,
      trim: true,
    });
    this.enhancedParser = new EnhancedXppParser();
  }

  /**
   * Parse an X++ class file (AxClass XML)
   */
  async parseClassFile(filePath: string, model?: string): Promise<XppParseResult<XppClassInfo>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = await this.parser.parseStringPromise(content);

      if (!parsed.AxClass) {
        return { success: false, error: 'Not a valid AxClass file' };
      }

      const axClass = parsed.AxClass;
      const className = axClass.Name || 'UnknownClass';

      // Methods are nested in SourceCode.Methods.Method
      const methodsData = axClass.SourceCode?.Methods?.Method || axClass.Methods?.Method;

      const parsedMethods = this.parseMethods(methodsData, className);

      // Inheritance lives in the Declaration CDATA as X++ text, not in XML
      // elements — see parseXppClassHeader. The element reads are kept only as
      // a fallback for hand-written/synthetic AxClass XML in tests and tools.
      const header = parseXppClassHeader(this.cdataText(axClass.SourceCode?.Declaration));

      const parsedImplements = header?.implements.length
        ? header.implements
        : this.parseImplements(axClass.Implements);
      const parsedDeclaration = this.extractClassDeclaration(axClass, header);
      const isAbstract = header?.isAbstract
        ?? (axClass.IsAbstract === 'Yes' || axClass.IsAbstract === 'true');
      const isFinal = header?.isFinal
        ?? (axClass.IsFinal === 'Yes' || axClass.IsFinal === 'true');
      const extendsClass = header?.extends || axClass.Extends || undefined;

      const classInfoBase = {
        name: className,
        model: model || 'Unknown',
        sourcePath: filePath,
        extends: extendsClass,
        implements: parsedImplements,
        isAbstract,
        isFinal,
        declaration: parsedDeclaration,
        methods: parsedMethods,
        documentation: axClass.DeveloperDocumentation || undefined,
      };

      const classInfo: XppClassInfo = {
        ...classInfoBase,
        tags: this.enhancedParser.generateClassTags({ ...classInfoBase, methods: [] }),
        usedTypes: this.enhancedParser.extractClassDependencies(classInfoBase),
        description: axClass.DeveloperDocumentation || `${className} class${extendsClass ? ` extending ${extendsClass}` : ''}`,
      };

      return { success: true, data: classInfo };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Parse an X++ table file (AxTable XML)
   */
  async parseTableFile(filePath: string, model?: string): Promise<XppParseResult<XppTableInfo>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = await this.parser.parseStringPromise(content);

      if (!parsed.AxTable) {
        return { success: false, error: 'Not a valid AxTable file' };
      }

      const axTable = parsed.AxTable;
      const tableName = axTable.Name || 'UnknownTable';

      const tableInfo: XppTableInfo = {
        name: tableName,
        model: model || 'Unknown',
        sourcePath: filePath,
        label: axTable.Label || tableName,
        tableGroup: axTable.TableGroup || 'Main',
        primaryIndex: axTable.PrimaryIndex || undefined,
        clusteredIndex: axTable.ClusteredIndex || undefined,
        fields: this.parseFields(axTable.Fields?.AxTableField),
        indexes: this.parseIndexes(axTable.Indexes?.AxTableIndex),
        relations: this.parseRelations(axTable.Relations?.AxTableRelation),
        methods: this.parseMethods(axTable.SourceCode?.Methods?.Method, tableName),
      };

      return { success: true, data: tableInfo };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Parse an X++ view/data entity file (AxView or AxDataEntityView XML)
   */
  async parseViewFile(filePath: string, model?: string): Promise<XppParseResult<XppViewInfo>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = await this.parser.parseStringPromise(content);

      const axView = parsed.AxDataEntityView || parsed.AxView;
      if (!axView) {
        return { success: false, error: 'Not a valid AxView/AxDataEntityView file' };
      }

      const isDataEntity = !!parsed.AxDataEntityView;
      const viewName = axView.Name || 'UnknownView';

      const viewInfo: XppViewInfo = {
        name: viewName,
        model: model || 'Unknown',
        sourcePath: filePath,
        type: isDataEntity ? 'data-entity' : 'view',
        label: axView.Label || undefined,
        isPublic: axView.IsPublic === 'Yes' || axView.IsPublic === 'true',
        isReadOnly: axView.IsReadOnly === 'Yes' || axView.IsReadOnly === 'true',
        primaryKey: axView.PrimaryKey || undefined,
        primaryKeyFields: this.parseViewPrimaryKeyFields(axView.Keys, axView.PrimaryKey),
        fields: this.parseViewFields(axView.Fields),
        relations: this.parseViewRelations(axView.Relations),
        methods: this.parseMethods(axView.SourceCode?.Methods?.Method, viewName),
      };

      return { success: true, data: viewInfo };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Text of a CDATA-bearing element. xml2js hands back a plain string, unless
   * the element carries an attribute (mergeAttrs) — then the text sits under
   * `_` and the raw value is an object.
   */
  private cdataText(node: unknown): string {
    if (typeof node === 'string') return node;
    const text = (node as { _?: unknown } | null | undefined)?._;
    return typeof text === 'string' ? text : '';
  }

  private parseImplements(implementsStr?: string | any): string[] {
    if (!implementsStr) return [];
    if (typeof implementsStr !== 'string') return [];
    return implementsStr.split(',').map(i => i.trim()).filter(Boolean);
  }

  /**
   * The class's declaration line. Rebuilt from the parsed Declaration CDATA so
   * it reflects what the source actually says; falls back to synthesising one
   * from XML elements when there is no declaration to read.
   */
  private extractClassDeclaration(axClass: any, header?: XppClassHeader | null): string {
    const modifiers: string[] = [];
    if (header) {
      if (header.isAbstract) modifiers.push('abstract');
      if (header.isFinal) modifiers.push('final');
      let decl = modifiers.length > 0 ? `${modifiers.join(' ')} ` : '';
      decl += `${header.kind} ${header.name}`;
      if (header.extends) decl += ` extends ${header.extends}`;
      if (header.implements.length) decl += ` implements ${header.implements.join(', ')}`;
      return decl;
    }

    if (axClass.IsAbstract === 'Yes' || axClass.IsAbstract === 'true') modifiers.push('abstract');
    if (axClass.IsFinal === 'Yes' || axClass.IsFinal === 'true') modifiers.push('final');

    let decl = modifiers.length > 0 ? `${modifiers.join(' ')} ` : '';
    decl += `class ${axClass.Name}`;
    if (axClass.Extends) decl += ` extends ${axClass.Extends}`;
    if (axClass.Implements) decl += ` implements ${axClass.Implements}`;

    return decl;
  }

  private parseMethods(methodsData: any, parentClass: string = 'Unknown'): XppMethodInfo[] {
    if (!methodsData) return [];

    const methods = Array.isArray(methodsData) ? methodsData : [methodsData];
    return methods.map(method => {
      const source = method.Source || '';
      const methodName = method.Name || 'unknown';
      const decl = parseXppDeclaration(source, methodName);

      const baseMethod: XppMethodInfo = {
        name: methodName,
        visibility: this.parseVisibility(method.Visibility),
        returnType: decl?.returnType || method.ReturnType || 'void',
        parameters: this.toParameterInfo(decl),
        isStatic: decl?.modifiers.includes('static') ?? false,
        source: source,
        documentation: method.DeveloperDocumentation || undefined,
      };

      return this.enhancedParser.parseMethodEnhanced(baseMethod, parentClass);
    });
  }

  private parseVisibility(vis?: string): 'public' | 'private' | 'protected' {
    if (!vis) return 'public';
    const lower = vis.toLowerCase();
    if (lower === 'private') return 'private';
    if (lower === 'protected') return 'protected';
    return 'public';
  }

  /**
   * Parses <AxTableField i:type="AxTableFieldString"> nodes; the field type
   * comes from the i:type XML attribute (field.$['i:type']), not an element.
   */
  private parseFields(fieldsData: any): XppFieldInfo[] {
    if (!fieldsData) return [];

    const fields = Array.isArray(fieldsData) ? fieldsData : [fieldsData];
    return fields.map(field => {
      const rawType: string = field.$?.['i:type'] || 'AxTableFieldString';
      const xppType = rawType.replace('AxTableField', '') || 'String';
      return {
        name: field.Name || 'unknown',
        type: xppType,
        extendedDataType: field.ExtendedDataType || undefined,
        enumType: field.EnumType || undefined,
        mandatory: field.Mandatory === 'Yes' || field.Mandatory === 'true',
        label: field.Label || undefined,
      };
    });
  }

  private parseIndexes(indexesData: any): XppIndexInfo[] {
    if (!indexesData) return [];

    const indexes = Array.isArray(indexesData) ? indexesData : [indexesData];
    return indexes.map(index => ({
      name: index.Name || 'unknown',
      fields: this.parseIndexFields(index.Fields),
      // Uniqueness is marked via AlternateKey, not AllowDuplicates
      unique: index.AlternateKey === 'Yes' || index.AlternateKey === 'true',
      clustered: index.IsClustered === 'Yes' || index.IsClustered === 'true',
    }));
  }

  private parseIndexFields(fieldsStr?: string | any): string[] {
    if (!fieldsStr) return [];

    if (fieldsStr.AxTableIndexField) {
      const indexFields = Array.isArray(fieldsStr.AxTableIndexField)
        ? fieldsStr.AxTableIndexField
        : [fieldsStr.AxTableIndexField];

      return indexFields
        .map((field: any) => field?.DataField || field?.Name || '')
        .filter((field: string) => !!field);
    }

    if (typeof fieldsStr !== 'string') {
      if (Array.isArray(fieldsStr)) {
        return fieldsStr
          .map((field: any) => {
            if (typeof field === 'string') {
              return field;
            }

            if (field?.DataField) {
              return field.DataField;
            }

            if (field?.Name) {
              return field.Name;
            }

            return '';
          })
          .filter(Boolean);
      }
      return [];
    }

    return fieldsStr.split(',').map(f => f.trim()).filter(Boolean);
  }

  private parseRelations(relationsData: any): XppRelationInfo[] {
    if (!relationsData) return [];

    const relations = Array.isArray(relationsData) ? relationsData : [relationsData];
    return relations.map(rel => ({
      name: rel.Name || 'unknown',
      relatedTable: rel.RelatedTable || 'unknown',
      constraints: this.parseConstraints(rel.Constraints),
    }));
  }

  private parseConstraints(constraintsData: any): any[] {
    if (!constraintsData) return [];

    const constraintNodes = constraintsData.AxTableRelationConstraint
      ? (Array.isArray(constraintsData.AxTableRelationConstraint)
        ? constraintsData.AxTableRelationConstraint
        : [constraintsData.AxTableRelationConstraint])
      : (Array.isArray(constraintsData) ? constraintsData : [constraintsData]);

    return constraintNodes.map((constraint: any) => ({
      field: constraint.Field || '',
      relatedField: constraint.RelatedField || '',
    }));
  }

  private parseViewFields(fieldsData: any): XppViewFieldInfo[] {
    if (!fieldsData) return [];

    const entityFields = this.ensureArray(fieldsData.AxDataEntityViewField);
    const viewFields = this.ensureArray(fieldsData.AxViewField);
    const allFields = [...entityFields, ...viewFields];

    return allFields.map((field: any) => ({
      name: field.Name || 'unknown',
      dataSource: field.DataSource || undefined,
      dataField: field.DataField || undefined,
      dataMethod: field.DataMethod || undefined,
      labelId: this.extractLabelId(field.Label),
      isComputed: !!field.DataMethod,
    }));
  }

  private parseViewRelations(relationsData: any): XppViewRelationInfo[] {
    if (!relationsData) return [];

    const entityRelations = this.ensureArray(relationsData.AxDataEntityViewRelation);
    const viewRelations = this.ensureArray(relationsData.AxViewRelation);
    const allRelations = [...entityRelations, ...viewRelations];

    return allRelations.map((relation: any) => ({
      name: relation.Name || 'unknown',
      relatedTable: relation.RelatedDataEntity || relation.RelatedTable || 'unknown',
      relationType: relation.RelationType || 'Unknown',
      cardinality: relation.Cardinality || 'Unknown',
      fields: this.parseViewRelationFields(relation),
    }));
  }

  private parseViewPrimaryKeyFields(keysData: any, primaryKeyName?: string): string[] {
    if (!keysData) return [];

    const keys = this.ensureArray(keysData.AxDataEntityViewKey);
    const keyNode = primaryKeyName
      ? keys.find((key: any) => key.Name === primaryKeyName)
      : keys[0];

    if (!keyNode || !keyNode.Fields) return [];

    const keyFields = this.ensureArray(keyNode.Fields.AxDataEntityViewKeyField);
    return keyFields
      .map((field: any) => field.DataField || field.Name || '')
      .filter((field: string) => !!field);
  }

  private parseViewRelationFields(relation: any): XppViewRelationFieldInfo[] {
    const mappings: XppViewRelationFieldInfo[] = [];

    const relationFields = this.ensureArray(relation?.Fields?.AxDataEntityViewRelationField);
    for (const field of relationFields) {
      mappings.push({
        field: field.DataField || field.Field || field.Name || '',
        relatedField: field.RelatedDataField || field.RelatedField || '',
      });
    }

    const constraints = this.ensureArray(relation?.Constraints?.AxDataEntityViewRelationConstraint);
    for (const constraint of constraints) {
      mappings.push({
        field: constraint.DataField || constraint.Field || '',
        relatedField: constraint.RelatedDataField || constraint.RelatedField || '',
      });
    }

    return mappings.filter(mapping => !!mapping.field || !!mapping.relatedField);
  }

  private extractLabelId(labelValue?: string): string | undefined {
    if (!labelValue || typeof labelValue !== 'string') return undefined;
    const trimmed = labelValue.trim();
    if (!trimmed.startsWith('@')) return undefined;
    return trimmed;
  }

  private ensureArray<T>(value: T | T[] | undefined): T[] {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  /** Declaration parameters narrowed to the shape XppMethodInfo carries. */
  private toParameterInfo(decl: XppDeclaration | null): XppParameterInfo[] {
    return decl?.parameters.map(p => ({ type: p.type, name: p.name })) ?? [];
  }

  /**
   * Parse Form XML file (AxForm)
   */
  async parseFormFile(filePath: string, model?: string): Promise<XppParseResult<any>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = await this.parser.parseStringPromise(content);

      if (!parsed.AxForm) {
        return { success: false, error: 'Not a valid AxForm file' };
      }

      const axForm = parsed.AxForm;
      const formName = axForm.Name || 'UnknownForm';

      // Extract form info with full structure
      const formInfo: any = {
        name: formName,
        model: model || 'Unknown',
        sourcePath: filePath,
        label: axForm.Label || undefined,
        caption: axForm.Caption || axForm.TitleDatasource || undefined,
        formPattern: undefined, // Will be detected from Design
        formPatternVersion: undefined,
        dataSources: [],
        design: [],
        patternNodes: [],
        methods: [],
      };

      // Extract data sources (top-level <DataSources>, not the SourceCode one)
      // xml2js with explicitArray:false yields a plain object here, never an array.
      if (axForm.DataSources && typeof axForm.DataSources === 'object') {
        formInfo.dataSources = this.extractFormDataSources(axForm.DataSources);
      }

      // Extract design (controls) — Design > Controls > AxFormControl tree,
      // including Pattern/PatternVersion on Design and on container controls.
      if (axForm.Design && typeof axForm.Design === 'object') {
        const designInfo = walkFormDesign(axForm.Design);
        formInfo.design = designInfo.controls;
        formInfo.formPattern = designInfo.pattern || designInfo.style;
        formInfo.formPatternVersion = designInfo.patternVersion;
        formInfo.patternNodes = collectPatternNodes(designInfo);
      }

      // Extract methods — form methods live under SourceCode > Methods > Method
      const methodsNode = axForm.SourceCode?.Methods ?? axForm.Methods;
      if (methodsNode && typeof methodsNode === 'object') {
        formInfo.methods = this.extractFormMethods(methodsNode, formName);
      }

      return { success: true, data: formInfo };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Extract form datasources
   */
  private extractFormDataSources(dataSourcesNode: any): any[] {
    const dataSources: any[] = [];

    // Form XML uses <AxFormDataSource>; AxFormDataSourceRoot kept as legacy fallback
    const dsData = dataSourcesNode.AxFormDataSource || dataSourcesNode.AxFormDataSourceRoot;
    if (!dsData) {
      return dataSources;
    }

    const dsRoots = this.ensureArray(dsData);

    for (const dsNode of dsRoots) {
      const ds: any = {
        name: dsNode.Name || 'Unknown',
        table: dsNode.Table || 'Unknown',
        allowEdit: dsNode.AllowEdit === 'Yes' || dsNode.AllowEdit === 'true',
        allowCreate: dsNode.AllowCreate === 'Yes' || dsNode.AllowCreate === 'true',
        allowDelete: dsNode.AllowDelete === 'Yes' || dsNode.AllowDelete === 'true',
        fields: [],
        methods: [],
      };

      // Extract fields
      if (dsNode.Fields && this.ensureArray(dsNode.Fields).length > 0) {
        const fieldsNode = this.ensureArray(dsNode.Fields)[0];
        if (fieldsNode.AxFormDataSourceField) {
          const fieldNodes = this.ensureArray(fieldsNode.AxFormDataSourceField);
          ds.fields = fieldNodes
            .map((f: any) => f.DataField || 'Unknown')
            .filter((name: string) => name !== 'Unknown');
        }
      }

      // Extract methods
      if (dsNode.Methods && this.ensureArray(dsNode.Methods).length > 0) {
        const methodsNode = this.ensureArray(dsNode.Methods)[0];
        if (methodsNode.Method) {
          const methodNodes = this.ensureArray(methodsNode.Method);
          ds.methods = methodNodes.map((m: any) => m.Name || 'Unknown');
        }
      }

      dataSources.push(ds);
    }

    return dataSources;
  }

  /**
   * Extract form methods
   */
  private extractFormMethods(methodsNode: any, _formName: string): any[] {
    const methods: any[] = [];

    if (!methodsNode.Method) {
      return methods;
    }

    const methodNodes = this.ensureArray(methodsNode.Method);

    for (const methodNode of methodNodes) {
      const name = methodNode.Name || 'Unknown';
      const source = methodNode.Source || '';
      const decl = parseXppDeclaration(source, name);

      // Parse method info (similar to class methods)
      const methodInfo: any = {
        name,
        visibility: 'public', // Forms typically have public methods
        returnType: decl?.returnType || 'void',
        parameters: this.toParameterInfo(decl),
        isStatic: decl?.modifiers.includes('static') ?? false,
        source,
        sourceSnippet: source.split('\n').slice(0, 10).join('\n'),
      };

      methods.push(methodInfo);
    }

    return methods;
  }

  /**
   * Parse EDT XML file (AxEdt)
   */
  async parseEdtFile(filePath: string, model?: string): Promise<XppParseResult<any>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = await this.parser.parseStringPromise(content);

      if (!parsed.AxEdt) {
        return { success: false, error: 'Not a valid AxEdt file' };
      }

      const axEdt = parsed.AxEdt;
      const edtName = axEdt.Name || 'UnknownEDT';

      const getValue = (key: string): string | undefined => {
        const raw = axEdt[key];
        if (!raw) return undefined;
        const value = Array.isArray(raw) ? raw[0] : raw;
        return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
      };

      const edtInfo: any = {
        name: edtName,
        model: model || 'Unknown',
        sourcePath: filePath,
        extends: getValue('Extends'),
        enumType: getValue('EnumType'),
        referenceTable: getValue('ReferenceTable'),
        relationType: getValue('RelationType'),
        stringSize: getValue('StringSize'),
        databaseStringSize: getValue('DatabaseStringSize'),
        displayLength: getValue('DisplayLength'),
        label: getValue('Label'),
        helpText: getValue('HelpText'),
        formHelp: getValue('FormHelp'),
        configurationKey: getValue('ConfigurationKey'),
        alignment: getValue('Alignment'),
        decimalSeparator: getValue('DecimalSeparator'),
        signDisplay: getValue('SignDisplay'),
        noOfDecimals: getValue('NoOfDecimals'),
        additionalProperties: {} as Record<string, string>,
      };

      // Extract additional properties
      const knownProperties = new Set([
        'Name', 'Extends', 'EnumType', 'ReferenceTable', 'RelationType', 'StringSize', 'DisplayLength',
        'DatabaseStringSize',
        'Label', 'HelpText', 'FormHelp', 'ConfigurationKey', 'Alignment', 'DecimalSeparator',
        'SignDisplay', 'NoOfDecimals', 'ArrayElements', 'Relations', 'TableReferences'
      ]);

      for (const [key, value] of Object.entries(axEdt)) {
        if (knownProperties.has(key)) continue;

        const first = Array.isArray(value) ? value[0] : value;
        if (typeof first === 'string' && first.trim().length > 0) {
          edtInfo.additionalProperties[key] = first;
        }
      }

      return { success: true, data: edtInfo };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async parseSecurityPrivilegeFile(filePath: string): Promise<XppParseResult<{
    name: string;
    label?: string;
    sourcePath: string;
    entryPoints: Array<{ name: string; objectName: string; objectType: string; accessLevel: string }>;
  }>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = await this.parser.parseStringPromise(content);
      const root = parsed?.AxSecurityPrivilege;
      if (!root) return { success: false, error: 'Not an AxSecurityPrivilege file' };

      const name: string = root.Name || '';
      const label: string | undefined = root.Label || undefined;

      const rawEps = root.EntryPoints?.AxSecurityEntryPointReference;
      const epArray = rawEps ? (Array.isArray(rawEps) ? rawEps : [rawEps]) : [];
      const entryPoints = epArray.map((ep: any) => {
        // Grant / Access can be a plain string (e.g. "Allow") OR an object
        // ({ Read: "Allow", Create: "Allow", ... }) depending on the XML structure.
        // Normalise to a string so it can be stored as TEXT in SQLite.
        const rawAccess = ep.Grant ?? ep.Access;
        let accessLevel: string;
        if (rawAccess == null) {
          accessLevel = '';
        } else if (typeof rawAccess === 'object') {
          // Serialize to "Read:Allow,Create:Allow,..." form
          accessLevel = Object.entries(rawAccess as Record<string, string>)
            .map(([k, v]) => `${k}:${v}`)
            .join(',');
        } else {
          accessLevel = String(rawAccess);
        }
        return { name: ep.Name || '', objectName: ep.ObjectName || ep.Name || '', objectType: ep.ObjectType || '', accessLevel };
      }).filter((ep: any) => ep.name);

      return { success: true, data: { name, label, sourcePath: filePath, entryPoints } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async parseSecurityDutyFile(filePath: string): Promise<XppParseResult<{
    name: string;
    label?: string;
    sourcePath: string;
    privileges: string[];
  }>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = await this.parser.parseStringPromise(content);
      const root = parsed?.AxSecurityDuty;
      if (!root) return { success: false, error: 'Not an AxSecurityDuty file' };

      const name: string = root.Name || '';
      const label: string | undefined = root.Label || undefined;

      const rawPrivs = root.Privileges?.AxSecurityRolePermissionSet ??
                       root.Privileges?.AxSecurityPrivilegePermissionSet;
      const privArray = rawPrivs ? (Array.isArray(rawPrivs) ? rawPrivs : [rawPrivs]) : [];
      const privileges: string[] = privArray
        .map((p: any) => (typeof p === 'string' ? p : p.Name || ''))
        .filter(Boolean);

      return { success: true, data: { name, label, sourcePath: filePath, privileges } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async parseSecurityRoleFile(filePath: string): Promise<XppParseResult<{
    name: string;
    label?: string;
    description?: string;
    sourcePath: string;
    duties: string[];
  }>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = await this.parser.parseStringPromise(content);
      const root = parsed?.AxSecurityRole;
      if (!root) return { success: false, error: 'Not an AxSecurityRole file' };

      const name: string = root.Name || '';
      const label: string | undefined = root.Label || undefined;
      const description: string | undefined = root.Description || undefined;

      const rawDuties = root.Duties?.AxSecurityRoleDutyPermission ??
                        root.Duties?.AxSecurityDutyPermission;
      const dutyArray = rawDuties ? (Array.isArray(rawDuties) ? rawDuties : [rawDuties]) : [];
      const duties: string[] = dutyArray
        .map((d: any) => (typeof d === 'string' ? d : d.Name || ''))
        .filter(Boolean);

      return { success: true, data: { name, label, description, sourcePath: filePath, duties } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async parseMenuItemFile(
    filePath: string,
    itemType: 'display' | 'action' | 'output',
  ): Promise<XppParseResult<{
    name: string;
    label?: string;
    targetObject?: string;
    targetType?: string;
    securityPrivilege?: string;
    sourcePath: string;
  }>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = await this.parser.parseStringPromise(content);
      const rootKey = itemType === 'display'
        ? 'AxMenuItemDisplay'
        : itemType === 'action'
          ? 'AxMenuItemAction'
          : 'AxMenuItemOutput';
      const root = parsed?.[rootKey];
      if (!root) return { success: false, error: `Not an ${rootKey} file` };

      return {
        success: true,
        data: {
          name: root.Name || '',
          label: root.Label || undefined,
          targetObject: root.Object || undefined,
          targetType: root.ObjectType || undefined,
          securityPrivilege: root.SecurityPrivilege || undefined,
          sourcePath: filePath,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async parseExtensionFile(
    filePath: string,
    extensionType: string,
  ): Promise<XppParseResult<{
    name: string;
    baseObjectName: string;
    sourcePath: string;
    addedFields: string[];
    addedMethods: string[];
    addedIndexes: string[];
    cocMethods: string[];
    eventSubscriptions: string[];
  }>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = await this.parser.parseStringPromise(content);

      // Determine XML root element by extensionType
      const rootKeyMap: Record<string, string> = {
        'table-extension':       'AxTableExtension',
        'class-extension':       'AxClassExtension',
        'form-extension':        'AxFormExtension',
        'enum-extension':        'AxEnumExtension',
        'edt-extension':         'AxEdtExtension',
        'data-entity-extension': 'AxDataEntityViewExtension',
      };
      const rootKey = rootKeyMap[extensionType] || Object.keys(parsed || {})[0] || '';
      const root = parsed?.[rootKey];
      if (!root) return { success: false, error: `Cannot parse extension type: ${extensionType}` };

      const name: string = root.Name || '';

      // No Ax*Extension XML carries <Extends>/<BaseObject> — these reads are a
      // fallback for synthetic XML only. Real files identify the base object
      // either by the [ExtensionOf(<kind>Str(Base))] attribute on the
      // declaration (class extensions) or by the "Base.<Suffix>" name
      // convention (every other kind), so both are read here. Leaving this
      // empty silently kills every extension_metadata lookup keyed on
      // base_object_name — resolve_references' extension-method and
      // table-extension-field checks, and table_extension_info.
      let baseObjectName: string = root.Extends || root.BaseObject || '';

      if (!baseObjectName) {
        // Comments/strings blanked so a mention in a doc comment can't match.
        const decl = blankCommentsAndStrings(this.cdataText(root.SourceCode?.Declaration));
        // Any intrinsic: classStr / tableStr / formStr / enumStr /
        // extendedTypeStr / dataEntityViewStr.
        baseObjectName = decl.match(/ExtensionOf\s*\(\s*\w+Str\s*\(\s*([\w.]+)\s*\)/i)?.[1] || '';
      }

      if (!baseObjectName && name.includes('.')) {
        // "SalesTable.FooExtension" → "SalesTable"; the suffix may itself
        // contain dots ("OMLegalEntity.Extension.Retail"), so split on the first.
        baseObjectName = name.slice(0, name.indexOf('.'));
      }

      // Extract added fields
      const rawFields = root.Fields?.AxTableField ?? root.Fields?.AxEdtField ?? [];
      const fieldArr = Array.isArray(rawFields) ? rawFields : rawFields ? [rawFields] : [];
      const addedFields: string[] = fieldArr.map((f: any) => f.Name || '').filter(Boolean);

      // Extract added indexes
      const rawIndexes = root.Indexes?.AxTableIndex ?? [];
      const indexArr = Array.isArray(rawIndexes) ? rawIndexes : rawIndexes ? [rawIndexes] : [];
      const addedIndexes: string[] = indexArr.map((i: any) => i.Name || '').filter(Boolean);

      // Extract methods + detect CoC and event subscriptions
      const rawMethods = root.SourceCode?.Methods?.Method ?? root.Methods?.Method ?? [];
      const methodArr = Array.isArray(rawMethods) ? rawMethods : rawMethods ? [rawMethods] : [];

      const addedMethods: string[] = [];
      const cocMethods: string[] = [];
      const eventSubscriptions: string[] = [];

      for (const m of methodArr) {
        const methodName: string = m.Name || '';
        const source: string = typeof m.Source === 'string' ? m.Source : (m._ || '');
        if (!methodName) continue;

        addedMethods.push(methodName);

        // CoC detection: method source calls "next methodName"
        if (/\bnext\s+\w+\s*\(/i.test(source)) {
          cocMethods.push(methodName);
        }

        // Event handler detection: [SubscribesTo(...)]
        const subMatch = source.match(/\[SubscribesTo\s*\(/i);
        if (subMatch) {
          // Extract the subscribes-to target for storage
          const target = source.match(/\[SubscribesTo\s*\([^)]+\)/)?.[0] || methodName;
          eventSubscriptions.push(target);
        }
      }

      return {
        success: true,
        data: {
          name,
          baseObjectName,
          sourcePath: filePath,
          addedFields,
          addedMethods,
          addedIndexes,
          cocMethods,
          eventSubscriptions,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Parse an AxService file: backing class, external name, namespace, and the
   * exposed service operations (each maps to a public method on the class).
   */
  async parseServiceFile(filePath: string): Promise<XppParseResult<{
    name: string;
    serviceClass?: string;
    externalName?: string;
    namespace?: string;
    sourcePath: string;
    operations: { name: string; method: string; idempotent: boolean }[];
  }>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = await this.parser.parseStringPromise(content);
      const root = parsed?.AxService;
      if (!root) return { success: false, error: 'Not an AxService file' };

      const rawOps = root.ServiceOperations?.AxServiceOperation;
      const opArr = Array.isArray(rawOps) ? rawOps : rawOps ? [rawOps] : [];
      const operations = opArr
        .map((o: any) => ({
          name: o.Name || '',
          method: o.Method || o.Name || '',
          idempotent: String(o.EnableIdempotence || '').toLowerCase() === 'yes',
        }))
        .filter((o: { name: string }) => o.name);

      return {
        success: true,
        data: {
          name: root.Name || '',
          serviceClass: root.Class || undefined,
          externalName: root.ExternalName || undefined,
          namespace: root.Namespace || undefined,
          sourcePath: filePath,
          operations,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Parse an AxMap file: the X++ map class (methods) and its table mappings
   * (each mapping binds the map to a table via field connections).
   */
  async parseMapFile(filePath: string): Promise<XppParseResult<{
    name: string;
    extends?: string;
    sourcePath: string;
    methods: string[];
    mappings: { table: string; fieldConnections: number }[];
  }>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = await this.parser.parseStringPromise(content);
      const root = parsed?.AxMap;
      if (!root) return { success: false, error: 'Not an AxMap file' };

      const decl: string = root.SourceCode?.Declaration || '';
      const extendsMatch = decl.match(/\bextends\s+(\w+)/i);

      const rawMethods = root.SourceCode?.Methods?.Method;
      const methodArr = Array.isArray(rawMethods) ? rawMethods : rawMethods ? [rawMethods] : [];
      const methods: string[] = methodArr.map((m: any) => m.Name || '').filter(Boolean);

      const rawMappings = root.Mappings?.AxTableMapping;
      const mapArr = Array.isArray(rawMappings) ? rawMappings : rawMappings ? [rawMappings] : [];
      const mappings = mapArr.map((m: any) => {
        const rawConn = m.Connections?.AxTableMappingConnection;
        const connArr = Array.isArray(rawConn) ? rawConn : rawConn ? [rawConn] : [];
        return { table: m.MappingTable || '', fieldConnections: connArr.length };
      }).filter((m: { table: string }) => m.table);

      return {
        success: true,
        data: { name: root.Name || '', extends: extendsMatch?.[1], sourcePath: filePath, methods, mappings },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /** Parse an AxConfigurationKey file: label + parent key (feature gating tree). */
  async parseConfigurationKeyFile(filePath: string): Promise<XppParseResult<{
    name: string;
    label?: string;
    parentKey?: string;
    sourcePath: string;
  }>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = await this.parser.parseStringPromise(content);
      const root = parsed?.AxConfigurationKey;
      if (!root) return { success: false, error: 'Not an AxConfigurationKey file' };
      return {
        success: true,
        data: { name: root.Name || '', label: root.Label || undefined, parentKey: root.ParentKey || undefined, sourcePath: filePath },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /** Parse an AxLicenseCode file: group, package, type (license-based feature gating). */
  async parseLicenseCodeFile(filePath: string): Promise<XppParseResult<{
    name: string;
    label?: string;
    group?: string;
    licensePackage?: string;
    type?: string;
    sourcePath: string;
  }>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = await this.parser.parseStringPromise(content);
      const root = parsed?.AxLicenseCode;
      if (!root) return { success: false, error: 'Not an AxLicenseCode file' };
      return {
        success: true,
        data: {
          name: root.Name || '',
          label: root.Label || undefined,
          group: root.Group || undefined,
          licensePackage: root.Package || undefined,
          type: root.Type || undefined,
          sourcePath: filePath,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /** Parse an AxSecurityPolicy file: row-level (OLS) policy on a primary table. */
  async parseSecurityPolicyFile(filePath: string): Promise<XppParseResult<{
    name: string;
    label?: string;
    primaryTable?: string;
    query?: string;
    operation?: string;
    constrainedTable: boolean;
    sourcePath: string;
  }>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = await this.parser.parseStringPromise(content);
      const root = parsed?.AxSecurityPolicy;
      if (!root) return { success: false, error: 'Not an AxSecurityPolicy file' };
      return {
        success: true,
        data: {
          name: root.Name || '',
          label: root.Label || undefined,
          primaryTable: root.PrimaryTable || undefined,
          query: root.Query || undefined,
          operation: root.Operation || undefined,
          constrainedTable: String(root.ConstrainedTable || '').toLowerCase() === 'yes',
          sourcePath: filePath,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /** Parse an AxMacroDictionary file: the #define entries of a shared macro library. */
  async parseMacroFile(filePath: string): Promise<XppParseResult<{
    name: string;
    sourcePath: string;
    defines: { name: string; value: string }[];
  }>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = await this.parser.parseStringPromise(content);
      const root = parsed?.AxMacroDictionary;
      if (!root) return { success: false, error: 'Not an AxMacroDictionary file' };

      const source: string = typeof root.Source === 'string' ? root.Source : (root.Source?._ || '');
      const defines: { name: string; value: string }[] = [];
      // #define.Name(value) and #define.Name  (no value)
      const re = /#define\.(\w+)\s*(?:\(([^)]*)\))?/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        defines.push({ name: m[1], value: (m[2] ?? '').trim() });
      }

      return { success: true, data: { name: root.Name || '', sourcePath: filePath, defines } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Parse an AxServiceGroup file: member services and deployment flag.
   */
  async parseServiceGroupFile(filePath: string): Promise<XppParseResult<{
    name: string;
    autoDeploy: boolean;
    description?: string;
    sourcePath: string;
    services: string[];
  }>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = await this.parser.parseStringPromise(content);
      const root = parsed?.AxServiceGroup;
      if (!root) return { success: false, error: 'Not an AxServiceGroup file' };

      const rawSvc = root.Services?.AxServiceGroupService;
      const svcArr = Array.isArray(rawSvc) ? rawSvc : rawSvc ? [rawSvc] : [];
      const services: string[] = svcArr
        .map((s: any) => s.Service || s.Name || '')
        .filter(Boolean);

      return {
        success: true,
        data: {
          name: root.Name || '',
          autoDeploy: String(root.AutoDeploy || '').toLowerCase() === 'yes',
          description: root.Description || undefined,
          sourcePath: filePath,
          services,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
