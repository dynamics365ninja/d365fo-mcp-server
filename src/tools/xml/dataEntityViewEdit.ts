/**
 * In-place edits of an existing AxDataEntityView (pure string in / string out).
 *
 * The bridge writes a fixed list of entity properties and cannot add a datasource or a
 * mapped field to an entity (only to an extension), so these edits are made here.
 *
 * Element order matters: the deserializer drops a mis-ordered element silently, and an
 * element missing from the order table lets a new property land on the wrong side of it.
 *
 * Every edit is anchored on the file's indent unit (detectIndentUnit): an element's depth is
 * read from its indentation, which is what keeps an edit off a nested collection of the same
 * name. Shipped metadata is tab-indented; about 2% of it uses two spaces.
 */

import { escapeXml } from '../../utils/xmlEscape.js';
import { ENTITY_CATEGORIES } from '../../utils/axEnumProperties.js';
import { buildAxDataEntityViewFieldXml } from './dataEntityViewExtensionXml.js';
import { yesNo, detectIndentUnit } from './tableFieldPropertyEdit.js';
import { createXmlTokenScanner } from '../../utils/xmlScan.js';
import { lineStartBefore } from './tableFieldRemoval.js';

/**
 * Top-level elements of an AxDataEntityView in serialised order, measured over the ~5,800
 * shipped entities of a platform install (pairwise majority; a handful of outliers exist).
 */
export const ENTITY_TOP_LEVEL_ORDER = [
  'Name', 'SourceCode', 'ConfigurationKey', 'CountryRegionCodes', 'DeveloperDocumentation',
  'FormRef', 'IsObsolete', 'Label', 'SingularLabel', 'OperationalDomain', 'SubscriberAccessLevel',
  'Tags', 'AllowArchival', 'AllowRetention', 'AllowRowVersionChangeTracking',
  'AutoCreateDataverse', 'DataManagementEnabled', 'DataManagementStagingTable',
  'EnableSetBasedSqlOperations', 'EntityCategory', 'IsPublic', 'IsReadOnly', 'Modules',
  'PrimaryCompanyContext', 'PrimaryKey', 'PublicCollectionName', 'PublicEntityName',
  'SupportsSetBasedSqlOperations', 'ValidTimeStateEnabled', 'DeleteActions', 'FieldGroups',
  'Fields', 'Keys', 'Mappings', 'Ranges', 'Relations', 'StateMachines', 'ViewMetadata'
] as const;

/**
 * The scalar properties upsertDataEntityProperty writes. Modules, OperationalDomain and
 * SubscriberAccessLevel are ordered above but not writable here: their values are enums or
 * structures this writer does not validate.
 */
export const ENTITY_SCALAR_PROPERTIES: ReadonlySet<string> = new Set([
  'ConfigurationKey', 'CountryRegionCodes', 'DeveloperDocumentation', 'FormRef', 'IsObsolete',
  'Label', 'SingularLabel', 'Tags', 'AllowRowVersionChangeTracking', 'AutoCreateDataverse',
  'DataManagementEnabled', 'DataManagementStagingTable', 'AllowArchival', 'AllowRetention',
  'EnableSetBasedSqlOperations', 'EntityCategory', 'IsPublic', 'IsReadOnly',
  'PrimaryCompanyContext', 'PrimaryKey', 'PublicCollectionName', 'PublicEntityName',
  'SupportsSetBasedSqlOperations', 'ValidTimeStateEnabled',
]);

const ENTITY_NOYES_PROPERTIES: ReadonlySet<string> = new Set([
  'AllowArchival', 'AllowRetention', 'AllowRowVersionChangeTracking', 'AutoCreateDataverse',
  'DataManagementEnabled', 'EnableSetBasedSqlOperations', 'IsObsolete', 'IsPublic', 'IsReadOnly',
  'SupportsSetBasedSqlOperations', 'ValidTimeStateEnabled',
]);

export interface EditResult {
  ok: boolean;
  xml?: string;
  /** Human-readable reason when !ok, or a note when ok. */
  message: string;
}

const fail = (message: string): EditResult => ({ ok: false, message });

