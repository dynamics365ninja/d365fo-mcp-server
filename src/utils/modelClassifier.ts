/**
 * Model Classifier Utility
 * Determines whether a D365 F&O model is custom or standard
 * 
 * Logic:
 * - Custom models are defined in CUSTOM_MODELS environment variable
 * - Supports wildcards: Custom*, *Test, *Extension*
 * - Models with EXTENSION_PREFIX are considered custom
 * - Auto-detected models from workspace are automatically registered as custom
 * - All other models are considered Microsoft standard models
 */

// Runtime registry for auto-detected custom models
const autoDetectedCustomModels = new Set<string>();

/**
 * Register a model as custom (e.g., from auto-detection)
 * This allows dynamically detected models to be treated as custom
 */
export function registerCustomModel(modelName: string): void {
  autoDetectedCustomModels.add(modelName);
  console.error(`[ModelClassifier] Registered "${modelName}" as custom model (auto-detected)`);
}

/**
 * Clear all auto-detected custom models (for test isolation)
 */
export function clearAutoDetectedModels(): void {
  autoDetectedCustomModels.clear();
}

/**
 * Check if a model is registered as auto-detected custom
 */
export function isAutoDetectedCustomModel(modelName: string): boolean {
  return autoDetectedCustomModels.has(modelName);
}

/**
 * Get list of custom models from environment
 */
export function getCustomModels(): string[] {
  return process.env.CUSTOM_MODELS?.split(',').map(m => m.trim()).filter(Boolean) || [];
}

/**
 * Get extension prefix from environment
 */
export function getExtensionPrefix(): string {
  return process.env.EXTENSION_PREFIX || '';
}

/**
 * Get the explicitly configured target model name from the environment.
 *
 * D365FO_MODEL_NAME is the model the server was told to write into. It is set
 * deliberately by the developer (e.g. per server instance), so the model it
 * names is custom by definition — see isCustomModel().
 *
 * Returns empty string when not configured.
 */
export function getConfiguredModelName(): string {
  return process.env.D365FO_MODEL_NAME?.trim() || '';
}

/**
 * Get configurable object suffix from environment.
 * Returns the raw EXTENSION_SUFFIX value (trailing underscores stripped).
 * Empty string when not configured.
 */
export function getObjectSuffix(): string {
  return process.env.EXTENSION_SUFFIX?.trim().replace(/_+$/, '') || '';
}

/**
 * Resolve the extension-naming style from the environment.
 *
 *  - 'prefix' (default): extension elements and extension classes embed the
 *    EXTENSION_PREFIX as an infix, per Microsoft's prefix-based guideline
 *    (e.g. CustTable.CrExtension, CustTableCr_Extension).
 *
 *  - 'model-name': extension elements and extension classes embed the MODEL NAME,
 *    matching the Visual Studio developer-tools default
 *    (e.g. CustTable.ContosoRobotics, CustTable_ContosoRobotics_Extension).
 *    EXTENSION_PREFIX still applies to NEW objects and to fields/methods added
 *    inside extensions — only the extension element/class token changes.
 *
 * Configured via EXTENSION_NAMING_STYLE. Any value other than 'model-name'
 * (including unset) resolves to 'prefix' so existing setups are unchanged.
 */
export function getExtensionNamingStyle(): 'prefix' | 'model-name' {
  return process.env.EXTENSION_NAMING_STYLE?.trim().toLowerCase() === 'model-name'
    ? 'model-name'
    : 'prefix';
}

/**
 * Apply a configurable suffix to a NEW model element name.
 * The suffix is appended at the end of the object name.
 *
 * Suffix does NOT apply to:
 *  - Dot-notation extension elements (CustTable.XyExtension — suffix breaks MS naming)
 *  - Extension classes ending with _Extension (SalesFormLetterXy_Extension)
 *  - Names that already end with the suffix (case-insensitive)
 *
 * Examples with EXTENSION_SUFFIX="ZZ":
 *   MyTable        → MyTableZZ
 *   MyClass        → MyClassZZ
 *   MyTableZZ      → MyTableZZ  (no double-suffix)
 *   CustTable.XyExtension → CustTable.XyExtension (skip)
 *   CustTableXy_Extension → CustTableXy_Extension (skip)
 */
export function applyObjectSuffix(objectName: string, suffix: string): string {
  if (!suffix) return objectName;

  // Skip extension elements — suffix would break MS naming conventions
  if (objectName.includes('.') && objectName.toLowerCase().endsWith('extension')) {
    return objectName;
  }
  if (objectName.endsWith('_Extension')) {
    return objectName;
  }

  // Already has the suffix (case-insensitive)
  if (objectName.toLowerCase().endsWith(suffix.toLowerCase())) {
    return objectName;
  }

  return `${objectName}${suffix}`;
}

