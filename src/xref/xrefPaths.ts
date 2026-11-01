/**
 * The path logic of the C# bridge's cross-reference queries, ported for the
 * SQLite provider (sqliteXrefProvider.ts). Source:
 * bridge/D365MetadataBridge/Services/CrossReferenceService.cs. Keep the two in
 * step: the provider must answer with exactly the targets, categories and
 * classifications the bridge would, so that tool output does not depend on which
 * of the two answered. The reasons behind each rule are documented there; only
 * what differs in SQLite is explained here.
 *
 * The bridge expresses a target set as `Path IN (…) OR Path LIKE …` against SQL
 * Server's case-insensitive collation. A LIKE cannot use the NOCASE index on
 * Names.Path in SQLite (the column itself is BINARY), so every pattern is split
 * into a literal prefix, scanned as an index range, and — only when the pattern
 * has more after its first wildcard — a LIKE that filters the rows of that range.
 */

// DYNAMICSXREFDB [References].Kind values (CrossReferenceService.cs, Kind constants).
export const KIND_CALL = 1;
export const KIND_TYPE_REF = 2;
export const KIND_IMPLEMENTS = 3;
export const KIND_EXTENDS = 4;
export const KIND_DELEGATE = 6;
export const KIND_ATTRIBUTE = 7;
export const KIND_TAG = 9;
export const KIND_OVERRIDE = 10;

/** A LIKE pattern as an index range: names starting with `prefix`, then filtered by `like` if set. */
export interface PathPattern {
  prefix: string;
  /** Full SQLite LIKE pattern (escape character `\`), when the prefix alone over-matches. */
  like?: string;
}

/** The target set of a lookup: exact paths plus patterns. */
export interface PathTargets {
  exact: string[];
  patterns: PathPattern[];
}

/** Escape a literal for a SQLite LIKE pattern with ESCAPE '\'. */
export function escapeLike(literal: string): string {
  return literal.replace(/[\\%_]/g, ch => `\\${ch}`);
}

/**
 * Fold ASCII A-Z to lower case, as SQLite's NOCASE collation does (and nothing
 * else: NOCASE leaves non-ASCII characters alone).
 */
export function foldNocase(s: string): string {
  return s.replace(/[A-Z]/g, ch => ch.toLowerCase());
}

/**
 * The half-open NOCASE range [lo, hi) holding every string that starts with
 * `prefix`, ignoring ASCII case. Bounds are folded first: NOCASE compares the
 * folded strings, so an unfolded upper bound after "Z" ("[") would sort below
 * "z…" and drop it.
 */
export function prefixRange(prefix: string): { lo: string; hi: string } {
  const lo = foldNocase(prefix);
  if (lo.length === 0) return { lo, hi: '\u{10FFFF}' };
  const last = lo.charCodeAt(lo.length - 1);
  return { lo, hi: lo.slice(0, -1) + String.fromCharCode(last + 1) };
}

/** Parse "/Classes/X/Methods/y" into its first four segments. */
export function parsePath(path: string): {
  objectType: string;
  objectName: string;
  segment?: string;
  segmentName?: string;
} {
  const parts = path.split('/').filter(Boolean);
  return {
    objectType: parts[0] ?? '',
    objectName: parts[1] ?? '',
    segment: parts[2],
    segmentName: parts[3],
  };
}

/** Last slash-separated segment of a path, or undefined when it has none. */
export function leafSegment(path: string): string | undefined {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : undefined;
}

/** CategorizeReference: the reference type from its Kind, refined by the target's shape. */
export function categorizeReference(kind: number | null | undefined, targetPath: string): string {
  switch (kind) {
    case KIND_CALL:
      return 'call';
    case KIND_IMPLEMENTS:
      return 'implements';
    case KIND_EXTENDS:
      return 'extends';
    case KIND_DELEGATE:
      return 'delegate-declaration';
    case KIND_ATTRIBUTE:
      return 'attribute';
    case KIND_TAG:
      return 'tag';
    case KIND_OVERRIDE:
      return 'override';
  }
  if (targetPath.includes('/Fields/')) return 'field-access';
  const { segment } = parsePath(targetPath);
  if (segment === 'Methods') return 'method-reference';
  if (!segment) return 'type-reference';
  return 'reference';
}

