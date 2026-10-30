/**
 * find_references — the "you used a form name as a class" hint is for a name
 * looked up AS a class.
 *
 * The owner of a member was checked the same way, so a field's table always
 * read as "not a class": `SalesTable.SalesId` with targetType "field" came back
 * with "⚠️ Type Mismatch: `SalesTable` is not a class", though no class was
 * asked for. A method's owner may just as well be a table, form or view.
 */
import { describe, expect, it } from 'vitest';
import { findReferencesTool } from '../../src/tools/analysis/findReferences';

/** A read DB for the name-based fallback: no code rows, object types by name. */
function fakeDb(types: Record<string, string[]>) {
  return {
    prepare: (sql: string) => ({
      get: () => undefined,
      all: (arg: string) =>
        sql.includes('SELECT DISTINCT type, model') ? (types[arg] ?? []).map(type => ({ type, model: 'M' })) : [],
    }),
  };
}

// No bridge in the context: the lookup takes the name-based fallback, where the hint is printed.
const run = async (args: Record<string, unknown>, db: any) =>
  (await findReferencesTool(
    { method: 'tools/call', params: { name: 'find_references', arguments: args } } as any,
    { symbolIndex: { getReadDb: () => db, db } } as any,
  )).content[0].text as string;

describe('find_references — the owner of a member is not checked as a class', () => {
  // As in the standard application: SalesTable is both a table and a form, and no class.
  const db = fakeDb({ SalesTable: ['form', 'table'] });

  it('does not call a field\'s table "not a class"', async () => {
    const text = await run({ targetName: 'SalesTable.SalesId', targetType: 'field' }, db);
    expect(text).not.toContain('Type Mismatch');
  });

  it('does not call a method\'s table "not a class", qualified or through ownerName', async () => {
    const qualified = await run({ targetName: 'SalesTable.initFromSalesQuotationTable', targetType: 'method' }, db);
    const viaOwner = await run({ targetName: 'initFromSalesQuotationTable', ownerName: 'SalesTable', targetType: 'method' }, db);
    expect(qualified).not.toContain('Type Mismatch');
    expect(viaOwner).not.toContain('Type Mismatch');
  });

  it('still flags a table or form name looked up as a class', async () => {
    const text = await run({ targetName: 'SalesTable', targetType: 'class' }, db);
    expect(text).toContain('⚠️ **Type Mismatch:** `SalesTable` is not a **class**');
  });
});
