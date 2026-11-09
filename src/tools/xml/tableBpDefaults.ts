/**
 * Structural best-practice defaults for a NEW AxTable, applied to the XML a
 * create wrote (bridge, smart builder or template).
 *
 * Every rule here is one xppbp reported on tables this server created, with the
 * checker's own message:
 *
 *   BPErrorTableFieldNotInFieldGroup      "The table's field is not a member of a field group."
 *   BPErrorTableMissingGroupAutoReport    "The table has no fields in the AutoReport field group."
 *   BPErrorTablePrimaryKeyEditable        "The primary key must not be editable."
 *   BPErrorTablePrimaryKeyNotMandatory    "The primary key must be mandatory."
 *   BPErrorEDTNotMigrated                 "The relation under the extended data type (EDT) 'ItemId'
 *                                          must be migrated to table relation."
 *   BPUpgradeMetadataEDTRelation          "EDT relation found in field ItemId of table … It should be
 *                                          migrated to a regular table relation."
 *   BPCheckMissingDeleteActions           "Delete actions missing in table … which is related to
 *                                          table UnitOfMeasure with relation name UnitOfMeasure"
 *   BPUpgradeMetadataDeleteAction         "DeleteAction InventTable has no explicit relation set."
 *   BPErrorTableRelationshipPropertiesCompleteness
 *                                         "Relation properties [RelationshipType,
 *                                          RelatedTableCardinality, Cardinality] … are not set."
 *
 * What each fix writes, and where the shape comes from:
 *
 *   • Key fields (the PrimaryIndex's and every AlternateKey index's) get
 *     <AllowEdit>No</AllowEdit> and <Mandatory>Yes</Mandatory>, as on the
 *     shipped staging tables (AbbreviationsStaging.StagingIdx: DefinitionGroup,
 *     ExecutionId, …). A field whose XML already says AllowEdit=Yes or
 *     Mandatory=No is a choice somebody made and is left alone.
 *   • A field in no group joins AutoReport; when every field already sits in a
 *     custom group, AutoReport gets the first five so it is not empty.
 *   • A field whose EDT carries a relation gets the table relation that EDT
 *     describes (its AxEdtRelation / AxEdtTableReference), unless it sets
 *     IgnoreEDTRelation=Yes or a relation already constrains it. TempDB tables
 *     included: the checker reports them too.
 *   • Every relation without <OnDelete> gets Restricted — the relation is
 *     where the platform keeps delete behaviour now. A relation with only a
 *     Name and RelatedTable (what the bridge's AddRelation writes) also gets
 *     Cardinality ZeroMore, RelatedTableCardinality ZeroOne (ExactlyOne when
 *     every constrained field is mandatory) and RelationshipType Association,
 *     the values the shipped SalesQuotationLine → InventTable relation uses.
 *   • With `dropWriterDeleteActions`, a delete action this server's own smart
 *     writers added for a relation target (Table = RelatedTable, no Relation)
 *     is removed. It sat on the CHILD table pointing at the parent, so
 *     "Restricted" blocked deleting the child's own rows whenever the parent
 *     row existed, and xppbp flagged it as having no explicit relation. The
 *     relation's OnDelete=Restricted states the intended rule the right way
 *     round. Only set this for XML a writer produced, never for caller XML.
 */

import { upsertTableFieldProperty, detectIndentUnit } from './tableFieldPropertyEdit.js';
import { escapeXml } from '../../utils/xmlEscape.js';

/** Where a field's EDT relation points. */
export interface EdtRelationTarget {
  table: string;
  relatedField: string;
}

export interface TableBpDefaultsOptions {
  /** EDT name (any case) → the relation that EDT declares. */
  edtRelations?: Record<string, EdtRelationTarget>;
  /** Relation name (any case) → the OnDelete the caller asked for. */
  relationOnDelete?: Record<string, string>;
  /** Remove the parent-pointing delete actions the smart writers add (see above). */
  dropWriterDeleteActions?: boolean;
}