/**
 * Resolve the clean prefix to use when naming newly created D365FO objects.
 *
 * Microsoft naming guidelines (https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/extensibility/naming-guidelines-extensions):
 *  - New model elements  → prefix concatenated directly: {Prefix}{ObjectName}  (e.g. WHSMyTable)
 *  - Extension elements  → {BaseElement}.{Prefix}Extension                     (e.g. HCMWorker.WHSExtension)
 *  - Extension classes   → {BaseElement}{Prefix}_Extension                     (e.g. SalesFormLetterContoso_Extension)
 *  - Fields in extensions→ {Prefix}{FieldName}                                 (e.g. WHSApprovingWorker)
 *
 * Priority (EXTENSION_PREFIX has higher priority than modelName):
 * 1. EXTENSION_PREFIX env var (trailing '_' stripped — the underscore is NOT part of the prefix)
 * 2. modelName as fallback (only if EXTENSION_PREFIX is not set)
 *
 * Returns empty string when both are empty.
 */
export function resolveObjectPrefix(modelName: string): string {
  const envPrefix = process.env.EXTENSION_PREFIX?.trim();

  if (envPrefix) {
    return envPrefix.replace(/_+$/, '');
  }

  if (modelName) {
    return modelName.replace(/_+$/, '');
  }

  return '';
}

/**
 * Derive the extension infix form from an already-resolved prefix.
 *
 * Extension elements (dot-notation and _Extension classes) embed the prefix
 * as a PascalCase infix WITHOUT any underscore separator:
 *   - Underscore-style EXTENSION_PREFIX "XY_"  → resolved prefix "XY"  → infix "Xy"
 *   - Normal prefix "Contoso"                  → resolved prefix "Contoso" → infix "Contoso"
 *   - All-caps prefix "WHS" with "WHS_" in env → infix "Whs"
 *   - All-caps prefix "WHS" with "WHS" in env  → infix "WHS" (unchanged)
 *
 * Detection: if EXTENSION_PREFIX env var ends with '_', apply first-upper + rest-lower.
 */
export function deriveExtensionInfix(resolvedPrefix: string): string {
  if (!resolvedPrefix) return '';
  const rawEnvPrefix = process.env.EXTENSION_PREFIX?.trim() ?? '';
  const envHasUnderscore = rawEnvPrefix.endsWith('_');
  if (envHasUnderscore) {
    // XY_ → Xy  (first char uppercase, remaining chars lowercase)
    return resolvedPrefix.charAt(0).toUpperCase() + resolvedPrefix.slice(1).toLowerCase();
  }
  // Normal PascalCase — just capitalize first letter, keep the rest as-is
  return resolvedPrefix.charAt(0).toUpperCase() + resolvedPrefix.slice(1);
}

/**
 * Resolve the literal prefix TOKEN that `applyObjectPrefix` prepends to a
 * REGULAR (non-extension) new object name for the CURRENT session — i.e. the
 * exact substring that will appear at the start of e.g. an EDT/table/class
 * Name in generated metadata (`{token}{ObjectName}`).
 *
 * Factored out of `applyObjectPrefix`'s "regular objects" branch (same
 * underscore-style-vs-PascalCase derivation) so other callers that need to
 * recognise/strip this token from ALREADY-GENERATED names — notably the eval
 * golden oracle's prefix-agnostic comparison (src/eval/oracle/normalize.ts,
 * see docs/AGENT_EVAL_LOOP.md §6.2) — don't have to duplicate the branching
 * logic. Returns '' when no prefix is configured.
 */
export function resolveRegularObjectPrefixToken(modelName?: string): string {
  const resolved = resolveObjectPrefix(modelName ?? '');
  if (!resolved) return '';
  const rawEnvPrefix = process.env.EXTENSION_PREFIX?.trim() ?? '';
  const envHasUnderscore = rawEnvPrefix.endsWith('_');
  return envHasUnderscore ? rawEnvPrefix : resolved.charAt(0).toUpperCase() + resolved.slice(1);
}

/**
 * Apply prefix to a NEW model element name.
 * Per MS guidelines, the prefix is concatenated directly (no separator):
 *   WHSMyTable, MyPrefixMyClass, ContosoMyForm
 *
 * Underscore-style prefixes (EXTENSION_PREFIX="XY_") are handled specially:
 *   - Regular objects (classes, tables, forms, …): prefix kept with underscore
 *       XY_CustTable, XY_MyClass  (NOT XyCustTable)
 *   - Extension elements (dot-notation or _Extension class infix): PascalCase, no underscore
 *       CustTable.XyExtension, CustTableXy_Extension  (NOT CustTable.XY_Extension)
 *
 * CRITICAL for extension classes: If EXTENSION_PREFIX is set in .env,
 * it should be used EXCLUSIVELY - never combined with modelName prefix.
 * The function receives the ALREADY RESOLVED prefix (from resolveObjectPrefix),
 * so it strips any existing suffix-prefix and replaces it with the current one.
 *
 * Case-insensitive check prevents double-prefixing.
 */
