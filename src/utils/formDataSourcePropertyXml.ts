/**
 * Set a property ON a data source the form (or form extension) itself defines.
 *
 * Join properties could be given only while a data source was added
 * (add-data-source passes joinSource and linkType to the bridge). On a data
 * source that already existed nothing could change them, so the join of an
 * existing data source was edited in the form XML by hand (#1161).
 *
 * The property is written as a direct child of that <AxFormDataSource>: replaced
 * where it stands when present, inserted in the platform's element order when
 * absent. The order matters because the metadata deserializer DROPS an element
 * it meets out of sequence, without a word (#979). The order is not alphabetical.
 * It was measured on Microsoft standard forms: 13,234 data sources, and no pair
 * of elements ever appears in both orders:
 *
 *   Name, Table, Fields, ReferencedDataSources, AutoNotify, AutoQuery, AutoSearch,
 *   CrossCompanyAutoQuery, DelayActive, JoinSource, LinkType, OnlyFetchActive,
 *   AllowCheck, AllowCreate, AllowDelete, AllowEdit, Index, InsertAtEnd,
 *   InsertIfEmpty, MaxAccessRight, StartPosition, DataSourceLinks,
 *   DerivedDataSources.
 *
 * Every scalar in that chain can be set. CounterField, ValidTimeStateAutoQuery,
 * ValidTimeStateUpdate, OptionalRecordMode and MaxRecordsToLoad exist too, but
 * are too rare to place with certainty, so they are refused. A data source that
 * already carries one of them still takes a new property when the side it is on
 * is known (see FORM_DATA_SOURCE_AFTER_INSERT_IF_EMPTY), and is refused
 * otherwise. Replacing a value never moves it, so it always works.
 *
 * Pure and side-effect-free: the file I/O stays in the caller.
 */

import { detectEol } from './eolUtils.js';

/**
 * Elements that FOLLOW <InsertIfEmpty> in an AxFormDataSource. Measured over the
 * 21,168 data sources of the shipped forms and form extensions (source XML): every
 * other child element only ever precedes it, and none appears on both sides.
 */
export const FORM_DATA_SOURCE_AFTER_INSERT_IF_EMPTY = [
  'StartPosition', 'MaxAccessRight', 'ValidTimeStateUpdate', 'ValidTimeStateAutoQuery',
  'OptionalRecordMode', 'DataSourceLinks', 'DerivedDataSources',
];

/**
 * The properties modify-property can set on a form data source, in the platform's
 * element order (measured on Microsoft standard forms, see the header).
 */
export const FORM_DATA_SOURCE_PROPERTIES = [
  'AutoNotify', 'AutoQuery', 'AutoSearch', 'CrossCompanyAutoQuery', 'DelayActive', 'JoinSource', 'LinkType',
  'OnlyFetchActive', 'AllowCheck', 'AllowCreate', 'AllowDelete', 'AllowEdit', 'Index', 'InsertAtEnd',
  'InsertIfEmpty', 'MaxAccessRight', 'StartPosition',
] as const;

/** The Yes/No properties among them. */
const YES_NO_PROPERTIES: readonly string[] = [
  'AutoNotify', 'AutoQuery', 'AutoSearch', 'CrossCompanyAutoQuery', 'DelayActive', 'OnlyFetchActive',
  'AllowCheck', 'AllowCreate', 'AllowDelete', 'AllowEdit', 'InsertAtEnd', 'InsertIfEmpty',
];

/** The children of an AxFormDataSource whose relative order is established, in that order. */
const KNOWN_ORDER: readonly string[] = [
  'Name', 'Table', 'Fields', 'ReferencedDataSources', ...FORM_DATA_SOURCE_PROPERTIES,
  'DataSourceLinks', 'DerivedDataSources',
];

/** Member names of the platform's form data source link type enum. */
export const FORM_DATA_SOURCE_LINK_TYPES = [
  'InnerJoin', 'OuterJoin', 'ExistJoin', 'NotExistJoin', 'Delayed', 'Active', 'Passive',
] as const;

