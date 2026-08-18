/**
 * Removal of one control from an AxForm or AxFormExtension, in place.
 *
 * The inverse of insertFormExtensionControl (see formExtensionControlXml.ts) and
 * of the bridge's AddControl, and it has the same reason for existing as
 * directXmlDeleteAction: there is no C# operation for it, so the only way to
 * take a button off a form was d365fo_file(action="create", overwrite=true) —
 * rewriting the whole form from hand-authored XML, which loses every collection
 * the caller did not think to re-type.
 *
 * Two things make this more than a string replace:
 *
 *  1. Controls NEST. A button lives inside a ButtonGroup inside an ActionPane
 *     inside <Design>/<Controls>, and every level is another <Controls>. The
 *     target is found by walking the tree, not by matching a `<Name>` substring
 *     — the latter also matches data sources, data fields, the form's own
 *     <Name>, and every override method's <Name>.
 *
 *  2. A form EXTENSION expresses a control in two shapes (see
 *     formExtensionControlXml.ts): a bare <AxFormControl> nested under a
 *     container the extension owns, or an <AxFormExtensionControl> envelope in
 *     the extension's root <Controls> whose real control sits under
 *     <FormControl>. Deleting the <FormControl> out of an envelope leaves the
 *     envelope behind — a control-less wrapper with a <Parent> reference, which
 *     is not a shape the deserializer expects. The whole envelope goes.
 *
 * Separators: a toolbar button is almost always followed by an
 * <AxFormButtonSeparatorControl>, which exists only to space that button from
 * the next one. Removing the button and leaving the separator puts a stray
 * divider on the ActionPane, so `removeSeparator` drops the adjacent one too —
 * opt-in, because "adjacent separator" is a layout judgement and a separator
 * between two REMAINING buttons is load-bearing.
 *
 * Pure and side-effect-free; the file I/O stays in the caller.
 */

import {
  type XmlNode, parseNodes, firstChild, textValueOf,
} from './xmlNodeTree.js';

/** Element name of the separator control, as it appears in `i:type`. */
const SEPARATOR_ITYPE = 'AxFormButtonSeparatorControl';

/** Roots this writer will touch. Anything else is declined, never guessed at. */
const SUPPORTED_ROOTS = new Set(['AxForm', 'AxFormExtension']);

export interface RemoveFormControlSpec {
  /** <Name> of the control to remove (case-insensitive). */
  controlName: string;
  /**
   * Also remove an adjacent AxFormButtonSeparatorControl sibling — the one after
   * the control, or the one before it when there is nothing after. Off by
   * default.
   */
  removeSeparator?: boolean;
}

export type RemoveFormControlResult =
  /** Control removed. `removed` names every control element deleted, in file order. */
  | { kind: 'removed'; xml: string; removed: string[]; notes: string[] }
  /** No control of that name. `present` lists the ones there are, for the error. */
  | { kind: 'not-found'; present: string[] }
  /** Not a form/form-extension shape this writer recognises; the caller declines. */
  | { kind: 'unsupported' };

/** A control node plus the element that has to be deleted to remove it. */
interface ControlEntry {
  /** The control itself — <AxFormControl> or an envelope's <FormControl>. */
  control: XmlNode;
  /** The node to delete: the control, or the <AxFormExtensionControl> around it. */
  target: XmlNode;
  /** The <Controls> collection `target` is a direct child of, when there is one. */
  collection: XmlNode | undefined;
  name: string;
}

/** Every control element in the file, with the node that removes it. */
function collectControls(xml: string, root: XmlNode): ControlEntry[] {
  const entries: ControlEntry[] = [];

  const visit = (node: XmlNode, envelope: XmlNode | undefined, collection: XmlNode | undefined): void => {
    for (const child of node.children) {
      if (child.name === 'AxFormControl' || child.name === 'FormControl') {
        const nameNode = firstChild(child, 'Name');
        const name = nameNode ? textValueOf(xml, nameNode) : '';
        if (name) {
          // Inside an envelope the deletable unit is the envelope: an
          // <AxFormExtensionControl> without its <FormControl> carries a
          // <Parent> pointing at a control it no longer defines.
          const target = child.name === 'FormControl' && envelope ? envelope : child;
          entries.push({ control: child, target, collection, name });
        }
      }
      const nextEnvelope = child.name === 'AxFormExtensionControl' ? child : envelope;
      const nextCollection = child.name === 'Controls' ? child : collection;
      visit(child, nextEnvelope, nextCollection);
    }
  };

  // The root's own <Controls> is found by the walk itself, so start with none.
  visit(root, undefined, undefined);
  return entries;
}

/**
 * The control elements a <Controls> collection holds directly — envelopes
 * included, since an envelope IS one entry of the collection.
 */
