/**
 * Tests for Fuzzy Matching Utilities (Priority 4 - Search Suggestions)
 */

import { describe, it, expect } from 'vitest';
import {
  levenshteinDistance,
  similarityScore,
  findFuzzyMatches,
  isProbableTypo,
  generateBroaderSearches,
  generateNarrowerSearches,
  extractRootTerm
} from '../../src/utils/fuzzyMatching.js';

describe('Fuzzy Matching Utilities', () => {
  describe('levenshteinDistance', () => {
    it('should return 0 for identical strings', () => {
      expect(levenshteinDistance('dimension', 'dimension')).toBe(0);
    });

    it('should detect single character typo', () => {
      expect(levenshteinDistance('dimension', 'dimnesion')).toBe(2); // swap n and e
    });

    it('should detect missing character', () => {
      expect(levenshteinDistance('dimension', 'dimesion')).toBe(1);
    });

    it('should detect extra character', () => {
      expect(levenshteinDistance('dimension', 'dimenssion')).toBe(1);
    });

    it('should be case-insensitive', () => {
      expect(levenshteinDistance('Dimension', 'dimension')).toBe(0);
    });
  });

  describe('similarityScore', () => {
    it('should return 1.0 for identical strings', () => {
      expect(similarityScore('test', 'test')).toBe(1.0);
    });

    it('should return high score for similar strings', () => {
      const score = similarityScore('dimension', 'dimnesion');
      expect(score).toBeGreaterThan(0.7);
      expect(score).toBeLessThan(1.0);
    });

    it('should return low score for very different strings', () => {
      expect(similarityScore('dimension', 'xyz')).toBeLessThan(0.3);
    });
  });

  describe('findFuzzyMatches', () => {
    const candidates = [
      'DimensionAttribute',
      'DimensionAttributeValue',
      'DimensionAttributeValueSet',
      'DimensionStorage',
      'LedgerDimension',
      'CustomerTable'
    ];

    it('should find close matches for typo', () => {
      const matches = findFuzzyMatches('DimnesionAttribute', candidates, 0.7, 5);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].term).toBe('DimensionAttribute');
      expect(matches[0].score).toBeGreaterThan(0.7);
    });

    it('should not match the exact query term', () => {
      const matches = findFuzzyMatches('DimensionAttribute', candidates, 0.7, 5);
      expect(matches.every(m => m.term !== 'DimensionAttribute')).toBe(true);
    });

    it('should respect maxResults limit', () => {
      const matches = findFuzzyMatches('Dimension', candidates, 0.5, 3);
      expect(matches.length).toBeLessThanOrEqual(3);
    });

    it('should sort by score descending', () => {
      const matches = findFuzzyMatches('DimAttribute', candidates, 0.5, 5);
      for (let i = 1; i < matches.length; i++) {
        expect(matches[i - 1].score).toBeGreaterThanOrEqual(matches[i].score);
      }
    });
  });

  describe('isProbableTypo', () => {
    it('should detect probable typo with high similarity', () => {
      expect(isProbableTypo('dimnesion', 'dimension', 0.88)).toBe(true);
    });

    it('should not flag low similarity as typo', () => {
      expect(isProbableTypo('abc', 'xyz', 0.3)).toBe(false);
    });
  });

  describe('generateBroaderSearches', () => {
    it('should remove common suffixes', () => {
      const broader = generateBroaderSearches('DimensionHelper');
      expect(broader).toContain('Dimension');
    });

    it('should add wildcard pattern', () => {
      const broader = generateBroaderSearches('Dimension');
      expect(broader).toContain('Dimension*');
    });

    it('should handle queries without suffixes', () => {
      const broader = generateBroaderSearches('Cust');
      expect(broader.length).toBeGreaterThan(0);
      expect(broader).toContain('Cust*');
    });
  });

  describe('generateNarrowerSearches', () => {
    it('should add common suffixes', () => {
      const narrower = generateNarrowerSearches('Dimension');
      expect(narrower).toContain('DimensionHelper');
      expect(narrower).toContain('DimensionService');
      expect(narrower).toContain('DimensionManager');
    });

    it('should not add suffixes if query already has one', () => {
      const narrower = generateNarrowerSearches('DimensionHelper');
      expect(narrower.length).toBe(0);
    });
  });

  describe('extractRootTerm', () => {
    it('should extract root from Helper class', () => {
      expect(extractRootTerm('DimensionHelper')).toBe('Dimension');
    });

    it('should extract root from Service class', () => {
      expect(extractRootTerm('CustService')).toBe('Cust');
    });

    it('should extract root from Manager class', () => {
      expect(extractRootTerm('InventManager')).toBe('Invent');
    });

    it('should return original if no suffix', () => {
      expect(extractRootTerm('Dimension')).toBe('Dimension');
    });
  });
});