function isEntity(xml: string): boolean {
  return /<AxDataEntityView[\s>]/.test(xml);
}

/** Top-level (one indent unit) element lines, with their offsets. */
function topLevelElements(xml: string, u: string): Array<{ name: string; index: number }> {
  const out: Array<{ name: string; index: number }> = [];
  const re = new RegExp(`^${u}<(\\w+)(?:\\s[^>]*)?(?:/>|>)`, 'gm');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push({ name: m[1], index: m.index });
  return out;
}

/** Top-level collections: the scalar property block ends at the first of them. */
const ENTITY_COLLECTIONS = new Set([
  'DeleteActions', 'FieldGroups', 'Fields', 'Keys', 'Mappings', 'Ranges', 'Relations', 'StateMachines', 'ViewMetadata',
]);

/**
 * Where the entity's scalar properties sit: after its <SourceCode> block (whose
 * X++ may contain anything) and before its first collection.
 */
function scalarPropertySpan(xml: string, u: string): { start: number; end: number } {
  const sourceEnd = new RegExp(`^${u}(?:</SourceCode>|<SourceCode\\s*/>)`, 'm').exec(xml);
  const start = sourceEnd ? sourceEnd.index + sourceEnd[0].length : 0;
  const firstCollection = topLevelElements(xml, u).find(e => e.index >= start && ENTITY_COLLECTIONS.has(e.name));
  return { start, end: firstCollection ? firstCollection.index : start };
}

/**
 * Set (or insert, in canonical position) one scalar property of an entity.
 * Refuses names that are not entity scalar properties: writing an arbitrary
 * element would land somewhere the deserializer ignores.
 */
export function upsertDataEntityProperty(xml: string, name: string, value: string): EditResult {
  if (!isEntity(xml)) return fail('not an AxDataEntityView document');
  const canonical = [...ENTITY_SCALAR_PROPERTIES].find(p => p.toLowerCase() === name.toLowerCase());
  if (!canonical) {
    return fail(
      `'${name}' is not a scalar AxDataEntityView property. Supported: ` +
      `${[...ENTITY_SCALAR_PROPERTIES].join(', ')}.`,
    );
  }
  // A NoYes property written as anything else is dropped by the deserializer without a word.
  let written = value;
  if (ENTITY_NOYES_PROPERTIES.has(canonical)) {
    const v = yesNo(value);
    if (!v) return fail(`${canonical} takes Yes or No, not '${value}'.`);
    written = v;
  }
  // EntityCategory is an enum: a value outside it is one the deserializer cannot read.
  // Empty is let through: it means "back to the default", and the caller drops the element.
  if (canonical === 'EntityCategory' && value.trim() !== '') {
    const v = ENTITY_CATEGORIES.find(c => c.toLowerCase() === value.trim().toLowerCase());
    if (!v) return fail(`EntityCategory takes one of ${ENTITY_CATEGORIES.join(', ')}, not '${value}'.`);
    written = v;
  }
  const u = detectIndentUnit(xml);
  const text = `<${canonical}>${escapeXml(written)}</${canonical}>`;

  // Existing element (leaf or empty): replace in place.
  const existing = new RegExp(`^${u}<${canonical}(?:>[^<]*</${canonical}>|\\s*/>)`, 'm');
  if (existing.test(xml)) {
    return { ok: true, xml: xml.replace(existing, () => `${u}${text}`), message: `${canonical} updated` };
  }
  // …or at another indentation. Shipped entities mix them (a tab line in a
  // two-space file), and looking only at the detected unit inserted a SECOND copy.
  // Between </SourceCode> and the first collection there are only scalar
  // properties, so any match in that span is the top-level element.
  const scalarSpan = scalarPropertySpan(xml, u);
  const anyIndent = new RegExp(`^([ \\t]*)<${canonical}(?:>[^<]*</${canonical}>|\\s*/>)`, 'm')
    .exec(xml.slice(scalarSpan.start, scalarSpan.end));
  if (anyIndent) {
    const at = scalarSpan.start + anyIndent.index;
    return {
      ok: true,
      xml: `${xml.slice(0, at)}${anyIndent[1]}${text}${xml.slice(at + anyIndent[0].length)}`,
      message: `${canonical} updated`,
    };
  }

  // Insert before the first top-level element that belongs AFTER this one.
  const rank = (n: string) => ENTITY_TOP_LEVEL_ORDER.indexOf(n as never);
  const mine = rank(canonical);
  const later = topLevelElements(xml, u).find(e => rank(e.name) > mine);
  if (!later) return fail('could not find an insertion point (no collections in the document)');
  return {
    ok: true,
    xml: `${xml.slice(0, later.index)}${u}${text}\n${xml.slice(later.index)}`,
    message: `${canonical} inserted`,
  };
}

