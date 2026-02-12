/**
 * Database Builder Script
 * Builds SQLite database from extracted metadata
 */

import 'dotenv/config';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { XppSymbolIndex } from '../src/metadata/symbolIndex.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { isCustomModel, isStandardModel, getCustomModels } from '../src/utils/modelClassifier.js';

const INPUT_PATH = process.env.METADATA_PATH || './extracted-metadata';
const OUTPUT_DB = process.env.DB_PATH || './data/xpp-metadata.db';
const EXTRACT_MODE = process.env.EXTRACT_MODE || 'all';
const CUSTOM_MODELS = getCustomModels();

async function buildDatabase() {
  console.log('🔨 Building X++ Metadata Database');
  console.log(`📂 Input: ${INPUT_PATH}`);
  console.log(`💾 Output: ${OUTPUT_DB}`);
  console.log(`⚙️  Extract Mode: ${EXTRACT_MODE}`);
  console.log('');

  // Create symbol index
  const symbolIndex = new XppSymbolIndex(OUTPUT_DB);

  // Optimize for bulk loading: use MEMORY journal during build
  console.log('⚡ Setting bulk load optimizations (MEMORY journal)...');
  symbolIndex.db.pragma('journal_mode = MEMORY'); // Fastest for bulk inserts
  symbolIndex.db.pragma('synchronous = OFF');     // Maximum speed (safe for build process)
  symbolIndex.db.pragma('locking_mode = EXCLUSIVE'); // No concurrent access needed during build

  // Determine which models to rebuild based on EXTRACT_MODE
  let modelsToRebuild: string[] = [];
  
  if (EXTRACT_MODE === 'all') {
    // Clear entire database for full rebuild
    console.log('🗑️  Clearing entire database for full rebuild...');
    symbolIndex.clear();
  } else if (EXTRACT_MODE === 'custom') {
    // Clear only custom models
    if (CUSTOM_MODELS.length > 0) {
      // Clear specific custom models
      symbolIndex.clearModels(CUSTOM_MODELS);
      modelsToRebuild = CUSTOM_MODELS;
    } else {
      // Clear all custom models (exclude standard)
      const allModels = fsSync.readdirSync(INPUT_PATH, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
      modelsToRebuild = allModels.filter(m => isCustomModel(m));
      symbolIndex.clearModels(modelsToRebuild);
    }
  } else if (EXTRACT_MODE === 'standard') {
    // Clear only standard models (all except custom)
    const allModels = fsSync.readdirSync(INPUT_PATH, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
    modelsToRebuild = allModels.filter(m => isStandardModel(m));
    symbolIndex.clearModels(modelsToRebuild);
  }

  // Index the extracted metadata
  console.log('📖 Indexing metadata...');
  const startTime = Date.now();
  
  if (modelsToRebuild.length > 0) {
    // Index specific models
    console.log(`📦 Indexing ${modelsToRebuild.length} model(s): ${modelsToRebuild.join(', ')}`);
    for (const modelName of modelsToRebuild) {
      console.log(`   🔄 Starting indexing of ${modelName}...`);
      await symbolIndex.indexMetadataDirectory(INPUT_PATH, modelName);
      console.log(`   ✅ Completed indexing of ${modelName}`);
    }
  } else {
    // Index all models in the directory
    console.log(`   🔄 Starting full directory indexing...`);
    await symbolIndex.indexMetadataDirectory(INPUT_PATH);
    console.log(`   ✅ Completed directory indexing`);
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

  // Convert to WAL mode for production use (better concurrency)
  console.log('\n🔄 Converting database to WAL mode for production...');
  symbolIndex.db.pragma('locking_mode = NORMAL');  // Re-enable shared access
  symbolIndex.db.pragma('journal_mode = WAL');     // Enable WAL for runtime
  symbolIndex.db.pragma('synchronous = NORMAL');   // Balance speed/safety
  console.log('✅ Database converted to WAL mode');

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
