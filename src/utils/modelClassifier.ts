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
  
  // EXTENSION_PREFIX has absolute priority — even if modelName is provided
  if (envPrefix) {
    return envPrefix.replace(/_+$/, ''); // strip trailing underscores
  }
  
  // Fallback to modelName only if EXTENSION_PREFIX is not set
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
export function applyObjectPrefix(objectName: string, prefix: string): string {
  if (!prefix) return objectName;

  // Extension infix form — PascalCase without underscore (e.g. "XY" → "Xy" when env had "XY_")
  const extensionInfix = deriveExtensionInfix(prefix);

  // Regular object prefix — keep underscore for underscore-style prefixes
  //   EXTENSION_PREFIX="XY_" → rawEnvPrefix="XY_" → regularPrefix="XY_" → XY_CustTable
  //   EXTENSION_PREFIX="Contoso" → regularPrefix="Contoso" → ContosoCustTable
  const rawEnvPrefix = process.env.EXTENSION_PREFIX?.trim() ?? '';
  const envHasUnderscore = rawEnvPrefix.endsWith('_');
  const regularPrefix = envHasUnderscore
    ? rawEnvPrefix                                         // keep "XY_" as-is
    : prefix.charAt(0).toUpperCase() + prefix.slice(1);   // normalize PascalCase

  // SPECIAL CASE A: Dot-notation extension elements — BaseElement.PrefixExtension
  // For table/form/EDT/enum extensions: "CustTable.XyExtension", "HCMWorker.ContosoExtension"
  // The suffix after the dot is always {ExtensionInfix}Extension.
  if (objectName.includes('.') && objectName.toLowerCase().endsWith('extension')) {
    const dotIdx = objectName.lastIndexOf('.');
    const basePart = objectName.slice(0, dotIdx);    // e.g., "CustTable"
    const correctSuffix = `${extensionInfix}Extension`;
    // Always return the correctly-cased suffix — never preserve the original casing.
    // Without this, "VendTrans.CTSOExtension" with EXTENSION_PREFIX=CTSO_ would not be
    // normalized to "VendTrans.CtsoExtension".
    return `${basePart}.${correctSuffix}`;
  }

  // SPECIAL CASE B: Extension classes — extension infix goes BEFORE "_Extension"
  // Example: SalesFormLetter + "Contoso"       → SalesFormLetterContoso_Extension
  // Example: SalesFormLetter + "XY" (env "XY_") → SalesFormLetterXy_Extension
  //
  // IMPORTANT: objectName MUST be the BASE class name + "_Extension" WITHOUT any prefix infix.
  if (objectName.endsWith('_Extension')) {
    const baseName = objectName.slice(0, -'_Extension'.length);

    // Check if the extension infix is already present at the end (case-insensitive)
    if (baseName.toLowerCase().endsWith(extensionInfix.toLowerCase())) {
      return objectName; // Already has the correct infix, return as-is
    }

    // Inject the extension infix before "_Extension"
    return `${baseName}${extensionInfix}_Extension`;
  }

  // NORMAL CASE: Regular objects — prefix at the START
  // Check if already prefixed (case-insensitive check against the full regular prefix)
  if (objectName.toLowerCase().startsWith(regularPrefix.toLowerCase())) {
    return objectName;
  }
  // For underscore-style: also check against the clean prefix (without underscore)
  // to avoid re-prefixing objects that were already prefixed without the underscore.
  if (envHasUnderscore && objectName.toLowerCase().startsWith(prefix.toLowerCase())) {
    return objectName;
  }

  // Capitalize first letter of objectName part so result is PascalCase after the prefix
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
  
  // No wildcard - exact match
  if (!patternLower.includes('*')) {
    return patternLower === modelLower;
  }
  
  // Convert wildcard pattern to regex
  const regexPattern = patternLower
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
    .replace(/\*/g, '.*'); // Replace * with .*
  
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(modelLower);
}

/**
 * Check if a model is custom (case-insensitive)
 * @param modelName - Name of the model to check
 * @returns true if model is custom, false if standard
 */
export function isCustomModel(modelName: string): boolean {
  // Priority 1: Auto-detected custom models (from workspace detection)
  if (isAutoDetectedCustomModel(modelName)) {
    return true;
  }
  
  const customModels = getCustomModels();
  const extensionPrefix = getExtensionPrefix();
  
  // Priority 2: Check if model matches any pattern in custom models list
  const isInCustomList = customModels.some(pattern => matchesPattern(pattern, modelName));
  
  // Priority 3: Check if model starts with extension prefix
  const hasExtensionPrefix = !!(extensionPrefix && modelName.startsWith(extensionPrefix));
  
  return isInCustomList || hasExtensionPrefix;
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
