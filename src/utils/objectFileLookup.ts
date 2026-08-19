/**
 * Locate an AOT object's XML file on disk, by type and name.
 *
 * This lived in the MODIFY tool, and four read-only tools (tableInfo, enumInfo,
 * queryInfo, viewInfo) imported it from there — so reading a table pulled in the
 * whole write path, its bridge adapter and its op-spec registry. It answers a
 * question about where metadata lives, which is a util's job, not a tool's.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getConfigManager, fallbackPackagePath } from './configManager.js';
import { PackageResolver } from './packageResolver.js';

/**
 * objectType → the Ax* metadata folder its XML lives in. Module-level because
 * two functions answer questions about that layout now: findD365FileOnDisk
 * (where the file IS) and expectedD365FilePath (where it WOULD be).
 */
const AOT_FOLDER_BY_OBJECT_TYPE: Record<string, string> = {
  class: 'AxClass',
  table: 'AxTable',
  form: 'AxForm',
  enum: 'AxEnum',
  query: 'AxQuery',
  view: 'AxView',
  edt: 'AxEdt',
  'data-entity': 'AxDataEntityView',
  report: 'AxReport',
  'table-extension': 'AxTableExtension',
  'class-extension': 'AxClass',
  'form-extension': 'AxFormExtension',
  'enum-extension': 'AxEnumExtension',
  'edt-extension': 'AxEdtExtension',
  'data-entity-extension': 'AxDataEntityViewExtension',
  'menu-item-display': 'AxMenuItemDisplay',
  'menu-item-action': 'AxMenuItemAction',
  'menu-item-output': 'AxMenuItemOutput',
  'menu-item-display-extension': 'AxMenuItemDisplayExtension',
  'menu-item-action-extension': 'AxMenuItemActionExtension',
  'menu-item-output-extension': 'AxMenuItemOutputExtension',
  menu: 'AxMenu',
  'menu-extension': 'AxMenuExtension',
  'security-privilege': 'AxSecurityPrivilege',
  'security-duty': 'AxSecurityDuty',
  'security-role': 'AxSecurityRole',
  'ignore-diagnostic-list': 'AxIgnoreDiagnosticList',
};

/**
 * Filesystem fallback for findD365File.
 * Constructs the expected AOT file path from config/env and checks if it exists on disk.
 * This handles objects that were just created and are not yet indexed in the symbol database.
 */
export async function findD365FileOnDisk(
  objectType: string,
  objectName: string,
  modelName?: string,
  explicitPackagePath?: string,
): Promise<string | null> {
  const objectFolder = AOT_FOLDER_BY_OBJECT_TYPE[objectType];
  if (!objectFolder) return null;

  const configManager = getConfigManager();

  // Ensure .mcp.json is loaded — lazy init so this works even when
  // server startup did not call initializeConfig() before this tool ran.
  await configManager.ensureLoaded();

  // Resolve model name (same priority order as generateSmartTable):
  //   1. Explicit arg (skip placeholders like "any")
  //   2. .mcp.json context (modelName field or last segment of workspacePath)
  //   3. Auto-detected model name (async, from .rnrproj scan)
  //   4. D365FO_MODEL_NAME env var
  const resolvedModel =
    (modelName && modelName !== 'any' ? modelName : null) ||
    configManager.getModelName() ||
    (await configManager.getAutoDetectedModelName()) ||
    process.env.D365FO_MODEL_NAME ||
    null;

  if (!resolvedModel) {
    console.error('[modifyD365File] Filesystem fallback: could not resolve model name. ' +
      'Provide modelName parameter, configure .mcp.json with modelName/projectPath, or set D365FO_MODEL_NAME env var.');
    return null;
  }

  const configPackagePath =
    configManager.getPackagePath() || fallbackPackagePath();

  // Resolve the custom write root (D365FO_CUSTOM_PACKAGES_PATH).
  // Try this before the MS PLD so we find repo-tracked objects first.
  const customWritePath = await configManager.getCustomPackagesPath();

  // Candidate 0: caller-supplied packagePath. Highest priority — the caller knows
  // the model lives outside the default PackagesLocalDirectory (e.g. a repo checkout).
  // Try both the package==model layout and a PackageResolver scan rooted here so a
  // package!=model layout (e.g. package "ACAUTOCONT" / model "AC AUTOCONT") still resolves.
  if (explicitPackagePath) {
    const directPath = path.join(explicitPackagePath, resolvedModel, resolvedModel, objectFolder, `${objectName}.xml`);
    try {
      await fs.access(directPath);
      console.error(`[modifyD365File] Found via explicit packagePath: ${directPath}`);
      return directPath;
    } catch { /* try resolver scan below */ }
    try {
      const resolver = new PackageResolver([explicitPackagePath]);
      const resolved = await resolver.resolve(resolvedModel);
      if (resolved) {
        const resolvedPath = path.join(resolved.rootPath, resolved.packageName, resolvedModel, objectFolder, `${objectName}.xml`);
        await fs.access(resolvedPath);
        console.error(`[modifyD365File] Found via explicit packagePath (PackageResolver): ${resolvedPath}`);
        return resolvedPath;
      }
    } catch { /* not found under explicit packagePath; fall through */ }
  }

  // Candidate 1: custom write root, package == model (most common for custom models)
  if (customWritePath) {
    const customCandidatePath = path.join(
      customWritePath,
      resolvedModel,
      resolvedModel,
      objectFolder,
      `${objectName}.xml`
    );
    try {
      await fs.access(customCandidatePath);
      console.error(`[modifyD365File] Found via custom packages path: ${customCandidatePath}`);
      return customCandidatePath;
    } catch {
      // Not at custom path; continue
    }
  }

  // Candidate 2: MS PLD / configured packagePath, package == model (traditional fallback)
  const candidatePath = path.join(
    configPackagePath,
    resolvedModel,
    resolvedModel,
    objectFolder,
    `${objectName}.xml`
  );

  try {
    await fs.access(candidatePath);
    console.error(`[modifyD365File] Found via filesystem fallback: ${candidatePath}`);
    return candidatePath;
  } catch {
    // Not at the default package==model path; try PackageResolver (UDE or custom layout)
  }

  // Candidate 3: PackageResolver scan — handles package != model layouts in both UDE
  // and traditional setups with a custom root
  try {
    const envType = await configManager.getDevEnvironmentType();
    const msPath = envType === 'ude' ? await configManager.getMicrosoftPackagesPath() : null;
    const roots = [explicitPackagePath, customWritePath, msPath, configPackagePath].filter(Boolean) as string[];
    const resolver = new PackageResolver(roots);
    const resolved = await resolver.resolve(resolvedModel);
    if (resolved) {
      const resolvedPath = path.join(
        resolved.rootPath,
        resolved.packageName,
        resolvedModel,
        objectFolder,
        `${objectName}.xml`
      );
      try {
        await fs.access(resolvedPath);
        console.error(`[modifyD365File] Found via PackageResolver: ${resolvedPath}`);
        return resolvedPath;
      } catch {
        // Not found at resolved path either
      }
    }
  } catch {
    // PackageResolver failed — skip silently
  }

  return null;
}

