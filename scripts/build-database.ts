/**
 * Database Builder Script
 * Builds SQLite database from extracted metadata
 */

import { loadEnv } from '../src/utils/loadEnv.js';
loadEnv(import.meta.url);
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { XppSymbolIndex } from '../src/metadata/symbolIndex.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { isCustomModel, isStandardModel, getCustomModels } from '../src/utils/modelClassifier.js';
import { indexAllLabels } from '../src/metadata/labelParser.js';
import { XppConfigProvider } from '../src/utils/xppConfigProvider.js';

const INPUT_PATH = process.env.METADATA_PATH || './extracted-metadata';
const OUTPUT_DB = process.env.DB_PATH || './data/xpp-metadata.db';
const OUTPUT_LABELS_DB = process.env.LABELS_DB_PATH || './data/xpp-metadata-labels.db';
const EXTRACT_MODE = process.env.EXTRACT_MODE || 'all';
const CUSTOM_MODELS = getCustomModels();
const FORCE_VACUUM = process.env.VACUUM === 'true';
// Labels are indexed from PackagesLocalDirectory directly (not from extracted-metadata)
const PACKAGES_PATH = process.env.D365FO_PACKAGE_PATH || process.env.PACKAGES_PATH || 'K:\\AosService\\PackagesLocalDirectory';
const INCLUDE_LABELS = process.env.INCLUDE_LABELS !== 'false'; // default: true
// Two-phase CI build: Phase 1 indexes symbols only (SKIP_FTS=true), Phase 2 runs build-fts
const SKIP_FTS = process.env.SKIP_FTS === 'true';
// Resume interrupted build: skip already-indexed models (progress tracked in _build_progress table)
const RESUME = process.env.RESUME === 'true';

