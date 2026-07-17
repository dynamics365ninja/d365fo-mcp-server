/**
 * Metadata Extraction Script
 * Extracts X++ metadata from D365 F&O PackagesLocalDirectory
 */

import { loadEnv } from '../src/utils/loadEnv.js';
loadEnv(import.meta.url);
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { XppMetadataParser, buildClassExtensionRecord } from '../src/metadata/xmlParser.js';
import type { XppClassInfo } from '../src/metadata/types.js';
import { isCustomModel as checkIsCustomModel, getCustomModels } from '../src/utils/modelClassifier.js';
import { XppConfigProvider } from '../src/utils/xppConfigProvider.js';
import { box, kv, sectionTitle, statusLine, spread, c, glyph, log, shortPath, supportsUnicode, sanitize } from '../src/utils/terminalUi.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Sanitise emoji/fancy punctuation at the stream level on legacy Windows consoles
// (cp852/cp1250) so output stays readable instead of turning into mojibake.
// No-op on terminals that render Unicode (Windows Terminal, VS Code, *nix).
if (!supportsUnicode) {
  const wrapWrite = (stream: NodeJS.WriteStream) => {
    const orig = stream.write.bind(stream) as (...a: any[]) => boolean;
    (stream as any).write = (chunk: any, ...rest: any[]): boolean =>
      typeof chunk === 'string' ? orig(sanitize(chunk), ...rest) : orig(chunk, ...rest);
  };
  wrapWrite(process.stdout);
  wrapWrite(process.stderr);
}

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
  viewExtensions: number;
  queryExtensions: number;
  mapExtensions: number;
  menuExtensions: number;
  securityDutyExtensions: number;
  securityRoleExtensions: number;
  menuItemDisplayExtensions: number;
  menuItemActionExtensions: number;
  menuItemOutputExtensions: number;
  services: number;
  serviceGroups: number;
  maps: number;
  configurationKeys: number;
  licenseCodes: number;
  securityPolicies: number;
  macros: number;
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

/** The model-level values every extractor needs, threaded through AOT_EXTRACTORS. */
interface ModelContext {
  parser: XppMetadataParser;
  modelName: string;
  stats: ExtractionStats;
  isCustom: boolean;
}

/** One entry of AOT_EXTRACTORS: the folders to read and the extractor that reads them. */
interface AotExtractor {
  /** AOT folders this extractor reads, in canonical PascalCase. */
  dirs: string[];
  /**
   * Runs with `dirPaths` = those of `dirs` that exist in this model, as real on-disk
   * paths. Never called with an empty list, so extractors need no "missing folder" check.
   */
  run: (ctx: ModelContext, dirPaths: string[]) => Promise<void>;
}

/**
 * Every extractor a model is run through, in order, paired with the AOT folders it reads.
 *
 * This is the single source of truth for both the extraction work and the progress
 * denominator (EXTRACTED_AOT_DIRS is derived from it), so the two cannot drift apart.
 * They previously did: only 9 folders were counted while ~36 were extracted, which put
 * progress past 100%.
 *
 * No AxClassExtension: the AOT has no such folder. Class extensions are AxClass files
 * carrying [ExtensionOf(...)], and extractClasses emits their records (#693).
 * AxMapExtension is empty in every package surveyed, but generate_object can emit one,
 * so it stays wired to keep our own output indexable. AxWorkflow*Extension folders are
 * likewise empty and nothing creates them - left out (#693).
 */
