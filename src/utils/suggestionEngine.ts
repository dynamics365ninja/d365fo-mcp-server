/**
 * Search Suggestion Engine
 * Provides intelligent suggestions for failed or empty search results
 */

import type { XppSymbol } from '../metadata/types.js';
import {
  findFuzzyMatches,
  isProbableTypo,
  generateBroaderSearches,
  generateNarrowerSearches,
  extractRootTerm
} from './fuzzyMatching.js';

export interface SearchSuggestion {
  type: 'typo' | 'broader' | 'narrower' | 'related';
  query: string;
  reason: string;
  confidence: number; // 0-1
}

/**
 * Generate suggestions for a failed search query
 */
export function generateSearchSuggestions(
  query: string,
  allSymbolNames: string[],
  symbolsByTerm: Map<string, XppSymbol[]>,
  maxSuggestions: number = 5
): SearchSuggestion[] {
  const suggestions: SearchSuggestion[] = [];
  
  // 1. Typo corrections (Did you mean?)
  const typoSuggestions = generateTypoSuggestions(query, allSymbolNames);
  suggestions.push(...typoSuggestions);
  
  // 2. Broader searches (remove suffixes, use wildcards)
  const broaderSuggestions = generateBroaderSuggestions(query);
  suggestions.push(...broaderSuggestions);
  
  // 3. Narrower searches (add common suffixes)
  const narrowerSuggestions = generateNarrowerSuggestions(query);
  suggestions.push(...narrowerSuggestions);
  
  // 4. Related term suggestions
  const relatedSuggestions = generateRelatedSuggestions(query, symbolsByTerm);
  suggestions.push(...relatedSuggestions);
  
  // Sort by confidence and return top suggestions
  return suggestions
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxSuggestions);
}

/**
 * Generate typo correction suggestions
 */
function generateTypoSuggestions(
  query: string,
  allSymbolNames: string[]
): SearchSuggestion[] {
  const suggestions: SearchSuggestion[] = [];
  
  // Find fuzzy matches with high similarity
  const matches = findFuzzyMatches(query, allSymbolNames, 0.7, 5);
  
  for (const match of matches) {
    const isTypo = isProbableTypo(query, match.term, match.score);
    
    suggestions.push({
      type: 'typo',
      query: match.term,
      reason: isTypo 
        ? `Did you mean "${match.term}"?`
        : `Similar term: "${match.term}" (${Math.round(match.score * 100)}% match)`,
      confidence: match.score
    });
  }
  
  return suggestions;
}

/**
 * Generate broader search suggestions
 */
function generateBroaderSuggestions(query: string): SearchSuggestion[] {
  const suggestions: SearchSuggestion[] = [];
  const broaderSearches = generateBroaderSearches(query);
  
  for (const broaderQuery of broaderSearches) {
    const isWildcard = broaderQuery.endsWith('*');
    
    suggestions.push({
      type: 'broader',
      query: broaderQuery,
      reason: isWildcard
        ? `Try wildcard search for "${broaderQuery.slice(0, -1)}" prefix`
        : `Try broader search without suffix`,
      confidence: isWildcard ? 0.6 : 0.7
    });
  }
  
  return suggestions;
}

/**
 * Generate narrower search suggestions
 */
function generateNarrowerSuggestions(query: string): SearchSuggestion[] {
  const suggestions: SearchSuggestion[] = [];
  const narrowerSearches = generateNarrowerSearches(query);
  
  // Only suggest top 3 most common suffixes
  const topSuffixes = ['Helper', 'Service', 'Manager'];
  
  for (const narrowerQuery of narrowerSearches) {
    const suffix = narrowerQuery.replace(query, '');
    
    if (topSuffixes.includes(suffix)) {
      suggestions.push({
        type: 'narrower',
        query: narrowerQuery,
        reason: `Try with common suffix "${suffix}"`,
        confidence: 0.65
      });
    }
  }
  
  return suggestions;
}

/**
 * Generate related term suggestions based on usage patterns
 */
function generateRelatedSuggestions(
  query: string,
  symbolsByTerm: Map<string, XppSymbol[]>
): SearchSuggestion[] {
  const suggestions: SearchSuggestion[] = [];
  const rootTerm = extractRootTerm(query);
  
  // Find symbols with similar root terms
  const relatedTerms = new Set<string>();
  
  for (const [term, _symbols] of symbolsByTerm) {
    const termRoot = extractRootTerm(term);
    
    // Check if root terms are related
    if (termRoot.toLowerCase().includes(rootTerm.toLowerCase()) ||
        rootTerm.toLowerCase().includes(termRoot.toLowerCase())) {
      if (term.toLowerCase() !== query.toLowerCase()) {
        relatedTerms.add(term);
      }
    }
  }
  
  // Convert to suggestions
  for (const term of Array.from(relatedTerms).slice(0, 3)) {
    suggestions.push({
      type: 'related',
      query: term,
      reason: `Related term with similar root`,
      confidence: 0.6
    });
  }
  
  return suggestions;
}

