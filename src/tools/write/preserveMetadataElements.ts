/**
 * A write may not silently delete what it was not asked to touch.
 *
 * The bridge's write path is Read → mutate → `IMetadataProvider.Update()`. That
 * round trip goes through the metamodel, so anything the deserializer failed to
 * read — a misordered element, a property this server patched onto the file
 * after the provider's last rebuild — is simply absent from the object it
 * serialises back. Both writes report success. The file is quietly poorer than
 * it was, and "Verified: on disk" only ever asked whether a file exists.
 *
 * The 2026-08-31 capture run of L4-headerlines-document-slice hit it twice in
 * one session (CacheLookup=None, then DeleteAction=Cascade) and neither the
 * 5,779-test suite nor the golden diff could see it: the metadata built with 0
 * errors and read back as plausible.
 *
 * Both root causes are fixed at source — the delete-action element order in
 * directXmlWriters.ts, the refresh ordering in createD365File.ts. This module is
 * the guard that makes the CLASS of defect non-silent, including the instances
 * nobody has found yet:
 *
 *   • compare the file before and after the write;
 *   • an element the operation did not target and that lost its value is put
 *     back, in the position it held;
 *   • what happened is reported in the write's own response.
 *
 * Deliberately narrow, because a wrong restore is worse than a missing one:
 *   • only TOP-LEVEL LEAF elements (`<CacheLookup>None</CacheLookup>`) — never a
 *     collection, whose contents an operation legitimately rewrites;
 *   • never for a `remove-*` operation, and never for the property a
 *     modify-property call names — those are asked-for deletions;
 *   • never for an element the operation ADDED or CHANGED, only for one that
 *     vanished outright.
 */

import { scanXmlLeaves } from '../../utils/xmlScan.js';

/**
 * Top-level leaf elements of the root, in document order: name → raw text.
 *
 * Structure, not indentation, and certainly not "the document with the comments
 * deleted" — that strip is the bug xmlScan.ts exists to stop, and it was flagged
 * here as js/incomplete-multi-character-sanitization on this module's first CI
 * run. A property inside a comment is not a property, and a property nested in a
 * collection is not top-level; scanXmlLeaves distinguishes both.
 */
export function readTopLevelLeaves(xml: string): Map<string, string> {
  const leaves = new Map<string, string>();
  for (const leaf of scanXmlLeaves(xml)) {
    if (leaf.depth === 1 && !leaves.has(leaf.name)) leaves.set(leaf.name, leaf.text);
  }
  return leaves;
}

export interface PreservationResult {
  /** The document to write, with anything restored put back. */
  xml: string;
  /** Elements restored, as `Name=value`. */
  restored: string[];
}

/**
 * Operations whose whole point is to remove something. A missing element after
 * one of these is the caller's intent, not a defect.
 */
const REMOVING_OPERATIONS = new Set([
  'remove-method', 'remove-field', 'remove-index', 'remove-relation',
  'remove-delete-action', 'remove-field-group', 'remove-control',
  'remove-entry-point', 'remove-enum-value', 'remove-query-range',
  'remove-table-mapping', 'remove-full-text-index', 'remove-diagnostic-suppression',
  'replace-all-fields', 'rename-field', 'replace-code',
]);

/**
 * Put back the top-level properties the write dropped without being asked to.
 *
 * `targetedProperty` is the element the operation itself is about (the
 * propertyPath of a modify-property) — that one is the caller's to change or
 * clear, so it is never restored.
 */
export function preserveDroppedProperties(
  before: string,
  after: string,
  operation: string,
  targetedProperty?: string,
): PreservationResult {
  if (REMOVING_OPERATIONS.has(operation)) return { xml: after, restored: [] };

  const beforeLeaves = readTopLevelLeaves(before);
  const afterLeaves = readTopLevelLeaves(after);
  const target = targetedProperty?.toLowerCase();

  const missing = [...beforeLeaves].filter(([name, value]) =>
    value.trim().length > 0 &&
    !afterLeaves.has(name) &&
    name.toLowerCase() !== target &&
    // Identity is not a "property": a document that lost its <Name> is broken in
    // a way this module must not paper over.
    name !== 'Name',
  );
  if (missing.length === 0) return { xml: after, restored: [] };

  // Re-insert each one directly after the element that preceded it in the
  // ORIGINAL document and still exists in the new one — that keeps the canonical
  // order the serialiser is sensitive about, without this module having to own a
  // second copy of the order table.
  const beforeNames = [...beforeLeaves.keys()];
  let xml = after;
  const restored: string[] = [];
  for (const [name, value] of missing) {
    const element = `\t<${name}>${value}</${name}>\n`;
    const idx = beforeNames.indexOf(name);
    let anchored = false;
    for (let i = idx - 1; i >= 0; i--) {
      const prev = beforeNames[i];
      if (!afterLeaves.has(prev)) continue;
      const prevElement = new RegExp(`^\\t<${prev}>[^<]*</${prev}>\\n`, 'm');
      const hit = prevElement.exec(xml);
      if (hit) {
        xml = xml.slice(0, hit.index + hit[0].length) + element + xml.slice(hit.index + hit[0].length);
        anchored = true;
        break;
      }
    }
    if (!anchored) {
      // Nothing to anchor to: put it directly after the root start tag, which is
      // where the first property belongs anyway.
      const rootEnd = /^<Ax\w+[^>]*>\n/m.exec(xml);
      if (!rootEnd) continue;
      const at = rootEnd.index + rootEnd[0].length;
      xml = xml.slice(0, at) + element + xml.slice(at);
    }
    restored.push(`${name}=${value}`);
  }
  return { xml, restored };
}