const AOT_EXTRACTORS: AotExtractor[] = [
  { dirs: ['AxClass'], run: (c, [dir]) => extractClasses(c.parser, dir, c.modelName, c.stats, c.isCustom) },
  { dirs: ['AxTable'], run: (c, [dir]) => extractTables(c.parser, dir, c.modelName, c.stats, c.isCustom) },
  { dirs: ['AxForm'], run: (c, [dir]) => extractForms(c.parser, dir, c.modelName, c.stats, c.isCustom) },
  { dirs: ['AxQuery'], run: (c, [dir]) => extractQueries(dir, c.modelName, c.stats, c.isCustom) },
  // One extractor for both: parseViewFile tells a view from a data entity by content.
  { dirs: ['AxView', 'AxDataEntityView'], run: (c, dirs) => extractViews(c.parser, dirs, c.modelName, c.stats, c.isCustom) },
  { dirs: ['AxEnum'], run: (c, [dir]) => extractEnums(dir, c.modelName, c.stats, c.isCustom) },
  { dirs: ['AxEdt'], run: (c, [dir]) => extractEdts(c.parser, dir, c.modelName, c.stats, c.isCustom) },
  { dirs: ['AxReport'], run: (c, [dir]) => extractReports(dir, c.modelName, c.stats, c.isCustom) },

  { dirs: ['AxSecurityPrivilege'], run: (c, [dir]) => extractSecurityPrivileges(c.parser, dir, c.modelName, c.stats, c.isCustom) },
  { dirs: ['AxSecurityDuty'], run: (c, [dir]) => extractSecurityDuties(c.parser, dir, c.modelName, c.stats, c.isCustom) },
  { dirs: ['AxSecurityRole'], run: (c, [dir]) => extractSecurityRoles(c.parser, dir, c.modelName, c.stats, c.isCustom) },

  { dirs: ['AxMenuItemDisplay'], run: (c, [dir]) => extractMenuItems(c.parser, dir, c.modelName, 'display', c.stats, c.isCustom) },
  { dirs: ['AxMenuItemAction'], run: (c, [dir]) => extractMenuItems(c.parser, dir, c.modelName, 'action', c.stats, c.isCustom) },
  { dirs: ['AxMenuItemOutput'], run: (c, [dir]) => extractMenuItems(c.parser, dir, c.modelName, 'output', c.stats, c.isCustom) },

  { dirs: ['AxTableExtension'], run: (c, [dir]) => extractExtensions(c.parser, dir, c.modelName, 'table-extension', c.stats, c.isCustom) },
  { dirs: ['AxFormExtension'], run: (c, [dir]) => extractExtensions(c.parser, dir, c.modelName, 'form-extension', c.stats, c.isCustom) },
  { dirs: ['AxEnumExtension'], run: (c, [dir]) => extractExtensions(c.parser, dir, c.modelName, 'enum-extension', c.stats, c.isCustom) },
  { dirs: ['AxEdtExtension'], run: (c, [dir]) => extractExtensions(c.parser, dir, c.modelName, 'edt-extension', c.stats, c.isCustom) },
  { dirs: ['AxDataEntityViewExtension'], run: (c, [dir]) => extractExtensions(c.parser, dir, c.modelName, 'data-entity-extension', c.stats, c.isCustom) },
  { dirs: ['AxViewExtension'], run: (c, [dir]) => extractExtensions(c.parser, dir, c.modelName, 'view-extension', c.stats, c.isCustom) },
  { dirs: ['AxQuerySimpleExtension'], run: (c, [dir]) => extractExtensions(c.parser, dir, c.modelName, 'query-extension', c.stats, c.isCustom) },
  { dirs: ['AxMenuExtension'], run: (c, [dir]) => extractExtensions(c.parser, dir, c.modelName, 'menu-extension', c.stats, c.isCustom) },
  { dirs: ['AxSecurityDutyExtension'], run: (c, [dir]) => extractExtensions(c.parser, dir, c.modelName, 'security-duty-extension', c.stats, c.isCustom) },
  { dirs: ['AxSecurityRoleExtension'], run: (c, [dir]) => extractExtensions(c.parser, dir, c.modelName, 'security-role-extension', c.stats, c.isCustom) },
  { dirs: ['AxMenuItemDisplayExtension'], run: (c, [dir]) => extractExtensions(c.parser, dir, c.modelName, 'menu-item-display-extension', c.stats, c.isCustom) },
  { dirs: ['AxMenuItemActionExtension'], run: (c, [dir]) => extractExtensions(c.parser, dir, c.modelName, 'menu-item-action-extension', c.stats, c.isCustom) },
  { dirs: ['AxMenuItemOutputExtension'], run: (c, [dir]) => extractExtensions(c.parser, dir, c.modelName, 'menu-item-output-extension', c.stats, c.isCustom) },
  { dirs: ['AxMapExtension'], run: (c, [dir]) => extractExtensions(c.parser, dir, c.modelName, 'map-extension', c.stats, c.isCustom) },

  { dirs: ['AxService'], run: (c, [dir]) => extractServices(c.parser, dir, c.modelName, c.stats, c.isCustom) },
  { dirs: ['AxServiceGroup'], run: (c, [dir]) => extractServiceGroups(c.parser, dir, c.modelName, c.stats, c.isCustom) },

  { dirs: ['AxMap'], run: (c, [dir]) => extractMaps(c.parser, dir, c.modelName, c.stats, c.isCustom) },
  { dirs: ['AxConfigurationKey'], run: (c, [dir]) => extractConfigurationKeys(c.parser, dir, c.modelName, c.stats, c.isCustom) },
  { dirs: ['AxLicenseCode'], run: (c, [dir]) => extractLicenseCodes(c.parser, dir, c.modelName, c.stats, c.isCustom) },
  { dirs: ['AxSecurityPolicy'], run: (c, [dir]) => extractSecurityPolicies(c.parser, dir, c.modelName, c.stats, c.isCustom) },
  { dirs: ['AxMacroDictionary'], run: (c, [dir]) => extractMacros(c.parser, dir, c.modelName, c.stats, c.isCustom) },
];

/** Every AOT folder the extractors read - the progress denominator. Derived, never edited. */
export const EXTRACTED_AOT_DIRS: string[] = AOT_EXTRACTORS.flatMap(e => e.dirs);

