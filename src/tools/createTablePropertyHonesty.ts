/**
 * Create-path parameter honesty for AxTable.
 *
 * Cluster #35 ("a write op silently drops an optional parameter"), create half.
 * Corpus evidence: eval/corpus/runs/2026-07-22T16__L2-config-key-gated-table__0e1e367.json
 *
 *   d365fo_file(action="create", objectType="table",
 *               properties={ configurationKey: "ConDemoModuleKey" })
 *
 * answered ✅ over an AxTable with no <ConfigurationKey> at all and no warning.
 * The same property IS honoured by the menu-item-display writer, so the caller has
 * no way to guess which writers keep their promises. Root cause: the create goes
 * through the bridge's CreateSmartTable, whose C# SetAxTableProperty() switch has
 * no `configurationkey` (nor `formref`) case — the unknown key hits `default:`,
 * logs to the bridge's stderr, and returns false, which CreateSmartTable ignores.
 *
 * This module closes the hole from the TypeScript side, so it works against an
 * OLD bridge binary too (no rebuild required):
 *
 *   1. Every scalar property the caller passed is reconciled against the XML that
 *      was actually written.
 *   2. A property that did not land but CAN be expressed as an AxTable element is
 *      written on disk in canonical order (upsertAxTableProperty — the same repair
 *      the modify surface already uses for FormRef).
 *   3. Anything left over — a property that does not exist at table level, or one
 *      whose value is not legal for its enum — is REPORTED, never dropped silently.
 *
 * Deliberately conservative: a property that is already present in the document is
 * left exactly as the writer produced it (no value overwriting), and a value that
 * equals the serializer-omitted default counts as honoured rather than being
 * written redundantly. Both rules keep this off the golden-metadata diff.
 */

import {
  AX_TABLE_ELEMENT_ORDER,
  AX_TABLE_NON_EXISTENT_PROPERTIES,
  upsertAxTableProperty,
} from '../utils/axTablePropertyOrder.js';

/** Keys of `properties` that are handled by their own bridge parameter, not as elements. */
const STRUCTURAL_TABLE_KEYS = new Set(
  [
    'fields',
    'fieldgroups',
    'indexes',
    'relations',
    'methods',
    'deleteactions',
    'values',
    'enumvalues',
    'mappings',
    'statemachines',
    'fulltextindexes',
  ].map(k => k.toLowerCase()),
);

/**
 * Enum-typed table properties and their legal values. An illegal value is reported
 * with the legal list instead of being written — the same contract the bridge's
 * add-relation path adopted in 8be57d7 ("'Nonsense' is not a valid RelationshipType.
 * Valid values: …") rather than silently leaving the default in place.
 */
const AX_TABLE_ENUM_VALUES: Record<string, readonly string[]> = {
  TableGroup: [
    'Miscellaneous', 'Parameter', 'Group', 'Main', 'Transaction',
    'WorksheetHeader', 'WorksheetLine', 'TransactionHeader', 'TransactionLine',
    'Reference', 'Framework',
  ],
  CacheLookup: ['None', 'NotInTTS', 'Found', 'FoundAndEmpty', 'EntireTable'],
  TableType: ['Regular', 'RegularTable', 'InMemory', 'TempDB'],
  ValidTimeStateFieldType: ['None', 'Date', 'UtcDateTime'],
  SaveDataPerCompany: ['Yes', 'No'],
  SupportInheritance: ['Yes', 'No'],
  SystemTable: ['Yes', 'No'],
  Visible: ['Yes', 'No'],
};

/** NoYes-typed properties, where `true`/`false` must be spelled Yes/No in XML. */
const NO_YES_PROPERTIES = new Set(['SaveDataPerCompany', 'SupportInheritance', 'SystemTable', 'Visible']);

/**
 * Values the AxTable serializer omits because they ARE the default. Requesting one
 * of these and getting no element back is not a dropped parameter — writing it would
 * add an element no shipped table has.
 */
const AX_TABLE_OMITTED_DEFAULTS: Record<string, readonly string[]> = {
  TableGroup: ['Miscellaneous'],
  CacheLookup: ['NotInTTS'],
  TableType: ['Regular', 'RegularTable'],
  ValidTimeStateFieldType: ['None'],
  SaveDataPerCompany: ['Yes'],
  SupportInheritance: ['No'],
  SystemTable: ['No'],
  Visible: ['Yes'],
};

/**
 * Structural collections that travel as their own bridge parameter, and the AxTable
 * element each one lands in.
 *
 * `generateAxTableXml` — the template the create tool falls back to when the bridge
 * is down — emits a hardcoded `<Indexes />`, `<Relations />` and the five standard
 * field groups, so every index, relation and custom field group the caller passed is
 * dropped on the floor while the response stays the same ✅ as a bridge create. The
 * check below is against the XML that was actually written rather than against a
 * list of "what this writer supports", so it cannot drift out of date the way such a
 * list would.
 */
