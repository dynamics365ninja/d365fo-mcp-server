/**
 * Tests for get_view_info tool
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { getViewInfoTool } from '../../src/tools/viewInfo.js';
import type { XppServerContext } from '../../src/types/context.js';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex.js';
import path from 'path';
import { promises as fs } from 'fs';
import os from 'os';
import Database from 'better-sqlite3';

describe('get_view_info tool', () => {
  let context: XppServerContext;
  let tempDbPath: string;
  let tempViewFile: string;

  beforeAll(async () => {
    // Create temp database and files for testing
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'view-info-test-'));
    tempDbPath = path.join(tempDir, 'test.db');
    tempViewFile = path.join(tempDir, 'TestView.xml');

    // Create test view XML
    const viewXml = `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>TestDataEntity</Name>
	<Label>@TestModel:TestDataEntityLabel</Label>
\t<IsPublic>Yes</IsPublic>
\t<IsReadOnly>No</IsReadOnly>
\t<PrimaryKey>Key1</PrimaryKey>
\t<Fields>
\t\t<AxDataEntityViewField>
\t\t\t<Name>CustomerAccount</Name>
\t\t\t<DataSource>CustTable</DataSource>
\t\t\t<DataField>AccountNum</DataField>
\t\t</AxDataEntityViewField>
\t\t<AxDataEntityViewField>
\t\t\t<Name>CustomerName</Name>
\t\t\t<DataSource>CustTable</DataSource>
\t\t\t<DataField>Name</DataField>
\t\t</AxDataEntityViewField>
\t\t<AxDataEntityViewField>
\t\t\t<Name>TotalAmount</Name>
\t\t\t<DataMethod>getTotalAmount</DataMethod>
\t\t</AxDataEntityViewField>
\t</Fields>
\t<Relations>
\t\t<AxDataEntityViewRelation>
\t\t\t<Name>CustTransRelation</Name>
\t\t\t<RelatedDataEntity>CustTransEntity</RelatedDataEntity>
\t\t\t<RelationType>Association</RelationType>
\t\t\t<Cardinality>ZeroMore</Cardinality>
\t\t</AxDataEntityViewRelation>
\t</Relations>
\t<Methods>
\t\t<Method>
\t\t\t<Name>getTotalAmount</Name>
\t\t</Method>
\t\t<Method>
\t\t\t<Name>initValue</Name>
\t\t</Method>
\t</Methods>
</AxDataEntityView>`;

    await fs.writeFile(tempViewFile, viewXml, 'utf-8');

    const db = new Database(tempDbPath);
    
    // Create schema matching symbolIndex.ts
    db.exec(`
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        parent_name TEXT,
        signature TEXT,
        file_path TEXT NOT NULL,
        model TEXT NOT NULL,
        description TEXT,
        tags TEXT,
        source_snippet TEXT,
        complexity INTEGER,
        used_types TEXT,
        method_calls TEXT,
        inline_comments TEXT,
        extends_class TEXT,
        implements_interfaces TEXT,
        usage_example TEXT,
        usage_frequency INTEGER DEFAULT 0,
        pattern_type TEXT,
        typical_usages TEXT,
        called_by_count INTEGER DEFAULT 0,
        related_methods TEXT,
        api_patterns TEXT
      );
      
      CREATE INDEX idx_symbols_name ON symbols(name);
      CREATE INDEX idx_symbols_type ON symbols(type);
    `);

    // Insert test data
    const insert = db.prepare(`
      INSERT INTO symbols (name, type, parent_name, file_path, model)
      VALUES (?, ?, ?, ?, ?)
    `);

    // Insert test view
    insert.run('TestDataEntity', 'view', null, tempViewFile, 'TestModel');

    const symbolIndex = new XppSymbolIndex(tempDbPath);

    context = {
      symbolIndex,
      parser: {} as any,
      cache: undefined as any,
      workspaceScanner: {} as any,
      hybridSearch: {} as any,
      termRelationshipGraph: {} as any,
    };
  });

  it('should extract view properties', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_view_info',
        arguments: {
          viewName: 'TestDataEntity',
          includeFields: false,
          includeRelations: false,
          includeMethods: false,
        },
      },
    };

    const result = await getViewInfoTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    
    expect(text).toContain('TestDataEntity');
    expect(text).toContain('**Label:** @TestModel:TestDataEntityLabel');
    expect(text).toContain('**Public:** ✅');
    expect(text).toContain('**Read-Only:** ❌');
    expect(text).toContain('**Primary Key:** Key1');
  });

  it('should extract mapped fields', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_view_info',
        arguments: {
          viewName: 'TestDataEntity',
          includeFields: true,
          includeRelations: false,
          includeMethods: false,
        },
      },
    };

    const result = await getViewInfoTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    
    expect(text).toContain('Mapped Fields');
    expect(text).toContain('CustomerAccount');
    expect(text).toContain('CustTable');
    expect(text).toContain('AccountNum');
    expect(text).toContain('CustomerName');
    expect(text).toContain('Name');
  });

  it('should extract computed fields', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_view_info',
        arguments: {
          viewName: 'TestDataEntity',
          includeFields: true,
          includeRelations: false,
          includeMethods: false,
        },
      },
    };

    const result = await getViewInfoTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    
    expect(text).toContain('Computed Fields');
    expect(text).toContain('TotalAmount');
    expect(text).toContain('getTotalAmount');
  });

  it('should separate mapped and computed fields', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_view_info',
        arguments: {
          viewName: 'TestDataEntity',
          includeFields: true,
          includeRelations: false,
          includeMethods: false,
        },
      },
    };

    const result = await getViewInfoTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    
    // Check that both sections exist
    expect(text).toContain('### Mapped Fields');
    expect(text).toContain('### Computed Fields');
    
    // Check that mapping table exists
    expect(text).toMatch(/\|\s*Field Name\s*\|\s*Data Source\s*\|\s*Data Field\s*\|/);
  });

  it('should extract relations', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_view_info',
        arguments: {
          viewName: 'TestDataEntity',
          includeFields: false,
          includeRelations: true,
          includeMethods: false,
        },
      },
    };

    const result = await getViewInfoTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    
    expect(text).toContain('Relations (1)');
    expect(text).toContain('CustTransRelation');
    expect(text).toContain('CustTransEntity');
    expect(text).toContain('Association');
    expect(text).toContain('ZeroMore');
  });

  it('should extract methods', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_view_info',
        arguments: {
          viewName: 'TestDataEntity',
          includeFields: false,
          includeRelations: false,
          includeMethods: true,
        },
      },
    };

    const result = await getViewInfoTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    
    expect(text).toContain('Methods (2)');
    expect(text).toContain('getTotalAmount');
    expect(text).toContain('initValue');
  });

  it('should show summary statistics', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_view_info',
        arguments: {
          viewName: 'TestDataEntity',
          includeFields: true,
          includeRelations: true,
          includeMethods: true,
        },
      },
    };

    const result = await getViewInfoTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    
    expect(text).toContain('Summary');
    expect(text).toContain('**Total Fields:** 3');
    expect(text).toContain('Mapped Fields: 2');
    expect(text).toContain('Computed Fields: 1');
    expect(text).toContain('**Relations:** 1');
    expect(text).toContain('**Methods:** 2');
  });

  it('should handle non-existent view', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_view_info',
        arguments: {
          viewName: 'NonExistentView',
        },
      },
    };

    const result = await getViewInfoTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('should show field count correctly', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_view_info',
        arguments: {
          viewName: 'TestDataEntity',
          includeFields: true,
        },
      },
    };

    const result = await getViewInfoTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    
    expect(text).toContain('Fields (3)');
  });

  it('should fallback to extracted metadata JSON when XML is not accessible', async () => {
    const fallbackViewName = 'FallbackDataEntity';
    const extractedDir = path.join(process.cwd(), 'extracted-metadata', 'TestModel', 'views');
    const extractedPath = path.join(extractedDir, `${fallbackViewName}.json`);

    await fs.mkdir(extractedDir, { recursive: true });
    await fs.writeFile(
      extractedPath,
      JSON.stringify(
        {
          name: fallbackViewName,
          model: 'TestModel',
          sourcePath: 'C:/inaccessible/path.xml',
          type: 'data-entity',
          label: '@TestModel:FallbackDataEntityLabel',
          isPublic: true,
          isReadOnly: false,
          primaryKey: 'RecId',
          fields: [
            {
              name: 'AccountNum',
              dataSource: 'CustTable',
              dataField: 'AccountNum',
              isComputed: false,
            },
          ],
          relations: [],
          methods: [{ name: 'computeSomething' }],
        },
        null,
        2,
      ),
      'utf-8',
    );

    const insert = context.symbolIndex.db.prepare(`
      INSERT INTO symbols (name, type, parent_name, file_path, model)
      VALUES (?, ?, ?, ?, ?)
    `);
    insert.run(fallbackViewName, 'view', null, 'C:/inaccessible/path.xml', 'TestModel');

    const request = {
      method: 'tools/call',
      params: {
        name: 'get_view_info',
        arguments: {
          viewName: fallbackViewName,
          includeFields: true,
          includeRelations: false,
          includeMethods: true,
        },
      },
    };

    const result = await getViewInfoTool(request as any, context);
    const text = result.content[0].text;

    expect(result.isError).not.toBe(true);
    expect(text).toContain(fallbackViewName);
    expect(text).toContain('**Label:** @TestModel:FallbackDataEntityLabel');
    expect(text).toContain('AccountNum');
    expect(text).toContain('computeSomething');

    await fs.rm(extractedPath, { force: true });
  });
});
