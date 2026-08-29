/**
 * Workspace Scanner
 * Scans local X++ files in workspace for hybrid analysis
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { parseStringPromise } from '../utils/xml.js';
import { isFileUnderRoot } from '../utils/pathContainment.js';

/**
 * Directories never worth walking in a D365FO workspace. fs.glob's `exclude`
 * callback is handed the plain entry NAME (not a path), and returning true for
 * a directory prunes the whole subtree — which is why this is a name set rather
 * than the `**​/node_modules/**` style patterns the glob package took.
 *
 * The callback form is used deliberately over `exclude: string[]`: the callback
 * has been supported since fs.glob landed, the pattern-array form is newer, and
 * an unsupported option here would be ignored silently rather than throwing.
 */
const SKIPPED_DIRS = new Set(['node_modules', 'bin', 'obj', '.git']);

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

export class WorkspaceScanner {
  private workspaceCache: Map<string, { files: WorkspaceFile[]; scannedAt: number }> = new Map();

  /** Cache TTL; paired with invalidate() (called by the dispatcher after every MUTATING_TOOLS call) to keep results current without an fs.watch. Lazy expiry — no background timer. */
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

    // Find all .xml files (D365FO metadata files). fs.glob yields cwd-relative
    // paths, so resolve them here — the glob package's `absolute: true` did it.
    const xmlFiles: string[] = [];
    for await (const relPath of fs.glob('**/*.xml', {
      cwd: workspacePath,
      exclude: name => SKIPPED_DIRS.has(name),
    })) {
      xmlFiles.push(path.resolve(workspacePath, relPath));
    }

    for (const filePath of xmlFiles) {
      // Reject symlinks that resolve outside the workspace root.
      if (!isFileUnderRoot(filePath, workspacePath)) {
        console.warn(`[WorkspaceScanner] Skipping ${filePath} — resolves outside workspace root ${workspacePath}`);
        continue;
      }

      const stat = await fs.stat(filePath);
      const fileName = path.basename(filePath, '.xml');
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

    if (classNode.Extends) {
      metadata.extends = classNode.Extends;
    }

    if (classNode.Implements) {
      metadata.implements = Array.isArray(classNode.Implements)
        ? classNode.Implements
        : [classNode.Implements];
    }

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

    if (tableNode.Label) {
      metadata.properties!.label = tableNode.Label;
    }

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

    // Tables can have methods too.
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