const MEMBER_CONTAINERS = ['Tables', 'Classes', 'Forms', 'Views', 'DataEntityViews', 'Queries', 'Maps'];

const BARE_NAME_CONTAINERS = [
  'Tables',
  'Classes',
  'Enums',
  'Views',
  'DataEntityViews',
  'Queries',
  'Forms',
  'Edts',
  'Maps',
  'Reports',
  'MenuItemDisplays',
  'MenuItemActions',
  'MenuItemOutputs',
];

const METADATA_TYPES: Record<string, string[]> = {
  Tables: ['Table'],
  Classes: ['Class'],
  Enums: ['Enum'],
  Views: ['View'],
  DataEntityViews: ['DataEntityView'],
  Queries: ['QuerySimple', 'QueryComposite'],
  Forms: ['Form'],
  Maps: ['Map'],
  Reports: ['Report'],
  MenuItemDisplays: ['MenuItemDisplay'],
  MenuItemActions: ['MenuItemAction'],
  MenuItemOutputs: ['MenuItemOutput'],
  Edts: [
    'EdtString',
    'EdtReal',
    'EdtEnum',
    'EdtInt64',
    'EdtDate',
    'EdtInt',
    'EdtUtcDateTime',
    'EdtContainer',
    'EdtGuid',
    'EdtTime',
  ],
};

const METADATA_FIELD_SEGMENTS: Record<string, string[]> = {
  Tables: [
    'TableFieldString',
    'TableFieldEnum',
    'TableFieldReal',
    'TableFieldInt64',
    'TableFieldInt',
    'TableFieldDate',
    'TableFieldUtcDateTime',
    'TableFieldGuid',
    'TableFieldContainer',
    'TableFieldTime',
  ],
  Maps: [
    'MapFieldString',
    'MapFieldEnum',
    'MapFieldReal',
    'MapFieldInt64',
    'MapFieldInt',
    'MapFieldDate',
    'MapFieldUtcDateTime',
    'MapFieldGuid',
    'MapFieldContainer',
    'MapFieldTime',
  ],
  Views: [
    'ViewFieldBound',
    'ViewFieldComputedString',
    'ViewFieldComputedEnum',
    'ViewFieldComputedReal',
    'ViewFieldComputedInt64',
    'ViewFieldComputedInt',
    'ViewFieldComputedDate',
    'ViewFieldComputedUtcDateTime',
  ],
  DataEntityViews: [
    'DataEntityViewMappedField',
    'DataEntityViewUnmappedFieldString',
    'DataEntityViewUnmappedFieldEnum',
    'DataEntityViewUnmappedFieldReal',
    'DataEntityViewUnmappedFieldInt64',
    'DataEntityViewUnmappedFieldInt',
    'DataEntityViewUnmappedFieldDate',
    'DataEntityViewUnmappedFieldUtcDateTime',
    'DataEntityViewUnmappedFieldGuid',
    'DataEntityViewUnmappedFieldContainer',
  ],
};

/** AddMetadataTwins: the metadata-shaped twins of an X++-shaped path. */
function addMetadataTwins(xppPath: string, exact: string[]): void {
  if (!xppPath.startsWith('/')) return;
  const parts = xppPath.split('/').filter(Boolean);
  const types = METADATA_TYPES[parts[0]];
  if (parts.length < 2 || !types) return;
  if (parts.length === 2) {
    for (const t of types) exact.push(`${t}/${parts[1]}`);
  } else if (parts.length === 4) {
    if (parts[2] === 'Methods') {
      for (const t of types) exact.push(`${t}/${parts[1]}/Method/${parts[3]}`);
    } else if (parts[2] === 'Fields' && METADATA_FIELD_SEGMENTS[parts[0]]) {
      for (const t of types) {
        for (const s of METADATA_FIELD_SEGMENTS[parts[0]]) exact.push(`${t}/${parts[1]}/${s}/${parts[3]}`);
      }
    } else if (parts[2] === 'EnumValues' && parts[0] === 'Enums') {
      exact.push(`Enum/${parts[1]}/EnumValue/${parts[3]}`);
    } else if (parts[2] === 'TableIndexs') {
      for (const t of types) exact.push(`${t}/${parts[1]}/TableIndex/${parts[3]}`);
    } else if (parts[2] === 'TableFieldGroups') {
      for (const t of types) exact.push(`${t}/${parts[1]}/TableFieldGroup/${parts[3]}`);
    }
  } else if (parts.length === 6 && parts[0] === 'Forms' && parts[2] === 'DataSources' && parts[4] === 'Methods') {
    exact.push(`Form/${parts[1]}/FormDataSourceRoot/${parts[3]}/Method/${parts[5]}`);
  }
}

