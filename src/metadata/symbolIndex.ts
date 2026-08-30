/**
 * X++ Symbol Index
 * SQLite-based symbol indexing with FTS5 full-text search
 */

import Database, { type Statement } from '../database/sqlite.js';
import { Worker } from 'node:worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import type { XppSymbol } from './types.js';
import { renderMethodSignature } from './xppDeclaration.js';
import { isStandardModel } from '../utils/modelClassifier.js';
import { labelIdSpellings, parseLabelReference } from '../utils/labelReference.js';
import { c, log } from '../utils/terminalUi.js';

/**
 * Detect if running in CI environment
 * Supports: Azure Pipelines (TF_BUILD), GitHub Actions (CI), GitLab CI (CI)
 */
const isCI = (): boolean => {
  return !!(process.env.CI || process.env.TF_BUILD || process.env.GITHUB_ACTIONS);
};

/** How many distinct queries keep a memoized "did you mean" candidate pool. */
const SUGGESTION_CACHE_ENTRIES = 32;

/** Total + per-type symbol counts (both come from one GROUP BY scan). */
export interface SymbolCounts {
  total: number;
  byType: Record<string, number>;
}

/** One extension_metadata row, as both the full build and a reindex write it. */
export interface ExtensionMetadataRecord {
  extensionName: string;
  extensionType: string;
  baseObjectName: string;
  addedFields?: string[];
  addedMethods?: string[];
  addedIndexes?: string[];
  cocMethods?: string[];
  eventSubscriptions?: string[];
  model: string;
}

export class XppSymbolIndex {
  public db: Database; // Public for direct pragma access in build scripts
  public labelsDb: Database; // Separate DB for labels (performance optimization)
  private stmtCache: Map<string, Statement> = new Map();
  private labelsStmtCache: Map<string, Statement> = new Map();
  // Buffer for property_stats observations — flushed once per model (batch INSERT)
  // Key: "nodeType|property|value|model", Value: accumulated count
  private propStatBuffer: Map<string, number> = new Map();
  // Per-run "not authored by Microsoft" set (lowercased), supplied by the caller —
  // see setNonMicrosoftModels(). null = caller said nothing, fall back to isStandardModel().
  private nonMicrosoftModels: Set<string> | null = null;
  // isStandardModel() re-parses env on every call and the miners run per node; the
  // answer is constant per model within a run. Cleared by setNonMicrosoftModels().
  private mineableModelCache: Map<string, boolean> = new Map();

  // Read-only connection pool: WAL mode allows N readers + 1 writer without
  // blocking each other. Pool size: READ_POOL_SIZE env var (default 3, clamped 1-8).
  // Not used for :memory: databases (each connection would be a separate empty DB).
  private readPool: Database[] = [];
  private labelsReadPool: Database[] = [];
  private readPoolRR = 0;
  // Symbol-count scans are expensive (full index scan of 1M+ rows, 30-60 s
  // cold) — memoize the result and compute it off-thread (see getSymbolCounts).
  private dbPath: string;
  // Needed alongside dbPath so ensureFilePathIndexes() can size the labels DB
  // and hand its path to the background index builder.
  private labelsDbPath: string = ':memory:';
  private symbolCountsCache: SymbolCounts | null = null;
  private symbolCountsPromise: Promise<SymbolCounts> | null = null;
  // "Did you mean" candidate pools, keyed by query. An agent that guesses a name
  // wrong tends to guess near it again, and both pools are derived purely from the
  // index — recomputing them per probe is the whole cost of a failed search.
  // Bounded so a long session cannot accumulate one entry per typo.
  private suggestionNamesCache: Map<string, string[]> = new Map();
  private symbolsByTermCache: Map<string, XppSymbol[]> | null = null;
  // Per-connection prepared-statement cache.  Prepared statements are bound to
  // their originating connection and cannot be shared across connections.
  private perConnStmtCache = new WeakMap<Database, Map<string, Statement>>();

  /**
   * Directory holding the metadata databases. Sibling marker files (the blob-download
   * note, the last-build record) live here so they travel with the index they describe.
   */
  get dataDir(): string {
    return path.dirname(this.dbPath);
  }

  constructor(dbPath: string, labelsDbPath?: string) {
    this.dbPath = dbPath;
    // Ensure database directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // Labels live in a separate DB so the main symbol DB stays small and fast;
    // labels can be huge (20M+ rows) without affecting search performance.
    const labelPath = labelsDbPath || dbPath.replace('.db', '-labels.db');
    this.labelsDbPath = labelPath;
    this.labelsDb = new Database(labelPath);

    // journal_mode should be set by caller (MEMORY for build, WAL for production).
    // pragma() returns a string like "wal"/"delete" — always truthy, so compare the value, not !pragma(...).
    const currentJournalMode = this.db.pragma('journal_mode', { simple: true }) as string;
    if (currentJournalMode !== 'wal') {
      this.db.pragma('journal_mode = WAL'); // Write-Ahead Logging for better concurrency
    }
    this.db.pragma('synchronous = NORMAL'); // Faster writes, still crash-safe
    this.db.pragma('cache_size = -64000'); // 64MB cache (negative = kibibytes)
    this.db.pragma('temp_store = MEMORY'); // Store temp tables in memory
    // 1 GiB. The shipped symbol DB is ~2.3 GB and the labels DB ~0.9 GB, so the
    // previous 256 MB / 128 MB mapped roughly a tenth of each file and every read
    // outside that window paid a page copy through the regular pager. SQLite maps
    // min(mmap_size, file size) and the mapping is virtual — pages fault in on
    // demand — so a larger window costs address space, not resident memory.
    this.db.pragma('mmap_size = 1073741824'); // 1 GiB memory-mapped I/O
    // Without a busy_timeout the writer fails immediately (SQLITE_BUSY) whenever
    // a WAL checkpoint races with an active reader; retry for up to 5s instead.
    this.db.pragma('busy_timeout = 5000');
    // Raise checkpoint threshold (default 1000 WAL frames) to reduce checkpoint
    // frequency and reader/checkpoint contention; production DB is read-mostly.
    this.db.pragma('wal_autocheckpoint = 4000');

    // Configure labels DB similarly
    const labelsJournalMode = this.labelsDb.pragma('journal_mode', { simple: true }) as string;
    if (labelsJournalMode !== 'wal') {
      this.labelsDb.pragma('journal_mode = WAL');
    }
    this.labelsDb.pragma('synchronous = NORMAL');
    this.labelsDb.pragma('cache_size = -32000'); // 32MB cache for labels
    this.labelsDb.pragma('temp_store = MEMORY');
    this.labelsDb.pragma('mmap_size = 536870912'); // 512 MiB — see the note above
    this.labelsDb.pragma('busy_timeout = 5000');
    this.labelsDb.pragma('wal_autocheckpoint = 4000');
    // page_size is a no-op on an existing database (only applies to new DBs).
    // optimize/ANALYZE intentionally NOT run here (slow on 500K+ rows) — the
    // pre-built DB already has persisted stats; use runPostBuildTasks() instead.

    this.initializeDatabase();

    // Skip pool for :memory: — each new connection would be a separate empty DB.
    if (dbPath !== ':memory:') {
      const poolSize = Math.min(8, Math.max(1,
        parseInt(process.env.READ_POOL_SIZE || '3', 10) || 3
      ));
      for (let i = 0; i < poolSize; i++) {
        const rConn = new Database(dbPath, { readonly: true });
        rConn.pragma('busy_timeout = 5000');
        rConn.pragma('cache_size = -32000'); // 32 MB page cache per connection
        rConn.pragma('temp_store = MEMORY');
        rConn.pragma('mmap_size = 1073741824');
        this.readPool.push(rConn);

        if (labelPath !== ':memory:') {
          const rLabels = new Database(labelPath, { readonly: true });
          rLabels.pragma('busy_timeout = 5000');
          rLabels.pragma('cache_size = -16000'); // 16 MB per labels connection
          rLabels.pragma('temp_store = MEMORY');
          rLabels.pragma('mmap_size = 536870912');
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
  getReadDb(): Database {
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
    db: Database,
    key: string,
    buildSql: () => string
  ): Statement {
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
    log.step('Running post-build database optimization (ANALYZE + optimize)...');
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
      log.ok(`Post-build optimization complete in ${elapsed}s`);
    } catch (e) {
      log.warn(`Post-build optimization failed (non-fatal): ${e instanceof Error ? e.message : e}`);
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
      visibility: row.visibility || undefined,
      usageExample: row.usage_example || undefined,
      usageFrequency: row.usage_frequency || undefined,
      patternType: row.pattern_type || undefined,
      typicalUsages: row.typical_usages || undefined,
      calledByCount: row.called_by_count || undefined,
      relatedMethods: row.related_methods || undefined,
      apiPatterns: row.api_patterns || undefined,
    };
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
        visibility TEXT,
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
        // Additive, like every column above it: a database built before this
        // gets it as NULL and the readers omit the line until a re-index fills
        // it, rather than being forced into a rebuild (#902).
        ['visibility', 'TEXT'],
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

    // Labels live in the separate labelsDb (keeps the main symbol DB fast for search).
    //
    // file_path is a foreign key, not a string. Every label in a .label.txt shares
    // one ~130-character absolute path, so storing it inline repeated it per row and
    // then indexed it twice (BINARY + NOCASE) — 813 distinct paths carried across
    // 374 K rows on a default en-US build. Measured: 310 MB inline versus 130 MB
    // through label_files, and the CREATE INDEX pass over the loaded table drops
    // from 4.0 s to 1.4 s. See migrateLabelPathsToLabelFiles().
    this.labelsDb.exec(`
      CREATE TABLE IF NOT EXISTS label_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_label_files_path ON label_files(file_path);
      -- removeLabelsByFile compares COLLATE NOCASE (Windows paths differ only in case
      -- between the indexer and a tool argument), and SQLite only uses an index whose
      -- collation matches the comparison.
      CREATE INDEX IF NOT EXISTS idx_label_files_path_nocase
        ON label_files(file_path COLLATE NOCASE);
    `);
    this.labelsDb.exec(`
      CREATE TABLE IF NOT EXISTS labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label_id TEXT NOT NULL,
        label_file_id TEXT NOT NULL,
        model TEXT NOT NULL,
        language TEXT NOT NULL,
        text TEXT NOT NULL,
        comment TEXT,
        file_path_id INTEGER NOT NULL
      );
    `);

    // idx_labels_unique is created separately from the rest, and deliberately so:
    // it is the only one a bulk load cannot run without. INSERT OR REPLACE dedupes
    // through it, so dropping it for the load would let duplicate rows in and the
    // CREATE UNIQUE INDEX afterwards would fail the whole build. The others are pure
    // read accelerators — see dropLabelSecondaryIndexes().
    this.labelsDb.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_unique
        ON labels(label_id, label_file_id, model, language);
    `);
    this.labelsDb.exec(XppSymbolIndex.LABEL_SECONDARY_INDEX_SQL);

    // FTS5 full-text search for labels — every indexed language, not just en-US.
    // See rebuildLabelsFts() for why the en-US-only index had to go.
    this.labelsDb.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS labels_fts USING fts5(
        label_id,
        text,
        comment,
        content='labels',
        content_rowid='id'
      );
    `);

    this.createLabelsFtsTriggers();
    // Ascending order, and it matters: both migrations advance the same
    // PRAGMA user_version counter, so a later one running first would stamp its own
    // number over a step that had not happened yet and skip it forever.
    this.migrateLabelsFtsLanguageCoverage();  // user_version 0 -> 1
    this.migrateLabelPathsToLabelFiles();     // user_version 1 -> 2

    // Extended metadata tables for smart generation

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

    // Form Patterns — mined Pattern/PatternVersion per Design node and
    // sub-patterned container (node_path 'Design' = the form's top-level pattern).
    // Grounds pattern recommendations ("real forms using pattern X") and
    // cross-checks the curated catalog against actual metadata.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS form_patterns (
        form_name TEXT NOT NULL,
        model TEXT NOT NULL,
        node_path TEXT NOT NULL,
        control_name TEXT NOT NULL DEFAULT '',
        control_type TEXT NOT NULL DEFAULT '',
        pattern TEXT NOT NULL,
        pattern_version TEXT,
        child_sequence TEXT,
        PRIMARY KEY (form_name, node_path)
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_form_patterns_pattern ON form_patterns(pattern, pattern_version);
      CREATE INDEX IF NOT EXISTS idx_form_patterns_model ON form_patterns(model);
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
        database_string_size TEXT,
        display_length TEXT,
        label TEXT,
        model TEXT NOT NULL
      );
    `);

    // Migrate existing edt_metadata table: add database_string_size column when missing
    {
      const existingCols = new Set(
        (this.db.pragma('table_info(edt_metadata)') as Array<{ name: string }>).map(r => r.name)
      );
      if (!existingCols.has('database_string_size')) {
        this.db.exec(`ALTER TABLE edt_metadata ADD COLUMN database_string_size TEXT;`);
      }
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_edt_metadata_name ON edt_metadata(edt_name);
      CREATE INDEX IF NOT EXISTS idx_edt_metadata_extends ON edt_metadata(extends);
      CREATE INDEX IF NOT EXISTS idx_edt_metadata_enum ON edt_metadata(enum_type);
      CREATE INDEX IF NOT EXISTS idx_edt_metadata_ref_table ON edt_metadata(reference_table);
      CREATE INDEX IF NOT EXISTS idx_edt_metadata_model ON edt_metadata(model);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_edt_metadata_unique ON edt_metadata(edt_name, model);
    `);

    // Security tables

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

    // Menu item targets

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

    // Index metadata (key-value); e.g. last_indexed_at drives staleness detection in get_workspace_info.

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Property stats: distribution of metadata property values across STANDARD models,
    // used for data-driven BP rules in validate_xpp instead of hardcoded tables.
    // Presence is encoded via special values '(present)' / '(absent)'.

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS property_stats (
        node_type TEXT NOT NULL,
        property TEXT NOT NULL,
        value TEXT NOT NULL,
        model TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (node_type, property, value, model)
      );
      CREATE INDEX IF NOT EXISTS idx_ps_node_prop ON property_stats(node_type, property);
    `);

    // Extension metadata

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

    // Service operations & service group membership
    // AxService → exposed operations (each maps to a public method on the class).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS service_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_name TEXT NOT NULL,
        operation_name TEXT NOT NULL,
        method_name TEXT NOT NULL,
        idempotent INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_so_service ON service_operations(service_name);
      CREATE INDEX IF NOT EXISTS idx_so_model ON service_operations(model);
    `);

