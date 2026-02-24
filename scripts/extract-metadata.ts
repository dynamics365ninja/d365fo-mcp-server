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
import { XppConfigProvider } from '../src/utils/xppConfigProvider.js';

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
    // Check if any patterns contain wildcards
    const hasWildcards = CUSTOM_MODELS.some(pattern => pattern.includes('*'));
    if (hasWildcards) {
      // Will expand wildcards dynamically by scanning packages
      FILTER_MODE = 'custom-only';
    } else {
      // Exact model names - use directly
      MODELS_TO_EXTRACT = CUSTOM_MODELS;
    }
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
  queries: number;
  views: number;
  dataEntities: number;
  enums: number;
  edts: number;
  errors: number;
}

interface ModelWorkItem {
  packageName: string;
  modelName: string;
  modelPath: string;
  expectedXmlFiles: number;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${formatCount(ms)}ms`;
  if (ms < 60000) return `${formatDecimal(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = (ms % 60000) / 1000;
  return `${formatCount(minutes)}m ${formatDecimal(seconds)}s`;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatDecimal(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPercent(current: number, total: number): string {
  if (total <= 0) return '0.00%';
  return `${formatDecimal((current / total) * 100)}%`;
}

async function countXmlFilesInDirectory(dirPath: string): Promise<number> {
  if (!fsSync.existsSync(dirPath)) {
    return 0;
  }

  const files = await fs.readdir(dirPath);
  return files.filter(file => file.endsWith('.xml')).length;
}

async function countModelXmlFiles(modelPath: string): Promise<number> {
  let total = 0;
  const sourceDirs = [
    'AxClass', 'axclass',
    'AxTable', 'axtable',
    'AxForm', 'axform',
    'AxQuery', 'axquery',
    'AxView', 'axview',
    'AxDataEntityView', 'axdataentityview',
    'AxEnum', 'axenum',
    'AxEdt', 'axedt',
  ];

  for (const sourceDir of sourceDirs) {
    total += await countXmlFilesInDirectory(path.join(modelPath, sourceDir));
  }

  return total;
}

async function extractMetadata() {
  const extractionStart = Date.now();
  console.log('🔍 X++ Metadata Extraction');

  // Build list of metadata root paths to scan
  // Priority: XPP config auto-detection > PACKAGES_PATH fallback
  const metadataRoots: string[] = [];
  let customRoot: string | null = null; // UDE: path whose models are all "custom"
  const devEnvType = process.env.DEV_ENVIRONMENT_TYPE || 'auto';
  if (devEnvType !== 'traditional') {
    const xppProvider = new XppConfigProvider();
    const configName = process.env.XPP_CONFIG_NAME || undefined;
    const xppConfig = await xppProvider.getActiveConfig(configName);
    if (xppConfig) {
      console.log(`[UDE] XPP config: ${xppConfig.configName} v${xppConfig.version}`);
      customRoot = xppConfig.customPackagesPath;
      metadataRoots.push(xppConfig.customPackagesPath);
      console.log(`[UDE] Custom packages path: ${xppConfig.customPackagesPath}`);
      metadataRoots.push(xppConfig.microsoftPackagesPath);
      console.log(`[UDE] Microsoft packages path: ${xppConfig.microsoftPackagesPath}`);
    }
  }
  // Fallback: traditional single path
  if (metadataRoots.length === 0) {
    metadataRoots.push(PACKAGES_PATH);
  }

  console.log(`📂 Source: ${metadataRoots.join(', ')}`);
  console.log(`📁 Output: ${OUTPUT_PATH}`);
  console.log(`🎯 Extract Mode: ${EXTRACT_MODE}`);
  
  if (EXTRACT_MODE === 'custom') {
    if (MODELS_TO_EXTRACT.length > 0) {
      console.log(`📋 Custom Models (explicit): ${MODELS_TO_EXTRACT.join(', ')}`);
    } else {
      console.log(`📋 Mode: Extract custom models only`);
      if (CUSTOM_MODELS.length > 0) {
        console.log(`📋 Custom Model patterns: ${CUSTOM_MODELS.join(', ')}`);
      }
      const extensionPrefix = process.env.EXTENSION_PREFIX;
      if (extensionPrefix) {
        console.log(`📋 Extension Prefix: ${extensionPrefix}`);
      }
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
  console.log(`ℹ️  Note: AxLabelFile labels (.label.txt) are NOT extracted here.`);
  console.log(`   Labels are indexed directly from PACKAGES_PATH during 'npm run build-database'.`);
  console.log('');

  const parser = new XppMetadataParser();
  const stats: ExtractionStats = {
    totalFiles: 0,
    classes: 0,
    tables: 0,
    forms: 0,
    queries: 0,
    views: 0,
    dataEntities: 0,
    enums: 0,
    edts: 0,
    errors: 0,
  };

  // Clean up existing output directory ONLY for 'all' mode
  // For 'custom' and 'standard' modes, preserve existing metadata (e.g., downloaded from blob)
  if (EXTRACT_MODE === 'all') {
    try {
      await fs.rm(OUTPUT_PATH, { recursive: true, force: true });
      console.log('🗑️  Cleaned up existing metadata directory');
    } catch (error) {
      // Ignore errors if directory doesn't exist
    }
  } else {
    console.log(`ℹ️  Preserving existing metadata (mode: ${EXTRACT_MODE})`);
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

  // Determine which packages to process (with their root paths)
  // Each entry maps package name -> root path it was found in
  const packageRootMap: Map<string, string> = new Map();

  if (MODELS_TO_EXTRACT.length > 0) {
    // Explicit list provided - resolve to actual names (case-insensitive) across all roots
    for (const root of metadataRoots) {
      for (const modelName of MODELS_TO_EXTRACT) {
        const actualName = await findActualDirectoryName(root, modelName);
        if (actualName && !packageRootMap.has(actualName)) {
          packageRootMap.set(actualName, root);
        }
      }
    }
    // Warn about models not found in any root
    for (const modelName of MODELS_TO_EXTRACT) {
      const found = [...packageRootMap.keys()].some(
        pkg => pkg.toLowerCase() === modelName.toLowerCase()
      );
      if (!found) {
        console.warn(`⚠️  Model not found: ${modelName}`);
      }
    }
  } else {
    // Scan all packages (including symbolic links) across all roots
    let totalAllPackageNames = 0;
    for (const root of metadataRoots) {
      const allPackages = await fs.readdir(root, { withFileTypes: true });
      const allPackageNames = allPackages
        .filter(e => e.isDirectory() || e.isSymbolicLink())
        .map(e => e.name);
      totalAllPackageNames += allPackageNames.length;

      // Apply filtering based on mode
      // In UDE mode, use path-based detection: customRoot = custom, everything else = standard
      // Falls back to CUSTOM_MODELS / EXTENSION_PREFIX for traditional environments
      let filteredPackages: string[];
      if (FILTER_MODE === 'custom-only') {
        if (customRoot) {
          filteredPackages = root === customRoot ? allPackageNames : [];
        } else {
          filteredPackages = allPackageNames.filter(pkg => isCustomModel(pkg));
        }
      } else if (FILTER_MODE === 'standard-only') {
        if (customRoot) {
          filteredPackages = root === customRoot ? [] : allPackageNames;
        } else {
          filteredPackages = allPackageNames.filter(pkg => !isCustomModel(pkg));
        }
      } else {
        filteredPackages = allPackageNames;
      }

      for (const pkg of filteredPackages) {
        if (!packageRootMap.has(pkg)) {
          packageRootMap.set(pkg, root);
        }
      }
    }

    const packagesToProcessCount = packageRootMap.size;
    if (FILTER_MODE === 'custom-only') {
      console.log(`📦 Found ${formatCount(packagesToProcessCount)} custom packages to process (${formatCount(totalAllPackageNames - packagesToProcessCount)} standard models excluded)`);
    } else if (FILTER_MODE === 'standard-only') {
      console.log(`📦 Found ${formatCount(packagesToProcessCount)} standard packages to process (${formatCount(totalAllPackageNames - packagesToProcessCount)} custom models excluded)`);
    } else {
      console.log(`📦 Found ${formatCount(packagesToProcessCount)} packages to process`);
    }
  }

  const modelWorkItems: ModelWorkItem[] = [];

  // Build model worklist first to enable accurate progress percentages
  for (const [packageName, rootPath] of packageRootMap) {
    const packagePath = path.join(rootPath, packageName);

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
      const hasAxEdt = await fs.access(path.join(modelPath, 'AxEdt')).then(() => true)
        .catch(() => fs.access(path.join(modelPath, 'axedt')).then(() => true).catch(() => false));
      const hasAxView = await fs.access(path.join(modelPath, 'AxView')).then(() => true)
        .catch(() => fs.access(path.join(modelPath, 'axview')).then(() => true).catch(() => false));
      const hasAxDataEntityView = await fs.access(path.join(modelPath, 'AxDataEntityView')).then(() => true)
        .catch(() => fs.access(path.join(modelPath, 'axdataentityview')).then(() => true).catch(() => false));

      if (!hasAxClass && !hasAxTable && !hasAxEnum && !hasAxEdt && !hasAxView && !hasAxDataEntityView) {
        // Skip directories that don't contain X++ metadata
        continue;
      }

      const expectedXmlFiles = await countModelXmlFiles(modelPath);
      modelWorkItems.push({ packageName, modelName, modelPath, expectedXmlFiles });
    }
  }

  const totalModels = modelWorkItems.length;
  const totalExpectedFiles = modelWorkItems.reduce((sum, item) => sum + item.expectedXmlFiles, 0);
  console.log(`📍 Planned work: ${formatCount(totalModels)} models, ${formatCount(totalExpectedFiles)} XML files`);

  // Process each model with progress tracking
  let currentPackage = '';
  let processedModels = 0;
  let cumulativeModelDuration = 0;

  for (const modelItem of modelWorkItems) {
    if (currentPackage !== modelItem.packageName) {
      currentPackage = modelItem.packageName;
      console.log(`\n📦 Processing package: ${currentPackage} | Model progress: ${formatPercent(processedModels, totalModels)} (${formatCount(processedModels)}/${formatCount(totalModels)})`);
    }

    const modelStart = Date.now();
    console.log(`   📂 Model: ${modelItem.modelName} (${formatCount(modelItem.expectedXmlFiles)} XML files)`);

    // Extract classes
    await extractClasses(parser, modelItem.modelPath, modelItem.modelName, stats);

    // Extract tables
    await extractTables(parser, modelItem.modelPath, modelItem.modelName, stats);

    // Extract forms
    await extractForms(parser, modelItem.modelPath, modelItem.modelName, stats);

    // Extract queries
    await extractQueries(parser, modelItem.modelPath, modelItem.modelName, stats);

    // Extract views
    await extractViews(parser, modelItem.modelPath, modelItem.modelName, stats);

    // Extract enums
    await extractEnums(parser, modelItem.modelPath, modelItem.modelName, stats);

    // Extract EDTs
    await extractEdts(parser, modelItem.modelPath, modelItem.modelName, stats);

    const modelDuration = Date.now() - modelStart;
    cumulativeModelDuration += modelDuration;
    processedModels++;

    const elapsed = Date.now() - extractionStart;
    const avgModelDuration = processedModels > 0 ? cumulativeModelDuration / processedModels : 0;
    const avgFileDuration = stats.totalFiles > 0 ? elapsed / stats.totalFiles : 0;
    console.log(
      `   ⏱️  Model done in ${formatDuration(modelDuration)} | Progress: ${formatPercent(processedModels, totalModels)} (${formatCount(processedModels)}/${formatCount(totalModels)} models), ${formatPercent(stats.totalFiles, totalExpectedFiles)} (${formatCount(stats.totalFiles)}/${formatCount(totalExpectedFiles)} files) | Avg: ${formatDuration(avgModelDuration)}/model, ${formatDuration(avgFileDuration)}/file`
    );
  }

  console.log('\n✅ Extraction complete!');
  const totalDuration = Date.now() - extractionStart;
  const averagePerFile = stats.totalFiles > 0 ? totalDuration / stats.totalFiles : 0;
  const averagePerModel = processedModels > 0 ? cumulativeModelDuration / processedModels : 0;
  console.log(`⏱️  Duration: ${formatDuration(totalDuration)} (avg ${formatDuration(averagePerModel)}/model, ${formatDuration(averagePerFile)}/file)`);
  console.log(`📊 Statistics:`);
  console.log(`   Total files: ${formatCount(stats.totalFiles)}`);
  console.log(`   Classes: ${formatCount(stats.classes)}`);
  console.log(`   Tables: ${formatCount(stats.tables)}`);
  console.log(`   Forms: ${formatCount(stats.forms)}`);
  console.log(`   Queries: ${formatCount(stats.queries)}`);
  console.log(`   Views: ${formatCount(stats.views)}`);
  console.log(`   Data entities: ${formatCount(stats.dataEntities)}`);
  console.log(`   Enums: ${formatCount(stats.enums)}`);
  console.log(`   EDTs: ${formatCount(stats.edts)}`);
  console.log(`   Errors: ${formatCount(stats.errors)}`);
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

  console.log(`   Classes: ${formatCount(xmlFiles.length)} files`);

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

  console.log(`   Tables: ${formatCount(xmlFiles.length)} files`);

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

async function extractForms(
  parser: XppMetadataParser,
  modelPath: string,
  modelName: string,
  stats: ExtractionStats
) {
  // Support both uppercase and lowercase directory names (Linux case-sensitivity)
  let formsPath = path.join(modelPath, 'AxForm');
  
  try {
    await fs.access(formsPath);
  } catch {
    // Try lowercase
    formsPath = path.join(modelPath, 'axform');
    try {
      await fs.access(formsPath);
    } catch {
      return; // No forms in this model
    }
  }

  const files = await fs.readdir(formsPath);
  const xmlFiles = files.filter(f => f.endsWith('.xml'));

  console.log(`   Forms: ${formatCount(xmlFiles.length)} files`);

  for (const file of xmlFiles) {
    const filePath = path.join(formsPath, file);
    stats.totalFiles++;

    try {
      // Basic form parsing (name extraction)
      const formName = path.basename(file, '.xml');
      const formInfo = {
        name: formName,
        model: modelName,
        sourcePath: filePath,
        type: 'form'
      };
      
      const outputDir = path.join(OUTPUT_PATH, modelName, 'forms');
      await fs.mkdir(outputDir, { recursive: true });
      const outputFile = path.join(outputDir, `${formName}.json`);
      await fs.writeFile(outputFile, JSON.stringify(formInfo, null, 2));

      stats.forms++;
    } catch (error) {
      console.error(`   ❌ Error parsing ${file}:`, error);
      stats.errors++;
    }
  }

}

async function extractQueries(
  parser: XppMetadataParser,
  modelPath: string,
  modelName: string,
  stats: ExtractionStats
) {
  // Support both uppercase and lowercase directory names (Linux case-sensitivity)
  let queriesPath = path.join(modelPath, 'AxQuery');
  
  try {
    await fs.access(queriesPath);
  } catch {
    // Try lowercase
    queriesPath = path.join(modelPath, 'axquery');
    try {
      await fs.access(queriesPath);
    } catch {
      return; // No queries in this model
    }
  }

  const files = await fs.readdir(queriesPath);
  const xmlFiles = files.filter(f => f.endsWith('.xml'));

  console.log(`   Queries: ${formatCount(xmlFiles.length)} files`);

  for (const file of xmlFiles) {
    const filePath = path.join(queriesPath, file);
    stats.totalFiles++;

    try {
      // Basic query parsing (name extraction)
      const queryName = path.basename(file, '.xml');
      const queryInfo = {
        name: queryName,
        model: modelName,
        sourcePath: filePath,
        type: 'query'
      };
      
      const outputDir = path.join(OUTPUT_PATH, modelName, 'queries');
      await fs.mkdir(outputDir, { recursive: true });
      const outputFile = path.join(outputDir, `${queryName}.json`);
      await fs.writeFile(outputFile, JSON.stringify(queryInfo, null, 2));

      stats.queries++;
    } catch (error) {
      console.error(`   ❌ Error parsing ${file}:`, error);
      stats.errors++;
    }
  }

}

async function extractViews(
  parser: XppMetadataParser,
  modelPath: string,
  modelName: string,
  stats: ExtractionStats
) {
  const sourceDirs: string[] = [];

  for (const dirName of ['AxView', 'axview', 'AxDataEntityView', 'axdataentityview']) {
    const candidate = path.join(modelPath, dirName);
    if (fsSync.existsSync(candidate)) {
      sourceDirs.push(candidate);
    }
  }

  if (sourceDirs.length === 0) {
    return;
  }

  let totalXmlFiles = 0;

  for (const sourceDir of sourceDirs) {
    const files = await fs.readdir(sourceDir);
    const xmlFiles = files.filter(f => f.endsWith('.xml'));
    totalXmlFiles += xmlFiles.length;

    for (const file of xmlFiles) {
      const filePath = path.join(sourceDir, file);
      stats.totalFiles++;

      try {
        const viewInfo = await parser.parseViewFile(filePath, modelName);

        if (!viewInfo.success || !viewInfo.data) {
          console.error(`   ⚠️  Failed to parse ${file}: ${viewInfo.error || 'Unknown error'}`);
          stats.errors++;
          continue;
        }

        const outputDir = path.join(OUTPUT_PATH, modelName, 'views');
        await fs.mkdir(outputDir, { recursive: true });
        const outputFile = path.join(outputDir, `${viewInfo.data.name}.json`);
        await fs.writeFile(outputFile, JSON.stringify(viewInfo.data, null, 2));

        if (viewInfo.data.type === 'data-entity') {
          stats.dataEntities++;
        } else {
          stats.views++;
        }
      } catch (error) {
        console.error(`   ❌ Error parsing ${file}:`, error);
        stats.errors++;
      }
    }
  }

  console.log(`   Views/Data entities: ${formatCount(totalXmlFiles)} files`);
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

  console.log(`   Enums: ${formatCount(xmlFiles.length)} files`);

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

async function extractEdts(
  parser: XppMetadataParser,
  modelPath: string,
  modelName: string,
  stats: ExtractionStats
) {
  // Support both uppercase and lowercase directory names (Linux case-sensitivity)
  let edtsPath = path.join(modelPath, 'AxEdt');

  try {
    await fs.access(edtsPath);
  } catch {
    // Try lowercase
    edtsPath = path.join(modelPath, 'axedt');
    try {
      await fs.access(edtsPath);
    } catch {
      return; // No EDTs in this model
    }
  }

  const files = await fs.readdir(edtsPath);
  const xmlFiles = files.filter(f => f.endsWith('.xml'));

  console.log(`   EDTs: ${formatCount(xmlFiles.length)} files`);

  for (const file of xmlFiles) {
    const filePath = path.join(edtsPath, file);
    stats.totalFiles++;

    try {
      // Store raw XML (same approach as enums)
      const content = await fs.readFile(filePath, 'utf-8');
      const edtName = path.basename(file, '.xml');
      const outputDir = path.join(OUTPUT_PATH, modelName, 'edts');
      await fs.mkdir(outputDir, { recursive: true });
      const outputFile = path.join(outputDir, `${edtName}.json`);
      await fs.writeFile(outputFile, JSON.stringify({ name: edtName, sourcePath: filePath, raw: content }, null, 2));

      stats.edts++;
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
