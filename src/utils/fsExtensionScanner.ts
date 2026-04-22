/**
 * Filesystem Extension Scanner
 *
 * Generic utility for scanning Ax*Extension XML files on disk.
 * Used as a last-resort fallback when the SQLite index has no data for a given
 * base object — prevents the AI from falling back to PowerShell scripts.
 *
 * Supported extension types and their AOT folders:
 *
 *   Standard (ObjectName.ModelName.xml):
 *     table-extension          → AxTableExtension
 *     form-extension           → AxFormExtension
 *     enum-extension           → AxEnumExtension
 *     edt-extension            → AxEdtExtension
 *     view-extension           → AxViewExtension
 *     query-extension          → AxQuerySimpleExtension
 *     data-entity-extension    → AxDataEntityViewExtension
 *     map-extension            → AxMapExtension
 *     menu-extension           → AxMenuExtension
 *     security-duty-extension  → AxSecurityDutyExtension
 *     security-role-extension  → AxSecurityRoleExtension
 *
 *   Class-style (ObjectName_Extension.xml in AxClass/):
 *     class-extension          → AxClass  (filename ends with _Extension)
 */

import { promises as fs } from 'fs';
import path from 'path';
import { parseStringPromise } from 'xml2js';

// ── Public interface ─────────────────────────────────────────────────────────

export interface FsExtensionScanResult {
  /** Extension object name (from <Name> element) */
  name: string;
  /** Model directory name (immediate child of package dir) */
  model: string;
  /** Absolute path to the XML file */
  filePath: string;
  /** Field names added by this extension (table / view / data-entity extensions) */
  addedFields: string[];
  /** Index names added by this extension (table extensions) */
  addedIndexes: string[];
  /** Names of methods defined in this extension */
  addedMethods: string[];
  /** Methods that contain the `next` keyword — Chain of Command wrappers */
  cocMethods: string[];
  /** Enum value names added by this extension (enum extensions) */
  addedValues: string[];
  /** Controls added via form extension */
  addedControls: string[];
  /** Data sources added via form extension */
  addedDataSources: string[];
}

// ── Folder config ────────────────────────────────────────────────────────────

interface ExtensionTypeConfig {
  axFolder: string;
  /**
   * When true the extension lives in AxClass/, named like
   * `BaseName_Extension.xml` or `BaseName_ModelExtension.xml`.
   * When false the extension file is named `BaseName.Model.xml`.
   */
  isClassStyle?: boolean;
}

export const EXTENSION_FOLDER_CONFIG: Readonly<Record<string, ExtensionTypeConfig>> = {
  'table-extension':           { axFolder: 'AxTableExtension' },
  'form-extension':            { axFolder: 'AxFormExtension' },
  'enum-extension':            { axFolder: 'AxEnumExtension' },
  'edt-extension':             { axFolder: 'AxEdtExtension' },
  'view-extension':            { axFolder: 'AxViewExtension' },
  'query-extension':           { axFolder: 'AxQuerySimpleExtension' },
  'data-entity-extension':     { axFolder: 'AxDataEntityViewExtension' },
  'map-extension':             { axFolder: 'AxMapExtension' },
  'menu-extension':            { axFolder: 'AxMenuExtension' },
  'security-duty-extension':   { axFolder: 'AxSecurityDutyExtension' },
  'security-role-extension':   { axFolder: 'AxSecurityRoleExtension' },
  'class-extension':           { axFolder: 'AxClass', isClassStyle: true },
} as const;

// ── Core scanner ─────────────────────────────────────────────────────────────

/**
 * Hard budget (ms) for a single scan. The scanner walks every package and every
 * model folder, so without a cap a scan on a full `PackagesLocalDirectory`
 * (hundreds of packages) can block the tool for many seconds. The budget is
 * checked between directory reads so partial results are still returned.
 *
 * Override with `D365FO_FS_SCAN_TIMEOUT_MS` (minimum 500 ms).
 */
const SCAN_TIMEOUT_MS = Math.max(500,
  parseInt(process.env.D365FO_FS_SCAN_TIMEOUT_MS || '3000', 10) || 3000
);

