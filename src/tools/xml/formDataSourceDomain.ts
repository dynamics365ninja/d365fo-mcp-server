/**
 * Whether every data source of a form is a Local table, which decides what xppbp
 * expects on a Display menu item that opens it: "The Expected value for
 * OperationalDomain property is Local, because the OperationalDomain property on
 * all data sources is Local." (and SubscriberAccessLevel No Access). Any other form
 * keeps the usual Shared + Read.
 *
 * A data source table's OperationalDomain is its own element when it has one,
 * otherwise what the BP rules give it (TempDB, InMemory or Staging → Local). The
 * form and its tables are read through the index (file, or stored copy).
 */

import { readIndexedXml } from '../../utils/indexedXmlLookup.js';
import { expectedTableBpDefaults, menuItemKindOf, tableBpInputsFromXml } from '../../utils/bpCreateDefaults.js';

/** The tables of a form's own data sources (not those of a form extension). */
export function formDataSourceTables(formXml: string): string[] {
  const tables: string[] = [];
  for (const m of formXml.matchAll(/<AxFormDataSource\b[^>]*>([\s\S]*?)(?:<Fields\b|<\/AxFormDataSource>)/g)) {
    const table = /<Table>\s*([^<]+?)\s*<\/Table>/.exec(m[1])?.[1];
    if (table) tables.push(table);
  }
  return [...new Set(tables)];
}

/** A table's OperationalDomain: its own element, else what the BP rules expect for it. */
export function tableOperationalDomain(tableXml: string): string {
  const own = /^[ \t]*<OperationalDomain>\s*([^<]+?)\s*<\/OperationalDomain>/m.exec(tableXml)?.[1];
  return own ?? expectedTableBpDefaults(tableBpInputsFromXml(tableXml)).operationalDomain;
}

/**
 * True when the form has data sources and every one of their tables is Local,
 * false when one is not, undefined when the form or a table could not be read
 * (the caller then keeps the usual default rather than guess).
 */
export async function formDataSourcesAllLocal(formName: string, db: unknown): Promise<boolean | undefined> {
  if (!db || !formName) return undefined;
  try {
    const form = await readIndexedXml(db, formName, ['form']);
    if (!form) return undefined;
    const tables = formDataSourceTables(form.xml);
    if (tables.length === 0) return undefined;
    for (const t of tables) {
      const table = await readIndexedXml(db, t, ['table']);
      if (!table) return undefined;
      if (tableOperationalDomain(table.xml) !== 'Local') return false;
    }
    return true;
  } catch {
    return undefined;
  }
}

/**
 * For a menu item document: whether it is a Display item on a form whose data
 * sources are all Local. Undefined for any other menu item, or when unknown.
 */
export async function menuItemFormAllLocal(menuItemXml: string, db: unknown): Promise<boolean | undefined> {
  const root = /<(AxMenuItem(?:Action|Display|Output))[\s>]/.exec(menuItemXml);
  if (!root || menuItemKindOf(root[1]) !== 'Display') return undefined;
  const objectType = /^[ \t]*<ObjectType>\s*([^<]*?)\s*<\/ObjectType>/m.exec(menuItemXml)?.[1] || 'Form';
  if (!/^form$/i.test(objectType)) return undefined;
  const form = /^[ \t]*<Object>\s*([^<]+?)\s*<\/Object>/m.exec(menuItemXml)?.[1];
  return form ? formDataSourcesAllLocal(form, db) : undefined;
}
