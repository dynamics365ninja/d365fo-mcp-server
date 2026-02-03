/**
 * X++ Symbol Index
 * SQLite-based symbol indexing with FTS5 full-text search
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { XppSymbol } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class XppSymbolIndex {
  private db: Database.Database;
  private standardModels: string[] = [];

  constructor(dbPath: string) {
    // Ensure database directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.loadStandardModels();
    this.initializeDatabase();
  }

  /**
   * Load standard models from configuration file
   */
  private loadStandardModels(): void {
    try {
      const configPath = path.resolve(__dirname, '../../config/standard-models.json');
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configContent);
      this.standardModels = config.standardModels || [];
    } catch (error) {
      // Fallback to minimal set if config file not found
      console.warn('Could not load standard-models.json, using fallback list');
      this.standardModels = [
        'ApplicationFoundation',
        'ApplicationPlatform',
        'ApplicationSuite',
        'Directory',
        'Ledger',
      ];
    }
  }

  private initializeDatabase(): void {
    // Create symbols table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        parent_name TEXT,
        signature TEXT,
        file_path TEXT NOT NULL,
        model TEXT NOT NULL
      );
    `);

    // Create FTS5 virtual table for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
        name,
        type,
        parent_name,
        signature,
        content='symbols',
        content_rowid='id'
      );
    `);

    // Create triggers to keep FTS table in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
        INSERT INTO symbols_fts(rowid, name, type, parent_name, signature)
        VALUES (new.id, new.name, new.type, new.parent_name, new.signature);
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
        DELETE FROM symbols_fts WHERE rowid = old.id;
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
        UPDATE symbols_fts SET
          name = new.name,
          type = new.type,
          parent_name = new.parent_name,
          signature = new.signature
        WHERE rowid = new.id;
      END;
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_type ON symbols(type);
      CREATE INDEX IF NOT EXISTS idx_symbols_model ON symbols(model);
    `);
  }

  /**
   * Add a symbol to the index
   */
  addSymbol(symbol: XppSymbol): void {
    const stmt = this.db.prepare(`
      INSERT INTO symbols (name, type, parent_name, signature, file_path, model)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      symbol.name,
      symbol.type,
      symbol.parentName || null,
      symbol.signature || null,
      symbol.filePath,
      symbol.model
    );
  }

  /**
   * Search symbols by query with full-text search
   */
  searchSymbols(query: string, limit: number = 20, types?: string[]): XppSymbol[] {
    let sql = `
      SELECT s.name, s.type, s.parent_name, s.signature, s.file_path, s.model
      FROM symbols_fts fts
      JOIN symbols s ON s.id = fts.rowid
      WHERE symbols_fts MATCH ?
    `;

    const params: any[] = [query];

    if (types && types.length > 0) {
      sql += ` AND s.type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => ({
      name: row.name,
      type: row.type as any,
      parentName: row.parent_name || undefined,
      signature: row.signature || undefined,
      filePath: row.file_path,
      model: row.model,
    }));
  }

  /**
   * Search symbols by prefix (for autocomplete)
   */
  searchByPrefix(prefix: string, types?: string[], limit: number = 20): XppSymbol[] {
    let sql = `
      SELECT name, type, parent_name, signature, file_path, model
      FROM symbols
      WHERE name LIKE ?
    `;

    const params: any[] = [`${prefix}%`];

    if (types && types.length > 0) {
      sql += ` AND type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    sql += ` ORDER BY name LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      name: row.name,
      type: row.type as any,
      parentName: row.parent_name || undefined,
      signature: row.signature || undefined,
      filePath: row.file_path,
      model: row.model,
    }));
  }

  /**
   * Get a specific symbol by name and type
   */
  getSymbolByName(name: string, type: string): XppSymbol | null {
    const stmt = this.db.prepare(`
      SELECT name, type, parent_name, signature, file_path, model
      FROM symbols
      WHERE name = ? AND type = ?
      LIMIT 1
    `);

    const row = stmt.get(name, type) as any;
    if (!row) return null;

    return {
      name: row.name,
      type: row.type as any,
      parentName: row.parent_name || undefined,
      signature: row.signature || undefined,
      filePath: row.file_path,
      model: row.model,
    };
  }

  /**
   * Get all classes (for resource listing)
   */
  getAllClasses(): XppSymbol[] {
    const stmt = this.db.prepare(`
      SELECT name, type, parent_name, signature, file_path, model
      FROM symbols
      WHERE type = 'class'
      ORDER BY name
    `);

    const rows = stmt.all() as any[];
    return rows.map(row => ({
      name: row.name,
      type: row.type as any,
      parentName: row.parent_name || undefined,
      signature: row.signature || undefined,
      filePath: row.file_path,
      model: row.model,
    }));
  }

  /**
   * Get symbol count
   */
  getSymbolCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM symbols');
    const result = stmt.get() as { count: number };
    return result.count;
  }

  /**
   * Get symbol count by type
   */
  getSymbolCountByType(): Record<string, number> {
    const stmt = this.db.prepare(`
      SELECT type, COUNT(*) as count
      FROM symbols
      GROUP BY type
    `);

    const rows = stmt.all() as { type: string; count: number }[];
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.type] = row.count;
    }
    return result;
  }

  /**
   * Index metadata from a directory
   */
  async indexMetadataDirectory(metadataPath: string, modelName?: string): Promise<void> {
    const models = modelName ? [modelName] : await this.getModelDirectories(metadataPath);

    // Wrap everything in a single transaction for massive performance boost
    const transaction = this.db.transaction(() => {
      for (const model of models) {
        const modelPath = path.join(metadataPath, model);
        
        // Index classes
        const classesPath = path.join(modelPath, 'classes');
        if (fs.existsSync(classesPath)) {
          this.indexClasses(classesPath, model);
        }

        // Index tables
        const tablesPath = path.join(modelPath, 'tables');
        if (fs.existsSync(tablesPath)) {
          this.indexTables(tablesPath, model);
        }

        // Index enums
        const enumsPath = path.join(modelPath, 'enums');
        if (fs.existsSync(enumsPath)) {
          this.indexEnums(enumsPath, model);
        }
      }
    });

    // Execute the entire indexing in one transaction
    transaction();
  }

  private async getModelDirectories(metadataPath: string): Promise<string[]> {
    const entries = fs.readdirSync(metadataPath, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  }

  private indexClasses(classesPath: string, model: string): void {
    const files = fs.readdirSync(classesPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(classesPath, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const classData = JSON.parse(content);

      // Add class symbol
      this.addSymbol({
        name: classData.name,
        type: 'class',
        signature: classData.extends ? `extends ${classData.extends}` : undefined,
        filePath,
        model,
      });

      // Add method symbols
      if (classData.methods && Array.isArray(classData.methods)) {
        for (const method of classData.methods) {
          const params = method.parameters?.map((p: any) => `${p.type} ${p.name}`).join(', ') || '';
          this.addSymbol({
            name: method.name,
            type: 'method',
            parentName: classData.name,
            signature: `${method.returnType} ${method.name}(${params})`,
            filePath,
            model,
          });
        }
      }
    }
  }

  private indexTables(tablesPath: string, model: string): void {
    const files = fs.readdirSync(tablesPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(tablesPath, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const tableData = JSON.parse(content);

      // Add table symbol
      this.addSymbol({
        name: tableData.name,
        type: 'table',
        signature: tableData.label || undefined,
        filePath,
        model,
      });

      // Add field symbols
      if (tableData.fields && Array.isArray(tableData.fields)) {
        for (const field of tableData.fields) {
          this.addSymbol({
            name: field.name,
            type: 'field',
            parentName: tableData.name,
            signature: field.type,
            filePath,
            model,
          });
        }
      }
    }
  }

  private indexEnums(enumsPath: string, model: string): void {
    const files = fs.readdirSync(enumsPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(enumsPath, file);
      const enumName = path.basename(file, '.json');

      // Add enum symbol
      this.addSymbol({
        name: enumName,
        type: 'enum',
        filePath,
        model,
      });
    }
  }

  /**
   * Get class methods for autocomplete
   */
  getClassMethods(className: string): XppSymbol[] {
    const stmt = this.db.prepare(`
      SELECT name, type, parent_name, signature, file_path, model
      FROM symbols
      WHERE parent_name = ? AND type = 'method'
      ORDER BY name
    `);

    const rows = stmt.all(className) as any[];
    return rows.map(row => ({
      name: row.name,
      type: row.type as any,
      parentName: row.parent_name || undefined,
      signature: row.signature || undefined,
      filePath: row.file_path,
      model: row.model,
    }));
  }

  /**
   * Get table fields for autocomplete
   */
  getTableFields(tableName: string): XppSymbol[] {
    const stmt = this.db.prepare(`
      SELECT name, type, parent_name, signature, file_path, model
      FROM symbols
      WHERE parent_name = ? AND type = 'field'
      ORDER BY name
    `);

    const rows = stmt.all(tableName) as any[];
    return rows.map(row => ({
      name: row.name,
      type: row.type as any,
      parentName: row.parent_name || undefined,
      signature: row.signature || undefined,
      filePath: row.file_path,
      model: row.model,
    }));
  }

  /**
   * Get completions for a class or table
   */
  getCompletions(objectName: string, prefix?: string): any[] {
    const methods = this.getClassMethods(objectName);
    const fields = this.getTableFields(objectName);
    const allMembers = [...methods, ...fields];

    const filtered = prefix
      ? allMembers.filter(m => m.name.toLowerCase().startsWith(prefix.toLowerCase()))
      : allMembers;

    return filtered.map(m => ({
      label: m.name,
      kind: m.type === 'method' ? 'Method' : 'Field',
      detail: m.signature,
      documentation: undefined,
    }));
  }

  /**
   * Search custom extensions by prefix
   */
  searchCustomExtensions(query: string, prefix?: string, limit: number = 20): XppSymbol[] {
    let sql = `
      SELECT name, type, parent_name, signature, file_path, model
      FROM symbols
      WHERE name LIKE ?
    `;

    const params: any[] = [`%${query}%`];

    if (prefix) {
      sql += ` AND model LIKE ?`;
      params.push(`${prefix}%`);
    }

    sql += ` ORDER BY name LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      name: row.name,
      type: row.type as any,
      parentName: row.parent_name || undefined,
      signature: row.signature || undefined,
      filePath: row.file_path,
      model: row.model,
    }));
  }

  /**
   * Get list of custom models (non-standard models)
   * Filters out Microsoft's standard D365 F&O models loaded from config
   */
  getCustomModels(): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT model
      FROM symbols
      ORDER BY model
    `);

    const rows = stmt.all() as { model: string }[];
    return rows
      .map(row => row.model)
      .filter(model => !this.standardModels.includes(model));
  }

  /**
   * Clear all symbols
   */
  clear(): void {
    this.db.exec('DELETE FROM symbols');
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}
