/**
 * What a form needs to know to bind a table field the way the form designer does:
 * is it a surrogate foreign key, and to which table.
 *
 * Dragging such a field onto a form in Visual Studio adds a reference group, not
 * an Int64 control: the user picks the related record by its replacement key
 * (a worker by personnel number) instead of typing a RecId. In 228 shipped
 * ApplicationSuite forms an Int64 field whose EDT derives from RefRecId and whose
 * table relation points at RecId of a table with a replacement key is bound by a
 * reference group 114 times and by an Int64 control once.
 *
 * Pure: the caller reads the files (tools/write/referenceGroupControl.ts).
 */

import { type XmlNode, firstChild, parseNodes, textValueOf } from '../../utils/xmlNodeTree.js';

const ITYPE = /\bi:type\s*=\s*"([^"]+)"/;

function allNamed(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (child.name === name) out.push(child);
    allNamed(child, name, out);
  }
  return out;
}

const childText = (xml: string, node: XmlNode, name: string): string | undefined => {
  const c = firstChild(node, name);
  const v = c && !c.selfClosing ? textValueOf(xml, c).trim() : '';
  return v || undefined;
};

/** Data source name (lower case) → table, from an AxForm or the data sources an AxFormExtension adds. */
export function formDataSourceTables(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const root = parseNodes(xml);
  if (!root) return out;
  for (const ds of allNamed(root, 'AxFormDataSource')) {
    const name = childText(xml, ds, 'Name');
    const table = childText(xml, ds, 'Table');
    if (name && table && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), table);
  }
  return out;
}

export interface TableField {
  /** The field's i:type, e.g. "AxTableFieldInt64". */
  iType?: string;
  edt?: string;
}

/** A field of an AxTable or AxTableExtension, matched case-insensitively; null when the file has none of that name. */
export function tableField(xml: string, fieldName: string): TableField | null {
  const root = parseNodes(xml);
  const fields = root && firstChild(root, 'Fields');
  if (!fields) return null;
  const wanted = fieldName.toLowerCase();
  const field = fields.children.find(f => childText(xml, f, 'Name')?.toLowerCase() === wanted);
  if (!field) return null;
  return {
    iType: ITYPE.exec(xml.slice(field.start, field.openEnd))?.[1],
    edt: childText(xml, field, 'ExtendedDataType'),
  };
}

/** The relation of an AxTable or AxTableExtension that links `fieldName` to RecId of another table. */
export function recIdRelation(xml: string, fieldName: string): { name: string; relatedTable: string } | null {
  const root = parseNodes(xml);
  const relations = root && firstChild(root, 'Relations');
  if (!relations) return null;
  const wanted = fieldName.toLowerCase();
  for (const relation of relations.children) {
    const related = childText(xml, relation, 'RelatedTable');
    const constraints = firstChild(relation, 'Constraints');
    if (!related || !constraints) continue;
    const onField = constraints.children.some(c =>
      childText(xml, c, 'Field')?.toLowerCase() === wanted && childText(xml, c, 'RelatedField')?.toLowerCase() === 'recid');
    if (onField) return { name: childText(xml, relation, 'Name') ?? related, relatedTable: related };
  }
  return null;
}

/** An AxEdt's base EDT and the table it references. */
export function edtLinks(xml: string): { extends?: string; referenceTable?: string } {
  const root = parseNodes(xml);
  if (!root) return {};
  return { extends: childText(xml, root, 'Extends'), referenceTable: childText(xml, root, 'ReferenceTable') };
}

/** An AxTable's ReplacementKey, the index the platform shows a reference by. */
export function replacementKey(xml: string): string | undefined {
  const root = parseNodes(xml);
  return root ? childText(xml, root, 'ReplacementKey') : undefined;
}
