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
  XppMethodInfo,
  XppParameterInfo,
  XppFieldInfo,
  XppIndexInfo,
  XppRelationInfo,
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
        methods: this.parseMethods(axTable.Methods?.Method, tableName),
      };

      return { success: true, data: tableInfo };
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

  private parseIndexFields(fieldsStr?: string | any): string[] {
    if (!fieldsStr) return [];
    if (typeof fieldsStr !== 'string') {
      // Handle case where xml2js returns an object or array
      if (Array.isArray(fieldsStr)) {
        return fieldsStr.map(f => String(f)).filter(Boolean);
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

    const constraints = Array.isArray(constraintsData) ? constraintsData : [constraintsData];
    return constraints.map(c => ({
      field: c.Field || '',
      relatedField: c.RelatedField || '',
    }));
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
}
