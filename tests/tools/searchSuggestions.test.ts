/**
 * Integration Tests for Search Suggestions in Search Tool (Priority 4)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchTool } from '../../src/tools/search.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../src/types/context.js';
import { TermRelationshipGraph } from '../../src/utils/suggestionEngine.js';

describe('Search Tool - Intelligent Suggestions Integration', () => {
  let mockContext: XppServerContext;

  beforeEach(() => {
    // Build term relationship graph
    const termGraph = new TermRelationshipGraph();
    termGraph.build([]);

    // Mock context with suggestion support
    mockContext = {
      symbolIndex: {
        searchSymbols: vi.fn(() => []), // No results - trigger suggestions
        getAllSymbolNames: vi.fn(() => [
          'DimensionAttribute',
          'DimensionAttributeValue',
          'DimensionHelper',
          'LedgerDimension',
          'CustTable'
        ]),
        getSymbolsByTerm: vi.fn(() => new Map())
      } as any,
      parser: {} as any,
      cache: {
        generateSearchKey: vi.fn((query, limit, type) => `search:${query}:${limit}:${type}`),
        getFuzzy: vi.fn(async () => null),
        set: vi.fn(async () => {}),
      } as any,
      workspaceScanner: {} as any,
      hybridSearch: {} as any,
      termRelationshipGraph: termGraph
    };
  });

  it('should provide typo suggestions when no results found', async () => {
    const request: CallToolRequest = {
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: {
          query: 'DimnesionAttribute', // Typo
          type: 'class',
          limit: 20
        }
      }
    };

    const result = await searchTool(request, mockContext);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = (result.content[0] as any).text;
    
    // Should contain "Did you mean?" section
    expect(text).toContain('🔍 Did you mean?');
    expect(text).toContain('DimensionAttribute');
  });

  it('should provide broader search suggestions', async () => {
    const request: CallToolRequest = {
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: {
          query: 'DimensionHelper',
          type: 'class',
          limit: 20
        }
      }
    };

    const result = await searchTool(request, mockContext);

    expect(result.content).toBeDefined();
    const text = (result.content[0] as any).text;
    
    // Should suggest broader search
    expect(text).toContain('🔎 Try broader search');
    expect(text).toContain('Dimension');
  });

  it('should provide narrower search suggestions', async () => {
    const request: CallToolRequest = {
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: {
          query: 'Dimension',
          type: 'class',
          limit: 20
        }
      }
    };

    const result = await searchTool(request, mockContext);

    expect(result.content).toBeDefined();
    const text = (result.content[0] as any).text;
    
    // Should suggest narrower search
    expect(text).toContain('🎯 Try narrower search');
    expect(text).toMatch(/Helper|Service|Manager/);
  });

  it('should handle queries with results normally', async () => {
    // Mock successful search
    (mockContext.symbolIndex as any).searchSymbols = vi.fn(() => [
      {
        name: 'DimensionAttribute',
        type: 'class' as const,
        filePath: '/test',
        model: 'Test'
      }
    ]);

    const request: CallToolRequest = {
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: {
          query: 'DimensionAttribute',
          type: 'class',
          limit: 20
        }
      }
    };

    const result = await searchTool(request, mockContext);

    expect(result.content).toBeDefined();
    const text = (result.content[0] as any).text;
    
    // Should show results, not suggestions
    expect(text).toContain('Found');
    expect(text).toContain('DimensionAttribute');
    expect(text).not.toContain('🔍 Did you mean?');
  });

  it('should limit number of suggestions', async () => {
    const request: CallToolRequest = {
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: {
          query: 'Dim',
          type: 'class',
          limit: 20
        }
      }
    };

    const result = await searchTool(request, mockContext);

    expect(result.content).toBeDefined();
    const text = (result.content[0] as any).text;
    
    // Count suggestion bullets (should be reasonable, not overwhelming)
    const bulletCount = (text.match(/^• /gm) || []).length;
    expect(bulletCount).toBeGreaterThan(0);
    expect(bulletCount).toBeLessThanOrEqual(10); // Reasonable limit
  });

  it('should provide suggestions even for very different terms', async () => {
    const request: CallToolRequest = {
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: {
          query: 'NonexistentTerm12345',
          type: 'class',
          limit: 20
        }
      }
    };

    const result = await searchTool(request, mockContext);

    expect(result.content).toBeDefined();
    const text = (result.content[0] as any).text;
    
    // Should still provide some suggestions (broader/narrower)
    expect(text.length).toBeGreaterThan(40); // More than just "No results"
    expect(text).toMatch(/Try|Suggestions?|Did you mean|🔎|🎯/i);
  });
});
