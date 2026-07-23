#!/usr/bin/env node
/**
 * Unified database maintenance CLI for xpp-metadata.db
 *
 * Consolidates the former check-db*.mjs and repair-*.mjs scripts.
 *
 * Usage:
 *   node scripts/db-maintenance.mjs check    [--db-path PATH] [--model-prefix PREFIX]
 *   node scripts/db-maintenance.mjs repair-fts          [--db-path PATH]
 *   node scripts/db-maintenance.mjs repair-fts-surgical  [--db-path PATH]
 *   node scripts/db-maintenance.mjs repair-dump          [--db-path PATH]
 */
import { renameSync, existsSync, unlinkSync } from 'fs';
import { parseArgs } from 'util';

// Runs through tsx (see the "db-maintenance" npm script) so it can share the
// server's node:sqlite layer instead of carrying its own SQLite binding.
import Database from '../src/database/sqlite.js';

// ── CLI parsing ──────────────────────────────────────────────────────────────
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'db-path':      { type: 'string', default: './data/xpp-metadata.db' },
    'model-prefix': { type: 'string', default: '' },
    help:           { type: 'boolean', short: 'h', default: false },
  },
});

const command = positionals[0];
const DB_PATH = values['db-path'];
const MODEL_PREFIX = values['model-prefix'];

if (!command || values.help) {
  console.log(`Usage: node scripts/db-maintenance.mjs <command> [options]

Commands:
  check                Health check: integrity, FTS tables, symbol count,
                       model distribution, optional prefix filter.
  repair-fts           Drop and recreate FTS virtual table + triggers,
                       rebuild index from existing symbols.
  repair-fts-surgical  Emergency writable_schema removal of FTS entries
                       when DROP TABLE fails due to corruption.
  repair-dump          Full dump-and-restore: read all data from corrupt DB,
                       write to a fresh one, rebuild FTS, swap files.

Options:
  --db-path PATH       Path to xpp-metadata.db  (default: ./data/xpp-metadata.db)
  --model-prefix PFX   Filter models by prefix  (used by 'check')
  -h, --help           Show this help message
`);
  process.exit(command ? 0 : 1);
}

