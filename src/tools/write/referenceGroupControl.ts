/**
 * add-control and reference groups: which control type a field gets when the caller
 * names none, and how a reference group reaches a plain form.
 *
 * Dragging a surrogate foreign key (an Int64 field whose EDT derives from RefRecId,
 * related to RecId of another table) onto a form in Visual Studio adds a reference
 * group, which shows the related record by its replacement key. add-control picked
 * the EDT's base type instead, so the same field became an Int64 control showing a
 * RecId. The rule below follows what shipped forms do (tools/xml/surrogateForeignKey.ts);
 * an explicit controlType always wins.
 */

import * as fs from 'fs/promises';
import { bridgeAddControl } from '../../bridge/bridgeAdapter.js';
import type { BridgeClient } from '../../bridge/bridgeClient.js';
import { findBaseObjectXml } from '../../utils/baseObjectXml.js';
import { findAotFilesInAllPackages } from '../../utils/objectFileLookup.js';
import {
  edtLinks, formDataSourceTables, recIdRelation, replacementKey, tableField,
} from '../xml/surrogateForeignKey.js';
import { directXmlModifyControlProperty } from './directXmlWriters.js';

export interface AddControlTypeArgs {
  controlType?: string;
  controlDataSource?: string;
  controlDataField?: string;
}

const isReferenceGroup = (controlType: string | undefined): boolean =>
  controlType?.toLowerCase() === 'referencegroup';

/** An EDT chain can be deep (SalesTaker → HcmWorkerRecId → RefRecId); a cycle must not hang the call. */
const MAX_EDT_DEPTH = 12;

const AOT_FOLDERS: Record<string, string> = { form: 'AxForm', table: 'AxTable', edt: 'AxEdt' };

/**
 * findBaseObjectXml, else every package folder. A write-only companion has no index,
 * and findBaseObjectXml then looks in the configured model only, so SalesTable,
 * SalesTaker and HcmWorker were never found there — on the server where add-control
 * runs in a hybrid setup. Same fallback findBaseObjectXml uses for menus.
 */
async function readObjectXml(objectType: string, name: string, symbolIndex: unknown): Promise<string | null> {
  const found = await findBaseObjectXml(objectType, name, symbolIndex).catch(() => null);
  if (found) return found;
  const fileName = `${name.toLowerCase()}.xml`;
  const [file] = await findAotFilesInAllPackages(AOT_FOLDERS[objectType], n => n.toLowerCase() === fileName).catch(() => []);
  return file ? fs.readFile(file, 'utf-8').catch(() => null) : null;
}

interface SurrogateForeignKey {
  table: string;
  field: string;
  edt: string;
  /** "relation <name>" or "ReferenceTable of EDT <name>": where the link to the related table came from. */
  via: string;
  relatedTable: string;
  replacementKey?: string;
}

/**
 * The control type add-control writes: the caller's, a reference group for a
 * surrogate foreign key whose related table has a replacement key, or `fallback`
 * (the EDT's base type). `note` says why, for the reply.
 */
export async function pickAddControlType(
  args: AddControlTypeArgs,
  objectType: string,
  objectName: string,
  filePath: string,
  symbolIndex: unknown,
  fallback: string,
): Promise<{ controlType: string; note: string }> {
  if (args.controlType || !args.controlDataSource || !args.controlDataField) return { controlType: fallback, note: '' };
  const sfk = await surrogateForeignKey(objectType, objectName, filePath, args.controlDataSource, args.controlDataField, symbolIndex)
    .catch(() => null);
  if (!sfk) return { controlType: fallback, note: '' };
  // The field is known to be Int64 here, whatever the EDT guess behind `fallback` said.
  const subject = `${sfk.table}.${sfk.field} is a surrogate foreign key to ${sfk.relatedTable} (EDT ${sfk.edt}, ${sfk.via})`;
  if (!sfk.replacementKey) {
    return {
      controlType: 'Int64',
      note: `\n\n> ℹ️ ${subject}, but ${sfk.relatedTable} has no replacement key, so it was added as an ` +
        `Int64 control. Pass controlType="ReferenceGroup" for a reference group anyway.`,
    };
  }
  return {
    controlType: 'ReferenceGroup',
    note: `\n\n> 🔗 controlType "ReferenceGroup": ${subject}, shown by its replacement key ${sfk.replacementKey} — ` +
      `the control the form designer adds for this field. Pass controlType="Int64" for a plain Int64 control instead.`,
  };
}

