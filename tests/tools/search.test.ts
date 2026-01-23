import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchTool } from '../../src/tools/search';
import type { XppServerContext } from '../../src/types/context';
import type { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import type { RedisCacheService } from '../../src/cache/redisCache';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

describe('searchTool', () => {
  let mockContext: XppServerContext;
  let mockSymbolIndex: Partial<XppSymbolIndex>;
  let mockCache: Partial<RedisCacheService>;

  beforeEach(() => {
    mockSymbolIndex = {
      searchSymbols: vi.fn(() => [
        {
          id: 1,
          name: 'CustTable',
          type: 'table' as const,
          parentName: undefined,
          signature: undefined,
          filePath: '/Tables/CustTable.xml',
          model: 'ApplicationSuite',
        },
        {
          id: 2,
          name: 'createCustomer',
          type: 'method' as const,
          parentName: 'CustTable',
          signature: 'void createCustomer()',
          filePath: '/Tables/CustTable.xml',
          model: 'ApplicationSuite',
        },
      ]),
    };

    mockCache = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      generateSearchKey: vi.fn((query: string, limit?: number) => `search:${query}:${limit||20}`),
    };

    mockContext = {
      symbolIndex: mockSymbolIndex as XppSymbolIndex,
      cache: mockCache as RedisCacheService,
      parser: {} as any,
    };
  });

  it('should return search results', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'xpp_search',
        arguments: { query: 'CustTable' }
      }
    } as CallToolRequest;

    const result = await searchTool(request, mockContext);

    expect(result).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('CustTable');
    expect(result.content[0].text).toContain('createCustomer');
    expect(mockSymbolIndex.searchSymbols).toHaveBeenCalledWith('CustTable', 20);
  });

  it('should handle empty query', async () => {
    mockSymbolIndex.searchSymbols = vi.fn(() => []);

    const request = {
      method: 'tools/call',
      params: {
        name: 'xpp_search',
        arguments: { query: '' }
      }
    } as CallToolRequest;

    const result = await searchTool(request, mockContext);

    expect(result).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('No X++ symbols found');
  });

  it('should use cache when available', async () => {
    const cachedData = [
      { name: 'CachedClass', type: 'class', model: 'TestModel' },
    ];
    mockCache.get = vi.fn(async () => cachedData) as any;

    const request = {
      method: 'tools/call',
      params: {
        name: 'xpp_search',
        arguments: { query: 'test' }
      }
    } as CallToolRequest;

    const result = await searchTool(request, mockContext);

    expect(mockCache.get).toHaveBeenCalled();
    expect(result.content[0].text).toContain('CachedClass');
  });

  it('should respect maxResults parameter', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'xpp_search',
        arguments: { query: 'test', limit: 5 }
      }
    } as CallToolRequest;

    await searchTool(request, mockContext);

    expect(mockSymbolIndex.searchSymbols).toHaveBeenCalledWith('test', 5);
  });

  it('should handle errors gracefully', async () => {
    mockSymbolIndex.searchSymbols = vi.fn(() => {
      throw new Error('Database error');
    });

    const request = {
      method: 'tools/call',
      params: {
        name: 'xpp_search',
        arguments: { query: 'test' }
      }
    } as CallToolRequest;

    const result = await searchTool(request, mockContext);

    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Error');
  });
});