export interface TableBpDefaultsResult {
  xml: string;
  /** One line per fix, for the create response. */
  notes: string[];
}

/** Fields the platform adds, never declared under <Fields>. */
const SYSTEM_FIELDS = new Set([
  'recid', 'recversion', 'dataareaid', 'partition', 'tableid',
  'createdby', 'createddatetime', 'createdtransactionid',
  'modifiedby', 'modifieddatetime', 'modifiedtransactionid',
]);

/** AxTableRelation children in serialised order (shipped relations, e.g. SalesQuotationLine). */
const RELATION_ELEMENT_ORDER = [
  'Name', 'Cardinality', 'CreateNavigationPropertyMethods', 'EDTReplacement', 'EntityRelationshipRole',
  'NavigationPropertyMethodNameOverride', 'OnDelete', 'RelatedTable', 'RelatedTableCardinality',
  'RelatedTableRole', 'RelationshipType', 'Role', 'UseDefaultRoleNames', 'Validate', 'Constraints', 'Index',
];

const ON_DELETE_VALUES = ['None', 'Restricted', 'Cascade', 'CascadeRestricted'];

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Block {
  start: number;
  end: number;
  text: string;
}

/** A table-level collection (`<Fields>`, `<Relations>`, …) at indent `u`, or null. */
function section(xml: string, u: string, name: string): Block | null {
  const open = new RegExp(`^${esc(u)}<${name}(\\s*/>|>)[ \\t]*\\n`, 'm').exec(xml);
  if (!open) return null;
  if (open[1].endsWith('/>')) return { start: open.index, end: open.index + open[0].length, text: open[0] };
  const close = new RegExp(`^${esc(u)}</${name}>[ \\t]*\\n`, 'm');
  const rest = xml.slice(open.index);
  const c = close.exec(rest);
  if (!c) return null;
  const end = open.index + c.index + c[0].length;
  return { start: open.index, end, text: xml.slice(open.index, end) };
}

/** The member blocks of a collection: each `<Tag …>` … `</Tag>` at indent `u2`. */
function members(sectionText: string, u2: string, tag: string): Block[] {
  const out: Block[] = [];
  const re = new RegExp(`^${esc(u2)}<${tag}\\b[^\\n]*\\n(?:[\\s\\S]*?)^${esc(u2)}</${tag}>[ \\t]*\\n`, 'gm');
  for (const m of sectionText.matchAll(re)) out.push({ start: m.index!, end: m.index! + m[0].length, text: m[0] });
  return out;
}

function child(blockText: string, u3: string, name: string): string | undefined {
  return new RegExp(`^${esc(u3)}<${name}>\\s*([^<]*?)\\s*</${name}>`, 'm').exec(blockText)?.[1];
}

interface FieldInfo {
  name: string;
  edt?: string;
  allowEdit?: string;
  mandatory?: string;
  ignoreEdtRelation?: string;
}

function readFields(xml: string, u: string): FieldInfo[] {
  const s = section(xml, u, 'Fields');
  if (!s) return [];
  const u3 = u.repeat(3);
  return members(s.text, u.repeat(2), 'AxTableField').map(b => ({
    name: child(b.text, u3, 'Name') ?? '',
    edt: child(b.text, u3, 'ExtendedDataType'),
    allowEdit: child(b.text, u3, 'AllowEdit'),
    mandatory: child(b.text, u3, 'Mandatory'),
    ignoreEdtRelation: child(b.text, u3, 'IgnoreEDTRelation'),
  })).filter(f => f.name.length > 0);
}

/** The table's own <Name> and its top-level property (outside every collection). */
function topLevel(xml: string, u: string, name: string): string | undefined {
  return new RegExp(`^${esc(u)}<${name}>\\s*([^<]*?)\\s*</${name}>`, 'm').exec(xml)?.[1];
}

// ── Key fields ──────────────────────────────────────────────────────────────

