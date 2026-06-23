/**
 * Workspace Scanner
 * Scans local X++ files in workspace for hybrid analysis
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { parseStringPromise } from 'xml2js';
import { isFileUnderRoot } from '../utils/pathContainment.js';

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
  private workspaceCache: Map<string, { files: WorkspaceFile[]; scannedAt: number }> = new Map();

  /**
   * Short cache TTL so the context pipeline reflects freshly-saved files within
   * seconds rather than the old 5-minute window. Combined with invalidate()
   * (called after writes) this keeps "recently edited" / "active file" current
   * without an fs.watch. Lazy expiry — no background timer to leak.
   */
  private static readonly CACHE_TTL_MS = 15_000;

  /**
   * Scan workspace for X++ files
   */
  async scanWorkspace(workspacePath: string): Promise<WorkspaceFile[]> {
    // Serve from cache while still fresh (lazy expiry).
    const cached = this.workspaceCache.get(workspacePath);
    if (cached && Date.now() - cached.scannedAt < WorkspaceScanner.CACHE_TTL_MS) {
      return cached.files;
    }

    const files: WorkspaceFile[] = [];

    // Find all .xml files (D365FO metadata files)
    const xmlFiles = await glob('**/*.xml', {
      cwd: workspacePath,
      ignore: ['**/node_modules/**', '**/bin/**', '**/obj/**', '**/.git/**'],
      absolute: true,
    });

    for (const filePath of xmlFiles) {
      // Defense in depth: verify that each globbed file (after symlink
      // resolution) still resolves under the validated workspace root.
      // A symlink placed inside the workspace could otherwise redirect a read
      // to an arbitrary location outside the allowed root.
      if (!isFileUnderRoot(filePath, workspacePath)) {
        console.warn(`[WorkspaceScanner] Skipping ${filePath} — resolves outside workspace root ${workspacePath}`);
        continue;
      }

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

    this.workspaceCache.set(workspacePath, { files, scannedAt: Date.now() });

    return files;
  }

  /**
   * Drop cached scan results so the next scanWorkspace re-reads from disk.
   * Call after a write (create/modify/undo) so "recently edited" and the
   * active-file resolution reflect the change immediately.
   */
  invalidate(workspacePath?: string): void {
    if (workspacePath) {
      this.workspaceCache.delete(workspacePath);
    } else {
      this.workspaceCache.clear();
    }
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
   * Clear cache (alias of invalidate() with no argument).
   */
  clearCache(): void {
    this.invalidate();
  }
}
