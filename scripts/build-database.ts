/**
 * Database Builder Script
 * Builds SQLite database from extracted metadata
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { XppSymbolIndex } from '../src/metadata/symbolIndex.js';

const INPUT_PATH = process.env.INPUT_PATH || './extracted-metadata';
const OUTPUT_DB = process.env.OUTPUT_DB || './xpp-metadata.db';

async function buildDatabase() {
  console.log('🔨 Building X++ Metadata Database');
  console.log(`📂 Input: ${INPUT_PATH}`);
  console.log(`💾 Output: ${OUTPUT_DB}`);
  console.log('');

  // Create symbol index
  const symbolIndex = new XppSymbolIndex(OUTPUT_DB);

  // Index the extracted metadata
  console.log('📖 Indexing metadata...');
  await symbolIndex.indexMetadataDirectory(INPUT_PATH);

  const count = symbolIndex.getSymbolCount();
  console.log(`✅ Database built successfully!`);
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
