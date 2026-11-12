/**
 * What a removed table field leaves behind in its own file.
 *
 * The bridge's RemoveField takes the field out of <Fields> and nothing else, so a
 * table or table extension kept every <AxTableFieldGroupField> that named it and
 * the next build failed on a field group pointing at a field that is gone.
 *
 * Two different answers, on purpose:
 *   • a field-group entry is only a listing of the field, so it goes with it;
 *   • an index field, a relation constraint, a title field or a mapping changes
 *     what the table DOES when it is taken away, so those are reported and left
 *     for the caller to decide.
 *
 * Works on the token stream (utils/xmlScan.ts), not on indentation, so CDATA in
 * <Declaration> is never read as markup and a two-space file behaves like a
 * tab-indented one. Names are compared case-insensitively, as X++ does.
 */

import { createXmlTokenScanner } from '../../utils/xmlScan.js';

/** A place in the file that still names the removed field. */
export interface RemainingFieldReference {
  kind: 'index' | 'full-text-index' | 'relation' | 'mapping' | 'property' | 'field-property' | 'other';
  /** One line for the reply: what references the field. */
  what: string;
  /** One line for the reply: the operation that fixes it. */
  fix: string;
}

export interface RemovedFieldCleanup {
  /** The document with the field-group entries removed (the input when none matched). */
  xml: string;
  /** Field groups the field was removed from, in document order. */
  removedFromGroups: string[];
  /** Everything else that still names the field. */
  remaining: RemainingFieldReference[];
}

interface OpenElement {
  name: string;
  /** Offset of the start tag. */
  at: number;
  /** Text of this element's own <Name> child, once seen. */
  ownName?: string;
}

/** Leaf elements whose text is a field of THIS table. */
function isFieldReferenceLeaf(leaf: string): boolean {
  // RelatedField is a field of the related table and MapField a field of the map.
  if (leaf === 'RelatedField' || leaf === 'MapField') return false;
  return leaf === 'MapFieldTo' || /^TitleField\d$/.test(leaf) || /Field$/.test(leaf);
}

/** Where the removal of an element starts: its own line's indentation and line break. */
function lineStartBefore(xml: string, at: number): number {
  let i = at;
  while (i > 0 && (xml[i - 1] === ' ' || xml[i - 1] === '\t')) i--;
  if (i > 0 && xml[i - 1] === '\n') {
    i--;
    if (i > 0 && xml[i - 1] === '\r') i--;
    return i;
  }
  return at;
}

/**
 * Null when the file still defines the field (the removal did not happen, so
 * nothing may be cleaned) or is not a table or table extension.
 */