/**
 * AddExtensionMembers: a field or enum value added by an extension, stored under
 * "<base>.<suffix>". The bridge's pattern "/TableExtensions/<base>.%/Fields/<f>"
 * becomes the range "/TableExtensions/<base>." filtered by that same LIKE.
 */
function addExtensionMembers(xppPath: string, patterns: PathPattern[]): void {
  const parts = xppPath.split('/').filter(Boolean);
  if (!xppPath.startsWith('/') || parts.length !== 4) return;
  const ext = (prefix: string, rest: string) =>
    patterns.push({ prefix, like: `${escapeLike(prefix)}%${escapeLike(rest)}` });
  if (parts[0] === 'Tables' && parts[2] === 'Fields') {
    ext(`/TableExtensions/${parts[1]}.`, `/Fields/${parts[3]}`);
    for (const s of METADATA_FIELD_SEGMENTS.Tables) ext(`TableExtension/${parts[1]}.`, `/${s}/${parts[3]}`);
  } else if (parts[0] === 'Enums' && parts[2] === 'EnumValues') {
    ext(`/EnumExtensions/${parts[1]}.`, `/EnumValues/${parts[3]}`);
    ext(`EnumExtension/${parts[1]}.`, `/EnumValue/${parts[3]}`);
  }
}

/**
 * The target set FindReferences queries for `objectPath`: an explicit path,
 * "Owner.member", or a bare name expanded across every container.
 */
export function referenceTargets(objectPath: string): PathTargets {
  let variants: string[] = [];
  let memberQualified = false;
  if (objectPath.includes('/')) {
    variants.push(objectPath);
    memberQualified = [
      '/Methods/',
      '/Fields/',
      '/Method/',
      '/TableField',
      '/EnumValues/',
      '/EnumValue/',
      '/TableIndexs/',
      '/TableIndex/',
      '/TableFieldGroups/',
      '/TableFieldGroup/',
    ].some(s => objectPath.includes(s));
  } else if (objectPath.includes('.')) {
    memberQualified = true;
    const dot = objectPath.lastIndexOf('.');
    const owner = objectPath.slice(0, dot);
    const member = objectPath.slice(dot + 1);
    for (const c of MEMBER_CONTAINERS) {
      variants.push(`/${c}/${owner}/Methods/${member}`);
      variants.push(`/${c}/${owner}/Fields/${member}`);
    }
    variants.push(`/Enums/${owner}/EnumValues/${member}`);
    const ownerDot = owner.indexOf('.');
    if (ownerDot > 0 && owner.indexOf('.', ownerDot + 1) < 0) {
      variants.push(`/Forms/${owner.slice(0, ownerDot)}/DataSources/${owner.slice(ownerDot + 1)}/Methods/${member}`);
    }
  } else {
    for (const c of BARE_NAME_CONTAINERS) variants.push(`/${c}/${objectPath}`);
  }

  const patterns: PathPattern[] = [];
  for (const p of [...variants]) {
    addMetadataTwins(p, variants);
    addExtensionMembers(p, patterns);
  }
  variants = [...new Set(variants)];
  // Children of a non-member target ("p/%"): a plain prefix, no LIKE needed.
  const children = memberQualified ? [] : variants.map(p => ({ prefix: `${p}/` }));
  return { exact: variants, patterns: [...children, ...patterns] };
}

/** The attribute a Chain of Command class carries ("ExtensionOf", not "ExtensionOfAttribute"). */
export const EXTENSION_OF_ATTRIBUTE_PATH = '/Classes/ExtensionOf';

/** Containers a CoC class extension can be based on. */
export const COC_BASE_CONTAINERS = ['Classes', 'Tables', 'Forms', 'Views', 'Maps', 'DataEntityViews', 'Queries'];

/** The candidate elements of FindExtensionClasses: "/<C>/<base>" and everything under it. */
export function extensionCandidateTargets(baseName: string): PathTargets {
  return {
    exact: COC_BASE_CONTAINERS.map(c => `/${c}/${baseName}`),
    patterns: COC_BASE_CONTAINERS.map(c => ({ prefix: `/${c}/${baseName}/` })),
  };
}

