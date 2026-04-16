/**
 * Metadata Extraction Script
 * Extracts X++ metadata from D365 F&O PackagesLocalDirectory
 */

import { loadEnv } from '../src/utils/loadEnv.js';
loadEnv(import.meta.url);
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { XppMetadataParser } from '../src/metadata/xmlParser.js';
import { isCustomModel as checkIsCustomModel, getCustomModels } from '../src/utils/modelClassifier.js';
import { XppConfigProvider } from '../src/utils/xppConfigProvider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGES_PATH = process.env.D365FO_PACKAGE_PATH || 'C:\\AOSService\\PackagesLocalDirectory';
const OUTPUT_PATH = process.env.METADATA_PATH || './extracted-metadata';
const CUSTOM_MODELS_PATH = process.env.CUSTOM_MODELS_PATH; // Optional: separate path for custom extensions

// Custom models defined in .env - these are YOUR extensions
const CUSTOM_MODELS = getCustomModels();

// Extract mode: 'all' = all models (standard + custom), 'custom' = only custom models, 'standard' = only standard models (all except custom)
const EXTRACT_MODE = process.env.EXTRACT_MODE || 'all';

// Use shared utility for checking custom models
const isCustomModel = checkIsCustomModel;

/**
 * Strip machine-specific prefix so that sourcePath stored in JSON is relative
 * to PackagesLocalDirectory (portable across CI agents and local machines).
 * e.g. "/home/vsts/work/1/PackagesLocalDirectory/App/App/AxClass/X.xml"
 *   => "App/App/AxClass/X.xml"
 */
function normalizeSourcePath(p: string): string {
  const m = /[/\\]PackagesLocalDirectory[/\\](.+)$/.exec(p);
  return m ? m[1].replace(/\\/g, '/') : p;
}

/** JSON.stringify replacer that normalises all sourcePath values. */
function sourcePathReplacer(key: string, value: unknown): unknown {
  return key === 'sourcePath' && typeof value === 'string'
    ? normalizeSourcePath(value)
    : value;
}

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
  reports: number;
  securityPrivileges: number;
  securityDuties: number;
  securityRoles: number;
  menuItemDisplays: number;
  menuItemActions: number;
  menuItemOutputs: number;
  tableExtensions: number;
  classExtensions: number;
  formExtensions: number;
  enumExtensions: number;
  edtExtensions: number;
  dataEntityExtensions: number;
  errors: number;
}

interface ModelWorkItem {
  packageName: string;
  modelName: string;
  modelPath: string;
  expectedXmlFiles: number;
  /** True for custom/ISV models whose paths should be normalised to relative form. */
  isCustom: boolean;
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
    'AxReport', 'axreport',
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
    reports: 0,
    securityPrivileges: 0,
    securityDuties: 0,
    securityRoles: 0,
    menuItemDisplays: 0,
    menuItemActions: 0,
    menuItemOutputs: 0,
    tableExtensions: 0,
    classExtensions: 0,
    formExtensions: 0,
    enumExtensions: 0,
    edtExtensions: 0,
    dataEntityExtensions: 0,
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
      // In UDE mode: custom iff the package lives under customRoot.
      // In traditional mode: fall back to name-based detection.
      const isCustom = customRoot ? rootPath === customRoot : isCustomModel(modelName);
      modelWorkItems.push({ packageName, modelName, modelPath, expectedXmlFiles, isCustom });
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

    const { modelPath, modelName, isCustom } = modelItem;

    // Extract classes
    await extractClasses(parser, modelPath, modelName, stats, isCustom);

    // Extract tables
    await extractTables(parser, modelPath, modelName, stats, isCustom);

    // Extract forms
    await extractForms(parser, modelPath, modelName, stats, isCustom);

    // Extract queries
    await extractQueries(parser, modelPath, modelName, stats, isCustom);

    // Extract views
    await extractViews(parser, modelPath, modelName, stats, isCustom);

    // Extract enums
    await extractEnums(parser, modelPath, modelName, stats, isCustom);

    // Extract EDTs
    await extractEdts(parser, modelPath, modelName, stats, isCustom);

    // Extract Reports
    await extractReports(modelPath, modelName, stats, isCustom);

    // Extract security objects
    await extractSecurityPrivileges(parser, modelPath, modelName, stats, isCustom);
    await extractSecurityDuties(parser, modelPath, modelName, stats, isCustom);
    await extractSecurityRoles(parser, modelPath, modelName, stats, isCustom);

    // Extract menu items
    await extractMenuItems(parser, modelPath, modelName, 'display', stats, isCustom);
    await extractMenuItems(parser, modelPath, modelName, 'action', stats, isCustom);
    await extractMenuItems(parser, modelPath, modelName, 'output', stats, isCustom);