/**
 * The path an object's XML WOULD have, whether or not it exists yet.
 *
 * findD365FileOnDisk gates every candidate on fs.access and returns null when
 * none of them exists — correct for a lookup, and a dead end for the one
 * operation that legitimately targets a file that is not there yet:
 * add-diagnostic-suppression on a model that has never suppressed anything has
 * no {Model}_BPSuppressions.xml to find. Without this, that whole path was
 * reachable only by passing filePath by hand, and the tool answered the
 * documented call ("objectName is the file's own base name") with "File not
 * found — re-run action=create", which cannot create this type at all.
 *
 * Existence is what is dropped here, NOT the layout: the <Package> segment
 * still comes from PackageResolver (a package can differ from the model it
 * carries), and the write root is the same one findD365FileOnDisk prefers, so
 * the returned path lands where a real object of that type lives. The caller
 * still passes it through assertWritePathAllowed like any other write target.
 */
export async function expectedD365FilePath(
  objectType: string,
  objectName: string,
  modelName?: string,
  explicitPackagePath?: string,
): Promise<string | null> {
  const objectFolder = AOT_FOLDER_BY_OBJECT_TYPE[objectType];
  if (!objectFolder) return null;

  const configManager = getConfigManager();
  await configManager.ensureLoaded();

  const resolvedModel =
    (modelName && modelName !== 'any' ? modelName : null) ||
    configManager.getModelName() ||
    (await configManager.getAutoDetectedModelName()) ||
    process.env.D365FO_MODEL_NAME ||
    null;
  if (!resolvedModel) return null;

  const configPackagePath = configManager.getPackagePath() || fallbackPackagePath();
  const customWritePath = await configManager.getCustomPackagesPath();

  // The package that actually carries this model, when it can be determined —
  // package == model is only the common case, not the rule.
  try {
    const roots = [explicitPackagePath, customWritePath, configPackagePath].filter(Boolean) as string[];
    if (roots.length > 0) {
      const resolved = await new PackageResolver(roots).resolve(resolvedModel);
      if (resolved) {
        return path.join(
          resolved.rootPath, resolved.packageName, resolvedModel, objectFolder, `${objectName}.xml`,
        );
      }
    }
  } catch { /* fall through to the package == model layout */ }

  const root = explicitPackagePath || customWritePath || configPackagePath;
  if (!root) return null;
  return path.join(root, resolvedModel, resolvedModel, objectFolder, `${objectName}.xml`);
}
