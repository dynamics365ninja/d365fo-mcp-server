/**
 * Cache Utilities
 * Helper functions for smart caching with fuzzy matching
 */

/**
 * Calculate Levenshtein distance between two strings
 * Used for fuzzy cache key matching
 */
export function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  
  // Create 2D array for dynamic programming
  const dp: number[][] = Array(len1 + 1)
    .fill(null)
    .map(() => Array(len2 + 1).fill(0));
  
  // Initialize first row and column
  for (let i = 0; i <= len1; i++) {
    dp[i][0] = i;
  }
  for (let j = 0; j <= len2; j++) {
    dp[0][j] = j;
  }
  
  // Fill the DP table
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }
  
  return dp[len1][len2];
}

/**
 * Calculate similarity score between two strings (0-1)
 * 1.0 = identical, 0.0 = completely different
 */
export function similarityScore(str1: string, str2: string): number {
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 1.0;
  
  const distance = levenshteinDistance(str1, str2);
  return 1.0 - distance / maxLen;
}

/**
 * Normalize a query string for consistent caching
 * - Convert to lowercase
 * - Trim whitespace
 * - Remove special characters
 * - Collapse multiple spaces
 */
export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '') // Remove special chars
    .replace(/\s+/g, ' '); // Collapse spaces
}

/**
 * Extract query component from cache key
 * Example: "xpp:search:dimension:class:20" → "dimension"
 */
export function extractQueryFromKey(key: string): string {
  const parts = key.split(':');
  if (parts.length >= 3) {
    return parts[2]; // Query is typically 3rd component
  }
  return '';
}

/**
 * Extract all components from cache key
 */
export interface CacheKeyComponents {
  prefix: string;
  type: string;
  query: string;
  filter?: string;
  limit?: number;
}

export function parseCacheKey(key: string): CacheKeyComponents | null {
  const parts = key.split(':');
  
  // xpp:search:query:type:limit
  if (parts[0] === 'xpp' && parts[1] === 'search' && parts.length >= 5) {
    return {
      prefix: 'xpp',
      type: 'search',
      query: parts[2],
      filter: parts[3],
      limit: parseInt(parts[4], 10)
    };
  }
  
  // xpp:class:className or xpp:table:tableName
  if (parts[0] === 'xpp' && (parts[1] === 'class' || parts[1] === 'table') && parts.length >= 3) {
    return {
      prefix: 'xpp',
      type: parts[1],
      query: parts[2]
    };
  }
  
  return null;
}

/**
 * Check if two cache keys are compatible for fuzzy matching
 * Keys are compatible if they have the same type and similar parameters
 */
export function areKeysCompatible(key1: string, key2: string): boolean {
  const parsed1 = parseCacheKey(key1);
  const parsed2 = parseCacheKey(key2);
  
  if (!parsed1 || !parsed2) return false;
  
  // Must be same type
  if (parsed1.type !== parsed2.type) return false;
  
  // For searches, check filter and limit are reasonably close
  if (parsed1.type === 'search') {
    if (parsed1.filter !== parsed2.filter) return false;
    if (parsed1.limit && parsed2.limit) {
      const limitDiff = Math.abs(parsed1.limit - parsed2.limit);
      if (limitDiff > 10) return false; // Limits must be within 10
    }
  }
  
  return true;
}