    // Extract extensions
    await extractExtensions(parser, modelPath, modelName, 'table-extension', 'AxTableExtension', stats, isCustom);
    await extractExtensions(parser, modelPath, modelName, 'class-extension', 'AxClassExtension', stats, isCustom);
    await extractExtensions(parser, modelPath, modelName, 'form-extension', 'AxFormExtension', stats, isCustom);
    await extractExtensions(parser, modelPath, modelName, 'enum-extension', 'AxEnumExtension', stats, isCustom);
    await extractExtensions(parser, modelPath, modelName, 'edt-extension', 'AxEdtExtension', stats, isCustom);
    await extractExtensions(parser, modelPath, modelName, 'data-entity-extension', 'AxDataEntityViewExtension', stats, isCustom);

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
  console.log(`   Reports: ${formatCount(stats.reports)}`);
  console.log(`   Security privileges: ${formatCount(stats.securityPrivileges)}`);
  console.log(`   Security duties: ${formatCount(stats.securityDuties)}`);
  console.log(`   Security roles: ${formatCount(stats.securityRoles)}`);
  console.log(`   Menu items (display): ${formatCount(stats.menuItemDisplays)}`);
  console.log(`   Menu items (action): ${formatCount(stats.menuItemActions)}`);
  console.log(`   Menu items (output): ${formatCount(stats.menuItemOutputs)}`);
  console.log(`   Table extensions: ${formatCount(stats.tableExtensions)}`);
  console.log(`   Class extensions: ${formatCount(stats.classExtensions)}`);
  console.log(`   Form extensions: ${formatCount(stats.formExtensions)}`);
  console.log(`   Enum extensions: ${formatCount(stats.enumExtensions)}`);
  console.log(`   EDT extensions: ${formatCount(stats.edtExtensions)}`);
  console.log(`   Data entity extensions: ${formatCount(stats.dataEntityExtensions)}`);
  console.log(`   Errors: ${formatCount(stats.errors)}`);
}

async function extractClasses(
  parser: XppMetadataParser,
  modelPath: string,
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
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
      await fs.writeFile(outputFile, JSON.stringify(classInfo.data, isCustom ? sourcePathReplacer : undefined, 2));

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
  stats: ExtractionStats,
  isCustom = false
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
      await fs.writeFile(outputFile, JSON.stringify(tableInfo.data, isCustom ? sourcePathReplacer : undefined, 2));

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
  stats: ExtractionStats,
  isCustom = false
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
      // Parse full form structure using new parser
      const result = await parser.parseFormFile(filePath, modelName);
      
      if (!result.success || !result.data) {
        console.error(`   ❌ Error parsing ${file}: ${result.error || 'Unknown error'}`);
        stats.errors++;
        continue;
      }
      
      const formInfo = result.data;
      
      const outputDir = path.join(OUTPUT_PATH, modelName, 'forms');
      await fs.mkdir(outputDir, { recursive: true });
      const outputFile = path.join(outputDir, `${formInfo.name}.json`);
      await fs.writeFile(outputFile, JSON.stringify(formInfo, isCustom ? sourcePathReplacer : undefined, 2));

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
  stats: ExtractionStats,
  isCustom = false
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
      await fs.writeFile(outputFile, JSON.stringify(queryInfo, isCustom ? sourcePathReplacer : undefined, 2));

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
  stats: ExtractionStats,
  isCustom = false
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
        await fs.writeFile(outputFile, JSON.stringify(viewInfo.data, isCustom ? sourcePathReplacer : undefined, 2));

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
  stats: ExtractionStats,
  isCustom = false
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
      await fs.writeFile(outputFile, JSON.stringify({ raw: content }, isCustom ? sourcePathReplacer : undefined, 2));

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
  stats: ExtractionStats,
  isCustom = false
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
      // Parse full EDT structure using new parser
      const result = await parser.parseEdtFile(filePath, modelName);
      
      if (!result.success || !result.data) {
        console.error(`   ❌ Error parsing ${file}: ${result.error || 'Unknown error'}`);
        stats.errors++;
        continue;
      }
      
      const edtInfo = result.data;
      
      const outputDir = path.join(OUTPUT_PATH, modelName, 'edts');
      await fs.mkdir(outputDir, { recursive: true });
      const outputFile = path.join(outputDir, `${edtInfo.name}.json`);
      await fs.writeFile(outputFile, JSON.stringify(edtInfo, isCustom ? sourcePathReplacer : undefined, 2));

      stats.edts++;
    } catch (error) {
      console.error(`   ❌ Error parsing ${file}:`, error);
      stats.errors++;
    }
  }

}