function directControlChildren(collection: XmlNode): XmlNode[] {
  return collection.children.filter(
    c => c.name === 'AxFormControl' || c.name === 'AxFormExtensionControl',
  );
}

/** True when this control element (or the control inside its envelope) is a separator. */
function isSeparator(xml: string, node: XmlNode): boolean {
  if (openTagOf(xml, node).includes(SEPARATOR_ITYPE)) return true;
  const inner = firstChild(node, 'FormControl');
  return inner ? openTagOf(xml, inner).includes(SEPARATOR_ITYPE) : false;
}

const openTagOf = (xml: string, node: XmlNode): string => xml.slice(node.start, node.openEnd);

/**
 * The byte range to cut for `node`: the node itself, plus its own indentation
 * and the newline that ends its last line, so no blank line is left behind.
 */
function spanOf(xml: string, node: XmlNode): [number, number] {
  const lineStart = xml.lastIndexOf('\n', node.start - 1) + 1;
  const before = xml.slice(lineStart, node.start);
  const from = /^[ \t]*$/.test(before) ? lineStart : node.start;

  let to = node.end;
  while (to < xml.length && (xml[to] === ' ' || xml[to] === '\t')) to++;
  if (xml[to] === '\r') to++;
  if (xml[to] === '\n') to++;
  return [from, to];
}

/**
 * Remove `spec.controlName` from a form or form extension.
 *
 * Returns the updated XML with every untouched byte preserved, or a result that
 * says why nothing was written — never a silent no-op.
 */
export function removeFormControl(
  xml: string,
  spec: RemoveFormControlSpec,
): RemoveFormControlResult {
  const root = parseNodes(xml);
  // Refuse anything that is not a form, so a mis-typed objectType can never cut
  // elements out of an unrelated metadata file.
  if (!root || !SUPPORTED_ROOTS.has(root.name)) return { kind: 'unsupported' };

  const entries = collectControls(xml, root);
  const wanted = spec.controlName.trim().toLowerCase();
  const entry = entries.find(e => e.name.toLowerCase() === wanted);
  if (!entry) {
    return { kind: 'not-found', present: entries.map(e => e.name) };
  }

  const notes: string[] = [];
  const doomed: Array<{ node: XmlNode; name: string }> = [{ node: entry.target, name: entry.name }];

  if (spec.removeSeparator) {
    const separator = findAdjacentSeparator(xml, entry, entries);
    if (separator) {
      doomed.push(separator);
      notes.push(
        `removed the adjacent separator "${separator.name}" as well — it only spaced ` +
        `"${entry.name}" from its neighbour.`,
      );
    } else {
      notes.push(
        `removeSeparator was set, but "${entry.name}" has no adjacent ` +
        `${SEPARATOR_ITYPE} sibling — nothing extra was removed.`,
      );
    }
  }

  // The collection is emptied when every control element it holds directly is on
  // the list. An empty <Controls></Controls> is not what the serializer writes —
  // shipped metadata spells an empty collection `<Controls />` — so collapse it.
  const collection = entry.collection;
  const emptied =
    collection !== undefined &&
    directControlChildren(collection).every(c => doomed.some(d => d.node === c));

  let updated: string;
  if (emptied && collection) {
    // Replaced from '<Controls' onward, so the line's existing indentation stands.
    updated = xml.slice(0, collection.start) + '<Controls />' + xml.slice(collection.end);
  } else {
    // Descending by offset so an earlier cut never shifts a later one.
    const spans = doomed
      .map(d => spanOf(xml, d.node))
      .sort((a, b) => b[0] - a[0]);
    updated = xml;
    for (const [from, to] of spans) {
      updated = updated.slice(0, from) + updated.slice(to);
    }
  }

  return {
    kind: 'removed',
    xml: updated,
    removed: doomed
      .slice()
      .sort((a, b) => a.node.start - b.node.start)
      .map(d => d.name),
    notes,
  };
}

/**
 * The separator sibling that belongs to `entry`: the control element directly
 * after it in the same <Controls>, else the one directly before it.
 *
 * After-first because that is how the designer emits them — button, separator,
 * button — so the separator following a button is the one that button owns.
 */
function findAdjacentSeparator(
  xml: string,
  entry: ControlEntry,
  entries: readonly ControlEntry[],
): { node: XmlNode; name: string } | null {
  const collection = entry.collection;
  if (!collection) return null;

  const siblings = directControlChildren(collection);
  const at = siblings.indexOf(entry.target);
  if (at < 0) return null;

  for (const candidate of [siblings[at + 1], siblings[at - 1]]) {
    if (!candidate || !isSeparator(xml, candidate)) continue;
    const named = entries.find(e => e.target === candidate);
    return { node: candidate, name: named?.name ?? '(unnamed separator)' };
  }
  return null;
}
