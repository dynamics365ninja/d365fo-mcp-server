/**
 * Tests for get_enum_info tool
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { getEnumInfoTool } from '../../src/tools/enumInfo.js';
import type { XppServerContext } from '../../src/types/context.js';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex.js';
import path from 'path';
import { promises as fs } from 'fs';
import os from 'os';
import Database from 'better-sqlite3';

describe('get_enum_info tool', () => {
  let context: XppServerContext;
  let tempDbPath: string;
  let tempEnumFile: string;

  beforeAll(async () => {
    // Create temp database and files for testing
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'enum-info-test-'));
    tempDbPath = path.join(tempDir, 'test.db');
    tempEnumFile = path.join(tempDir, 'TestEnum.xml');

    // Create test enum XML
    const enumXml = `<?xml version="1.0" encoding="utf-8"?>
<AxEnum xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>TestEnum</Name>
\t<IsExtensible>Yes</IsExtensible>
\t<UseEnumValue>No</UseEnumValue>
\t<EnumValues>
\t\t<AxEnumValue>
\t\t\t<Name>None</Name>
\t\t\t<Value>0</Value>
\t\t\t<Label>None</Label>
\t\t</AxEnumValue>
\t\t<AxEnumValue>
\t\t\t<Name>Active</Name>
\t\t\t<Value>1</Value>
\t\t\t<Label>Active</Label>
\t\t</AxEnumValue>
\t\t<AxEnumValue>
\t\t\t<Name>Inactive</Name>
\t\t\t<Value>2</Value>
\t\t\t<Label>Inactive</Label>
\t\t</AxEnumValue>
\t</EnumValues>
</AxEnum>`;

    await fs.writeFile(tempEnumFile, enumXml, 'utf-8');

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

    // Insert test enum
    insert.run('TestEnum', 'enum', null, tempEnumFile, 'TestModel');

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

  it('should extract enum values', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_enum_info',
        arguments: {
          enumName: 'TestEnum',
          includeLabels: true,
        },
      },
    };

    const result = await getEnumInfoTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    
    expect(text).toContain('TestEnum');
    expect(text).toContain('Enum Values (3)');
    expect(text).toContain('None');
    expect(text).toContain('Active');
    expect(text).toContain('Inactive');
    expect(text).toContain('0');
    expect(text).toContain('1');
    expect(text).toContain('2');
  });

  it('should show enum extensibility', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_enum_info',
        arguments: {
          enumName: 'TestEnum',
        },
      },
    };

    const result = await getEnumInfoTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    
    expect(text).toContain('**Extensible:** ✅');
    expect(text).toContain('**Use Enum Value:** ❌');
  });

  it('should include enum value labels', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_enum_info',
        arguments: {
          enumName: 'TestEnum',
          includeLabels: true,
        },
      },
    };

    const result = await getEnumInfoTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    
    // Check table header includes Label column
    expect(text).toContain('| Label');
    expect(text).toContain('Active');
    expect(text).toContain('Inactive');
  });

  it('should exclude labels when requested', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_enum_info',
        arguments: {
          enumName: 'TestEnum',
          includeLabels: false,
        },
      },
    };

    const result = await getEnumInfoTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    
    // Check table header does NOT include Label column
    expect(text).not.toMatch(/\|\s*Label\s*\|/);
  });

  it('should show usage example for enum', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_enum_info',
        arguments: {
          enumName: 'TestEnum',
        },
      },
    };

    const result = await getEnumInfoTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    
    expect(text).toContain('Usage Example');
    expect(text).toContain('TestEnum myEnum = TestEnum::');
    expect(text).toContain('if (myEnum == TestEnum::');
  });

  it('should handle non-existent enum', async () => {
    const request = {
      method: 'tools/call',
      params: {
        name: 'get_enum_info',
        arguments: {
          enumName: 'NonExistentEnum',
        },
      },
    };

    const result = await getEnumInfoTool(request as any, context);

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });
});