function keyFieldNames(xml: string, u: string): string[] {
  const s = section(xml, u, 'Indexes');
  if (!s) return [];
  const u3 = u.repeat(3);
  const primary = topLevel(xml, u, 'PrimaryIndex')?.toLowerCase();
  const names = new Set<string>();
  for (const ix of members(s.text, u.repeat(2), 'AxTableIndex')) {
    const ixName = child(ix.text, u3, 'Name')?.toLowerCase();
    const isKey = /^yes$/i.test(child(ix.text, u3, 'AlternateKey') ?? '') || (!!primary && ixName === primary);
    if (!isKey) continue;
    for (const m of ix.text.matchAll(/<DataField>\s*([^<]*?)\s*<\/DataField>/g)) names.add(m[1]);
  }
  return [...names];
}

function applyKeyFields(xml: string, u: string, notes: string[]): string {
  const fields = readFields(xml, u);
  const byName = new Map(fields.map(f => [f.name.toLowerCase(), f]));
  const done: string[] = [];
  for (const key of keyFieldNames(xml, u)) {
    if (SYSTEM_FIELDS.has(key.toLowerCase())) continue;
    const f = byName.get(key.toLowerCase());
    if (!f) continue;
    if (f.allowEdit === undefined) {
      const r = upsertTableFieldProperty(xml, f.name, 'AllowEdit', 'No');
      if (r.ok) xml = r.xml!;
    }
    if (f.mandatory === undefined) {
      const r = upsertTableFieldProperty(xml, f.name, 'Mandatory', 'Yes');
      if (r.ok) xml = r.xml!;
    }
    if (f.allowEdit === undefined || f.mandatory === undefined) done.push(f.name);
  }
  if (done.length > 0) notes.push(`key fields AllowEdit=No, Mandatory=Yes: ${done.join(', ')}`);
  return xml;
}

// ── Field groups ────────────────────────────────────────────────────────────

function renderGroupField(u: string, field: string): string {
  return `${u.repeat(4)}<AxTableFieldGroupField>\n${u.repeat(5)}<DataField>${escapeXml(field)}</DataField>\n${u.repeat(4)}</AxTableFieldGroupField>\n`;
}

/** Append `fields` to the group `groupName`, creating the group (first) when missing. */
function addToGroup(xml: string, u: string, groupName: string, fields: string[]): string {
  const u2 = u.repeat(2);
  const u3 = u.repeat(3);
  const rendered = fields.map(f => renderGroupField(u, f)).join('');
  let s = section(xml, u, 'FieldGroups');
  if (!s) return xml;
  if (s.text.trimEnd().endsWith('/>')) {
    const expanded = `${u}<FieldGroups>\n${u}</FieldGroups>\n`;
    xml = xml.slice(0, s.start) + expanded + xml.slice(s.end);
    s = section(xml, u, 'FieldGroups')!;
  }
  const group = members(s.text, u2, 'AxTableFieldGroup').find(
    g => child(g.text, u3, 'Name')?.toLowerCase() === groupName.toLowerCase(),
  );
  if (!group) {
    const block = `${u2}<AxTableFieldGroup>\n${u3}<Name>${groupName}</Name>\n${u3}<Fields>\n${rendered}${u3}</Fields>\n${u2}</AxTableFieldGroup>\n`;
    const at = s.start + s.text.indexOf('\n') + 1;
    return xml.slice(0, at) + block + xml.slice(at);
  }
  const gStart = s.start + group.start;
  let text = group.text;
  const empty = new RegExp(`^${esc(u3)}<Fields\\s*/>[ \\t]*\\n`, 'm');
  const close = new RegExp(`^${esc(u3)}</Fields>[ \\t]*\\n`, 'm');
  if (empty.test(text)) {
    text = text.replace(empty, () => `${u3}<Fields>\n${rendered}${u3}</Fields>\n`);
  } else if (close.test(text)) {
    text = text.replace(close, m => rendered + m);
  } else {
    text = text.replace(new RegExp(`^${esc(u2)}</AxTableFieldGroup>`, 'm'), m => `${u3}<Fields>\n${rendered}${u3}</Fields>\n${m}`);
  }
  return xml.slice(0, gStart) + text + xml.slice(gStart + group.text.length);
}

