/**
 * End-to-End User Scenario Tests
 * Tests real-world user queries to ensure MCP tools work correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchTool } from '../../src/tools/search';
import { tableInfoTool } from '../../src/tools/tableInfo';
import { classInfoTool } from '../../src/tools/classInfo';
import { completionTool } from '../../src/tools/completion';
import { codeGenTool } from '../../src/tools/codeGen';
import { analyzeCodePatternsTool } from '../../src/tools/analyzePatterns';
import { suggestMethodImplementationTool } from '../../src/tools/suggestImplementation';
import type { XppServerContext } from '../../src/types/context';
import type { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

describe('User Scenario Tests', () => {
  let mockContext: XppServerContext;
  let mockSymbolIndex: Partial<XppSymbolIndex>;
  let mockParser: any;

  beforeEach(() => {
    mockSymbolIndex = {
      searchSymbols: vi.fn(),
      getTableFields: vi.fn(),
      getClassMethods: vi.fn(),
      getSymbolByName: vi.fn(),
      getAllSymbolNames: vi.fn(() => []),
      getSymbolsByTerm: vi.fn(() => new Map()),
      getCompletions: vi.fn(() => []),
      analyzeCodePatterns: vi.fn(() => ({
        scenario: 'test',
        totalMatches: 0,
        patterns: [],
        commonMethods: [],
        commonDependencies: [],
      })),
    };

    mockParser = {
      parseTableFile: vi.fn(async () => ({
        success: true,
        data: {
          name: 'TestTable',
          fields: [],
          indexes: [],
          relations: [],
          methods: [],
        },
      })),
      parseClassFile: vi.fn(async () => ({
        success: true,
        data: {
          name: 'TestClass',
          methods: [],
        },
      })),
    };

    mockContext = {
      symbolIndex: mockSymbolIndex as XppSymbolIndex,
      cache: {
        get: vi.fn(async () => null),
        getFuzzy: vi.fn(async () => null),
        set: vi.fn(async () => {}),
        setClassInfo: vi.fn(async () => {}),
        generateSearchKey: vi.fn((query: string) => `key:${query}`),
        generateTableKey: vi.fn((tableName: string) => `table:${tableName}`),
        generateClassKey: vi.fn((className: string) => `class:${className}`),
      } as any,
      parser: mockParser,
      workspaceScanner: {} as any,
      hybridSearch: {} as any,
      termRelationshipGraph: {} as any,
    };
  });

  describe('Scenario 1: What methods are available on SalesTable table related to totals/sums?', () => {
    it('should find methods related to totals on SalesTable', async () => {
      // Mock for table lookup
      mockSymbolIndex.getSymbolByName = vi.fn((name, type) => {
        if (name === 'SalesTable' && type === 'table') {
          return {
            id: 1,
            name: 'SalesTable',
            type: 'table' as const,
            filePath: '/Tables/SalesTable.xml',
            model: 'ApplicationSuite',
          };
        }
        return null;
      });
      
      // Mock parser to return table with methods
      mockParser.parseTableFile = vi.fn(async () => ({
        success: true,
        data: {
          name: 'SalesTable',
          label: 'Sales orders',
          tableGroup: 'Main',
          model: 'ApplicationSuite',
          fields: [],
          indexes: [],
          relations: [],
          methods: [
            {
              name: 'calcTotalAmount',
              signature: 'public Amount calcTotalAmount()',
              source: 'public Amount calcTotalAmount() { return 0; }',
              visibility: 'public',
              returnType: 'Amount',
              isStatic: false,
              parameters: [],
            },
            {
              name: 'sumLineAmount',
              signature: 'public Amount sumLineAmount()',
              source: 'public Amount sumLineAmount() { return 0; }',
              visibility: 'public',
              returnType: 'Amount',
              isStatic: false,
              parameters: [],
            },
            {
              name: 'totalDiscount',
              signature: 'public Amount totalDiscount()',
              source: 'public Amount totalDiscount() { return 0; }',
              visibility: 'public',
              returnType: 'Amount',
              isStatic: false,
              parameters: [],
            },
          ],
        },
      }));

      const request = {
        method: 'tools/call',
        params: {
          name: 'get_table_info',
          arguments: { tableName: 'SalesTable' }
        }
      } as CallToolRequest;

      const result = await tableInfoTool(request, mockContext);

      expect(result.content[0].text).toContain('calcTotalAmount');
      expect(result.content[0].text).toContain('sumLineAmount');
      expect(result.content[0].text).toContain('totalDiscount');
    });
  });

  describe('Scenario 2: Give me a list of fields on VendTable table', () => {
    it('should list all fields on VendTable', async () => {
      mockSymbolIndex.getSymbolByName = vi.fn(() => ({
        id: 1,
        name: 'VendTable',
        type: 'table' as const,
        filePath: '/Tables/VendTable.xml',
        model: 'ApplicationSuite',
      }));
      
      mockSymbolIndex.getTableFields = vi.fn(() => [
        {
          id: 2,
          name: 'AccountNum',
          type: 'field' as const,
          parentName: 'VendTable',
          signature: 'VendAccount AccountNum',
          filePath: '/Tables/VendTable.xml',
          model: 'ApplicationSuite',
        },
        {
          id: 3,
          name: 'Name',
          type: 'field' as const,
          parentName: 'VendTable',
          signature: 'VendName Name',
          filePath: '/Tables/VendTable.xml',
          model: 'ApplicationSuite',
        },
        {
          id: 4,
          name: 'Currency',
          type: 'field' as const,
          parentName: 'VendTable',
          signature: 'CurrencyCode Currency',
          filePath: '/Tables/VendTable.xml',
          model: 'ApplicationSuite',
        },
      ]);
      
      mockParser.parseTableFile = vi.fn(async () => ({
        success: true,
        data: {
          name: 'VendTable',
          model: 'ApplicationSuite',
          sourcePath: '/Tables/VendTable.xml',
          fields: [
            {
              name: 'AccountNum',
              type: 'String',
              extendedDataType: 'VendAccount',
            },
            {
              name: 'Name',
              type: 'String',
              extendedDataType: 'VendName',
            },
            {
              name: 'Currency',
              type: 'String',
              extendedDataType: 'CurrencyCode',
            },
          ],
          indexes: [],
          relations: [],
          methods: [],
        },
      }));

      const request = {
        method: 'tools/call',
        params: {
          name: 'get_table_info',
          arguments: { tableName: 'VendTable' }
        }
      } as CallToolRequest;

      const result = await tableInfoTool(request, mockContext);

      expect(result.content[0].text).toContain('AccountNum');
      expect(result.content[0].text).toContain('Name');
      expect(result.content[0].text).toContain('Currency');
    });
  });

  describe('Scenario 3: Search for classes related to sales invoice posting process', () => {
    it('should find relevant classes for invoice posting', async () => {
      mockSymbolIndex.searchSymbols = vi.fn(() => [
        {
          name: 'SalesFormLetter_Invoice',
          type: 'class' as const,
          filePath: '/Classes/SalesFormLetter_Invoice.xml',
          model: 'ApplicationSuite',
          description: 'Sales invoice posting',
        },
        {
          name: 'SalesInvoiceDP',
          type: 'class' as const,
          filePath: '/Classes/SalesInvoiceDP.xml',
          model: 'ApplicationSuite',
          description: 'Sales invoice data provider',
        },
        {
          name: 'CustInvoiceJour',
          type: 'table' as const,
          filePath: '/Tables/CustInvoiceJour.xml',
          model: 'ApplicationSuite',
          description: 'Customer invoice journal',
        },
      ]);

      const request = {
        method: 'tools/call',
        params: {
          name: 'search',
          arguments: { query: 'sales invoice posting', type: 'class' }
        }
      } as CallToolRequest;

      const result = await searchTool(request, mockContext);

      expect(result.content[0].text).toContain('SalesFormLetter_Invoice');
      expect(mockSymbolIndex.searchSymbols).toHaveBeenCalled();
    });
  });

  describe('Scenario 4: How can I use CoC to extend the insert method on a table?', () => {
    it('should provide CoC extension pattern', async () => {
      mockSymbolIndex.searchSymbols = vi.fn(() => [
        {
          name: 'CustTable',
          type: 'table' as const,
          filePath: '/Tables/CustTable.xml',
          model: 'ApplicationSuite',
        },
      ]);

      const request = {
        method: 'tools/call',
        params: {
          name: 'generate_code',
          arguments: { 
            pattern: 'class',
            name: 'CustTable_Extension',
            description: 'CoC extension for CustTable.insert()'
          }
        }
      } as CallToolRequest;

      const result = await codeGenTool(request);

      expect(result.content[0].text).toContain('class');
      expect(result.content[0].text).toContain('Extension');
    });
  });

  describe('Scenario 5: Create an event handler that validates newly inserted data in InventTrans table', () => {
    it('should generate event handler code', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'generate_code',
          arguments: { 
            pattern: 'class',
            name: 'InventTransEventHandler',
            description: 'Event handler for InventTrans validation on insert'
          }
        }
      } as CallToolRequest;

      const result = await codeGenTool(request);

      expect(result.content[0].text).toContain('class');
      expect(result.content[0].text).toContain('InventTrans');
    });
  });

  describe('Scenario 6: Create a batch job for processing open sales orders', () => {
    it('should generate batch job code', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'generate_code',
          arguments: { 
            pattern: 'batch-job',
            name: 'ProcessOpenSalesOrdersBatch',
            description: 'Batch job to process open sales orders'
          }
        }
      } as CallToolRequest;

      const result = await codeGenTool(request);

      expect(result.content[0].text).toContain('batch');
      expect(result.content[0].text).toContain('process');
    });
  });

  describe('Scenario 7: Create a form extension for CustTable with new button logic', () => {
    it('should generate form extension code', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'generate_code',
          arguments: { 
            pattern: 'form-handler',
            name: 'CustTable_FormExtension',
            description: 'Form extension for CustTable with button logic'
          }
        }
      } as CallToolRequest;

      const result = await codeGenTool(request);

      expect(result.content[0].text).toContain('class');
    });
  });

  describe('Scenario 8: Create methods that create a general ledger journal header and one transaction', () => {
    it('should suggest pattern for ledger journal creation', async () => {
      mockSymbolIndex.analyzeCodePatterns = vi.fn(() => ({
        scenario: 'ledger journal creation',
        totalMatches: 15,
        patterns: [
          { patternType: 'LedgerJournal_Creation', count: 15, examples: ['LedgerJournalCheckPost', 'LedgerJournalTrans_MarkSettlement'] },
        ],
        commonMethods: [
          { name: 'LedgerJournalTable.insert', frequency: 12 },
          { name: 'LedgerJournalTrans.insert', frequency: 12 },
        ],
        commonDependencies: [
          { name: 'LedgerJournalTable', frequency: 15 },
          { name: 'LedgerJournalTrans', frequency: 15 },
        ],
      }));

      const request = {
        method: 'tools/call',
        params: {
          name: 'analyze_code_patterns',
          arguments: { scenario: 'ledger journal creation' }
        }
      } as CallToolRequest;

      const result = await analyzeCodePatternsTool(request, mockContext);

      expect(result.content[0].text).toContain('LedgerJournalTable');
      expect(result.content[0].text).toContain('LedgerJournalTrans');
    });
  });

  describe('Scenario 9: Show me inheritance for SalesFormLetter', () => {
    it('should return class hierarchy', async () => {
      mockSymbolIndex.getSymbolByName = vi.fn(() => ({
        id: 1,
        name: 'SalesFormLetter',
        type: 'class' as const,
        filePath: '/Classes/SalesFormLetter.xml',
        model: 'ApplicationSuite',
        parentName: 'FormLetter',
        extendsClass: 'FormLetter',
      }));
      
      mockSymbolIndex.getClassMethods = vi.fn(() => []);
      
      mockParser.parseClassFile = vi.fn(async () => ({
        success: true,
        data: {
          name: 'SalesFormLetter',
          model: 'ApplicationSuite',
          methods: [],
          extends: 'FormLetter',
          isAbstract: false,
          isFinal: false,
          implements: [],
          declaration: 'public class SalesFormLetter extends FormLetter',
        },
        error: undefined,
      }));

      const request = {
        method: 'tools/call',
        params: {
          name: 'get_class_info',
          arguments: { className: 'SalesFormLetter' }
        }
      } as CallToolRequest;

      const result = await classInfoTool(request, mockContext);

      expect(result.content[0].text).toContain('SalesFormLetter');
      expect(result.content[0].text).toContain('extends');
      expect(result.content[0].text).toContain('FormLetter');
    });
  });

  describe('Scenario 10: Create a helper class for financial dimensions', () => {
    it('should generate helper class with dimension methods', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'generate_code',
          arguments: { 
            pattern: 'class',
            name: 'DimensionHelper',
            description: 'Helper class for creating financial dimensions from main account and dimension values'
          }
        }
      } as CallToolRequest;

      const result = await codeGenTool(request);

      expect(result.content[0].text).toContain('class');
      expect(result.content[0].text).toContain('DimensionHelper');
    });
  });

  describe('Scenario 11: Analyze code patterns for financial dimensions', () => {
    it('should find financial dimension patterns', async () => {
      mockSymbolIndex.analyzeCodePatterns = vi.fn(() => ({
        scenario: 'financial dimensions',
        totalMatches: 25,
        patterns: [
          { patternType: 'Dimension_Helper', count: 10, examples: ['LedgerDimensionFacade', 'DimensionHelper'] },
        ],
        commonMethods: [
          { name: 'DimensionAttributeValueSet::find', frequency: 20 },
        ],
        commonDependencies: [
          { name: 'DimensionAttributeValueSet', frequency: 25 },
          { name: 'DimensionDefault', frequency: 18 },
        ],
      }));

      const request = {
        method: 'tools/call',
        params: {
          name: 'analyze_code_patterns',
          arguments: { scenario: 'financial dimensions' }
        }
      } as CallToolRequest;

      const result = await analyzeCodePatternsTool(request, mockContext);

      expect(result.content[0].text).toContain('Dimension');
    });
  });

  describe('Scenario 12: Suggest implementation for validate method in MyDimensionHelper class', () => {
    it('should suggest validation method implementation', async () => {
      mockSymbolIndex.searchSymbols = vi.fn(() => [
        {
          name: 'validate',
          type: 'method' as const,
          parentName: 'SomeHelper',
          filePath: '/Classes/SomeHelper.xml',
          model: 'ApplicationSuite',
        },
      ]);

      const request = {
        method: 'tools/call',
        params: {
          name: 'suggest_method_implementation',
          arguments: { 
            className: 'MyDimensionHelper',
            methodName: 'validate'
          }
        }
      } as CallToolRequest;

      const result = await suggestMethodImplementationTool(request, mockContext);

      expect(result.content).toBeDefined();
    });
  });

  describe('Scenario 13: What\'s the standard pattern for implementing a number sequence in X++?', () => {
    it('should find number sequence pattern', async () => {
      mockSymbolIndex.analyzeCodePatterns = vi.fn(() => ({
        scenario: 'number sequence implementation',
        totalMatches: 30,
        patterns: [
          { patternType: 'NumberSeq_Usage', count: 30, examples: ['CustTable', 'SalesTable', 'VendTable'] },
        ],
        commonMethods: [
          { name: 'NumberSeq::newGetNum', frequency: 28 },
          { name: 'NumberSeq::num', frequency: 25 },
        ],
        commonDependencies: [
          { name: 'NumberSeq', frequency: 30 },
          { name: 'NumberSequenceTable', frequency: 15 },
        ],
      }));

      const request = {
        method: 'tools/call',
        params: {
          name: 'analyze_code_patterns',
          arguments: { scenario: 'number sequence implementation' }
        }
      } as CallToolRequest;

      const result = await analyzeCodePatternsTool(request, mockContext);

      expect(result.content[0].text).toContain('NumberSeq');
      expect(result.content[0].text).toContain('Pattern');
    });
  });
});
