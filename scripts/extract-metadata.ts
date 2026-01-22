/**
 * Metadata Extraction Script
 * Extracts X++ metadata from D365 F&O PackagesLocalDirectory
 */

import 'dotenv/config';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { XppMetadataParser } from '../src/metadata/xmlParser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGES_PATH = process.env.PACKAGES_PATH || 'C:\\AOSService\\PackagesLocalDirectory';
const OUTPUT_PATH = process.env.OUTPUT_PATH || './extracted-metadata';
const CUSTOM_MODELS_PATH = process.env.CUSTOM_MODELS_PATH; // Optional: separate path for custom extensions
const EXTENSION_PREFIX = process.env.EXTENSION_PREFIX || '';

// Load standard F&O models from config file
function loadStandardModels(): string[] {
  try {
    const configPath = path.resolve(__dirname, '../config/standard-models.json');
    const configContent = fsSync.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configContent);
    return config.standardModels || [];
  } catch (error) {
    console.warn('⚠️  Could not load standard-models.json, using fallback list');
    return [
      'ApplicationFoundation',
      'ApplicationPlatform',
      'ApplicationSuite',
      'Directory',
      'Ledger',
    ];
  }
}

const STANDARD_MODELS = loadStandardModels();

// Custom extension models to extract
const CUSTOM_MODELS = process.env.CUSTOM_MODELS?.split(',').map(m => m.trim()).filter(Boolean) || [
  // Add your custom models here or use CUSTOM_MODELS env var
  // 'CustomModel1',
  // 'CustomModel2',
];

// Combined list
const MODELS_TO_EXTRACT = [
  ...STANDARD_MODELS,
  ...CUSTOM_MODELS,
];

interface ExtractionStats {
  totalFiles: number;
  classes: number;
  tables: number;
  forms: number;
  enums: number;
  errors: number;
}

async function extractMetadata() {
  console.log('🔍 X++ Metadata Extraction');
  console.log(`📂 Source: ${PACKAGES_PATH}`);
  console.log(`📁 Output: ${OUTPUT_PATH}`);
  console.log(`📋 Models: ${MODELS_TO_EXTRACT.join(', ')}`);
  console.log('');

  const parser = new XppMetadataParser();
  const stats: ExtractionStats = {
    totalFiles: 0,
    classes: 0,
    tables: 0,
    forms: 0,
    enums: 0,
    errors: 0,
  };

  // Create output directory
  await fs.mkdir(OUTPUT_PATH, { recursive: true });

  // Process each package/model
  for (const packageName of MODELS_TO_EXTRACT) {
    console.log(`\n📦 Processing package: ${packageName}`);

    const packagePath = path.join(PACKAGES_PATH, packageName);
    
    try {
      await fs.access(packagePath);
    } catch {
      console.warn(`⚠️  Package path not found: ${packagePath}`);
      continue;
    }

    // Find all models within this package
    const entries = await fs.readdir(packagePath, { withFileTypes: true });
    const modelDirs = entries.filter(e => e.isDirectory()).map(e => e.name);

    for (const modelName of modelDirs) {
      const modelPath = path.join(packagePath, modelName);
      
      // Check if this directory contains X++ metadata (has AxClass, AxTable, etc.)
      const hasAxClass = await fs.access(path.join(modelPath, 'AxClass')).then(() => true).catch(() => false);
      const hasAxTable = await fs.access(path.join(modelPath, 'AxTable')).then(() => true).catch(() => false);
      const hasAxEnum = await fs.access(path.join(modelPath, 'AxEnum')).then(() => true).catch(() => false);

      if (!hasAxClass && !hasAxTable && !hasAxEnum) {
        // Skip directories that don't contain X++ metadata
        continue;
      }

      console.log(`   📂 Model: ${modelName}`);

      // Extract classes
      await extractClasses(parser, modelPath, modelName, stats);

      // Extract tables
      await extractTables(parser, modelPath, modelName, stats);

      // Extract enums
      await extractEnums(parser, modelPath, modelName, stats);
    }
  }

  console.log('\n✅ Extraction complete!');
  console.log(`📊 Statistics:`);
  console.log(`   Total files: ${stats.totalFiles}`);
  console.log(`   Classes: ${stats.classes}`);
  console.log(`   Tables: ${stats.tables}`);
  console.log(`   Enums: ${stats.enums}`);
  console.log(`   Errors: ${stats.errors}`);
}

async function extractClasses(
  parser: XppMetadataParser,
  modelPath: string,
  modelName: string,
  stats: ExtractionStats
) {
  const classesPath = path.join(modelPath, 'AxClass');
  
  try {
    await fs.access(classesPath);
  } catch {
    return; // No classes in this model
  }

  const files = await fs.readdir(classesPath);
  const xmlFiles = files.filter(f => f.endsWith('.xml'));

  console.log(`   Classes: ${xmlFiles.length} files`);

  for (const file of xmlFiles) {
    const filePath = path.join(classesPath, file);
    stats.totalFiles++;

    try {
      const classInfo = await parser.parseClassFile(filePath, modelName);
      
      if (!classInfo.success || !classInfo.data) {
        console.error(`   ⚠️  Failed to parse ${file}: ${classInfo.error || 'Unknown error'}`);
        stats.errors++;
        continue;
      }
      
      // Save as JSON
      const outputDir = path.join(OUTPUT_PATH, modelName, 'classes');
      await fs.mkdir(outputDir, { recursive: true });
      const outputFile = path.join(outputDir, `${classInfo.data.name}.json`);
      await fs.writeFile(outputFile, JSON.stringify(classInfo.data, null, 2));

      stats.classes++;
    } catch (error) {
      console.error(`   ❌ Error parsing ${file}:`, error);
      stats.errors++;
    }
  }
}

