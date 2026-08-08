import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import {
  generateTableMethodSource,
  generateDisplayMethodSource,
} from '../../src/tools/write/modifyD365File';

// Real in-memory symbol index (production schema incl. symbols_fts) — the EDT
// lookup canonicalizes the table name through lookupSymbolNocase, which a
// plain get()-only fake cannot serve.
let index: XppSymbolIndex;
let db: any;

beforeAll(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
  const sym = (name: string, type: string, parentName?: string, signature?: string) =>
    index.addSymbol({ name, type, parentName, signature, filePath: '/x.xml', model: 'Test' } as any);

  sym('MyTable', 'table');
  sym('ItemId', 'field', 'MyTable', 'ItemId');
  // The index stores a base-type keyword (not an EDT) for this field
  sym('ContosoRentEquipmentTable', 'table');
  sym('ContosoRentEquipmentId', 'field', 'ContosoRentEquipmentTable', 'String');
  db = index.getReadDb();
});

afterAll(() => index.close());

describe('generateTableMethodSource', () => {
  it('generates a find method using the resolved key-field EDT', () => {
    const { methodName, source, note } = generateTableMethodSource(
      'MyTable', 'find', 'ItemId', db,
    );
    expect(methodName).toBe('find');
    expect(note).toBeUndefined();
    expect(source).toContain('public static MyTable find(ItemId _itemId, boolean _forUpdate = false)');
    expect(source).toContain('MyTable myTable;');
    expect(source).toContain('select firstonly myTable');
    expect(source).toContain('where myTable.ItemId == _itemId;');
    expect(source).toContain('myTable.selectForUpdate(_forUpdate);');
    // never smuggle XML/CDATA markup into generated X++
    expect(source).not.toContain(']]>');
  });

  it('resolves the EDT for differently-cased table and field names (canonicalized, not full-scanned)', () => {
    const { source, note } = generateTableMethodSource(
      'MyTable', 'find', 'itemid', db,
    );
    expect(note).toBeUndefined();
    // resolved EDT keeps canonical casing; the param name echoes the input
    expect(source).toContain('find(ItemId _itemid,');
  });

  it('falls back to the field name as param type and adds a note when EDT is not indexed', () => {
    const { source, note } = generateTableMethodSource(
      'MyTable', 'find', 'CustomKey', db,
    );
    expect(source).toContain('find(CustomKey _customKey,');
    expect(note).toMatch(/Could not resolve the EDT/i);
  });

  it('ignores a base-type signature ("String") and uses the field name, not an invalid X++ type', () => {
    // The symbol index stores a field's BASE TYPE in signature (e.g. "String"), not its
    // EDT. "String" is not a valid X++ parameter type — the generator must fall back to
    // the field name (conventionally the EDT) rather than emit `find(String _id)`.
    const { source, note } = generateTableMethodSource(
      'ContosoRentEquipmentTable', 'find', 'ContosoRentEquipmentId', db,
    );
    expect(source).toContain('find(ContosoRentEquipmentId _contosoRentEquipmentId,');
    expect(source).not.toMatch(/find\(String /);
    expect(note).toMatch(/Could not resolve the EDT/i);
  });

  it('generates an exist method returning boolean', () => {
    const { methodName, source } = generateTableMethodSource(
      'MyTable', 'exist', 'ItemId', db,
    );
    expect(methodName).toBe('exist');
    expect(source).toContain('public static boolean exist(ItemId _itemId)');
    expect(source).toContain('select firstonly RecId from myTable');
    expect(source).toContain('.RecId != 0;');
  });

  it('throws when find/exist is missing the key field', () => {
    expect(() => generateTableMethodSource('MyTable', 'find', undefined, db))
      .toThrow(/requires tableKeyField/i);
    expect(() => generateTableMethodSource('MyTable', 'exist', undefined, db))
      .toThrow(/requires tableKeyField/i);
  });

  it('generates findByRecId without needing a key field', () => {
    const { methodName, source } = generateTableMethodSource(
      'MyTable', 'findByRecId', undefined, db,
    );
    expect(methodName).toBe('findByRecId');
    expect(source).toContain('public static MyTable findByRecId(RefRecId _recId, boolean _forUpdate = false)');
    expect(source).toContain('where myTable.RecId == _recId;');
  });

  it('generates validateWrite / validateDelete with super() and a boolean return', () => {
    for (const t of ['validateWrite', 'validateDelete'] as const) {
      const { methodName, source } = generateTableMethodSource('MyTable', t, undefined, db);
      expect(methodName).toBe(t);
      expect(source).toContain(`public boolean ${t}()`);
      expect(source).toContain('ret = super();');
      expect(source).toContain('return ret;');
    }
  });

  it('generates initValue calling super()', () => {
    const { methodName, source } = generateTableMethodSource('MyTable', 'initValue', undefined, db);
    expect(methodName).toBe('initValue');
    expect(source).toContain('public void initValue()');
    expect(source).toContain('super();');
  });
});

describe('generateDisplayMethodSource', () => {
  it('generates a display method stub with the given return EDT', () => {
    const source = generateDisplayMethodSource('displayTotal', 'AmountMST');
    expect(source).toContain('public display AmountMST displayTotal()');
    expect(source).toContain('AmountMST ret;');
    expect(source).toContain('return ret;');
    expect(source).not.toContain(']]>');
  });
});
