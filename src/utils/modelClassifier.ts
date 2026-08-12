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

import { getInferredModelPrefix, toExtensionInfixCase } from './modelPrefixInference.js';
import { normalizeModelToken } from './modelToken.js';

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
function isAutoDetectedCustomModel(modelName: string): boolean {
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
function getConfiguredModelName(): string {
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
 * Resolve the RAW prefix token for a model — the form that still carries a
 * trailing underscore when the convention has one ("DEMO_", "ISV_"), because that
 * underscore decides how every other name is built.
 *
 * Priority — the ACTIVE MODEL outranks configuration:
 * 1. The prefix the model's own objects already use (see modelPrefixInference).
 *    Development spans many models, each with its own prefix; the workspace
 *    knows which model is open, so that is the authoritative source. A globally
 *    configured "Isv" must not override a model whose objects all say "IsvFin".
 * 2. EXTENSION_PREFIX from configuration — the fallback for a model with nothing
 *    to learn from, e.g. one that is still empty.
 * 3. modelName itself, when nothing else is configured.
 *
 * Set EXTENSION_PREFIX_SOURCE=config to pin step 2 above step 1.
 */
function resolveRawPrefix(modelName: string): string {
  const learned = modelName ? getInferredModelPrefix(modelName) : null;
  if (learned?.regular) return learned.regular;

  const envPrefix = process.env.EXTENSION_PREFIX?.trim();
  if (envPrefix) return envPrefix;

  return modelName || '';
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
 * Returns the prefix with any trailing '_' stripped — the underscore is not part
 * of the prefix itself, only of the form used for regular objects. See
 * resolveRawPrefix() for the priority order, and resolveRegularObjectPrefixToken()
 * for the token actually prepended to a name.
 *
 * Returns empty string when nothing resolves.
 */
export function resolveObjectPrefix(modelName: string): string {
  return resolveRawPrefix(modelName).replace(/_+$/, '');
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
 *   - Compound "ConFinSK_"                     → infix "ConFinSk" (per segment)
 *
 * Detection: if the winning raw prefix ends with '_', lower each PascalCase
 * segment on its own (see toExtensionInfixCase) — flattening the whole token
 * would turn "ConFinSK" into "Confinsk".
 *
 * When `modelName` is given and that model's own extensions already state their
 * infix, it is used verbatim instead of being derived. The two are genuinely
 * independent: model Demo names regular objects "DEMO_Foo" but its extensions
 * "AssetBookTable.DEMOExtension" — deriving would produce "DemoExtension" and
 * every name would silently diverge from the model's existing convention.
 */
export function deriveExtensionInfix(resolvedPrefix: string, modelName?: string): string {
  if (!resolvedPrefix) return '';

  const learned = modelName ? getInferredModelPrefix(modelName) : null;
  if (learned?.infix) return learned.infix;

  const rawPrefix = modelName ? resolveRawPrefix(modelName) : (process.env.EXTENSION_PREFIX?.trim() ?? '');
  if (rawPrefix.endsWith('_')) {
    // XY_ → Xy, ConFinSK_ → ConFinSk  (first char of each segment upper, rest lower)
    return toExtensionInfixCase(resolvedPrefix);
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
  const raw = resolveRawPrefix(modelName ?? '');
  if (!raw) return '';
  if (raw.endsWith('_')) return raw;
  const resolved = raw.replace(/_+$/, '');
  return resolved.charAt(0).toUpperCase() + resolved.slice(1);
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
 *
 * ALWAYS pass `modelName` when you know it. Omitting it does not merely lose the
 * model-name naming style — it changes the regular-object result, because the raw
 * prefix then falls back to EXTENSION_PREFIX and the model's own separator is
 * invisible: a model whose objects are "ConSK_*" yields "ConSK_QualityTier"
 * with the argument and "ConSKQualityTier" without it. prepare(mode="create")
 * predicted names through the 2-arg form while d365fo_file(action="create") wrote
 * them through the 3-arg form, so the two disagreed on every underscore-style model.
 * Prefer normalizeObjectName() (utils/objectNaming.ts), which is the one path
 * create/modify already share.
 */
export function applyObjectPrefix(objectName: string, prefix: string, modelName?: string): string {
  if (!prefix) return objectName;

  // model-name style embeds the model name instead of the prefix infix for extension
  // elements/classes only (VS default); regular new objects are unaffected.
  const useModelName = !!modelName && getExtensionNamingStyle() === 'model-name';

  // The model name as it may appear inside an object name — identical to modelName
  // unless the name carries characters an AOT identifier cannot (see #892).
  const modelToken = modelName ? normalizeModelToken(modelName) : '';

  // Extension infix form — PascalCase without underscore (e.g. "XY" → "Xy" when env had "XY_"),
  // or the model's own infix when its existing extensions state one.
  const extensionInfix = deriveExtensionInfix(prefix, modelName);

  // Regular object prefix keeps the underscore for underscore-style prefixes
  //   "XY_"     → regularPrefix="XY_"     → XY_CustTable
  //   "Contoso" → regularPrefix="Contoso" → ContosoCustTable
  // The raw form comes from the model when one is given, so a model whose objects
  // use "DEMO_" keeps the underscore even though EXTENSION_PREFIX says otherwise.
  const rawPrefix = modelName ? resolveRawPrefix(modelName) : (process.env.EXTENSION_PREFIX?.trim() ?? '');
  const envHasUnderscore = rawPrefix.endsWith('_');
  const regularPrefix = envHasUnderscore
    ? rawPrefix
    : prefix.charAt(0).toUpperCase() + prefix.slice(1);

  // Dot-notation extension elements: BaseObject.{Infix}Extension (standard AOT naming)
  // or BaseObject.ModelName (bare model name, as VS generates for model-name style).
  if (objectName.includes('.')) {
    const dotIdx = objectName.lastIndexOf('.');
    const basePart = objectName.slice(0, dotIdx);
    const suffixPart = objectName.slice(dotIdx + 1);

    // Replaces whatever follows the dot, so re-running is idempotent.
    if (useModelName) {
      return `${basePart}.${modelToken}`;
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
      // Match on the TOKEN, not the raw model name: the token is what an existing
      // name can contain, so comparing against "contoso robotics" never fired and
      // CustTable_ContosoRobotics_Extension grew a second token on every pass.
      const lowerModel = modelToken.toLowerCase();
      if (cleanBase.toLowerCase().endsWith('_' + lowerModel)) {
        cleanBase = cleanBase.slice(0, cleanBase.length - lowerModel.length - 1);
      } else if (cleanBase.toLowerCase().endsWith(lowerModel)) {
        cleanBase = cleanBase.slice(0, cleanBase.length - lowerModel.length);
      }
      cleanBase = cleanBase.replace(/_+$/, '');
      return `${cleanBase}_${modelToken}_Extension`;
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