/** The note a restore earns in the write's response. Empty when nothing moved. */
export function renderPreservationNote(restored: readonly string[]): string {
  if (restored.length === 0) return '';
  return (
    `\n\n🔧 Restored after the write: ${restored.join(', ')}.\n` +
    `The metadata round trip dropped ${restored.length === 1 ? 'it' : 'them'} — ` +
    `${restored.length === 1 ? 'an element' : 'elements'} this operation never touched. ` +
    `Put back from the pre-write file rather than left to disappear silently; ` +
    `re-read the object if you need to be sure of its current shape.`
  );
}

/**
 * Did the value the operation CLAIMED to write actually survive to disk?
 *
 * "✅ Verified: on disk (2,143 bytes)" answers a question nobody was asking. The
 * file existed before the write too. Both silent corruptions in the 2026-08-31
 * capture run were reported with that line under them, and it was true both
 * times — the bytes were on disk, just not the ones the caller asked for.
 *
 * Only operations whose result is a single unambiguous element are checked. A
 * marker that cannot be derived returns null, and a check that cannot be made is
 * not reported as one that passed.
 */
export function claimedMarkerFor(
  operation: string,
  args: Record<string, unknown>,
): { label: string; pattern: RegExp } | null {
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null;

  switch (operation) {
    case 'modify-property': {
      const name = str(args.propertyPath);
      const value = str(args.propertyValue) ?? (args.propertyValue != null ? String(args.propertyValue) : null);
      if (!name || value === null) return null;
      // Only top-level scalar properties: a dotted path addresses something this
      // check cannot see with a regex, and guessing is what got us here.
      if (name.includes('.') || name.includes('/')) return null;
      return {
        label: `${name}=${value}`,
        pattern: new RegExp(`<${escapeRe(name)}>\\s*${escapeRe(value)}\\s*</${escapeRe(name)}>`, 'i'),
      };
    }
    case 'add-delete-action': {
      const name = str(args.deleteActionName) ?? str(args.deleteActionTable);
      const type = str(args.deleteActionType) ?? 'Restricted';
      if (!name) return null;
      return {
        label: `delete action ${name} = ${type}`,
        pattern: new RegExp(
          `<Name>${escapeRe(name)}</Name>\\s*<DeleteAction>${escapeRe(type)}</DeleteAction>`, 'i',
        ),
      };
    }
    case 'add-enum-value': {
      const name = str(args.enumValueName);
      if (!name) return null;
      return { label: `enum value ${name}`, pattern: new RegExp(`<Name>${escapeRe(name)}</Name>`) };
    }
    case 'modify-enum-value': {
      const name = str(args.enumValueName);
      const value = args.enumValueInt;
      if (!name || typeof value !== 'number') return null;
      return {
        label: `enum value ${name} = ${value}`,
        pattern: new RegExp(`<Name>${escapeRe(name)}</Name>(?:\\s*<[^>]+>[^<]*</[^>]+>)*?\\s*<Value>${value}</Value>`),
      };
    }
    default:
      return null;
  }
}

function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The warning an unfulfilled claim earns. Empty when the claim held (or none was checkable). */
export function renderClaimCheck(
  marker: { label: string; pattern: RegExp } | null,
  postImage: string | null,
): string {
  if (!marker || !postImage) return '';
  if (marker.pattern.test(postImage.replace(/\r\n/g, '\n'))) return '';
  return (
    `\n\n❌ Verification: "${marker.label}" is NOT in the file after a reported success.\n` +
    `Treat this write as failed and re-read the object — a metadata round trip can drop a value it ` +
    `could not deserialize, and it does so without an error.`
  );
}