/** The folders that mark a directory as an X++ model rather than bin/Resources/etc. */
const MODEL_MARKER_DIRS = ['AxClass', 'AxTable', 'AxEnum', 'AxEdt', 'AxView', 'AxDataEntityView'];

/**
 * Map a model's real subdirectory names by their lowercased form, so callers can look
 * up a canonical 'AxClass' regardless of the casing on disk (the AOT ships PascalCase,
 * but Linux checkouts may be lowercased).
 *
 * Reading the directory once and matching case-insensitively is what keeps a folder
 * from resolving twice: probing 'AxClass' and then an 'axclass' twin hits the same
 * directory on case-insensitive filesystems, which double-counted every folder on
 * Windows and made extractViews parse each view file twice.
 */
export async function mapModelDirs(modelPath: string): Promise<Map<string, string>> {
  const byLowerName = new Map<string, string>();
  try {
    for (const entry of await fs.readdir(modelPath, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        byLowerName.set(entry.name.toLowerCase(), path.join(modelPath, entry.name));
      }
    }
  } catch {
    // Model path unreadable - callers treat this as "no extractable folders".
  }
  return byLowerName;
}

/** Resolve canonical folder names against a model's actual folders, dropping absent ones. */
function resolveDirs(dirsByLowerName: Map<string, string>, canonicalDirs: string[]): string[] {
  return canonicalDirs
    .map(dirName => dirsByLowerName.get(dirName.toLowerCase()))
    .filter((dirPath): dirPath is string => dirPath !== undefined);
}

async function countXmlFilesInDirectory(dirPath: string): Promise<number> {
  const files = await fs.readdir(dirPath);
  return files.filter(file => file.endsWith('.xml')).length;
}

/** Expected XML file count for a model, over exactly the folders the extractors read. */
export async function countModelXmlFiles(dirsByLowerName: Map<string, string>): Promise<number> {
  let total = 0;
  for (const dirPath of resolveDirs(dirsByLowerName, EXTRACTED_AOT_DIRS)) {
    total += await countXmlFilesInDirectory(dirPath);
  }
  return total;
}

