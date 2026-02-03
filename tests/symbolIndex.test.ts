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

  it('should filter search results by type', () => {
    const symbolIndex = new XppSymbolIndex(testDbPath);

    // Add various symbols
    symbolIndex.addSymbol({
      name: 'CustomerTable',
      type: 'table',
      filePath: '/test/CustomerTable.xml',
      model: 'TestModel',
    });

    symbolIndex.addSymbol({
      name: 'CustomerClass',
      type: 'class',
      filePath: '/test/CustomerClass.xml',
      model: 'TestModel',
    });

    symbolIndex.addSymbol({
      name: 'CustomerEnum',
      type: 'enum',
      filePath: '/test/CustomerEnum.xml',
      model: 'TestModel',
    });

    // Search only for classes using prefix search
    const classResults = symbolIndex.searchByPrefix('Customer', ['class'], 10);
    expect(classResults.length).toBeGreaterThan(0);
    expect(classResults.every(r => r.type === 'class')).toBe(true);

    // Search only for tables
    const tableResults = symbolIndex.searchByPrefix('Customer', ['table'], 10);
    expect(tableResults.length).toBeGreaterThan(0);
    expect(tableResults.every(r => r.type === 'table')).toBe(true);

    // Search only for enums
    const enumResults = symbolIndex.searchByPrefix('Customer', ['enum'], 10);
    expect(enumResults.length).toBeGreaterThan(0);
    expect(enumResults.every(r => r.type === 'enum')).toBe(true);

    // Search all types
    const allResults = symbolIndex.searchByPrefix('Customer', undefined, 10);
    expect(allResults.length).toBeGreaterThanOrEqual(3);

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