async function extractTables(
  parser: XppMetadataParser,
  modelPath: string,
  modelName: string,
  stats: ExtractionStats
) {
  const tablesPath = path.join(modelPath, 'AxTable');
  
  try {
    await fs.access(tablesPath);
  } catch {
    return; // No tables in this model
  }

  const files = await fs.readdir(tablesPath);
  const xmlFiles = files.filter(f => f.endsWith('.xml'));

  console.log(`   Tables: ${xmlFiles.length} files`);

  for (const file of xmlFiles) {
    const filePath = path.join(tablesPath, file);
    stats.totalFiles++;

    try {
      const tableInfo = await parser.parseTableFile(filePath, modelName);
      
      if (!tableInfo.success || !tableInfo.data) {
        console.error(`   ⚠️  Failed to parse ${file}: ${tableInfo.error || 'Unknown error'}`);
        stats.errors++;
        continue;
      }
      
      // Save as JSON
      const outputDir = path.join(OUTPUT_PATH, modelName, 'tables');
      await fs.mkdir(outputDir, { recursive: true });
      const outputFile = path.join(outputDir, `${tableInfo.data.name}.json`);
      await fs.writeFile(outputFile, JSON.stringify(tableInfo.data, null, 2));

      stats.tables++;
    } catch (error) {
      console.error(`   ❌ Error parsing ${file}:`, error);
      stats.errors++;
    }
  }
}

async function extractEnums(
  parser: XppMetadataParser,
  modelPath: string,
  modelName: string,
  stats: ExtractionStats
) {
  const enumsPath = path.join(modelPath, 'AxEnum');
  
  try {
    await fs.access(enumsPath);
  } catch {
    return; // No enums in this model
  }

  const files = await fs.readdir(enumsPath);
  const xmlFiles = files.filter(f => f.endsWith('.xml'));

  console.log(`   Enums: ${xmlFiles.length} files`);

  for (const file of xmlFiles) {
    const filePath = path.join(enumsPath, file);
    stats.totalFiles++;

    try {
      // Basic enum parsing (simplified)
      const content = await fs.readFile(filePath, 'utf-8');
      const outputDir = path.join(OUTPUT_PATH, modelName, 'enums');
      await fs.mkdir(outputDir, { recursive: true });
      const outputFile = path.join(outputDir, file.replace('.xml', '.json'));
      await fs.writeFile(outputFile, JSON.stringify({ raw: content }, null, 2));

      stats.enums++;
    } catch (error) {
      console.error(`   ❌ Error parsing ${file}:`, error);
      stats.errors++;
    }
  }
}

async function extractCustomExtensionsOnly() {
  console.log('🔍 X++ Custom Extensions Extraction');
  console.log(`📂 Source: ${CUSTOM_MODELS_PATH || PACKAGES_PATH}`);
  console.log(`📁 Output: ${OUTPUT_PATH}`);
  console.log(`🏷️  Extension Prefix: ${EXTENSION_PREFIX || '(none)'}`);
  console.log(`📋 Models: ${CUSTOM_MODELS.join(', ')}`);
  console.log('');

  const parser = new XppMetadataParser();
  const stats: ExtractionStats = {
    totalFiles: 0,
    classes: 0,
    tables: 0,
    forms: 0,
    enums: 0,
    errors: 0,
  };

  await fs.mkdir(OUTPUT_PATH, { recursive: true });

  const basePath = CUSTOM_MODELS_PATH || PACKAGES_PATH;

  for (const packageName of CUSTOM_MODELS) {
    console.log(`\n📦 Processing custom package: ${packageName}`);
    const packagePath = path.join(basePath, packageName);
    
    try {
      await fs.access(packagePath);
    } catch {
      console.warn(`⚠️  Package path not found: ${packagePath}`);
      continue;
    }

    // Find all models within this package
    const entries = await fs.readdir(packagePath, { withFileTypes: true });
    const modelDirs = entries.filter(e => e.isDirectory()).map(e => e.name);

    for (const modelName of modelDirs) {
      const modelPath = path.join(packagePath, modelName);
      
      // Check if this directory contains X++ metadata
      const hasAxClass = await fs.access(path.join(modelPath, 'AxClass')).then(() => true).catch(() => false);
      const hasAxTable = await fs.access(path.join(modelPath, 'AxTable')).then(() => true).catch(() => false);
      const hasAxEnum = await fs.access(path.join(modelPath, 'AxEnum')).then(() => true).catch(() => false);

      if (!hasAxClass && !hasAxTable && !hasAxEnum) {
        continue;
      }

      console.log(`   📂 Model: ${modelName}`);

      await extractClasses(parser, modelPath, modelName, stats);
      await extractTables(parser, modelPath, modelName, stats);
      await extractEnums(parser, modelPath, modelName, stats);
    }
  }

  console.log('\n✅ Custom extensions extraction complete!');
  console.log(`📊 Statistics:`);
  console.log(`   Total files: ${stats.totalFiles}`);
  console.log(`   Classes: ${stats.classes}`);
  console.log(`   Tables: ${stats.tables}`);
  console.log(`   Enums: ${stats.enums}`);
  console.log(`   Errors: ${stats.errors}`);
}

// Run extraction based on mode
const mode = process.env.EXTRACT_MODE || 'all'; // 'all', 'standard', 'custom'

if (mode === 'custom') {
  extractCustomExtensionsOnly().catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
} else {
  extractMetadata().catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}