async function extractMetadata() {
  const extractionStart = Date.now();

  const W = 56;
  console.log('');
  for (const line of box([
    spread(c.bold('D365 F&O Metadata Extraction'), c.dim(`mode=${EXTRACT_MODE}`), W),
    c.gray('XML metadata -> JSON'),
  ], W)) {
    console.log(line);
  }
  console.log('');

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
      log.info(`UDE config: ${xppConfig.configName} v${xppConfig.version}`);
      customRoot = xppConfig.customPackagesPath;
      metadataRoots.push(xppConfig.customPackagesPath);
      log.detail(`Custom packages: ${shortPath(xppConfig.customPackagesPath)}`);
      metadataRoots.push(xppConfig.microsoftPackagesPath);
      log.detail(`Microsoft packages: ${shortPath(xppConfig.microsoftPackagesPath)}`);
    }
  }
  // Fallback: traditional single path
  if (metadataRoots.length === 0) {
    metadataRoots.push(PACKAGES_PATH);
  }

  console.log(kv('Source', metadataRoots.join(', ')));
  console.log(kv('Output', shortPath(OUTPUT_PATH)));
  
  if (EXTRACT_MODE === 'custom') {
    if (MODELS_TO_EXTRACT.length > 0) {
      log.detail(`Custom models (explicit): ${MODELS_TO_EXTRACT.join(', ')}`);
    } else {
      log.detail('Extracting custom models only');
      if (CUSTOM_MODELS.length > 0) {
        log.detail(`Custom model patterns: ${CUSTOM_MODELS.join(', ')}`);
      }
      const extensionPrefix = process.env.EXTENSION_PREFIX;
      if (extensionPrefix) {
        log.detail(`Extension prefix: ${extensionPrefix}`);
      }
    }
  } else if (EXTRACT_MODE === 'standard') {
    log.detail('Extracting standard models (exclude custom)');
    if (CUSTOM_MODELS.length > 0) {
      log.detail(`Custom models to exclude: ${CUSTOM_MODELS.join(', ')}`);
    }
  } else {
    log.detail('Extracting all models (standard + custom)');
  }
  console.log('');
  log.info('AxLabelFile labels (.label.txt) are NOT extracted here.');
  log.detail(`Labels are indexed directly from PACKAGES_PATH during 'npm run build-database'.`);
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
    viewExtensions: 0,
    queryExtensions: 0,
    mapExtensions: 0,
    menuExtensions: 0,
    securityDutyExtensions: 0,
    securityRoleExtensions: 0,
    menuItemDisplayExtensions: 0,
    menuItemActionExtensions: 0,
    menuItemOutputExtensions: 0,
    services: 0,
    serviceGroups: 0,
    maps: 0,
    configurationKeys: 0,
    licenseCodes: 0,
    securityPolicies: 0,
    macros: 0,
    errors: 0,
  };

  // Clean up existing output directory ONLY for 'all' mode
  // For 'custom' and 'standard' modes, preserve existing metadata (e.g., downloaded from blob)
  if (EXTRACT_MODE === 'all') {
    try {
      await fs.rm(OUTPUT_PATH, { recursive: true, force: true });
      log.step('Cleaned up existing metadata directory');
    } catch (error) {
      // Ignore errors if directory doesn't exist
    }
  } else {
    log.info('Preserving existing metadata (incremental build)');
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
        log.warn(`Model not found: ${modelName}`);
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
      log.step(`Found ${formatCount(packagesToProcessCount)} custom packages to process (${formatCount(totalAllPackageNames - packagesToProcessCount)} standard models excluded)`);
    } else if (FILTER_MODE === 'standard-only') {
      log.step(`Found ${formatCount(packagesToProcessCount)} standard packages to process (${formatCount(totalAllPackageNames - packagesToProcessCount)} custom models excluded)`);
    } else {
      log.step(`Found ${formatCount(packagesToProcessCount)} packages to process`);
    }
  }

  const modelWorkItems: ModelWorkItem[] = [];

  // Build model worklist first to enable accurate progress percentages
  for (const [packageName, rootPath] of packageRootMap) {
    const packagePath = path.join(rootPath, packageName);

    try {
      await fs.access(packagePath);
    } catch {
      log.warn(`Package path not found: ${packagePath}`);
      continue;
    }

    // Find all models within this package (including symbolic links)
    const entries = await fs.readdir(packagePath, { withFileTypes: true });
    const modelDirs = entries.filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name);

    for (const modelName of modelDirs) {
      const modelPath = path.join(packagePath, modelName);

      // Check if this directory contains X++ metadata (has AxClass, AxTable, etc.)
      // Do this first so non-model directories (bin, Resources, Reports, …) are
      // silently skipped before any model-name-based filtering is applied.
      const modelDirsByLowerName = await mapModelDirs(modelPath);
      if (resolveDirs(modelDirsByLowerName, MODEL_MARKER_DIRS).length === 0) {
        // Skip directories that don't contain X++ metadata
        continue;
      }

      // Skip FormAdaptor models
      if (modelName.endsWith('FormAdaptor')) {
        log.detail(`${glyph.arrow} skip FormAdaptor model: ${modelName}`);
        continue;
      }

      // Apply model-level filtering
      if (FILTER_MODE === 'custom-only' && !isCustomModel(modelName)) {
        log.detail(`${glyph.arrow} skip standard model: ${modelName}`);
        continue;
      }
      if (FILTER_MODE === 'standard-only' && isCustomModel(modelName)) {
        log.detail(`${glyph.arrow} skip custom model: ${modelName}`);
        continue;
      }

      const expectedXmlFiles = await countModelXmlFiles(modelDirsByLowerName);
      // In UDE mode: custom iff the package lives under customRoot.
      // In traditional mode: fall back to name-based detection.
      const isCustom = customRoot ? rootPath === customRoot : isCustomModel(modelName);
      modelWorkItems.push({ packageName, modelName, modelPath, expectedXmlFiles, isCustom });
    }
  }

  const totalModels = modelWorkItems.length;
  const totalExpectedFiles = modelWorkItems.reduce((sum, item) => sum + item.expectedXmlFiles, 0);
  console.log('');
  log.step(`Planned work: ${formatCount(totalModels)} models, ${formatCount(totalExpectedFiles)} XML files`);

  // Process each model with progress tracking
  let currentPackage = '';
  let processedModels = 0;
  let cumulativeModelDuration = 0;

  for (const modelItem of modelWorkItems) {
    if (currentPackage !== modelItem.packageName) {
      currentPackage = modelItem.packageName;
      console.log('');
      log.step(`${c.bold(currentPackage)} ${c.dim(glyph.dot)} model progress ${formatPercent(processedModels, totalModels)} (${formatCount(processedModels)}/${formatCount(totalModels)})`);
    }

    const modelStart = Date.now();
    log.detail(`${modelItem.modelName} (${formatCount(modelItem.expectedXmlFiles)} XML files)`);

    const { modelPath, modelName, isCustom } = modelItem;

    // Resolve the model's folders once, then run every extractor whose folders exist.
    // AOT_EXTRACTORS is the same list countModelXmlFiles counted, so the numerator and
    // the denominator cover exactly the same folders.
    const ctx: ModelContext = { parser, modelName, stats, isCustom };
    const dirsByLowerName = await mapModelDirs(modelPath);

    for (const extractor of AOT_EXTRACTORS) {
      const dirPaths = resolveDirs(dirsByLowerName, extractor.dirs);
      if (dirPaths.length === 0) continue;
      await extractor.run(ctx, dirPaths);
    }

    const modelDuration = Date.now() - modelStart;
    cumulativeModelDuration += modelDuration;
    processedModels++;

    const elapsed = Date.now() - extractionStart;
    const avgModelDuration = processedModels > 0 ? cumulativeModelDuration / processedModels : 0;
    const avgFileDuration = stats.totalFiles > 0 ? elapsed / stats.totalFiles : 0;
    log.detail(
      `done in ${formatDuration(modelDuration)} ${glyph.dot} progress ${formatPercent(processedModels, totalModels)} (${formatCount(processedModels)}/${formatCount(totalModels)} models), ${formatPercent(stats.totalFiles, totalExpectedFiles)} (${formatCount(stats.totalFiles)}/${formatCount(totalExpectedFiles)} files) ${glyph.dot} avg ${formatDuration(avgModelDuration)}/model, ${formatDuration(avgFileDuration)}/file`
    );
  }

  const totalDuration = Date.now() - extractionStart;
  const averagePerFile = stats.totalFiles > 0 ? totalDuration / stats.totalFiles : 0;
  const averagePerModel = processedModels > 0 ? cumulativeModelDuration / processedModels : 0;
  console.log('');
  console.log(statusLine('ok', c.green(`Extraction complete in ${formatDuration(totalDuration)}`)));
  log.detail(`avg ${formatDuration(averagePerModel)}/model, ${formatDuration(averagePerFile)}/file`);
  console.log('');
  console.log(sectionTitle(`Statistics (${formatCount(stats.totalFiles)} files)`));
  console.log('');
  const statRows: Array<[string, number]> = [
    ['Classes', stats.classes],
    ['Tables', stats.tables],
    ['Forms', stats.forms],
    ['Queries', stats.queries],
    ['Views', stats.views],
    ['Data entities', stats.dataEntities],
    ['Enums', stats.enums],
    ['EDTs', stats.edts],
    ['Reports', stats.reports],
    ['Security privileges', stats.securityPrivileges],
    ['Security duties', stats.securityDuties],
    ['Security roles', stats.securityRoles],
    ['Menu items (display)', stats.menuItemDisplays],
    ['Menu items (action)', stats.menuItemActions],
    ['Menu items (output)', stats.menuItemOutputs],
    ['Table extensions', stats.tableExtensions],
    ['Class extensions', stats.classExtensions],
    ['Form extensions', stats.formExtensions],
    ['Enum extensions', stats.enumExtensions],
    ['EDT extensions', stats.edtExtensions],
    ['Data entity extensions', stats.dataEntityExtensions],
    ['View extensions', stats.viewExtensions],
    ['Query extensions', stats.queryExtensions],
    ['Map extensions', stats.mapExtensions],
    ['Menu extensions', stats.menuExtensions],
    ['Security duty extensions', stats.securityDutyExtensions],
    ['Security role extensions', stats.securityRoleExtensions],
    ['Menu item extensions (display)', stats.menuItemDisplayExtensions],
    ['Menu item extensions (action)', stats.menuItemActionExtensions],
    ['Menu item extensions (output)', stats.menuItemOutputExtensions],
    ['Services', stats.services],
    ['Service groups', stats.serviceGroups],
    ['Maps', stats.maps],
    ['Configuration keys', stats.configurationKeys],
    ['License codes', stats.licenseCodes],
    ['Security policies', stats.securityPolicies],
    ['Macros', stats.macros],
  ];
  const statLabelWidth = Math.max(...statRows.map(([label]) => label.length)) + 2;
  for (const [label, value] of statRows) {
    if (value === 0) continue;
    console.log(kv(label, c.cyan(formatCount(value)), statLabelWidth));
  }
  console.log('');
  if (stats.errors > 0) {
    console.log(statusLine('warn', c.yellow(`${formatCount(stats.errors)} error(s) during extraction - see log above`)));
  } else {
    console.log(statusLine('ok', 'No errors'));
  }
  console.log('');
}