/**
 * When true, the filesystem fallback is completely disabled and the scanner
 * always returns []. Useful in production where the index is authoritative and
 * a stale scan would silently mask missing data.
 */
const FS_FALLBACK_DISABLED = process.env.D365FO_DISABLE_FS_FALLBACK === 'true';

/**
 * Per-scan result cache with short TTL. Three different tools
 * (table-extension / CoC / analyze-extension-points) may request the same
 * object within a single conversation; caching keeps the scanner from
 * re-walking the filesystem each time.
 */
const SCAN_CACHE_TTL_MS = 30_000;
interface ScanCacheEntry { at: number; data: FsExtensionScanResult[]; }
const scanCache = new Map<string, ScanCacheEntry>();

function cacheKeyFor(objectName: string, extensionType: string, packagePath: string): string {
  return `${packagePath}|${extensionType}|${objectName.toLowerCase()}`;
}

/**
 * Scan the D365FO packages directory for extension XML files for a given base
 * object and extension type.
 *
 * Protections against request-time pathology:
 *  - returns [] immediately when D365FO_DISABLE_FS_FALLBACK=true
 *  - caps total work at SCAN_TIMEOUT_MS (partial results allowed)
 *  - caches the result for SCAN_CACHE_TTL_MS
 *
 * @param objectName   Base object name (e.g. `SalesTable`, `SalesOrder`)
 * @param extensionType Key from EXTENSION_FOLDER_CONFIG (e.g. `'table-extension'`)
 * @param packagePath  Root packages directory (e.g. `K:\AOSService\PackagesLocalDirectory`)
 */
export async function scanFsExtensions(
  objectName: string,
  extensionType: string,
  packagePath: string,
): Promise<FsExtensionScanResult[]> {
  if (FS_FALLBACK_DISABLED) return [];
  const config = EXTENSION_FOLDER_CONFIG[extensionType];
  if (!config) return [];

  const cacheKey = cacheKeyFor(objectName, extensionType, packagePath);
  const cached = scanCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SCAN_CACHE_TTL_MS) {
    return cached.data;
  }

  const started = Date.now();
  const timeBudgetExceeded = () => Date.now() - started > SCAN_TIMEOUT_MS;

  const results: FsExtensionScanResult[] = [];
  let packages: string[];
  try {
    packages = await fs.readdir(packagePath);
  } catch {
    return results;
  }

  const lowerObjName = objectName.toLowerCase();

  outer: for (const pkg of packages) {
    if (timeBudgetExceeded()) break outer;
    const pkgDir = path.join(packagePath, pkg);
    let modelDirs: string[];
    try {
      const stat = await fs.stat(pkgDir);
      if (!stat.isDirectory()) continue;
      modelDirs = await fs.readdir(pkgDir);
    } catch { continue; }

    for (const mdl of modelDirs) {
      if (timeBudgetExceeded()) break outer;
      const axDir = path.join(pkgDir, mdl, config.axFolder);
      let xmlFiles: string[];
      try {
        xmlFiles = await fs.readdir(axDir);
      } catch { continue; }

      for (const xmlFile of xmlFiles) {
        if (timeBudgetExceeded()) break outer;
        // ── Fast-path: filename filter (avoids reading files unnecessarily) ──
        const baseName = path.basename(xmlFile, '.xml');
        const lowerBase = baseName.toLowerCase();

        if (config.isClassStyle) {
          // Class extensions: BaseName_Extension.xml  or  BaseName_ModelExtension.xml
          if (!lowerBase.startsWith(lowerObjName + '_')) continue;
          if (!lowerBase.endsWith('_extension')) continue;
        } else {
          // Standard: BaseName.ModelName.xml
          if (!lowerBase.startsWith(lowerObjName + '.')) continue;
        }

        const fullPath = path.join(axDir, xmlFile);
        try {
          const result = await parseExtensionFile(
            fullPath, baseName, mdl, extensionType, config,
          );
          if (result) results.push(result);
        } catch { continue; }
      }
    }
  }

  // Store even partial results — next call within TTL returns them instantly.
  scanCache.set(cacheKey, { at: Date.now(), data: results });
  return results;
}