export interface EntityDataSourceSpec {
  name: string;
  table: string;
  /** Existing datasource to nest under. Default: the root datasource. */
  joinSource?: string;
  /** InnerJoin (default, omitted from XML) | OuterJoin | ExistsJoin | NoExistsJoin. */
  joinMode?: string;
  /** Field on the JOIN (parent) datasource. */
  joinField?: string;
  /** Field on the NEW datasource's table. */
  relatedField?: string;
  readOnly?: boolean;
  /** Default true — every shipped embedded datasource of an entity carries it. */
  dynamicFields?: boolean;
}

const JOIN_MODES = ['InnerJoin', 'OuterJoin', 'ExistsJoin', 'NoExistsJoin'];

/**
 * Add an AxQuerySimpleEmbeddedDataSource, with its join relation, under a
 * datasource of the entity's ViewMetadata query.
 *
 * Shape and sub-element order come from a shipped entity:
 *   Name, DynamicFields, IsReadOnly, Table, DataSources, DerivedDataSources,
 *   Fields, Ranges, JoinMode, Relations
 * On the relation, `Field` is the field of the JOIN (parent) datasource and
 * `RelatedField` the field of the new datasource's table
 * (DefaultDimension → DimensionSetEntity.RecId).
 */
export function addDataEntityDataSource(xml: string, spec: EntityDataSourceSpec): EditResult {
  if (!isEntity(xml)) return fail('not an AxDataEntityView document');
  if (!spec.joinField || !spec.relatedField) {
    return fail(
      'an embedded datasource needs its join relation: pass joinField (field on the parent ' +
      'datasource) and relatedField (field on the new datasource\'s table) — a datasource with no ' +
      'relation is a cross join.',
    );
  }
  const joinMode = spec.joinMode
    ? JOIN_MODES.find(m => m.toLowerCase() === spec.joinMode!.toLowerCase())
    : undefined;
  if (spec.joinMode && !joinMode) {
    return fail(`joinMode '${spec.joinMode}' is not one of ${JOIN_MODES.join(', ')}.`);
  }

  const vm = xml.indexOf('<ViewMetadata>');
  if (vm < 0) return fail('the entity has no <ViewMetadata> query (it is an inert skeleton)');
  const query = xml.slice(vm);

  const u = detectIndentUnit(xml);
  const dsElement = new RegExp(
    `^((?:${u})+)<(AxQuerySimpleRootDataSource|AxQuerySimpleEmbeddedDataSource)>\\n(?:${u})+<Name>([^<]+)</Name>`,
    'gm',
  );
  const sources: Array<{ name: string; indent: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = dsElement.exec(query))) sources.push({ name: m[3], indent: m[1], index: vm + m.index });
  if (sources.length === 0) return fail('the entity query has no datasource');
  if (sources.some(s => s.name === spec.name)) {
    return fail(`datasource '${spec.name}' already exists on this entity`);
  }

  const root = sources.find(s => s.indent === u.repeat(3)) ?? sources[0];
  const parent = spec.joinSource ? sources.find(s => s.name === spec.joinSource) : root;
  if (!parent) {
    return fail(`joinSource '${spec.joinSource}' is not a datasource of this entity (have: ${sources.map(s => s.name).join(', ')}).`);
  }

  // The parent's OWN <DataSources>, found by exact indentation so a nested one is never taken.
  const pi = parent.indent;
  const after = xml.slice(parent.index);
  const own = new RegExp(`^${pi}${u}<DataSources(?: />|>)`, 'm').exec(after);
  if (!own) return fail(`could not find the <DataSources> of '${parent.name}'`);
  const ownAt = parent.index + own.index;

  const t = (n: number) => u.repeat(n);
  const depth = pi.length / u.length + 2; // indent units: parent > DataSources > new datasource
  const lines = [
    `${t(depth)}<AxQuerySimpleEmbeddedDataSource>`,
    `${t(depth + 1)}<Name>${escapeXml(spec.name)}</Name>`,
    ...(spec.dynamicFields === false ? [] : [`${t(depth + 1)}<DynamicFields>Yes</DynamicFields>`]),
    ...(spec.readOnly ? [`${t(depth + 1)}<IsReadOnly>Yes</IsReadOnly>`] : []),
    `${t(depth + 1)}<Table>${escapeXml(spec.table)}</Table>`,
    `${t(depth + 1)}<DataSources />`,
    `${t(depth + 1)}<DerivedDataSources />`,
    `${t(depth + 1)}<Fields />`,
    `${t(depth + 1)}<Ranges />`,
    ...(joinMode && joinMode !== 'InnerJoin' ? [`${t(depth + 1)}<JoinMode>${joinMode}</JoinMode>`] : []),
    `${t(depth + 1)}<Relations>`,
    `${t(depth + 2)}<AxQuerySimpleDataSourceRelation>`,
    `${t(depth + 3)}<Name>QueryDataSourceRelation1</Name>`,
    `${t(depth + 3)}<Field>${escapeXml(spec.joinField)}</Field>`,
    `${t(depth + 3)}<JoinDataSource>${escapeXml(parent.name)}</JoinDataSource>`,
    `${t(depth + 3)}<RelatedField>${escapeXml(spec.relatedField)}</RelatedField>`,
    `${t(depth + 2)}</AxQuerySimpleDataSourceRelation>`,
    `${t(depth + 1)}</Relations>`,
    `${t(depth)}</AxQuerySimpleEmbeddedDataSource>`,
  ].join('\n');

  const openLen = own[0].length;
  let updated: string;
  if (own[0].endsWith('/>')) {
    updated =
      `${xml.slice(0, ownAt)}${pi}${u}<DataSources>\n${lines}\n${pi}${u}</DataSources>` +
      `${xml.slice(ownAt + openLen)}`;
  } else {
    const closeRe = new RegExp(`^${pi}${u}</DataSources>`, 'm');
    const rest = xml.slice(ownAt + openLen);
    const close = closeRe.exec(rest);
    if (!close) return fail(`unbalanced <DataSources> under '${parent.name}'`);
    const at = ownAt + openLen + close.index;
    updated = `${xml.slice(0, at)}${lines}\n${xml.slice(at)}`;
  }
  return { ok: true, xml: updated, message: `datasource ${spec.name} added under ${parent.name}` };
}