    // AxServiceGroup → member services. Enables the service→group reverse lookup
    // used to compute the /api/services/<group>/<service>/<operation> endpoint.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS service_group_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_name TEXT NOT NULL,
        service_name TEXT NOT NULL,
        model TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sgm_group ON service_group_members(group_name);
      CREATE INDEX IF NOT EXISTS idx_sgm_service ON service_group_members(service_name);
      CREATE INDEX IF NOT EXISTS idx_sgm_model ON service_group_members(model);
    `);

    // Map mappings
    // AxMap → tables it maps onto (with field-connection counts).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS map_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        map_name TEXT NOT NULL,
        mapping_table TEXT NOT NULL,
        field_connections INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mm_map ON map_mappings(map_name);
      CREATE INDEX IF NOT EXISTS idx_mm_table ON map_mappings(mapping_table);
      CREATE INDEX IF NOT EXISTS idx_mm_model ON map_mappings(model);
    `);

    // Security policies (row-level / OLS)
    // Indexed by primary table so get_security_coverage_for_object can report
    // which OLS policies constrain a given table.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS security_policies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        policy_name TEXT NOT NULL,
        primary_table TEXT,
        query_name TEXT,
        operation TEXT,
        constrained_table INTEGER NOT NULL DEFAULT 0,
        label TEXT,
        model TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sp_policy ON security_policies(policy_name);
      CREATE INDEX IF NOT EXISTS idx_sp_table ON security_policies(primary_table);
      CREATE INDEX IF NOT EXISTS idx_sp_model ON security_policies(model);
    `);

    // Macro defines
    // AxMacroDictionary → its #define entries.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS macro_defines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        macro_name TEXT NOT NULL,
        define_name TEXT NOT NULL,
        define_value TEXT,
        model TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_md_macro ON macro_defines(macro_name);
      CREATE INDEX IF NOT EXISTS idx_md_define ON macro_defines(define_name);
      CREATE INDEX IF NOT EXISTS idx_md_model ON macro_defines(model);
    `);

    this.ensureFilePathIndexes();
  }

  /**
   * The `labels` indexes that exist purely to accelerate reads, keyed by name so
   * they can be dropped for a bulk load and rebuilt afterwards.
   *
   * `idx_labels_unique` is NOT in here — it enforces the dedupe that
   * INSERT OR REPLACE relies on and has to stay live through the load.
   *
   * The two file_path entries are also created on demand by ensureFilePathIndexes()
   * (which adds the large-DB worker dispatch that startup needs); this list is the
   * single definition of their SQL so the two paths cannot drift apart.
   */
  private static readonly LABEL_SECONDARY_INDEXES: ReadonlyArray<{ name: string; sql: string }> = [
    { name: 'idx_labels_id', sql: 'CREATE INDEX IF NOT EXISTS idx_labels_id ON labels(label_id);' },
    { name: 'idx_labels_file_id', sql: 'CREATE INDEX IF NOT EXISTS idx_labels_file_id ON labels(label_file_id);' },
    { name: 'idx_labels_model', sql: 'CREATE INDEX IF NOT EXISTS idx_labels_model ON labels(model);' },
    // Every language comparison in this file is LOWER(language) = LOWER(?), because
    // Microsoft packages unzipped on Linux store 'en-us' while custom packages write
    // 'en-US'. A plain index on language cannot serve that predicate, so the LIKE
    // fallback degraded to a scan of all four locales instead of one.
    //
    // There is deliberately no plain idx_labels_language beside it: no query in this
    // file compares language for equality — the three that mention it at all only
    // ORDER BY / GROUP_CONCAT it, after filtering on label_id or label_file_id — so
    // it was a B-tree maintained on every insert and read by nothing.
    {
      name: 'idx_labels_language_lower',
      sql: 'CREATE INDEX IF NOT EXISTS idx_labels_language_lower ON labels(LOWER(language));',
    },
    {
      name: 'idx_labels_file_path_id',
      sql: 'CREATE INDEX IF NOT EXISTS idx_labels_file_path_id ON labels(file_path_id);',
    },
  ];

  /** The subset created at schema-init time; the file_path_id index is left to ensureFilePathIndexes(). */
  private static readonly LABEL_SECONDARY_INDEX_SQL = XppSymbolIndex.LABEL_SECONDARY_INDEXES
    .filter(i => i.name !== 'idx_labels_file_path_id')
    .map(i => i.sql)
    .join('\n');

  /**
   * Drop the read-only `labels` indexes ahead of a bulk load, and report which ones
   * were actually there so the caller can put back exactly that set.
   *
   * Every row of a bulk load otherwise maintains eight B-trees, two of them keyed on
   * a ~130-character absolute path. Measured on a 400 K-row / 150-model reproduction
   * of this exact write path: 17.2 s with the indexes live versus 10.6 s dropping
   * these seven and rebuilding them at the end (the insert itself, 14.9 s → 4.4 s).
   * This is the same trade the symbols side already makes in ensureFilePathIndexes().
   *
   * Build-time only. Do NOT call this on a server that is answering queries — label
   * search degrades to a full scan until createLabelSecondaryIndexes() finishes.
   */
  dropLabelSecondaryIndexes(): string[] {
    const dropped: string[] = [];
    for (const { name } of XppSymbolIndex.LABEL_SECONDARY_INDEXES) {
      const exists = this.labelsDb
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`)
        .get(name);
      if (!exists) continue;
      this.labelsDb.exec(`DROP INDEX IF EXISTS ${name}`);
      dropped.push(name);
    }
    return dropped;
  }

  /**
   * Rebuild the indexes dropped by dropLabelSecondaryIndexes().
   *
   * Pass the array that call returned to restore exactly the set that was there;
   * omit it to create all of them. Returns the elapsed milliseconds so build scripts
   * can report the cost they moved out of the insert loop.
   */
  createLabelSecondaryIndexes(only?: string[]): number {
    const wanted = only ? new Set(only) : null;
    const started = Date.now();
    for (const { name, sql } of XppSymbolIndex.LABEL_SECONDARY_INDEXES) {
      if (wanted && !wanted.has(name)) continue;
      this.labelsDb.exec(sql);
    }
    return Date.now() - started;
  }

  /**
   * Index `symbols.file_path` and `labels.file_path`.
   *
   * Both are the lookup key of removeSymbolsByFile()/removeLabelsByFile(), which
   * every update_symbol_index, undo_last_modification and resync runs first.
   * Unindexed, each of those calls scans the entire table — measured on the 2 GB
   * production DB at 319 s (the SELECT of object names) + 173 s (the DELETE) for
   * indexing a SINGLE new object, versus 0 ms once the index exists. That is why
   * indexing one freshly created object cost as much as a rebuild.
   *
   * Deliberately not part of the CREATE INDEX block above. node:sqlite is
   * synchronous, and building this index over an already-populated production
   * table takes ~8 s, so doing it inline would block the event loop for the whole
   * of startup — the failure mode that makes MCP clients time out and kill the
   * server. On an empty or small DB (a fresh build, the test suite, :memory:) the
   * build is instant and runs here; on a large existing DB it is handed to a
   * worker thread, and until it finishes those deletes simply stay as slow as
   * they are today.
   */
  private ensureFilePathIndexes(): void {
    const missing = (db: Database, indexName: string): boolean =>
      !db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(indexName);

    // Size is read off the file rather than counted, because COUNT(*) on the
    // table we are trying to speed up is itself one of the slow scans.
    const isLarge = (dbFile: string): boolean => {
      if (dbFile === ':memory:') return false;
      try {
        return fs.statSync(dbFile).size > 200 * 1024 * 1024;
      } catch {
        return false;
      }
    };

    const labelsPath = this.labelsDbPath;
    const work: Array<{ db: Database; dbFile: string; sql: string; name: string }> = [];
    if (missing(this.db, 'idx_symbols_file_path')) {
      work.push({
        db: this.db,
        dbFile: this.dbPath,
        name: 'idx_symbols_file_path',
        sql: 'CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);',
      });
    }
    if (missing(this.labelsDb, 'idx_labels_file_path_id')) {
      work.push({
        db: this.labelsDb,
        dbFile: labelsPath,
        name: 'idx_labels_file_path_id',
        sql: 'CREATE INDEX IF NOT EXISTS idx_labels_file_path_id ON labels(file_path_id);',
      });
    }
    // NOCASE twins. removeSymbolsByFile/removeLabelsByFile compare COLLATE NOCASE
    // (Windows paths differ only in case between the indexer and a tool argument),
    // and SQLite will only use an index whose collation matches the comparison —
    // without these the case-insensitive delete falls back to the full-table scan
    // the BINARY indexes above exist to avoid.
    if (missing(this.db, 'idx_symbols_file_path_nocase')) {
      work.push({
        db: this.db,
        dbFile: this.dbPath,
        name: 'idx_symbols_file_path_nocase',
        sql: 'CREATE INDEX IF NOT EXISTS idx_symbols_file_path_nocase ON symbols(file_path COLLATE NOCASE);',
      });
    }
    // No labels NOCASE twin any more: the case-insensitive path comparison moved to
    // label_files, whose two indexes are created with the table — it holds one row per
    // .label.txt (813 on a default build), so building them is instant and needs
    // neither the deferral nor the worker dispatch the per-label table needed.

    for (const item of work) {
      if (isLarge(item.dbFile)) {
        this.buildIndexInWorker(item.dbFile, item.sql, item.name);
      } else {
        item.db.exec(item.sql);
      }
    }
  }

  /**
   * Build one index on a separate thread so the main event loop keeps serving.
   * WAL mode allows the worker's write to proceed alongside main-thread readers.
   * Best-effort: a failure leaves the index absent, which is exactly the state
   * the server ran in before, so it is logged and never thrown.
   */
  private buildIndexInWorker(dbPath: string, sql: string, indexName: string): void {
    try {
      const worker = new Worker(new URL('./buildIndexWorker.js', import.meta.url), {
        workerData: { dbPath, sql, indexName },
      });
      // unref() so a pending index build never keeps the process alive on exit.
      worker.unref();
      worker.once('message', (msg: { ok: boolean; elapsedMs?: number; error?: string }) => {
        if (msg.ok) {
          console.error(`[SymbolIndex] Built ${indexName} in background (${msg.elapsedMs}ms)`);
        } else {
          console.error(`[SymbolIndex] Background build of ${indexName} failed: ${msg.error}`);
        }
        void worker.terminate();
      });
      worker.once('error', e => console.error(`[SymbolIndex] ${indexName} worker error: ${e}`));
    } catch (e) {
      console.error(`[SymbolIndex] Could not start ${indexName} worker: ${e}`);
    }
  }

  /**
   * Create FTS triggers for keeping symbols_fts in sync
   * Extracted to allow disabling during bulk inserts and re-enabling after
   *
   * symbols_fts is an external-content table, so removals and updates MUST hand the OLD
   * column values back to FTS5 via the 'delete' command. A plain `DELETE FROM symbols_fts`
   * (or `UPDATE symbols_fts SET`) cannot work: the trigger runs AFTER the content row is
   * already gone, leaving FTS5 nothing to re-derive the row's terms from — it fails with
   * "missing row N from content table" and strands the old terms in the index.
   *
   * Dropped and recreated rather than CREATE-IF-NOT-EXISTS so databases still carrying the
   * earlier (broken) definitions are repaired on the next index run.
   */
  private createFTSTriggers(): void {
    this.db.exec('DROP TRIGGER IF EXISTS symbols_ai;');
    this.db.exec('DROP TRIGGER IF EXISTS symbols_ad;');
    this.db.exec('DROP TRIGGER IF EXISTS symbols_au;');

    this.db.exec(`
      CREATE TRIGGER symbols_ai AFTER INSERT ON symbols BEGIN
        INSERT INTO symbols_fts(rowid, name, type, parent_name, signature, description, tags, source_snippet, inline_comments)
        VALUES (new.id, new.name, new.type, new.parent_name, new.signature, new.description, new.tags, new.source_snippet, new.inline_comments);
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER symbols_ad AFTER DELETE ON symbols BEGIN
        INSERT INTO symbols_fts(symbols_fts, rowid, name, type, parent_name, signature, description, tags, source_snippet, inline_comments)
        VALUES ('delete', old.id, old.name, old.type, old.parent_name, old.signature, old.description, old.tags, old.source_snippet, old.inline_comments);
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER symbols_au AFTER UPDATE ON symbols BEGIN
        INSERT INTO symbols_fts(symbols_fts, rowid, name, type, parent_name, signature, description, tags, source_snippet, inline_comments)
        VALUES ('delete', old.id, old.name, old.type, old.parent_name, old.signature, old.description, old.tags, old.source_snippet, old.inline_comments);
        INSERT INTO symbols_fts(rowid, name, type, parent_name, signature, description, tags, source_snippet, inline_comments)
        VALUES (new.id, new.name, new.type, new.parent_name, new.signature, new.description, new.tags, new.source_snippet, new.inline_comments);
      END;
    `);
  }

  /**
   * (Re)create the labels_fts sync triggers — the single definition of them.
   *
   * There is deliberately no language filter here. The triggers used to carry
   * `WHEN LOWER(language) = 'en-us'`, which kept the index one quarter of its size
   * on a four-locale build but made every non-English search fall through to the
   * LIKE scan in searchLabelsLike — measured at 152 s for a four-term `cs` query
   * against a 1.4 M-row table, run synchronously on the event loop so the whole
   * server stalled behind it. The rows are indexed; the space is the cheaper half
   * of that trade. Whatever LABEL_LANGUAGES ingested is what gets tokenised, so a
   * default en-US-only build is unaffected.
   *
   * Dropped and recreated (not CREATE-IF-NOT-EXISTS alone) so a database still
   * carrying the earlier language-filtered definitions is repaired on the next open —
   * mirrors createFTSTriggers on the symbols side.
   */
  private createLabelsFtsTriggers(): void {
    this.labelsDb.exec(`
      DROP TRIGGER IF EXISTS labels_ai;
      DROP TRIGGER IF EXISTS labels_ad;
      DROP TRIGGER IF EXISTS labels_au;

      CREATE TRIGGER labels_ai AFTER INSERT ON labels BEGIN
        INSERT INTO labels_fts(rowid, label_id, text, comment)
        VALUES (new.id, new.label_id, new.text, new.comment);
      END;

      CREATE TRIGGER labels_ad AFTER DELETE ON labels BEGIN
        INSERT INTO labels_fts(labels_fts, rowid, label_id, text, comment)
        VALUES ('delete', old.id, old.label_id, old.text, old.comment);
      END;

      CREATE TRIGGER labels_au AFTER UPDATE ON labels BEGIN
        INSERT INTO labels_fts(labels_fts, rowid, label_id, text, comment)
        VALUES ('delete', old.id, old.label_id, old.text, old.comment);
        INSERT INTO labels_fts(rowid, label_id, text, comment)
        VALUES (new.id, new.label_id, new.text, new.comment);
      END;
    `);
  }

  /**
   * Databases built before labels_fts covered every language carry an index holding
   * only en-US rows. Recreating the triggers fixes rows written from now on but
   * cannot retroactively tokenise the ones already there, so the non-English search
   * would stay silently empty until the next full rebuild — exactly the failure this
   * change exists to remove.
   *
   * `PRAGMA user_version` on the labels DB records the coverage generation. It is 0
   * on every database that predates this, so the one-time rebuild is self-triggering
   * and costs nothing on an already-migrated file.
   */
  /**
   * Move an existing database from the inline `labels.file_path` column to the
   * `label_files` lookup table.
   *
   * Runs once, gated on `PRAGMA user_version` like the FTS coverage migration below.
   * A database built before this carries the path spelled out on every row; the
   * column cannot simply be dropped, because the rows have to be rewritten to point
   * at the extracted paths instead.
   *
   * This is a full table rewrite, so it is minutes on a multi-GB labels database
   * rather than the ~23 s the FTS migration costs — announced up front for the same
   * reason: a silent stall of that length reads as a hung server. It is worth paying
   * once. The rewritten table is less than half the size, and every full-table
   * operation on it afterwards (FTS rebuild, ANALYZE, VACUUM, any cold-cache scan)
   * moves proportionally less disk.
   *
   * Row ids are carried over deliberately: `labels_fts` is an external-content index
   * keyed on `labels.id`, so preserving them keeps it valid. It is rebuilt at the end
   * anyway, because the content table it points at is a different table object by then.
   */
  private migrateLabelPathsToLabelFiles(): void {
    const LABEL_FILES_NORMALISED = 2;
    try {
      const version = Number(this.labelsDb.pragma('user_version', { simple: true }) ?? 0);
      if (version >= LABEL_FILES_NORMALISED) return;

      // A database that never had the old column (a fresh build, :memory:, the test
      // suite) only needs the version stamp.
      const columns = this.labelsDb.pragma('table_info(labels)') as Array<{ name: string }>;
      if (!columns.some(c => c.name === 'file_path')) {
        this.labelsDb.pragma(`user_version = ${LABEL_FILES_NORMALISED}`);
        return;
      }

      const { n } = this.labelsDb.prepare('SELECT COUNT(*) AS n FROM labels').get() as { n: number };
      if (n > 0) {
        log.detail(
          `Normalising ${n.toLocaleString('en-US')} label file paths into label_files ` +
            `(one-off; several minutes on a multi-GB labels database)…`,
        );
      }

      // Triggers first: they reference the table about to be dropped, and the rewrite
      // must not fire per-row FTS maintenance for rows that are only moving house.
      this.labelsDb.exec(`
        DROP TRIGGER IF EXISTS labels_ai;
        DROP TRIGGER IF EXISTS labels_ad;
        DROP TRIGGER IF EXISTS labels_au;
      `);

      this.labelsDb.exec('BEGIN');
      try {
        this.labelsDb.exec(`
          INSERT OR IGNORE INTO label_files (file_path) SELECT DISTINCT file_path FROM labels;

          CREATE TABLE labels_migrated (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label_id TEXT NOT NULL,
            label_file_id TEXT NOT NULL,
            model TEXT NOT NULL,
            language TEXT NOT NULL,
            text TEXT NOT NULL,
            comment TEXT,
            file_path_id INTEGER NOT NULL
          );

          INSERT INTO labels_migrated (id, label_id, label_file_id, model, language, text, comment, file_path_id)
            SELECT l.id, l.label_id, l.label_file_id, l.model, l.language, l.text, l.comment, lf.id
            FROM labels l
            JOIN label_files lf ON lf.file_path = l.file_path;

          DROP TABLE labels;
          ALTER TABLE labels_migrated RENAME TO labels;
        `);
        this.labelsDb.exec('COMMIT');
      } catch (e) {
        this.labelsDb.exec('ROLLBACK');
        throw e;
      }

      // The rename dropped every index that lived on the old table.
      this.labelsDb.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_unique
          ON labels(label_id, label_file_id, model, language);
      `);
      this.labelsDb.exec(XppSymbolIndex.LABEL_SECONDARY_INDEX_SQL);
      this.createLabelsFtsTriggers();
      this.rebuildLabelsFts();

      this.labelsDb.pragma(`user_version = ${LABEL_FILES_NORMALISED}`);
      if (n > 0) log.detail(`Label file paths normalised (${n.toLocaleString('en-US')} rows).`);
    } catch (e) {
      // Same posture as the FTS migration: a read-only file or a writer holding the
      // lock must not take the server down. Leaving user_version unstamped means the
      // next open retries. Unlike that one there is no degraded-but-correct fallback,
      // so make the failure loud rather than a detail line.
      console.error(`[SymbolIndex] label_files migration failed, will retry on next open: ${e}`);
      // Whatever went wrong, the triggers must not stay dropped.
      try {
        this.createLabelsFtsTriggers();
      } catch { /* the connection is beyond help; the error above is the signal */ }
    }
  }

  private migrateLabelsFtsLanguageCoverage(): void {
    const LABELS_FTS_ALL_LANGUAGES = 1;
    try {
      const version = Number(this.labelsDb.pragma('user_version', { simple: true }) ?? 0);
      if (version >= LABELS_FTS_ALL_LANGUAGES) return;

      // A database still on the inline file_path column is about to be rewritten by
      // migrateLabelPathsToLabelFiles, which rebuilds labels_fts from scratch over
      // every language — the whole of what this step does. Stamp and let it, rather
      // than re-tokenising a 1.4 M-row table twice in one startup.
      const legacyPathColumn = (this.labelsDb.pragma('table_info(labels)') as Array<{ name: string }>)
        .some(c => c.name === 'file_path');
      if (legacyPathColumn) {
        this.labelsDb.pragma(`user_version = ${LABELS_FTS_ALL_LANGUAGES}`);
        return;
      }

      // An empty labels table needs no rebuild — a fresh DB is already correct, and
      // stamping it here keeps the first real build off the slow path.
      const { n } = this.labelsDb
        .prepare('SELECT COUNT(*) AS n FROM labels')
        .get() as { n: number };
      if (n > 0) {
        // Measured at ~23 s for 1.4 M labels, and it blocks startup. Announced rather
        // than done quietly, because a silent 23 s stall reads as a hung server.
        log.detail(
          `Re-tokenising ${n.toLocaleString('en-US')} labels so every language is searchable (one-off, ~20 s)…`,
        );
        this.rebuildLabelsFts();
      }
      this.labelsDb.pragma(`user_version = ${LABELS_FTS_ALL_LANGUAGES}`);
    } catch (e) {
      // A read-only file, or a writer holding the lock, must not take the server down.
      // Leaving user_version unstamped means the next open retries; until then the
      // non-English searches fall back to searchLabelsLike — the old behaviour, slow
      // but correct.
      console.error(`[SymbolIndex] labels_fts language migration skipped: ${e}`);
    }
  }

  /**
   * Add a symbol to the index with enhanced metadata
   */
  addSymbol(symbol: XppSymbol): void {
    this.invalidateSymbolCounts();
    let stmt = this.stmtCache.get('addSymbol');
    if (!stmt) {
      stmt = this.db.prepare(`
        INSERT OR REPLACE INTO symbols (
          name, type, parent_name, signature, file_path, model, package_name,
          description, tags, source_snippet, source, complexity, used_types, method_calls,
          inline_comments, extends_class, implements_interfaces, visibility, usage_example,
          usage_frequency, pattern_type, typical_usages, called_by_count, related_methods, api_patterns
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      symbol.visibility || null,
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
   * All stored forms a file path may take in the index. Full builds store the
   * JSON's sourcePath: CI-extracted custom models normalize it to a
   * PackagesLocalDirectory-relative forward-slash path (see normalizeSourcePath
   * in scripts/extract-metadata.ts), while locally built DBs keep the absolute
   * Windows path with backslashes. Matching every form keeps stale-row cleanup
   * working regardless of which build produced the DB.
   */
  private filePathForms(filePath: string): string[] {
    const forms = new Set<string>();
    const addSpellings = (p: string): void => {
      if (!p) return;
      forms.add(p);
      forms.add(p.replace(/\//g, '\\'));
      forms.add(p.replace(/\\/g, '/'));
      const m = /[/\\]PackagesLocalDirectory[/\\](.+)$/.exec(p);
      if (m) {
        const tail = m[1].replace(/\\/g, '/');
        forms.add(tail);
        forms.add(tail.replace(/\//g, '\\'));
      }
    };

    addSpellings(filePath);
    // A model directory under PackagesLocalDirectory is routinely a symlink/junction
    // to a repo checkout, so the path a caller holds and the path the indexer walked
    // are two different spellings of the same file. Without the resolved alias the
    // delete matches neither stored form and the stale rows survive — the index then
    // keeps answering with symbols of a file that was reverted or deleted.
    try {
      addSpellings(fs.realpathSync(filePath));
    } catch {
      // File already gone (the usual case for an undo that deleted it) — the
      // as-given spellings are all we have.
    }
    return [...forms];
  }

  /**
   * Remove all symbols for a given file path from both the main table and FTS index.
   * Matches every stored path form (see filePathForms) so stale rows are removed
   * even when the DB stores a different path form than the caller passed.
   *
   * The comparison is COLLATE NOCASE because SQLite's default BINARY collation made
   * it case-SENSITIVE against a Windows filesystem that is not: `k:\aosservice\…`
   * from a tool argument never matched `K:\AosService\…` as stored by the indexer,
   * so the delete reported 0 rows and every stale symbol stayed searchable. See
   * ensureFilePathIndexes for the NOCASE index that keeps this lookup off a scan.
   *
   * Returns the names of top-level objects that were removed (for cache invalidation).
   */
  /**
   * Top-level object names belonging to one model — the evidence from which a
   * model's naming prefix is inferred (see utils/modelPrefixInference.ts).
   *
   * Deliberately narrow and bounded: only `name`, capped at `limit`. Reading whole
   * rows here would pull source snippets across the wire and turn a 450 ms lookup
   * into a slow one.
   *
   * Extension objects are included on purpose — a dot-notation extension states the
   * model's infix outright — but `parent_name IS NULL` had been quietly excluding
   * them, because an extension ELEMENT is stored as a child of the base object it
   * extends. On ContosoFinanceSK that hid 34 of 36: the model spells its extensions
   * "…ConSKExtension" 35 times and "…ConSkExtension" once, yet inference saw
   * two names, one of each, fell under the 60 % threshold and derived "ConSk"
   * from the regular token instead — flattening the "SK" country code. This server
   * then WROTE a ConSk extension, which became one of the two visible names, so
   * the wrong answer was feeding itself. Members ('method', 'field') are excluded by
   * type, which is what this clause was reaching for.
   *
   * The sample is drawn in two BANDS rather than as one `LIMIT` over the union,
   * because a model with more names than `limit` otherwise lets SQLite decide which
   * ones inference sees — no ORDER BY means no defined subset, and inference is
   * threshold-based (MIN_COVERAGE 60 %), so a skewed sample can flip the answer.
   * The bands also protect the signal: extensions are rare and state the infix
   * outright, regular objects are many and carry the leading token, and
   * inferPrefixFromObjectNames needs BOTH — a single window ordered any way at all
   * would let the larger band crowd the other one out entirely. Each band is capped
   * at half the budget, gives back what it does not use, and is ordered (type, name)
   * so the same model always yields the same sample — a silent, self-reinforcing
   * failure otherwise, since this server writes names with the inferred prefix and
   * those names become evidence for the next inference.
   */
  getModelObjectNames(model: string, limit = 400): string[] {
    if (!model) return [];
    if (limit <= 0) return [];
    const db = this.getReadDb();

    const band = (extensions: boolean, cap: number): string[] => {
      if (cap <= 0) return [];
      const rows = db
        .prepare(
          `SELECT name FROM symbols
           WHERE model = ?
             AND type ${extensions ? 'LIKE' : 'NOT LIKE'} '%-extension'
             ${extensions ? '' : 'AND parent_name IS NULL'}
             AND type NOT IN ('method', 'field')
           ORDER BY type, name
           LIMIT ?`
        )
        .all(model, cap) as Array<{ name: string }>;
      return rows.map(r => r.name);
    };

    // Extensions first so their (smaller) band can hand its leftover budget to the
    // regular one; the reverse would let a large model spend the whole budget on
    // regular objects before the infix evidence is ever read.
    const half = Math.max(1, Math.ceil(limit / 2));
    const extensionNames = band(true, half);
    const regularNames = band(false, limit - extensionNames.length);
    return [...extensionNames, ...regularNames];
  }

  removeSymbolsByFile(filePath: string): { deletedCount: number; objectNames: string[] } {
    const forms = this.filePathForms(filePath);
    const placeholders = forms.map(() => '?').join(', ');

    // Collect object names BEFORE deletion (for cache invalidation)
    const rows = this.db.prepare(
      `SELECT DISTINCT name FROM symbols WHERE file_path COLLATE NOCASE IN (${placeholders}) AND parent_name IS NULL`
    ).all(...forms) as Array<{ name: string }>;
    const objectNames = rows.map(r => r.name);

    // The FTS trigger (symbols_fts AFTER DELETE) handles FTS cleanup automatically
    const result = this.db.prepare(`DELETE FROM symbols WHERE file_path COLLATE NOCASE IN (${placeholders})`).run(...forms);
    this.invalidateSymbolCounts();
    return { deletedCount: result.changes, objectNames };
  }

  /**
   * Remove all labels for a given file path from the labels DB.
   * Matches every stored path form (see filePathForms), like removeSymbolsByFile.
   * Also cleans up the labels FTS index.
   * Returns the count of deleted label rows.
   */
  removeLabelsByFile(filePath: string): number {
    const forms = this.filePathForms(filePath);
    const placeholders = forms.map(() => '?').join(', ');
    // The path spellings are matched against label_files — one row per .label.txt —
    // and the labels themselves are deleted by the resulting id. The NOCASE
    // comparison this replaced ran over every label row; it now runs over ~800.
    // The labels_ad trigger handles FTS cleanup, for every language.
    const result = this.labelsDb.prepare(
      `DELETE FROM labels
       WHERE file_path_id IN (
         SELECT id FROM label_files WHERE file_path COLLATE NOCASE IN (${placeholders})
       )`
    ).run(...forms);
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
    const allTokens = cleaned
      .split(/\s+/)
      .map(t => t.toLowerCase())
      .filter(t => t.length > 1); // Filter single chars
    // Drop stop words only while a real token remains — a query may legitimately
    // BE a stop word (e.g. a method literally named "find"), and falling through
    // to the phrase-search fallback would behave differently for it.
    const withoutStopWords = allTokens.filter(t => !stopWords.has(t));
    const tokens = withoutStopWords.length > 0 ? withoutStopWords : allTokens;
    
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
   *
   * `opts.substringFallback: false` keeps the search strictly on the FTS index —
   * see substringScanIsWorthIt() for what the fallback costs and why hot,
   * non-user-facing callers opt out of it.
   */
  searchSymbols(
    query: string,
    limit: number = 20,
    types?: string[],
    opts?: { substringFallback?: boolean }
  ): XppSymbol[] {
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
      const rows = (stmt.all(...params) as any[]).map(row => this.rowToSymbol(row));
      // FTS5's default tokenizer treats each name as one indivisible token and only
      // matches token PREFIXES, so a mid-token substring query (e.g. "CategoryPropert"
      // against "ProcurementProductCategoryPropertyEntity") is a syntactically valid
      // query that legitimately returns zero rows. Fall back to LIKE in that case too,
      // not only when FTS5 throws a syntax error — but only where that scan can pay
      // for itself, since unlike the syntax-error path this one is reachable on every
      // ordinary miss.
      if (rows.length > 0) return rows;
      if (opts?.substringFallback === false || !this.substringScanIsWorthIt(query)) return rows;
      return this.likeFallbackSearch(db, query, limit, types);
    } catch {
      // FTS5 syntax error (e.g. user typed *, ", (, ), -) — fall back to LIKE contains search
      return this.likeFallbackSearch(db, query, limit, types);
    }
  }

  /**
   * Is a leading-wildcard LIKE scan justified for this query?
   *
   * `name LIKE '%q%'` cannot use idx_symbols_name — SQLite scans the whole index
   * (measured: 1.19M rows, ~300 ms warm and far worse cold, versus ~1 ms for the
   * FTS miss it follows), synchronously, on exactly the path an agent hits when it
   * guesses a name wrong. The syntax-error fallback could afford that because it
   * was rare; the zero-row fallback happens on every ordinary miss, so it is only
   * taken where it can actually return something:
   *   - an empty query would match the entire corpus (LIKE '%%') and answer a
   *     no-hit search with an arbitrary alphabetical slice of the index,
   *   - a query containing whitespace can never match a symbol name, so the scan
   *     is guaranteed to come back empty (contextRanker joins intent tokens with
   *     spaces and would pay it on every miss),
   *   - one or two characters are too unselective to be a useful substring probe.
   *
   * Known limitation: the fallback only fires when FTS returns *nothing*, so one
   * incidental hit (e.g. query "Propert" matching PropertyType by prefix) still
   * hides the mid-token matches. Widening it to "fewer rows than limit" would put
   * the scan back on the common path, which is the cost this guard exists to avoid.
   */
  private substringScanIsWorthIt(query: string): boolean {
    const trimmed = query.trim();
    return trimmed.length >= 3 && !/\s/.test(trimmed);
  }

  /**
   * LIKE-based contains search used as a fallback when FTS5 either throws
   * (syntax error) or returns no rows (valid query, prefix-only tokenizer miss —
   * gated by substringScanIsWorthIt, which documents what this scan costs).
   * PERFORMANCE: Only select essential columns, not s.* (avoids loading large text fields)
   */
  private likeFallbackSearch(db: Database, query: string, limit: number, types?: string[]): XppSymbol[] {
    const fallbackCacheKey = types?.length ? `fallback_typed_${types.join('_')}` : 'fallback_all';
    // ESCAPE '\' is required — without it the backslashes produced by
    // escapeLikePattern are literal characters and any query containing
    // '_' or '%' (e.g. "SalesLine_MyExt") silently matches nothing.
    // Two phases, because the column list decides which index SQLite may use.
    //
    // Selecting the display columns forces `SCAN symbols USING INDEX
    // idx_symbols_name` - the index supplies the order, then every candidate row
    // is fetched from the 2.5 GB table. Selecting only `id` turns the same scan
    // into `SCAN ... USING COVERING INDEX`, which never touches the table.
    // Measured on the reference VM, cold: 98.8 s -> 83.4 s; warm: ~2 s -> 0.27 s.
    // The cold number matters less than what it enables - a covering scan reads
    // exactly the index the startup warm-up preloads, so those pages are already
    // there. Hydrating the survivors by rowid is a handful of lookups.
    let fallbackSql = `SELECT s.id FROM symbols s WHERE s.name LIKE ? ESCAPE '\\'`;
    const escapeLikePattern = (value: string): string => {
      // First escape backslashes, then escape SQL LIKE wildcards % and _
      return value
        .replace(/\\/g, '\\\\')
        .replace(/[%_]/g, '\\$&');
    };
    // Trimmed: no symbol name starts or ends with whitespace, so padding in the
    // raw query would only ever turn a real match into a miss.
    const fallbackParams: any[] = [`%${escapeLikePattern(query.trim())}%`];
    if (types && types.length > 0) {
      fallbackSql += ` AND s.type IN (${types.map(() => '?').join(',')})`;
      fallbackParams.push(...types);
    }
    fallbackSql += ` ORDER BY s.name LIMIT ?`;
    fallbackParams.push(limit);

    const fallbackStmt = this.getReadStmt(db, fallbackCacheKey, () => fallbackSql);
    const ids = (fallbackStmt.all(...fallbackParams) as Array<{ id: number }>).map(r => r.id);
    if (ids.length === 0) return [];

    // Hydrate by rowid - at most `limit` of them, so the IN-list is bounded and
    // the statement cache is keyed by its size rather than by the ids in it.
    const hydrateStmt = this.getReadStmt(db, `fallback_hydrate_${ids.length}`, () =>
      `SELECT s.id, s.name, s.type, s.parent_name, s.signature, s.file_path, s.model, s.description
       FROM symbols s WHERE s.id IN (${ids.map(() => '?').join(',')})`);
    const rows = hydrateStmt.all(...ids) as any[];
    // The scan produced the ids in name order; an IN-list does not preserve it.
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return rows.map(r => this.rowToSymbol(r));
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
   * Get symbol count.
   *
   * WARNING: without a warm cache this is a full index scan — 30-60 s on a
   * large production DB with a cold file cache, and node:sqlite blocks the
   * event loop for the whole scan. Server request paths must use
   * getSymbolCounts() (off-thread) or getCachedSymbolCounts() instead; the
   * synchronous form is for build scripts and post-indexing logging where the
   * DB is small or already hot.
   */
  getSymbolCount(): number {
    if (this.symbolCountsCache) return this.symbolCountsCache.total;
    const stmt = this.getReadDb().prepare('SELECT COUNT(*) as count FROM symbols');
    return (stmt.get() as { count: number }).count;
  }

  /**
   * Get symbol count by type. Same event-loop-blocking caveat as getSymbolCount().
   */
  getSymbolCountByType(): Record<string, number> {
    if (this.symbolCountsCache) return this.symbolCountsCache.byType;
    return this.computeSymbolCountsSync().byType;
  }

  /**
   * Cheap emptiness probe — O(1) regardless of table size. Use this instead of
   * getSymbolCount() === 0 on startup paths.
   */
  hasAnySymbols(): boolean {
    const row = this.getReadDb()
      .prepare('SELECT EXISTS(SELECT 1 FROM symbols) as present')
      .get() as { present: number };
    return row.present === 1;
  }

  /**
   * Memoized counts if already computed this session, else null. Never scans —
   * safe on any request path (health endpoints, status displays).
   */
  getCachedSymbolCounts(): SymbolCounts | null {
    return this.symbolCountsCache;
  }

  /**
   * Total + per-type symbol counts without blocking the event loop.
   *
   * The scan runs in a worker thread with its own read-only connection (WAL
   * allows concurrent readers), so the MCP server keeps answering protocol
   * requests while it runs. The result is memoized; concurrent callers share
   * one in-flight computation. Falls back to a synchronous scan when the
   * worker cannot start (:memory: DBs are per-connection and invisible to
   * another thread; under tsx/vitest the compiled worker .js does not exist).
   */
  async getSymbolCounts(): Promise<SymbolCounts> {
    if (this.symbolCountsCache) return this.symbolCountsCache;
    if (this.symbolCountsPromise) return this.symbolCountsPromise;

    const promise = this.computeSymbolCountsInWorker()
      .catch(() => this.computeSymbolCountsSync())
      .then(counts => {
        // Only memoize if no write invalidated the computation while it ran.
        if (this.symbolCountsPromise === promise) {
          this.symbolCountsCache = counts;
        }
        return counts;
      });
    this.symbolCountsPromise = promise;
    return promise;
  }

  /**
   * Drop everything memoized from the symbols table — counts and the suggestion
   * candidate pools. Call after any write that changes symbol rows.
   */
  private invalidateSymbolCounts(): void {
    this.symbolCountsCache = null;
    this.symbolCountsPromise = null;
    this.suggestionNamesCache.clear();
    this.symbolsByTermCache = null;
  }

  private computeSymbolCountsSync(): SymbolCounts {
    const rows = this.getReadDb()
      .prepare(`SELECT type, COUNT(*) as count FROM symbols GROUP BY type`)
      .all() as { type: string; count: number }[];
    const byType: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      byType[row.type] = row.count;
      total += row.count;
    }
    return { total, byType };
  }

  private computeSymbolCountsInWorker(): Promise<SymbolCounts> {
    if (this.dbPath === ':memory:') {
      return Promise.reject(new Error('in-memory DB is not visible to worker threads'));
    }
    return new Promise<SymbolCounts>((resolve, reject) => {
      const worker = new Worker(new URL('./symbolCountsWorker.js', import.meta.url), {
        workerData: { dbPath: this.dbPath },
      });
      worker.once('message', (msg: { ok: boolean; total?: number; byType?: Record<string, number>; error?: string }) => {
        if (msg.ok) {
          resolve({ total: msg.total!, byType: msg.byType! });
        } else {
          reject(new Error(msg.error));
        }
        void worker.terminate();
      });
      worker.once('error', reject);
      // A promise settles only once — this covers "exited before messaging".
      worker.once('exit', code => reject(new Error(`counts worker exited with code ${code}`)));
    });
  }

  /**
   * Compute usage statistics (usage_frequency and called_by_count) for all methods
   * Should be called after initial indexing is complete
   * Optimized for 300k+ methods with minimal memory usage
   */
  computeUsageStatistics(): void {
    log.step('Computing usage statistics...');
    const startTime = Date.now();
    const inCI = isCI();
    
    // Temporarily disable synchronous writes for speed during statistics computation
    const originalSync = this.db.pragma('synchronous', { simple: true });
    this.db.pragma('synchronous = OFF');
    
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS temp_method_calls (
        caller_method TEXT,
        called_method TEXT
      );
      DELETE FROM temp_method_calls;
    `);

    const allMethods = this.db.prepare(`
      SELECT name, method_calls 
      FROM symbols 
      WHERE type = 'method' AND method_calls IS NOT NULL AND method_calls != ''
    `).all() as Array<{ name: string; method_calls: string }>;
    
    log.detail(`${allMethods.length.toLocaleString('en-US')} methods with call references`);
    
    if (allMethods.length === 0) {
      log.detail('No method calls to process, skipping statistics');
      return;
    }
    
    log.detail('Parsing and inserting method calls...');
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
      
      const insertBatch = this.db.transaction(() => {
        for (const method of batchMethods) {
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
      
      // Progress every 10% — a single overwriting line in interactive terminals
      // (matches the model-indexing progress style below), plain periodic lines
      // in CI logs where \r overwriting doesn't render.
      if ((batchIdx + 1) % Math.ceil(totalBatches / 10) === 0 || batchIdx === totalBatches - 1) {
        const percent = Math.round(((batchIdx + 1) / totalBatches) * 100);
        const text = `${percent}% (${batchEnd.toLocaleString('en-US')}/${allMethods.length.toLocaleString('en-US')} methods)`;
        if (inCI) {
          log.detail(text);
        } else {
          process.stdout.write(`\r      ${c.dim(text.padEnd(44))}`);
        }
      }
      
      // Force GC in CI after each batch to prevent memory buildup
      if (isCI() && global.gc && batchIdx % 10 === 0) {
        global.gc();
      }
    }
    if (!inCI) console.log(''); // newline after the overwriting progress line
    
    log.detail('Computing aggregated statistics...');

    const updateTransaction = this.db.transaction(() => {
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
      
      log.detail('Applying statistics to symbols...');

      // LEFT JOIN UPDATE (SQLite 3.33+); falls back to correlated subquery if unsupported.
      try {
        if (inCI) {
          log.detail('Updating usage_frequency and called_by_count (this may take 1-2 minutes)...');
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
        
        if (inCI) {
          log.detail('Setting zero counts for unused methods...');
        }
        
        // Set to 0 for methods not in temp_call_stats
        this.db.exec(`
          UPDATE symbols
          SET usage_frequency = 0, called_by_count = 0
          WHERE type = 'method'
            AND NOT EXISTS (SELECT 1 FROM temp_call_stats WHERE temp_call_stats.called_method = symbols.name);
        `);
      } catch {
        log.warn('Optimized UPDATE failed, using fallback method');
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
    log.ok(`Usage statistics computed in ${duration}s`);
  }

  /**
   * Index metadata from a directory.
   *
   * `modelNames` scopes the pass:
   *   - omitted        → index every model directory found under `metadataPath`
   *   - a model name   → index just that one model
   *   - an array       → index exactly those models in a SINGLE pass
   *
   * Pass an array rather than calling this once per model: with the default
   * `ftsStrategy: 'rebuild'` the FTS index is rebuilt from scratch ONCE at the end of the
   * call, which is O(all symbols in the DB), so a per-model loop turns a scoped rebuild
   * into N full-table rebuilds.
   *
   * `ftsStrategy` picks how symbols_fts is brought up to date:
   *   - 'rebuild'     (default) drop the FTS triggers, bulk-insert, then re-tokenise the
   *                   WHOLE symbols table. Cost is O(all symbols) regardless of scope —
   *                   right for a full or near-full rebuild, where it beats per-row triggers.
   *   - 'incremental' keep the FTS triggers live so only the touched rows are re-tokenised.
   *                   Cost is O(scope). Use it when the scope is a small fraction of the
   *                   database (a custom-model build: ~10K of ~1.2M symbols, where the full
   *                   rebuild cost 327s against 5s of actual indexing work).
   */
  /**
   * Turn a write failure inside a model transaction into an error that names
   * the database being written and, when the drive is the likely cause, how
   * much room is left on it.
   *
   * A full disk makes SQLite roll the transaction back itself, so our transaction
   * wrapper then fails to COMMIT and the only thing the user sees is
   * "cannot commit - no transaction is active" with a stack inside the library —
   * no path, no mention of space. That message sent at least one user hunting
   * for a corrupt index when the index was simply being written to the wrong
   * (and nearly full) drive.
   */
  private describeWriteFailure(err: unknown, model: string): Error {
    const original = err instanceof Error ? err : new Error(String(err));
    const message = original.message;
    const diskRelated = /disk is full|SQLITE_FULL|disk I\/O error|no transaction is active/i.test(message);
    if (!diskRelated) return original;

    let space = '';
    try {
      const stat = fs.statfsSync(path.dirname(path.resolve(this.dbPath)));
      const freeGb = (Number(stat.bavail) * Number(stat.bsize)) / 1024 ** 3;
      space = ` (${freeGb.toFixed(1)} GB free there)`;
    } catch {
      // statfs is best-effort — the path advice below is the useful part.
    }

    const wrapped = new Error(
      `Writing model '${model}' to ${this.dbPath} failed: ${message}\n` +
      `The index is written to that path${space}. A full disk makes SQLite roll the write back on its own, ` +
      `which is what surfaces as "cannot commit - no transaction is active".\n` +
      `Point the installation at a drive with room (a full index needs several GB): ` +
      `re-run 'd365fo-mcp setup' and choose another directory, or set index.dbPath / index.metadataPath in d365fo-mcp.json.`,
    );
    wrapped.cause = original;
    return wrapped;
  }

  async indexMetadataDirectory(
    metadataPath: string,
    modelNames?: string | string[],
    opts?: { ftsStrategy?: 'rebuild' | 'incremental' },
  ): Promise<void> {
    const skipFts = process.env.SKIP_FTS === 'true';
    const resumable = process.env.RESUME === 'true';
    // Incremental FTS only makes sense for a scoped pass; an unscoped one touches
    // every row anyway, so the bulk rebuild is strictly cheaper.
    const incrementalFts = opts?.ftsStrategy === 'incremental' && modelNames !== undefined && !skipFts;

    const requested = modelNames === undefined
      ? undefined
      : (Array.isArray(modelNames) ? modelNames : [modelNames]);
    const allModels = requested ?? await this.getModelDirectories(metadataPath);

    // Sort largest models first — ensures Foundation (56K files) is indexed before any CI timeout.
    // Skip the size scan only when a single model was requested (nothing to order).
    let models = allModels;
    if (allModels.length > 1) {
      log.detail(`Scanning ${allModels.length} model(s) to determine build order...`);
      models = this.sortModelsBySize(metadataPath, allModels);
      log.detail(`Build order determined (largest model first: ${models[0] ?? '—'})`);
    }

    // Skip already-indexed models when resuming (RESUME=true)
    if (resumable) {
      const done = this.getIndexedModels();
      const skipped = models.filter(m => done.has(m));
      models = models.filter(m => !done.has(m));
      if (skipped.length > 0) {
        log.detail(`Resuming build: skipping ${skipped.length} already-indexed model(s)`);
      }
    }

    const startTime = Date.now();

    if (incrementalFts) {
      // Keep the FTS triggers live so each touched row maintains symbols_fts itself.
      // createFTSTriggers() is CREATE TRIGGER IF NOT EXISTS, so this also repairs a
      // database left trigger-less by an interrupted SKIP_FTS build.
      this.createFTSTriggers();
      // Rows are written with INSERT OR REPLACE. SQLite fires delete triggers for the
      // rows a REPLACE displaces ONLY when recursive triggers are enabled; without this
      // the displaced row's symbols_fts entry would survive as an orphan pointing at a
      // rowid that no longer exists in the content table.
      this.db.pragma('recursive_triggers = ON');
    } else {
      // Disable FTS triggers during bulk insert — we rebuild FTS once at the end
      this.db.exec('DROP TRIGGER IF EXISTS symbols_ai;');
      this.db.exec('DROP TRIGGER IF EXISTS symbols_au;');
      this.db.exec('DROP TRIGGER IF EXISTS symbols_ad;');
    }

    // Prepare progress statement (executes inside each model's transaction)
    const markProgress = resumable
      ? this.db.prepare(`INSERT OR REPLACE INTO _build_progress (model, indexed_at) VALUES (?, ?)`)
      : null;

    // Per-model transactions (not one giant transaction): bounds peak memory to
    // one model's inserts and commits progress to disk after each model, so a
    // CI timeout can resume instead of losing all progress.
    let modelIndex = 0;
    for (const model of models) {
      modelIndex++;
      const modelPath = path.join(metadataPath, model);
      const modelStartTime = Date.now();
      const progressPercent = ((modelIndex / models.length) * 100).toFixed(0);

      // Show which model is being processed RIGHT NOW (before the slow transaction)
      if (isCI()) {
        log.detail(`[${progressPercent}%] indexing ${model}...`);
      } else {
        process.stdout.write(`\r      ${c.dim(`[${progressPercent}%]`)} ${model.padEnd(40)} ${c.dim('indexing...')}`);
      }

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

        const viewExtPath = path.join(modelPath, 'view-extensions');
        if (fs.existsSync(viewExtPath)) this.indexExtensions(viewExtPath, model, 'view-extension');

        const queryExtPath = path.join(modelPath, 'query-extensions');
        if (fs.existsSync(queryExtPath)) this.indexExtensions(queryExtPath, model, 'query-extension');

        const mapExtPath = path.join(modelPath, 'map-extensions');
        if (fs.existsSync(mapExtPath)) this.indexExtensions(mapExtPath, model, 'map-extension');

        const menuExtPath = path.join(modelPath, 'menu-extensions');
        if (fs.existsSync(menuExtPath)) this.indexExtensions(menuExtPath, model, 'menu-extension');

        const secDutyExtPath = path.join(modelPath, 'security-duty-extensions');
        if (fs.existsSync(secDutyExtPath)) this.indexExtensions(secDutyExtPath, model, 'security-duty-extension');

        const secRoleExtPath = path.join(modelPath, 'security-role-extensions');
        if (fs.existsSync(secRoleExtPath)) this.indexExtensions(secRoleExtPath, model, 'security-role-extension');

        const miDisplayExtPath = path.join(modelPath, 'menu-item-display-extensions');
        if (fs.existsSync(miDisplayExtPath)) this.indexExtensions(miDisplayExtPath, model, 'menu-item-display-extension');

        const miActionExtPath = path.join(modelPath, 'menu-item-action-extensions');
        if (fs.existsSync(miActionExtPath)) this.indexExtensions(miActionExtPath, model, 'menu-item-action-extension');

        const miOutputExtPath = path.join(modelPath, 'menu-item-output-extensions');
        if (fs.existsSync(miOutputExtPath)) this.indexExtensions(miOutputExtPath, model, 'menu-item-output-extension');

        // Services + service groups
        const servicesPath = path.join(modelPath, 'services');
        if (fs.existsSync(servicesPath)) this.indexServices(servicesPath, model);

        const serviceGroupsPath = path.join(modelPath, 'service-groups');
        if (fs.existsSync(serviceGroupsPath)) this.indexServiceGroups(serviceGroupsPath, model);

        // Maps, feature gating, security policies, macros
        const mapsPath = path.join(modelPath, 'maps');
        if (fs.existsSync(mapsPath)) this.indexMaps(mapsPath, model);

        const configKeysPath = path.join(modelPath, 'configuration-keys');
        if (fs.existsSync(configKeysPath)) this.indexConfigurationKeys(configKeysPath, model);

        const licenseCodesPath = path.join(modelPath, 'license-codes');
        if (fs.existsSync(licenseCodesPath)) this.indexLicenseCodes(licenseCodesPath, model);

        const securityPoliciesPath = path.join(modelPath, 'security-policies');
        if (fs.existsSync(securityPoliciesPath)) this.indexSecurityPolicies(securityPoliciesPath, model);

        const macrosPath = path.join(modelPath, 'macros');
        if (fs.existsSync(macrosPath)) this.indexMacros(macrosPath, model);

        // Flush buffered property_stats observations (batch write — much faster than
        // per-field upserts scattered across the transaction)
        this.flushPropertyStats();

        // Mark model as done atomically with its data (same transaction)
        markProgress?.run(model, Date.now());
      });
      try {
        tx();
      } catch (err) {
        throw this.describeWriteFailure(err, model);
      }

      const modelDuration = ((Date.now() - modelStartTime) / 1000).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

      if (isCI()) {
        // CI environment: overwrite the "indexing..." line with the completed summary
        log.detail(`[${progressPercent}%] ${model} - ${modelDuration}s (${elapsed}s total)`);
      } else {
        // Interactive terminal: overwrite the "indexing..." line with completed summary
        process.stdout.write(`\r      ${c.dim(`[${progressPercent}%]`)} ${model.padEnd(40)} ${c.dim(`${modelDuration}s (${elapsed}s total)`)}`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    // Add newline only if we were overwriting (interactive mode)
    if (!isCI()) {
      console.log(''); // New line after progress
    }

    if (incrementalFts) {
      // FTS was maintained row-by-row by the triggers — nothing left to do.
      this.db.pragma('recursive_triggers = OFF');
      log.ok(`Indexed ${models.length} model(s) in ${duration}s (FTS updated incrementally)`);
    } else if (skipFts) {
      // Phase 1 of two-phase CI build: symbols only, FTS deferred to build-fts step
      log.info(`Skipping FTS rebuild (SKIP_FTS=true) - run 'npm run build-fts' to finish`);
      this.createFTSTriggers();
      log.ok(`Indexed ${models.length} model(s) in ${duration}s`);
    } else {
      // Rebuild FTS index from scratch (much faster than per-insert triggers)
      const ftsStartTime = Date.now();
      this.db.exec("INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild');");
      const ftsDuration = ((Date.now() - ftsStartTime) / 1000).toFixed(1);
      this.createFTSTriggers();
      log.ok(`Indexed ${models.length} model(s) in ${duration}s (FTS rebuilt in ${ftsDuration}s)`);
    }

    this.touchLastIndexed();
  }

  /**
   * Sort models by JSON file count descending.
   * Ensures the largest models (e.g. Foundation with 56K files) are indexed first,
   * so the most data is committed to disk before any CI pipeline timeout.
   *
   * Uses a single recursive readdirSync per model (Node 18.17+) instead of
   * 20 separate readdirSync calls per subdirectory — ~20× fewer syscalls.
   */
  private sortModelsBySize(metadataPath: string, models: string[]): string[] {
    const sized = models.map(model => {
      const modelPath = path.join(metadataPath, model);
      let count = 0;
      try {
        // readdirSync with recursive:true returns all entries in one call (Node 18.17+)
        const entries = fs.readdirSync(modelPath, { recursive: true }) as string[];
        count = entries.filter(f => (f as string).endsWith('.json')).length;
      } catch {
        // Unreadable model directory — treat as empty (will be sorted last)
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
    log.step('Rebuilding symbols FTS index...');
    this.db.exec('DROP TRIGGER IF EXISTS symbols_ai;');
    this.db.exec('DROP TRIGGER IF EXISTS symbols_au;');
    this.db.exec('DROP TRIGGER IF EXISTS symbols_ad;');
    const start = Date.now();
    this.db.exec("INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild');");
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    this.createFTSTriggers();
    log.ok(`Symbols FTS index rebuilt in ${duration}s`);
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
          visibility: classData.visibility,
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
            
            this.addSymbol({
              name: method.name,
              type: 'method',
              parentName: classData.name,
              signature: renderMethodSignature(method),
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
      } catch (error) {
        log.warn(`Skipped ${file}: ${error instanceof Error ? error.message : error}`);
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

        this.addSymbol({
          name: tableData.name,
          type: 'table',
          signature: tableData.label || undefined,
          filePath: sourceFilePath,
          model,
        });

        // Mine property distribution for data-driven BP rules (standard models only)
        this.recordTablePropertyStats(tableData, model);

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
            this.addSymbol({
              name: method.name,
              type: 'method',
              parentName: tableData.name,
              signature: renderMethodSignature(method),
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
        log.warn(`Skipped table ${file}: ${error instanceof Error ? error.message : error}`);
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

        this.addSymbol({
          name: enumName,
          type: 'enum',
          filePath: sourceFilePath,
          model,
        });
      
      } catch (error) {
        log.warn(`Skipped enum ${file}: ${error instanceof Error ? error.message : error}`);
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
            edtData.stringSize || edtData.displayLength || edtData.label ||
            edtData.databaseStringSize) {
          const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO edt_metadata (
              edt_name, extends, enum_type, reference_table, relation_type,
              string_size, database_string_size, display_length, label, model
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          
          stmt.run(
            edtName,
            edtData.extends || null,
            edtData.enumType || null,
            edtData.referenceTable || null,
            edtData.relationType || null,
            edtData.stringSize || null,
            edtData.databaseStringSize || null,
            edtData.displayLength || null,
            edtData.label || null,
            model
          );
        }
      } catch (error) {
        log.warn(`Skipped edt ${file}: ${error instanceof Error ? error.message : error}`);
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
        log.warn(`Skipped report ${file}: ${error instanceof Error ? error.message : error}`);
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

        this.addSymbol({
          name: formName,
          type: 'form',
          filePath: sourceFilePath,
          model,
          description: formData.caption || formData.label,
        });

        // Index mined pattern nodes (Design + sub-patterned containers) and
        // record pattern distribution stats for the advisor/cross-check.
        if (formData.patternNodes && Array.isArray(formData.patternNodes)) {
          const patternStmt = this.db.prepare(`
            INSERT OR REPLACE INTO form_patterns (
              form_name, model, node_path, control_name, control_type,
              pattern, pattern_version, child_sequence
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const node of formData.patternNodes) {
            if (!node?.pattern || !node?.nodePath) continue;
            patternStmt.run(
              formName,
              model,
              node.nodePath,
              node.controlName ?? '',
              node.controlType ?? '',
              node.pattern,
              node.patternVersion ?? null,
              JSON.stringify(node.childSequence ?? []),
            );
            // form_patterns rows above are per-model FACTS and are stored for every model;
            // property_stats is a corpus of "what the standard platform does", so the same
            // gate as recordTablePropertyStats() applies here. Without it our own forms and
            // ISV forms skew the mined pattern distribution that generateSmartForm's
            // defaultFormPattern() picks from — on every environment, not just UDE.
            if (node.nodePath === 'Design' && this.isMineableModel(model)) {
              this.recordPropertyStat('AxFormDesign', 'Pattern', node.pattern, model);
              this.recordPropertyStat(
                'AxFormDesign',
                `PatternVersion:${node.pattern}`,
                node.patternVersion ?? '(absent)',
                model,
              );
            }
          }
        }

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
        log.warn(`Skipped form ${file}: ${error instanceof Error ? error.message : error}`);
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

        this.addSymbol({
          name: queryName,
          type: 'query',
          filePath: sourceFilePath,
          model,
          description: queryData.title || queryData.label,
        });
      
      } catch (error) {
        log.warn(`Skipped query ${file}: ${error instanceof Error ? error.message : error}`);
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
            this.addSymbol({
              name: method.name,
              type: 'method',
              parentName: viewName,
              signature: renderMethodSignature(method),
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
        log.warn(`Skipped view ${file}: ${error instanceof Error ? error.message : error}`);
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
          // Skip malformed entry points — missing name causes a bind error in node:sqlite
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
        log.warn(`Skipped security-privilege ${file}: ${error instanceof Error ? error.message : error}`);
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
        log.warn(`Skipped security-duty ${file}: ${error instanceof Error ? error.message : error}`);
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
        log.warn(`Skipped security-role ${file}: ${error instanceof Error ? error.message : error}`);
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
        log.warn(`Skipped menu-item-${menuItemType} ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private indexServices(dirPath: string, model: string): void {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    const insertOp = this.db.prepare(`
      INSERT INTO service_operations
        (service_name, operation_name, method_name, idempotent, model)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const sourceFilePath = data.sourcePath || filePath;
        const name = data.name || path.basename(file, '.json');

        // signature carries the backing class; description carries the external name
        // so both surface in search/FTS without an extra lookup.
        this.addSymbol({
          name,
          type: 'service',
          filePath: sourceFilePath,
          model,
          signature: data.serviceClass || undefined,
          description: data.externalName || undefined,
        });

        if (Array.isArray(data.operations)) {
          for (const op of data.operations) {
            if (!op?.name) continue;
            insertOp.run(name, op.name, op.method || op.name, op.idempotent ? 1 : 0, model);
          }
        }
      } catch (error) {
        log.warn(`Skipped service ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private indexServiceGroups(dirPath: string, model: string): void {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    const insertMember = this.db.prepare(`
      INSERT INTO service_group_members (group_name, service_name, model)
      VALUES (?, ?, ?)
    `);

    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const sourceFilePath = data.sourcePath || filePath;
        const name = data.name || path.basename(file, '.json');

        this.addSymbol({
          name,
          type: 'service-group',
          filePath: sourceFilePath,
          model,
          description: data.description || undefined,
        });

        if (Array.isArray(data.services)) {
          for (const svc of data.services) {
            if (!svc) continue;
            insertMember.run(name, svc, model);
          }
        }
      } catch (error) {
        log.warn(`Skipped service-group ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private indexMaps(dirPath: string, model: string): void {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    const insertMapping = this.db.prepare(`
      INSERT INTO map_mappings (map_name, mapping_table, field_connections, model)
      VALUES (?, ?, ?, ?)
    `);
    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const name = data.name || path.basename(file, '.json');
        this.addSymbol({
          name,
          type: 'map',
          filePath: data.sourcePath || filePath,
          model,
          extendsClass: data.extends || undefined,
        });
        if (Array.isArray(data.mappings)) {
          for (const m of data.mappings) {
            if (!m?.table) continue;
            insertMapping.run(name, m.table, m.fieldConnections || 0, model);
          }
        }
      } catch (error) {
        log.warn(`Skipped map ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private indexConfigurationKeys(dirPath: string, model: string): void {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const name = data.name || path.basename(file, '.json');
        // signature carries the parent key so the gating tree is queryable from search.
        this.addSymbol({
          name,
          type: 'configuration-key',
          filePath: data.sourcePath || filePath,
          model,
          description: data.label || undefined,
          signature: data.parentKey || undefined,
        });
      } catch (error) {
        log.warn(`Skipped configuration-key ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private indexLicenseCodes(dirPath: string, model: string): void {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const name = data.name || path.basename(file, '.json');
        // signature: "Group/Type" compact descriptor for search hits.
        const sig = [data.group, data.type].filter(Boolean).join(' / ') || undefined;
        this.addSymbol({
          name,
          type: 'license-code',
          filePath: data.sourcePath || filePath,
          model,
          description: data.label || undefined,
          signature: sig,
        });
      } catch (error) {
        log.warn(`Skipped license-code ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private indexSecurityPolicies(dirPath: string, model: string): void {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    const insertPolicy = this.db.prepare(`
      INSERT INTO security_policies
        (policy_name, primary_table, query_name, operation, constrained_table, label, model)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const name = data.name || path.basename(file, '.json');
        this.addSymbol({
          name,
          type: 'security-policy',
          filePath: data.sourcePath || filePath,
          model,
          description: data.label || undefined,
          signature: data.primaryTable || undefined,
        });
        insertPolicy.run(
          name,
          data.primaryTable || null,
          data.query || null,
          data.operation || null,
          data.constrainedTable ? 1 : 0,
          data.label || null,
          model,
        );
      } catch (error) {
        log.warn(`Skipped security-policy ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private indexMacros(dirPath: string, model: string): void {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    const insertDefine = this.db.prepare(`
      INSERT INTO macro_defines (macro_name, define_name, define_value, model)
      VALUES (?, ?, ?, ?)
    `);
    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const name = data.name || path.basename(file, '.json');
        this.addSymbol({
          name,
          type: 'macro',
          filePath: data.sourcePath || filePath,
          model,
        });
        if (Array.isArray(data.defines)) {
          for (const d of data.defines) {
            if (!d?.name) continue;
            insertDefine.run(name, d.name, d.value ?? '', model);
          }
        }
      } catch (error) {
        log.warn(`Skipped macro ${file}: ${error instanceof Error ? error.message : error}`);
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
        log.warn(`Skipped ${extensionType} ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  /**
   * Replace the extension_metadata row for a single extension.
   *
   * indexExtensions above is the full build's path and reads the extracted JSON;
   * an incremental reindex has only the AOT file, and until it could write here
   * an extension changed in-session was invisible to every reader keyed on
   * base_object_name — resolve_references' field and method checks above all,
   * which report an unknown identifier as an ERROR and, under
   * GROUNDING_ENFORCE, refuse the write carrying it.
   *
   * Delete-then-insert: the table has no unique constraint, so the INSERT OR
   * REPLACE the full build uses only ever appends. Keyed by name + type + model,
   * which is what identifies one extension across a rebuild.
   */
  upsertExtensionMetadata(record: ExtensionMetadataRecord): void {
    const json = (values: string[] | undefined): string | null =>
      values && values.length > 0 ? JSON.stringify(values) : null;

    this.db.transaction(() => {
      this.removeExtensionMetadata(record.extensionName, record.extensionType, record.model);
      this.db.prepare(`
        INSERT INTO extension_metadata
          (extension_name, extension_type, base_object_name, added_fields, added_methods,
           added_indexes, coc_methods, event_subscriptions, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.extensionName,
        record.extensionType,
        record.baseObjectName,
        json(record.addedFields),
        json(record.addedMethods),
        json(record.addedIndexes),
        json(record.cocMethods),
        json(record.eventSubscriptions),
        record.model,
      );
    })();
  }

  /** Drop the extension_metadata row(s) for one extension. Returns rows removed. */
  removeExtensionMetadata(extensionName: string, extensionType: string, model: string): number {
    try {
      return this.db.prepare(
        `DELETE FROM extension_metadata
         WHERE extension_name = ? AND extension_type = ? AND model = ?`,
      ).run(extensionName, extensionType, model).changes;
    } catch {
      return 0;
    }
  }

  // Index freshness bookkeeping

  /** Record "the index was (re)built/updated now" — drives staleness detection. */
  touchLastIndexed(): void {
    try {
      this.db.prepare(
        `INSERT OR REPLACE INTO _index_meta (key, value) VALUES ('last_indexed_at', ?)`,
      ).run(new Date().toISOString());
    } catch {
      // Bookkeeping is best-effort
    }
  }

  /** ISO timestamp of the last full or incremental index update, or null. */
  getLastIndexedAt(): string | null {
    try {
      const row = this.getReadDb().prepare(
        `SELECT value FROM _index_meta WHERE key = 'last_indexed_at'`,
      ).get() as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  // Property statistics (data-driven BP rules)

  /**
   * Record one observation of a metadata property value.
   * Presence checks use the special values '(present)' / '(absent)'.
   */
  recordPropertyStat(nodeType: string, property: string, value: string, model: string): void {
    // Buffer observations in memory; flushed to DB in batch by flushPropertyStats()
    const key = `${nodeType}|${property}|${value}|${model}`;
    this.propStatBuffer.set(key, (this.propStatBuffer.get(key) ?? 0) + 1);
  }

  /**
   * Flush all buffered property_stats observations to the database in a single
   * batch. Call once at the end of each model's transaction. The buffer is
   * cleared after flushing so repeated calls are safe.
   */
  flushPropertyStats(): void {
    if (this.propStatBuffer.size === 0) return;
    let stmt = this.stmtCache.get('flushPropertyStat');
    if (!stmt) {
      stmt = this.db.prepare(`
        INSERT INTO property_stats (node_type, property, value, model, count)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(node_type, property, value, model) DO UPDATE SET count = count + excluded.count
      `);
      this.stmtCache.set('flushPropertyStat', stmt);
    }
    for (const [key, count] of this.propStatBuffer) {
      const [nodeType, property, value, model] = key.split('|');
      stmt.run(nodeType, property, value, model, count);
    }
    this.propStatBuffer.clear();
  }

  /**
   * Ratio of '(present)' observations for a property across all mined models.
   * Returns total=0 when no statistics exist (validate_xpp falls back to
   * static defaults in that case).
   */
  getPropertyPresenceRatio(nodeType: string, property: string): { present: number; total: number; ratio: number } {
    const rows = this.getReadDb().prepare(
      `SELECT value, SUM(count) AS c FROM property_stats
       WHERE node_type = ? AND property = ? GROUP BY value`,
    ).all(nodeType, property) as Array<{ value: string; c: number }>;
    let present = 0;
    let total = 0;
    for (const row of rows) {
      total += row.c;
      if (row.value === '(present)') present += row.c;
    }
    return { present, total, ratio: total > 0 ? present / total : 0 };
  }

  /** Most common values for a property, ordered by observation count. */
  getPropertyValueDistribution(
    nodeType: string,
    property: string,
    limit = 10,
  ): Array<{ value: string; count: number }> {
    return this.getReadDb().prepare(
      `SELECT value, SUM(count) AS count FROM property_stats
       WHERE node_type = ? AND property = ? AND value NOT IN ('(present)', '(absent)')
       GROUP BY value ORDER BY count DESC LIMIT ?`,
    ).all(nodeType, property, limit) as Array<{ value: string; count: number }>;
  }

  /**
   * Tell the index which models this run knows to be non-Microsoft, overriding the
   * name-based `isStandardModel()` heuristic for the property-stats miners.
   *
   * `isStandardModel()` reads CUSTOM_MODELS/EXTENSION_PREFIX from the environment, and
   * `build-database` runs as a separate process where CUSTOM_MODELS is deliberately empty
   * on UDE (custom models are path-auto-detected during extract — see
   * src/utils/extractManifest.ts). Without this, our own model and every third-party ISV
   * model under the custom root are mined as if Microsoft had authored them, and the
   * mined defaults that `prepare`/`generate_object`/`validate_code` present as platform
   * convention are really our own past habits fed back to us.
   *
   * The list is additive: a model here is never mined, and models not listed still go
   * through `isStandardModel()`. Pass an empty array to assert "the caller checked and
   * found none" — that is different from never calling this at all.
   */
  setNonMicrosoftModels(models: string[]): void {
    this.nonMicrosoftModels = new Set(models.map(m => m.toLowerCase()));
    this.mineableModelCache.clear();
  }

  /**
   * Single gate for every property-stats miner: may this model's metadata be mined as
   * evidence of "what the standard Microsoft platform does"?
   */
  private isMineableModel(model: string): boolean {
    const cached = this.mineableModelCache.get(model);
    if (cached !== undefined) return cached;
    const mineable = !this.nonMicrosoftModels?.has(model.toLowerCase()) && isStandardModel(model);
    this.mineableModelCache.set(model, mineable);
    return mineable;
  }

  /**
   * Delete property_stats rows for models that today's gate would not mine.
   *
   * The counts are cumulative (`ON CONFLICT ... count + excluded.count`), so gating the
   * miners only stops NEW pollution — rows written by an earlier build survive until
   * something removes them. This is that something, and it is cheap enough to run on every
   * build: the table is tiny (a few thousand rows, ~150 models on a full D365FO index)
   * because it stores one row per node_type/property/value/model, not per object.
   *
   * Re-evaluates every model actually present in the table rather than only the models
   * this run was told about, so it also clears historical pollution — e.g. rows mined
   * before a model was added to CUSTOM_MODELS. It is therefore only as good as the current
   * notion of "non-Microsoft": an ISV model that neither the extract manifest nor
   * isStandardModel() knows about stays until it is declared.
   *
   * Returns the models purged (empty when the corpus is already clean). With
   * `{ dryRun: true }` it returns the same list without deleting anything, so callers can
   * report the damage without duplicating the predicate.
   */
  purgeNonMineableStats(opts: { dryRun?: boolean } = {}): string[] {
    const models = (this.db.prepare('SELECT DISTINCT model FROM property_stats').all() as Array<{ model: string }>)
      .map(r => r.model);
    const toPurge = models.filter(m => !this.isMineableModel(m));
    if (toPurge.length === 0 || opts.dryRun) return toPurge;

    // Chunked to stay clear of SQLITE_MAX_VARIABLE_NUMBER on a pathological model count.
    const purge = this.db.transaction((names: string[]) => {
      for (let i = 0; i < names.length; i += 400) {
        const chunk = names.slice(i, i + 400);
        const placeholders = chunk.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM property_stats WHERE model IN (${placeholders})`).run(...chunk);
      }
    });
    purge(toPurge);
    return toPurge;
  }

  /**
   * Mine property statistics from one parsed table JSON. Only standard
   * (Microsoft) models are mined — the stats answer "what does the standard
   * platform do", not "what did our customizations do".
   */
  private recordTablePropertyStats(tableData: any, model: string): void {
    if (!this.isMineableModel(model)) return;
    const presence = (v: unknown) => (v ? '(present)' : '(absent)');
    try {
      // xmlParser defaults label to the table name — same value means no real label
      const hasLabel = !!tableData.label && tableData.label !== tableData.name;
      this.recordPropertyStat('AxTable', 'Label', presence(hasLabel), model);
      this.recordPropertyStat('AxTable', 'TableGroup', tableData.tableGroup || '(absent)', model);
      this.recordPropertyStat('AxTable', 'PrimaryIndex', presence(tableData.primaryIndex), model);
      this.recordPropertyStat('AxTable', 'ClusteredIndex', presence(tableData.clusteredIndex), model);
      const indexes = Array.isArray(tableData.indexes) ? tableData.indexes : [];
      this.recordPropertyStat(
        'AxTable', 'AlternateKeyIndex',
        presence(indexes.some((i: any) => i?.unique)), model,
      );
      const fields = Array.isArray(tableData.fields) ? tableData.fields : [];
      for (const field of fields) {
        this.recordPropertyStat(
          'AxTableField', 'ExtendedDataType',
          presence(field?.extendedDataType || field?.enumType), model,
        );
      }
    } catch {
      // Statistics are best-effort — never fail the indexing pass
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
   * Search custom extensions by prefix.
   *
   * Restricts results to symbol types whose names carry the `*_Extension` /
   * `*.<model>Extension` convention (class-extension, table-extension, etc.)
   * so that unrelated symbols sharing a substring don't leak into extension UI.
   *
   * `model IN (custom models)` is what makes this affordable, and it has to be the
   * FIRST predicate. A leading-wildcard `name LIKE '%q%'` is unindexable, so with the
   * whole corpus in scope every call scanned all 584 K symbols — measured at 122.8 s on
   * the production DB. Against idx_symbols_model the same scan covers only the ~25
   * custom models. The filter is also a correctness fix: the results were already
   * captioned "matches in custom extensions" while Microsoft rows could satisfy the
   * name convention and appear there.
   *
   * `types` narrows to symbol kinds (the `type` argument of search(scope="extensions"),
   * which used to be dropped before it reached here). A method or field is matched on
   * its PARENT carrying the extension convention — its own name never does.
   */
  searchCustomExtensions(query: string, prefix?: string, limit: number = 20, types?: string[]): XppSymbol[] {
    const customModels = this.getCustomModels()
      .filter(m => !prefix || m.toLowerCase().startsWith(prefix.toLowerCase()));
    if (customModels.length === 0) return [];

    // '_' is a single-character LIKE wildcard, so the unescaped '%_Extension' this
    // replaced also matched any name merely ENDING in "Extension" — which is how a
    // method called validateWriteExtension was reported as an extension object.
    const escapeLikePattern = (value: string): string =>
      value.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');

    const modelPlaceholders = customModels.map(() => '?').join(',');
    let sql = `
      SELECT *
      FROM symbols
      WHERE model IN (${modelPlaceholders})
        AND name LIKE ? ESCAPE '\\'
        AND (
          type IN (
            'class-extension','table-extension','form-extension','enum-extension',
            'edt-extension','view-extension','query-extension','data-entity-extension',
            'map-extension','menu-extension','security-role-extension','security-duty-extension',
            'menu-item-display-extension','menu-item-action-extension','menu-item-output-extension'
          )
          OR name LIKE '%\\_Extension' ESCAPE '\\'
          OR name LIKE '%.%Extension'
          OR parent_name LIKE '%\\_Extension' ESCAPE '\\'
          OR parent_name LIKE '%.%Extension'
        )
    `;

    const params: any[] = [...customModels, `%${escapeLikePattern(query)}%`];

    if (types && types.length > 0) {
      // Unary + strips the term of its index affinity. Written plainly, `type IN ('method')`
      // makes the planner prefer idx_type_name over idx_symbols_model — and since ~1 M of the
      // 1.19 M rows ARE methods, that trades a 25-model seek for a scan of nearly the whole
      // table: measured 14.8 ms → 238 ms warm, 56 s cold. EXPLAIN QUERY PLAN must keep
      // reporting `SEARCH symbols USING INDEX idx_symbols_model`.
      sql += ` AND +type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    sql += ` ORDER BY name LIMIT ?`;
    params.push(limit);

    const rows = this.getReadDb().prepare(sql).all(...params) as any[];
    return rows.map(row => this.rowToSymbol(row));
  }

  /**
   * Get list of custom models (non-standard models).
   *
   * Standard-model determination is delegated to `isStandardModel()` from
   * modelClassifier (CUSTOM_MODELS / EXTENSION_PREFIX / configured target model).
   * The legacy `this.standardModels` array is always empty (see
   * `loadStandardModels()`), so filtering against it used to return EVERY model
   * — including Microsoft's — as "custom". Filtering via `isStandardModel()`
   * restores the intended custom-only result.
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
      .filter(model => !isStandardModel(model));
  }

  /**
   * Full-text symbol search restricted to CUSTOM/ISV models.
   *
   * Broad keyword searches routed through the C# bridge fill their fixed result
   * window (`maxResults`) in provider-enumeration order, which is dominated by
   * the far larger Microsoft standard corpus — so custom matches that enumerate
   * later get truncated and the search looks like it "only returns Microsoft
   * objects". The search tool probes this method in parallel and splices the
   * custom hits back in, ranked directly after exact-name matches.
   *
   * Index-safe: the FTS5 MATCH drives the query and the `model IN (...)` filter
   * (idx_symbols_model) narrows to the small custom set. The LIKE fallback here is
   * still reached only on an FTS5 syntax error — unlike searchSymbols, this method
   * has no zero-row fallback — and it is model-scoped either way, so the selective
   * `model IN` predicate keeps it off a full `%query%` scan of the whole corpus.
   */
  searchCustomModelSymbols(query: string, types?: string[], limit: number = 15): XppSymbol[] {
    const customModels = this.getCustomModels();
    if (customModels.length === 0) return [];

    const modelPlaceholders = customModels.map(() => '?').join(',');
    const ftsQuery = this.sanitizeFtsQuery(query);
    const db = this.getReadDb();

    let sql = `
      SELECT s.id, s.name, s.type, s.parent_name, s.signature, s.file_path, s.model, s.description
      FROM symbols_fts fts
      JOIN symbols s ON s.id = fts.rowid
      WHERE symbols_fts MATCH ?
        AND s.model IN (${modelPlaceholders})
    `;
    const params: any[] = [ftsQuery, ...customModels];
    if (types && types.length > 0) {
      sql += ` AND s.type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }
    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);

    try {
      const stmt = db.prepare(sql);
      return (stmt.all(...params) as any[]).map(row => this.rowToSymbol(row));
    } catch {
      // FTS5 syntax error (query contains *, ", (, ), -) → LIKE fallback, still model-scoped.
      const escapeLikePattern = (value: string): string =>
        value.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
      let fb = `
        SELECT s.id, s.name, s.type, s.parent_name, s.signature, s.file_path, s.model, s.description
        FROM symbols s
        WHERE s.name LIKE ? ESCAPE '\\'
          AND s.model IN (${modelPlaceholders})
      `;
      const fbParams: any[] = [`%${escapeLikePattern(query)}%`, ...customModels];
      if (types && types.length > 0) {
        fb += ` AND s.type IN (${types.map(() => '?').join(',')})`;
        fbParams.push(...types);
      }
      fb += ` ORDER BY s.name LIMIT ?`;
      fbParams.push(limit);
      try {
        return (db.prepare(fb).all(...fbParams) as any[]).map(r => this.rowToSymbol(r));
      } catch {
        return [];
      }
    }
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
    // Find methods that reference this class in their used_types.
    // Cap at 20 rows — fetching source_snippet for 50+ rows on a 584K-row table causes timeout.
    //
    // `used_types LIKE '%name%'` was wrong on both counts. used_types is a
    // comma-separated list of exact type names, so a substring test answered
    // "SalesTable" with methods that only use AxSalesTable or
    // MCRSalesTableRefRecId. And it could not use an index: LIMIT 20 only stops
    // the scan once 20 matches exist, so a name with no matches read used_types
    // out of all 627 K method rows — each carrying source_snippet and source in
    // overflow pages. Measured on the 2 GB index: over 7 minutes, synchronously,
    // which blocks the whole server until the client gives up and kills it.
    //
    // The FTS pre-filter makes the candidate set small (an indexed token match on
    // source_snippet), and exact membership in the list then decides. Same
    // measurement: 0–230 ms, with the false positives gone.
    //
    // The pre-filter also narrows what can be returned: a method whose
    // used_types names the class but whose stored snippet does not mention it is
    // no longer reported. That is acceptable here specifically — this tool
    // exists to show usage examples, and the caller reads initialization
    // patterns straight out of source_snippet, so a row whose snippet lacks the
    // name has no example to contribute.
    const safe = className.replace(/["\(\)\\]/g, '').trim();
    if (!safe) return [];

    let stmt = this.stmtCache.get('getApiUsagePatterns');
    if (!stmt) {
      stmt = this.db.prepare(
        `SELECT name, parent_name, method_calls, source_snippet
           FROM symbols
          WHERE type = 'method'
            AND id IN (SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ?)
            AND ', ' || used_types || ', ' LIKE ? COLLATE NOCASE
          LIMIT 20`
      );
      this.stmtCache.set('getApiUsagePatterns', stmt);
    }
    const methods = stmt.all(`{source_snippet} : "${safe}"`, `%, ${className}, %`) as any[];

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
    this.invalidateSymbolCounts();
    this.db.exec('DELETE FROM symbols');
    this.db.exec('DELETE FROM table_relations');
    this.db.exec('DELETE FROM form_datasources');
    this.db.exec('DELETE FROM form_patterns');
    this.db.exec('DELETE FROM edt_metadata');
    this.db.exec('DELETE FROM security_privilege_entries');
    this.db.exec('DELETE FROM security_duty_privileges');
    this.db.exec('DELETE FROM security_role_duties');
    this.db.exec('DELETE FROM menu_item_targets');
    this.db.exec('DELETE FROM extension_metadata');
    this.db.exec('DELETE FROM service_operations');
    this.db.exec('DELETE FROM service_group_members');
    this.db.exec('DELETE FROM map_mappings');
    this.db.exec('DELETE FROM security_policies');
    this.db.exec('DELETE FROM macro_defines');
    this.db.exec('DELETE FROM property_stats');
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
    this.invalidateSymbolCounts();

    // The symbols_ad trigger is what removes the cleared rows from symbols_fts. It is
    // normally already in place, but an interrupted SKIP_FTS build can leave the database
    // trigger-less — recreate it (IF NOT EXISTS) so a clear can never orphan FTS rows.
    this.createFTSTriggers();

    // Wrap all deletes in a single transaction so the database never ends up
    // in a partially-cleared state if one statement fails mid-way.
    const deleteAll = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM symbols WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM table_relations WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM form_datasources WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM form_patterns WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM edt_metadata WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM security_privilege_entries WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM security_duty_privileges WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM security_role_duties WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM menu_item_targets WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM extension_metadata WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM service_operations WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM service_group_members WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM map_mappings WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM security_policies WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM macro_defines WHERE model IN (${placeholders})`).run(...modelNames);
      this.db.prepare(`DELETE FROM property_stats WHERE model IN (${placeholders})`).run(...modelNames);
    });
    deleteAll();

    log.step(`Cleared symbols for models: ${modelNames.join(', ')}`);
    
    if (shouldVacuum) {
      log.step('Running VACUUM to optimize database...');
      this.vacuum();
      log.ok('VACUUM completed');
    } else {
      log.info('Skipping VACUUM for faster incremental build');
    }
  }

  /**
   * Vacuum the database to reclaim space after deletions
   */
  private vacuum(): void {
    this.db.exec('VACUUM');
  }

  /**
   * Get candidate symbol names for fuzzy matching ("did you mean" suggestions).
   *
   * When a query is given, candidates are anchored to it: names sharing the
   * query's leading characters plus names sharing its root term (avoids
   * always sampling the same alphabetical slice of a 580K-symbol index).
   * Without a query, falls back to the first 5000 names alphabetically.
   *
   * Both probes go through symbols_fts. `name LIKE '%root%'` cannot use any index
   * — SQLite scans all 1.17M rows, synchronously, on exactly the path an agent hits
   * when it guessed a name wrong, which it does routinely. FTS5 answers a prefix
   * term from its term index instead. The trade is that infix candidates
   * ("MyCustTable" for query "CustTable") are no longer offered; they scored below
   * the 0.7 fuzzy threshold anyway, being far longer than the query.
   */
  getAllSymbolNames(query?: string, limit: number = 2000): string[] {
    const trimmed = query?.trim();
    const cacheKey = `${trimmed ?? ''}|${limit}`;
    const cached = this.suggestionNamesCache.get(cacheKey);
    if (cached) return cached;

    const names = this.computeSymbolNameCandidates(trimmed, limit);

    // Bounded LRU-ish: a session probing dozens of wrong names must not pin an
    // unbounded number of 2000-name arrays in memory.
    if (this.suggestionNamesCache.size >= SUGGESTION_CACHE_ENTRIES) {
      const oldest = this.suggestionNamesCache.keys().next().value;
      if (oldest !== undefined) this.suggestionNamesCache.delete(oldest);
    }
    this.suggestionNamesCache.set(cacheKey, names);
    return names;
  }

  private computeSymbolNameCandidates(trimmed: string | undefined, limit: number): string[] {
    if (!trimmed) {
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

    // Typo distance is usually in the tail of the name, so same-prefix names are
    // the best candidate pool; the longer root-term prefix catches typos further
    // in (e.g. "CusTable" → "CustTable") with a tighter, higher-quality window.
    const half = Math.max(1, Math.floor(limit / 2));
    // FTS5 tokenizes on non-alphanumerics, so anything else in the term would be
    // read as an operator (or a syntax error) rather than matched.
    const ftsTerm = trimmed.replace(/[^a-zA-Z0-9]/g, '');
    const prefix = ftsTerm.slice(0, 2);
    const root = ftsTerm.slice(0, Math.max(3, Math.ceil(ftsTerm.length / 2)));

    const names = new Set<string>();
    const db = this.getReadDb();
    if (prefix.length > 0) {
      try {
        const stmt = this.getReadStmt(db, 'suggest_fts_prefix', () =>
          `SELECT s.name FROM symbols_fts fts JOIN symbols s ON s.id = fts.rowid
           WHERE symbols_fts MATCH ? LIMIT ?`);
        for (const probe of new Set([prefix, root])) {
          for (const row of stmt.iterate(`{name} : "${probe}"*`, half) as IterableIterator<{ name: string }>) {
            names.add(row.name);
          }
        }
        return [...names];
      } catch {
        // FTS table missing (SKIP_FTS build) — fall through to the scan.
      }
    }

    const escapeLike = (value: string): string =>
      value.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
    try {
      const prefixStmt = this.getReadStmt(db, 'suggest_prefix', () =>
        `SELECT DISTINCT name FROM symbols WHERE name LIKE ? ESCAPE '\\' LIMIT ?`);
      for (const row of prefixStmt.iterate(`${escapeLike(trimmed.slice(0, 2))}%`, half) as IterableIterator<{ name: string }>) {
        names.add(row.name);
      }
    } catch {
      // Best-effort — suggestions are advisory, never fail the search
    }
    return [...names];
  }

  /**
   * Get symbols grouped by term (for relationship analysis)
   * Returns a map of term -> symbols with that term
   * Uses iterator to avoid loading all symbols into memory at once
   *
   * Memoized for the lifetime of the index contents: the query takes no arguments
   * and hydrates the same 3000 rows every time, yet it sits on the failed-search
   * path next to getAllSymbolNames — so every name an agent probes and misses paid
   * for a fresh `SELECT *` of 3000 rows on the event loop.
   */
  getSymbolsByTerm(): Map<string, XppSymbol[]> {
    if (this.symbolsByTermCache) return this.symbolsByTermCache;
    const built = this.computeSymbolsByTerm();
    this.symbolsByTermCache = built;
    return built;
  }

  private computeSymbolsByTerm(): Map<string, XppSymbol[]> {
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
   * Close the database connection and release all pooled resources: the
   * prepared-statement cache, writer + read pool, labels DB + its read pool,
   * and any pending debounced labels FTS rebuild timer.
   */
  close(): void {
    // RUN the pending debounced rebuild, don't just cancel its timer: labels created
    // in the last ~300 ms before shutdown are in the labels table but not yet in
    // labels_fts, and cancelling leaves them unfindable by searchLabels until the
    // next full re-index. Best-effort — a rebuild failure must not block the close.
    try {
      this.flushLabelsFtsRebuild();
    } catch (e) {
      console.error(`[SymbolIndex] Final labels FTS flush failed: ${e}`);
      this._labelsFtsTimer = null;
    }

    // Drain read pools first — writer close will fail on WAL if readers hold a lock.
    this.closeReadPool();

    this.stmtCache.clear();
    try { this.db.close(); } catch { /* ignore */ }
    try { this.labelsDb.close(); } catch { /* ignore */ }
  }

  // Label methods

  /**
   * Add (or replace) a label entry in the index.
   * Labels live in the separate `labelsDb` connection — NOT in the main symbols DB.
   * The stmtCache is shared across connections so the cache key is namespaced to avoid
   * accidentally reusing a statement prepared against a different DB handle.
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
    let stmt = this.stmtCache.get('labels::addLabel');
    if (!stmt) {
      stmt = this.labelsDb.prepare(`
        INSERT OR REPLACE INTO labels (label_id, label_file_id, model, language, text, comment, file_path_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      this.stmtCache.set('labels::addLabel', stmt);
    }
    stmt.run(
      entry.labelId,
      entry.labelFileId,
      entry.model,
      entry.language,
      entry.text,
      entry.comment ?? null,
      this.labelFilePathId(entry.filePath),
    );
  }

  /**
   * Row id of `filePath` in `label_files`, inserting it if it is new.
   *
   * Memoised for the process: a bulk load calls this once per label but there is
   * one distinct path per .label.txt (813 across a default en-US build of 374 K
   * rows), so without the cache it would be ~374 K index probes to learn 813 answers.
   * The cache is only ever added to — rows in label_files are never deleted, since a
   * path that had labels once may have them again after the next scan and the table
   * is trivially small either way.
   */
  private labelFilePathId(filePath: string): number {
    const cached = this.labelFilePathIds.get(filePath);
    if (cached !== undefined) return cached;

    let select = this.stmtCache.get('labels::selectFilePathId');
    if (!select) {
      select = this.labelsDb.prepare('SELECT id FROM label_files WHERE file_path = ?');
      this.stmtCache.set('labels::selectFilePathId', select);
    }
    let insert = this.stmtCache.get('labels::insertFilePath');
    if (!insert) {
      insert = this.labelsDb.prepare('INSERT OR IGNORE INTO label_files (file_path) VALUES (?)');
      this.stmtCache.set('labels::insertFilePath', insert);
    }

    let row = select.get(filePath) as { id: number } | undefined;
    if (!row) {
      insert.run(filePath);
      row = select.get(filePath) as { id: number } | undefined;
    }
    // A missing row here would mean the INSERT was rejected by something other than
    // the uniqueness it is told to ignore; there is no sane id to invent.
    if (!row) throw new Error(`Could not resolve label file path to an id: ${filePath}`);

    this.labelFilePathIds.set(filePath, row.id);
    return row.id;
  }

  /** filePath -> label_files.id, populated lazily by labelFilePathId(). */
  private readonly labelFilePathIds = new Map<string, number>();

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
    opts?: { skipFtsRebuild?: boolean; keepTriggers?: boolean },
  ): void {
    const keepTriggers = !!opts?.keepTriggers;
    if (keepTriggers) {
      // Scoped/incremental insert: let the triggers maintain labels_fts per row instead of
      // re-tokenising every label in the database afterwards. Recursive triggers are required so the
      // rows displaced by INSERT OR REPLACE fire labels_ad and don't leave orphaned FTS
      // entries pointing at dead rowids.
      this.labelsDb.pragma('recursive_triggers = ON');
    } else {
      // Disable FTS triggers during bulk insert
      this.labelsDb.exec(`DROP TRIGGER IF EXISTS labels_ai`);
      this.labelsDb.exec(`DROP TRIGGER IF EXISTS labels_ad`);
      this.labelsDb.exec(`DROP TRIGGER IF EXISTS labels_au`);
    }

    // try/finally, because the teardown is not optional: a constraint violation in
    // the insert or a failure inside rebuildLabelsFts used to propagate with the
    // triggers still dropped, and from then on every label written through this
    // connection was missing from labels_fts with nothing to signal it.
    try {
      const insert = this.labelsDb.prepare(`
        INSERT OR REPLACE INTO labels (label_id, label_file_id, model, language, text, comment, file_path_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const insertMany = this.labelsDb.transaction((rows: typeof entries) => {
        for (const e of rows) {
          insert.run(
            e.labelId,
            e.labelFileId,
            e.model,
            e.language,
            e.text,
            e.comment ?? null,
            this.labelFilePathId(e.filePath),
          );
        }
      });

      insertMany(entries);

      // With keepTriggers the index is already up to date — the triggers maintained
      // it row by row. Otherwise rebuild, unless the caller will do a single rebuild
      // after all batches.
      if (!keepTriggers && !opts?.skipFtsRebuild) {
        this.rebuildLabelsFts();
      }
    } finally {
      if (keepTriggers) {
        this.labelsDb.pragma('recursive_triggers = OFF');
      } else {
        this.createLabelsFtsTriggers();
      }
    }
  }

  /**
   * Rebuild the FTS index for labels from scratch — every row in `labels`, whatever
   * its language.
   *
   * This used to filter to en-US on the theory that it was "the primary search
   * language", which held only as long as nobody searched in another one. On a build
   * with LABEL_LANGUAGES=en-US,cs,sk,de the other three quarters were unreachable
   * through the index, and searchLabels quietly answered them with a LIKE scan of
   * the whole table instead. The index is ~4x larger on such a build; the alternative
   * was a 150 s query.
   */
  rebuildLabelsFts(): void {
    // Clear existing FTS index
    this.labelsDb.exec(`INSERT INTO labels_fts(labels_fts) VALUES('delete-all')`);
    this.labelsDb.exec(`
      INSERT INTO labels_fts(rowid, label_id, text, comment)
      SELECT id, label_id, text, comment FROM labels
    `);
  }

  // Debounced labels FTS rebuild
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
   * Full-text search labels within one language (default en-US).
   *
   * Answered from labels_fts, which covers every indexed locale. Only queries FTS5
   * cannot tokenise fall through to the LIKE scan in searchLabelsLike.
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

    // Sanitize query for FTS5 (strip chars that would cause a syntax error)
    const ftsQuery = query.replace(/['"*()]/g, ' ').trim();
    // Route to LIKE when FTS5 would silently return 0 results:
    // • '_' and '%' — word separators in the unicode61 tokenizer (also LIKE wildcards);
    //   literal underscore/percent searches must go through LIKE with proper escaping.
    // • Any query whose letter/digit content disappears after sanitization (e.g. '-',
    //   '.', '@', ':', '@SYS:') produces zero FTS5 tokens and no exception to trigger
    //   the catch-based fallback below.
    //   The test is Unicode-aware on purpose: unicode61 tokenises 'Přístup' and
    //   'Qualität' perfectly well, and an [a-zA-Z0-9] test would have shunted any
    //   query without ASCII letters onto the LIKE scan this method exists to avoid.
    if (/[_%]/.test(query) || !/[\p{L}\p{N}]/u.test(ftsQuery)) {
      return this.searchLabelsLike(query, opts);
    }

    // Cache statement keyed by which optional filters are active (4 variants)
    const stmtKey = `searchLabels_${model ? 'model' : 'nomodel'}_${labelFileId ? 'lfid' : 'nolfid'}`;
    let stmt = this.labelsStmtCache.get(stmtKey);
    if (!stmt) {
      // The language predicate is not optional. labels_fts now holds every locale,
      // so without it a `cs` search happily returns the en-US and de rows that share
      // a token — the index no longer does the filtering the caller assumed.
      let sql = `
        SELECT l.label_id AS labelId, l.label_file_id AS labelFileId, l.model, l.language,
               l.text, l.comment, lf.file_path AS filePath,
               f.rank
        FROM labels_fts f
        JOIN labels l ON l.id = f.rowid
        JOIN label_files lf ON lf.id = l.file_path_id
        WHERE labels_fts MATCH ?
          AND LOWER(l.language) = ?`;
      if (model)       sql += `\n          AND l.model = ?`;
      if (labelFileId) sql += `\n          AND l.label_file_id = ?`;
      sql += `\n          ORDER BY f.rank\n          LIMIT ?`;
      stmt = this.labelsDb.prepare(sql);
      this.labelsStmtCache.set(stmtKey, stmt);
    }

    const params: any[] = [ftsQuery, language.toLowerCase()];
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
   * LIKE-based fallback label search, for the queries FTS5 cannot tokenise
   * (literal '_'/'%', or nothing but punctuation once sanitised).
   *
   * A leading-wildcard LIKE cannot use an index, so this scans the labels table.
   * The language predicate is written to hit idx_labels_language_lower, which keeps
   * the scan inside one locale instead of all of them; there is no way to make the
   * text comparison itself cheaper here, which is exactly why the FTS path above now
   * covers every language rather than only en-US.
   */
  private searchLabelsLike(
    query: string,
    opts: { language?: string; model?: string; labelFileId?: string; limit?: number } = {},
  ): any[] {
    const { language = 'en-US', model, labelFileId, limit = 30 } = opts;
    // Escape LIKE special characters so the query is treated as a literal substring.
    // '\' is the escape character declared in the SQL ESCAPE clause below.
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    const pattern = `%${escaped}%`;

    const stmtKey = `searchLabelsLike_${model ? 'model' : 'nomodel'}_${labelFileId ? 'lfid' : 'nolfid'}`;
    let stmt = this.labelsStmtCache.get(stmtKey);
    if (!stmt) {
      let sql = `
        SELECT l.label_id AS labelId, l.label_file_id AS labelFileId, l.model, l.language,
               l.text, l.comment, lf.file_path AS filePath, 0 as rank
        FROM labels l
        JOIN label_files lf ON lf.id = l.file_path_id
        WHERE (l.text LIKE ? ESCAPE '\\' OR l.label_id LIKE ? ESCAPE '\\')
          AND LOWER(l.language) = ?`;
      if (model)       sql += `\n          AND l.model = ?`;
      if (labelFileId) sql += `\n          AND l.label_file_id = ?`;
      sql += `\n        LIMIT ?`;
      stmt = this.labelsDb.prepare(sql);
      this.labelsStmtCache.set(stmtKey, stmt);
    }

    // Lowercased here, not as LOWER(?) in SQL: the expression index is on
    // LOWER(language), and matching it requires the bound side to be a plain value.
    const params: any[] = [pattern, pattern, language.toLowerCase()];
    if (model)       params.push(model);
    if (labelFileId) params.push(labelFileId);
    params.push(limit);
    return stmt.all(...params) as any[];
  }

  /**
   * Get a single label by ID (returns all languages).
   *
   * The ID may be spelled any way the rest of the server emits it: a reference
   * (`@ContosoExt:EquipmentName`, `@GLS4170035`, even the doubled
   * `@SYS:@SYS67433`) or the bare key. #888: matching the caller's string
   * against the stored one verbatim made the natural spelling fail for the 27
   * legacy label files, whose keys are stored WITH the sigil — 61% of the
   * indexed rows — and `search` output, which is always a reference, was never
   * valid input here. Both branches of the IN-list still use `idx_labels_id`
   * (and `idx_labels_unique` once the file/model filters are added), so the
   * widening costs nothing; see labelIdSpellings for why the sigil is not
   * normalised away at storage time instead.
   *
   * Rows come back with the id EXACTLY as stored, which is the spelling
   * callers must keep using for anything that reads the .label.txt (see
   * labelMissingOnDisk) or writes a reference.
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
    const parsed = parseLabelReference(labelId);
    const spellings = labelIdSpellings(parsed.labelId);
    if (spellings.length === 0) return [];

    // A `@File:Id` input names its own file; an explicit argument still wins,
    // and when the two disagree the empty result is the right answer.
    const fileFilter = labelFileId ?? parsed.labelFileId;

    const params: any[] = [...spellings];
    let sql = `
      SELECT l.label_id AS labelId, l.label_file_id AS labelFileId, l.model, l.language,
             l.text, l.comment, lf.file_path AS filePath
      FROM labels l
      JOIN label_files lf ON lf.id = l.file_path_id
      WHERE l.label_id IN (${spellings.map(() => '?').join(', ')})
    `;
    if (fileFilter) { sql += ` AND l.label_file_id = ?`; params.push(fileFilter); }
    if (model)      { sql += ` AND l.model = ?`;         params.push(model); }
    sql += ` ORDER BY l.language`;
    return this.labelsDb.prepare(sql).all(...params) as any[];
  }

  /**
   * Get all label file IDs for a model (i.e. which AxLabelFiles exist).
   *
   * Both filters belong in SQL. `labelFileId` used to be applied by the caller to
   * the finished list, so asking about ONE label file still grouped all 1.4 M rows
   * into 1602 groups and then threw 1601 of them away — a full index scan measured
   * at 2.5 s warm, and one cold call in a real session took 28 s against the 40-170 ms
   * every other call to the same tool costs. Pushed into the WHERE clause the same
   * lookup is a seek on idx_labels_file_id: 0.4 ms.
   */
  getLabelFileIds(model?: string, labelFileId?: string): Array<{ labelFileId: string; model: string; languages: string }> {
    const run = (extraWhere: string, params: string[]) => this.labelsDb.prepare(`
      SELECT label_file_id AS labelFileId, model, GROUP_CONCAT(DISTINCT language) AS languages
      FROM labels
      ${extraWhere}
      GROUP BY label_file_id, model
      ORDER BY label_file_id
    `).all(...params) as Array<{ labelFileId: string; model: string; languages: string }>;

    const where: string[] = [];
    const params: string[] = [];
    if (model) { where.push('model = ?'); params.push(model); }
    if (labelFileId) { where.push('label_file_id = ?'); params.push(labelFileId); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const hits = run(clause, params);
    if (hits.length > 0 || !labelFileId) return hits;

    // The caller-side filter this replaced compared lowercased, and idx_labels_file_id
    // is BINARY — so a differently-cased ID would silently return nothing. Only when
    // the fast exact seek misses does it cost the scan to stay case-insensitive.
    const nocaseWhere: string[] = ['label_file_id = ? COLLATE NOCASE'];
    const nocaseParams: string[] = [labelFileId];
    if (model) { nocaseWhere.unshift('model = ?'); nocaseParams.unshift(model); }
    return run(`WHERE ${nocaseWhere.join(' AND ')}`, nocaseParams);
  }

  /**
   * Get the physical .label.txt file path for each language of a label file.
   * Used by labels(action="info", labelFileId=…) so callers get the on-disk
   * location per language instead of having to shell out to find it.
   */
  getLabelFilePaths(
    labelFileId: string,
    model?: string,
  ): Array<{ language: string; filePath: string; model: string }> {
    const params: any[] = [labelFileId];
    let sql = `
      SELECT DISTINCT l.language, lf.file_path AS filePath, l.model
      FROM labels l
      JOIN label_files lf ON lf.id = l.file_path_id
      WHERE l.label_file_id = ? AND lf.file_path IS NOT NULL AND lf.file_path != ''
    `;
    if (model) { sql += ` AND l.model = ?`; params.push(model); }
    sql += ` ORDER BY l.language`;
    return this.labelsDb.prepare(sql).all(...params) as any[];
  }

  /**
   * Remove all labels for the given models (used during incremental rebuild)
   */
  clearLabelsForModels(models: string[], opts?: { ftsStrategy?: 'rebuild' | 'incremental' }): void {
    const placeholders = models.map(() => '?').join(',');
    this.labelsDb.prepare(`DELETE FROM labels WHERE model IN (${placeholders})`).run(...models);
    // 'incremental': the labels_ad trigger already dropped each deleted row from labels_fts,
    // so the full delete-all + re-INSERT of every label (O(all labels)) is pure waste
    // when only a handful of models were cleared.
    if (opts?.ftsStrategy !== 'incremental') this.rebuildLabelsFts();
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
   * Updates all rows for the given labelId + labelFileId + model combination.
   *
   * No FTS rebuild: the `labels_au` trigger deletes the old term and inserts the new
   * one for each updated row, which is the whole of the work a rebuild would redo.
   * This used to call rebuildLabelsFts() afterwards — re-tokenising every label in
   * the database (~105 s on the production DB) to reflect a handful of renamed rows,
   * and because node:sqlite is synchronous the server answered nothing for its whole
   * duration. create_label and update_symbol_index were moved off that pattern
   * earlier; this was the last caller still on it.
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
  }
}