async function extractClasses(
  parser: XppMetadataParser,
  classesPath: string,
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
) {
  const files = await fs.readdir(classesPath);
  const xmlFiles = files.filter(f => f.endsWith('.xml'));

  log.detail(`Classes: ${formatCount(xmlFiles.length)} files`);

  for (const file of xmlFiles) {
    const filePath = path.join(classesPath, file);
    stats.totalFiles++;

    try {
      const classInfo = await parser.parseClassFile(filePath, modelName);
      
      if (!classInfo.success || !classInfo.data) {
        log.warn(`Failed to parse ${file}: ${classInfo.error || 'Unknown error'}`);
        stats.errors++;
        continue;
      }
      
      // Save as JSON
      const outputDir = path.join(OUTPUT_PATH, modelName, 'classes');
      await fs.mkdir(outputDir, { recursive: true });
      const outputFile = path.join(outputDir, `${classInfo.data.name}.json`);
      await fs.writeFile(outputFile, JSON.stringify(classInfo.data, isCustom ? sourcePathReplacer : undefined, 2));

      stats.classes++;

      // A class carrying [ExtensionOf(...)] is also a class extension. It stays
      // indexed as a class (it is a real AxClass) and additionally gets an
      // extension record, which is what find_coc_extensions and
      // resolve_references' extension-method path query.
      if (classInfo.data.extensionOf) {
        await writeClassExtensionRecord(classInfo.data, modelName, stats, isCustom);
      }
    } catch (error) {
      log.err(`Error parsing ${file}: ${error instanceof Error ? error.message : error}`);
      stats.errors++;
    }
  }

}