export interface EntityMappedFieldSpec {
  name: string;
  dataField: string;
  dataSource: string;
  label?: string;
  accessModifier?: string;
  mandatory?: string;
}

/** Append one AxDataEntityViewMappedField to the entity's top-level <Fields>. */
export function addDataEntityMappedField(xml: string, spec: EntityMappedFieldSpec): EditResult {
  if (!isEntity(xml)) return fail('not an AxDataEntityView document');
  const esc = spec.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`<AxDataEntityViewField\\b[^>]*>\\s*<Name>${esc}</Name>`).test(xml)) {
    return fail(`field '${spec.name}' already exists on this entity`);
  }
  // A Mandatory that is not Yes/No is a value the NoYes deserializer cannot read.
  let mandatory: string | undefined;
  if (spec.mandatory !== undefined) {
    mandatory = yesNo(spec.mandatory);
    if (!mandatory) return fail(`Mandatory takes Yes or No, not '${spec.mandatory}'.`);
  }
  const u = detectIndentUnit(xml);
  // The builder indents with tabs; re-indent it in the file's own unit (it carries no CDATA).
  const element = buildAxDataEntityViewFieldXml({
    name: spec.name, dataField: spec.dataField, dataSource: spec.dataSource,
    label: spec.label, accessModifier: spec.accessModifier, mandatory,
  }).replace(/^\t+/gm, tabs => u.repeat(tabs.length));
  const empty = new RegExp(`^${u}<Fields />`, 'm').exec(xml);
  if (empty) {
    return {
      ok: true,
      xml: `${xml.slice(0, empty.index)}${u}<Fields>\n${element}\n${u}</Fields>${xml.slice(empty.index + empty[0].length)}`,
      message: `field ${spec.name} added`,
    };
  }
  const open = new RegExp(`^${u}<Fields>\\n`, 'm').exec(xml);
  if (!open) return fail('the entity has no top-level <Fields> collection');
  const close = new RegExp(`^${u}</Fields>`, 'm').exec(xml.slice(open.index));
  if (!close) return fail('unbalanced <Fields>');
  const at = open.index + close.index;
  return { ok: true, xml: `${xml.slice(0, at)}${element}\n${xml.slice(at)}`, message: `field ${spec.name} added` };
}