export function applyObjectPrefix(objectName: string, prefix: string, modelName?: string): string {
  if (!prefix) return objectName;

  // model-name style embeds the model name instead of the prefix infix for extension
  // elements/classes only (VS default); regular new objects are unaffected.
  const useModelName = !!modelName && getExtensionNamingStyle() === 'model-name';

  // Extension infix form — PascalCase without underscore (e.g. "XY" → "Xy" when env had "XY_")
  const extensionInfix = deriveExtensionInfix(prefix);

  // Regular object prefix keeps the underscore for underscore-style env prefixes
  //   EXTENSION_PREFIX="XY_" → regularPrefix="XY_" → XY_CustTable
  //   EXTENSION_PREFIX="Contoso" → regularPrefix="Contoso" → ContosoCustTable
  const rawEnvPrefix = process.env.EXTENSION_PREFIX?.trim() ?? '';
  const envHasUnderscore = rawEnvPrefix.endsWith('_');
  const regularPrefix = envHasUnderscore
    ? rawEnvPrefix
    : prefix.charAt(0).toUpperCase() + prefix.slice(1);

  // Dot-notation extension elements: BaseObject.{Infix}Extension (standard AOT naming)
  // or BaseObject.ModelName (bare model name, as VS generates for model-name style).
  if (objectName.includes('.')) {
    const dotIdx = objectName.lastIndexOf('.');
    const basePart = objectName.slice(0, dotIdx);
    const suffixPart = objectName.slice(dotIdx + 1);

    // Replaces whatever follows the dot, so re-running is idempotent.
    if (useModelName) {
      return `${basePart}.${modelName}`;
    }

    if (suffixPart.toLowerCase().endsWith('extension')) {
      // Always normalize casing (e.g. "CTSOExtension" → "CtsoExtension").
      const correctSuffix = `${extensionInfix}Extension`;
      return `${basePart}.${correctSuffix}`;
    }

    // Bare model-name suffix (no "extension" word) — return as-is.
    return objectName;
  }

  // Extension classes: infix goes before "_Extension".
  // objectName must be the base class name + "_Extension" without any prefix infix.
  if (objectName.endsWith('_Extension')) {
    const baseName = objectName.slice(0, -'_Extension'.length);

    // Strip any trailing model-name token first so re-running stays idempotent
    // (avoids Base_ModelName_ModelName_Extension).
    if (useModelName) {
      let cleanBase = baseName.replace(/_+$/, '');
      const lowerModel = modelName!.toLowerCase();
      if (cleanBase.toLowerCase().endsWith('_' + lowerModel)) {
        cleanBase = cleanBase.slice(0, cleanBase.length - lowerModel.length - 1);
      } else if (cleanBase.toLowerCase().endsWith(lowerModel)) {
        cleanBase = cleanBase.slice(0, cleanBase.length - lowerModel.length);
      }
      cleanBase = cleanBase.replace(/_+$/, '');
      return `${cleanBase}_${modelName}_Extension`;
    }

    // Check if the extension infix is already present at the end (case-insensitive)
    if (baseName.toLowerCase().endsWith(extensionInfix.toLowerCase())) {
      return objectName; // Already has the correct infix, return as-is
    }

    // Inject the extension infix before "_Extension"
    return `${baseName}${extensionInfix}_Extension`;
  }

  // Regular objects: prefix at the start. Check both the full regular prefix and,
  // for underscore-style prefixes, the clean prefix without underscore, to avoid
  // re-prefixing an already-prefixed name.
  if (objectName.toLowerCase().startsWith(regularPrefix.toLowerCase())) {
    return objectName;
  }
  if (envHasUnderscore && objectName.toLowerCase().startsWith(prefix.toLowerCase())) {
    return objectName;
  }

  const normalizedName = objectName.charAt(0).toUpperCase() + objectName.slice(1);
  return `${regularPrefix}${normalizedName}`;
}

/**
 * Build the name of an EXTENSION ELEMENT (table extension, form extension, etc.)
 * Format: {BaseElementName}.{Prefix}Extension
 * Example: HCMWorker.WHSExtension, ContactPerson.ContosoCustomizations
 *
 * Never use just {BaseElement}.Extension — the prefix/infix is required to avoid conflicts.
 */
export function buildExtensionElementName(baseElement: string, prefix: string): string {
  if (!prefix) {
    throw new Error(
      `Extension element name requires a prefix. ` +
      `Set EXTENSION_PREFIX in .env or pass modelName. ` +
      `Bad pattern: "${baseElement}.Extension" (too generic, risk of conflicts).`
    );
  }
  const infix = deriveExtensionInfix(prefix);
  return `${baseElement}.${infix}Extension`;
}

