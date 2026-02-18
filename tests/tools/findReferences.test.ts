/**
 * Tests for find_references tool
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { findReferencesTool } from '../../src/tools/findReferences.js';
import type { XppServerContext } from '../../src/types/context.js';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex.js';
import path from 'path';
import { promises as fs } from 'fs';
import os from 'os';
import Database from 'better-sqlite3';

describe('find_references tool', () => {
  let context: XppServerContext;
  let tempDbPath: string;

  beforeAll(async () => {
    // Create temp database for testing
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'find-refs-test-'));
    tempDbPath = path.join(tempDir, 'test.db');

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
      INSERT INTO symbols (name, type, parent_name, file_path, model, source_snippet, extends_class, implements_interfaces)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Insert test class
    insert.run('TestHelper', 'class', null, '/test/TestHelper.xml', 'TestModel', null, 'Object', null);

    // Insert test methods that reference TestHelper.validate()
    insert.run('process', 'method', 'CustomerService', '/test/CustomerService.xml', 'TestModel', 
      'public void process()\n{\n    TestHelper helper = new TestHelper();\n    helper.validate();\n}', null, null);
    
    insert.run('validate', 'method', 'OrderService', '/test/OrderService.xml', 'TestModel', 
      '    if (!TestHelper::validate(order))\n    {\n        throw error("Invalid");\n    }', null, null);

    // Insert class that extends TestHelper
    insert.run('CustomHelper', 'class', null, '/test/CustomHelper.xml', 'TestModel', null, 'TestHelper', null);

    // Insert class that instantiates TestHelper
    insert.run('run', 'method', 'TestJob', '/test/TestJob.xml', 'TestModel', 
      'public void run()\n{\n    TestHelper helper = new TestHelper();\n    helper.execute();\n}', null, null);

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

  it('should find method call references', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'find_references',
        arguments: {
          targetName: 'validate',
          targetType: 'method',
          scope: 'all',
          limit: 50,
        },
      },
    };

    const result = await findReferencesTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('validate');
    expect(result.content[0].text).toContain('Total References Found');
  });

  it('should find class extension references', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'find_references',
        arguments: {
          targetName: 'TestHelper',
          targetType: 'class',
          scope: 'all',
          limit: 50,
        },
      },
    };

    const result = await findReferencesTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    expect(text).toContain('TestHelper');
    expect(text).toContain('extends');
  });

  it('should find instantiation references', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'find_references',
        arguments: {
          targetName: 'TestHelper',
          targetType: 'class',
          scope: 'all',
          limit: 50,
        },
      },
    };

    const result = await findReferencesTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    expect(text).toContain('TestHelper');
    expect(text).toContain('instantiation');
  });

  it('should return no references for non-existent symbol', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'find_references',
        arguments: {
          targetName: 'NonExistentMethod',
          targetType: 'method',
          scope: 'all',
          limit: 50,
        },
      },
    };

    const result = await findReferencesTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('No references found');
  });

  it('should group references by type', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'find_references',
        arguments: {
          targetName: 'TestHelper',
          targetType: 'class',
          scope: 'all',
          limit: 50,
        },
      },
    };

    const result = await findReferencesTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    expect(text).toContain('Summary by Type');
  });

  it('should limit results correctly', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'find_references',
        arguments: {
          targetName: 'TestHelper',
          targetType: 'class',
          scope: 'all',
          limit: 1,
        },
      },
    };

    const result = await findReferencesTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    expect(text).toContain('**Showing:** 1');
  });
});
