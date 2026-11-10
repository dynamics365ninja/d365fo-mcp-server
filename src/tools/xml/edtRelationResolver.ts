/**
 * Where a field's EDT relation points, for the create's EDT-relation migration
 * (BPErrorEDTNotMigrated, see tableBpDefaults.ts).
 *
 * The EDT's own XML is the authority: its first <AxEdtRelation> (or, failing
 * that, <AxEdtTableReference>) names the table and the related field. The
 * index's edt_metadata.reference_table cannot stand in for it: it holds only
 * the legacy <ReferenceTable> property, which many related EDTs do not carry
 * (CustAccount relates to CustTable.AccountNum through <Relations> alone), and
 * it has no related field at all. It is still used, with the EDT name as the
 * related field, when no XML can be read — the guess generate_object's
 * table-relation mode has always made (ItemId → InventTable.ItemId).
 *
 * Only the field's own EDT is read, not its Extends chain: the checker's message
 * names the field's EDT ("The relation under the extended data type (EDT)
 * 'ItemId' must be migrated"), and an inherited relation is not evidence that
 * the checker asks for one. Best-effort: any failure is a miss, never an error.
 */

import { readIndexedXml } from '../../utils/indexedXmlLookup.js';
import type { EdtRelationTarget } from './tableBpDefaults.js';

/** The relation an AxEdt document declares, or undefined. */
export function edtRelationFromXml(xml: string): EdtRelationTarget | undefined {
  for (const container of ['Relations', 'TableReferences']) {
    const body = new RegExp(`<${container}>([\\s\\S]*?)</${container}>`).exec(xml)?.[1];
    if (!body) continue;
    const table = /<Table>\s*([^<]+?)\s*<\/Table>/.exec(body)?.[1];
    const relatedField = /<RelatedField>\s*([^<]+?)\s*<\/RelatedField>/.exec(body)?.[1];
    if (table && relatedField) return { table, relatedField };
  }
  const legacy = /<ReferenceTable>\s*([^<]+?)\s*<\/ReferenceTable>/.exec(xml)?.[1];
  const name = /<Name>\s*([^<]+?)\s*<\/Name>/.exec(xml)?.[1];
  return legacy && name ? { table: legacy, relatedField: name } : undefined;
}

/** EDT names on the AxTableField elements of a table document. */
export function fieldEdtNames(tableXml: string): string[] {
  const fields = /^[ \t]<Fields>\r?\n([\s\S]*?)^[ \t]<\/Fields>/m.exec(tableXml)?.[1] ?? '';
  const names = new Set<string>();
  for (const m of fields.matchAll(/<ExtendedDataType>\s*([^<]+?)\s*<\/ExtendedDataType>/g)) names.add(m[1]);
  return [...names];
}

/**
 * Resolve the relation of each EDT. `db` is the symbol index's read handle; with
 * none, nothing resolves and the caller writes no relations.
 */
export async function resolveEdtRelations(
  edtNames: readonly string[],
  db: unknown,
): Promise<Record<string, EdtRelationTarget>> {
  const out: Record<string, EdtRelationTarget> = {};
  if (!db) return out;
  await Promise.all(edtNames.map(async edt => {
    try {
      const found = await readIndexedXml(db, edt, ['edt']);
      const fromXml = found ? edtRelationFromXml(found.xml) : undefined;
      if (fromXml) { out[edt] = fromXml; return; }
      if (found) return; // the EDT is known and declares no relation
      const row = (db as any)
        .prepare(`SELECT reference_table FROM edt_metadata WHERE edt_name = ? COLLATE NOCASE AND reference_table IS NOT NULL AND reference_table != '' LIMIT 1`)
        .get(edt) as { reference_table?: string } | undefined;
      if (row?.reference_table) out[edt] = { table: row.reference_table, relatedField: edt };
    } catch {
      /* best-effort */
    }
  }));
  return out;
}
