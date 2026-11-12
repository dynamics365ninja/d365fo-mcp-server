/**
 * Where a new object's XML goes: package, model folder, file.
 *
 * d365fo_file(action="create") writes there and action="generate" recommends it.
 * Generate used to build `<packagePath>\<model>\<model>\<folder>\<name>.xml` by
 * hand, so it pointed at the Microsoft PackagesLocalDirectory where create wrote
 * into the custom write root, and at `<model>\<model>` where the descriptor named
 * a different package. One function now answers for both.
 */

import * as path from 'path';
import { getConfigManager, fallbackPackagePath } from '../../utils/configManager.js';
import { PackageResolver } from '../../utils/packageResolver.js';

export interface WriteTargetRequest {
  /** The resolved model name (the folder under the package). */
  modelName: string;
  /** The AOT folder, e.g. `AxClass`. */
  objectFolder: string;
  /** The final object name: the file is `<objectName>.xml`. */
  objectName: string;
  /** Explicit package name; wins over descriptor resolution. */
  packageName?: string;
  /** Explicit metadata root. */
  packagePath?: string;
  /** Phase timer of the calling tool, so the resolver sweep is measured. */
  time?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** Prefix of the stderr log line, e.g. `create_d365fo_file`. */
  logTag?: string;
}

export interface WriteTarget {
  envType: string;
  /** The metadata root the package sits in. */
  basePath: string;
  packageName: string;
  /** `<basePath>\<package>\<model>\<objectFolder>`. */
  modelPath: string;
  /** `<modelPath>\<objectName>.xml`, as path.join built it. */
  fullPath: string;
  /** fullPath with backslashes. */
  normalizedFullPath: string;
}

/**
 * Resolve the file a create of `objectName` writes.
 *
 * Throws when the model or object name would take the path outside the metadata
 * root (path traversal).
 */
export async function resolveWriteTarget(request: WriteTargetRequest): Promise<WriteTarget> {
  const { modelName: actualModelName, objectFolder } = request;
  const time = request.time ?? (<T>(_name: string, fn: () => Promise<T>) => fn());
  const logTag = request.logTag ?? 'create_d365fo_file';

  // Construct full path - resolve package name
  // Package name can differ from model name in any environment (not just UDE).
  const configManager = getConfigManager();
  const configPackagePath = configManager.getPackagePath();
  const envType = await configManager.getDevEnvironmentType();

  let basePath: string;
  let resolvedPackageName: string;

  // Resolve the custom write root (D365FO_CUSTOM_PACKAGES_PATH).
  // Applies in both UDE and traditional mode — it always points to the repo
  // working tree where custom model XML lives, regardless of dev env type.
  const customWritePath = await configManager.getCustomPackagesPath();

  if (request.packageName) {
    // Explicit packageName always wins, regardless of environment type
    resolvedPackageName = request.packageName;
    // Custom write root beats the MS PLD for explicit packageName calls too.
    basePath = request.packagePath || customWritePath || configPackagePath || fallbackPackagePath();
  } else if (envType === 'ude') {
    // UDE mode: auto-resolve package name via descriptor scan across both roots
    const msPath = await configManager.getMicrosoftPackagesPath();
    const roots = [customWritePath, msPath].filter(Boolean) as string[];

    const resolver = new PackageResolver(roots);
    const resolved = await time('package resolution', () => resolver.resolve(actualModelName));

    if (resolved) {
      resolvedPackageName = resolved.packageName;
      basePath = resolved.rootPath;
    } else {
      // Fallback: assume package == model (common case)
      resolvedPackageName = actualModelName;
      basePath = customWritePath || request.packagePath || configPackagePath || fallbackPackagePath();
    }
  } else {
    // Traditional mode: try descriptor-based resolution first so a package
    // whose name differs from the model name (e.g. package "ISVPackage",
    // model "ISV Package") resolves correctly without an explicit packageName
    // arg. Scan both the custom write root and D365FO_PACKAGE_PATH for the
    // matching descriptor; fall back to assuming package == model otherwise.
    const roots = [customWritePath, configPackagePath].filter(Boolean) as string[];
    const resolver = new PackageResolver(roots);
    const resolved = roots.length
      ? await time('package resolution', () => resolver.resolve(actualModelName))
      : null;

    if (resolved) {
      resolvedPackageName = resolved.packageName;
      basePath = resolved.rootPath;
    } else {
      // Fallback: assume package == model.
      // Prefer the custom write root over D365FO_PACKAGE_PATH so custom model
      // XML lands in the repo working tree rather than the MS PackagesLocalDirectory.
      resolvedPackageName = actualModelName;
      basePath =
        request.packagePath ||
        customWritePath ||
        configPackagePath ||
        fallbackPackagePath();
    }
  }

  console.error(
    `[${logTag}] Environment: ${envType}, Package: ${resolvedPackageName}, Model: ${actualModelName}, BasePath: ${basePath}`,
  );

  const modelPath = path.join(
    basePath,
    resolvedPackageName,
    actualModelName,
    objectFolder,
  );
  const fileName = `${request.objectName}.xml`;
  const fullPath = path.join(modelPath, fileName);

  // Security: prevent path traversal. path.join() resolves ".." segments,
  // so a crafted modelName/objectName could escape basePath entirely.
  // Resolve both paths and assert the target stays within basePath.
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(fullPath);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
    throw new Error(
      `❌ Security error: resolved path "${resolvedTarget}" is outside base directory "${resolvedBase}".\n` +
      `Check modelName, packageName, objectName, and packagePath for path traversal sequences.`
    );
  }

  // Normalize path to Windows format (backslashes) for consistency
  const normalizedFullPath = fullPath.replace(/\//g, '\\');

  return {
    envType,
    basePath,
    packageName: resolvedPackageName,
    modelPath,
    fullPath,
    normalizedFullPath,
  };
}