/**
 * Build term relationship graph from symbol metadata
 * Analyzes what terms are commonly used together
 */
export class TermRelationshipGraph {
  private relationships: Map<string, Map<string, number>> = new Map();
  
  /**
   * Build relationship graph from symbols
   */
  build(symbols: XppSymbol[]): void {
    for (const symbol of symbols) {
      const baseTerm = symbol.name.toLowerCase();
      
      // Extract related terms from various metadata fields
      const relatedTerms = this.extractRelatedTerms(symbol);
      
      // Record co-occurrences
      for (const relatedTerm of relatedTerms) {
        this.addRelationship(baseTerm, relatedTerm);
      }
    }
  }
  
  /**
   * Extract related terms from symbol metadata
   */
  private extractRelatedTerms(symbol: XppSymbol): Set<string> {
    const terms = new Set<string>();
    
    // From used_types field
    if (symbol.usedTypes) {
      const types = symbol.usedTypes.split(',').map(t => t.trim().toLowerCase());
      types.forEach(t => terms.add(t));
    }
    
    // From method_calls field
    if (symbol.methodCalls) {
      const calls = symbol.methodCalls.split(',').map(c => c.trim().toLowerCase());
      calls.forEach(c => terms.add(c));
    }
    
    // From related_methods field
    if (symbol.relatedMethods) {
      const methods = symbol.relatedMethods.split(',').map(m => m.trim().toLowerCase());
      methods.forEach(m => terms.add(m));
    }
    
    // From parent class/table
    if (symbol.parentName) {
      terms.add(symbol.parentName.toLowerCase());
    }
    
    // From extends class
    if (symbol.extendsClass) {
      terms.add(symbol.extendsClass.toLowerCase());
    }
    
    return terms;
  }
  
  /**
   * Add or increment relationship between two terms
   */
  private addRelationship(term1: string, term2: string): void {
    if (term1 === term2) return;
    
    if (!this.relationships.has(term1)) {
      this.relationships.set(term1, new Map());
    }
    
    const termRelations = this.relationships.get(term1)!;
    const currentCount = termRelations.get(term2) || 0;
    termRelations.set(term2, currentCount + 1);
  }
  
  /**
   * Get related terms for a given term
   */
  getRelatedTerms(term: string, limit: number = 5): Array<{ term: string; strength: number }> {
    const termLower = term.toLowerCase();
    const relations = this.relationships.get(termLower);
    
    if (!relations) return [];
    
    // Convert to array and sort by strength
    return Array.from(relations.entries())
      .map(([relatedTerm, count]) => ({
        term: relatedTerm,
        strength: count
      }))
      .sort((a, b) => b.strength - a.strength)
      .slice(0, limit);
  }
  
  /**
   * Get total relationship count for a term (popularity indicator)
   */
  getTermPopularity(term: string): number {
    const termLower = term.toLowerCase();
    const relations = this.relationships.get(termLower);
    
    if (!relations) return 0;
    
    return Array.from(relations.values()).reduce((sum, count) => sum + count, 0);
  }
}

/**
 * Format suggestions for display
 */
export function formatSuggestions(suggestions: SearchSuggestion[]): string {
  if (suggestions.length === 0) return '';
  
  const lines: string[] = [];
  
  // Group by type
  const typoSuggestions = suggestions.filter(s => s.type === 'typo');
  const broaderSuggestions = suggestions.filter(s => s.type === 'broader');
  const narrowerSuggestions = suggestions.filter(s => s.type === 'narrower');
  const relatedSuggestions = suggestions.filter(s => s.type === 'related');
  
  if (typoSuggestions.length > 0) {
    lines.push('\n### 🔍 Did you mean?');
    typoSuggestions.forEach(s => {
      lines.push(`• **"${s.query}"** - ${s.reason}`);
    });
  }
  
  if (broaderSuggestions.length > 0) {
    lines.push('\n### 🔎 Try broader search');
    broaderSuggestions.forEach(s => {
      lines.push(`• **"${s.query}"** - ${s.reason}`);
    });
  }
  
  if (narrowerSuggestions.length > 0) {
    lines.push('\n### 🎯 Try narrower search');
    narrowerSuggestions.forEach(s => {
      lines.push(`• **"${s.query}"** - ${s.reason}`);
    });
  }
  
  if (relatedSuggestions.length > 0) {
    lines.push('\n### 🔗 Related terms');
    relatedSuggestions.forEach(s => {
      lines.push(`• **"${s.query}"** - ${s.reason}`);
    });
  }
  
  return lines.join('\n');
}
