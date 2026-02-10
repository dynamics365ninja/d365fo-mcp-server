/**
 * Tests for Search Suggestion Engine (Priority 4)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateSearchSuggestions,
  TermRelationshipGraph,
  formatSuggestions,
  type SearchSuggestion
} from '../../src/utils/suggestionEngine.js';
import type { XppSymbol } from '../../src/metadata/types.js';

describe('Search Suggestion Engine', () => {
  const mockSymbolNames = [
    'DimensionAttribute',
    'DimensionAttributeValue',
    'DimensionAttributeValueSet',
    'DimensionHelper',
    'DimensionService',
    'LedgerDimension',
    'CustTable'
  ];

  const mockSymbolsByTerm = new Map<string, XppSymbol[]>();

  beforeEach(() => {
    mockSymbolsByTerm.clear();
    mockSymbolsByTerm.set('dimension', [
      { name: 'Dimension', type: 'class' } as XppSymbol
    ]);
    mockSymbolsByTerm.set('dimensionhelper', [
      { name: 'DimensionHelper', type: 'class' } as XppSymbol
    ]);
  });

  describe('generateSearchSuggestions', () => {
    it('should generate typo suggestions for misspelled query', () => {
      const suggestions = generateSearchSuggestions(
        'DimnesionAttribute', // typo: swapped n and e
        mockSymbolNames,
        mockSymbolsByTerm,
        5
      );

      expect(suggestions.length).toBeGreaterThan(0);
      const typoSuggestions = suggestions.filter(s => s.type === 'typo');
      expect(typoSuggestions.length).toBeGreaterThan(0);
      expect(typoSuggestions[0].query).toBe('DimensionAttribute');
    });

    it('should generate broader search suggestions', () => {
      const suggestions = generateSearchSuggestions(
        'DimensionHelper',
        mockSymbolNames,
        mockSymbolsByTerm,
        5
      );

      const broaderSuggestions = suggestions.filter(s => s.type === 'broader');
      expect(broaderSuggestions.length).toBeGreaterThan(0);
      expect(broaderSuggestions.some(s => s.query === 'Dimension')).toBe(true);
    });

    it('should generate narrower search suggestions', () => {
      const suggestions = generateSearchSuggestions(
        'Dimension',
        mockSymbolNames,
        mockSymbolsByTerm,
        5
      );

      const narrowerSuggestions = suggestions.filter(s => s.type === 'narrower');
      expect(narrowerSuggestions.length).toBeGreaterThan(0);
      expect(narrowerSuggestions.some(s => s.query.includes('Helper'))).toBe(true);
    });

    it('should limit results to maxSuggestions', () => {
      const suggestions = generateSearchSuggestions(
        'Dim',
        mockSymbolNames,
        mockSymbolsByTerm,
        3
      );

      expect(suggestions.length).toBeLessThanOrEqual(3);
    });

    it('should sort suggestions by confidence', () => {
      const suggestions = generateSearchSuggestions(
        'DimnesionHelper',
        mockSymbolNames,
        mockSymbolsByTerm,
        5
      );

      for (let i = 1; i < suggestions.length; i++) {
        expect(suggestions[i - 1].confidence).toBeGreaterThanOrEqual(suggestions[i].confidence);
      }
    });
  });

  describe('TermRelationshipGraph', () => {
    let graph: TermRelationshipGraph;

    beforeEach(() => {
      graph = new TermRelationshipGraph();
    });

    it('should build relationships from symbols', () => {
      const symbols: XppSymbol[] = [
        {
          name: 'DimensionHelper',
          type: 'class',
          usedTypes: 'DimensionAttribute,DimensionAttributeValue',
          methodCalls: 'validate,find',
          filePath: '/test',
          model: 'Test'
        },
        {
          name: 'LedgerHelper',
          type: 'class',
          usedTypes: 'DimensionAttribute,LedgerJournal',
          methodCalls: 'post,validate',
          filePath: '/test',
          model: 'Test'
        }
      ];

      graph.build(symbols);

      const related = graph.getRelatedTerms('dimensionhelper', 5);
      expect(related.length).toBeGreaterThan(0);
      expect(related.some(r => r.term === 'dimensionattribute')).toBe(true);
    });

    it('should track relationship strength', () => {
      const symbols: XppSymbol[] = [
        {
          name: 'Helper1',
          type: 'class',
          usedTypes: 'CommonType',
          filePath: '/test',
          model: 'Test'
        },
        {
          name: 'Helper2',
          type: 'class',
          usedTypes: 'CommonType',
          filePath: '/test',
          model: 'Test'
        },
        {
          name: 'Helper3',
          type: 'class',
          usedTypes: 'CommonType,RareType',
          filePath: '/test',
          model: 'Test'
        }
      ];

      graph.build(symbols);

      // Query with correct lowercase (term relationship graph stores keys in lowercase)
      const related = graph.getRelatedTerms('helper1', 5);
      expect(related.length).toBeGreaterThan(0);
      expect(related[0].strength).toBeGreaterThan(0);
    });

    it('should calculate term popularity', () => {
      const symbols: XppSymbol[] = [
        {
          name: 'PopularClass',
          type: 'class',
          usedTypes: 'Type1,Type2,Type3',
          filePath: '/test',
          model: 'Test'
        }
      ];

      graph.build(symbols);

      const popularity = graph.getTermPopularity('popularclass');
      expect(popularity).toBeGreaterThan(0);
    });

    it('should return empty for unknown term', () => {
      graph.build([]);
      const related = graph.getRelatedTerms('nonexistent', 5);
      expect(related.length).toBe(0);
    });
  });

  describe('formatSuggestions', () => {
    it('should format suggestions with headers', () => {
      const suggestions: SearchSuggestion[] = [
        {
          type: 'typo',
          query: 'DimensionAttribute',
          reason: 'Did you mean "DimensionAttribute"?',
          confidence: 0.9
        },
        {
          type: 'broader',
          query: 'Dimension',
          reason: 'Try broader search without suffix',
          confidence: 0.7
        }
      ];

      const formatted = formatSuggestions(suggestions);
      expect(formatted).toContain('🔍 Did you mean?');
      expect(formatted).toContain('DimensionAttribute');
      expect(formatted).toContain('🔎 Try broader search');
      expect(formatted).toContain('Dimension');
    });

    it('should return empty string for no suggestions', () => {
      const formatted = formatSuggestions([]);
      expect(formatted).toBe('');
    });

    it('should group suggestions by type', () => {
      const suggestions: SearchSuggestion[] = [
        {
          type: 'typo',
          query: 'Term1',
          reason: 'Typo correction',
          confidence: 0.9
        },
        {
          type: 'narrower',
          query: 'Term2Helper',
          reason: 'Try with suffix',
          confidence: 0.65
        },
        {
          type: 'typo',
          query: 'Term3',
          reason: 'Another typo',
          confidence: 0.85
        }
      ];

      const formatted = formatSuggestions(suggestions);
      expect(formatted).toContain('🔍 Did you mean?');
      expect(formatted).toContain('Term1');
      expect(formatted).toContain('Term3');
      expect(formatted).toContain('🎯 Try narrower search');
      expect(formatted).toContain('Term2Helper');
    });
  });
});
