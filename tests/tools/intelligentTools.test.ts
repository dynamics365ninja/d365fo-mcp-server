import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzeCodePatternsTool } from '../../src/tools/analyzePatterns';
import { suggestMethodImplementationTool } from '../../src/tools/suggestImplementation';
import { analyzeClassCompletenessTool } from '../../src/tools/analyzeCompleteness';
import { getApiUsagePatternsTool } from '../../src/tools/apiUsagePatterns';
import type { XppServerContext } from '../../src/types/context';
import type { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import type { RedisCacheService } from '../../src/cache/redisCache';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

describe('Intelligent Code Generation Tools', () => {
  let mockContext: XppServerContext;
  let mockSymbolIndex: Partial<XppSymbolIndex>;
  let mockCache: Partial<RedisCacheService>;

  beforeEach(() => {
    mockSymbolIndex = {
      analyzeCodePatterns: vi.fn(() => ({
        scenario: 'financial dimensions',
        totalMatches: 15,
        patterns: [{ patternType: 'Helper', count: 10, examples: ['DimHelper1', 'DimHelper2'] }],
        commonMethods: [
          { name: 'addDimension', frequency: 15 },
          { name: 'save', frequency: 12 }
        ],
        commonDependencies: [
          { name: 'DimensionAttributeValueSet', frequency: 15 },
          { name: 'DimensionStorage', frequency: 10 }
        ],
        exampleClasses: ['DimensionAttributeValueSet', 'DimensionStorage']
      })),
      findSimilarMethods: vi.fn(() => [
        {
          className: 'TestHelper',
          methodName: 'validate',
          signature: 'boolean validate()',
          sourceSnippet: 'public boolean validate() { return true; }',
          complexity: 3,
          tags: ['validation', 'helper'],
          patternType: 'Helper'
        }
      ]),
      getClassMethods: vi.fn(() => [
        { name: 'init', signature: 'void init()', type: 'method' as const, filePath: '/Classes/Test.xml', model: 'Test' },
        { name: 'run', signature: 'void run()', type: 'method' as const, filePath: '/Classes/Test.xml', model: 'Test' }
      ]),
      suggestMissingMethods: vi.fn(() => [
        { methodName: 'validate', frequency: 17, totalClasses: 20, percentage: 85 }
      ]),
      getSymbolByName: vi.fn((name) => ({
        name,
        type: 'class' as const,
        filePath: '/Classes/Test.xml',
        model: 'ApplicationSuite',
        patternType: 'Helper'
      })),
      getApiUsagePatterns: vi.fn(() => [
        {
          patternType: 'Initialization',
          usageCount: 25,
          classes: ['DimHelper1', 'DimHelper2'],
          initialization: ['DimensionAttributeValueSet valueSet;', 'valueSet = DimensionAttributeValueSet::construct();'],
          methodSequence: ['valueSet.addDimension(attr, value);', 'valueSet.save();']
        }
      ])
    };

    mockCache = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
    };

    mockContext = {
      symbolIndex: mockSymbolIndex as XppSymbolIndex,
      cache: mockCache as RedisCacheService,
      parser: {} as any,
    };
  });

  describe('analyzeCodePatternsTool', () => {
    it('should analyze code patterns for a scenario', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'analyze_code_patterns',
          arguments: { scenario: 'financial dimensions', limit: 5 }
        }
      } as CallToolRequest;

      const result = await analyzeCodePatternsTool(request, mockContext);

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('DimensionAttributeValueSet');
      expect(mockSymbolIndex.analyzeCodePatterns).toHaveBeenCalledWith('financial dimensions', undefined, 5);
    });

    it('should filter by class pattern', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'analyze_code_patterns',
          arguments: { scenario: 'posting', classPattern: 'Service' }
        }
      } as CallToolRequest;

      const result = await analyzeCodePatternsTool(request, mockContext);

      expect(result).toBeDefined();
      expect(mockSymbolIndex.analyzeCodePatterns).toHaveBeenCalledWith('posting', 'Service', 20);
    });

    it('should use cache when available', async () => {
      const cachedData = {
        scenario: 'test',
        totalMatches: 10,
        patterns: [],
        commonMethods: [],
        commonDependencies: [{ name: 'CachedClass', frequency: 10 }],
        exampleClasses: ['CachedClass']
      };
      mockCache.get = vi.fn().mockImplementation(async <T>(_key: string): Promise<T | null> => cachedData as T);

      const request = {
        method: 'tools/call',
        params: {
          name: 'analyze_code_patterns',
          arguments: { scenario: 'test' }
        }
      } as CallToolRequest;

      const result = await analyzeCodePatternsTool(request, mockContext);

      expect(result.content[0].text).toContain('CachedClass');
      expect(mockSymbolIndex.analyzeCodePatterns).not.toHaveBeenCalled();
    });
  });

  describe('suggestMethodImplementationTool', () => {
    it('should suggest method implementation', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'suggest_method_implementation',
          arguments: { className: 'MyHelper', methodName: 'validate' }
        }
      } as CallToolRequest;

      const result = await suggestMethodImplementationTool(request, mockContext);

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('validate');
      expect(result.content[0].text).toContain('Similar Methods');
      expect(mockSymbolIndex.findSimilarMethods).toHaveBeenCalledWith('validate', 'MyHelper', 5);
    });

    it('should handle no similar methods found', async () => {
      mockSymbolIndex.findSimilarMethods = vi.fn(() => []);

      const request = {
        method: 'tools/call',
        params: {
          name: 'suggest_method_implementation',
          arguments: { className: 'MyHelper', methodName: 'unknownMethod' }
        }
      } as CallToolRequest;

      const result = await suggestMethodImplementationTool(request, mockContext);

      expect(result.content[0].text).toContain('No similar methods found');
    });
  });

  describe('analyzeClassCompletenessTool', () => {
    it('should analyze class completeness', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'analyze_class_completeness',
          arguments: { className: 'TestHelper' }
        }
      } as CallToolRequest;

      const result = await analyzeClassCompletenessTool(request, mockContext);

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('TestHelper');
      expect(result.content[0].text).toContain('Class Completeness Analysis');
      expect(mockSymbolIndex.getSymbolByName).toHaveBeenCalledWith('TestHelper', 'class');
    });

    it('should handle class not found', async () => {
      mockSymbolIndex.getSymbolByName = vi.fn(() => null);

      const request = {
        method: 'tools/call',
        params: {
          name: 'analyze_class_completeness',
          arguments: { className: 'NonExistentClass' }
        }
      } as CallToolRequest;

      const result = await analyzeClassCompletenessTool(request, mockContext);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('should suggest missing methods', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'analyze_class_completeness',
          arguments: { className: 'TestHelper' }
        }
      } as CallToolRequest;

      const result = await analyzeClassCompletenessTool(request, mockContext);

      expect(result.content[0].text).toContain('Suggested Missing Methods');
      expect(result.content[0].text).toContain('validate');
      expect(result.content[0].text).toContain('85%');
    });
  });

  describe('getApiUsagePatternsTool', () => {
    it('should return API usage patterns', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'get_api_usage_patterns',
          arguments: { apiName: 'DimensionAttributeValueSet' }
        }
      } as CallToolRequest;

      const result = await getApiUsagePatternsTool(request, mockContext);

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('API Usage Patterns');
      expect(result.content[0].text).toContain('DimensionAttributeValueSet');
      expect(mockSymbolIndex.getApiUsagePatterns).toHaveBeenCalledWith('DimensionAttributeValueSet');
    });

    it('should handle no patterns found', async () => {
      mockSymbolIndex.getApiUsagePatterns = vi.fn(() => []);

      const request = {
        method: 'tools/call',
        params: {
          name: 'get_api_usage_patterns',
          arguments: { apiName: 'UnknownAPI' }
        }
      } as CallToolRequest;

      const result = await getApiUsagePatternsTool(request, mockContext);

      expect(result.content[0].text).toContain('No usage patterns found');
    });

    it('should show initialization patterns', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'get_api_usage_patterns',
          arguments: { apiName: 'DimensionAttributeValueSet' }
        }
      } as CallToolRequest;

      const result = await getApiUsagePatternsTool(request, mockContext);

      expect(result.content[0].text).toContain('Initialization');
      expect(result.content[0].text).toContain('construct()');
    });
  });
});
