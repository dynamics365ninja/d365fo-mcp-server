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
import { isCustomModel as checkIsCustomModel, getCustomModels } from '../src/utils/modelClassifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGES_PATH = process.env.PACKAGES_PATH || 'C:\\AOSService\\PackagesLocalDirectory';
const OUTPUT_PATH = process.env.METADATA_PATH || './extracted-metadata';
const CUSTOM_MODELS_PATH = process.env.CUSTOM_MODELS_PATH; // Optional: separate path for custom extensions

// Custom models defined in .env - these are YOUR extensions
const CUSTOM_MODELS = getCustomModels();

// Extract mode: 'all' = all models (standard + custom), 'custom' = only custom models, 'standard' = only standard models (all except custom)
const EXTRACT_MODE = process.env.EXTRACT_MODE || 'all';

// Use shared utility for checking custom models
const isCustomModel = checkIsCustomModel;

let MODELS_TO_EXTRACT: string[] = [];
let FILTER_MODE: 'all' | 'custom-only' | 'standard-only' = 'all';

if (EXTRACT_MODE === 'custom') {
  // Extract only custom models
  if (CUSTOM_MODELS.length > 0) {
    MODELS_TO_EXTRACT = CUSTOM_MODELS;
  } else {
    FILTER_MODE = 'custom-only'; // Will filter dynamically based on prefix
  }
} else if (EXTRACT_MODE === 'standard') {
  // Extract all models EXCEPT custom models
  FILTER_MODE = 'standard-only';
} else {
  // Extract all models (standard + custom)
  FILTER_MODE = 'all';
}

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
  console.log(`🎯 Extract Mode: ${EXTRACT_MODE}`);
  
  if (EXTRACT_MODE === 'custom' && CUSTOM_MODELS.length > 0) {
    console.log(`📋 Custom Models (explicit): ${CUSTOM_MODELS.join(', ')}`);
  } else if (EXTRACT_MODE === 'custom') {
    console.log(`📋 Mode: Extract custom models only`);
    if (CUSTOM_MODELS.length > 0) {
      console.log(`📋 Custom Models defined: ${CUSTOM_MODELS.join(', ')}`);
    }
    const extensionPrefix = process.env.EXTENSION_PREFIX;
    if (extensionPrefix) {
      console.log(`📋 Extension Prefix: ${extensionPrefix}`);
    }
  } else if (EXTRACT_MODE === 'standard') {
    console.log(`📋 Mode: Extract standard models (exclude custom)`);
    if (CUSTOM_MODELS.length > 0) {
      console.log(`📋 Custom Models to exclude: ${CUSTOM_MODELS.join(', ')}`);
    }
  } else {
    console.log(`📋 Mode: Extract all models (standard + custom)`);
  }
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

  // Clean up existing output directory
  try {
    await fs.rm(OUTPUT_PATH, { recursive: true, force: true });
    console.log('🗑️  Cleaned up existing metadata directory');
  } catch (error) {
    // Ignore errors if directory doesn't exist
  }

  // Create output directory
  await fs.mkdir(OUTPUT_PATH, { recursive: true });

  // Helper function to find actual directory name (case-insensitive)
  async function findActualDirectoryName(basePath: string, targetName: string): Promise<string | null> {
    try {
      const entries = await fs.readdir(basePath, { withFileTypes: true });
      const found = entries.find(e => 
        (e.isDirectory() || e.isSymbolicLink()) && 
        e.name.toLowerCase() === targetName.toLowerCase()
      );
      return found ? found.name : null;
    } catch {
      return null;
    }
  }

  // Determine which packages to process
  let packagesToProcess: string[] = [];
  
  if (MODELS_TO_EXTRACT.length > 0) {
    // Explicit list provided - resolve to actual names (case-insensitive)
    for (const modelName of MODELS_TO_EXTRACT) {
      const actualName = await findActualDirectoryName(PACKAGES_PATH, modelName);
      if (actualName) {
        packagesToProcess.push(actualName);
      } else {
        console.warn(`⚠️  Model not found: ${modelName}`);
      }
    }
  } else {
    // Scan all packages (including symbolic links)
    const allPackages = await fs.readdir(PACKAGES_PATH, { withFileTypes: true });
    const allPackageNames = allPackages
      .filter(e => e.isDirectory() || e.isSymbolicLink())
      .map(e => e.name);
    
    // Apply filtering based on mode
    if (FILTER_MODE === 'custom-only') {
      // Keep only custom models (defined in CUSTOM_MODELS or with EXTENSION_PREFIX)
      packagesToProcess = allPackageNames.filter(pkg => isCustomModel(pkg));
      console.log(`📦 Found ${packagesToProcess.length} custom packages to process (${allPackageNames.length - packagesToProcess.length} standard models excluded)`);
    } else if (FILTER_MODE === 'standard-only') {
      // Keep only standard models (exclude custom)
      packagesToProcess = allPackageNames.filter(pkg => !isCustomModel(pkg));
      console.log(`📦 Found ${packagesToProcess.length} standard packages to process (${allPackageNames.length - packagesToProcess.length} custom models excluded)`);
    } else {
      // Process all packages
      packagesToProcess = allPackageNames;
      console.log(`📦 Found ${packagesToProcess.length} packages to process`);
    }
  }

  // Process each package/model
  for (const packageName of packagesToProcess) {
    console.log(`\n📦 Processing package: ${packageName}`);

    const packagePath = path.join(PACKAGES_PATH, packageName);
    
    try {
      await fs.access(packagePath);
    } catch {
      console.warn(`⚠️  Package path not found: ${packagePath}`);
      continue;
    }

    // Find all models within this package (including symbolic links)
    const entries = await fs.readdir(packagePath, { withFileTypes: true });
    const modelDirs = entries.filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name);

    for (const modelName of modelDirs) {
      // Skip FormAdaptor models
      if (modelName.endsWith('FormAdaptor')) {
        console.log(`   ⏭️  Skipping FormAdaptor model: ${modelName}`);
        continue;
      }

      // Apply model-level filtering
      if (FILTER_MODE === 'custom-only' && !isCustomModel(modelName)) {
        console.log(`   ⏭️  Skipping standard model: ${modelName}`);
        continue;
      }
      if (FILTER_MODE === 'standard-only' && isCustomModel(modelName)) {
        console.log(`   ⏭️  Skipping custom model: ${modelName}`);
        continue;
      }

      const modelPath = path.join(packagePath, modelName);
      
      // Check if this directory contains X++ metadata (has AxClass, AxTable, etc.)
      // Support both uppercase and lowercase directory names (Linux case-sensitivity)
      const hasAxClass = await fs.access(path.join(modelPath, 'AxClass')).then(() => true)
        .catch(() => fs.access(path.join(modelPath, 'axclass')).then(() => true).catch(() => false));
      const hasAxTable = await fs.access(path.join(modelPath, 'AxTable')).then(() => true)
        .catch(() => fs.access(path.join(modelPath, 'axtable')).then(() => true).catch(() => false));
      const hasAxEnum = await fs.access(path.join(modelPath, 'AxEnum')).then(() => true)
        .catch(() => fs.access(path.join(modelPath, 'axenum')).then(() => true).catch(() => false));

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
  // Support both uppercase and lowercase directory names (Linux case-sensitivity)
  let classesPath = path.join(modelPath, 'AxClass');
  
  try {
    await fs.access(classesPath);
  } catch {
    // Try lowercase
    classesPath = path.join(modelPath, 'axclass');
    try {
      await fs.access(classesPath);
    } catch {
      return; // No classes in this model
    }
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
  // Support both uppercase and lowercase directory names (Linux case-sensitivity)
  let tablesPath = path.join(modelPath, 'AxTable');
  
  try {
    await fs.access(tablesPath);
  } catch {
    // Try lowercase
    tablesPath = path.join(modelPath, 'axtable');
    try {
      await fs.access(tablesPath);
    } catch {
      return; // No tables in this model
    }
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
  // Support both uppercase and lowercase directory names (Linux case-sensitivity)
  let enumsPath = path.join(modelPath, 'AxEnum');
  
  try {
    await fs.access(enumsPath);
  } catch {
    // Try lowercase
    enumsPath = path.join(modelPath, 'axenum');
    try {
      await fs.access(enumsPath);
    } catch {
      return; // No enums in this model
    }
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

// Run extraction
extractMetadata().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