export interface RemoveEntityFieldResult extends EditResult {
  /** The entity's own <AxDataEntityViewField> was removed. */
  removedEntityField?: boolean;
  /** "DataSource.Field" of every query data-source field entry removed. */
  removedDataSourceFields?: string[];
  /** Places that still name the field and were left alone. */
  remaining?: string[];
}

interface ScanElement {
  name: string;
  at: number;
  leaves: Record<string, string>;
}

/**
 * remove-field on an AxDataEntityView: the entity's field AND the query data-source field entry
 * that feeds it. The bridge removes only the former, leaving `<AxQuerySimpleDataSourceField>` in
 * ViewMetadata, and the build then fails with "Field 'X' does not exist".
 *
 * - A mapped field takes its (DataSource, DataField) entry with it, unless another remaining
 *   mapped field still reads the same column. An unmapped / computed field has no entry.
 * - When the entity field is already gone (a previous remove-field left the entry behind) the
 *   leftover entries named `fieldName` are removed instead; "not found" only when there is none.
 * - `dataSourceName` limits the data-source cleanup to that data source.
 */
export function removeDataEntityField(xml: string, fieldName: string, dataSourceName?: string): RemoveEntityFieldResult {
  if (!isEntity(xml)) return fail('not an AxDataEntityView document');
  const wanted = fieldName.trim().toLowerCase();
  const onlyDs = dataSourceName?.trim().toLowerCase();
  const stack: ScanElement[] = [];
  let open: { contentAt: number } | null = null;

  const entityFields: Array<{ at: number; end: number; name: string; dataField?: string; dataSource?: string }> = [];
  const dsFields: Array<{ at: number; end: number; name?: string; field?: string; ds: string }> = [];
  const remaining: string[] = [];
  const viewRefs: Array<{ text: string; what: string }> = [];

  const scanner = createXmlTokenScanner();
  let token: RegExpExecArray | null;
  while ((token = scanner.exec(xml)) !== null) {
    const closing = token[1];
    const starting = token[2];
    if (!closing && !starting) continue;
    if (starting) {
      if (token[4] === '/') { open = null; continue; }
      stack.push({ name: starting, at: token.index, leaves: {} });
      open = { contentAt: token.index + token[0].length };
      continue;
    }
    const depth = stack.length;
    const el = stack[depth - 1];
    if (!el || el.name !== closing) { open = null; stack.pop(); continue; }
    const parent = stack[depth - 2];
    const end = token.index + token[0].length;
    if (open) {
      const text = xml.slice(open.contentAt, token.index).trim();
      if (parent) parent.leaves[closing] = text;
      const section = stack[1]?.name;
      if (section === 'ViewMetadata') {
        // Query ranges, group-by and order-by name a data-source COLUMN; judged against it below.
        const holder = stack.find(e => /Range|GroupBy|OrderBy|Having/.test(e.name));
        if (holder && /Field/.test(closing)) {
          viewRefs.push({ text: text.toLowerCase(), what: `${holder.name.replace(/^AxQuerySimple/, '')} in the view query (<${closing}>)` });
        }
      } else if (
        (section === 'FieldGroups' || section === 'Keys' || section === 'Ranges') && /Field$/.test(closing) ||
        (section === 'Mappings' && closing === 'MapFieldTo')
      ) {
        if (text.toLowerCase() === wanted) remaining.push(`${section} '${stack[2]?.leaves.Name ?? '(unnamed)'}' (<${closing}>)`);
      }
    }
    if (el.name === 'AxDataEntityViewField' && depth === 3 && stack[1]?.name === 'Fields') {
      entityFields.push({ at: el.at, end, name: el.leaves.Name ?? '', dataField: el.leaves.DataField, dataSource: el.leaves.DataSource });
    } else if (el.name === 'AxQuerySimpleDataSourceField' && stack.some(s => s.name === 'ViewMetadata')) {
      const owner = [...stack].reverse().find(s => /^AxQuerySimple(Root|Embedded|Derived)DataSource$/.test(s.name));
      dsFields.push({ at: el.at, end, name: el.leaves.Name, field: el.leaves.Field, ds: owner?.leaves.Name ?? '' });
    }
    open = null;
    stack.pop();
  }

  const target = entityFields.find(f => f.name.toLowerCase() === wanted);
  const others = entityFields.filter(f => f !== target);
  const stillRead = (ds: string, col: string) => others.some(f =>
    f.dataSource?.toLowerCase() === ds.toLowerCase() && f.dataField?.toLowerCase() === col.toLowerCase());
  const inScope = (ds: string) => !onlyDs || ds.toLowerCase() === onlyDs;

  // With the entity field present, only the (data source, column) it read is orphaned. When it
  // is already gone, an entry named after it is a leftover, in whichever data source it sits.
  const cols = new Set([wanted, (target?.dataField ?? '').toLowerCase()].filter(Boolean));
  const cuts: Array<[number, number]> = [];
  const removedDs: string[] = [];
  if (target) cuts.push([lineStartBefore(xml, target.at), target.end]);
  for (const d of dsFields) {
    const col = (d.field ?? d.name ?? '').toLowerCase();
    if (!inScope(d.ds)) continue;
    const feeds = target
      ? !!target.dataField && !!target.dataSource && d.ds.toLowerCase() === target.dataSource.toLowerCase() && col === target.dataField.toLowerCase()
      : col === wanted || (d.name ?? '').toLowerCase() === wanted;
    if (!feeds || stillRead(d.ds, d.field ?? d.name ?? '')) continue;
    cuts.push([lineStartBefore(xml, d.at), d.end]);
    removedDs.push(`${d.ds}.${d.field ?? d.name}`);
  }
  if (cuts.length === 0) {
    return fail(`field '${fieldName}' not found on this entity${onlyDs ? ` (data source '${dataSourceName}')` : ''}, and no data-source field entry names it`);
  }

  let out = xml;
  for (const [start, end] of cuts.sort((a, b) => b[0] - a[0])) {
    let before = out.slice(0, start);
    let after = out.slice(end);
    if (/<Fields>[ \t\r\n]*$/.test(before) && /^[ \t\r\n]*<\/Fields>/.test(after)) {
      before = before.replace(/<Fields>[ \t\r\n]*$/, '<Fields />');
      after = after.replace(/^[ \t\r\n]*<\/Fields>/, '');
    }
    out = before + after;
  }
  const parts = [
    target ? `field '${fieldName}' removed` : `field '${fieldName}' was already removed from the entity`,
    removedDs.length ? `data-source field entr${removedDs.length === 1 ? 'y' : 'ies'} removed: ${removedDs.join(', ')}` : '',
  ].filter(Boolean);
  for (const v of viewRefs) if (cols.has(v.text) && !remaining.includes(v.what)) remaining.push(v.what);
  return { ok: true, xml: out, message: parts.join('; '), removedEntityField: !!target, removedDataSourceFields: removedDs, remaining };
}