function groupedFieldNames(xml: string, u: string): Set<string> {
  const s = section(xml, u, 'FieldGroups');
  const set = new Set<string>();
  if (!s) return set;
  for (const m of s.text.matchAll(/<DataField>\s*([^<]*?)\s*<\/DataField>/g)) set.add(m[1].toLowerCase());
  return set;
}

function autoReportFields(xml: string, u: string): string[] {
  const s = section(xml, u, 'FieldGroups');
  if (!s) return [];
  const u3 = u.repeat(3);
  const g = members(s.text, u.repeat(2), 'AxTableFieldGroup').find(x => child(x.text, u3, 'Name') === 'AutoReport');
  return g ? [...g.text.matchAll(/<DataField>\s*([^<]*?)\s*<\/DataField>/g)].map(m => m[1]) : [];
}

function applyFieldGroups(xml: string, u: string, notes: string[]): string {
  const fields = readFields(xml, u).filter(f => !SYSTEM_FIELDS.has(f.name.toLowerCase()));
  if (fields.length === 0 || !section(xml, u, 'FieldGroups')) return xml;
  const grouped = groupedFieldNames(xml, u);
  const missing = fields.map(f => f.name).filter(n => !grouped.has(n.toLowerCase()));
  if (missing.length > 0) {
    xml = addToGroup(xml, u, 'AutoReport', missing);
    notes.push(`added to field group AutoReport (every field needs a group): ${missing.join(', ')}`);
  }
  if (autoReportFields(xml, u).length === 0) {
    const first = fields.slice(0, 5).map(f => f.name);
    xml = addToGroup(xml, u, 'AutoReport', first);
    notes.push(`AutoReport filled so it is not empty: ${first.join(', ')}`);
  }
  return xml;
}

// ── Relations ───────────────────────────────────────────────────────────────

interface RelationInfo {
  block: Block;
  name: string;
  relatedTable?: string;
  constrainedFields: string[];
}

function readRelations(xml: string, u: string): { section: Block | null; relations: RelationInfo[] } {
  const s = section(xml, u, 'Relations');
  if (!s) return { section: null, relations: [] };
  const u3 = u.repeat(3);
  const relations = members(s.text, u.repeat(2), 'AxTableRelation').map(b => ({
    block: b,
    name: child(b.text, u3, 'Name') ?? '',
    relatedTable: child(b.text, u3, 'RelatedTable'),
    constrainedFields: [...b.text.matchAll(/<Field>\s*([^<]*?)\s*<\/Field>/g)].map(m => m[1]),
  }));
  return { section: s, relations };
}

function renderRelation(u: string, name: string, target: EdtRelationTarget, field: string, mandatory: boolean): string {
  const u2 = u.repeat(2);
  const u3 = u.repeat(3);
  const u4 = u.repeat(4);
  const u5 = u.repeat(5);
  return (
    `${u2}<AxTableRelation>\n` +
    `${u3}<Name>${escapeXml(name)}</Name>\n` +
    `${u3}<Cardinality>ZeroMore</Cardinality>\n` +
    `${u3}<OnDelete>Restricted</OnDelete>\n` +
    `${u3}<RelatedTable>${escapeXml(target.table)}</RelatedTable>\n` +
    `${u3}<RelatedTableCardinality>${mandatory ? 'ExactlyOne' : 'ZeroOne'}</RelatedTableCardinality>\n` +
    `${u3}<RelationshipType>Association</RelationshipType>\n` +
    `${u3}<Constraints>\n` +
    `${u4}<AxTableRelationConstraint xmlns=""\n${u5}i:type="AxTableRelationConstraintField">\n` +
    `${u5}<Name>${escapeXml(field)}</Name>\n` +
    `${u5}<Field>${escapeXml(field)}</Field>\n` +
    `${u5}<RelatedField>${escapeXml(target.relatedField)}</RelatedField>\n` +
    `${u4}</AxTableRelationConstraint>\n` +
    `${u3}</Constraints>\n` +
    `${u2}</AxTableRelation>\n`
  );
}