export function cleanRemovedFieldReferences(xml: string, fieldName: string): RemovedFieldCleanup | null {
  const wanted = fieldName.trim().toLowerCase();
  if (!wanted) return null;

  const stack: OpenElement[] = [];
  let open: { contentAt: number } | null = null;
  /** [start, end) of each field-group entry to cut. */
  const cuts: Array<[number, number]> = [];
  const removedFromGroups: string[] = [];
  const remaining: RemainingFieldReference[] = [];
  /** Indexes that name the field: index name → the note to complete once the roles are known. */
  const indexHits: string[] = [];
  /** Top-level properties that name an index (PrimaryIndex, ClusteredIndex, ReplacementKey). */
  const indexRoles = new Map<string, string[]>();
  /** A group entry whose <DataField> matched, cut when its end tag arrives. */
  let pendingCut: { depth: number; at: number; group: string } | null = null;
  let root = '';

  const scanner = createXmlTokenScanner();
  let token: RegExpExecArray | null;
  while ((token = scanner.exec(xml)) !== null) {
    const closing = token[1];
    const starting = token[2];
    if (!closing && !starting) continue; // comment, CDATA, processing instruction

    if (starting) {
      if (token[4] === '/') { open = null; continue; }
      stack.push({ name: starting, at: token.index });
      if (stack.length === 1) root = starting;
      open = { contentAt: token.index + token[0].length };
      continue;
    }

    // An end tag.
    const depth = stack.length;
    const element = stack[depth - 1];
    if (!element || element.name !== closing) { open = null; stack.pop(); continue; }

    if (open) {
      const text = xml.slice(open.contentAt, token.index).trim();
      const parent = stack[depth - 2];
      if (closing === 'Name' && parent && parent.ownName === undefined) parent.ownName = text;

      const section = stack[1]?.name;
      const entry = stack[2];
      // The field is still there: the removal did not land.
      if (closing === 'Name' && depth === 4 && section === 'Fields' && text.toLowerCase() === wanted) return null;

      if (text.toLowerCase() === wanted && isFieldReferenceLeaf(closing)) {
        const owner = entry?.ownName ?? '(unnamed)';
        if ((section === 'FieldGroups' || section === 'FieldGroupExtensions') && depth === 6 && closing === 'DataField') {
          pendingCut = {
            depth: 5,
            at: stack[4].at,
            group: section === 'FieldGroupExtensions' ? `${owner} (extension of a base table group)` : owner,
          };
        } else if (section === 'Indexes') {
          if (!indexHits.includes(owner)) indexHits.push(owner);
        } else if (section === 'FullTextIndexes') {
          remaining.push({
            kind: 'full-text-index',
            what: `full-text index '${owner}' has it as a field`,
            fix: `operation="remove-full-text-index" (indexName="${owner}"), then operation="add-full-text-index" without the field if the index is still wanted`,
          });
        } else if (section === 'Relations' || section === 'RelationExtensions') {
          remaining.push({
            kind: 'relation',
            what: `relation '${owner}' has a constraint on it`,
            fix: `operation="remove-relation" (relationName="${owner}"), then operation="add-relation" with the constraints that remain if the relation is still wanted`,
          });
        } else if (section === 'Mappings') {
          remaining.push({
            kind: 'mapping',
            what: `mapping to map '${entry?.ownName ?? stack[2]?.name}' connects a map field to it`,
            fix: `operation="remove-table-mapping", then operation="add-table-mapping" with the connections that remain if the mapping is still wanted`,
          });
        } else if (section === 'Fields' && depth >= 4) {
          remaining.push({
            kind: 'field-property',
            what: `field '${owner}' names it in <${closing}>`,
            fix: `operation="modify-field" on '${owner}' to point ${closing} at another field or clear it`,
          });
        } else if (depth === 2) {
          remaining.push({
            kind: 'property',
            what: `table property ${closing} is set to it`,
            fix: `operation="modify-property" (propertyPath="${closing}") with another field, or an empty propertyValue to clear it`,
          });
        } else {
          remaining.push({
            kind: 'other',
            what: `<${closing}> under ${stack.slice(1, depth - 1).map(e => e.name).join(' > ')}${entry?.ownName ? ` ('${entry.ownName}')` : ''}`,
            fix: 'read the object and correct that element with the operation for its collection',
          });
        }
      } else if (depth === 2 && text && (closing === 'PrimaryIndex' || closing === 'ClusteredIndex' || closing === 'ReplacementKey')) {
        const key = text.toLowerCase();
        indexRoles.set(key, [...(indexRoles.get(key) ?? []), closing]);
      }
    }

    if (pendingCut && depth === pendingCut.depth) {
      cuts.push([lineStartBefore(xml, pendingCut.at), token.index + token[0].length]);
      if (!removedFromGroups.includes(pendingCut.group)) removedFromGroups.push(pendingCut.group);
      pendingCut = null;
    }
    open = null;
    stack.pop();
  }

  if (root !== 'AxTable' && root !== 'AxTableExtension') return null;

  const indexReferences: RemainingFieldReference[] = indexHits.map(index => {
    const roles = indexRoles.get(index.toLowerCase());
    return {
      kind: 'index',
      what: `index '${index}' has it as a field${roles ? ` (the index is the table's ${roles.join(' and ')})` : ''}`,
      fix: `operation="remove-index" (indexName="${index}"), then operation="add-index" without the field if the index is still wanted`,
    };
  });

  let out = xml;
  for (const [start, end] of [...cuts].reverse()) {
    let before = out.slice(0, start);
    let after = out.slice(end);
    // The last entry of a group: the serializer writes an empty collection as <Fields />.
    if (/<Fields>[ \t\r\n]*$/.test(before) && /^[ \t\r\n]*<\/Fields>/.test(after)) {
      before = before.replace(/<Fields>[ \t\r\n]*$/, '<Fields />');
      after = after.replace(/^[ \t\r\n]*<\/Fields>/, '');
    }
    out = before + after;
  }

  return { xml: out, removedFromGroups, remaining: [...indexReferences, ...remaining] };
}

/** The lines a remove-field reply gains. Empty when the field was in no group and nothing else names it. */
export function renderRemovedFieldCleanup(fieldName: string, cleanup: RemovedFieldCleanup): string {
  const parts: string[] = [];
  if (cleanup.removedFromGroups.length > 0) {
    parts.push(
      `🔧 Also removed '${fieldName}' from ${cleanup.removedFromGroups.length === 1 ? 'field group' : 'field groups'} ` +
      `${cleanup.removedFromGroups.join(', ')}, so no group is left naming a field that is gone.`,
    );
  }
  if (cleanup.remaining.length > 0) {
    parts.push(
      `⚠️ '${fieldName}' is removed, but this file still references it and will not build until that is fixed. ` +
      `Nothing below was changed, because each one changes what the table does:\n` +
      cleanup.remaining.map(r => `  • ${r.what}. Fix: ${r.fix}.`).join('\n'),
    );
  }
  return parts.join('\n');
}
