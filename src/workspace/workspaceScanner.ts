/**
 * Workspace Scanner
 * Scans local X++ files in workspace for hybrid analysis
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { parseStringPromise } from 'xml2js';

export interface WorkspaceFile {
  path: string;
  name: string;
  type: 'class' | 'table' | 'form' | 'enum' | 'unknown';
  content?: string;
  lastModified: Date;
  metadata?: ParsedMetadata;
}

export interface ParsedMetadata {
  methods?: MethodMetadata[];
  fields?: FieldMetadata[];
  extends?: string;
  implements?: string[];
  properties?: Record<string, any>;
}

export interface MethodMetadata {
  name: string;
  params?: string;
  returnType?: string;
  signature: string;
  isStatic?: boolean;
}

export interface FieldMetadata {
  name: string;
  type?: string;
  edt?: string;
  mandatory?: boolean;
}

export interface WorkspaceContext {
  rootPath: string;
  files: WorkspaceFile[];
  openFiles: Map<string, string>; // path -> content
}

export class WorkspaceScanner {
  private workspaceCache: Map<string, WorkspaceFile[]> = new Map();

  /**
   * Scan workspace for X++ files
   */
  async scanWorkspace(workspacePath: string): Promise<WorkspaceFile[]> {
    // Check cache
    const cached = this.workspaceCache.get(workspacePath);
    if (cached) {
      return cached;
    }

    const files: WorkspaceFile[] = [];

    // Find all .xml files (D365FO metadata files)
    const xmlFiles = await glob('**/*.xml', {
      cwd: workspacePath,
      ignore: ['**/node_modules/**', '**/bin/**', '**/obj/**', '**/.git/**'],
      absolute: true,
    });

    for (const filePath of xmlFiles) {
      const stat = await fs.stat(filePath);
      const fileName = path.basename(filePath, '.xml');
      
      // Detect type from path
      const type = this.detectFileType(filePath);
      
      files.push({
        path: filePath,
        name: fileName,
        type,
        lastModified: stat.mtime,
      });
    }

    // Cache for 5 minutes
    this.workspaceCache.set(workspacePath, files);
    setTimeout(() => this.workspaceCache.delete(workspacePath), 5 * 60 * 1000);

    return files;
  }

  /**
   * Read content of specific file
   */
  async readFile(filePath: string): Promise<string> {
    return await fs.readFile(filePath, 'utf-8');
  }

  /**
   * Search X++ symbols in workspace files
   */
  async searchInWorkspace(
    workspacePath: string,
    query: string,
    type?: 'class' | 'table' | 'form' | 'enum'
  ): Promise<WorkspaceFile[]> {
    const files = await this.scanWorkspace(workspacePath);

    return files.filter((file) => {
      if (type && file.type !== type) return false;
      return file.name.toLowerCase().includes(query.toLowerCase());
    });
  }

  /**
   * Detect file type from path
   */
  private detectFileType(filePath: string): WorkspaceFile['type'] {
    if (filePath.includes('\\AxClass\\') || filePath.includes('/AxClass/')) {
      return 'class';
    }
    if (filePath.includes('\\AxTable\\') || filePath.includes('/AxTable/')) {
      return 'table';
    }
    if (filePath.includes('\\AxForm\\') || filePath.includes('/AxForm/')) {
      return 'form';
    }
    if (filePath.includes('\\AxEnum\\') || filePath.includes('/AxEnum/')) {
      return 'enum';
    }
    return 'unknown';
  }

  /**
   * Get statistics about workspace
   */
  async getWorkspaceStats(workspacePath: string): Promise<{
    totalFiles: number;
    classes: number;
    tables: number;
    forms: number;
    enums: number;
  }> {
    const files = await this.scanWorkspace(workspacePath);

    return {
      totalFiles: files.length,
      classes: files.filter((f) => f.type === 'class').length,
      tables: files.filter((f) => f.type === 'table').length,
      forms: files.filter((f) => f.type === 'form').length,
      enums: files.filter((f) => f.type === 'enum').length,
    };
  }

  /**
   * Parse XML metadata from file
   */
  async parseXmlFile(filePath: string): Promise<ParsedMetadata | undefined> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const xml = await parseStringPromise(content, { explicitArray: false });

      const type = this.detectFileType(filePath);

      switch (type) {
        case 'class':
          return this.parseClassXml(xml);
        case 'table':
          return this.parseTableXml(xml);
        default:
          return undefined;
      }
    } catch (error) {
      console.warn(`Failed to parse ${filePath}:`, error);
      return undefined;
    }
  }

  /**
   * Parse AxClass XML structure
   */
  private parseClassXml(xml: any): ParsedMetadata {
    const classNode = xml.AxClass;
    if (!classNode) return {};

    const metadata: ParsedMetadata = {
      methods: [],
      fields: [],
      properties: {},
    };

    // Parse class header
    if (classNode.Extends) {
      metadata.extends = classNode.Extends;
    }

    if (classNode.Implements) {
      metadata.implements = Array.isArray(classNode.Implements)
        ? classNode.Implements
        : [classNode.Implements];
    }

    // Parse methods
    if (classNode.MethodInfo) {
      const methods = Array.isArray(classNode.MethodInfo)
        ? classNode.MethodInfo
        : [classNode.MethodInfo];

      for (const method of methods) {
        if (method?.Name) {
          metadata.methods!.push({
            name: method.Name,
            returnType: method.ReturnType || 'void',
            params: method.Parameters || '',
            signature: `${method.ReturnType || 'void'} ${method.Name}(${method.Parameters || ''})`,
            isStatic: method.Static === 'Yes',
          });
        }
      }
    }

    return metadata;
  }

  /**
   * Parse AxTable XML structure
   */
  private parseTableXml(xml: any): ParsedMetadata {
    const tableNode = xml.AxTable;
    if (!tableNode) return {};

    const metadata: ParsedMetadata = {
      fields: [],
      methods: [],
      properties: {},
    };

    // Parse table properties
    if (tableNode.Label) {
      metadata.properties!.label = tableNode.Label;
    }

    // Parse fields
    if (tableNode.Fields?.AxTableField) {
      const fields = Array.isArray(tableNode.Fields.AxTableField)
        ? tableNode.Fields.AxTableField
        : [tableNode.Fields.AxTableField];

      for (const field of fields) {
        if (field?.Name) {
          metadata.fields!.push({
            name: field.Name,
            type: field.Type || 'String',
            edt: field.ExtendedDataType,
            mandatory: field.Mandatory === 'Yes',
          });
        }
      }
    }

    // Parse methods (tables can have methods too)
    if (tableNode.MethodInfo) {
      const methods = Array.isArray(tableNode.MethodInfo)
        ? tableNode.MethodInfo
        : [tableNode.MethodInfo];

      for (const method of methods) {
        if (method?.Name) {
          metadata.methods!.push({
            name: method.Name,
            returnType: method.ReturnType || 'void',
            params: method.Parameters || '',
            signature: `${method.ReturnType || 'void'} ${method.Name}(${method.Parameters || ''})`,
          });
        }
      }
    }

    return metadata;
  }

  /**
   * Get file with parsed metadata
   */
  async getFileWithMetadata(filePath: string): Promise<WorkspaceFile | null> {
    try {
      const stat = await fs.stat(filePath);
      const fileName = path.basename(filePath, '.xml');
      const type = this.detectFileType(filePath);
      const metadata = await this.parseXmlFile(filePath);

      return {
        path: filePath,
        name: fileName,
        type,
        lastModified: stat.mtime,
        metadata,
      };
    } catch (error) {
      console.warn(`Failed to get file metadata for ${filePath}:`, error);
      return null;
    }
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.workspaceCache.clear();
  }
}