export type FormDataSourcePropertyOutcome =
  | {
      ok: true;
      xml: string;
      /** False when the file already carried exactly this value — nothing to write. */
      changed: boolean;
      /** Human-readable account of what happened, for the tool reply. */
      detail: string;
    }
  | { ok: false; reason: string };

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Names of the data sources the document defines, in file order. */
export function formDataSourceNames(xml: string): string[] {
  const names: string[] = [];
  const re = /<AxFormDataSource xmlns="">\s*<Name>([^<]*)<\/Name>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) names.push(m[1].trim());
  return names;
}

/**
 * Set `propertyName` = `propertyValue` on the data source `dataSourceName` of an
 * AxForm or AxFormExtension. An empty value removes the element, which puts the
 * property back to its default. InsertIfEmpty=Yes does the same: Yes is its
 * default and the platform never writes it. The defaults of the other properties
 * are not established here, so their value is written as given (Yes/No
 * properties take Yes or No).
 *
 * `joinSourceCheck: 'skip-when-absent'` is for a form extension, whose data
 * source may join a data source of the BASE form that this file does not hold.
 */
export function upsertFormDataSourceProperty(
  xml: string,
  dataSourceName: string,
  propertyName: string,
  propertyValue: string,
  options: { joinSourceCheck?: 'strict' | 'skip-when-absent' } = {},
): FormDataSourcePropertyOutcome {
  const eol = detectEol(xml);
  const content = xml.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const finish = (text: string): string => (eol === '\n' ? text : text.replace(/\n/g, '\r\n'));

  const all = formDataSourceNames(content);
  // Case-insensitive, like the bridge's own "already exists" check on add-data-source.
  const block = new RegExp(
    `^([\\t ]*)<AxFormDataSource xmlns="">\\n([\\t ]+)<Name>${escapeRegExp(dataSourceName.trim())}</Name>\\n` +
      `[\\s\\S]*?^\\1</AxFormDataSource>`,
    'mi',
  ).exec(content);
  if (!block) {
    return {
      ok: false,
      reason:
        `data source '${dataSourceName}' was not found. ` +
        (all.length > 0 ? `Data sources in this file: ${all.join(', ')}.` : 'This file defines no data sources.'),
    };
  }
  const childIndent = block[2];
  const dsName = new RegExp(`^${childIndent}<Name>([^<]*)</Name>`, 'm').exec(block[0])![1];

  const property = FORM_DATA_SOURCE_PROPERTIES.find(p => p.toLowerCase() === propertyName.trim().toLowerCase());
  if (!property) {
    return {
      ok: false,
      reason:
        `'${propertyName}' cannot be set on a form data source by this server. Supported: ` +
        `${FORM_DATA_SOURCE_PROPERTIES.join(', ')}. The platform drops an element written out of order, ` +
        `and other data source properties are too rare in standard forms to place with certainty. Set it in the form designer.`,
    };
  }

  // ── The value to write; '' means "remove the element" ────────────────────
  let value = String(propertyValue).trim();
  let note = '';
  if (property === 'JoinSource' && value !== '') {
    const target = all.find(n => n.toLowerCase() === value.toLowerCase());
    if (target && target.toLowerCase() === dsName.toLowerCase()) {
      return { ok: false, reason: `a data source cannot join itself ('${dsName}').` };
    }
    if (target) {
      value = target; // the spelling the form declares
    } else if (options.joinSourceCheck === 'skip-when-absent' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      note = ` '${value}' is not a data source of this extension, so it was not checked: it must be a data source of the base form.`;
    } else {
      return {
        ok: false,
        reason:
          `JoinSource '${value}' is not a data source of this form. ` +
          `Data sources: ${all.filter(n => n.toLowerCase() !== dsName.toLowerCase()).join(', ') || '(none other)'}.`,
      };
    }
  }
  if (property === 'LinkType' && value !== '') {
    const linkType = FORM_DATA_SOURCE_LINK_TYPES.find(t => t.toLowerCase() === value.toLowerCase());
    if (!linkType) {
      return {
        ok: false,
        reason: `'${value}' is not a valid LinkType. Valid values: ${FORM_DATA_SOURCE_LINK_TYPES.join(', ')}.`,
      };
    }
    value = linkType;
  }
  if (YES_NO_PROPERTIES.includes(property) && value !== '') {
    const flag = value.toLowerCase();
    if (flag === 'no' || flag === 'false') value = 'No';
    else if (flag === 'yes' || flag === 'true') value = 'Yes';
    else return { ok: false, reason: `${property} takes Yes or No, not '${value}'.` };
    // Yes is InsertIfEmpty's default and the platform never writes it.
    if (property === 'InsertIfEmpty' && value === 'Yes') value = '';
  } else if (!['JoinSource', 'LinkType'].includes(property) && value !== '' && !/^[A-Za-z_][\w.]*$/.test(value)) {
    return { ok: false, reason: `'${value}' is not a plain name, so it was not written as ${property}.` };
  }

  // ── Replace or remove an element that is already there ───────────────────
  const existing = new RegExp(`^${childIndent}<${property}>([^<]*)</${property}>\\n`, 'm').exec(block[0]);
  const splice = (updatedBlock: string): string =>
    finish(content.slice(0, block.index) + updatedBlock + content.slice(block.index + block[0].length));
  const shown = property === 'InsertIfEmpty' && value === '' ? 'Yes' : value;

  if (existing) {
    const current = existing[1].trim();
    if (current === value) {
      return { ok: true, xml, changed: false, detail: `${dsName}.${property} is already '${value}'` };
    }
    const line = value === '' ? '' : `${childIndent}<${property}>${value}</${property}>\n`;
    const updated = block[0].slice(0, existing.index) + line + block[0].slice(existing.index + existing[0].length);
    return {
      ok: true,
      xml: splice(updated),
      changed: true,
      detail: value === ''
        ? `removed ${dsName}.${property} (was '${current}', now its default${shown ? ` ${shown}` : ''})`
        : `set ${dsName}.${property}='${value}' (was '${current}')${note}`,
    };
  }
  if (value === '') {
    return {
      ok: true, xml, changed: false,
      detail: `${dsName}.${property} is not set — already its default${shown ? ` (${shown})` : ''}`,
    };
  }

  // ── Insert before the first child that follows it in the platform's order ─
  const children = [...block[0].matchAll(new RegExp(`^${childIndent}<([A-Za-z_][\\w.]*)`, 'gm'))];
  const rank = KNOWN_ORDER.indexOf(property);
  // The rare elements outside the chain are known to follow InsertIfEmpty, and so
  // everything up to it. Next to MaxAccessRight or StartPosition their side is unknown.
  const beforeRare = rank <= KNOWN_ORDER.indexOf('InsertIfEmpty');
  const follows = (name: string): boolean =>
    KNOWN_ORDER.indexOf(name) > rank || (beforeRare && FORM_DATA_SOURCE_AFTER_INSERT_IF_EMPTY.includes(name));
  // Everything but the elements in FORM_DATA_SOURCE_AFTER_INSERT_IF_EMPTY precedes
  // InsertIfEmpty, so it needs no check. Any other property does.
  const unplaced = property === 'InsertIfEmpty'
    ? []
    : [...new Set(children.map(c => c[1]).filter(n => !KNOWN_ORDER.includes(n) && !follows(n)))];
  if (unplaced.length > 0) {
    return {
      ok: false,
      reason:
        `data source '${dsName}' already carries ${unplaced.map(n => `<${n}>`).join(', ')}, and where ` +
        `<${property}> goes relative to ${unplaced.length === 1 ? 'it' : 'them'} is not established. The ` +
        `platform drops an element written out of order, so nothing was written. Set ${property} in the form designer.`,
    };
  }
  const next = children.find(c => follows(c[1]));
  let at: number;
  if (next) {
    at = next.index!;
  } else if (property === 'InsertIfEmpty') {
    return { ok: false, reason: `no insertion point for InsertIfEmpty in data source '${dsName}'.` };
  } else {
    // Nothing follows it: the last child of the data source, before its closing tag.
    at = block[0].lastIndexOf('\n') + 1;
  }
  const updated = `${block[0].slice(0, at)}${childIndent}<${property}>${value}</${property}>\n${block[0].slice(at)}`;
  return { ok: true, xml: splice(updated), changed: true, detail: `set ${dsName}.${property}='${value}'${note}` };
}
