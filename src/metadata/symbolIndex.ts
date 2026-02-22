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
  public db: Database.Database; // Public for direct pragma access in build scripts
  public labelsDb: Database.Database; // Separate DB for labels (performance optimization)
  private standardModels: string[] = [];
  private stmtCache: Map<string, Database.Statement> = new Map();
  private labelsStmtCache: Map<string, Database.Statement> = new Map();

  constructor(dbPath: string, labelsDbPath?: string) {
    // Ensure database directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    
    // 🎯 PERFORMANCE: Separate database for labels
    // This keeps the main symbol DB small and fast for search operations
    // Labels DB can be huge (20M+ rows) without affecting search performance
    const labelPath = labelsDbPath || dbPath.replace('.db', '-labels.db');
    this.labelsDb = new Database(labelPath);
    
    // Enable SQLite performance optimizations for both DBs
    // Note: journal_mode should be set by caller (MEMORY for build, WAL for production)
    if (!this.db.pragma('journal_mode', { simple: true })) {
      // Set default to WAL if not already configured
      this.db.pragma('journal_mode = WAL'); // Write-Ahead Logging for better concurrency
    }
    this.db.pragma('synchronous = NORMAL'); // Faster writes, still crash-safe
    this.db.pragma('cache_size = -64000'); // 64MB cache (negative = kibibytes)
    this.db.pragma('temp_store = MEMORY'); // Store temp tables in memory
    this.db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O
    
    // Configure labels DB similarly
    if (!this.labelsDb.pragma('journal_mode', { simple: true })) {
      this.labelsDb.pragma('journal_mode = WAL');
    }
    this.labelsDb.pragma('synchronous = NORMAL');
    this.labelsDb.pragma('cache_size = -32000'); // 32MB cache for labels
    this.labelsDb.pragma('temp_store = MEMORY');
    this.labelsDb.pragma('mmap_size = 134217728'); // 128MB memory-mapped I/O
    // Note: page_size is a no-op on an existing database; only applies to new DBs
    // Note: optimize and ANALYZE are intentionally NOT run here — they are slow
    //       (seconds on 500K+ rows) and the pre-built DB already has persisted stats.
    //       Call runPostBuildTasks() from build scripts instead.
    
    this.loadStandardModels();
    this.initializeDatabase();
  }

  /**
   * Run post-build maintenance tasks: ANALYZE + optimize.
   * Call this at the END of build scripts (after all data is loaded and WAL mode is set).
   * Do NOT call from the production server startup — the pre-built DB already has stats.
   */
  runPostBuildTasks(): void {
    console.log('🔧 Running post-build database optimization (ANALYZE + optimize)...');
    const start = Date.now();
    try {
      // Optimize main symbol database
      this.db.pragma('analysis_limit = 1000');
      this.db.exec('ANALYZE');
      this.db.pragma('optimize');
      
      // Optimize labels database
      this.labelsDb.pragma('analysis_limit = 1000');
      this.labelsDb.exec('ANALYZE');
      this.labelsDb.pragma('optimize');
      
      const elapsed = ((Date.now() - start) / 1000).toFixed(2);
      console.log(`✅ Post-build optimization complete in ${elapsed}s`);
    } catch (e) {
      console.warn('⚠️  Post-build optimization failed (non-fatal):', e);
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

    // Migrate existing symbols table: add any columns that may be missing
    // (needed when opening a DB built with an older schema)
    {
      const existingCols = new Set(
        (this.db.pragma('table_info(symbols)') as Array<{ name: string }>).map(r => r.name)
      );
      const newCols: Array<[string, string]> = [
        ['description', 'TEXT'],
        ['tags', 'TEXT'],
        ['source_snippet', 'TEXT'],
        ['complexity', 'INTEGER'],
        ['used_types', 'TEXT'],
        ['method_calls', 'TEXT'],
        ['inline_comments', 'TEXT'],
        ['extends_class', 'TEXT'],
        ['implements_interfaces', 'TEXT'],
        ['usage_example', 'TEXT'],
        ['usage_frequency', 'INTEGER DEFAULT 0'],
        ['pattern_type', 'TEXT'],
        ['typical_usages', 'TEXT'],
        ['called_by_count', 'INTEGER DEFAULT 0'],
        ['related_methods', 'TEXT'],
        ['api_patterns', 'TEXT'],
      ];
      for (const [col, def] of newCols) {
        if (!existingCols.has(col)) {
          this.db.exec(`ALTER TABLE symbols ADD COLUMN ${col} ${def};`);
        }
      }
    }

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
    this.createFTSTriggers();

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

    // 🎯 LABELS MOVED TO SEPARATE DATABASE (labelsDb)
    // This keeps the main symbol DB fast for search operations
    // Initialize labels tables in the separate labels database
    this.labelsDb.exec(`
      CREATE TABLE IF NOT EXISTS labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label_id TEXT NOT NULL,
        label_file_id TEXT NOT NULL,
        model TEXT NOT NULL,
        language TEXT NOT NULL,
        text TEXT NOT NULL,
        comment TEXT,
        file_path TEXT NOT NULL
      );
    `);

    this.labelsDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_labels_id ON labels(label_id);
      CREATE INDEX IF NOT EXISTS idx_labels_file_id ON labels(label_file_id);
      CREATE INDEX IF NOT EXISTS idx_labels_model ON labels(model);
      CREATE INDEX IF NOT EXISTS idx_labels_language ON labels(language);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_unique
        ON labels(label_id, label_file_id, model, language);
    `);

    // FTS5 full-text search for labels (en-US text only – primary search language)
    this.labelsDb.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS labels_fts USING fts5(
        label_id,
        text,
        comment,
        content='labels',
        content_rowid='id'
      );
    `);

    // Only index en-US rows to keep FTS compact (~5x smaller on typical installs)
    this.labelsDb.exec(`
      CREATE TRIGGER IF NOT EXISTS labels_ai AFTER INSERT ON labels WHEN new.language = 'en-US' BEGIN
        INSERT INTO labels_fts(rowid, label_id, text, comment)
        VALUES (new.id, new.label_id, new.text, new.comment);
      END;
      CREATE TRIGGER IF NOT EXISTS labels_ad AFTER DELETE ON labels WHEN old.language = 'en-US' BEGIN
        INSERT INTO labels_fts(labels_fts, rowid, label_id, text, comment)
        VALUES ('delete', old.id, old.label_id, old.text, old.comment);
      END;
      CREATE TRIGGER IF NOT EXISTS labels_au AFTER UPDATE ON labels WHEN old.language = 'en-US' OR new.language = 'en-US' BEGIN
        INSERT INTO labels_fts(labels_fts, rowid, label_id, text, comment)
        VALUES ('delete', old.id, old.label_id, old.text, old.comment);
        INSERT INTO labels_fts(rowid, label_id, text, comment)
        VALUES (new.id, new.label_id, new.text, new.comment);
      END;
    `);
  }

  /**
   * Create FTS triggers for keeping symbols_fts in sync
   * Extracted to allow disabling during bulk inserts and re-enabling after
   */
  private createFTSTriggers(): void {
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
   * Sanitize a user query for FTS5 to prevent syntax errors.
   * FTS5 operators (AND, OR, NOT, NEAR, quotes, parens, *) can crash the engine
   * when they appear in raw user input. Wraps each token as a quoted prefix term.
   *
   * Performance: restricts the MATCH to the small/fast columns only.
   * source_snippet and inline_comments hold full X++ source code (100-2000 chars per
   * method × 300K+ methods) — including them in every FTS scan is the single biggest
   * cause of slow symbol searches after table-method indexing was added.
   */
  private sanitizeFtsQuery(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) return '""';
    
    // Minimal stop words - only the most common query keywords
    const stopWords = new Set([
      // Common query verbs (Czech)
      'vyhledej', 'najdi', 'zobraz', 'ukaž', 'související', 'proces', 'procesy',
      // Common query verbs (English)  
      'find', 'search', 'show', 'get', 'list', 'related', 'process', 'processes',
      // Object type keywords (already in type parameter)
      'method', 'methods', 'class', 'classes', 'table', 'tables', 'třídy', 'třída'
    ]);
    
    // Strip FTS5 special characters – keep alphanumeric, underscore and spaces
    const cleaned = trimmed.replace(/[^\w\s]/g, ' ').trim();
    const tokens = cleaned
      .split(/\s+/)
      .filter(t => t.length > 0)
      .map(t => t.toLowerCase())
      .filter(t => !stopWords.has(t) && t.length > 1); // Filter stop words and single chars
    
    // If no tokens remain after filtering, use original query in quotes
    if (tokens.length === 0) {
      return `{name type parent_name signature description tags} : "${trimmed}"`;
    }
    
    // Create FTS query with prefix matching
    const baseQuery = tokens.map(t => `"${t}"*`).join(' ');
    
    // Column-set filter: FTS5 searches only these columns, skipping source_snippet
    // and inline_comments. This is valid FTS5 syntax and uses the same index.
    return `{name type parent_name signature description tags} : ${baseQuery}`;
  }

  /**
   * Search symbols by query with full-text search
   * PERFORMANCE: Only select essential columns (name, type, parent_name, signature, model, file_path)
   * Uses prepared statement caching for common queries
   */
  searchSymbols(query: string, limit: number = 20, types?: string[]): XppSymbol[] {
    const ftsQuery = this.sanitizeFtsQuery(query);
    
    // PERFORMANCE: Cache prepared statements for common search patterns
    const cacheKey = types?.length ? `search_typed_${types.join('_')}` : 'search_all';
    
    // PERFORMANCE: Select only essential columns, not s.* (avoids loading large text fields)
    let sql = `
      SELECT s.id, s.name, s.type, s.parent_name, s.signature, s.file_path, s.model, s.description
      FROM symbols_fts fts
      JOIN symbols s ON s.id = fts.rowid
      WHERE symbols_fts MATCH ?
    `;

    const params: any[] = [ftsQuery];

    if (types && types.length > 0) {
      sql += ` AND s.type IN (${types.map(() => '?').join(',')})`;  
      params.push(...types);
    }

    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);

    try {
      let stmt = this.stmtCache.get(cacheKey);
      if (!stmt) {
        stmt = this.db.prepare(sql);
        this.stmtCache.set(cacheKey, stmt);
      }
      const rows = stmt.all(...params) as any[];
      return rows.map(row => this.rowToSymbol(row));
    } catch {
      // FTS5 syntax error (e.g. user typed *, ", (, ), -) — fall back to LIKE contains search
      // PERFORMANCE: Also select only essential columns in fallback
      const fallbackCacheKey = types?.length ? `fallback_typed_${types.join('_')}` : 'fallback_all';
      let fallbackSql = `SELECT s.id, s.name, s.type, s.parent_name, s.signature, s.file_path, s.model, s.description FROM symbols s WHERE s.name LIKE ?`;
      const fallbackParams: any[] = [`%${query.replace(/[%_]/g, '\\$&')}%`];
      if (types && types.length > 0) {
        fallbackSql += ` AND s.type IN (${types.map(() => '?').join(',')})`;
        fallbackParams.push(...types);
      }
      fallbackSql += ` ORDER BY s.name LIMIT ?`;
      fallbackParams.push(limit);
      
      let fallbackStmt = this.stmtCache.get(fallbackCacheKey);
      if (!fallbackStmt) {
        fallbackStmt = this.db.prepare(fallbackSql);
        this.stmtCache.set(fallbackCacheKey, fallbackStmt);
      }
      return (fallbackStmt.all(...fallbackParams) as any[]).map(r => this.rowToSymbol(r));
    }
  }

  /**
   * Search symbols by prefix (for autocomplete)
   * PERFORMANCE: Only select essential columns
   */
  searchByPrefix(prefix: string, types?: string[], limit: number = 20): XppSymbol[] {
    let sql = `
      SELECT id, name, type, parent_name, signature, file_path, model, description
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
    let stmt = this.stmtCache.get('getSymbolByName');
    if (!stmt) {
      stmt = this.db.prepare(`SELECT * FROM symbols WHERE name = ? AND type = ? LIMIT 1`);
      this.stmtCache.set('getSymbolByName', stmt);
    }
    const row = stmt.get(name, type) as any;
    return row ? this.rowToSymbol(row) : null;
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
    
    // Temporarily disable synchronous writes for speed during statistics computation
    const originalSync = this.db.pragma('synchronous', { simple: true });
    this.db.pragma('synchronous = OFF');
    
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
    
    // Restore original synchronous setting
    this.db.pragma(`synchronous = ${originalSync}`);
    
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    console.log(`✅ Usage statistics computed in ${duration}s`);
  }

  /**
   * Index metadata from a directory
   * Uses single transaction for all models - fastest approach with 8GB heap
   */
  async indexMetadataDirectory(metadataPath: string, modelName?: string): Promise<void> {
    const skipFts = process.env.SKIP_FTS === 'true';
    const resumable = process.env.RESUME === 'true';

    const allModels = modelName ? [modelName] : await this.getModelDirectories(metadataPath);

    // Sort largest models first — ensures Foundation (56K files) is indexed before any CI timeout
    let models = allModels;
    if (!modelName) {
      models = this.sortModelsBySize(metadataPath, allModels);
    }

    // Skip already-indexed models when resuming (RESUME=true)
    if (resumable) {
      const done = this.getIndexedModels();
      const skipped = models.filter(m => done.has(m));
      models = models.filter(m => !done.has(m));
      if (skipped.length > 0) {
        console.log(`   ♻️  Resuming build: skipping ${skipped.length} already-indexed model(s)`);
      }
    }

    const startTime = Date.now();

    // Disable FTS triggers during bulk insert — we rebuild FTS once at the end
    this.db.exec('DROP TRIGGER IF EXISTS symbols_ai;');
    this.db.exec('DROP TRIGGER IF EXISTS symbols_au;');
    this.db.exec('DROP TRIGGER IF EXISTS symbols_ad;');

    // Prepare progress statement (executes inside each model's transaction)
    const markProgress = resumable
      ? this.db.prepare(`INSERT OR REPLACE INTO _build_progress (model, indexed_at) VALUES (?, ?)`)
      : null;

    // Per-model transactions instead of one giant transaction.
    // Benefits vs. single transaction:
    //   • Peak memory = 1 model's inserts (not 100K files × full dataset in MEMORY journal)
    //   • Progress is committed to disk after each model — safe to resume on timeout
    //   • Foundation (56K files) no longer holds 7+ GB in RAM before first commit
    let modelIndex = 0;
    for (const model of models) {
      modelIndex++;
      const modelPath = path.join(metadataPath, model);
      const modelStartTime = Date.now();

      const tx = this.db.transaction(() => {
        const classesPath = path.join(modelPath, 'classes');
        if (fs.existsSync(classesPath)) this.indexClasses(classesPath, model);

        const tablesPath = path.join(modelPath, 'tables');
        if (fs.existsSync(tablesPath)) this.indexTables(tablesPath, model);

        const formsPath = path.join(modelPath, 'forms');
        if (fs.existsSync(formsPath)) this.indexForms(formsPath, model);

        const queriesPath = path.join(modelPath, 'queries');
        if (fs.existsSync(queriesPath)) this.indexQueries(queriesPath, model);

        const viewsPath = path.join(modelPath, 'views');
        if (fs.existsSync(viewsPath)) this.indexViews(viewsPath, model);

        const enumsPath = path.join(modelPath, 'enums');
        if (fs.existsSync(enumsPath)) this.indexEnums(enumsPath, model);

        // Mark model as done atomically with its data (same transaction)
        markProgress?.run(model, Date.now());
      });
      tx();

      const modelDuration = ((Date.now() - modelStartTime) / 1000).toFixed(1);
      const progressPercent = ((modelIndex / models.length) * 100).toFixed(0);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`   📦 [${progressPercent}%] ${model} - ${modelDuration}s (${elapsed}s total)`);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    if (skipFts) {
      // Phase 1 of two-phase CI build: symbols only, FTS deferred to build-fts step
      console.log(`   ⏭️  Skipping FTS rebuild (SKIP_FTS=true) — run 'npm run build-fts' to finish`);
      this.createFTSTriggers();
      console.log(`   ✅ Indexed ${models.length} model(s) in ${duration}s`);
    } else {
      // Rebuild FTS index from scratch (much faster than per-insert triggers)
      const ftsStartTime = Date.now();
      this.db.exec("INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild');");
      const ftsDuration = ((Date.now() - ftsStartTime) / 1000).toFixed(1);
      this.createFTSTriggers();
      console.log(`   ✅ Indexed ${models.length} model(s) in ${duration}s (FTS rebuilt in ${ftsDuration}s)`);
    }
  }

  /**
   * Sort models by JSON file count descending.
   * Ensures the largest models (e.g. Foundation with 56K files) are indexed first,
   * so the most data is committed to disk before any CI pipeline timeout.
   */
  private sortModelsBySize(metadataPath: string, models: string[]): string[] {
    const subdirs = ['classes', 'tables', 'forms', 'queries', 'views', 'enums'];
    const sized = models.map(model => {
      let count = 0;
      const modelPath = path.join(metadataPath, model);
      for (const sub of subdirs) {
        const p = path.join(modelPath, sub);
        if (fs.existsSync(p)) {
          count += fs.readdirSync(p).filter(f => f.endsWith('.json')).length;
        }
      }
      return { model, count };
    });
    return sized.sort((a, b) => b.count - a.count).map(s => s.model);
  }

  /**
   * Get the set of models already indexed (for RESUME=true builds).
   */
  getIndexedModels(): Set<string> {
    try {
      const rows = this.db.prepare(`SELECT model FROM _build_progress`).all() as { model: string }[];
      return new Set(rows.map(r => r.model));
    } catch {
      return new Set();
    }
  }

  /**
   * Clear progress tracking checkpoint (call before a fresh full rebuild).
   */
  clearProgressTracking(): void {
    try {
      this.db.exec(`DELETE FROM _build_progress`);
    } catch {
      // Table may not exist yet
    }
  }

  /**
   * Rebuild the FTS index for symbols from scratch.
   * Use this as a standalone step after a SKIP_FTS=true build (Phase 2 of two-phase CI).
   */
  rebuildFTS(): void {
    console.log('🔍 Rebuilding symbols FTS index...');
    this.db.exec('DROP TRIGGER IF EXISTS symbols_ai;');
    this.db.exec('DROP TRIGGER IF EXISTS symbols_au;');
    this.db.exec('DROP TRIGGER IF EXISTS symbols_ad;');
    const start = Date.now();
    this.db.exec("INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild');");
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    this.createFTSTriggers();
    console.log(`✅ Symbols FTS index rebuilt in ${duration}s`);
  }

  private async getModelDirectories(metadataPath: string): Promise<string[]> {
    const entries = fs.readdirSync(metadataPath, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  }

  private indexClasses(classesPath: string, model: string): void {
    const files = fs.readdirSync(classesPath).filter(f => f.endsWith('.json'));
    
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

  private indexForms(formsPath: string, model: string): void {
    const files = fs.readdirSync(formsPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const filePath = path.join(formsPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const formData = JSON.parse(content);

        // Use sourcePath from metadata (original XML file) instead of JSON file path
        const sourceFilePath = formData.sourcePath || filePath;
        const formName = formData.name || path.basename(file, '.json');

        // Add form symbol
        this.addSymbol({
          name: formName,
          type: 'form',
          filePath: sourceFilePath,
          model,
          description: formData.caption || formData.label,
        });
      
      } catch (error) {
        // Only log errors, don't stop processing
        console.error(`      ⚠️  Skipped form ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private indexQueries(queriesPath: string, model: string): void {
    const files = fs.readdirSync(queriesPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const filePath = path.join(queriesPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const queryData = JSON.parse(content);

        // Use sourcePath from metadata (original XML file) instead of JSON file path
        const sourceFilePath = queryData.sourcePath || filePath;
        const queryName = queryData.name || path.basename(file, '.json');

        // Add query symbol
        this.addSymbol({
          name: queryName,
          type: 'query',
          filePath: sourceFilePath,
          model,
          description: queryData.title || queryData.label,
        });
      
      } catch (error) {
        // Only log errors, don't stop processing
        console.error(`      ⚠️  Skipped query ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private indexViews(viewsPath: string, model: string): void {
    const files = fs.readdirSync(viewsPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const filePath = path.join(viewsPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const viewData = JSON.parse(content);

        // Use sourcePath from metadata (original XML file) instead of JSON file path
        const sourceFilePath = viewData.sourcePath || filePath;
        const viewName = viewData.name || path.basename(file, '.json');

        // Add view symbol
        this.addSymbol({
          name: viewName,
          type: 'view',
          filePath: sourceFilePath,
          model,
          description: viewData.label,
        });
      
      } catch (error) {
        // Only log errors, don't stop processing
        console.error(`      ⚠️  Skipped view ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  /**
   * Get class methods for autocomplete
   */
  getClassMethods(className: string): XppSymbol[] {
    let stmt = this.stmtCache.get('getClassMethods');
    if (!stmt) {
      stmt = this.db.prepare(`SELECT * FROM symbols WHERE parent_name = ? AND type = 'method' ORDER BY name`);
      this.stmtCache.set('getClassMethods', stmt);
    }
    return (stmt.all(className) as any[]).map(row => this.rowToSymbol(row));
  }

  /**
   * Get table fields for autocomplete
   */
  getTableFields(tableName: string): XppSymbol[] {
    let stmt = this.stmtCache.get('getTableFields');
    if (!stmt) {
      stmt = this.db.prepare(`SELECT * FROM symbols WHERE parent_name = ? AND type = 'field' ORDER BY name`);
      this.stmtCache.set('getTableFields', stmt);
    }
    return (stmt.all(tableName) as any[]).map(row => this.rowToSymbol(row));
  }

  /**
   * Get completions for a class or table
   */
  getCompletions(objectName: string, prefix?: string): any[] {
    // Single query instead of two separate calls for methods + fields
    let stmt = this.stmtCache.get('getCompletions');
    if (!stmt) {
      stmt = this.db.prepare(
        `SELECT name, type, signature FROM symbols
         WHERE parent_name = ? AND type IN ('method', 'field')
         ORDER BY type DESC, name`  // methods before fields
      );
      this.stmtCache.set('getCompletions', stmt);
    }

    const allMembers = stmt.all(objectName) as Array<{ name: string; type: string; signature: string | null }>;

    const filtered = prefix
      ? allMembers.filter(m => m.name.toLowerCase().startsWith(prefix.toLowerCase()))
      : allMembers;

    return filtered.map(m => ({
      label: m.name,
      kind: m.type === 'method' ? 'Method' : 'Field',
      detail: m.signature ?? undefined,
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
    
    // Collect example class names and count dependency frequencies (data already in classes)
    for (const cls of classes) {
      exampleClasses.push(cls.name);
      if (cls.used_types) {
        for (const rawType of cls.used_types.split(',')) {
          const cleaned = rawType.trim();
          if (cleaned) dependencyFrequency[cleaned] = (dependencyFrequency[cleaned] || 0) + 1;
        }
      }
    }

    // Single bulk query instead of N+1 (one getClassMethods() call per class)
    if (classes.length > 0) {
      const classNames = classes.map((c: any) => c.name);
      const placeholders = classNames.map(() => '?').join(',');
      const allMethods = this.db.prepare(
        `SELECT name FROM symbols WHERE type = 'method' AND parent_name IN (${placeholders})`
      ).all(...classNames) as Array<{ name: string }>;
      for (const method of allMethods) {
        methodFrequency[method.name] = (methodFrequency[method.name] || 0) + 1;
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
    let stmt = this.stmtCache.get('findSimilarMethods');
    if (!stmt) {
      stmt = this.db.prepare(`
        SELECT s.*, parent.name as class_name, parent.pattern_type
        FROM symbols s
        LEFT JOIN symbols parent ON s.parent_name = parent.name AND parent.type = 'class'
        WHERE s.type = 'method'
          AND s.name LIKE ?
        ORDER BY s.complexity ASC, s.name
        LIMIT ?
      `);
      this.stmtCache.set('findSimilarMethods', stmt);
    }
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
  getApiUsagePatterns(className: string): any[] {
    // Find all methods that reference this class in their used_types
    let stmt = this.stmtCache.get('getApiUsagePatterns');
    if (!stmt) {
      stmt = this.db.prepare(`SELECT * FROM symbols WHERE type = 'method' AND used_types LIKE ? LIMIT 50`);
      this.stmtCache.set('getApiUsagePatterns', stmt);
    }
    const methods = stmt.all(`%${className}%`) as any[];

    if (methods.length === 0) {
      return [];
    }

    const methodCallPatterns: Record<string, number> = {};
    const initPatterns: string[] = [];

    for (const method of methods) {
      if (method.method_calls) {
        for (const call of (method.method_calls as string).split(',')) {
          const c = call.trim();
          if (c) methodCallPatterns[c] = (methodCallPatterns[c] || 0) + 1;
        }
      }

      // Collect initialization snippets
      if (method.source_snippet && (method.source_snippet as string).includes('new ' + className)) {
        const snippet = (method.source_snippet as string).split('\n').slice(0, 5).join('\n');
        if (!initPatterns.includes(snippet)) initPatterns.push(snippet);
      }
    }

    const commonMethodCalls = Object.entries(methodCallPatterns)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10);

    // Return an array so formatPatterns() can iterate with .length and index access
    return [{
      patternType: 'General Usage',
      usageCount: methods.length,
      classes: methods.map((m: any) => m.parent_name as string).filter(Boolean).slice(0, 10),
      initialization: initPatterns.slice(0, 3),
      methodSequence: commonMethodCalls.map(([name, count]) => `${name}  // called ${count}×`),
      relatedApis: commonMethodCalls.slice(0, 5).map(([name]) => name),
    }];
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
    
    // Single GROUP BY query instead of N+1 getClassMethods() calls per similar class
    const methodFrequency: Record<string, number> = {};

    if (similarClasses.length > 0) {
      const classNames = similarClasses.map((r: any) => r.parent_name);
      const placeholders = classNames.map(() => '?').join(',');
      const methodCounts = this.db.prepare(
        `SELECT name, COUNT(DISTINCT parent_name) AS class_count
         FROM symbols
         WHERE type = 'method' AND parent_name IN (${placeholders})
         GROUP BY name
         ORDER BY class_count DESC
         LIMIT 50`
      ).all(...classNames) as Array<{ name: string; class_count: number }>;

      for (const row of methodCounts) {
        if (!existingMethodNames.has(row.name)) {
          methodFrequency[row.name] = row.class_count;
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
   * @param modelNames - Array of model names to clear
   * @param shouldVacuum - Whether to run VACUUM after deletion (default: false for better incremental build performance)
   */
  clearModels(modelNames: string[], shouldVacuum: boolean = false): void {
    if (modelNames.length === 0) return;
    
    const placeholders = modelNames.map(() => '?').join(',');
    const stmt = this.db.prepare(`DELETE FROM symbols WHERE model IN (${placeholders})`);
    stmt.run(...modelNames);
    
    console.log(`🗑️  Cleared symbols for models: ${modelNames.join(', ')}`);
    
    if (shouldVacuum) {
      console.log('🧹 Running VACUUM to optimize database...');
      this.vacuum();
      console.log('✅ VACUUM completed');
    } else {
      console.log('⏭️  Skipping VACUUM for faster incremental build');
    }
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

  // ============================================
  // Label Methods
  // ============================================

  /**
   * Add (or replace) a label entry in the index
   */
  addLabel(entry: {
    labelId: string;
    labelFileId: string;
    model: string;
    language: string;
    text: string;
    comment?: string;
    filePath: string;
  }): void {
    let stmt = this.stmtCache.get('addLabel');
    if (!stmt) {
      stmt = this.db.prepare(`
        INSERT OR REPLACE INTO labels (label_id, label_file_id, model, language, text, comment, file_path)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      this.stmtCache.set('addLabel', stmt);
    }
    stmt.run(
      entry.labelId,
      entry.labelFileId,
      entry.model,
      entry.language,
      entry.text,
      entry.comment ?? null,
      entry.filePath,
    );
  }

  /**
   * Bulk-insert labels (drops FTS triggers for speed).
   * Pass `{ skipFtsRebuild: true }` when indexing many models sequentially;
   * the caller must then invoke `rebuildLabelsFts()` once after all models are done.
   */
  bulkAddLabels(
    entries: Array<{
      labelId: string;
      labelFileId: string;
      model: string;
      language: string;
      text: string;
      comment?: string;
      filePath: string;
    }>,
    opts?: { skipFtsRebuild?: boolean },
  ): void {
    // Disable FTS triggers during bulk insert
    this.labelsDb.exec(`DROP TRIGGER IF EXISTS labels_ai`);
    this.labelsDb.exec(`DROP TRIGGER IF EXISTS labels_ad`);
    this.labelsDb.exec(`DROP TRIGGER IF EXISTS labels_au`);

    const insert = this.labelsDb.prepare(`
      INSERT OR REPLACE INTO labels (label_id, label_file_id, model, language, text, comment, file_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.labelsDb.transaction((rows: typeof entries) => {
      for (const e of rows) {
        insert.run(e.labelId, e.labelFileId, e.model, e.language, e.text, e.comment ?? null, e.filePath);
      }
    });

    insertMany(entries);

    // Rebuild FTS unless the caller will do a single rebuild after all batches
    if (!opts?.skipFtsRebuild) {
      this.rebuildLabelsFts();
    }

    // Re-create triggers (en-US only to keep FTS compact)
    this.labelsDb.exec(`
      CREATE TRIGGER IF NOT EXISTS labels_ai AFTER INSERT ON labels WHEN new.language = 'en-US' BEGIN
        INSERT INTO labels_fts(rowid, label_id, text, comment)
        VALUES (new.id, new.label_id, new.text, new.comment);
      END;
      CREATE TRIGGER IF NOT EXISTS labels_ad AFTER DELETE ON labels WHEN old.language = 'en-US' BEGIN
        INSERT INTO labels_fts(labels_fts, rowid, label_id, text, comment)
        VALUES ('delete', old.id, old.label_id, old.text, old.comment);
      END;
      CREATE TRIGGER IF NOT EXISTS labels_au AFTER UPDATE ON labels WHEN old.language = 'en-US' OR new.language = 'en-US' BEGIN
        INSERT INTO labels_fts(labels_fts, rowid, label_id, text, comment)
        VALUES ('delete', old.id, old.label_id, old.text, old.comment);
        INSERT INTO labels_fts(rowid, label_id, text, comment)
        VALUES (new.id, new.label_id, new.text, new.comment);
      END;
    `);
  }

  /**
   * Rebuild the FTS index for labels from scratch.
   * Only indexes en-US rows — the primary search language — keeping the
   * index ~(N_languages)x smaller compared to indexing all translations.
   */
  rebuildLabelsFts(): void {
    // Clear existing FTS index
    this.labelsDb.exec(`INSERT INTO labels_fts(labels_fts) VALUES('delete-all')`);
    // Re-populate with en-US rows only
    this.labelsDb.exec(`
      INSERT INTO labels_fts(rowid, label_id, text, comment)
      SELECT id, label_id, text, comment FROM labels WHERE language = 'en-US'
    `);
  }

  /**
   * Full-text search labels (default language: en-US, falls back to any)
   */
  searchLabels(
    query: string,
    opts: { language?: string; model?: string; limit?: number } = {},
  ): Array<{
    labelId: string;
    labelFileId: string;
    model: string;
    language: string;
    text: string;
    comment: string | null;
    filePath: string;
    rank: number;
  }> {
    const { language = 'en-US', model, limit = 30 } = opts;

    // labels_fts only indexes en-US rows. For any other language, skip straight to
    // LIKE-based search — attempting FTS would always produce 0 results and then
    // fall through to LIKE anyway, wasting two round-trips.
    if (language !== 'en-US') {
      return this.searchLabelsLike(query, opts);
    }

    // Sanitize query for FTS5 (escape special chars)
    const ftsQuery = query.replace(/['"*()]/g, ' ').trim();
    if (!ftsQuery) return [];

    // Cache the two SQL variants (with / without model filter) so SQLite doesn't
    // have to re-parse and re-plan on every call.
    let stmt: Database.Statement;
    const params: any[] = [ftsQuery];

    if (model) {
      let s = this.labelsStmtCache.get('searchLabels_model');
      if (!s) {
        s = this.labelsDb.prepare(`
          SELECT l.label_id, l.label_file_id, l.model, l.language, l.text, l.comment, l.file_path,
                 f.rank
          FROM labels_fts f
          JOIN labels l ON l.id = f.rowid
          WHERE labels_fts MATCH ?
            AND l.model = ?
          ORDER BY f.rank
          LIMIT ?
        `);
        this.labelsStmtCache.set('searchLabels_model', s);
      }
      stmt = s;
      params.push(model, limit);
    } else {
      let s = this.labelsStmtCache.get('searchLabels_nomodel');
      if (!s) {
        s = this.labelsDb.prepare(`
          SELECT l.label_id, l.label_file_id, l.model, l.language, l.text, l.comment, l.file_path,
                 f.rank
          FROM labels_fts f
          JOIN labels l ON l.id = f.rowid
          WHERE labels_fts MATCH ?
          ORDER BY f.rank
          LIMIT ?
        `);
        this.labelsStmtCache.set('searchLabels_nomodel', s);
      }
      stmt = s;
      params.push(limit);
    }

    try {
      return stmt.all(...params) as any[];
    } catch {
      // FTS query syntax error — fallback to LIKE
      return this.searchLabelsLike(query, opts);
    }
  }

  /**
   * LIKE-based fallback label search (for queries with special characters)
   */
  private searchLabelsLike(
    query: string,
    opts: { language?: string; model?: string; limit?: number } = {},
  ): any[] {
    const { language = 'en-US', model, limit = 30 } = opts;
    const pattern = `%${query}%`;
    const params: any[] = [pattern, pattern, language];

    const stmtKey = model ? 'searchLabelsLike_model' : 'searchLabelsLike_nomodel';
    let stmt = this.labelsStmtCache.get(stmtKey);
    if (!stmt) {
      let sql = `
        SELECT label_id, label_file_id, model, language, text, comment, file_path, 0 as rank
        FROM labels
        WHERE (text LIKE ? OR label_id LIKE ?)
          AND language = ?
      `;
      if (model) sql += ` AND model = ?`;
      sql += ` LIMIT ?`;
      stmt = this.labelsDb.prepare(sql);
      this.labelsStmtCache.set(stmtKey, stmt);
    }

    if (model) params.push(model);
    params.push(limit);
    return stmt.all(...params) as any[];
  }

  /**
   * Get a single label by exact ID (returns all languages)
   */
  getLabelById(
    labelId: string,
    labelFileId?: string,
    model?: string,
  ): Array<{
    labelId: string;
    labelFileId: string;
    model: string;
    language: string;
    text: string;
    comment: string | null;
    filePath: string;
  }> {
    const params: any[] = [labelId];
    let sql = `
      SELECT label_id AS labelId, label_file_id AS labelFileId, model, language, text, comment, file_path AS filePath
      FROM labels
      WHERE label_id = ?
    `;
    if (labelFileId) { sql += ` AND label_file_id = ?`; params.push(labelFileId); }
    if (model)       { sql += ` AND model = ?`;         params.push(model); }
    sql += ` ORDER BY language`;
    return this.labelsDb.prepare(sql).all(...params) as any[];
  }

  /**
   * Get all label file IDs for a model (i.e. which AxLabelFiles exist)
   */
  getLabelFileIds(model?: string): Array<{ labelFileId: string; model: string; languages: string }> {
    if (model) {
      return this.labelsDb.prepare(`
        SELECT label_file_id AS labelFileId, model, GROUP_CONCAT(DISTINCT language) AS languages
        FROM labels
        WHERE model = ?
        GROUP BY label_file_id, model
        ORDER BY label_file_id
      `).all(model) as any[];
    }
    return this.labelsDb.prepare(`
      SELECT label_file_id AS labelFileId, model, GROUP_CONCAT(DISTINCT language) AS languages
      FROM labels
      GROUP BY label_file_id, model
      ORDER BY label_file_id
    `).all() as any[];
  }

  /**
   * Remove all labels for the given models (used during incremental rebuild)
   */
  clearLabelsForModels(models: string[]): void {
    const placeholders = models.map(() => '?').join(',');
    this.labelsDb.prepare(`DELETE FROM labels WHERE model IN (${placeholders})`).run(...models);
    this.rebuildLabelsFts();
  }

  /**
   * Total label count
   */
  getLabelCount(): number {
    const row = this.labelsDb.prepare(`SELECT COUNT(*) AS cnt FROM labels`).get() as any;
    return row?.cnt ?? 0;
  }
}
