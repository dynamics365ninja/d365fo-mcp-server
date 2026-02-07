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
      await symbolIndex.indexMetadataDirectory(INPUT_PATH, modelName);
    }
  } else {
    // Index all models in the directory
    await symbolIndex.indexMetadataDirectory(INPUT_PATH);
  }
  
  const endTime = Date.now();
  const duration = ((endTime - startTime) / 1000).toFixed(2);

  const count = symbolIndex.getSymbolCount();
  console.log(`✅ Database built successfully in ${duration}s!`);
  console.log(`📊 Total symbols: ${count}`);

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
