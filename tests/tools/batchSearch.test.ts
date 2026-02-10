import { describe, it, expect, vi, beforeEach } from 'vitest';
import { batchSearchTool } from '../../src/tools/batchSearch';
import type { XppServerContext } from '../../src/types/context';
import type { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import type { RedisCacheService } from '../../src/cache/redisCache';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

describe('batchSearchTool', () => {
  let mockContext: XppServerContext;
  let mockSymbolIndex: Partial<XppSymbolIndex>;
  let mockCache: Partial<RedisCacheService>;

  beforeEach(() => {
    mockSymbolIndex = {
      searchSymbols: vi.fn((query: string) => {
        if (query === 'dimension') {
          return [
            {
              id: 1,
              name: 'DimensionAttribute',
              type: 'class' as const,
              parentName: undefined,
              signature: undefined,
              filePath: '/Classes/DimensionAttribute.xml',
              model: 'Dimensions',
            },
          ];
        } else if (query === 'helper') {
          return [
            {
              id: 2,
              name: 'CustTableHelper',
              type: 'class' as const,
              parentName: undefined,
              signature: undefined,
              filePath: '/Classes/CustTableHelper.xml',
              model: 'ApplicationSuite',
            },
          ];
        }
        return [];
      }),
    };

    mockCache = {
      get: vi.fn(async () => null),
      getFuzzy: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      generateSearchKey: vi.fn((query: string, limit?: number, type?: string) => `search:${query}:${type||'all'}:${limit||20}`),
    };

    mockContext = {
      symbolIndex: mockSymbolIndex as XppSymbolIndex,
      cache: mockCache as RedisCacheService,
      parser: {} as any,
      workspaceScanner: {} as any,
      hybridSearch: {} as any,
    };
  });

  it('should execute multiple searches in parallel', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'batch_search',
        arguments: {
          queries: [
            { query: 'dimension', type: 'class', limit: 5 },
            { query: 'helper', type: 'class', limit: 5 },
          ]
        }
      }
    } as CallToolRequest;

    const result = await batchSearchTool(request, mockContext);

    expect(result).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Batch Search Results');
    expect(result.content[0].text).toContain('dimension');
    expect(result.content[0].text).toContain('helper');
    expect(result.content[0].text).toContain('DimensionAttribute');
    expect(result.content[0].text).toContain('CustTableHelper');
    
    // Verify both searches were called
    expect(mockSymbolIndex.searchSymbols).toHaveBeenCalledWith('dimension', 5, ['class']);
    expect(mockSymbolIndex.searchSymbols).toHaveBeenCalledWith('helper', 5, ['class']);
  });

  it('should display execution time and performance metrics', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'batch_search',
        arguments: {
          queries: [
            { query: 'dimension' },
            { query: 'helper' },
          ]
        }
      }
    } as CallToolRequest;

    const result = await batchSearchTool(request, mockContext);

    expect(result.content[0].text).toContain('Executed:');
    expect(result.content[0].text).toContain('Time:');
    expect(result.content[0].text).toContain('ms');
    expect(result.content[0].text).toContain('Performance Note');
    expect(result.content[0].text).toContain('parallel execution');
  });

  it('should handle single query', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'batch_search',
        arguments: {
          queries: [
            { query: 'dimension', limit: 10 }
          ]
        }
      }
    } as CallToolRequest;

    const result = await batchSearchTool(request, mockContext);

    expect(result).toBeDefined();
    expect(result.content[0].text).toContain('1 parallel query');
    expect(mockSymbolIndex.searchSymbols).toHaveBeenCalledTimes(1);
  });

  it('should handle empty results', async () => {
    mockSymbolIndex.searchSymbols = vi.fn(() => []);

    const request = {
      method: 'tools/call',
      params: {
        name: 'batch_search',
        arguments: {
          queries: [
            { query: 'nonexistent' },
            { query: 'missing' },
          ]
        }
      }
    } as CallToolRequest;

    const result = await batchSearchTool(request, mockContext);

    expect(result).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Batch Search Results');
  });

  it('should handle individual query errors gracefully', async () => {
    mockSymbolIndex.searchSymbols = vi.fn((query: string) => {
      if (query === 'error') {
        throw new Error('Search failed');
      }
      return [
        {
          id: 1,
          name: 'ValidClass',
          type: 'class' as const,
          parentName: undefined,
          signature: undefined,
          filePath: '/Classes/ValidClass.xml',
          model: 'Test',
        },
      ];
    });

    const request = {
      method: 'tools/call',
      params: {
        name: 'batch_search',
        arguments: {
          queries: [
            { query: 'valid' },
            { query: 'error' },
          ]
        }
      }
    } as CallToolRequest;

    const result = await batchSearchTool(request, mockContext);

    expect(result).toBeDefined();
    // The error will be shown in the query result, but success count might still be 2/2
    // because searchTool returns a result object even on error (with isError flag)
    expect(result.content[0].text).toContain('Query 2: "error"');
    expect(result.content[0].text).toContain('Error searching symbols: Search failed');
  });

  it('should validate query array limits', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'batch_search',
        arguments: {
          queries: [] // Empty array
        }
      }
    } as CallToolRequest;

    const result = await batchSearchTool(request, mockContext);

    expect(result).toBeDefined();
    expect(result.isError).toBe(true);
  });

  it('should respect query-specific parameters', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'batch_search',
        arguments: {
          queries: [
            { query: 'dimension', type: 'class', limit: 3 },
            { query: 'helper', type: 'table', limit: 7 },
          ]
        }
      }
    } as CallToolRequest;

    await batchSearchTool(request, mockContext);

    expect(mockSymbolIndex.searchSymbols).toHaveBeenCalledWith('dimension', 3, ['class']);
    expect(mockSymbolIndex.searchSymbols).toHaveBeenCalledWith('helper', 7, ['table']);
  });

  it('should show speedup calculation', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'batch_search',
        arguments: {
          queries: [
            { query: 'a' },
            { query: 'b' },
            { query: 'c' },
          ]
        }
      }
    } as CallToolRequest;

    const result = await batchSearchTool(request, mockContext);

    expect(result.content[0].text).toContain('faster');
    // Accept both normal speedup calculation and "too fast to measure" message
    expect(result.content[0].text).toMatch(/(\d+(\.\d+)?x faster|~\d+(\.\d+)?x faster)/);
  });
});
