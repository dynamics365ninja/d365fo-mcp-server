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
import { PackageResolver, type ResolvedPackage } from '../../utils/packageResolver.js';

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
  /** Prefix of the stderr log line, e.g. `[create_d365fo_file]`. */
  logPrefix?: string;
}

export interface WriteTarget {
  envType: string;
  /**
   * The model folder the file goes in. The name passed, unless that was a
   * package name whose descriptor declares exactly one model: then that model.
   */
  modelName: string;
  /** Lines for the reply: a model taken from the package's descriptor, or no descriptor at all. */
  notes: string[];
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
 * The metadata roots whose descriptors say which package holds a model: the
 * custom write root, then the Microsoft packages root (UDE) or D365FO_PACKAGE_PATH.
 */
async function descriptorRoots(
  envType: string,
  customWritePath: string | null | undefined,
  configPackagePath: string | null | undefined,
): Promise<string[]> {
  const second = envType === 'ude'
    ? await getConfigManager().getMicrosoftPackagesPath()
    : configPackagePath;
  return [customWritePath, second].filter(Boolean) as string[];
}

/**
 * The model meant by `modelName`, when that is a package name.
 *
 * A name no descriptor declares as a model, but that is the <ModelModule> of
 * exactly one model, means that model; the note says so for the reply. Any other
 * name comes back as passed, with no note.
 *
 * Create calls this as soon as it knows the model, before anything compares the
 * model with something else: the cross-model guard checked "ContosoCore" against
 * the workspace's "Contoso Core" and refused the write, the Microsoft-model check
 * and the naming ran on the package name, and only the write target, which comes
 * last, resolved it to the model.
 */
export async function resolvePackageNameAsModel(
  modelName: string,
): Promise<{ modelName: string; note?: string }> {
  const configManager = getConfigManager();
  const envType = await configManager.getDevEnvironmentType();
  const roots = await descriptorRoots(
    envType,
    await configManager.getCustomPackagesPath(),
    configManager.getPackagePath(),
  );
  if (!roots.length) return { modelName };
  const resolver = new PackageResolver(roots);
  if (await resolver.resolve(modelName)) return { modelName };
  const models = await resolver.modelsOfPackage(modelName);
  if (models.length !== 1) return { modelName };
  return { modelName: models[0].modelName, note: packageNameNote(modelName, models[0]) };
}

/**
 * Resolve the file a create of `objectName` writes.
 *
 * Throws when the model or object name would take the path outside the metadata
 * root (path traversal).
 */
export async function resolveWriteTarget(request: WriteTargetRequest): Promise<WriteTarget> {
  const { objectFolder } = request;
  let actualModelName = request.modelName;
  const time = request.time ?? (<T>(_name: string, fn: () => Promise<T>) => fn());
  const logPrefix = request.logPrefix ?? '[create_d365fo_file]';

  // Construct full path - resolve package name
  // Package name can differ from model name in any environment (not just UDE).
  const configManager = getConfigManager();
  const configPackagePath = configManager.getPackagePath();
  const envType = await configManager.getDevEnvironmentType();

  let basePath: string;
  let resolvedPackageName: string;
  const notes: string[] = [];

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
    const roots = await descriptorRoots(envType, customWritePath, configPackagePath);

    const resolver = new PackageResolver(roots);
    const resolved = await time('package resolution', () => resolver.resolve(actualModelName));

    const packageModels = resolved ? [] : await resolver.modelsOfPackage(actualModelName);
    const byPackage = packageModels.length === 1 ? packageModels[0] : null;
    if (resolved) {
      resolvedPackageName = resolved.packageName;
      basePath = resolved.rootPath;
    } else if (byPackage) {
      resolvedPackageName = byPackage.packageName;
      basePath = byPackage.rootPath;
      notes.push(packageNameNote(actualModelName, byPackage));
      actualModelName = byPackage.modelName;
    } else {
      // Fallback: assume package == model (common case)
      resolvedPackageName = actualModelName;
      basePath = customWritePath || request.packagePath || configPackagePath || fallbackPackagePath();
      notes.push(fallbackNote(actualModelName, packageModels, basePath, roots));
    }
  } else {
    // Traditional mode: try descriptor-based resolution first so a package
    // whose name differs from the model name (e.g. package "ISVPackage",
    // model "ISV Package") resolves correctly without an explicit packageName
    // arg. Scan both the custom write root and D365FO_PACKAGE_PATH for the
    // matching descriptor; fall back to assuming package == model otherwise.
    const roots = await descriptorRoots(envType, customWritePath, configPackagePath);
    const resolver = new PackageResolver(roots);
    const resolved = roots.length
      ? await time('package resolution', () => resolver.resolve(actualModelName))
      : null;

    const packageModels = resolved || !roots.length ? [] : await resolver.modelsOfPackage(actualModelName);
    const byPackage = packageModels.length === 1 ? packageModels[0] : null;
    if (resolved) {
      resolvedPackageName = resolved.packageName;
      basePath = resolved.rootPath;
    } else if (byPackage) {
      resolvedPackageName = byPackage.packageName;
      basePath = byPackage.rootPath;
      notes.push(packageNameNote(actualModelName, byPackage));
      actualModelName = byPackage.modelName;
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
      notes.push(fallbackNote(actualModelName, packageModels, basePath, roots));
    }
  }

  console.error(
    `${logPrefix} Environment: ${envType}, Package: ${resolvedPackageName}, Model: ${actualModelName}, BasePath: ${basePath}`,
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
    modelName: actualModelName,
    notes,
    basePath,
    packageName: resolvedPackageName,
    modelPath,
    fullPath,
    normalizedFullPath,
  };
}

/**
 * `name` matched no descriptor's model <Name> but is the package of exactly one
 * model, which the write now goes to. Said in the reply, so later calls pass the
 * model's name and not the package's.
 */
function packageNameNote(name: string, model: ResolvedPackage): string {
  return (
    `ℹ️ "${name}" is a package name. Its descriptor declares the model "${model.modelName}", ` +
    `so the file goes in ${path.join(model.rootPath, model.packageName, model.modelName)}. ` +
    `Pass modelName "${model.modelName}" in later calls.`
  );
}

/**
 * The fallback `<root>/<name>/<name>` is a folder no descriptor declares: a new
 * one, beside the model's real folder when `name` was meant to be an existing
 * model. Said in the reply rather than created silently.
 */
function fallbackNote(name: string, packageModels: ResolvedPackage[], basePath: string, roots: string[]): string {
  const folder = path.join(basePath, name, name);
  if (packageModels.length > 1) {
    const models = packageModels.map(m => m.modelName).sort().map(m => `"${m}"`).join(', ');
    return (
      `⚠️ "${name}" is a package name that holds several models (${models}). As passed, the file ` +
      `goes in a new model folder ${folder}. Pass one of the models as modelName.`
    );
  }
  const searched = roots.length ? roots.join(', ') : 'no metadata root configured';
  return (
    `⚠️ No descriptor declares a model or package named "${name}" (searched: ${searched}). ` +
    `The file goes in a new model folder ${folder}, which no model owns until a descriptor ` +
    `exists. Check modelName if the model already exists.`
  );
}

