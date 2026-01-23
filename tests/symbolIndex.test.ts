import { describe, it, expect, beforeAll } from 'vitest';
import { XppSymbolIndex } from '../src/metadata/symbolIndex';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

describe('XppSymbolIndex', () => {
  const testDbPath = join(process.cwd(), 'test-data', 'test-symbols.db');

  beforeAll(() => {
    // Create test directory
    const testDir = join(process.cwd(), 'test-data');
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
    
    // Clean up existing test database
    if (existsSync(testDbPath)) {
      rmSync(testDbPath);
    }
  });

  it('should create a new database with proper schema', () => {
    const symbolIndex = new XppSymbolIndex(testDbPath);
    expect(existsSync(testDbPath)).toBe(true);
    symbolIndex.close();
  });

  it('should add and retrieve symbols', () => {
    const symbolIndex = new XppSymbolIndex(testDbPath);

    symbolIndex.addSymbol({
      name: 'TestClass',
      type: 'class',
      filePath: '/test/path.xml',
      model: 'TestModel',
    });

    const result = symbolIndex.getSymbolByName('TestClass', 'class');
    expect(result).toBeDefined();
    expect(result?.name).toBe('TestClass');
    expect(result?.type).toBe('class');
    expect(result?.model).toBe('TestModel');

    symbolIndex.close();
  });

  it('should search symbols with FTS', () => {
    const symbolIndex = new XppSymbolIndex(testDbPath);

    symbolIndex.addSymbol({
      name: 'CustTable',
      type: 'table',
      filePath: '/test/CustTable.xml',
      model: 'TestModel',
    });

    const results = symbolIndex.searchSymbols('CustTable', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe('CustTable');

    symbolIndex.close();
  });

  it('should return correct symbol count', () => {
    const symbolIndex = new XppSymbolIndex(testDbPath);
    const count = symbolIndex.getSymbolCount();
    expect(count).toBeGreaterThan(0);
    symbolIndex.close();
  });

  it('should retrieve class methods', () => {
    const symbolIndex = new XppSymbolIndex(testDbPath);

    symbolIndex.addSymbol({
      name: 'TestMethod',
      type: 'method',
      parentName: 'TestClass',
      signature: 'void TestMethod()',
      filePath: '/test/path.xml',
      model: 'TestModel',
    });

    const methods = symbolIndex.getClassMethods('TestClass');
    expect(methods.length).toBeGreaterThan(0);
    expect(methods[0].name).toBe('TestMethod');

    symbolIndex.close();
  });
});