/**
 * Write the class-extension record for an AxClass carrying [ExtensionOf(...)]
 * into the `class-extensions/` folder symbolIndex.indexExtensions already
 * reads, so both the symbols row and the extension_metadata row come out of
 * the existing pipeline unchanged.
 */
async function writeClassExtensionRecord(
  classInfo: XppClassInfo,
  modelName: string,
  stats: ExtractionStats,
  isCustom: boolean,
) {
  const record = buildClassExtensionRecord(classInfo, modelName);
  if (!record) return;

  const outputDir = path.join(OUTPUT_PATH, modelName, 'class-extensions');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, `${classInfo.name}.json`),
    JSON.stringify(record, isCustom ? sourcePathReplacer : undefined, 2),
  );

  stats.classExtensions++;
}

async function extractTables(
  parser: XppMetadataParser,
  tablesPath: string,
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
) {
  const files = await fs.readdir(tablesPath);
  const xmlFiles = files.filter(f => f.endsWith('.xml'));

  log.detail(`Tables: ${formatCount(xmlFiles.length)} files`);

  for (const file of xmlFiles) {
    const filePath = path.join(tablesPath, file);
    stats.totalFiles++;

    try {
      const tableInfo = await parser.parseTableFile(filePath, modelName);
      
      if (!tableInfo.success || !tableInfo.data) {
        log.warn(`Failed to parse ${file}: ${tableInfo.error || 'Unknown error'}`);
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
      log.err(`Error parsing ${file}: ${error instanceof Error ? error.message : error}`);
      stats.errors++;
    }
  }

}

async function extractForms(
  parser: XppMetadataParser,
  formsPath: string,
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
) {
  const files = await fs.readdir(formsPath);
  const xmlFiles = files.filter(f => f.endsWith('.xml'));

  log.detail(`Forms: ${formatCount(xmlFiles.length)} files`);

  for (const file of xmlFiles) {
    const filePath = path.join(formsPath, file);
    stats.totalFiles++;

    try {
      // Parse full form structure using new parser
      const result = await parser.parseFormFile(filePath, modelName);
      
      if (!result.success || !result.data) {
        log.err(`Error parsing ${file}: ${result.error || 'Unknown error'}`);
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
      log.err(`Error parsing ${file}: ${error instanceof Error ? error.message : error}`);
      stats.errors++;
    }
  }

}

async function extractQueries(
  queriesPath: string,
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
) {
  const files = await fs.readdir(queriesPath);
  const xmlFiles = files.filter(f => f.endsWith('.xml'));

  log.detail(`Queries: ${formatCount(xmlFiles.length)} files`);

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
      log.err(`Error parsing ${file}: ${error instanceof Error ? error.message : error}`);
      stats.errors++;
    }
  }

}

async function extractViews(
  parser: XppMetadataParser,
  sourceDirs: string[],
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
) {
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
          log.warn(`Failed to parse ${file}: ${viewInfo.error || 'Unknown error'}`);
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
        log.err(`Error parsing ${file}: ${error instanceof Error ? error.message : error}`);
        stats.errors++;
      }
    }
  }

  log.detail(`Views/Data entities: ${formatCount(totalXmlFiles)} files`);
}

async function extractEnums(
  enumsPath: string,
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
) {
  const files = await fs.readdir(enumsPath);
  const xmlFiles = files.filter(f => f.endsWith('.xml'));

  log.detail(`Enums: ${formatCount(xmlFiles.length)} files`);

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
      log.err(`Error parsing ${file}: ${error instanceof Error ? error.message : error}`);
      stats.errors++;
    }
  }

}