async function buildDatabase() {
  console.log('🔨 Building X++ Metadata Database');
  console.log(`📂 Input: ${INPUT_PATH}`);
  console.log(`💾 Output: ${OUTPUT_DB}`);
  console.log(`💾 Labels DB: ${OUTPUT_LABELS_DB}`);
  console.log(`⚙️  Extract Mode: ${EXTRACT_MODE}`);
  console.log(`🧹 VACUUM: ${EXTRACT_MODE === 'all' || FORCE_VACUUM ? 'Enabled' : 'Disabled (incremental build)'}`);
  console.log('');

  // Create symbol index with separate labels database
  const symbolIndex = new XppSymbolIndex(OUTPUT_DB, OUTPUT_LABELS_DB);

  // Optimize for bulk loading: use MEMORY journal during build
  console.log('⚡ Setting bulk load optimizations (MEMORY journal)...');
  // Close read-pool connections first: SQLite cannot grant locking_mode = EXCLUSIVE
  // while any other connection (even read-only, even in-process) holds a shared lock.
  // The pool is only needed for concurrent production reads, not for build scripts.
  symbolIndex.closeReadPool();
  symbolIndex.db.pragma('journal_mode = MEMORY'); // Fastest for bulk inserts
  symbolIndex.db.pragma('synchronous = OFF');     // Maximum speed (safe for build process)
  symbolIndex.db.pragma('locking_mode = EXCLUSIVE'); // No concurrent access needed during build
  
  // Same optimizations for labels database
  symbolIndex.labelsDb.pragma('journal_mode = MEMORY');
  symbolIndex.labelsDb.pragma('synchronous = OFF');
  symbolIndex.labelsDb.pragma('locking_mode = EXCLUSIVE');

  // Determine which models to rebuild based on EXTRACT_MODE
  let modelsToRebuild: string[] = [];
  
  // Determine if VACUUM should run:
  // - Always for full rebuild (EXTRACT_MODE=all)
  // - For incremental builds only if explicitly requested (VACUUM=true)
  const shouldVacuum = EXTRACT_MODE === 'all' || FORCE_VACUUM;
  
  if (RESUME) {
    // Resume mode: skip clearing, continue from progress checkpoint
    const done = symbolIndex.getIndexedModels();
    console.log(`♻️  Resume mode: ${done.size} model(s) already indexed, continuing from checkpoint`);
  } else if (EXTRACT_MODE === 'all') {
    // Clear entire database for full rebuild
    console.log('🗑️  Clearing entire database for full rebuild...');
    symbolIndex.clear();
    symbolIndex.clearProgressTracking();
  } else if (EXTRACT_MODE === 'custom') {
    // Clear only custom models
    if (CUSTOM_MODELS.length > 0) {
      // Expand wildcards in custom models
      const allModels = fsSync.readdirSync(INPUT_PATH, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
      
      // Expand patterns (e.g., "My*" → ["MyModel", "MyFinanceCore", ...])
      const expandedModels: string[] = [];
      for (const pattern of CUSTOM_MODELS) {
        if (pattern.includes('*')) {
          // Wildcard pattern - match against all models
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i');
          const matched = allModels.filter(m => regex.test(m));
          expandedModels.push(...matched);
        } else {
          // Exact model name
          if (allModels.includes(pattern)) {
            expandedModels.push(pattern);
          }
        }
      }
      
      modelsToRebuild = [...new Set(expandedModels)]; // Remove duplicates
      console.log(`🗑️  Clearing symbols for models: ${CUSTOM_MODELS.join(', ')}`);
      if (modelsToRebuild.length !== CUSTOM_MODELS.length) {
        console.log(`   📌 Expanded to ${modelsToRebuild.length} models: ${modelsToRebuild.slice(0, 5).join(', ')}${modelsToRebuild.length > 5 ? '...' : ''}`);
      }
      symbolIndex.clearModels(modelsToRebuild, shouldVacuum);
    } else {
      // When CUSTOM_MODELS is not specified, treat ALL models in INPUT_PATH as custom
      // This is correct for incremental builds where extract-metadata already filtered to custom models
      const allModels = fsSync.readdirSync(INPUT_PATH, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
      
      console.log(`🗑️  No CUSTOM_MODELS specified. Treating all ${allModels.length} model(s) in INPUT_PATH as custom`);
      console.log(`   📦 Models to rebuild: ${allModels.slice(0, 10).join(', ')}${allModels.length > 10 ? '...' : ''}`);
      
      // CRITICAL: Use allModels directly, NOT filtered by isCustomModel()
      // The filtering was already done by extract-metadata when it populated INPUT_PATH
      modelsToRebuild = allModels;
      symbolIndex.clearModels(modelsToRebuild, shouldVacuum);
    }
  } else if (EXTRACT_MODE === 'standard') {
    // Clear only standard models (all except custom)
    const allModels = fsSync.readdirSync(INPUT_PATH, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
    modelsToRebuild = allModels.filter(m => isStandardModel(m));
    symbolIndex.clearModels(modelsToRebuild, shouldVacuum);
  }

  // Index the extracted metadata
  console.log('📖 Indexing metadata...');
  const startTime = Date.now();
  
  if (modelsToRebuild.length > 0) {
    // Index specific models
    console.log(`📦 Indexing ${modelsToRebuild.length} model(s): ${modelsToRebuild.slice(0, 10).join(', ')}${modelsToRebuild.length > 10 ? '...' : ''}`);
    console.log(`   ℹ️  Incremental build: Standard models in database will be preserved`);
    for (const modelName of modelsToRebuild) {
      await symbolIndex.indexMetadataDirectory(INPUT_PATH, modelName);
    }
  } else {
    // Index all models in the directory
    console.log(`📦 Indexing ALL models from: ${INPUT_PATH}`);
    console.log(`   ⚠️  WARNING: This should only happen for EXTRACT_MODE=all (full rebuild)`);
    console.log(`   ⚠️  Current EXTRACT_MODE: ${EXTRACT_MODE}`);
    await symbolIndex.indexMetadataDirectory(INPUT_PATH);
  }
  
  console.log(`\n📊 Indexing complete, now collecting statistics...`);
  const endTime = Date.now();
  const duration = ((endTime - startTime) / 1000).toFixed(2);

  // Compute usage statistics (usage_frequency, called_by_count)
  // IMPORTANT: This is SLOW (1-2 minutes for 300k+ methods)
  // Only enable explicitly via COMPUTE_STATS=true (not automatic even for full rebuilds)
  const shouldComputeStats = process.env.COMPUTE_STATS === 'true';
  if (shouldComputeStats) {
    console.log('📈 Computing usage statistics (this may take 1-2 minutes)...');
    symbolIndex.computeUsageStatistics();
    console.log('✅ Usage statistics computed');
  } else {
    console.log('⏭️  Skipping usage statistics computation (use COMPUTE_STATS=true to enable)');
    console.log('    ℹ️  Statistics provide usage_frequency and called_by_count fields');
  }

  const count = symbolIndex.getSymbolCount();
  console.log(`✅ Database built successfully in ${duration}s!`);
  console.log(`📊 Total symbols: ${count}`);

  // ── Label Indexing ─────────────────────────────────────────────────────────
  if (SKIP_FTS) {
    console.log('\n⏭️  Skipping label indexing (SKIP_FTS=true) — will be indexed by build-fts step');
  } else if (INCLUDE_LABELS) {
    // Build list of package root paths to scan for labels.
    // Priority: XPP config auto-detection > PACKAGES_PATH fallback
    const labelRootPaths: string[] = [];
    const devEnvType = process.env.DEV_ENVIRONMENT_TYPE || 'auto';
    if (devEnvType !== 'traditional') {
      const xppProvider = new XppConfigProvider();
      const configName = process.env.XPP_CONFIG_NAME || undefined;
      const xppConfig = await xppProvider.getActiveConfig(configName);
      if (xppConfig) {
        console.log(`   [UDE] XPP config: ${xppConfig.configName} v${xppConfig.version}`);
        labelRootPaths.push(xppConfig.customPackagesPath);
        labelRootPaths.push(xppConfig.microsoftPackagesPath);
      }
    }
    // Fallback: traditional single path
    if (labelRootPaths.length === 0) {
      labelRootPaths.push(PACKAGES_PATH);
    }

    console.log(`\n🏷️  Indexing AxLabelFile labels from ${labelRootPaths.length} package root(s):`);
    for (const p of labelRootPaths) {
      console.log(`   📂 ${p}`);
    }

    // Filter out roots that don't exist on disk
    const validRoots = labelRootPaths.filter(p => {
      if (!fsSync.existsSync(p)) {
        console.log(`   ⚠️  PackagesLocalDirectory not found at "${p}" — skipping.`);
        return false;
      }
      return true;
    });

    if (validRoots.length === 0) {
      console.log(`   ⚠️  No valid package roots found — skipping labels.`);
      console.log(`   ℹ️  Set PACKAGES_PATH env var (or configure XPP_CONFIG_NAME for UDE), or INCLUDE_LABELS=false to suppress this message.`);
    } else {
      const labelStart = Date.now();

      // For incremental builds of specific custom models, clear and re-index only those models' labels
      // For full standard rebuild, index all standard model labels (not limited to modelsToRebuild)
      const isIncrementalCustomBuild = modelsToRebuild.length > 0 && EXTRACT_MODE === 'custom';

      let grandTotalLabels = 0;
      let grandTotalModels = 0;

      if (isIncrementalCustomBuild) {
        symbolIndex.clearLabelsForModels(modelsToRebuild);
        for (const rootPath of validRoots) {
          const { totalLabels, modelsIndexed } = await indexAllLabels(
            symbolIndex,
            rootPath,
            (modelName) => modelsToRebuild.includes(modelName),
          );
          grandTotalLabels += totalLabels;
          grandTotalModels += modelsIndexed;
        }
      } else {
        // Full rebuild — determine model filter based on EXTRACT_MODE
        let labelModelFilter: ((m: string) => boolean) | undefined;
        if (EXTRACT_MODE === 'custom') {
          labelModelFilter = (m) => isCustomModel(m);
        } else if (EXTRACT_MODE === 'standard') {
          labelModelFilter = (m) => isStandardModel(m);
        }
        // else: no filter — index all models

        for (const rootPath of validRoots) {
          const { totalLabels, modelsIndexed } = await indexAllLabels(
            symbolIndex,
            rootPath,
            labelModelFilter,
          );
          grandTotalLabels += totalLabels;
          grandTotalModels += modelsIndexed;
        }
      }

      const labelDuration = ((Date.now() - labelStart) / 1000).toFixed(2);
      console.log(`   ✅ ${grandTotalLabels} label entries indexed across ${grandTotalModels} models in ${labelDuration}s`);

      const labelCount = symbolIndex.getLabelCount();
      console.log(`   📊 Total labels in database: ${labelCount}`);
    }
  } else {
    console.log('\n⏭️  Skipping label indexing (INCLUDE_LABELS=false)');
  }

  if (SKIP_FTS) {
    console.log('\n⏭️  Skipping WAL conversion (database will be finalized by build-fts step)');
    console.log('   ℹ️  Upload this database as a pipeline artifact, then run: npm run build-fts');
  } else {
    // Convert to WAL mode for production use (better concurrency)
    console.log('\n🔄 Converting databases to WAL mode for production...');
    symbolIndex.db.pragma('locking_mode = NORMAL');  // Re-enable shared access
    symbolIndex.db.pragma('journal_mode = WAL');     // Enable WAL for runtime
    symbolIndex.db.pragma('synchronous = NORMAL');   // Balance speed/safety
    
    symbolIndex.labelsDb.pragma('locking_mode = NORMAL');
    symbolIndex.labelsDb.pragma('journal_mode = WAL');
    symbolIndex.labelsDb.pragma('synchronous = NORMAL');
    console.log('✅ Databases converted to WAL mode');

    // ANALYZE + optimize: persist query-planner stats into the DB so the production
    // server can open it with zero warmup cost (skipped when SKIP_FTS=true because
    // build-fts will run these tasks at the end of phase 2).
    symbolIndex.runPostBuildTasks();
  }

  // Show breakdown by type
  const breakdown = symbolIndex.getSymbolCountByType();
  console.log('\n📋 Symbol breakdown:');
  for (const [type, typeCount] of Object.entries(breakdown)) {
    console.log(`   ${type}: ${typeCount}`);
  }
}

buildDatabase().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
