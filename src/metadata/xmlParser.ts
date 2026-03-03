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

      // Extract class metadata
      const classInfo: XppClassInfo = {
        name: className,
        model: model || 'Unknown',
        sourcePath: filePath,  // Store original XML file path
        extends: axClass.Extends || undefined,
        implements: this.parseImplements(axClass.Implements),
        isAbstract: axClass.IsAbstract === 'Yes' || axClass.IsAbstract === 'true',
        isFinal: axClass.IsFinal === 'Yes' || axClass.IsFinal === 'true',
        declaration: this.extractClassDeclaration(axClass),
        methods: this.parseMethods(methodsData, className),
        documentation: axClass.DeveloperDocumentation || undefined,
        // Enhanced metadata
        tags: this.enhancedParser.generateClassTags({
          name: className,
          model: model || 'Unknown',
          sourcePath: filePath,
          extends: axClass.Extends || undefined,
          implements: this.parseImplements(axClass.Implements),
          isAbstract: axClass.IsAbstract === 'Yes' || axClass.IsAbstract === 'true',
          isFinal: axClass.IsFinal === 'Yes' || axClass.IsFinal === 'true',
          declaration: this.extractClassDeclaration(axClass),
          methods: [],
          documentation: axClass.DeveloperDocumentation || undefined,
        }),
        usedTypes: this.enhancedParser.extractClassDependencies({
          name: className,
          model: model || 'Unknown',
          sourcePath: filePath,
          extends: axClass.Extends || undefined,
          implements: this.parseImplements(axClass.Implements),
          isAbstract: axClass.IsAbstract === 'Yes' || axClass.IsAbstract === 'true',
          isFinal: axClass.IsFinal === 'Yes' || axClass.IsFinal === 'true',
          declaration: this.extractClassDeclaration(axClass),
          methods: this.parseMethods(methodsData, className),
          documentation: axClass.DeveloperDocumentation || undefined,
        }),
        description: axClass.DeveloperDocumentation || `${className} class${axClass.Extends ? ` extending ${axClass.Extends}` : ''}`,
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
        sourcePath: filePath,  // Store original XML file path
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

  private parseImplements(implementsStr?: string | any): string[] {
    if (!implementsStr) return [];
    if (typeof implementsStr !== 'string') return [];
    return implementsStr.split(',').map(i => i.trim()).filter(Boolean);
  }

  private extractClassDeclaration(axClass: any): string {
    const modifiers: string[] = [];
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
      
      const baseMethod: XppMethodInfo = {
        name: methodName,
        visibility: this.parseVisibility(method.Visibility),
        returnType: this.extractReturnType(source, methodName) || method.ReturnType || 'void',
        parameters: this.extractParametersFromSource(source, methodName),
        isStatic: this.isMethodStatic(source),
        source: source,
        documentation: method.DeveloperDocumentation || undefined,
      };

      // Add enhanced metadata
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
   * Parse table fields from <AxTableField xmlns="" i:type="AxTableFieldString"> nodes.
   * xml2js (explicitArray:false) groups all <AxTableField> children under the AxTableField key.
   * The field type is carried in the i:type XML attribute → field.$['i:type'].
   */
  private parseFields(fieldsData: any): XppFieldInfo[] {
    if (!fieldsData) return [];

    const fields = Array.isArray(fieldsData) ? fieldsData : [fieldsData];
    return fields.map(field => {
      // i:type attribute value e.g. 'AxTableFieldString' → strip prefix to get 'String'
      const rawType: string = field.$?.['i:type'] || 'AxTableFieldString';
      const xppType = rawType.replace('AxTableField', '') || 'String';
      return {
        name: field.Name || 'unknown',
        type: xppType,
        extendedDataType: field.ExtendedDataType || undefined,
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
      // D365FO uses <AlternateKey>Yes</AlternateKey> to mark unique indexes (NOT AllowDuplicates)
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
      // Handle case where xml2js returns an object or array
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

  /**
   * Extract parameters from method source code
   */
  private extractParametersFromSource(source: string, methodName: string): XppParameterInfo[] {
    if (!source) return [];

    // Find method signature in source - look for methodName followed by parentheses
    // Pattern: methodName(param1, param2, ...)
    const methodPattern = new RegExp(`\\b${this.escapeRegex(methodName)}\\s*\\(([^)]*)\\)`, 'i');
    const match = source.match(methodPattern);

    if (!match || !match[1]) return [];

    const paramsStr = match[1].trim();
    if (!paramsStr) return [];

    // Split by comma, but be careful with generic types that contain commas
    const params = this.splitParameters(paramsStr);

    return params.map(param => {
      // Parse "Type name" or "Type _name" format
      const parts = param.trim().split(/\s+/);
      if (parts.length >= 2) {
        // Join all but last part as type (handles complex types like "Dictionary<string, int>")
        const name = parts[parts.length - 1];
        const type = parts.slice(0, -1).join(' ');
        return { type, name };
      }
      return { type: 'object', name: param.trim() };
    }).filter(p => p.name.length > 0);
  }

  /**
   * Extract return type from method source
   */
  private extractReturnType(source: string, methodName: string): string | undefined {
    if (!source) return undefined;

    // Look for pattern: [modifiers] returnType methodName(
    const pattern = new RegExp(`\\b(\\w+)\\s+${this.escapeRegex(methodName)}\\s*\\(`, 'i');
    const match = source.match(pattern);

    if (match && match[1]) {
      const returnType = match[1];
      // Filter out modifiers
      const modifiers = ['public', 'private', 'protected', 'static', 'final', 'abstract', 'internal'];
      if (!modifiers.includes(returnType.toLowerCase())) {
        return returnType;
      }
    }

    return undefined;
  }

  /**
   * Check if method is static from source
   */
  private isMethodStatic(source: string): boolean {
    if (!source) return false;
    return /\bstatic\s+/i.test(source);
  }

  /**
   * Escape special regex characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Split parameters by comma, respecting nested generics
   */
  private splitParameters(paramsStr: string): string[] {
    const params: string[] = [];
    let current = '';
    let depth = 0;

    for (let i = 0; i < paramsStr.length; i++) {
      const char = paramsStr[i];
      
      if (char === '<' || char === '(') {
        depth++;
        current += char;
      } else if (char === '>' || char === ')') {
        depth--;
        current += char;
      } else if (char === ',' && depth === 0) {
        if (current.trim()) {
          params.push(current.trim());
        }
        current = '';
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      params.push(current.trim());
    }

    return params;
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
        dataSources: [],
        design: [],
        methods: [],
      };

      // Extract data sources
      if (axForm.DataSources && axForm.DataSources.length > 0) {
        formInfo.dataSources = this.extractFormDataSources(axForm.DataSources[0]);
      }

      // Extract design (controls)
      if (axForm.Design && axForm.Design.length > 0) {
        const designInfo = this.extractFormDesign(axForm.Design[0]);
        formInfo.design = designInfo.controls;
        formInfo.formPattern = designInfo.pattern;
      }

      // Extract methods
      if (axForm.Methods && axForm.Methods.length > 0) {
        formInfo.methods = this.extractFormMethods(axForm.Methods[0], formName);
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

    if (!dataSourcesNode.AxFormDataSourceRoot) {
      return dataSources;
    }

    const dsRoots = this.ensureArray(dataSourcesNode.AxFormDataSourceRoot);

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
   * Extract form design (controls)
   */
  private extractFormDesign(designNode: any): { controls: any[]; pattern?: string } {
    const controls: any[] = [];
    let pattern: string | undefined = undefined;

    // Detect form pattern from Design properties
    if (designNode.Pattern) {
      pattern = designNode.Pattern;
    } else if (designNode.Style) {
      // Some forms use Style instead of Pattern
      pattern = designNode.Style;
    }

    // Find root containers
    const rootKeys = Object.keys(designNode).filter(k => k.startsWith('AxForm'));

    for (const key of rootKeys) {
      const nodes = this.ensureArray(designNode[key]);
      for (const node of nodes) {
        const control = this.extractFormControl(node, key);
        if (control) {
          controls.push(control);
        }
      }
    }

    return { controls, pattern };
  }

  /**
   * Extract single form control recursively
   */
  private extractFormControl(node: any, nodeType: string): any | null {
    if (!node) return null;

    const control: any = {
      name: node.Name || 'Unknown',
      type: nodeType.replace('AxForm', ''),
      properties: {},
      children: [],
    };

    // Extract common properties
    const propertiesToExtract = [
      'Caption',
      'Visible',
      'Enabled',
      'AutoDeclaration',
      'DataSource',
      'DataField',
      'DataMethod',
      'HelpText',
      'Label',
      'Width',
      'Height',
      'AllowEdit',
      'Mandatory',
      'Style',
      'Pattern',
    ];

    for (const prop of propertiesToExtract) {
      if (node[prop]) {
        const value = Array.isArray(node[prop]) ? node[prop][0] : node[prop];
        if (value) {
          control.properties[prop] = value;
        }
      }
    }

    // Recursively extract child controls
    const childKeys = Object.keys(node).filter(k => k.startsWith('AxForm') && k !== nodeType);

    for (const childKey of childKeys) {
      const childNodes = this.ensureArray(node[childKey]);
      for (const childNode of childNodes) {
        const childControl = this.extractFormControl(childNode, childKey);
        if (childControl) {
          control.children.push(childControl);
        }
      }
    }

    return control;
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

      // Parse method info (similar to class methods)
      const methodInfo: any = {
        name,
        visibility: 'public', // Forms typically have public methods
        returnType: this.extractReturnType(source, name) || 'void',
        parameters: this.extractParametersFromSource(source, name),
        isStatic: this.isMethodStatic(source),
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
    entryPoints: Array<{ name: string; objectType: string; accessLevel: string }>;
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
      const entryPoints = epArray.map((ep: any) => ({
        name: ep.Name || '',
        objectType: ep.ObjectType || '',
        accessLevel: ep.Grant || ep.Access || '',
      })).filter((ep: any) => ep.name);

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
      const extendsValue: string = root.Extends || root.BaseObject || '';

      // For class extensions, base object name is inferred from Extends or the name itself
      // Class extension names follow the pattern "BaseClass.Suffix" or "BaseClass_Suffix_Extension"
      let baseObjectName = extendsValue;
      if (!baseObjectName && extensionType === 'class-extension') {
        // Try to parse from declaration: [ExtensionOf(classStr(BaseName))]
        const decl: string = root.SourceCode?.Declaration || '';
        const match = decl.match(/ExtensionOf\s*\(\s*classStr\s*\(\s*(\w+)\s*\)/i)
          ?? decl.match(/ExtensionOf\s*\(\s*tableStr\s*\(\s*(\w+)\s*\)/i)
          ?? decl.match(/ExtensionOf\s*\(\s*formStr\s*\(\s*(\w+)\s*\)/i);
        baseObjectName = match?.[1] || '';
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
}
