/**
 * X++ Symbol Index
 * SQLite-based symbol indexing with FTS5 full-text search
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { XppSymbol } from './types.js';

/**
 * Detect if running in CI environment
 * Supports: Azure Pipelines (TF_BUILD), GitHub Actions (CI), GitLab CI (CI)
 */
const isCI = (): boolean => {
  return !!(process.env.CI || process.env.TF_BUILD || process.env.GITHUB_ACTIONS);
};

export class XppSymbolIndex {
  private db: Database.Database;
  private standardModels: string[] = [];
  private stmtCache: Map<string, Database.Statement> = new Map();

  constructor(dbPath: string) {
    // Ensure database directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    
    // Enable SQLite performance optimizations
    this.db.pragma('journal_mode = WAL'); // Write-Ahead Logging for better concurrency
    this.db.pragma('synchronous = NORMAL'); // Faster writes, still crash-safe
    this.db.pragma('cache_size = -64000'); // 64MB cache (negative = kibibytes)
    this.db.pragma('temp_store = MEMORY'); // Store temp tables in memory
    this.db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O
    this.db.pragma('page_size = 8192'); // Optimal page size for modern systems
    this.db.pragma('optimize'); // Run query optimizer
    
    this.loadStandardModels();
    this.initializeDatabase();
    
    // Analyze database after initialization for better query plans
    try {
      this.db.pragma('analysis_limit = 1000');
      this.db.exec('ANALYZE');
    } catch (e) {
      // ANALYZE might fail on empty DB, ignore
    }
  }

  /**
   * Convert database row to XppSymbol with enhanced metadata
   */
  private rowToSymbol(row: any): XppSymbol {
    return {
      name: row.name,
      type: row.type as any,
      parentName: row.parent_name || undefined,
      signature: row.signature || undefined,
      filePath: row.file_path,
      model: row.model,
      description: row.description || undefined,
      tags: row.tags || undefined,
      sourceSnippet: row.source_snippet || undefined,
      complexity: row.complexity || undefined,
      usedTypes: row.used_types || undefined,
      methodCalls: row.method_calls || undefined,
      inlineComments: row.inline_comments || undefined,
      extendsClass: row.extends_class || undefined,
      implementsInterfaces: row.implements_interfaces || undefined,
      usageExample: row.usage_example || undefined,
      usageFrequency: row.usage_frequency || undefined,
      patternType: row.pattern_type || undefined,
      typicalUsages: row.typical_usages || undefined,
      calledByCount: row.called_by_count || undefined,
      relatedMethods: row.related_methods || undefined,
      apiPatterns: row.api_patterns || undefined,
    };
  }

  /**
   * Load standard models - now determined dynamically
   * Standard = all models NOT in CUSTOM_MODELS env variable
   */
  private loadStandardModels(): void {
    // Standard models are now determined dynamically based on CUSTOM_MODELS
    // This method kept for compatibility but standardModels array is no longer used
    // Use isStandardModel() from modelClassifier instead
    this.standardModels = [];
  }