// ── Commands ─────────────────────────────────────────────────────────────────
switch (command) {
  case 'check':          cmdCheck();          break;
  case 'repair-fts':     cmdRepairFts();      break;
  case 'repair-fts-surgical': cmdRepairFtsSurgical(); break;
  case 'repair-dump':    cmdRepairDump();     break;
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// check — combines check-db, check-db2, check-db3
// ─────────────────────────────────────────────────────────────────────────────
function cmdCheck() {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    // Integrity
    console.log('Running integrity_check...');
    const integ = db.pragma('integrity_check');
    console.log('Result:', JSON.stringify(integ.slice(0, 20)));

    // FTS tables
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const ftsTables = tables.filter(t => t.name.includes('fts'));
    console.log('FTS tables:', ftsTables.map(t => t.name));

    // Symbol count
    const symbolCount = db.prepare('SELECT COUNT(*) as cnt FROM symbols').get();
    console.log('Symbol count:', symbolCount.cnt);

    // Rootpage info (low pages)
    const allEntries = db.prepare("SELECT type, name, rootpage FROM sqlite_master ORDER BY rootpage").all();
    console.log('\nTables with rootpage <= 20:');
    allEntries.filter(t => t.rootpage <= 20).forEach(t =>
      console.log(`  rootpage=${t.rootpage} type=${t.type} name=${t.name}`)
    );

    // Model distribution (top 10)
    const models = db.prepare("SELECT model, COUNT(*) as cnt FROM symbols GROUP BY model ORDER BY cnt DESC LIMIT 10").all();
    console.log('\nTop models:');
    models.forEach(m => console.log(`  ${m.model}: ${m.cnt}`));

    // Prefix filter
    if (MODEL_PREFIX) {
      const filtered = db.prepare("SELECT model, COUNT(*) as cnt FROM symbols WHERE model LIKE ? GROUP BY model ORDER BY model").all(`${MODEL_PREFIX}%`);
      console.log(`\n${MODEL_PREFIX}* models in DB:`);
      if (filtered.length === 0) {
        console.log(`  NONE - ${MODEL_PREFIX}* models are MISSING from symbols table!`);
      } else {
        filtered.forEach(m => console.log(`  ${m.model}: ${m.cnt}`));
      }
    }
  } catch (e) {
    console.error('Error:', e.message, e.code);
    process.exit(1);
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// repair-fts — drop/recreate FTS + triggers, rebuild from symbols
// ─────────────────────────────────────────────────────────────────────────────
function cmdRepairFts() {
  console.log(`🔧 Repairing FTS index in: ${DB_PATH}`);
  const db = new Database(DB_PATH);
  try {
    db.pragma('journal_mode = WAL');

    console.log('🗑️  Dropping corrupt symbols_fts virtual table...');
    db.exec('DROP TABLE IF EXISTS symbols_fts;');
    console.log('   ✅ Dropped symbols_fts (+ shadow tables)');

    console.log('🗑️  Dropping FTS triggers...');
    db.exec('DROP TRIGGER IF EXISTS symbols_ai;');
    db.exec('DROP TRIGGER IF EXISTS symbols_au;');
    db.exec('DROP TRIGGER IF EXISTS symbols_ad;');
    console.log('   ✅ Dropped triggers');

    console.log('🏗️  Recreating symbols_fts virtual table...');
    db.exec(`
      CREATE VIRTUAL TABLE symbols_fts USING fts5(
        name, type, parent_name, signature, description, tags,
        source_snippet, inline_comments,
        content='symbols', content_rowid='id'
      );
    `);
    console.log('   ✅ Recreated symbols_fts (empty)');

    const symbolCount = db.prepare('SELECT COUNT(*) as cnt FROM symbols').get();
    console.log(`\n📊 Populating FTS from ${symbolCount.cnt} existing symbols...`);
    db.exec("INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild');");
    console.log('   ✅ FTS index rebuilt from existing symbols');

    console.log('\n🔍 Running integrity_check...');
    const result = db.pragma('integrity_check(1)');
    const isOk = result.length === 1 && result[0].integrity_check === 'ok';
    console.log(`   ${isOk ? '✅ Database integrity OK' : '❌ Issues found: ' + JSON.stringify(result)}`);

    console.log('\n✅ Repair complete! Now run: npm run build-database');
  } catch (e) {
    console.error('❌ Repair failed:', e.message);
    process.exit(1);
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// repair-fts-surgical — writable_schema emergency removal
// ─────────────────────────────────────────────────────────────────────────────
function cmdRepairFtsSurgical() {
  console.log(`🔧 Surgical FTS repair in: ${DB_PATH}`);
  const db = new Database(DB_PATH);
  try {
    db.pragma('writable_schema = ON');

    const ftsEntries = db.prepare(
      "SELECT type, name, tbl_name, rootpage FROM sqlite_master WHERE name LIKE 'symbols_fts%' OR name LIKE 'symbols_a%' ORDER BY name"
    ).all();
    console.log('FTS entries to remove:');
    ftsEntries.forEach(e => console.log(`  ${e.type} "${e.name}" (rootpage=${e.rootpage})`));

    if (ftsEntries.length === 0) {
      console.log('  Nothing to remove.');
    } else {
      const deleted = db.prepare(
        "DELETE FROM sqlite_master WHERE name LIKE 'symbols_fts%' OR name IN ('symbols_ai', 'symbols_au', 'symbols_ad')"
      ).run();
      console.log(`\n🗑️  Removed ${deleted.changes} entries from sqlite_master`);

      db.pragma('schema_version = ' + (db.pragma('schema_version', { simple: true }) + 1));
      console.log('   ✅ Schema version bumped');
    }

    db.pragma('writable_schema = OFF');
    db.pragma('integrity_check(1)');
  } catch (e) {
    console.error('❌ Failed:', e.message);
    process.exit(1);
  } finally {
    db.close();
  }

  // Reopen and verify
  console.log('\n🔍 Verifying repair...');
  const db2 = new Database(DB_PATH);
  try {
    const symbolCount = db2.prepare('SELECT COUNT(*) as cnt FROM symbols').get();
    console.log(`   symbols count: ${symbolCount.cnt}`);

    const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    console.log(`   tables: ${tables.map(t => t.name).join(', ')}`);

    console.log('\n✅ Repair complete! Now run: npm run build-database');
  } catch (e) {
    console.error('❌ Verification failed:', e.message);
  } finally {
    db2.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// repair-dump — full dump-and-restore
// ─────────────────────────────────────────────────────────────────────────────
function cmdRepairDump() {
  const BACKUP_PATH = DB_PATH + '.bak';
  const NEW_PATH = DB_PATH + '.new';

  console.log('🔧 Dump-and-restore repair for corrupt database');
  console.log(`   Source: ${DB_PATH}`);
  console.log(`   New DB: ${NEW_PATH}`);

  // Step 1: Open corrupt DB readonly
  const src = new Database(DB_PATH, { readonly: true });

  let symbolsCols, codePatterns = [], buildProgress = [];
  try {
    symbolsCols = src.pragma('table_info(symbols)').map(c => c.name);
    console.log(`\n📋 symbols columns: ${symbolsCols.join(', ')}`);

    const symbolCount = src.prepare('SELECT COUNT(*) as cnt FROM symbols').get().cnt;
    console.log(`📊 symbols to migrate: ${symbolCount}`);

    try {
      codePatterns = src.prepare('SELECT * FROM code_patterns').all();
      console.log(`📊 code_patterns to migrate: ${codePatterns.length}`);
    } catch { console.log('⚠️  Skipping code_patterns (not readable)'); }

    try {
      buildProgress = src.prepare('SELECT * FROM _build_progress').all();
      console.log(`📊 _build_progress to migrate: ${buildProgress.length} entries`);
    } catch { console.log('ℹ️  _build_progress not found (ok for incremental build)'); }
  } catch (e) {
    console.error('❌ Cannot read source DB:', e.message);
    src.close();
    process.exit(1);
  }

  // Step 2: Create new clean DB
  if (existsSync(NEW_PATH)) unlinkSync(NEW_PATH);
  const dst = new Database(NEW_PATH);
  dst.pragma('journal_mode = MEMORY');
  dst.pragma('synchronous = OFF');
  dst.pragma('locking_mode = EXCLUSIVE');
  dst.pragma('cache_size = -131072');

  console.log('\n🏗️  Creating schema in new DB...');
  const ddlRows = src.prepare(
    "SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'symbols_fts%' AND sql IS NOT NULL ORDER BY rootpage"
  ).all();
  for (const { sql } of ddlRows) {
    try { dst.exec(sql); } catch (e) { console.warn(`   ⚠️  Skipped DDL: ${e.message.slice(0, 80)}`); }
  }

  dst.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
      name, type, parent_name, signature, description, tags,
      source_snippet, inline_comments,
      content='symbols', content_rowid='id'
    );
  `);

  // Step 3: Batch-insert symbols
  console.log('\n📥 Migrating symbols...');
  const BATCH = 10000;
  const colList = symbolsCols.join(', ');
  const placeholders = symbolsCols.map(() => '?').join(', ');
  const insert = dst.prepare(`INSERT OR IGNORE INTO symbols (${colList}) VALUES (${placeholders})`);
  const insertBatch = dst.transaction((rows) => {
    for (const row of rows) insert.run(symbolsCols.map(c => row[c]));
  });

  let offset = 0, total = 0;
  const startTime = Date.now();
  while (true) {
    const rows = src.prepare(`SELECT * FROM symbols LIMIT ${BATCH} OFFSET ${offset}`).all();
    if (rows.length === 0) break;
    insertBatch(rows);
    offset += rows.length;
    total += rows.length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stdout.write(`\r   Migrated ${total.toLocaleString()} symbols... (${elapsed}s)`);
  }
  console.log(`\n   ✅ Migrated ${total.toLocaleString()} symbols`);

  // Step 4: Migrate code_patterns
  if (codePatterns.length > 0) {
    const cols = Object.keys(codePatterns[0]);
    const ins = dst.prepare(`INSERT OR IGNORE INTO code_patterns (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    dst.transaction(() => codePatterns.forEach(r => ins.run(cols.map(c => r[c]))))();
    console.log(`   ✅ Migrated ${codePatterns.length} code_patterns`);
  }

  // Step 5: Migrate _build_progress
  if (buildProgress.length > 0) {
    try {
      dst.exec('CREATE TABLE IF NOT EXISTS _build_progress (model TEXT PRIMARY KEY, indexed_at INTEGER)');
      const ins = dst.prepare('INSERT OR REPLACE INTO _build_progress (model, indexed_at) VALUES (?, ?)');
      dst.transaction(() => buildProgress.forEach(r => ins.run(r.model, r.indexed_at)))();
      console.log(`   ✅ Migrated ${buildProgress.length} build progress entries`);
    } catch (e) { console.warn('   ⚠️  Could not migrate _build_progress:', e.message); }
  }

  // Step 6: Rebuild FTS
  console.log('\n🔄 Rebuilding FTS index...');
  const ftsStart = Date.now();
  dst.exec("INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild');");
  console.log(`   ✅ FTS rebuilt in ${((Date.now() - ftsStart) / 1000).toFixed(1)}s`);

  src.close();
  dst.close();

  // Step 7: Swap files
  console.log('\n🔁 Swapping files...');
  if (existsSync(BACKUP_PATH)) unlinkSync(BACKUP_PATH);
  renameSync(DB_PATH, BACKUP_PATH);
  renameSync(NEW_PATH, DB_PATH);
  console.log(`   ✅ ${DB_PATH} replaced (backup: ${BACKUP_PATH})`);

  console.log('\n✅ Repair complete!');
  console.log('   Next: npm run build-database  (re-indexes custom models)');
}