/**
 * Build the name of an EXTENSION CLASS (Chain of Command / augmentation class).
 * Format: {BaseElement}{Prefix}_Extension
 * Example: ContactPersonWHS_Extension, CustTableForm{Prefix}_Extension
 *
 * Never use just {BaseClass}_Extension — the infix is required.
 */
export function buildExtensionClassName(baseClass: string, prefix: string): string {
  if (!prefix) {
    throw new Error(
      `Extension class name requires a prefix/infix. ` +
      `Set EXTENSION_PREFIX in .env or pass modelName. ` +
      `Bad pattern: "${baseClass}_Extension" (too generic, risk of conflicts).`
    );
  }
  // Derive the PascalCase infix form (e.g. "XY_" env → "Xy" infix, "Contoso" → "Contoso")
  const infix = deriveExtensionInfix(prefix);
  // Avoid double infix if baseClass already contains the infix
  const infixToAdd = baseClass.toLowerCase().includes(infix.toLowerCase()) ? '' : infix;
  return `${baseClass}${infixToAdd}_Extension`;
}

/**
 * Check if a pattern matches a model name (supports wildcards)
 * @param pattern - Pattern to match (e.g., "Custom*", "*Test", "*Extension*")
 * @param modelName - Model name to check
 * @returns true if pattern matches
 */
function matchesPattern(pattern: string, modelName: string): boolean {
  const patternLower = pattern.toLowerCase();
  const modelLower = modelName.toLowerCase();

  if (!patternLower.includes('*')) {
    return patternLower === modelLower;
  }

  const regexPattern = patternLower
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(modelLower);
}

/**
 * Check if a model is custom (case-insensitive)
 * @param modelName - Name of the model to check
 * @returns true if model is custom, false if standard
 */
export function isCustomModel(modelName: string): boolean {
  if (isAutoDetectedCustomModel(modelName)) {
    return true;
  }

  // The configured target model (D365FO_MODEL_NAME) is custom by definition — it was
  // named deliberately as the write target. Checked independently of the ISV prefix,
  // which is often just an abbreviation of the model name and would fail startsWith() below.
  const configuredModel = getConfiguredModelName();
  if (configuredModel && configuredModel.toLowerCase() === modelName.toLowerCase()) {
    return true;
  }

  const customModels = getCustomModels();
  const extensionPrefix = getExtensionPrefix();

  const isInCustomList = customModels.some(pattern => matchesPattern(pattern, modelName));
  const hasExtensionPrefix = matchesExtensionPrefix(extensionPrefix, modelName);

  return isInCustomList || hasExtensionPrefix;
}

/**
 * Does `modelName` start with the configured EXTENSION_PREFIX?
 *
 * Two deliberate normalizations, both aligning this check with the rest of the file:
 *
 *  - **Case-insensitive**, like every other comparison here (CUSTOM_MODELS via
 *    matchesPattern(), D365FO_MODEL_NAME, applyObjectPrefix()'s double-prefix guards).
 *    EXTENSION_PREFIX=contoso now recognises a model named ContosoRobotics.
 *
 *  - **Trailing '_' stripped**, because getExtensionPrefix() returns EXTENSION_PREFIX raw
 *    while resolveObjectPrefix() strips it. Model names rarely carry the underscore
 *    (EXTENSION_PREFIX="XY_" names objects XY_CustTable but the MODEL is usually XyRobotics),
 *    so matching the raw form only would leave those models classified as standard — the
 *    exact silent failure this guards against. "XY_" therefore matches both XY_Robotics
 *    and XyRobotics.
 *
 * A prefix of only underscores has no bare form; fall back to the raw value rather than
 * degenerating into an empty prefix that matches every model.
 */
function matchesExtensionPrefix(extensionPrefix: string, modelName: string): boolean {
  const rawPrefix = extensionPrefix.trim().toLowerCase();
  if (!rawPrefix) return false;
  const effective = rawPrefix.replace(/_+$/, '') || rawPrefix;
  return modelName.toLowerCase().startsWith(effective);
}

/**
 * Check if a model is standard (opposite of custom)
 * @param modelName - Name of the model to check
 * @returns true if model is standard Microsoft model
 */
export function isStandardModel(modelName: string): boolean {
  return !isCustomModel(modelName);
}

/**
 * Filter models by type
 * @param models - Array of model names
 * @param type - 'custom' or 'standard'
 * @returns Filtered array of model names
 */
export function filterModelsByType(models: string[], type: 'custom' | 'standard'): string[] {
  if (type === 'custom') {
    return models.filter(m => isCustomModel(m));
  }
  return models.filter(m => isStandardModel(m));
}