  private initializeDatabase(): void {
    // Create symbols table with enhanced metadata fields
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        parent_name TEXT,
        signature TEXT,
        file_path TEXT NOT NULL,
        model TEXT NOT NULL,
        description TEXT,
        tags TEXT,
        source_snippet TEXT,
        complexity INTEGER,
        used_types TEXT,
        method_calls TEXT,
        inline_comments TEXT,
        extends_class TEXT,
        implements_interfaces TEXT,
        usage_example TEXT,
        usage_frequency INTEGER DEFAULT 0,
        pattern_type TEXT,
        typical_usages TEXT,
        called_by_count INTEGER DEFAULT 0,
        related_methods TEXT,
        api_patterns TEXT
      );
    `);

    // Create FTS5 virtual table for full-text search with enhanced fields
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
        name,
        type,
        parent_name,
        signature,
        description,
        tags,
        source_snippet,
        inline_comments,
        content='symbols',
        content_rowid='id'
      );
    `);

    // Create triggers to keep FTS table in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
        INSERT INTO symbols_fts(rowid, name, type, parent_name, signature, description, tags, source_snippet, inline_comments)
        VALUES (new.id, new.name, new.type, new.parent_name, new.signature, new.description, new.tags, new.source_snippet, new.inline_comments);
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
          signature = new.signature,
          description = new.description,
          tags = new.tags,
          source_snippet = new.source_snippet,
          inline_comments = new.inline_comments
        WHERE rowid = new.id;
      END;
    `);

    // Create indexes - optimized with composite indexes for common query patterns
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_type ON symbols(type);
      CREATE INDEX IF NOT EXISTS idx_symbols_model ON symbols(model);
      CREATE INDEX IF NOT EXISTS idx_symbols_pattern_type ON symbols(pattern_type);
      CREATE INDEX IF NOT EXISTS idx_symbols_parent_name ON symbols(parent_name);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_symbols_unique 
        ON symbols(name, type, COALESCE(parent_name, ''), model);
      
      -- Composite indexes for common query patterns (major speed boost)
      CREATE INDEX IF NOT EXISTS idx_type_parent ON symbols(type, parent_name) WHERE parent_name IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_type_name ON symbols(type, name);
      CREATE INDEX IF NOT EXISTS idx_parent_type ON symbols(parent_name, type) WHERE parent_name IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_name_type ON symbols(name, type);
    `);

    // Create code_patterns table for pattern analysis
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_name TEXT NOT NULL UNIQUE,
        pattern_type TEXT NOT NULL,
        common_methods TEXT,
        dependencies TEXT,
        usage_examples TEXT,
        frequency INTEGER DEFAULT 0,
        domain TEXT,
        characteristics TEXT
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_patterns_type ON code_patterns(pattern_type);
      CREATE INDEX IF NOT EXISTS idx_patterns_domain ON code_patterns(domain);
    `);
  }

  /**
   * Add a symbol to the index with enhanced metadata
   */
  addSymbol(symbol: XppSymbol): void {
    // Use cached prepared statement for performance
    let stmt = this.stmtCache.get('addSymbol');
    if (!stmt) {
      stmt = this.db.prepare(`
        INSERT OR REPLACE INTO symbols (
          name, type, parent_name, signature, file_path, model,
          description, tags, source_snippet, complexity, used_types, method_calls,
          inline_comments, extends_class, implements_interfaces, usage_example,
          usage_frequency, pattern_type, typical_usages, called_by_count, related_methods, api_patterns
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.stmtCache.set('addSymbol', stmt);
    }

    stmt.run(
      symbol.name,
      symbol.type,
      symbol.parentName || null,
      symbol.signature || null,
      symbol.filePath,
      symbol.model,
      symbol.description || null,
      symbol.tags || null,
      symbol.sourceSnippet || null,
      symbol.complexity || null,
      symbol.usedTypes || null,
      symbol.methodCalls || null,
      symbol.inlineComments || null,
      symbol.extendsClass || null,
      symbol.implementsInterfaces || null,
      symbol.usageExample || null,
      symbol.usageFrequency || 0,
      symbol.patternType || null,
      symbol.typicalUsages || null,
      symbol.calledByCount || 0,
      symbol.relatedMethods || null,
      symbol.apiPatterns || null
    );
  }

  /**
   * Search symbols by query with full-text search
   */
  searchSymbols(query: string, limit: number = 20, types?: string[]): XppSymbol[] {
    let sql = `
      SELECT s.*
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
    return rows.map(row => this.rowToSymbol(row));
  }

  /**
   * Search symbols by prefix (for autocomplete)
   */
  searchByPrefix(prefix: string, types?: string[], limit: number = 20): XppSymbol[] {
    let sql = `
      SELECT *
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
    return rows.map(row => this.rowToSymbol(row));
  }

  /**
   * Get a specific symbol by name and type
   */
  getSymbolByName(name: string, type: string): XppSymbol | null {
    const stmt = this.db.prepare(`
      SELECT *
      FROM symbols
      WHERE name = ? AND type = ?
      LIMIT 1
    `);

    const row = stmt.get(name, type) as any;
    if (!row) return null;

    return this.rowToSymbol(row);
  }

  /**
   * Get all classes (for resource listing)
   */
  getAllClasses(): XppSymbol[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM symbols
      WHERE type = 'class'
      ORDER BY name
    `);

    const rows = stmt.all() as any[];
    return rows.map(row => this.rowToSymbol(row));
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
   * Compute usage statistics (usage_frequency and called_by_count) for all methods
   * Should be called after initial indexing is complete
   * Optimized for 300k+ methods with minimal memory usage
   */
  computeUsageStatistics(): void {
    console.log('📊 Computing usage statistics...');
    const startTime = Date.now();
    
    // Step 1: Create temporary table with all method calls
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS temp_method_calls (
        caller_method TEXT,
        called_method TEXT
      );
      DELETE FROM temp_method_calls;
    `);
    
    // Get all methods with their method_calls
    const allMethods = this.db.prepare(`
      SELECT name, method_calls 
      FROM symbols 
      WHERE type = 'method' AND method_calls IS NOT NULL AND method_calls != ''
    `).all() as Array<{ name: string; method_calls: string }>;
    
    console.log(`   Found ${allMethods.length} methods with call references`);
    
    if (allMethods.length === 0) {
      console.log('   No method calls to process, skipping statistics');
      return;
    }
    
    // Step 2: Batch insert parsed method calls - OPTIMIZED
    console.log('   Parsing and inserting method calls...');
    const insertStmt = this.db.prepare(
      'INSERT INTO temp_method_calls (caller_method, called_method) VALUES (?, ?)'
    );
    
    // Process in batches of 1000 methods to show progress and allow GC
    const BATCH_SIZE = 1000;
    const totalBatches = Math.ceil(allMethods.length / BATCH_SIZE);
    
    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const batchStart = batchIdx * BATCH_SIZE;
      const batchEnd = Math.min(batchStart + BATCH_SIZE, allMethods.length);
      const batchMethods = allMethods.slice(batchStart, batchEnd);
      
      // Insert batch in single transaction
      const insertBatch = this.db.transaction(() => {
        for (const method of batchMethods) {
          // Fast CSV parsing - avoid unnecessary trim/filter
          const calls = method.method_calls.split(',');
          for (let i = 0; i < calls.length; i++) {
            const calledMethod = calls[i].trim();
            if (calledMethod) {
              insertStmt.run(method.name, calledMethod);
            }
          }
        }
      });
      insertBatch();
      
      // Progress every 10%
      if ((batchIdx + 1) % Math.ceil(totalBatches / 10) === 0 || batchIdx === totalBatches - 1) {
        const percent = Math.round(((batchIdx + 1) / totalBatches) * 100);
        console.log(`   Progress: ${percent}% (${batchEnd}/${allMethods.length} methods)`);
      }
      
      // Force GC in CI after each batch to prevent memory buildup
      if (isCI() && global.gc && batchIdx % 10 === 0) {
        global.gc();
      }
    }
    
    console.log('   Computing aggregated statistics...');
    
    // Step 3: OPTIMIZED - Use single UPDATE with JOIN instead of correlated subqueries
    const updateTransaction = this.db.transaction(() => {
      // Create temp table with aggregated counts and index
      this.db.exec(`
        CREATE TEMP TABLE temp_call_stats AS
        SELECT 
          called_method,
          COUNT(*) as total_calls,
          COUNT(DISTINCT caller_method) as unique_callers
        FROM temp_method_calls
        GROUP BY called_method;
        
        CREATE INDEX idx_temp_call_stats ON temp_call_stats(called_method);
      `);
      
      console.log('   Applying statistics to symbols...');
      
      // OPTIMIZED: Use LEFT JOIN UPDATE (SQLite 3.33+) - much faster!
      // If not supported, falls back to correlated subquery with index
      try {
        if (isCI()) {
          console.log('   Updating usage_frequency and called_by_count (this may take 1-2 minutes)...');
        }
        
        this.db.exec(`
          UPDATE symbols
          SET 
            usage_frequency = COALESCE((
              SELECT total_calls 
              FROM temp_call_stats 
              WHERE temp_call_stats.called_method = symbols.name
            ), 0),
            called_by_count = COALESCE((
              SELECT unique_callers 
              FROM temp_call_stats 
              WHERE temp_call_stats.called_method = symbols.name
            ), 0)
          WHERE type = 'method'
            AND EXISTS (SELECT 1 FROM temp_call_stats WHERE temp_call_stats.called_method = symbols.name);
        `);
        
        if (isCI()) {
          console.log('   Setting zero counts for unused methods...');
        }
        
        // Set to 0 for methods not in temp_call_stats
        this.db.exec(`
          UPDATE symbols
          SET usage_frequency = 0, called_by_count = 0
          WHERE type = 'method'
            AND NOT EXISTS (SELECT 1 FROM temp_call_stats WHERE temp_call_stats.called_method = symbols.name);
        `);
      } catch (e) {
        console.warn('   Optimized UPDATE failed, using fallback method');
        // Fallback to correlated subquery (slower but compatible)
        this.db.exec(`
          UPDATE symbols
          SET 
            usage_frequency = COALESCE((SELECT total_calls FROM temp_call_stats WHERE called_method = symbols.name), 0),
            called_by_count = COALESCE((SELECT unique_callers FROM temp_call_stats WHERE called_method = symbols.name), 0)
          WHERE type = 'method';
        `);
      }
      
      // Cleanup
      this.db.exec('DROP TABLE IF EXISTS temp_call_stats;');
    });
    updateTransaction();
    
    // Cleanup
    this.db.exec('DROP TABLE temp_method_calls;');
    
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    console.log(`✅ Usage statistics computed in ${duration}s`);
  }

  /**
   * Index metadata from a directory
   * Uses single transaction for all models - fastest approach with 8GB heap
   */
  async indexMetadataDirectory(metadataPath: string, modelName?: string): Promise<void> {
    const models = modelName ? [modelName] : await this.getModelDirectories(metadataPath);

    console.log(`   Processing ${models.length} model(s)...`);
    const startTime = Date.now();

    // Wrap everything in a single transaction for maximum performance
    // With 8GB heap, this handles all 358 models without memory issues
    // Result: 1 transaction = 1 disk fsync = ~4 minutes (original speed)
    const transaction = this.db.transaction(() => {
      let modelIndex = 0;
      for (const model of models) {
        modelIndex++;
        const modelPath = path.join(metadataPath, model);
        
        // Log progress every 50 models in CI
        if (isCI() && modelIndex % 50 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`   Progress: ${modelIndex}/${models.length} models (${elapsed}s elapsed)...`);
        }
        
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
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`   ✅ Indexed ${models.length} model(s) in ${duration}s`);
  }

  private async getModelDirectories(metadataPath: string): Promise<string[]> {
    const entries = fs.readdirSync(metadataPath, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  }

  private indexClasses(classesPath: string, model: string): void {
    const files = fs.readdirSync(classesPath).filter(f => f.endsWith('.json'));
    
    // Basic logging for large models
    if (files.length > 1000) {
      console.log(`      Processing ${files.length} classes...`);
    }
    
    let processedCount = 0;
    for (const file of files) {
      try {
        const filePath = path.join(classesPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const classData = JSON.parse(content);

        // Use sourcePath from metadata (original XML file) instead of JSON file path
        const sourceFilePath = classData.sourcePath || filePath;

        // Add class symbol with enhanced metadata
        this.addSymbol({
          name: classData.name,
          type: 'class',
          signature: classData.extends ? `extends ${classData.extends}` : undefined,
          filePath: sourceFilePath,
          model,
          description: classData.description || classData.documentation,
          tags: classData.tags?.join(', '),
          extendsClass: classData.extends,
          implementsInterfaces: classData.implements?.join(', '),
          usedTypes: classData.usedTypes?.join(', '),
          // Pattern analysis fields
          patternType: classData.patternType,
          typicalUsages: classData.typicalUsages ? JSON.stringify(classData.typicalUsages) : undefined,
          relatedMethods: classData.relatedMethods ? JSON.stringify(classData.relatedMethods) : undefined,
          apiPatterns: classData.apiPatterns ? JSON.stringify(classData.apiPatterns) : undefined,
        });

        // Add method symbols with enhanced metadata
        if (classData.methods && Array.isArray(classData.methods)) {
          for (const method of classData.methods) {
            const params = method.parameters?.map((p: any) => `${p.type} ${p.name}`).join(', ') || '';
            
            this.addSymbol({
              name: method.name,
              type: 'method',
              parentName: classData.name,
              signature: `${method.returnType} ${method.name}(${params})`,
              filePath: sourceFilePath,
              model,
              description: method.documentation,
              tags: method.tags?.join(', '),
              sourceSnippet: method.sourceSnippet,
              complexity: method.complexity,
              usedTypes: method.usedTypes?.join(', '),
              methodCalls: method.methodCalls?.join(', '),
              inlineComments: method.inlineComments,
              usageExample: method.usageExample,
              // Pattern analysis fields
              typicalUsages: method.typicalUsages ? JSON.stringify(method.typicalUsages) : undefined,
              relatedMethods: method.relatedMethods ? JSON.stringify(method.relatedMethods) : undefined,
            });
          }
        }
        
        processedCount++;
        // Log progress every 500 classes for very large models
        if (files.length > 1000 && processedCount % 500 === 0) {
          console.log(`      Processed ${processedCount}/${files.length} classes...`);
        }
      } catch (error) {
        // Only log errors, don't stop processing
        console.error(`      ⚠️  Skipped ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private indexTables(tablesPath: string, model: string): void {
    const files = fs.readdirSync(tablesPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const filePath = path.join(tablesPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const tableData = JSON.parse(content);

        // Use sourcePath from metadata (original XML file) instead of JSON file path
        const sourceFilePath = tableData.sourcePath || filePath;

        // Add table symbol
        this.addSymbol({
          name: tableData.name,
          type: 'table',
          signature: tableData.label || undefined,
          filePath: sourceFilePath,
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
              filePath: sourceFilePath,
              model,
            });
          }
        }
      } catch (error) {
        // Only log errors, don't stop processing
        console.error(`      ⚠️  Skipped table ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private indexEnums(enumsPath: string, model: string): void {
    const files = fs.readdirSync(enumsPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const filePath = path.join(enumsPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const enumData = JSON.parse(content);

        // Use sourcePath from metadata (original XML file) instead of JSON file path
        const sourceFilePath = enumData.sourcePath || filePath;
        const enumName = enumData.name || path.basename(file, '.json');

        // Add enum symbol
        this.addSymbol({
          name: enumName,
          type: 'enum',
          filePath: sourceFilePath,
          model,
        });
      
      } catch (error) {
        // Only log errors, don't stop processing
        console.error(`      ⚠️  Skipped enum ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  /**
   * Get class methods for autocomplete
   */
  getClassMethods(className: string): XppSymbol[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM symbols
      WHERE parent_name = ? AND type = 'method'
      ORDER BY name
    `);

    const rows = stmt.all(className) as any[];
    return rows.map(row => this.rowToSymbol(row));
  }

  /**
   * Get table fields for autocomplete
   */
  getTableFields(tableName: string): XppSymbol[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM symbols
      WHERE parent_name = ? AND type = 'field'
      ORDER BY name
    `);

    const rows = stmt.all(tableName) as any[];
    return rows.map(row => this.rowToSymbol(row));
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
      SELECT *
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
    return rows.map(row => this.rowToSymbol(row));
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
   * Analyze code patterns for a given scenario/domain
   */
  analyzeCodePatterns(scenario: string, classPattern?: string, limit: number = 20): any {
    // Extract keywords from scenario for better search
    const keywords = scenario.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3 && !['with', 'which', 'will', 'that', 'this', 'from', 'have'].includes(w));
    
    let sql: string;
    const params: any[] = [];
    
    if (keywords.length > 0) {
      // Use FTS5 for better text search
      sql = `
        SELECT DISTINCT s.* 
        FROM symbols s
        WHERE s.type = 'class'
          AND (
            s.id IN (
              SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ?
            )
            ${keywords.slice(1).map(() => `
            OR s.id IN (
              SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ?
            )`).join('')}
            ${keywords.map(() => 'OR s.name LIKE ? OR s.tags LIKE ?').join(' ')}
          )
      `;
      
      // Add FTS match parameters
      for (const keyword of keywords) {
        params.push(keyword);
      }
      // Add LIKE parameters
      for (const keyword of keywords) {
        params.push(`%${keyword}%`, `%${keyword}%`);
      }
    } else {
      // Fallback to simple search
      sql = `
        SELECT * FROM symbols
        WHERE type = 'class'
          AND (name LIKE ? OR tags LIKE ? OR description LIKE ?)
      `;
      params.push(`%${scenario}%`, `%${scenario}%`, `%${scenario}%`);
    }
    
    if (classPattern) {
      sql += ` AND name LIKE ?`;
      params.push(`%${classPattern}`);
    }
    
    sql += ` LIMIT ?`;
    params.push(limit);
    
    const stmt = this.db.prepare(sql);
    const classes = stmt.all(...params) as any[];
    
    // Analyze common patterns
    const methodFrequency: Record<string, number> = {};
    const dependencyFrequency: Record<string, number> = {};
    const exampleClasses: string[] = [];
    
    for (const cls of classes) {
      exampleClasses.push(cls.name);
      
      // Count method frequencies
      const methods = this.getClassMethods(cls.name);
      for (const method of methods) {
        methodFrequency[method.name] = (methodFrequency[method.name] || 0) + 1;
      }
      
      // Count dependency frequencies
      if (cls.used_types) {
        const types = cls.used_types.split(',');
        for (const type of types) {
          const cleaned = type.trim();
          if (cleaned) {
            dependencyFrequency[cleaned] = (dependencyFrequency[cleaned] || 0) + 1;
          }
        }
      }
    }
    
    // Get top methods and dependencies
    const commonMethods = Object.entries(methodFrequency)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20)
      .map(([name, count]) => ({ name, frequency: count }));
      
    const commonDependencies = Object.entries(dependencyFrequency)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 15)
      .map(([name, count]) => ({ name, frequency: count }));
    
    return {
      scenario,
      totalMatches: classes.length,
      commonMethods,
      commonDependencies,
      exampleClasses: exampleClasses.slice(0, 10),
      patterns: this.detectPatternTypes(classes)
    };
  }

  /**
   * Detect pattern types from set of classes
   */
  private detectPatternTypes(classes: any[]): any[] {
    const patterns: Record<string, { count: number; examples: string[] }> = {};
    
    for (const cls of classes) {
      const name = cls.name;
      let patternType = 'Unknown';
      
      if (name.endsWith('Helper')) patternType = 'Helper';
      else if (name.endsWith('Service')) patternType = 'Service';
      else if (name.endsWith('Controller')) patternType = 'Controller';
      else if (name.endsWith('Handler')) patternType = 'Handler';
      else if (name.endsWith('Repository') || name.endsWith('Repo')) patternType = 'Repository';
      else if (name.endsWith('Manager')) patternType = 'Manager';
      else if (name.endsWith('Factory')) patternType = 'Factory';
      else if (name.endsWith('Builder')) patternType = 'Builder';
      else if (name.endsWith('Processor')) patternType = 'Processor';
      else if (name.endsWith('Validator')) patternType = 'Validator';
      
      if (!patterns[patternType]) {
        patterns[patternType] = { count: 0, examples: [] };
      }
      patterns[patternType].count++;
      if (patterns[patternType].examples.length < 5) {
        patterns[patternType].examples.push(name);
      }
    }
    
    return Object.entries(patterns).map(([type, data]) => ({
      patternType: type,
      count: data.count,
      examples: data.examples
    }));
  }

  /**
   * Find similar methods based on name and context
   */
  findSimilarMethods(methodName: string, _contextClass?: string, limit: number = 10): any[] {
    const sql = `
      SELECT s.*, parent.name as class_name, parent.pattern_type
      FROM symbols s
      LEFT JOIN symbols parent ON s.parent_name = parent.name AND parent.type = 'class'
      WHERE s.type = 'method' 
        AND s.name LIKE ?
      ORDER BY s.complexity ASC, s.name
      LIMIT ?
    `;
    
    const stmt = this.db.prepare(sql);
    const methods = stmt.all(`%${methodName}%`, limit) as any[];
    
    return methods.map(m => ({
      className: m.class_name || m.parent_name,
      methodName: m.name,
      signature: m.signature,
      sourceSnippet: m.source_snippet,
      complexity: m.complexity,
      tags: m.tags?.split(',').filter(Boolean) || [],
      patternType: m.pattern_type
    }));
  }

  /**
   * Get API usage patterns for a class
   */
  getApiUsagePatterns(className: string): any {
    // Find all places where this class is used
    const sql = `
      SELECT * FROM symbols
      WHERE type = 'method'
        AND used_types LIKE ?
      LIMIT 50
    `;
    
    const stmt = this.db.prepare(sql);
    const methods = stmt.all(`%${className}%`) as any[];
    
    if (methods.length === 0) {
      return {
        className,
        usageCount: 0,
        commonPatterns: [],
        initPatterns: [],
        methodCallSequences: []
      };
    }
    
    const methodCallPatterns: Record<string, number> = {};
    const initPatterns: string[] = [];
    
    for (const method of methods) {
      if (method.method_calls) {
        const calls = method.method_calls.split(',').map((c: string) => c.trim());
        for (const call of calls) {
          methodCallPatterns[call] = (methodCallPatterns[call] || 0) + 1;
        }
      }
      
      // Detect initialization patterns
      if (method.source_snippet && method.source_snippet.includes('new ' + className)) {
        const snippetLines = method.source_snippet.split('\n').slice(0, 5);
        initPatterns.push(snippetLines.join('\n'));
      }
    }
    
    const commonMethodCalls = Object.entries(methodCallPatterns)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([name, count]) => ({ method: name, frequency: count }));
    
    return {
      className,
      usageCount: methods.length,
      commonMethodCalls,
      initPatterns: initPatterns.slice(0, 5),
      usedInClasses: methods.map((m: any) => m.parent_name).filter(Boolean).slice(0, 10)
    };
  }

  /**
   * Suggest missing methods for a class based on pattern analysis
   */
  suggestMissingMethods(className: string): any[] {
    const classSymbol = this.getSymbolByName(className, 'class');
    if (!classSymbol) return [];
    
    // Get existing methods
    const existingMethods = this.getClassMethods(className);
    const existingMethodNames = new Set(existingMethods.map(m => m.name));
    
    // Detect pattern type
    let patternType = classSymbol.patternType || 'Unknown';
    if (!patternType || patternType === 'Unknown') {
      if (className.endsWith('Helper')) patternType = 'Helper';
      else if (className.endsWith('Service')) patternType = 'Service';
      else if (className.endsWith('Controller')) patternType = 'Controller';
    }
    
    // Find similar classes with same pattern
    const sql = `
      SELECT DISTINCT parent_name
      FROM symbols
      WHERE type = 'method'
        AND parent_name LIKE ?
        AND parent_name != ?
      LIMIT 20
    `;
    
    const stmt = this.db.prepare(sql);
    const similarClasses = stmt.all(`%${patternType}`, className) as any[];
    
    // Count method occurrences in similar classes
    const methodFrequency: Record<string, number> = {};
    
    for (const row of similarClasses) {
      const methods = this.getClassMethods(row.parent_name);
      for (const method of methods) {
        if (!existingMethodNames.has(method.name)) {
          methodFrequency[method.name] = (methodFrequency[method.name] || 0) + 1;
        }
      }
    }
    
    // Return top missing methods
    return Object.entries(methodFrequency)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([name, count]) => ({
        methodName: name,
        frequency: count,
        totalClasses: similarClasses.length,
        percentage: Math.round((count / similarClasses.length) * 100)
      }));
  }

  /**
   * Clear all symbols
   */
  clear(): void {
    this.db.exec('DELETE FROM symbols');
    this.vacuum();
  }

  /**
   * Clear symbols for specific models
   */
  clearModels(modelNames: string[]): void {
    if (modelNames.length === 0) return;
    
    const placeholders = modelNames.map(() => '?').join(',');
    const stmt = this.db.prepare(`DELETE FROM symbols WHERE model IN (${placeholders})`);
    stmt.run(...modelNames);
    
    console.log(`🗑️  Cleared symbols for models: ${modelNames.join(', ')}`);
    this.vacuum();
  }

  /**
   * Vacuum the database to reclaim space after deletions
   */
  private vacuum(): void {
    this.db.exec('VACUUM');
  }

  /**
   * Get all symbol names for fuzzy matching
   * Used by suggestion engine for typo detection
   * Uses iterator to avoid loading all names into memory at once
   */
  getAllSymbolNames(): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT name
      FROM symbols
      ORDER BY name
      LIMIT 5000
    `);
    
    const names: string[] = [];
    for (const row of stmt.iterate() as IterableIterator<{ name: string }>) {
      names.push(row.name);
    }
    return names;
  }

  /**
   * Get symbols grouped by term (for relationship analysis)
   * Returns a map of term -> symbols with that term
   * Uses iterator to avoid loading all symbols into memory at once
   */
  getSymbolsByTerm(): Map<string, XppSymbol[]> {
    const stmt = this.db.prepare(`
      SELECT *
      FROM symbols
      WHERE used_types IS NOT NULL 
         OR method_calls IS NOT NULL 
         OR related_methods IS NOT NULL
      ORDER BY name
      LIMIT 3000
    `);
    
    const symbolsByTerm = new Map<string, XppSymbol[]>();
    
    for (const row of stmt.iterate() as IterableIterator<any>) {
      const symbol = this.rowToSymbol(row);
      const termLower = symbol.name.toLowerCase();
      
      if (!symbolsByTerm.has(termLower)) {
        symbolsByTerm.set(termLower, []);
      }
      symbolsByTerm.get(termLower)!.push(symbol);
    }
    
    return symbolsByTerm;
  }

  /**
   * Get all symbols for relationship analysis
   * Used to build term relationship graph
   * Uses iterator to avoid memory exhaustion on large datasets
   */
  getAllSymbolsForAnalysis(): XppSymbol[] {
    const stmt = this.db.prepare(`
      SELECT *
      FROM symbols
      WHERE used_types IS NOT NULL 
         OR method_calls IS NOT NULL 
         OR related_methods IS NOT NULL
         OR parent_name IS NOT NULL
         OR extends_class IS NOT NULL
      LIMIT 2000
    `);
    
    const symbols: XppSymbol[] = [];
    for (const row of stmt.iterate() as IterableIterator<any>) {
      symbols.push(this.rowToSymbol(row));
    }
    return symbols;
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.stmtCache.clear();
    this.db.close();
  }
}
