/**
 * Tests for get_method_signature tool
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { getMethodSignatureTool } from '../../src/tools/methodSignature.js';
import type { XppServerContext } from '../../src/types/context.js';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex.js';
import path from 'path';
import { promises as fs } from 'fs';
import os from 'os';
import Database from 'better-sqlite3';

describe('get_method_signature tool', () => {
  let context: XppServerContext;
  let tempDbPath: string;
  let tempClassFile: string;

  beforeAll(async () => {
    // Create temp database and files for testing
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'method-sig-test-'));
    tempDbPath = path.join(tempDir, 'test.db');
    tempClassFile = path.join(tempDir, 'TestClass.xml');

    // Create test XML file with method
    const classXml = `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>TestClass</Name>
\t<Methods>
\t\t<Method>
\t\t\t<Name>calculateTotal</Name>
\t\t\t<Source>public static Real calculateTotal(Real price, Integer quantity, Percent discount = 0)
{
\tReal total;
\ttotal = price * quantity;
\tif (discount > 0)
\t{
\t\ttotal = total * (1 - discount / 100);
\t}
\treturn total;
}</Source>
\t\t</Method>
\t\t<Method>
\t\t\t<Name>validate</Name>
\t\t\t<Source>protected boolean validate()
{
\treturn true;
}</Source>
\t\t</Method>
\t</Methods>
</AxClass>`;

    await fs.writeFile(tempClassFile, classXml, 'utf-8');

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
      CREATE INDEX idx_symbols_parent ON symbols(parent_name);
    `);

    // Insert test data
    const insert = db.prepare(`
      INSERT INTO symbols (name, type, parent_name, file_path, model, signature)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    // Insert test class
    insert.run('TestClass', 'class', null, tempClassFile, 'TestModel', null);

    // Insert test methods
    insert.run('calculateTotal', 'method', 'TestClass', tempClassFile, 'TestModel', 
      'public static Real calculateTotal(Real price, Integer quantity, Percent discount = 0)');
    
    insert.run('validate', 'method', 'TestClass', tempClassFile, 'TestModel', 
      'protected boolean validate()');

    const symbolIndex = new XppSymbolIndex(tempDbPath);

    context = {
      symbolIndex,
      parser: {} as any,
      cache: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => {}),
        setClassInfo: vi.fn(async () => {}),
      } as any,
      workspaceScanner: {} as any,
      hybridSearch: {} as any,
      termRelationshipGraph: {} as any,
    };
  });

  it('should extract method signature with parameters', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_method_signature',
        arguments: {
          className: 'TestClass',
          methodName: 'calculateTotal',
        },
      },
    };

    const result = await getMethodSignatureTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    
    expect(text).toContain('TestClass.calculateTotal');
    expect(text).toContain('public');
    expect(text).toContain('static');
    expect(text).toContain('Real');
    expect(text).toContain('price');
    expect(text).toContain('quantity');
    expect(text).toContain('discount');
  });

  it('should generate Chain of Command template', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_method_signature',
        arguments: {
          className: 'TestClass',
          methodName: 'calculateTotal',
          includeCocTemplate: true,
        },
      },
    };

    const result = await getMethodSignatureTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    
    expect(text).toContain('Chain of Command Template');
    expect(text).toContain('[ExtensionOf');
    expect(text).toContain('next calculateTotal');
  });

  it('should extract method signature without parameters', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_method_signature',
        arguments: {
          className: 'TestClass',
          methodName: 'validate',
        },
      },
    };

    const result = await getMethodSignatureTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    
    expect(text).toContain('TestClass.validate');
    expect(text).toContain('protected');
    expect(text).toContain('boolean');
    expect(text).toContain('validate()'); // no parameters — empty parens
  });

  it('should handle non-existent class', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_method_signature',
        arguments: {
          className: 'NonExistentClass',
          methodName: 'someMethod',
        },
      },
    };

    const result = await getMethodSignatureTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('should handle non-existent method', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_method_signature',
        arguments: {
          className: 'TestClass',
          methodName: 'nonExistentMethod',
        },
      },
    };

    const result = await getMethodSignatureTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('should show method modifiers', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_method_signature',
        arguments: {
          className: 'TestClass',
          methodName: 'calculateTotal',
        },
      },
    };

    const result = await getMethodSignatureTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    
    expect(text).toContain('Modifiers:');
    expect(text).toContain('public');
    expect(text).toContain('static');
  });
});