const TABLE_COLLECTIONS: readonly { key: string; container: string; plural: string; repair: string }[] = [
  { key: 'indexes', container: 'Indexes', plural: 'indexes', repair: 'add-index' },
  { key: 'relations', container: 'Relations', plural: 'relations', repair: 'add-relation' },
  { key: 'fieldGroups', container: 'FieldGroups', plural: 'field groups', repair: 'add-field-group' },
];

/** A collection whose members are absent from the document that was written. */
export interface DroppedCollection {
  /** The `properties` key the caller used. */
  key: string;
  /** How to name these in prose, e.g. "indexes". */
  plural: string;
  /** Names that were requested but are not in the written XML. */
  missing: string[];
  /** modify operation that can add them back. */
  repair: string;
}

/** A property the create writer accepted but could not honour. */
export interface UnhonouredCreateProperty {
  /** The key as the caller spelled it. */
  name: string;
  /** The value the caller asked for. */
  value: string;
  /** Why it could not be written. */
  detail: string;
}

export interface TableCreateReconcileResult {
  /** The document, with every repairable dropped property written back in. */
  xml: string;
  /** Properties that the writer dropped and this repair wrote on disk. */
  patched: { name: string; element: string; value: string }[];
  /** Properties that could not be written at all — must be surfaced to the caller. */
  unhonoured: UnhonouredCreateProperty[];
  /** Structural collections (indexes/relations/field groups) missing from the written XML. */
  droppedCollections: DroppedCollection[];
}

/** Contents of `<Container>…</Container>`, or '' when the element is empty or absent. */
function sectionBody(xml: string, container: string): string {
  if (new RegExp(`<${container}\\s*/>`).test(xml)) return '';
  const m = new RegExp(`<${container}>([\\s\\S]*?)</${container}>`).exec(xml);
  return m ? m[1] : '';
}