// ── XML parsing ──────────────────────────────────────────────────────────────

/** Derive the xml2js root-element key from the AOT folder name */
function rootKeyFor(config: ExtensionTypeConfig): string {
  // class-extension lives in AxClass folder but root element is AxClass
  return config.axFolder; // e.g. 'AxTableExtension', 'AxClass'
}

async function parseExtensionFile(
  fullPath: string,
  baseName: string,
  model: string,
  extensionType: string,
  config: ExtensionTypeConfig,
): Promise<FsExtensionScanResult | null> {
  const raw = await fs.readFile(fullPath, 'utf-8');

  // Strip namespace declarations so xml2js sees plain element names,
  // regardless of whether the file uses xmlns="Microsoft.Dynamics..." etc.
  const xmlClean = raw.replace(/\s+xmlns(?::\w+)?="[^"]*"/g, '');

  const parsed = await parseStringPromise(xmlClean, { explicitArray: true });
  const rootKey = rootKeyFor(config);
  const root = parsed?.[rootKey];
  if (!root) return null;

  const extName: string = root.Name?.[0] ?? baseName;

  const addedFields: string[] = [];
  const addedIndexes: string[] = [];
  const addedMethods: string[] = [];
  const cocMethods: string[] = [];
  const addedValues: string[] = [];
  const addedControls: string[] = [];
  const addedDataSources: string[] = [];

  // ── Methods — common to class, table, form, view, etc. ──────────────────
  const sourceCode = root.SourceCode?.[0];
  if (sourceCode) {
    const methodsNode = sourceCode.Methods?.[0];
    if (methodsNode && typeof methodsNode === 'object') {
      const methodArr: any[] = methodsNode.Method ?? [];
      for (const m of methodArr) {
        const mName: string = m?.Name?.[0];
        if (!mName) continue;
        addedMethods.push(mName);
        // CoC: method body contains `next <identifier>`
        const src: string = m?.Source?.[0] ?? '';
        if (/\bnext\s+\w/i.test(src)) {
          cocMethods.push(mName);
        }
      }
    }
  }

  // ── Type-specific data extraction ────────────────────────────────────────
  switch (extensionType) {

    case 'table-extension': {
      extractNamedChildren(root.Fields?.[0], addedFields);
      extractNamedChildren(root.Indexes?.[0], addedIndexes);
      break;
    }

    case 'view-extension':
    case 'data-entity-extension': {
      extractNamedChildren(root.Fields?.[0], addedFields);
      break;
    }

    case 'enum-extension': {
      extractNamedChildren(root.EnumValues?.[0], addedValues);
      break;
    }

    case 'form-extension': {
      extractNamedChildren(root.Controls?.[0], addedControls);
      // DataSources added to the form (extra tables/views joined)
      extractNamedChildren(root.DataSources?.[0], addedDataSources);
      break;
    }

    case 'map-extension': {
      extractNamedChildren(root.Fields?.[0], addedFields);
      extractNamedChildren(root.Mappings?.[0], addedFields);
      break;
    }

    // edt-extension, query-extension, menu-extension, security-*-extension,
    // class-extension: only methods are useful (already extracted above)
    default:
      break;
  }

  return {
    name: extName, model, filePath: fullPath,
    addedFields, addedIndexes, addedMethods, cocMethods,
    addedValues, addedControls, addedDataSources,
  };
}

/**
 * Walk any xml2js node that represents a D365FO collection (e.g. `<Fields>`,
 * `<Controls>`) and collect all `<Name>` values from child elements.
 *
 * D365FO XML stores typed children under their type tag, e.g.:
 *   <Fields>
 *     <AxTableField><Name>MyField</Name>...</AxTableField>
 *   </Fields>
 */
function extractNamedChildren(node: any, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  for (const key of Object.keys(node)) {
    const arr = node[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const name: string = item?.Name?.[0];
      if (name) out.push(name);
    }
  }
}
