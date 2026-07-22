/**
 * Canonical element order for AxTable XML.
 *
 * AxTable documents are ORDER-SENSITIVE and the deserializer drops misordered
 * property elements SILENTLY: the property is physically in the file, `validate_code`
 * happily reports "no violations", and xppbp then complains that it is missing
 * (BPErrorTableTitleField1NotDeclared / BPErrorLabelNotDefined /
 * BPErrorDeveloperDocumentationNotDefined) with no clue why.
 * See docs/eval-sweep-findings-2026-07-21.md #13.
 *
 * Ground truth for the order below:
 *   - eval/goldens/L1-table-basic/DemoAgentNote.metadata.xml (VM-captured, built clean):
 *       Label → TableGroup → TitleField1 → TitleField2 →
 *       CacheLookup → ClusteredIndex → PrimaryIndex → ReplacementKey → DeleteActions
 *   - the sweep's own comparison against the shipped CustGroup.xml.
 *
 * Two blocks, each internally alphabetical:
 *   1. the "always serialised" block (ConfigurationKey … TitleField2)
 *   2. the extended/optional block (CacheLookup … TableType)
 * Collections (<DeleteActions>, <FieldGroups>, <Fields>, …) follow both.
 */

/** Block 1 — properties the serialiser always writes, in order. */
export const AX_TABLE_MANDATORY_PROPERTIES = [
  'ConfigurationKey',
  'DeveloperDocumentation',
  'FormRef',
  'Label',
  'TableGroup',
  'TitleField1',
  'TitleField2',
] as const;

/** Block 2 — extended properties, alphabetical, written only when set. */
export const AX_TABLE_EXTENDED_PROPERTIES = [
  'CacheLookup',
  'ClusteredIndex',
  'CreatedBy',
  'CreatedDateTime',
  'CreatedTransactionId',
  'Modules',
  'ModifiedBy',
  'ModifiedDateTime',
  'ModifiedTransactionId',
  'PrimaryIndex',
  'ReplacementKey',
  'SaveDataPerCompany',
  'SupportInheritance',
  'SystemTable',
  'TableType',
  'ValidTimeStateFieldType',
  'Visible',
] as const;

/** The collection elements that terminate the property block, in serialised order. */
export const AX_TABLE_COLLECTIONS = [
  'DeleteActions',
  'FieldGroups',
  'Fields',
  'FullTextIndexes',
  'Indexes',
  'Mappings',
  'Relations',
  'StateMachines',
] as const;

/** Full canonical order of everything that follows <SourceCode>. */
export const AX_TABLE_ELEMENT_ORDER: readonly string[] = [
  ...AX_TABLE_MANDATORY_PROPERTIES,
  ...AX_TABLE_EXTENDED_PROPERTIES,
  ...AX_TABLE_COLLECTIONS,
];

/**
 * Table-level property names that DO NOT EXIST in the AxTable metadata model and
 * are therefore silently ignored (or worse, make the document unreadable).
 * `AlternateKey` is index-level only — `<AxTableIndex><AlternateKey>Yes</AlternateKey>`
 * — but reads so naturally at table level that both the writer surface and the
 * validator missed it (findings #13).
 */
export const AX_TABLE_NON_EXISTENT_PROPERTIES: Record<string, string> = {
  AlternateKey:
    'AlternateKey is an INDEX property, not a table property. Put <AlternateKey>Yes</AlternateKey> ' +
    'inside the <AxTableIndex> that should act as the alternate key.',
  PrimaryKey:
    'There is no table-level PrimaryKey property. Use <PrimaryIndex> (and <ReplacementKey>) ' +
    'naming an existing index.',
  Index:
    'Indexes are declared as <AxTableIndex> entries inside <Indexes>, not as a table property.',
};

/** Canonical position of an element; unknown names sort last but keep relative order. */
export function axTableElementRank(name: string): number {
  const i = AX_TABLE_ELEMENT_ORDER.indexOf(name);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

/**
 * Render a property map as canonically ordered `<Tag>value</Tag>` lines.
 * Entries whose value is undefined/null/'' are omitted — an empty
 * `<TitleField1 />` is not the same as an absent one to xppbp, and the shipped
 * tables omit properties they do not set.
 *
 * @param props  property name → value
 * @param indent line prefix (default one tab, matching AxTable XML)
 */
export function renderAxTableProperties(
  props: Record<string, string | number | undefined | null>,
  indent = '\t',
): string {
  const names = Object.keys(props)
    .filter(n => props[n] !== undefined && props[n] !== null && String(props[n]).length > 0)
    .sort((a, b) => {
      const ra = axTableElementRank(a);
      const rb = axTableElementRank(b);
      return ra !== rb ? ra - rb : a.localeCompare(b);
    });
  return names.map(n => `${indent}<${n}>${props[n]}</${n}>\n`).join('');
}

/**
 * Insert (or replace) a single table-level property in an AxTable XML document,
 * keeping canonical order. Returns null when the document is not an AxTable or
 * the property is one that does not exist at table level.
 *
 * Used by the modify surface so a missing property (e.g. FormRef, which the C#
 * bridge's setProperty rejects outright — findings #37) can still be written
 * without corrupting the element order.
 */
export function upsertAxTableProperty(
  xml: string,
  property: string,
  value: string,
): string | null {
  if (!/<AxTable[\s>]/.test(xml)) return null;
  if (AX_TABLE_NON_EXISTENT_PROPERTIES[property]) return null;
  if (axTableElementRank(property) === Number.MAX_SAFE_INTEGER) return null;

  const existing = new RegExp(`([ \\t]*)<${property}\\s*/>|([ \\t]*)<${property}>[\\s\\S]*?</${property}>`);
  if (existing.test(xml)) {
    return xml.replace(existing, (m) => {
      const indent = m.match(/^[ \t]*/)?.[0] ?? '\t';
      return `${indent}<${property}>${value}</${property}>`;
    });
  }

  // Find the first element that must come AFTER this one and insert before it.
  const rank = axTableElementRank(property);
  for (const candidate of AX_TABLE_ELEMENT_ORDER) {
    if (axTableElementRank(candidate) <= rank) continue;
    const re = new RegExp(`^([ \\t]*)<${candidate}(\\s*/>|>)`, 'm');
    const m = re.exec(xml);
    if (!m) continue;
    const indent = m[1] || '\t';
    return (
      xml.slice(0, m.index) +
      `${indent}<${property}>${value}</${property}>\n` +
      xml.slice(m.index)
    );
  }
  return null;
}