/**
 * ResolveExtendedElement: the terminal element of the prefix chain the
 * [ExtensionOf] intrinsic's arguments produce, bounded to that attribute's own
 * argument window. Undefined when the declaration produced no usable target.
 */
export function resolveExtendedElement(
  refs: Array<{ target: string; kind: number; col: number }>,
  extCol: number,
): string | undefined {
  let limit = Number.MAX_SAFE_INTEGER;
  for (const { target, kind, col } of refs) {
    if (kind === KIND_ATTRIBUTE && target !== EXTENSION_OF_ATTRIBUTE_PATH && col > extCol && col < limit) limit = col;
  }
  const scoped: string[] = [];
  for (const { target, kind, col } of refs) {
    if (kind === KIND_TYPE_REF && col > extCol && col < limit && !scoped.includes(target)) scoped.push(target);
  }
  if (scoped.length === 0) return undefined;
  for (const candidate of scoped) {
    const prefix = `${candidate}/`.toLowerCase();
    if (!scoped.some(other => other !== candidate && other.toLowerCase().startsWith(prefix))) return candidate;
  }
  return [...scoped].sort((a, b) => b.length - a.length)[0];
}

/** IsRequestedOrNested: the element is the requested object or nested inside it. */
export function isRequestedOrNested(element: string, baseName: string): boolean {
  const el = element.toLowerCase();
  return COC_BASE_CONTAINERS.some(c => {
    const basePath = `/${c}/${baseName}`.toLowerCase();
    return el === basePath || el.startsWith(`${basePath}/`);
  });
}

/** FindEventSubscribers' targets: the table or class of that name and everything under it. */
export function eventSubscriberTargets(targetName: string): PathTargets {
  return {
    exact: [`/Tables/${targetName}`, `/Classes/${targetName}`],
    patterns: [{ prefix: `/Tables/${targetName}/` }, { prefix: `/Classes/${targetName}/` }],
  };
}

/**
 * The bridge's source filter for event subscribers, as SQLite LIKE terms. The
 * unescaped "_" is the bridge's own (any single character), kept for parity.
 */
export const EVENT_SOURCE_FILTER =
  "src.Path LIKE '/Classes/%' AND (src.Path LIKE '%EventHandler%' OR src.Path LIKE '%_Handler%' " +
  "OR src.Path LIKE '%Events%' OR src.Path LIKE '%_Extension%')";

/** ClassifyHandlerType: handler type from naming conventions. */
export function classifyHandlerType(className: string, methodName: string | undefined): string {
  const combined = `${className}.${methodName ?? ''}`.toLowerCase();
  if (['dataevent', 'oninserted', 'onupdated', 'ondeleted', 'onvalidated', 'oninit'].some(s => combined.includes(s))) {
    return 'dataEvent';
  }
  if (combined.includes('pre_') || combined.includes('_pre')) return 'pre';
  if (combined.includes('post_') || combined.includes('_post')) return 'post';
  if (combined.includes('delegate')) return 'delegate';
  return 'static';
}

const STANDARD_EVENTS = [
  'oninserted',
  'onupdated',
  'ondeleted',
  'onvalidatedwrite',
  'onvalidatedinsert',
  'onvalidateddelete',
  'oninitialized',
  'oninitvalue',
];

/** ExtractEventName: the standard event a handler method names, else the method name. */
export function extractEventName(methodName: string | undefined): string | undefined {
  if (methodName === undefined) return undefined;
  const lower = methodName.toLowerCase();
  for (const ev of STANDARD_EVENTS) {
    if (lower.includes(ev)) return ev[0].toUpperCase() + ev.slice(1);
  }
  return methodName;
}

/** FindApiUsageCallers' targets: an explicit path, or the class/table of that name and its members. */
export function apiUsageTargets(apiName: string): PathTargets {
  if (apiName.startsWith('/')) return { exact: [apiName], patterns: [] };
  return {
    exact: [`/Classes/${apiName}`, `/Tables/${apiName}`],
    patterns: [{ prefix: `/Classes/${apiName}/` }, { prefix: `/Tables/${apiName}/` }],
  };
}
