/**
 * X++ Metadata XML Parser
 * Parses D365 F&O AOT XML files (AxClass, AxTable, etc.)
 */

import * as fs from 'fs/promises';
import * as xml2js from 'xml2js';
import type {
  XppParseResult,
  XppClassInfo,
  XppTableInfo,
  XppMethodInfo,
  XppParameterInfo,
  XppFieldInfo,
  XppIndexInfo,
  XppRelationInfo,
} from './types.js';

export class XppMetadataParser {
  private parser: xml2js.Parser;

  constructor() {
    this.parser = new xml2js.Parser({
      explicitArray: false,
      mergeAttrs: true,
      trim: true,
    });
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

      // Extract class metadata
      const classInfo: XppClassInfo = {
        name: className,
        model: model || 'Unknown',
        extends: axClass.Extends || undefined,
        implements: this.parseImplements(axClass.Implements),
        isAbstract: axClass.IsAbstract === 'Yes' || axClass.IsAbstract === 'true',
        isFinal: axClass.IsFinal === 'Yes' || axClass.IsFinal === 'true',
        declaration: this.extractClassDeclaration(axClass),
        methods: this.parseMethods(axClass.Methods?.Method),
        documentation: axClass.DeveloperDocumentation || undefined,
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
        label: axTable.Label || tableName,
        tableGroup: axTable.TableGroup || 'Main',
        primaryIndex: axTable.PrimaryIndex || undefined,
        clusteredIndex: axTable.ClusteredIndex || undefined,
        fields: this.parseFields(axTable.Fields?.AxTableField),
        indexes: this.parseIndexes(axTable.Indexes?.AxTableIndex),
        relations: this.parseRelations(axTable.Relations?.AxTableRelation),
        methods: this.parseMethods(axTable.Methods?.Method),
      };

      return { success: true, data: tableInfo };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private parseImplements(implementsStr?: string): string[] {
    if (!implementsStr) return [];
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

  private parseMethods(methodsData: any): XppMethodInfo[] {
    if (!methodsData) return [];

    const methods = Array.isArray(methodsData) ? methodsData : [methodsData];
    return methods.map(method => ({
      name: method.Name || 'unknown',
      visibility: this.parseVisibility(method.Visibility),
      returnType: method.ReturnType || 'void',
      parameters: this.parseParameters(method.Parameters),
      isStatic: method.IsStatic === 'Yes' || method.IsStatic === 'true',
      source: method.Source || '',
      documentation: method.DeveloperDocumentation || undefined,
    }));
  }

  private parseVisibility(vis?: string): 'public' | 'private' | 'protected' {
    if (!vis) return 'public';
    const lower = vis.toLowerCase();
    if (lower === 'private') return 'private';
    if (lower === 'protected') return 'protected';
    return 'public';
  }

  private parseParameters(paramsStr?: string): XppParameterInfo[] {
    if (!paramsStr) return [];
    
    // Simple parameter parsing (may need enhancement for complex cases)
    const params = paramsStr.split(',').map(p => p.trim()).filter(Boolean);
    return params.map(p => {
      const parts = p.trim().split(/\s+/);
      if (parts.length >= 2) {
        return { type: parts[0], name: parts[1] };
      }
      return { type: 'object', name: p };
    });
  }

  private parseFields(fieldsData: any): XppFieldInfo[] {
    if (!fieldsData) return [];

    const fields = Array.isArray(fieldsData) ? fieldsData : [fieldsData];
    return fields.map(field => ({
      name: field.Name || 'unknown',
      type: field.Type || 'String',
      extendedDataType: field.ExtendedDataType || undefined,
      mandatory: field.Mandatory === 'Yes' || field.Mandatory === 'true',
      label: field.Label || undefined,
    }));
  }

  private parseIndexes(indexesData: any): XppIndexInfo[] {
    if (!indexesData) return [];

    const indexes = Array.isArray(indexesData) ? indexesData : [indexesData];
    return indexes.map(index => ({
      name: index.Name || 'unknown',
      fields: this.parseIndexFields(index.Fields),
      unique: index.AllowDuplicates === 'No' || index.AllowDuplicates === 'false',
      clustered: index.AlternateKey === 'Yes' || index.AlternateKey === 'true',
    }));
  }

  private parseIndexFields(fieldsStr?: string): string[] {
    if (!fieldsStr) return [];
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

    const constraints = Array.isArray(constraintsData) ? constraintsData : [constraintsData];
    return constraints.map(c => ({
      field: c.Field || '',
      relatedField: c.RelatedField || '',
    }));
  }
}