/**
 * Extract AxReport metadata.
 * Reports are stored as lightweight stubs — just name + file_path.
 * The get_report_info tool reads the live XML on demand rather than
 * caching a full parse, so we only need enough for the symbol DB entry.
 */
async function extractReports(
  modelPath: string,
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
) {
  // Support both uppercase and lowercase directory names (Linux case-sensitivity)
  let reportsPath = path.join(modelPath, 'AxReport');

  try {
    await fs.access(reportsPath);
  } catch {
    // Try lowercase
    reportsPath = path.join(modelPath, 'axreport');
    try {
      await fs.access(reportsPath);
    } catch {
      return; // No reports in this model
    }
  }

  const files = await fs.readdir(reportsPath);
  const xmlFiles = files.filter(f => f.endsWith('.xml'));

  if (xmlFiles.length === 0) return;
  console.log(`   Reports: ${formatCount(xmlFiles.length)} files`);

  const outputDir = path.join(OUTPUT_PATH, modelName, 'reports');
  await fs.mkdir(outputDir, { recursive: true });

  for (const file of xmlFiles) {
    const filePath = path.join(reportsPath, file);
    stats.totalFiles++;

    try {
      const name = file.replace('.xml', '');
      const stub = {
        name,
        type: 'report',
        model: modelName,
        // sourcePath lets reportInfo.ts read the live XML via the JSON metadata wrapper
        sourcePath: filePath,
      };

      const outputFile = path.join(outputDir, `${name}.json`);
      await fs.writeFile(outputFile, JSON.stringify(stub, isCustom ? sourcePathReplacer : undefined, 2));

      stats.reports++;
    } catch (error) {
      console.error(`   ❌ Error extracting report ${file}:`, error);
      stats.errors++;
    }
  }
}

async function extractSecurityPrivileges(
  parser: XppMetadataParser,
  modelPath: string,
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
) {
  let dirPath = path.join(modelPath, 'AxSecurityPrivilege');
  try { await fs.access(dirPath); } catch {
    dirPath = path.join(modelPath, 'axsecurityprivilege');
    try { await fs.access(dirPath); } catch { return; }
  }
  const files = (await fs.readdir(dirPath)).filter(f => f.endsWith('.xml'));
  if (files.length === 0) return;
  console.log(`   Security privileges: ${formatCount(files.length)} files`);
  const outputDir = path.join(OUTPUT_PATH, modelName, 'security-privileges');
  await fs.mkdir(outputDir, { recursive: true });
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    stats.totalFiles++;
    try {
      const result = await parser.parseSecurityPrivilegeFile(filePath);
      if (!result.success || !result.data) { stats.errors++; continue; }
      const outputFile = path.join(outputDir, `${result.data.name}.json`);
      await fs.writeFile(outputFile, JSON.stringify({ ...result.data, model: modelName, type: 'security-privilege' }, isCustom ? sourcePathReplacer : undefined, 2));
      stats.securityPrivileges++;
    } catch (error) {
      console.error(`   ❌ Error extracting security privilege ${file}:`, error);
      stats.errors++;
    }
  }
}

async function extractSecurityDuties(
  parser: XppMetadataParser,
  modelPath: string,
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
) {
  let dirPath = path.join(modelPath, 'AxSecurityDuty');
  try { await fs.access(dirPath); } catch {
    dirPath = path.join(modelPath, 'axsecurityduty');
    try { await fs.access(dirPath); } catch { return; }
  }
  const files = (await fs.readdir(dirPath)).filter(f => f.endsWith('.xml'));
  if (files.length === 0) return;
  console.log(`   Security duties: ${formatCount(files.length)} files`);
  const outputDir = path.join(OUTPUT_PATH, modelName, 'security-duties');
  await fs.mkdir(outputDir, { recursive: true });
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    stats.totalFiles++;
    try {
      const result = await parser.parseSecurityDutyFile(filePath);
      if (!result.success || !result.data) { stats.errors++; continue; }
      const outputFile = path.join(outputDir, `${result.data.name}.json`);
      await fs.writeFile(outputFile, JSON.stringify({ ...result.data, model: modelName, type: 'security-duty' }, isCustom ? sourcePathReplacer : undefined, 2));
      stats.securityDuties++;
    } catch (error) {
      console.error(`   ❌ Error extracting security duty ${file}:`, error);
      stats.errors++;
    }
  }
}