async function extractEdts(
  parser: XppMetadataParser,
  edtsPath: string,
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
) {
  const files = await fs.readdir(edtsPath);
  const xmlFiles = files.filter(f => f.endsWith('.xml'));

  log.detail(`EDTs: ${formatCount(xmlFiles.length)} files`);

  for (const file of xmlFiles) {
    const filePath = path.join(edtsPath, file);
    stats.totalFiles++;

    try {
      // Parse full EDT structure using new parser
      const result = await parser.parseEdtFile(filePath, modelName);
      
      if (!result.success || !result.data) {
        log.err(`Error parsing ${file}: ${result.error || 'Unknown error'}`);
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
      log.err(`Error parsing ${file}: ${error instanceof Error ? error.message : error}`);
      stats.errors++;
    }
  }

}

/**
 * Extract AxReport metadata.
 * Reports are stored as lightweight stubs — just name + file_path.
 * The get_object_info(report) reader loads the live XML on demand rather than
 * caching a full parse, so we only need enough for the symbol DB entry.
 */
async function extractReports(
  reportsPath: string,
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
) {
  const files = await fs.readdir(reportsPath);
  const xmlFiles = files.filter(f => f.endsWith('.xml'));

  if (xmlFiles.length === 0) return;
  log.detail(`Reports: ${formatCount(xmlFiles.length)} files`);

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
      log.err(`Error extracting report ${file}: ${error instanceof Error ? error.message : error}`);
      stats.errors++;
    }
  }
}

async function extractSecurityPrivileges(
  parser: XppMetadataParser,
  dirPath: string,
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
) {
  const files = (await fs.readdir(dirPath)).filter(f => f.endsWith('.xml'));
  if (files.length === 0) return;
  log.detail(`Security privileges: ${formatCount(files.length)} files`);
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
      log.err(`Error extracting security privilege ${file}: ${error instanceof Error ? error.message : error}`);
      stats.errors++;
    }
  }
}

async function extractSecurityDuties(
  parser: XppMetadataParser,
  dirPath: string,
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
) {
  const files = (await fs.readdir(dirPath)).filter(f => f.endsWith('.xml'));
  if (files.length === 0) return;
  log.detail(`Security duties: ${formatCount(files.length)} files`);
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
      log.err(`Error extracting security duty ${file}: ${error instanceof Error ? error.message : error}`);
      stats.errors++;
    }
  }
}

async function extractSecurityRoles(
  parser: XppMetadataParser,
  dirPath: string,
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
) {
  const files = (await fs.readdir(dirPath)).filter(f => f.endsWith('.xml'));
  if (files.length === 0) return;
  log.detail(`Security roles: ${formatCount(files.length)} files`);
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
      log.err(`Error extracting security role ${file}: ${error instanceof Error ? error.message : error}`);
      stats.errors++;
    }
  }
}

async function extractMenuItems(
  parser: XppMetadataParser,
  dirPath: string,
  modelName: string,
  itemType: 'display' | 'action' | 'output',
  stats: ExtractionStats,
  isCustom = false
) {
  const outDirName = `menu-item-${itemType}s`;
  const statKey = itemType === 'display' ? 'menuItemDisplays'
    : itemType === 'action' ? 'menuItemActions' : 'menuItemOutputs';

  const files = (await fs.readdir(dirPath)).filter(f => f.endsWith('.xml'));
  if (files.length === 0) return;
  log.detail(`Menu items (${itemType}): ${formatCount(files.length)} files`);
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
      log.err(`Error extracting menu item (${itemType}) ${file}: ${error instanceof Error ? error.message : error}`);
      stats.errors++;
    }
  }
}

async function extractExtensions(
  parser: XppMetadataParser,
  dirPath: string,
  modelName: string,
  extensionType: string,
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
    'view-extension': 'viewExtensions',
    'query-extension': 'queryExtensions',
    'map-extension': 'mapExtensions',
    'menu-extension': 'menuExtensions',
    'security-duty-extension': 'securityDutyExtensions',
    'security-role-extension': 'securityRoleExtensions',
    'menu-item-display-extension': 'menuItemDisplayExtensions',
    'menu-item-action-extension': 'menuItemActionExtensions',
    'menu-item-output-extension': 'menuItemOutputExtensions',
  };

  const files = (await fs.readdir(dirPath)).filter(f => f.endsWith('.xml'));
  if (files.length === 0) return;
  log.detail(`${extensionType}s: ${formatCount(files.length)} files`);
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
      log.err(`Error extracting ${extensionType} ${file}: ${error instanceof Error ? error.message : error}`);
      stats.errors++;
    }
  }
}

async function extractServices(
  parser: XppMetadataParser,
  dirPath: string,
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
) {
  const files = (await fs.readdir(dirPath)).filter(f => f.endsWith('.xml'));
  if (files.length === 0) return;
  log.detail(`Services: ${formatCount(files.length)} files`);
  const outputDir = path.join(OUTPUT_PATH, modelName, 'services');
  await fs.mkdir(outputDir, { recursive: true });
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    stats.totalFiles++;
    try {
      const result = await parser.parseServiceFile(filePath);
      if (!result.success || !result.data) { stats.errors++; continue; }
      const outputFile = path.join(outputDir, `${result.data.name}.json`);
      await fs.writeFile(outputFile, JSON.stringify({ ...result.data, model: modelName, type: 'service' }, isCustom ? sourcePathReplacer : undefined, 2));
      stats.services++;
    } catch (error) {
      log.err(`Error extracting service ${file}: ${error instanceof Error ? error.message : error}`);
      stats.errors++;
    }
  }
}

