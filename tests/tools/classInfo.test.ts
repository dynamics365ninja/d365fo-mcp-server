import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classInfoTool } from '../../src/tools/classInfo';
import type { XppServerContext } from '../../src/types/context';
import type { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import type { XppMetadataParser } from '../../src/metadata/xmlParser';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

describe('classInfoTool', () => {
  let mockContext: XppServerContext;
  let mockSymbolIndex: Partial<XppSymbolIndex>;
  let mockParser: Partial<XppMetadataParser>;

  beforeEach(() => {
    mockSymbolIndex = {
      getSymbolByName: vi.fn(() => ({
        id: 1,
        name: 'TestClass',
        type: 'class' as const,
        parentName: undefined,
        signature: undefined,
        filePath: '/Classes/TestClass.xml',
        model: 'ApplicationSuite',
      })),
      getClassMethods: vi.fn(() => [
        {
          id: 2,
          name: 'init',
          type: 'method' as const,
          parentName: 'TestClass',
          signature: 'void init()',
          filePath: '/Classes/TestClass.xml',
          model: 'ApplicationSuite',
        },
      ]),
    };

    mockParser = {
      parseClassFile: vi.fn(async () => ({
        success: true,
        data: {
          name: 'TestClass',
          model: 'ApplicationSuite',
          methods: [
            {
              name: 'init',
              parameters: [],
              returnType: 'void',
              modifiers: ['public'],
              visibility: 'public' as const,
              isStatic: false,
              documentation: '',
              source: 'public void init() { }',
            },
          ],
          extends: undefined,
          isAbstract: false,
          isFinal: false,
          implements: [],
          declaration: 'public class TestClass',
        },
        error: undefined,
      })),
    };

    mockContext = {
      symbolIndex: mockSymbolIndex as XppSymbolIndex,
      parser: mockParser as XppMetadataParser,
      cache: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => {}),
        generateClassKey: vi.fn((className: string) => `class:${className}`),
      } as any,
    };
  });

  it('should return class information from XML', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_class_info',
        arguments: { className: 'TestClass' }
      }
    } as CallToolRequest;

    const result = await classInfoTool(request, mockContext);

    expect(result).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('TestClass');
    expect(result.content[0].text).toContain('init');
    expect(mockParser.parseClassFile).toHaveBeenCalled();
  });

  it('should fallback to database when XML parsing fails', async () => {
    mockParser.parseClassFile = vi.fn(async () => ({
      success: false,
      data: undefined,
      error: 'XML parsing error',
    }));

    const request = {
      method: 'tools/call',
      params: {
        name: 'get_class_info',
        arguments: { className: 'TestClass' }
      }
    } as CallToolRequest;

    const result = await classInfoTool(request, mockContext);

    expect(result).toBeDefined();
    expect(result.content[0].text).toContain('TestClass');
    expect(result.content[0].text).toContain('symbol index data');
    expect(mockSymbolIndex.getClassMethods).toHaveBeenCalledWith('TestClass');
  });

  it('should handle class not found', async () => {
    mockSymbolIndex.getSymbolByName = vi.fn(() => null);

    const request = {
      method: 'tools/call',
      params: {
        name: 'get_class_info',
        arguments: { className: 'NonExistentClass' }
      }
    } as CallToolRequest;

    const result = await classInfoTool(request, mockContext);

    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('not found');
  });

  it('should handle errors gracefully', async () => {
    mockSymbolIndex.getSymbolByName = vi.fn(() => {
      throw new Error('Database error');
    });

    const request = {
      method: 'tools/call',
      params: {
        name: 'get_class_info',
        arguments: { className: 'TestClass' }
      }
    } as CallToolRequest;

    const result = await classInfoTool(request, mockContext);

    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Error');
  });
});
