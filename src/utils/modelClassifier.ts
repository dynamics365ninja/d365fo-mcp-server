/**
 * Model Classifier Utility
 * Determines whether a D365 F&O model is custom or standard
 * 
 * Logic:
 * - Custom models are defined in CUSTOM_MODELS environment variable
 * - Supports wildcards: Asl*, *Test, *Custom*
 * - Models with EXTENSION_PREFIX are considered custom
 * - All other models are considered Microsoft standard models
 */

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
 * Check if a pattern matches a model name (supports wildcards)
 * @param pattern - Pattern to match (e.g., "Asl*", "*Test", "*Custom*")
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
  const customModels = getCustomModels();
  const extensionPrefix = getExtensionPrefix();
  
  // Check if model matches any pattern in custom models list
  const isInCustomList = customModels.some(pattern => matchesPattern(pattern, modelName));
  
  // Check if model starts with extension prefix
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