function applyEdtRelations(
  xml: string,
  u: string,
  edtRelations: Record<string, EdtRelationTarget>,
  notes: string[],
): string {
  const lookup = new Map(Object.entries(edtRelations).map(([k, v]) => [k.toLowerCase(), v]));
  if (lookup.size === 0) return xml;
  const { relations } = readRelations(xml, u);
  const covered = new Set(relations.flatMap(r => r.constrainedFields.map(f => f.toLowerCase())));
  const usedNames = new Set(relations.map(r => r.name.toLowerCase()));
  const added: string[] = [];
  let rendered = '';
  for (const f of readFields(xml, u)) {
    if (!f.edt || /^yes$/i.test(f.ignoreEdtRelation ?? '')) continue;
    if (covered.has(f.name.toLowerCase())) continue;
    const target = lookup.get(f.edt.toLowerCase());
    if (!target) continue;
    const name = [target.table, f.name, `${target.table}_${f.name}`].find(n => !usedNames.has(n.toLowerCase()));
    if (!name) continue;
    usedNames.add(name.toLowerCase());
    covered.add(f.name.toLowerCase());
    rendered += renderRelation(u, name, target, f.name, /^yes$/i.test(f.mandatory ?? ''));
    added.push(`${f.name} → ${target.table}.${target.relatedField}`);
  }
  if (!rendered) return xml;
  const s = section(xml, u, 'Relations');
  if (!s) return xml;
  if (s.text.trimEnd().endsWith('/>')) {
    xml = xml.slice(0, s.start) + `${u}<Relations>\n${rendered}${u}</Relations>\n` + xml.slice(s.end);
  } else {
    const closeAt = s.start + s.text.lastIndexOf(`${u}</Relations>`);
    xml = xml.slice(0, closeAt) + rendered + xml.slice(closeAt);
  }
  notes.push(`table relations for EDT relations: ${added.join(', ')}`);
  return xml;
}

/** Insert `<name>value</name>` into a relation block at its canonical position. */
function upsertRelationChild(text: string, u3: string, name: string, value: string): string {
  const existing = new RegExp(`^${esc(u3)}<${name}>[^<]*</${name}>`, 'm');
  if (existing.test(text)) return text;
  const rank = RELATION_ELEMENT_ORDER.indexOf(name);
  const line = `${u3}<${name}>${value}</${name}>\n`;
  for (const m of text.matchAll(new RegExp(`^${esc(u3)}<(\\w+)[\\s/>]`, 'gm'))) {
    const r = RELATION_ELEMENT_ORDER.indexOf(m[1]);
    if (r > rank) return text.slice(0, m.index) + line + text.slice(m.index);
  }
  return text;
}

function applyRelationProperties(
  xml: string,
  u: string,
  onDelete: Record<string, string>,
  notes: string[],
): string {
  const { section: s, relations } = readRelations(xml, u);
  if (!s || relations.length === 0) return xml;
  const u3 = u.repeat(3);
  const wanted = new Map(Object.entries(onDelete).map(([k, v]) => [k.toLowerCase(), v]));
  const mandatory = new Set(readFields(xml, u).filter(f => /^yes$/i.test(f.mandatory ?? '')).map(f => f.name.toLowerCase()));
  const onDeleteSet: string[] = [];
  const completed: string[] = [];
  // Back to front, so earlier offsets stay valid.
  for (const r of [...relations].reverse()) {
    let text = r.block.text;
    const asked = wanted.get(r.name.toLowerCase());
    const value = ON_DELETE_VALUES.find(v => v.toLowerCase() === (asked ?? 'Restricted').toLowerCase()) ?? 'Restricted';
    if (child(text, u3, 'OnDelete') === undefined) {
      text = upsertRelationChild(text, u3, 'OnDelete', value);
      onDeleteSet.push(`${r.name}=${value}`);
    }
    const before = text;
    text = upsertRelationChild(text, u3, 'Cardinality', 'ZeroMore');
    const allMandatory = r.constrainedFields.length > 0 && r.constrainedFields.every(f => mandatory.has(f.toLowerCase()));
    text = upsertRelationChild(text, u3, 'RelatedTableCardinality', allMandatory ? 'ExactlyOne' : 'ZeroOne');
    text = upsertRelationChild(text, u3, 'RelationshipType', 'Association');
    if (text !== before) completed.push(r.name);
    if (text !== r.block.text) {
      const at = s.start + r.block.start;
      xml = xml.slice(0, at) + text + xml.slice(at + r.block.text.length);
    }
  }
  if (onDeleteSet.length > 0) notes.push(`relation OnDelete: ${onDeleteSet.reverse().join(', ')}`);
  if (completed.length > 0) {
    notes.push(`relation Cardinality/RelatedTableCardinality/RelationshipType completed: ${completed.reverse().join(', ')}`);
  }
  return xml;
}