/** The name a collection member was requested under, across the spellings the tool accepts. */
function collectionMemberName(item: unknown): string | undefined {
  if (typeof item === 'string') return item;
  if (typeof item !== 'object' || item === null) return undefined;
  const rec = item as Record<string, unknown>;
  const raw = rec.name ?? rec.indexName ?? rec.groupName ?? rec.relationName;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Which of the caller's structural collections are absent from the XML that was
 * written. Membership is checked by name, not by count, because the writer can emit
 * a non-empty container of its OWN making — the five standard field groups are there
 * whether or not the caller's custom group survived.
 */
export function findDroppedTableCollections(
  xml: string,
  properties: Record<string, unknown> | undefined,
): DroppedCollection[] {
  if (!properties) return [];
  const dropped: DroppedCollection[] = [];
  for (const { key, container, plural, repair } of TABLE_COLLECTIONS) {
    const requested = properties[key];
    if (!Array.isArray(requested) || requested.length === 0) continue;
    const body = sectionBody(xml, container);
    const missing = requested
      .map(collectionMemberName)
      .filter((name): name is string =>
        typeof name === 'string' && !new RegExp(`<Name>\\s*${escapeRegExp(name)}\\s*</Name>`, 'i').test(body));
    if (missing.length > 0) dropped.push({ key, plural, missing, repair });
  }
  return dropped;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Canonical AxTable element name for a caller-supplied key, or undefined if unknown. */
function canonicalElement(key: string): string | undefined {
  const lower = key.toLowerCase();
  const known = AX_TABLE_ELEMENT_ORDER.find((e: string) => e.toLowerCase() === lower);
  if (known) return known;
  const nonExistent = Object.keys(AX_TABLE_NON_EXISTENT_PROPERTIES).find(e => e.toLowerCase() === lower);
  if (nonExistent) return nonExistent;
  return undefined;
}

/** Normalise a caller value to its XML spelling (booleans → Yes/No for NoYes props). */
function normaliseValue(element: string | undefined, raw: string | number | boolean): string {
  const s = String(raw);
  if (element && NO_YES_PROPERTIES.has(element)) {
    if (/^(true|yes|1)$/i.test(s)) return 'Yes';
    if (/^(false|no|0)$/i.test(s)) return 'No';
  }
  return s;
}

/** Does the document already carry a non-empty value for this element? */
function elementPresent(xml: string, element: string): boolean {
  const re = new RegExp(`<${element}>\\s*([^<]*?)\\s*</${element}>`);
  const m = re.exec(xml);
  return m ? m[1].length > 0 : false;
}

/**
 * Reconcile the properties the caller asked for against the AxTable XML that was
 * actually written. Only scalar values are considered — collections travel as their
 * own bridge parameters and are checked elsewhere.
 */
export function reconcileTableCreateProperties(
  xml: string,
  properties: Record<string, unknown> | undefined,
): TableCreateReconcileResult {
  const result: TableCreateReconcileResult = { xml, patched: [], unhonoured: [], droppedCollections: [] };
  if (!properties || !/<AxTable[\s>]/.test(xml)) return result;

  result.droppedCollections = findDroppedTableCollections(xml, properties);

  for (const [key, rawValue] of Object.entries(properties)) {
    if (rawValue === undefined || rawValue === null) continue;
    if (!['string', 'number', 'boolean'].includes(typeof rawValue)) continue;
    if (STRUCTURAL_TABLE_KEYS.has(key.toLowerCase())) continue;
    if (String(rawValue).length === 0) continue;

    const element = canonicalElement(key);
    const value = normaliseValue(element, rawValue as string | number | boolean);

    // A name that does not exist at table level — never write it, always say so.
    if (element && AX_TABLE_NON_EXISTENT_PROPERTIES[element]) {
      result.unhonoured.push({ name: key, value, detail: AX_TABLE_NON_EXISTENT_PROPERTIES[element] });
      continue;
    }

    // The writer honoured it (or emitted its own value) — leave the document alone.
    const probe = element ?? key.charAt(0).toUpperCase() + key.slice(1);
    if (elementPresent(result.xml, probe)) continue;

    if (!element) {
      result.unhonoured.push({
        name: key,
        value,
        detail:
          `'${key}' is not a known AxTable property, so the writer could not place it in the ` +
          `order-sensitive property block. Check the spelling against the AxTable metamodel, or ` +
          `pass it through d365fo_file(action="modify", operation="modify-property").`,
      });
      continue;
    }

    // Requested value IS the serializer default — absence is correct, not a drop.
    const omitted = AX_TABLE_OMITTED_DEFAULTS[element];
    if (omitted?.some(d => d.toLowerCase() === value.toLowerCase())) continue;

    const legal = AX_TABLE_ENUM_VALUES[element];
    if (legal && !legal.some(v => v.toLowerCase() === value.toLowerCase())) {
      result.unhonoured.push({
        name: key,
        value,
        detail: `'${value}' is not a valid ${element}. Valid values: ${legal.join(', ')}.`,
      });
      continue;
    }

    const canonicalValue = legal?.find(v => v.toLowerCase() === value.toLowerCase()) ?? value;
    const patchedXml = upsertAxTableProperty(result.xml, element, canonicalValue);
    if (patchedXml) {
      result.xml = patchedXml;
      result.patched.push({ name: key, element, value: canonicalValue });
    } else {
      result.unhonoured.push({
        name: key,
        value,
        detail:
          `<${element}> has no defined position in the AxTable element order, so writing it ` +
          `could corrupt the document (the deserializer drops misordered elements silently). ` +
          `It was NOT written.`,
      });
    }
  }

  return result;
}

/**
 * Caller-facing report for a reconciled table create. Empty string when the writer
 * honoured everything — silence here means "nothing was dropped", which is exactly
 * the guarantee that was missing.
 */
export function renderTableCreateHonestyReport(result: TableCreateReconcileResult): string {
  const parts: string[] = [];
  if (result.droppedCollections.length > 0) {
    parts.push(
      `\n⚠️ NOT APPLIED — the writer that produced this file has no place for:\n` +
        result.droppedCollections
          .map(d => `   • ${d.missing.length} of the requested ${d.plural}: ${d.missing.join(', ')}`)
          .join('\n') +
        `\n   They are NOT in the file on disk. Add them with ` +
        result.droppedCollections.map(d => `d365fo_file(action="modify", operation="${d.repair}")`).join(' / ') +
        `, then re-read the object to confirm.`,
    );
  }
  if (result.patched.length > 0) {
    parts.push(
      `\n🔧 Written after the create (the metadata writer dropped ${result.patched.length === 1 ? 'it' : 'them'}): ` +
        result.patched.map(p => `<${p.element}>${p.value}</${p.element}>`).join(', ') +
        `\n   The C# bridge's SetAxTableProperty() does not know ${result.patched.map(p => p.element).join('/')}; ` +
        `the value was written into the AxTable XML in canonical element order instead.`,
    );
  }
  if (result.unhonoured.length > 0) {
    parts.push(
      `\n⚠️ DROPPED — ${result.unhonoured.length} propert${result.unhonoured.length === 1 ? 'y was' : 'ies were'} ` +
        `accepted but NOT written:\n` +
        result.unhonoured.map(p => `   • ${p.name}=${p.value} — ${p.detail}`).join('\n'),
    );
  }
  return parts.join('\n');
}
