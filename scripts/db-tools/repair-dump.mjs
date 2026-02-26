/**
 * Dump-and-restore repair:
 * Reads all symbols from the corrupt DB and writes them to a new clean DB.
 * Preserves code_patterns and _build_progress tables too.
 *
 * Usage: node scripts/repair-dump.mjs
 * After: npm run build-database  (re-indexes custom models + rebuilds FTS)
 */
import { createRequire } from 'module';
import { renameSync, existsSync, unlinkSync } from 'fs';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './data/xpp-metadata.db';
const BACKUP_PATH = DB_PATH + '.bak';
const NEW_PATH = DB_PATH + '.new';

console.log('🔧 Dump-and-restore repair for corrupt database');
console.log(`   Source: ${DB_PATH}`);
console.log(`   New DB: ${NEW_PATH}`);

// ── Step 1: Open corrupt DB in readonly ──────────────────────────────────────
const src = new Database(DB_PATH, { readonly: true });

// ── Step 2: Read symbols schema ───────────────────────────────────────────────
let symbolsCols, symbolsSchema, codePatterns = [], buildProgress = [];
try {
  symbolsCols = src.pragma('table_info(symbols)').map(c => c.name);
  console.log(`\n📋 symbols columns: ${symbolsCols.join(', ')}`);

  const symbolCount = src.prepare('SELECT COUNT(*) as cnt FROM symbols').get().cnt;
  console.log(`📊 symbols to migrate: ${symbolCount}`);

  // Try to read code_patterns (non-FTS table)
  try {
    codePatterns = src.prepare('SELECT * FROM code_patterns').all();
    console.log(`📊 code_patterns to migrate: ${codePatterns.length}`);
  } catch { console.log('⚠️  Skipping code_patterns (not readable)'); }

  // Try to read _build_progress
  try {
    buildProgress = src.prepare('SELECT * FROM _build_progress').all();
    console.log(`📊 _build_progress to migrate: ${buildProgress.length} entries`);
  } catch { console.log('ℹ️  _build_progress not found (ok for incremental build)'); }

} catch (e) {
  console.error('❌ Cannot read source DB:', e.message);
  src.close();
  process.exit(1);
}

// ── Step 3: Create new clean DB ───────────────────────────────────────────────
if (existsSync(NEW_PATH)) unlinkSync(NEW_PATH);
const dst = new Database(NEW_PATH);
dst.pragma('journal_mode = MEMORY');
dst.pragma('synchronous = OFF');
dst.pragma('locking_mode = EXCLUSIVE');
dst.pragma('cache_size = -131072'); // 128 MB cache

console.log('\n🏗️  Creating schema in new DB...');

// Read and replay DDL for symbols (excluding FTS)
const ddlRows = src.prepare(
  "SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'symbols_fts%' AND sql IS NOT NULL ORDER BY rootpage"
).all();

for (const { sql } of ddlRows) {
  try { dst.exec(sql); } catch (e) { console.warn(`   ⚠️  Skipped DDL: ${e.message.slice(0, 80)}`); }
}

// Create FTS5 virtual table fresh
dst.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
    name, type, parent_name, signature, description, tags,
    source_snippet, inline_comments,
    content='symbols', content_rowid='id'
  );
`);

// ── Step 4: Batch-insert symbols ──────────────────────────────────────────────
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

// ── Step 5: Migrate code_patterns ────────────────────────────────────────────
if (codePatterns.length > 0) {
  const cols = Object.keys(codePatterns[0]);
  const ins = dst.prepare(`INSERT OR IGNORE INTO code_patterns (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  const tx = dst.transaction(() => codePatterns.forEach(r => ins.run(cols.map(c => r[c]))));
  tx();
  console.log(`   ✅ Migrated ${codePatterns.length} code_patterns`);
}

// ── Step 6: Migrate _build_progress ──────────────────────────────────────────
if (buildProgress.length > 0) {
  try {
    dst.exec('CREATE TABLE IF NOT EXISTS _build_progress (model TEXT PRIMARY KEY, indexed_at INTEGER)');
    const ins = dst.prepare('INSERT OR REPLACE INTO _build_progress (model, indexed_at) VALUES (?, ?)');
    const tx = dst.transaction(() => buildProgress.forEach(r => ins.run(r.model, r.indexed_at)));
    tx();
    console.log(`   ✅ Migrated ${buildProgress.length} build progress entries`);
  } catch(e) { console.warn('   ⚠️  Could not migrate _build_progress:', e.message); }
}

// ── Step 7: Rebuild FTS ───────────────────────────────────────────────────────
console.log('\n🔄 Rebuilding FTS index...');
const ftsStart = Date.now();
dst.exec("INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild');");
console.log(`   ✅ FTS rebuilt in ${((Date.now() - ftsStart) / 1000).toFixed(1)}s`);

src.close();
dst.close();

// ── Step 8: Swap files ────────────────────────────────────────────────────────
console.log('\n🔁 Swapping files...');
if (existsSync(BACKUP_PATH)) unlinkSync(BACKUP_PATH);
renameSync(DB_PATH, BACKUP_PATH);
renameSync(NEW_PATH, DB_PATH);
console.log(`   ✅ ${DB_PATH} replaced (backup: ${BACKUP_PATH})`);

console.log('\n✅ Repair complete!');
console.log('   Next: npm run build-database  (re-indexes custom models)');
