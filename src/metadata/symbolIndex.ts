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

  // ─── Read-only connection pool ───────────────────────────────────────────────
  // SQLite WAL mode allows N concurrent readers + 1 writer without blocking each
  // other at the OS/SQLite level.  In a single Node.js process the event loop is
  // still single-threaded, but having separate connection objects means the OS
  // can hand each reader its own shared-cache page without serialising through a
  // single connection lock.  Each connection also carries its own stmt cache so
  // concurrent FTS5 queries don't share a mutable prepared-statement object.
  // Pool size: READ_POOL_SIZE env var (default 3, clamped to 1–8).
  // Not used for :memory: databases (each new Database(':memory:') is a separate,
  // initially-empty DB).
  private readPool: Database.Database[] = [];
  private labelsReadPool: Database.Database[] = [];
  private readPoolRR = 0;
  // Per-connection prepared-statement cache.  Prepared statements are bound to
  // their originating connection and cannot be shared across connections.
  private perConnStmtCache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

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
    // Retry for up to 5 s before throwing SQLITE_BUSY ("database is locked").
    // With the read pool + WAL auto-checkpoint, without this the writer would
    // fail immediately whenever a checkpoint races with an active reader.
    this.db.pragma('busy_timeout = 5000');
    // Raise checkpoint threshold: auto-checkpoint fires every N WAL frames.
    // Default is 1000; raising it reduces checkpoint frequency and therefore
    // the chance of readers blocking the checkpoint (and vice versa).
    // In production the DB is effectively read-only so checkpoints rarely write.
    this.db.pragma('wal_autocheckpoint = 4000');
    
    // Configure labels DB similarly
    if (!this.labelsDb.pragma('journal_mode', { simple: true })) {
      this.labelsDb.pragma('journal_mode = WAL');
    }
    this.labelsDb.pragma('synchronous = NORMAL');
    this.labelsDb.pragma('cache_size = -32000'); // 32MB cache for labels
    this.labelsDb.pragma('temp_store = MEMORY');
    this.labelsDb.pragma('mmap_size = 134217728'); // 128MB memory-mapped I/O
    this.labelsDb.pragma('busy_timeout = 5000');
    this.labelsDb.pragma('wal_autocheckpoint = 4000');
    // Note: page_size is a no-op on an existing database; only applies to new DBs
    // Note: optimize and ANALYZE are intentionally NOT run here — they are slow
    //       (seconds on 500K+ rows) and the pre-built DB already has persisted stats.
    //       Call runPostBuildTasks() from build scripts instead.
    
    this.loadStandardModels();
    this.initializeDatabase();

    // Open read-only pool connections (skip for :memory: — each new connection
    // would be a separate empty in-memory DB)
    if (dbPath !== ':memory:') {
      const poolSize = Math.min(8, Math.max(1,
        parseInt(process.env.READ_POOL_SIZE || '3', 10) || 3
      ));
      for (let i = 0; i < poolSize; i++) {
        const rConn = new Database(dbPath, { readonly: true });
        // Read-only connections: set busy_timeout so that if a WAL checkpoint
        // races with this reader, SQLite waits up to 5 s instead of failing
        // immediately with SQLITE_BUSY ("database is locked").
        rConn.pragma('busy_timeout = 5000');
        rConn.pragma('cache_size = -32000'); // 32 MB page cache per connection
        rConn.pragma('temp_store = MEMORY');
        rConn.pragma('mmap_size = 268435456');
        this.readPool.push(rConn);

        // Labels read pool is only useful when a real file exists
        if (labelPath !== ':memory:') {
          const rLabels = new Database(labelPath, { readonly: true });
          rLabels.pragma('busy_timeout = 5000');
          rLabels.pragma('cache_size = -16000'); // 16 MB per labels connection
          rLabels.pragma('temp_store = MEMORY');
          rLabels.pragma('mmap_size = 134217728');
          this.labelsReadPool.push(rLabels);
        }
      }
    }
  }

  /**
   * Returns the next read-only connection from the pool (round-robin).
   * Falls back to the main writer connection when the pool is empty
   * (e.g. :memory: databases used in write-only mode).
   *
   * Tool handlers should use this instead of accessing `db` directly
   * to benefit from read-pool parallelism and per-connection stmt caching.
   */
  getReadDb(): Database.Database {
    if (this.readPool.length === 0) return this.db;
    return this.readPool[this.readPoolRR++ % this.readPool.length];
  }

  /**
   * Close and drain all read-pool connections.
   * Must be called before setting locking_mode = EXCLUSIVE on the writer
   * connection (e.g. in build scripts) — SQLite cannot grant EXCLUSIVE while
   * any other connection (even read-only, even in-process) holds a shared lock.
   */
  closeReadPool(): void {
    for (const conn of this.readPool) {
      try { conn.close(); } catch { /* ignore */ }
    }
    this.readPool = [];
    for (const conn of this.labelsReadPool) {
      try { conn.close(); } catch { /* ignore */ }
    }
    this.labelsReadPool = [];
    this.readPoolRR = 0;
  }

  /**
   * Get (or lazily prepare) a statement on a specific connection.
   * Uses the per-connection WeakMap cache so statements are never shared
   * across connections.
   *
   * Tool handlers should use `getReadStmt(index.getReadDb(), key, () => sql)`
   * for repeated queries — avoids re-preparing the same SQL on every call.
   */
  getReadStmt(
    db: Database.Database,
    key: string,
    buildSql: () => string
  ): Database.Statement {
    let cache = this.perConnStmtCache.get(db);
    if (!cache) {
      cache = new Map();
      this.perConnStmtCache.set(db, cache);
    }
    let stmt = cache.get(key);
    if (!stmt) {
      stmt = db.prepare(buildSql());
      cache.set(key, stmt);
    }
    return stmt;
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
      packageName: row.package_name || row.model,
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
        package_name TEXT,
        description TEXT,
        tags TEXT,
        source_snippet TEXT,
        source TEXT,
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
        ['package_name', 'TEXT'],
        ['description', 'TEXT'],
        ['tags', 'TEXT'],
        ['source_snippet', 'TEXT'],
        ['source', 'TEXT'],
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
      // Validate column names and types before using them in DDL.
      // exec() does not support parameters for DDL, so we guard against
      // any future accidental mutation of newCols with external data.
      const allowedColNames = new Set(newCols.map(([col]) => col));
      const allowedColTypePat = /^(TEXT|INTEGER|INTEGER DEFAULT \d+)$/;
      for (const [col, def] of newCols) {
        if (!existingCols.has(col)) {
          if (!allowedColNames.has(col) || !allowedColTypePat.test(def)) {
            throw new Error(`symbolIndex: unexpected column definition: "${col} ${def}"`);
          }
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
      -- Covering index for field/method lookups by parent (avoids table access)
      CREATE INDEX IF NOT EXISTS idx_parent_type_name ON symbols(parent_name, type, name) WHERE parent_name IS NOT NULL;
      -- Index for extends_class lookups (CoC extension discovery)
      CREATE INDEX IF NOT EXISTS idx_extends_class ON symbols(extends_class) WHERE extends_class IS NOT NULL;
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

    // ── Extended Metadata Tables for Smart Generation ───────────────────────

    // Table Relations - for analyzing table relationships
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS table_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_table TEXT NOT NULL,
        target_table TEXT NOT NULL,
        relation_name TEXT NOT NULL,
        constraint_fields TEXT,
        model TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_table_relations_source ON table_relations(source_table);
      CREATE INDEX IF NOT EXISTS idx_table_relations_target ON table_relations(target_table);
      CREATE INDEX IF NOT EXISTS idx_table_relations_model ON table_relations(model);
    `);

    // Form DataSources - for analyzing form patterns
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS form_datasources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        form_name TEXT NOT NULL,
        datasource_name TEXT NOT NULL,
        table_name TEXT NOT NULL,
        allow_edit INTEGER DEFAULT 1,
        allow_create INTEGER DEFAULT 1,
        allow_delete INTEGER DEFAULT 1,
        model TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_form_datasources_form ON form_datasources(form_name);
      CREATE INDEX IF NOT EXISTS idx_form_datasources_table ON form_datasources(table_name);
      CREATE INDEX IF NOT EXISTS idx_form_datasources_model ON form_datasources(model);
    `);

    // EDT Metadata - for EDT suggestion and validation
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS edt_metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        edt_name TEXT NOT NULL,
        extends TEXT,
        enum_type TEXT,
        reference_table TEXT,
        relation_type TEXT,
        string_size TEXT,
        display_length TEXT,
        label TEXT,
        model TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_edt_metadata_name ON edt_metadata(edt_name);
      CREATE INDEX IF NOT EXISTS idx_edt_metadata_extends ON edt_metadata(extends);
      CREATE INDEX IF NOT EXISTS idx_edt_metadata_enum ON edt_metadata(enum_type);
      CREATE INDEX IF NOT EXISTS idx_edt_metadata_ref_table ON edt_metadata(reference_table);
      CREATE INDEX IF NOT EXISTS idx_edt_metadata_model ON edt_metadata(model);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_edt_metadata_unique ON edt_metadata(edt_name, model);
    `);

    // ── Security Tables ──────────────────────────────────────────────────────

    // Security Privilege Entry Points
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS security_privilege_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        privilege_name TEXT NOT NULL,
        entry_point_name TEXT NOT NULL,
        object_type TEXT NOT NULL,
        access_level TEXT NOT NULL,
        model TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spe_privilege ON security_privilege_entries(privilege_name);
      CREATE INDEX IF NOT EXISTS idx_spe_entry ON security_privilege_entries(entry_point_name);
      CREATE INDEX IF NOT EXISTS idx_spe_model ON security_privilege_entries(model);
    `);

    // Security Duty → Privilege references
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS security_duty_privileges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        duty_name TEXT NOT NULL,
        privilege_name TEXT NOT NULL,
        model TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sdp_duty ON security_duty_privileges(duty_name);
      CREATE INDEX IF NOT EXISTS idx_sdp_privilege ON security_duty_privileges(privilege_name);
      CREATE INDEX IF NOT EXISTS idx_sdp_model ON security_duty_privileges(model);
    `);

    // Security Role → Duty references
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS security_role_duties (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role_name TEXT NOT NULL,
        duty_name TEXT NOT NULL,
        model TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_srd_role ON security_role_duties(role_name);
      CREATE INDEX IF NOT EXISTS idx_srd_duty ON security_role_duties(duty_name);
      CREATE INDEX IF NOT EXISTS idx_srd_model ON security_role_duties(model);
    `);

    // ── Menu Item Targets ─────────────────────────────────────────────────────

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS menu_item_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        menu_item_name TEXT NOT NULL,
        menu_item_type TEXT NOT NULL,
        target_object TEXT,
        target_type TEXT,
        security_privilege TEXT,
        label TEXT,
        model TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mit_name ON menu_item_targets(menu_item_name);
      CREATE INDEX IF NOT EXISTS idx_mit_target ON menu_item_targets(target_object);
      CREATE INDEX IF NOT EXISTS idx_mit_model ON menu_item_targets(model);
    `);

    // ── Extension Metadata ───────────────────────────────────────────────────

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extension_metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        extension_name TEXT NOT NULL,
        extension_type TEXT NOT NULL,
        base_object_name TEXT NOT NULL,
        added_fields TEXT,
        added_methods TEXT,
        added_indexes TEXT,
        coc_methods TEXT,
        event_subscriptions TEXT,
        model TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_em_base ON extension_metadata(base_object_name);
      CREATE INDEX IF NOT EXISTS idx_em_type ON extension_metadata(extension_type);
      CREATE INDEX IF NOT EXISTS idx_em_name ON extension_metadata(extension_name);
      CREATE INDEX IF NOT EXISTS idx_em_model ON extension_metadata(model);
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
          name, type, parent_name, signature, file_path, model, package_name,
          description, tags, source_snippet, source, complexity, used_types, method_calls,
          inline_comments, extends_class, implements_interfaces, usage_example,
          usage_frequency, pattern_type, typical_usages, called_by_count, related_methods, api_patterns
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      symbol.packageName || symbol.model,
      symbol.description || null,
      symbol.tags || null,
      symbol.sourceSnippet || null,
      symbol.source || null,
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
   * Remove all symbols for a given file path from both the main table and FTS index.
   * Returns the names of top-level objects that were removed (for cache invalidation).
   */
  removeSymbolsByFile(filePath: string): { deletedCount: number; objectNames: string[] } {
    // Collect object names BEFORE deletion (for cache invalidation)
    const rows = this.db.prepare(
      `SELECT DISTINCT name FROM symbols WHERE file_path = ? AND parent_name IS NULL`
    ).all(filePath) as Array<{ name: string }>;
    const objectNames = rows.map(r => r.name);

    // The FTS trigger (symbols_fts AFTER DELETE) handles FTS cleanup automatically
    const result = this.db.prepare(`DELETE FROM symbols WHERE file_path = ?`).run(filePath);
    return { deletedCount: result.changes, objectNames };
  }

  /**
   * Remove all labels for a given file path from the labels DB.
   * Also cleans up the labels FTS index.
   * Returns the count of deleted label rows.
   */
  removeLabelsByFile(filePath: string): number {
    // The labels_ad trigger handles FTS cleanup for en-US rows
    const result = this.labelsDb.prepare(`DELETE FROM labels WHERE file_path = ?`).run(filePath);
    return result.changes;
  }

  /**
   * Remove all labels matching a specific label_id + model combination.
   * Used when a label is known to have been deleted/reverted.
   */
  removeLabelById(labelId: string, model: string): number {
    const result = this.labelsDb.prepare(
      `DELETE FROM labels WHERE label_id = ? AND model = ?`
    ).run(labelId, model);
    return result.changes;
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

    const db = this.getReadDb();
    try {
      const stmt = this.getReadStmt(db, cacheKey, () => sql);
      return (stmt.all(...params) as any[]).map(row => this.rowToSymbol(row));
    } catch {
      // FTS5 syntax error (e.g. user typed *, ", (, ), -) — fall back to LIKE contains search
      // PERFORMANCE: Also select only essential columns in fallback
      const fallbackCacheKey = types?.length ? `fallback_typed_${types.join('_')}` : 'fallback_all';
      let fallbackSql = `SELECT s.id, s.name, s.type, s.parent_name, s.signature, s.file_path, s.model, s.description FROM symbols s WHERE s.name LIKE ?`;
      const escapeLikePattern = (value: string): string => {
        // First escape backslashes, then escape SQL LIKE wildcards % and _
        return value
          .replace(/\\/g, '\\\\')
          .replace(/[%_]/g, '\\$&');
      };
      const fallbackParams: any[] = [`%${escapeLikePattern(query)}%`];
      if (types && types.length > 0) {
        fallbackSql += ` AND s.type IN (${types.map(() => '?').join(',')})`;  
        fallbackParams.push(...types);
      }
      fallbackSql += ` ORDER BY s.name LIMIT ?`;
      fallbackParams.push(limit);
      
      const fallbackStmt = this.getReadStmt(db, fallbackCacheKey, () => fallbackSql);
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

    const cacheKey = types?.length ? `prefix_typed_${types.join('_')}` : 'prefix_all';
    const db = this.getReadDb();
    const stmt = this.getReadStmt(db, cacheKey, () => sql);
    return (stmt.all(...params) as any[]).map(row => this.rowToSymbol(row));
  }

  /**
   * Get a specific symbol by name and type
   */
  getSymbolByName(name: string, type: string): XppSymbol | null {
    const db = this.getReadDb();
    const stmt = this.getReadStmt(db, 'getSymbolByName',
      () => `SELECT * FROM symbols WHERE name = ? AND type = ? LIMIT 1`);
    const row = stmt.get(name, type) as any;
    return row ? this.rowToSymbol(row) : null;
  }

  /**
   * Get all classes (for resource listing)
   */
  getAllClasses(): XppSymbol[] {
    const stmt = this.getReadDb().prepare(
      `SELECT * FROM symbols WHERE type = 'class' ORDER BY name`
    );
    return (stmt.all() as any[]).map(row => this.rowToSymbol(row));
  }

  /**
   * Get symbol count
   */
  getSymbolCount(): number {
    const stmt = this.getReadDb().prepare('SELECT COUNT(*) as count FROM symbols');
    return (stmt.get() as { count: number }).count;
  }

  /**
   * Get symbol count by type
   */
  getSymbolCountByType(): Record<string, number> {
    const stmt = this.getReadDb().prepare(
      `SELECT type, COUNT(*) as count FROM symbols GROUP BY type`
    );
    const rows = stmt.all() as { type: string; count: number }[];
    const result: Record<string, number> = {};
    for (const row of rows) result[row.type] = row.count;
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

        const edtsPath = path.join(modelPath, 'edts');
        if (fs.existsSync(edtsPath)) this.indexEdts(edtsPath, model);

        const reportsPath = path.join(modelPath, 'reports');
        if (fs.existsSync(reportsPath)) this.indexReports(reportsPath, model);

        // Security artifacts
        const secPrivPath = path.join(modelPath, 'security-privileges');
        if (fs.existsSync(secPrivPath)) this.indexSecurityPrivileges(secPrivPath, model);

        const secDutyPath = path.join(modelPath, 'security-duties');
        if (fs.existsSync(secDutyPath)) this.indexSecurityDuties(secDutyPath, model);

        const secRolePath = path.join(modelPath, 'security-roles');
        if (fs.existsSync(secRolePath)) this.indexSecurityRoles(secRolePath, model);

        // Menu items
        const menuDisplayPath = path.join(modelPath, 'menu-item-displays');
        if (fs.existsSync(menuDisplayPath)) this.indexMenuItems(menuDisplayPath, model, 'display');

        const menuActionPath = path.join(modelPath, 'menu-item-actions');
        if (fs.existsSync(menuActionPath)) this.indexMenuItems(menuActionPath, model, 'action');

        const menuOutputPath = path.join(modelPath, 'menu-item-outputs');
        if (fs.existsSync(menuOutputPath)) this.indexMenuItems(menuOutputPath, model, 'output');

        // Extensions
        const tableExtPath = path.join(modelPath, 'table-extensions');
        if (fs.existsSync(tableExtPath)) this.indexExtensions(tableExtPath, model, 'table-extension');

        const classExtPath = path.join(modelPath, 'class-extensions');
        if (fs.existsSync(classExtPath)) this.indexExtensions(classExtPath, model, 'class-extension');

        const formExtPath = path.join(modelPath, 'form-extensions');
        if (fs.existsSync(formExtPath)) this.indexExtensions(formExtPath, model, 'form-extension');

        const enumExtPath = path.join(modelPath, 'enum-extensions');
        if (fs.existsSync(enumExtPath)) this.indexExtensions(enumExtPath, model, 'enum-extension');

        const edtExtPath = path.join(modelPath, 'edt-extensions');
        if (fs.existsSync(edtExtPath)) this.indexExtensions(edtExtPath, model, 'edt-extension');

        const deExtPath = path.join(modelPath, 'data-entity-extensions');
        if (fs.existsSync(deExtPath)) this.indexExtensions(deExtPath, model, 'data-entity-extension');

        // Mark model as done atomically with its data (same transaction)
        markProgress?.run(model, Date.now());
      });
      tx();

      const modelDuration = ((Date.now() - modelStartTime) / 1000).toFixed(1);
      const progressPercent = ((modelIndex / models.length) * 100).toFixed(0);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      
      // Detect CI environment (Azure DevOps, GitHub Actions, GitLab CI, etc.)
      const isCI = process.env.CI === 'true' || process.env.TF_BUILD === 'True' || process.env.GITHUB_ACTIONS === 'true';
      
      if (isCI) {
        // CI environment: use normal console.log (one line per model)
        console.log(`   📦 [${progressPercent}%] ${model} - ${modelDuration}s (${elapsed}s total)`);
      } else {
        // Interactive terminal: overwrite same line for compact output
        process.stdout.write(`\r   📦 [${progressPercent}%] ${model.padEnd(40)} ${modelDuration}s (${elapsed}s total)`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    // Add newline only if we were overwriting (interactive mode)
    const isCI = process.env.CI === 'true' || process.env.TF_BUILD === 'True' || process.env.GITHUB_ACTIONS === 'true';
    if (!isCI) {
      console.log(''); // New line after progress
    }

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
    const subdirs = [
      'classes', 'tables', 'forms', 'queries', 'views', 'enums', 'edts', 'reports',
      'security-privileges', 'security-duties', 'security-roles',
      'menu-item-displays', 'menu-item-actions', 'menu-item-outputs',
      'table-extensions', 'class-extensions', 'form-extensions',
      'enum-extensions', 'edt-extensions', 'data-entity-extensions',
    ];
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
              source: method.source,
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

        // Add method symbols (parallel to indexClasses)
        if (tableData.methods && Array.isArray(tableData.methods)) {
          for (const method of tableData.methods) {
            const params = method.parameters?.map((p: any) => `${p.type} ${p.name}`).join(', ') || '';
            this.addSymbol({
              name: method.name,
              type: 'method',
              parentName: tableData.name,
              signature: `${method.returnType} ${method.name}(${params})`,
              filePath: sourceFilePath,
              model,
              description: method.documentation,
              tags: method.tags?.join(', '),
              sourceSnippet: method.sourceSnippet,
              source: method.source,
              complexity: method.complexity,
              usedTypes: method.usedTypes?.join(', '),
              methodCalls: method.methodCalls?.join(', '),
              inlineComments: method.inlineComments,
            });
          }
        }

        // Index table relations to new table
        if (tableData.relations && Array.isArray(tableData.relations)) {
          const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO table_relations (
              source_table, target_table, relation_name, constraint_fields, model
            ) VALUES (?, ?, ?, ?, ?)
          `);

          for (const relation of tableData.relations) {
            if (relation.name && relation.relatedTable) {
              // Serialize constraints as JSON
              const constraintFields = relation.constraints 
                ? JSON.stringify(relation.constraints)
                : null;
              
              stmt.run(
                tableData.name,
                relation.relatedTable,
                relation.name,
                constraintFields,
                model
              );
            }
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

  private indexEdts(edtsPath: string, model: string): void {
    const files = fs.readdirSync(edtsPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const filePath = path.join(edtsPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const edtData = JSON.parse(content);

        const sourceFilePath = edtData.sourcePath || filePath;
        const edtName = edtData.name || path.basename(file, '.json');

        let signature: string | undefined;
        
        // Enhanced metadata extraction from parsed EDT info
        if (edtData.extends) {
          signature = edtData.extends;
        } else if (edtData.enumType) {
          signature = edtData.enumType;
        } else if (typeof edtData.raw === 'string') {
          // Fallback to raw XML parsing for old metadata
          const extendsMatch = edtData.raw.match(/<Extends>([^<]+)<\/Extends>/i);
          const enumTypeMatch = edtData.raw.match(/<EnumType>([^<]+)<\/EnumType>/i);
          signature = extendsMatch?.[1]?.trim() || enumTypeMatch?.[1]?.trim();
        }

        // Add symbol
        this.addSymbol({
          name: edtName,
          type: 'edt',
          signature,
          filePath: sourceFilePath,
          model,
        });

        // Add extended EDT metadata to new table — always insert when any property is present
        if (edtData.extends || edtData.enumType || edtData.referenceTable ||
            edtData.stringSize || edtData.displayLength || edtData.label) {
          const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO edt_metadata (
              edt_name, extends, enum_type, reference_table, relation_type,
              string_size, display_length, label, model
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          
          stmt.run(
            edtName,
            edtData.extends || null,
            edtData.enumType || null,
            edtData.referenceTable || null,
            edtData.relationType || null,
            edtData.stringSize || null,
            edtData.displayLength || null,
            edtData.label || null,
            model
          );
        }
      } catch (error) {
        console.error(`      ⚠️  Skipped edt ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private indexReports(reportsPath: string, model: string): void {
    const files = fs.readdirSync(reportsPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const filePath = path.join(reportsPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const reportData = JSON.parse(content);

        // sourcePath points to the live AxReport XML on disk (set by extractReports)
        const sourceFilePath = reportData.sourcePath || filePath;
        const reportName = reportData.name || path.basename(file, '.json');

        this.addSymbol({
          name: reportName,
          type: 'report',
          filePath: sourceFilePath,
          model,
        });
      } catch (error) {
        console.error(`      ⚠️  Skipped report ${file}: ${error instanceof Error ? error.message : error}`);
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

        // Index form datasources to new table
        if (formData.dataSources && Array.isArray(formData.dataSources)) {
          const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO form_datasources (
              form_name, datasource_name, table_name, 
              allow_edit, allow_create, allow_delete, model
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `);

          for (const ds of formData.dataSources) {
            if (ds.name && ds.table) {
              stmt.run(
                formName,
                ds.name,
                ds.table,
                ds.allowEdit ? 1 : 0,
                ds.allowCreate ? 1 : 0,
                ds.allowDelete ? 1 : 0,
                model
              );
            }
          }
        }
      
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
          signature: viewData.type || undefined,
          filePath: sourceFilePath,
          model,
          description: viewData.label || viewData.type,
        });

        // Add field symbols (same pattern as tables)
        if (viewData.fields && Array.isArray(viewData.fields)) {
          for (const field of viewData.fields) {
            this.addSymbol({
              name: field.name,
              type: 'field',
              parentName: viewName,
              signature: field.dataMethod || field.dataField || undefined,
              filePath: sourceFilePath,
              model,
            });
          }
        }

        // Add method symbols (views and data-entities can have display/computed methods)
        if (viewData.methods && Array.isArray(viewData.methods)) {
          for (const method of viewData.methods) {
            const params = method.parameters?.map((p: any) => `${p.type} ${p.name}`).join(', ') || '';
            this.addSymbol({
              name: method.name,
              type: 'method',
              parentName: viewName,
              signature: `${method.returnType} ${method.name}(${params})`,
              filePath: sourceFilePath,
              model,
              description: method.documentation,
              tags: method.tags?.join(', '),
              sourceSnippet: method.sourceSnippet,
              source: method.source,
              complexity: method.complexity,
              usedTypes: method.usedTypes?.join(', '),
              methodCalls: method.methodCalls?.join(', '),
              inlineComments: method.inlineComments,
            });
          }
        }

      } catch (error) {
        // Only log errors, don't stop processing
        console.error(`      ⚠️  Skipped view ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private indexSecurityPrivileges(dirPath: string, model: string): void {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    const insertEntry = this.db.prepare(`
      INSERT OR IGNORE INTO security_privilege_entries
        (privilege_name, entry_point_name, object_type, access_level, model)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const sourceFilePath = data.sourcePath || filePath;
        const name = data.name || path.basename(file, '.json');
        const entryPoints: Array<{ name: string; objectType: string; accessLevel: string }> =
          data.entryPoints || [];

        this.addSymbol({
          name,
          type: 'security-privilege',
          filePath: sourceFilePath,
          model,
          description: data.label || undefined,
          signature: entryPoints.length > 0 ? `${entryPoints.length} entry point(s)` : undefined,
        });

        for (const ep of entryPoints) {
          // Skip malformed entry points — missing name causes "Too few parameter values" in better-sqlite3
          if (!ep.name) continue;
          // Safeguard: accessLevel may be an object in older JSONs extracted before
          // xmlParser normalisation was added. Serialize to string.
          const accessLevelStr = ep.accessLevel == null
            ? null
            : typeof ep.accessLevel === 'object'
              ? Object.entries(ep.accessLevel as Record<string, string>).map(([k, v]) => `${k}:${v}`).join(',')
              : String(ep.accessLevel);
          insertEntry.run(
            name,
            ep.name,
            ep.objectType ?? null,
            accessLevelStr,
            model
          );
        }
      } catch (error) {
        console.error(`      ⚠️  Skipped security-privilege ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private indexSecurityDuties(dirPath: string, model: string): void {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    const insertPriv = this.db.prepare(`
      INSERT OR IGNORE INTO security_duty_privileges (duty_name, privilege_name, model)
      VALUES (?, ?, ?)
    `);

    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const sourceFilePath = data.sourcePath || filePath;
        const name = data.name || path.basename(file, '.json');
        const privileges: string[] = data.privileges || [];

        this.addSymbol({
          name,
          type: 'security-duty',
          filePath: sourceFilePath,
          model,
          description: data.label || undefined,
          signature: privileges.length > 0 ? `${privileges.length} privilege(s)` : undefined,
        });

        for (const priv of privileges) {
          insertPriv.run(name, priv, model);
        }
      } catch (error) {
        console.error(`      ⚠️  Skipped security-duty ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private indexSecurityRoles(dirPath: string, model: string): void {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    const insertDuty = this.db.prepare(`
      INSERT OR IGNORE INTO security_role_duties (role_name, duty_name, model)
      VALUES (?, ?, ?)
    `);

    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const sourceFilePath = data.sourcePath || filePath;
        const name = data.name || path.basename(file, '.json');
        const duties: string[] = data.duties || [];

        this.addSymbol({
          name,
          type: 'security-role',
          filePath: sourceFilePath,
          model,
          description: data.description || data.label || undefined,
          signature: duties.length > 0 ? `${duties.length} duty(ies)` : undefined,
        });

        for (const duty of duties) {
          insertDuty.run(name, duty, model);
        }
      } catch (error) {
        console.error(`      ⚠️  Skipped security-role ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private indexMenuItems(dirPath: string, model: string, menuItemType: 'display' | 'action' | 'output'): void {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    const symbolType = `menu-item-${menuItemType}` as const;
    const insertTarget = this.db.prepare(`
      INSERT OR REPLACE INTO menu_item_targets
        (menu_item_name, menu_item_type, target_object, target_type, security_privilege, label, model)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const sourceFilePath = data.sourcePath || filePath;
        const name = data.name || path.basename(file, '.json');

        this.addSymbol({
          name,
          type: symbolType,
          filePath: sourceFilePath,
          model,
          description: data.label || undefined,
          signature: data.targetObject || data.object || undefined,
        });

        insertTarget.run(
          name,
          menuItemType,
          data.targetObject || data.object || null,
          data.targetType || data.objectType || null,
          data.securityPrivilege || null,
          data.label || null,
          model
        );
      } catch (error) {
        console.error(`      ⚠️  Skipped menu-item-${menuItemType} ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private indexExtensions(dirPath: string, model: string, extensionType: string): void {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    const insertMeta = this.db.prepare(`
      INSERT OR REPLACE INTO extension_metadata
        (extension_name, extension_type, base_object_name, added_fields, added_methods,
         added_indexes, coc_methods, event_subscriptions, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const sourceFilePath = data.sourcePath || filePath;
        const name = data.name || path.basename(file, '.json');
        const baseObjectName = data.baseObjectName || data.extends || '';

        this.addSymbol({
          name,
          type: extensionType as any,
          filePath: sourceFilePath,
          model,
          parentName: baseObjectName || undefined,
          extendsClass: baseObjectName || undefined,
          signature: baseObjectName || undefined,
        });

        insertMeta.run(
          name,
          extensionType,
          baseObjectName,
          data.addedFields ? JSON.stringify(data.addedFields) : null,
          data.addedMethods ? JSON.stringify(data.addedMethods) : null,
          data.addedIndexes ? JSON.stringify(data.addedIndexes) : null,
          data.cocMethods ? JSON.stringify(data.cocMethods) : null,
          data.eventSubscriptions ? JSON.stringify(data.eventSubscriptions) : null,
          model
        );
      } catch (error) {
        console.error(`      ⚠️  Skipped ${extensionType} ${file}: ${error instanceof Error ? error.message : error}`);
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
    
    // Build LIKE-only fallback SQL (always safe)
    const buildLikeSql = () => {
      const likeSql = keywords.length > 0
        ? `SELECT DISTINCT s.* FROM symbols s WHERE s.type = 'class' AND (${
            keywords.map(() => 's.name LIKE ? OR s.tags LIKE ? OR s.description LIKE ?').join(' OR ')
          })`
        : `SELECT DISTINCT s.* FROM symbols s WHERE s.type = 'class' AND (s.name LIKE ? OR s.tags LIKE ? OR s.description LIKE ?)`;
      const likeParams: any[] = keywords.length > 0
        ? keywords.flatMap(kw => [`%${kw}%`, `%${kw}%`, `%${kw}%`])
        : [`%${scenario}%`, `%${scenario}%`, `%${scenario}%`];
      return { likeSql, likeParams };
    };

    let classes: any[];

    if (keywords.length > 0) {
      // Use FTS5 for better text search; double-quote terms to prevent FTS5 syntax errors
      // (e.g. keywords like "select" or ones containing ":" would break MATCH otherwise)
      const safeFtsTerms = keywords.map(kw => `"${kw.replace(/"/g, '')}"`);
      let sql = `
        SELECT DISTINCT s.* 
        FROM symbols s
        WHERE s.type = 'class'
          AND (
            s.id IN (
              SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ?
            )
            ${safeFtsTerms.slice(1).map(() => `
            OR s.id IN (
              SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ?
            )`).join('')}
            ${keywords.map(() => 'OR s.name LIKE ? OR s.tags LIKE ?').join(' ')}
          )
      `;
      
      const params: any[] = [];
      params.push(...safeFtsTerms);
      for (const keyword of keywords) {
        params.push(`%${keyword}%`, `%${keyword}%`);
      }

      if (classPattern) {
        sql += ` AND s.name LIKE ?`;
        params.push(`%${classPattern}%`);
      }
      sql += ` LIMIT ?`;
      params.push(limit);

      try {
        classes = this.db.prepare(sql).all(...params) as any[];
      } catch {
        // FTS5 query failed (e.g. reserved word, missing virtual table) — fall back to LIKE
        const { likeSql, likeParams } = buildLikeSql();
        let fallback = likeSql;
        const fallbackParams = [...likeParams];
        if (classPattern) {
          fallback += ` AND s.name LIKE ?`;
          fallbackParams.push(`%${classPattern}%`);
        }
        fallback += ` LIMIT ?`;
        fallbackParams.push(limit);
        classes = this.db.prepare(fallback).all(...fallbackParams) as any[];
      }
    } else {
      // Fallback to simple search
      const { likeSql, likeParams } = buildLikeSql();
      let fallback = likeSql;
      const fallbackParams = [...likeParams];
      if (classPattern) {
        fallback += ` AND s.name LIKE ?`;
        fallbackParams.push(`%${classPattern}%`);
      }
      fallback += ` LIMIT ?`;
      fallbackParams.push(limit);
      classes = this.db.prepare(fallback).all(...fallbackParams) as any[];
    }
    
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
    // Try exact-name match first (fast) — falls back to LIKE only when nothing found
    const stmtKeyExact = 'findSimilarMethods:exact';
    let stmtExact = this.stmtCache.get(stmtKeyExact);
    if (!stmtExact) {
      stmtExact = this.db.prepare(`
        SELECT s.name, s.parent_name, s.signature, s.source_snippet, s.complexity, s.tags,
               parent.pattern_type
        FROM symbols s
        LEFT JOIN symbols parent ON s.parent_name = parent.name AND parent.type = 'class'
        WHERE s.type = 'method' AND s.name = ?
        ORDER BY s.complexity ASC
        LIMIT ?
      `);
      this.stmtCache.set(stmtKeyExact, stmtExact);
    }
    let methods = stmtExact.all(methodName, limit) as any[];

    // Fall back to suffix/prefix LIKE only when exact produced nothing, but cap at limit
    if (methods.length === 0) {
      let stmtLike = this.stmtCache.get('findSimilarMethods:like');
      if (!stmtLike) {
        stmtLike = this.db.prepare(`
          SELECT s.name, s.parent_name, s.signature, s.source_snippet, s.complexity, s.tags,
                 parent.pattern_type
          FROM symbols s
          LEFT JOIN symbols parent ON s.parent_name = parent.name AND parent.type = 'class'
          WHERE s.type = 'method' AND s.name LIKE ?
          ORDER BY s.complexity ASC, s.name
          LIMIT ?
        `);
        this.stmtCache.set('findSimilarMethods:like', stmtLike);
      }
      methods = stmtLike.all(`%${methodName}%`, limit) as any[];
    }
    
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
  getApiUsagePatterns(className: string): any[] {
    // Find all methods that reference this class in their used_types.
    // Cap at 20 rows — fetching source_snippet for 50+ rows on a 584K-row table causes timeout.
    let stmt = this.stmtCache.get('getApiUsagePatterns');
    if (!stmt) {
      stmt = this.db.prepare(
        `SELECT name, parent_name, method_calls, source_snippet
           FROM symbols
          WHERE type = 'method' AND used_types LIKE ?
          LIMIT 20`
      );
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
    this.db.exec('DELETE FROM table_relations');
    this.db.exec('DELETE FROM form_datasources');
    this.db.exec('DELETE FROM edt_metadata');
    this.db.exec('DELETE FROM security_privilege_entries');
    this.db.exec('DELETE FROM security_duty_privileges');
    this.db.exec('DELETE FROM security_role_duties');
    this.db.exec('DELETE FROM menu_item_targets');
    this.db.exec('DELETE FROM extension_metadata');
    this.vacuum();
  }

  /**
   * Clear symbols for specific models
   * @param modelNames - Array of model names to clear
   * @param shouldVacuum - Whether to run VACUUM after deletion (default: false for better incremental build performance)
   */
  clearModels(modelNames: string[], shouldVacuum: boolean = false): void {
    if (modelNames.length === 0) return;

    // NOTE: `placeholders` is built from '?' characters only — it never contains
    // user-supplied data. The actual model name values flow through SQLite's
    // parameterized binding via .run(...modelNames), so there is no injection risk.
    const placeholders = modelNames.map(() => '?').join(',');

    // Wrap all deletes in a single transaction so the database never ends up
    // in a partially-cleared state if one statement fails mid-way.
    const deleteAll = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM symbols WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM table_relations WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM form_datasources WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM edt_metadata WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM security_privilege_entries WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM security_duty_privileges WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM security_role_duties WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM menu_item_targets WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM extension_metadata WHERE model IN (${placeholders})`).run(...modelNames);
    });
    deleteAll();

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

  // ── Debounced labels FTS rebuild ────────────────────────────────────────────
  private _labelsFtsTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly LABELS_FTS_SETTLE_MS = 300;

  /**
   * Schedule a debounced labels FTS rebuild.
   * Multiple rapid create_label calls defer the expensive rebuild to ~300ms
   * after the last insertion, so a batch of 5 labels triggers only 1 rebuild.
   */
  scheduleLabelsFtsRebuild(): void {
    if (this._labelsFtsTimer) clearTimeout(this._labelsFtsTimer);
    this._labelsFtsTimer = setTimeout(() => {
      this._labelsFtsTimer = null;
      try {
        this.rebuildLabelsFts();
        console.error('[SymbolIndex] Debounced labels FTS rebuild complete');
      } catch (e) {
        console.error(`[SymbolIndex] Debounced labels FTS rebuild failed: ${e}`);
      }
    }, XppSymbolIndex.LABELS_FTS_SETTLE_MS);
  }

  /** Flush any pending labels FTS rebuild immediately (for tests / shutdown). */
  flushLabelsFtsRebuild(): void {
    if (this._labelsFtsTimer) {
      clearTimeout(this._labelsFtsTimer);
      this._labelsFtsTimer = null;
      this.rebuildLabelsFts();
    }
  }

  /**
   * Full-text search labels (default language: en-US, falls back to any)
   */
  searchLabels(
    query: string,
    opts: { language?: string; model?: string; labelFileId?: string; limit?: number } = {},
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
    const { language = 'en-US', model, labelFileId, limit = 30 } = opts;

    // labels_fts only indexes en-US rows. For any other language, skip straight to
    // LIKE-based search — attempting FTS would always produce 0 results and then
    // fall through to LIKE anyway, wasting two round-trips.
    if (language !== 'en-US') {
      return this.searchLabelsLike(query, opts);
    }

    // Sanitize query for FTS5 (escape special chars)
    const ftsQuery = query.replace(/['"*()]/g, ' ').trim();
    if (!ftsQuery) return [];

    // Cache statement keyed by which optional filters are active (4 variants)
    const stmtKey = `searchLabels_${model ? 'model' : 'nomodel'}_${labelFileId ? 'lfid' : 'nolfid'}`;
    let stmt = this.labelsStmtCache.get(stmtKey);
    if (!stmt) {
      let sql = `
        SELECT l.label_id, l.label_file_id, l.model, l.language, l.text, l.comment, l.file_path,
               f.rank
        FROM labels_fts f
        JOIN labels l ON l.id = f.rowid
        WHERE labels_fts MATCH ?`;
      if (model)       sql += `\n          AND l.model = ?`;
      if (labelFileId) sql += `\n          AND l.label_file_id = ?`;
      sql += `\n          ORDER BY f.rank\n          LIMIT ?`;
      stmt = this.labelsDb.prepare(sql);
      this.labelsStmtCache.set(stmtKey, stmt);
    }

    const params: any[] = [ftsQuery];
    if (model)       params.push(model);
    if (labelFileId) params.push(labelFileId);
    params.push(limit);

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
    opts: { language?: string; model?: string; labelFileId?: string; limit?: number } = {},
  ): any[] {
    const { language = 'en-US', model, labelFileId, limit = 30 } = opts;
    const pattern = `%${query}%`;

    const stmtKey = `searchLabelsLike_${model ? 'model' : 'nomodel'}_${labelFileId ? 'lfid' : 'nolfid'}`;
    let stmt = this.labelsStmtCache.get(stmtKey);
    if (!stmt) {
      let sql = `
        SELECT label_id, label_file_id, model, language, text, comment, file_path, 0 as rank
        FROM labels
        WHERE (text LIKE ? OR label_id LIKE ?)
          AND language = ?`;
      if (model)       sql += `\n          AND model = ?`;
      if (labelFileId) sql += `\n          AND label_file_id = ?`;
      sql += `\n        LIMIT ?`;
      stmt = this.labelsDb.prepare(sql);
      this.labelsStmtCache.set(stmtKey, stmt);
    }

    const params: any[] = [pattern, pattern, language];
    if (model)       params.push(model);
    if (labelFileId) params.push(labelFileId);
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

  /**
   * Rename a label ID in the index (used by rename_label tool).
   * Updates all rows for the given labelId + labelFileId + model combination
   * and rebuilds the FTS index.
   */
  renameLabelInIndex(
    oldLabelId: string,
    newLabelId: string,
    labelFileId: string,
    model: string,
  ): void {
    this.labelsDb.prepare(`
      UPDATE labels
      SET label_id = ?
      WHERE label_id = ?
        AND label_file_id = ?
        AND model = ?
    `).run(newLabelId, oldLabelId, labelFileId, model);
    this.rebuildLabelsFts();
  }
}
