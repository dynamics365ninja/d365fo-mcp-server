/**
 * FTS & Labels Build Script  (Phase 2 of two-phase CI build)
 *
 * Rebuilds the full-text search index and indexes AxLabelFile labels on an
 * existing symbols database produced by `build-database` with SKIP_FTS=true.
 *
 * Usage:
 *   npm run build-fts
 *
 * Relevant env vars:
 *   DB_PATH          Path to the SQLite database  (default: ./data/xpp-metadata.db)
 *   PACKAGES_PATH    Path to PackagesLocalDirectory for label indexing
 *                    (default: K:\AosService\PackagesLocalDirectory)
 *   INCLUDE_LABELS   Set to 'false' to skip label indexing  (default: true)
 *   EXTRACT_MODE     'all' | 'standard' | 'custom' — controls which model labels to index
 *                    (default: 'all')
 *
 * Two-phase Azure Pipeline pattern (fits within 2 × 120 min limit):
 *   Job 1:  SKIP_FTS=true INCLUDE_LABELS=false npm run build-database   → ~90 min
 *           Upload xpp-metadata.db as pipeline artifact
 *   Job 2:  Download artifact → npm run build-fts                        → ~60-90 min
 *           Upload final xpp-metadata.db to Blob Storage
 */

import { loadEnv } from '../src/utils/loadEnv.js';
loadEnv(import.meta.url);
import * as fsSync from 'fs';
import { XppSymbolIndex } from '../src/metadata/symbolIndex.js';
import { indexAllLabels } from '../src/metadata/labelParser.js';
import { isCustomModel, isStandardModel } from '../src/utils/modelClassifier.js';
import { fileURLToPath } from 'url';
import * as path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DB     = process.env.DB_PATH       || './data/xpp-metadata.db';
const OUTPUT_LABELS_DB = process.env.LABELS_DB_PATH || './data/xpp-metadata-labels.db';
const PACKAGES_PATH = process.env.PACKAGES_PATH || 'K:\\AosService\\PackagesLocalDirectory';
const INCLUDE_LABELS = process.env.INCLUDE_LABELS !== 'false'; // default: true
const EXTRACT_MODE  = process.env.EXTRACT_MODE  || 'all';

async function buildFts(): Promise<void> {
  console.log('🔍 Phase 2: Building FTS index + labels');
  console.log(`💾 Database: ${OUTPUT_DB}`);
  console.log(`💾 Labels DB: ${OUTPUT_LABELS_DB}`);
  console.log(`⚙️  Extract mode: ${EXTRACT_MODE}`);
  console.log('');

  if (!fsSync.existsSync(OUTPUT_DB)) {
    console.error(`❌ Database not found at: ${OUTPUT_DB}`);
    console.error('   Run "npm run build-database" (with SKIP_FTS=true) first.');
    process.exit(1);
  }

  const symbolIndex = new XppSymbolIndex(OUTPUT_DB, OUTPUT_LABELS_DB);

  // Use same bulk-load pragmas for the FTS rebuild (important: no WAL during heavy writes)
  symbolIndex.db.pragma('journal_mode = MEMORY');
  symbolIndex.db.pragma('synchronous = OFF');
  symbolIndex.db.pragma('locking_mode = EXCLUSIVE');
  symbolIndex.db.pragma('cache_size = -64000');
  symbolIndex.db.pragma('temp_store = MEMORY');
  symbolIndex.db.pragma('mmap_size = 268435456');
  
  // Same optimizations for labels database
  symbolIndex.labelsDb.pragma('journal_mode = MEMORY');
  symbolIndex.labelsDb.pragma('synchronous = OFF');
  symbolIndex.labelsDb.pragma('locking_mode = EXCLUSIVE');
  symbolIndex.labelsDb.pragma('cache_size = -64000');
  symbolIndex.labelsDb.pragma('temp_store = MEMORY');
  symbolIndex.labelsDb.pragma('mmap_size = 268435456');

  const totalStart = Date.now();

  // ── Symbols FTS ────────────────────────────────────────────────────────────
  symbolIndex.rebuildFTS();

  // ── Label Indexing ─────────────────────────────────────────────────────────
  if (INCLUDE_LABELS) {
    console.log(`\n🏷️  Indexing AxLabelFile labels from: ${PACKAGES_PATH}/{Model}/{Model}/AxLabelFile/...`);
    if (!fsSync.existsSync(PACKAGES_PATH)) {
      console.log(`   ⚠️  PackagesLocalDirectory not found at "${PACKAGES_PATH}" — skipping labels.`);
      console.log(`   ℹ️  Set PACKAGES_PATH env var to the correct path, or INCLUDE_LABELS=false to suppress.`);
    } else {
      const labelStart = Date.now();

      let labelModelFilter: ((m: string) => boolean) | undefined;
      if (EXTRACT_MODE === 'custom') {
        labelModelFilter = (m) => isCustomModel(m);
      } else if (EXTRACT_MODE === 'standard') {
        labelModelFilter = (m) => isStandardModel(m);
      }
      // else: no filter — index all models

      const { totalLabels, modelsIndexed } = await indexAllLabels(
        symbolIndex,
        PACKAGES_PATH,
        labelModelFilter,
      );

      const labelDuration = ((Date.now() - labelStart) / 1000).toFixed(2);
      console.log(`   ✅ ${totalLabels} label entries indexed across ${modelsIndexed} models in ${labelDuration}s`);

      const labelCount = symbolIndex.getLabelCount();
      console.log(`   📊 Total labels in database: ${labelCount}`);
    }
  } else {
    console.log('\n⏭️  Skipping label indexing (INCLUDE_LABELS=false)');
  }

  // ── Finalize: convert to WAL mode for production ───────────────────────────
  console.log('\n🔄 Converting databases to WAL mode for production...');
  symbolIndex.db.pragma('locking_mode = NORMAL');
  symbolIndex.db.pragma('journal_mode = WAL');
  symbolIndex.db.pragma('synchronous = NORMAL');
  
  symbolIndex.labelsDb.pragma('locking_mode = NORMAL');
  symbolIndex.labelsDb.pragma('journal_mode = WAL');
  symbolIndex.labelsDb.pragma('synchronous = NORMAL');
  console.log('✅ Databases converted to WAL mode');

  // Persist ANALYZE stats + optimizer hints into the DB so the production
  // server can open it instantly without re-running expensive maintenance.
  symbolIndex.runPostBuildTasks();

  const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(1);
  const symbolCount = symbolIndex.getSymbolCount();
  const labelCount = symbolIndex.getLabelCount();

  console.log(`\n📊 Final statistics:`);
  console.log(`   Symbols: ${symbolCount}`);
  console.log(`   Labels:  ${labelCount}`);
  console.log(`   Total Phase 2 time: ${totalDuration}s`);

  symbolIndex.close();
}

buildFts().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