async function extractSecurityRoles(
  parser: XppMetadataParser,
  modelPath: string,
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
) {
  let dirPath = path.join(modelPath, 'AxSecurityRole');
  try { await fs.access(dirPath); } catch {
    dirPath = path.join(modelPath, 'axsecurityrole');
    try { await fs.access(dirPath); } catch { return; }
  }
  const files = (await fs.readdir(dirPath)).filter(f => f.endsWith('.xml'));
  if (files.length === 0) return;
  console.log(`   Security roles: ${formatCount(files.length)} files`);
  const outputDir = path.join(OUTPUT_PATH, modelName, 'security-roles');
  await fs.mkdir(outputDir, { recursive: true });
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    stats.totalFiles++;
    try {
      const result = await parser.parseSecurityRoleFile(filePath);
      if (!result.success || !result.data) { stats.errors++; continue; }
      const outputFile = path.join(outputDir, `${result.data.name}.json`);
      await fs.writeFile(outputFile, JSON.stringify({ ...result.data, model: modelName, type: 'security-role' }, isCustom ? sourcePathReplacer : undefined, 2));
      stats.securityRoles++;
    } catch (error) {
      console.error(`   ❌ Error extracting security role ${file}:`, error);
      stats.errors++;
    }
  }
}

async function extractMenuItems(
  parser: XppMetadataParser,
  modelPath: string,
  modelName: string,
  itemType: 'display' | 'action' | 'output',
  stats: ExtractionStats,
  isCustom = false
) {
  const dirName = itemType === 'display' ? 'AxMenuItemDisplay'
    : itemType === 'action' ? 'AxMenuItemAction' : 'AxMenuItemOutput';
  const outDirName = `menu-item-${itemType}s`;
  const statKey = itemType === 'display' ? 'menuItemDisplays'
    : itemType === 'action' ? 'menuItemActions' : 'menuItemOutputs';

  let dirPath = path.join(modelPath, dirName);
  try { await fs.access(dirPath); } catch {
    dirPath = path.join(modelPath, dirName.toLowerCase());
    try { await fs.access(dirPath); } catch { return; }
  }
  const files = (await fs.readdir(dirPath)).filter(f => f.endsWith('.xml'));
  if (files.length === 0) return;
  console.log(`   Menu items (${itemType}): ${formatCount(files.length)} files`);
  const outputDir = path.join(OUTPUT_PATH, modelName, outDirName);
  await fs.mkdir(outputDir, { recursive: true });
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    stats.totalFiles++;
    try {
      const result = await parser.parseMenuItemFile(filePath, itemType);
      if (!result.success || !result.data) { stats.errors++; continue; }
      const outputFile = path.join(outputDir, `${result.data.name}.json`);
      await fs.writeFile(outputFile, JSON.stringify({ ...result.data, model: modelName, type: `menu-item-${itemType}` }, isCustom ? sourcePathReplacer : undefined, 2));
      (stats as any)[statKey]++;
    } catch (error) {
      console.error(`   ❌ Error extracting menu item (${itemType}) ${file}:`, error);
      stats.errors++;
    }
  }
}

async function extractExtensions(
  parser: XppMetadataParser,
  modelPath: string,
  modelName: string,
  extensionType: string,
  axDirName: string,
  stats: ExtractionStats,
  isCustom = false
) {
  const outDirName = extensionType + 's'; // table-extensions, class-extensions, etc.
  const statKeyMap: Record<string, string> = {
    'table-extension': 'tableExtensions',
    'class-extension': 'classExtensions',
    'form-extension': 'formExtensions',
    'enum-extension': 'enumExtensions',
    'edt-extension': 'edtExtensions',
    'data-entity-extension': 'dataEntityExtensions',
  };

  let dirPath = path.join(modelPath, axDirName);
  try { await fs.access(dirPath); } catch {
    dirPath = path.join(modelPath, axDirName.toLowerCase());
    try { await fs.access(dirPath); } catch { return; }
  }
  const files = (await fs.readdir(dirPath)).filter(f => f.endsWith('.xml'));
  if (files.length === 0) return;
  console.log(`   ${extensionType}s: ${formatCount(files.length)} files`);
  const outputDir = path.join(OUTPUT_PATH, modelName, outDirName);
  await fs.mkdir(outputDir, { recursive: true });
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    stats.totalFiles++;
    try {
      const result = await parser.parseExtensionFile(filePath, extensionType);
      if (!result.success || !result.data) { stats.errors++; continue; }
      const outputFile = path.join(outputDir, `${result.data.name}.json`);
      await fs.writeFile(outputFile, JSON.stringify({ ...result.data, model: modelName, type: extensionType }, isCustom ? sourcePathReplacer : undefined, 2));
      const statKey = statKeyMap[extensionType];
      if (statKey) (stats as any)[statKey]++;
    } catch (error) {
      console.error(`   ❌ Error extracting ${extensionType} ${file}:`, error);
      stats.errors++;
    }
  }
}

// Run extraction
extractMetadata().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
