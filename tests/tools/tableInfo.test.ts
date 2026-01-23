import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tableInfoTool } from '../../src/tools/tableInfo';
import type { XppServerContext } from '../../src/types/context';
import type { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import type { XppMetadataParser } from '../../src/metadata/xmlParser';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

describe('tableInfoTool', () => {
  let mockContext: XppServerContext;
  let mockSymbolIndex: Partial<XppSymbolIndex>;
  let mockParser: Partial<XppMetadataParser>;

  beforeEach(() => {
    mockSymbolIndex = {
      getSymbolByName: vi.fn(() => ({
        id: 1,
        name: 'CustTable',
        type: 'table' as const,
        parentName: undefined,
        signature: undefined,
        filePath: '/Tables/CustTable.xml',
        model: 'ApplicationSuite',
      })),
      getTableFields: vi.fn(() => [
        {
          id: 2,
          name: 'AccountNum',
          type: 'field' as const,
          parentName: 'CustTable',
          signature: 'str AccountNum',
          filePath: '/Tables/CustTable.xml',
          model: 'ApplicationSuite',
        },
      ]),
    };

    mockParser = {
      parseTableFile: vi.fn(async () => ({
        success: true,
        data: {
          name: 'CustTable',
          model: 'ApplicationSuite',
          fields: [
            {
              name: 'AccountNum',
              type: 'String',
              extendedDataType: 'CustAccount',
              mandatory: true,
            },
          ],
          indexes: [],
          relations: [],
          label: 'Customer table',
          tableGroup: 'Main',
          methods: [],
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
        generateTableKey: vi.fn((tableName: string) => `table:${tableName}`),
      } as any,
    };
  });

  it('should return table information from XML', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'xpp_get_table',
        arguments: { tableName: 'CustTable' }
      }
    } as CallToolRequest;

    const result = await tableInfoTool(request, mockContext);

    expect(result).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('CustTable');
    expect(result.content[0].text).toContain('AccountNum');
    expect(mockParser.parseTableFile).toHaveBeenCalled();
  });

  it('should fallback to database when XML parsing fails', async () => {
    mockParser.parseTableFile = vi.fn(async () => ({
      success: false,
      data: undefined,
      error: 'XML parsing error',
    }));

    const request = {
      method: 'tools/call',
      params: {
        name: 'xpp_get_table',
        arguments: { tableName: 'CustTable' }
      }
    } as CallToolRequest;

    const result = await tableInfoTool(request, mockContext);

    expect(result).toBeDefined();
    expect(result.content[0].text).toContain('CustTable');
    expect(result.content[0].text).toContain('symbol index data');
    expect(mockSymbolIndex.getTableFields).toHaveBeenCalledWith('CustTable');
  });

  it('should handle table not found', async () => {
    mockSymbolIndex.getSymbolByName = vi.fn(() => null);

    const request = {
      method: 'tools/call',
      params: {
        name: 'xpp_get_table',
        arguments: { tableName: 'NonExistentTable' }
      }
    } as CallToolRequest;

    const result = await tableInfoTool(request, mockContext);

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
        name: 'xpp_get_table',
        arguments: { tableName: 'CustTable' }
      }
    } as CallToolRequest;

    const result = await tableInfoTool(request, mockContext);

    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Error');
  });
});