async function extractServiceGroups(
  parser: XppMetadataParser,
  dirPath: string,
  modelName: string,
  stats: ExtractionStats,
  isCustom = false
) {
  const files = (await fs.readdir(dirPath)).filter(f => f.endsWith('.xml'));
  if (files.length === 0) return;
  log.detail(`Service groups: ${formatCount(files.length)} files`);
  const outputDir = path.join(OUTPUT_PATH, modelName, 'service-groups');
  await fs.mkdir(outputDir, { recursive: true });
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    stats.totalFiles++;
    try {
      const result = await parser.parseServiceGroupFile(filePath);
      if (!result.success || !result.data) { stats.errors++; continue; }
      const outputFile = path.join(outputDir, `${result.data.name}.json`);
      await fs.writeFile(outputFile, JSON.stringify({ ...result.data, model: modelName, type: 'service-group' }, isCustom ? sourcePathReplacer : undefined, 2));
      stats.serviceGroups++;
    } catch (error) {
      log.err(`Error extracting service group ${file}: ${error instanceof Error ? error.message : error}`);
      stats.errors++;
    }
  }
}

/**
 * Generic single-type extractor: reads <AxDir>/*.xml, parses each via `parseFn`,
 * writes JSON metadata with the given `type`, and bumps `statKey`.
 */
async function extractSimpleType(
  dirPath: string,
  modelName: string,
  outDirName: string,
  type: string,
  statKey: keyof ExtractionStats,
  parseFn: (filePath: string) => Promise<{ success: boolean; data?: any; error?: string }>,
  stats: ExtractionStats,
  isCustom: boolean,
  label: string,
) {
  const files = (await fs.readdir(dirPath)).filter(f => f.endsWith('.xml'));
  if (files.length === 0) return;
  log.detail(`${label}: ${formatCount(files.length)} files`);
  const outputDir = path.join(OUTPUT_PATH, modelName, outDirName);
  await fs.mkdir(outputDir, { recursive: true });
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    stats.totalFiles++;
    try {
      const result = await parseFn(filePath);
      if (!result.success || !result.data) { stats.errors++; continue; }
      const outputFile = path.join(outputDir, `${result.data.name}.json`);
      await fs.writeFile(outputFile, JSON.stringify({ ...result.data, model: modelName, type }, isCustom ? sourcePathReplacer : undefined, 2));
      (stats as any)[statKey]++;
    } catch (error) {
      log.err(`Error extracting ${label} ${file}: ${error instanceof Error ? error.message : error}`);
      stats.errors++;
    }
  }
}

async function extractMaps(parser: XppMetadataParser, dirPath: string, modelName: string, stats: ExtractionStats, isCustom = false) {
  await extractSimpleType(dirPath, modelName, 'maps', 'map', 'maps',
    (f) => parser.parseMapFile(f), stats, isCustom, 'Maps');
}

async function extractConfigurationKeys(parser: XppMetadataParser, dirPath: string, modelName: string, stats: ExtractionStats, isCustom = false) {
  await extractSimpleType(dirPath, modelName, 'configuration-keys', 'configuration-key', 'configurationKeys',
    (f) => parser.parseConfigurationKeyFile(f), stats, isCustom, 'Configuration keys');
}

async function extractLicenseCodes(parser: XppMetadataParser, dirPath: string, modelName: string, stats: ExtractionStats, isCustom = false) {
  await extractSimpleType(dirPath, modelName, 'license-codes', 'license-code', 'licenseCodes',
    (f) => parser.parseLicenseCodeFile(f), stats, isCustom, 'License codes');
}

async function extractSecurityPolicies(parser: XppMetadataParser, dirPath: string, modelName: string, stats: ExtractionStats, isCustom = false) {
  await extractSimpleType(dirPath, modelName, 'security-policies', 'security-policy', 'securityPolicies',
    (f) => parser.parseSecurityPolicyFile(f), stats, isCustom, 'Security policies');
}

async function extractMacros(parser: XppMetadataParser, dirPath: string, modelName: string, stats: ExtractionStats, isCustom = false) {
  await extractSimpleType(dirPath, modelName, 'macros', 'macro', 'macros',
    (f) => parser.parseMacroFile(f), stats, isCustom, 'Macros');
}

// Run extraction only when invoked as a script: tests import this module for
// EXTRACTED_AOT_DIRS/mapModelDirs/countModelXmlFiles and must not trigger a full run.
const invokedAsScript = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(__filename);

if (invokedAsScript) {
  extractMetadata().catch((error) => {
    log.err(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) console.error(error.stack);
    process.exit(1);
  });
}