function dropWriterDeleteActions(xml: string, u: string, notes: string[]): string {
  const s = section(xml, u, 'DeleteActions');
  if (!s || s.text.trimEnd().endsWith('/>')) return xml;
  const targets = new Set(readRelations(xml, u).relations.map(r => (r.relatedTable ?? '').toLowerCase()));
  const u3 = u.repeat(3);
  const all = members(s.text, u.repeat(2), 'AxTableDeleteAction');
  const drop = all.filter(d =>
    child(d.text, u3, 'Relation') === undefined && targets.has((child(d.text, u3, 'Table') ?? '').toLowerCase()));
  if (drop.length === 0) return xml;
  let text = s.text;
  for (const d of [...drop].reverse()) text = text.slice(0, d.start) + text.slice(d.end);
  if (drop.length === all.length) text = `${u}<DeleteActions />\n`;
  notes.push(
    `removed ${drop.length} delete action(s) on related parent table(s) (${drop.map(d => child(d.text, u3, 'Table')).join(', ')}): ` +
    `they blocked deleting this table's own rows; the relation's OnDelete=Restricted protects the parent instead`,
  );
  return xml.slice(0, s.start) + text + xml.slice(s.end);
}

/**
 * Apply every structural BP default to a new AxTable document. Anything that is
 * not an AxTable comes back unchanged. CRLF documents keep their line endings.
 */
export function applyTableBpDefaults(xml: string, options: TableBpDefaultsOptions = {}): TableBpDefaultsResult {
  if (!/<AxTable[\s>]/.test(xml)) return { xml, notes: [] };
  const crlf = /\r\n/.test(xml);
  let x = crlf ? xml.replace(/\r\n/g, '\n') : xml;
  const u = detectIndentUnit(x);
  const notes: string[] = [];

  x = applyKeyFields(x, u, notes);
  x = applyFieldGroups(x, u, notes);
  if (options.edtRelations) x = applyEdtRelations(x, u, options.edtRelations, notes);
  x = applyRelationProperties(x, u, options.relationOnDelete ?? {}, notes);
  if (options.dropWriterDeleteActions) x = dropWriterDeleteActions(x, u, notes);

  if (notes.length === 0) return { xml, notes };
  return { xml: crlf ? x.replace(/\n/g, '\r\n') : x, notes };
}

/** Caller-facing note for the create response, or '' when nothing changed. */
export function renderTableBpDefaultsNote(r: TableBpDefaultsResult): string {
  if (r.notes.length === 0) return '';
  return `\n📋 BP defaults written after the create:\n${r.notes.map(n => `   • ${n}`).join('\n')}`;
}

/** relations[].onDelete from a create's properties, keyed by relation name. */
export function relationOnDeleteFromSpecs(relations: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(relations)) return out;
  for (const r of relations) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const name = rec.name ?? rec.relationName;
    const on = rec.onDelete ?? rec.OnDelete;
    if (typeof name === 'string' && typeof on === 'string') out[name] = on;
  }
  return out;
}