async function surrogateForeignKey(
  objectType: string,
  objectName: string,
  filePath: string,
  dataSource: string,
  fieldName: string,
  symbolIndex: unknown,
): Promise<SurrogateForeignKey | null> {
  const table = await dataSourceTable(objectType, objectName, filePath, dataSource, symbolIndex);
  const tableXmls = await tableAndExtensionXmls(table, symbolIndex);
  const owner = tableXmls.find(x => tableField(x, fieldName));
  const field = owner ? tableField(owner, fieldName) : null;
  if (!owner || field?.iType !== 'AxTableFieldInt64' || !field.edt) return null;

  // The EDT chain must reach RefRecId; the first ReferenceTable on it is the fallback link.
  let referenceTable: { edt: string; table: string } | undefined;
  let reachesRefRecId = false;
  let edt: string | undefined = field.edt;
  for (let depth = 0; edt && depth < MAX_EDT_DEPTH; depth++) {
    if (['refrecid', 'recid'].includes(edt.toLowerCase())) { reachesRefRecId = true; break; }
    const xml = await readObjectXml('edt', edt, symbolIndex);
    if (!xml) break;
    const links = edtLinks(xml);
    if (links.referenceTable && !referenceTable) referenceTable = { edt, table: links.referenceTable };
    edt = links.extends;
  }
  if (!reachesRefRecId) return null;

  // The relation is usually where the field is, but an extension can relate a base field.
  const relation = [owner, ...tableXmls].map(x => recIdRelation(x, fieldName)).find(Boolean) ?? null;
  const relatedTable = relation?.relatedTable ?? referenceTable?.table;
  if (!relatedTable) return null;
  const relatedXml = await readObjectXml('table', relatedTable, symbolIndex);
  return {
    table,
    field: fieldName,
    edt: field.edt,
    via: relation ? `relation ${relation.name}` : `ReferenceTable of EDT ${referenceTable!.edt}`,
    relatedTable,
    replacementKey: relatedXml ? replacementKey(relatedXml) : undefined,
  };
}

/** The table a data source binds: from the form (for an extension, the base form too), else its own name. */
async function dataSourceTable(
  objectType: string,
  objectName: string,
  filePath: string,
  dataSource: string,
  symbolIndex: unknown,
): Promise<string> {
  const xmls = [await fs.readFile(filePath, 'utf-8').catch(() => '')];
  if (objectType === 'form-extension') {
    xmls.push(await readObjectXml('form', objectName.split('.')[0], symbolIndex) ?? '');
  }
  for (const xml of xmls) {
    const table = formDataSourceTables(xml).get(dataSource.toLowerCase());
    if (table) return table;
  }
  return dataSource;
}

/** The table's XML, then its extensions' (a custom field lives in one): from the index, else the package folders. */
async function tableAndExtensionXmls(table: string, symbolIndex: any): Promise<string[]> {
  const base = await readObjectXml('table', table, symbolIndex);
  const prefix = `${table.toLowerCase()}.`;
  let names: string[] = [];
  try {
    const rows = symbolIndex.getReadDb()
      .prepare(`SELECT DISTINCT name FROM symbols WHERE type = 'table-extension' AND name LIKE ?`)
      .all(`${table}.%`) as { name: string }[];
    // LIKE reads `_` as a wildcard, so the prefix is confirmed here.
    names = rows.map(r => r.name).filter(n => n.toLowerCase().startsWith(prefix));
  } catch { /* no index */ }
  let extensions: Array<string | null>;
  if (names.length > 0) {
    extensions = await Promise.all(names.map(n => findBaseObjectXml('table-extension', n, symbolIndex).catch(() => null)));
  } else {
    const files = await findAotFilesInAllPackages('AxTableExtension', f => {
      const lower = f.toLowerCase();
      return lower.startsWith(prefix) && lower.endsWith('.xml');
    }).catch(() => []);
    extensions = await Promise.all(files.map(f => fs.readFile(f, 'utf-8').catch(() => null)));
  }
  return [base, ...extensions].filter((x): x is string => !!x);
}

/**
 * add-control on a plain form through the bridge. A reference group has no DataField:
 * the bridge creates it bound to the data source only, and its ReferenceField is then
 * written into the saved file, in the order shipped reference groups use.
 */
export async function bridgeAddFormControl(
  bridge: BridgeClient | undefined,
  filePath: string,
  formName: string,
  args: AddControlTypeArgs & { controlName: string; parentControl: string; controlLabel?: string },
  controlType: string,
): Promise<{ success: boolean; message: string } | null> {
  const referenceGroup = isReferenceGroup(controlType);
  const added = await bridgeAddControl(
    bridge, formName, args.controlName, args.parentControl, controlType,
    args.controlDataSource, referenceGroup ? undefined : args.controlDataField, args.controlLabel,
  );
  if (!referenceGroup || !added?.success || !args.controlDataField) return added;
  const bound = await directXmlModifyControlProperty(
    filePath, 'form', formName, 'ReferenceField', args.controlDataField, args.controlName,
  ).catch((err: unknown) => ({ success: false, message: err instanceof Error ? err.message : String(err) }));
  // The control IS on the form: a failed binding is a warning on a success, never ❌.
  return {
    success: true,
    message: bound?.success
      ? `${added.message}\n${bound.message}`
      : `${added.message}\n⚠️ Not bound to a field: ReferenceField could not be set (${bound?.message ?? 'control not found'}). ` +
        `Set it with modify-property, controlName="${args.controlName}", propertyPath="ReferenceField".`,
  };
}
