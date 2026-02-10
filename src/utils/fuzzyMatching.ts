/**
 * Fuzzy Matching Utilities
 * Provides fuzzy string matching for typo detection and suggestions
 */

/**
 * Calculate Levenshtein distance between two strings
 * Used for detecting typos and similar terms
 */
export function levenshteinDistance(str1: string, str2: string): number {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();
  
  const len1 = s1.length;
  const len2 = s2.length;
  
  // Create matrix
  const matrix: number[][] = Array(len1 + 1)
    .fill(null)
    .map(() => Array(len2 + 1).fill(0));
  
  // Initialize first column and row
  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;
  
  // Fill matrix
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }
  
  return matrix[len1][len2];
}

/**
 * Calculate similarity score (0-1) based on Levenshtein distance
 * Higher score = more similar
 */
export function similarityScore(str1: string, str2: string): number {
  const distance = levenshteinDistance(str1, str2);
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 1.0;
  return 1 - distance / maxLen;
}

/**
 * Find fuzzy matches for a query term within a list of candidates
 * Returns matches sorted by similarity score (best first)
 */
export interface FuzzyMatch {
  term: string;
  score: number;
  distance: number;
}

export function findFuzzyMatches(
  query: string,
  candidates: string[],
  minScore: number = 0.7,
  maxResults: number = 5
): FuzzyMatch[] {
  const matches: FuzzyMatch[] = [];
  
  for (const candidate of candidates) {
    const distance = levenshteinDistance(query, candidate);
    const score = similarityScore(query, candidate);
    
    if (score >= minScore && query.toLowerCase() !== candidate.toLowerCase()) {
      matches.push({ term: candidate, score, distance });
    }
  }
  
  // Sort by score descending, then by distance ascending
  return matches
    .sort((a, b) => {
      if (Math.abs(a.score - b.score) > 0.01) {
        return b.score - a.score; // Higher score first
      }
      return a.distance - b.distance; // Lower distance first
    })
    .slice(0, maxResults);
}

/**
 * Check if query might be a typo based on common patterns
 */
export function isProbableTypo(query: string, bestMatch: string, score: number): boolean {
  // High similarity suggests typo
  if (score >= 0.85) return true;
  
  // Adjacent key typos (keyboard proximity)
  if (score >= 0.75 && hasSingleCharDifference(query, bestMatch)) return true;
  
  // Common transposition (swapped adjacent letters)
  if (hasTransposition(query, bestMatch)) return true;
  
  return false;
}

/**
 * Check if strings differ by exactly one character
 */
function hasSingleCharDifference(str1: string, str2: string): boolean {
  if (Math.abs(str1.length - str2.length) > 1) return false;
  
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();
  
  let differences = 0;
  let i = 0;
  let j = 0;
  
  while (i < s1.length && j < s2.length) {
    if (s1[i] !== s2[j]) {
      differences++;
      if (differences > 1) return false;
      
      // Handle insertion/deletion
      if (s1.length !== s2.length) {
        if (s1.length > s2.length) i++;
        else j++;
      } else {
        i++;
        j++;
      }
    } else {
      i++;
      j++;
    }
  }
  
  return differences <= 1;
}

/**
 * Check if strings have a single transposition (swapped adjacent chars)
 */
function hasTransposition(str1: string, str2: string): boolean {
  if (str1.length !== str2.length) return false;
  
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();
  
  let foundTransposition = false;
  
  for (let i = 0; i < s1.length - 1; i++) {
    if (s1[i] !== s2[i]) {
      // Check if next chars are swapped
      if (s1[i] === s2[i + 1] && s1[i + 1] === s2[i]) {
        if (foundTransposition) return false; // More than one transposition
        foundTransposition = true;
        i++; // Skip next char (already checked)
      } else {
        return false; // Not a simple transposition
      }
    }
  }
  
  return foundTransposition;
}

/**
 * Generate broader search suggestions by removing common suffixes
 */
export function generateBroaderSearches(query: string): string[] {
  const suggestions: string[] = [];
  const commonSuffixes = [
    'Helper', 'Service', 'Manager', 'Controller', 'Handler',
    'Builder', 'Factory', 'Provider', 'Processor', 'Engine',
    'Validator', 'Converter', 'Formatter', 'Parser', 'Writer',
    'Reader', 'Client', 'Server', 'Contract', 'DP'
  ];
  
  for (const suffix of commonSuffixes) {
    if (query.endsWith(suffix) && query.length > suffix.length) {
      suggestions.push(query.slice(0, -suffix.length));
    }
  }
  
  // Try wildcard pattern
  if (query.length >= 3) {
    suggestions.push(`${query}*`);
  }
  
  return [...new Set(suggestions)]; // Remove duplicates
}

/**
 * Generate narrower search suggestions by adding common suffixes
 */
export function generateNarrowerSearches(query: string): string[] {
  const suggestions: string[] = [];
  const commonSuffixes = [
    'Helper', 'Service', 'Manager', 'Controller', 'Table',
    'Contract', 'Builder', 'DP', 'Form', 'Query'
  ];
  
  // Don't add suffixes if query already has one
  const hasSuffix = commonSuffixes.some(s => query.endsWith(s));
  if (hasSuffix) return suggestions;
  
  // Add common suffixes
  for (const suffix of commonSuffixes) {
    suggestions.push(`${query}${suffix}`);
  }
  
  return suggestions;
}

/**
 * Extract root term from a class name (remove common suffixes)
 */
export function extractRootTerm(term: string): string {
  const commonSuffixes = [
    'Helper', 'Service', 'Manager', 'Controller', 'Handler',
    'Builder', 'Factory', 'Provider', 'Processor', 'Engine',
    'Table', 'Contract', 'DP', 'Form', 'Query'
  ];
  
  for (const suffix of commonSuffixes) {
    if (term.endsWith(suffix) && term.length > suffix.length) {
      return term.slice(0, -suffix.length);
    }
  }
  
  return term;
}
