/**
 * resolve_references — semantic reference resolver for generated X++ code.
 *
 * Anti-hallucination gate: extracts every external identifier from an X++
 * snippet and verifies it against the indexed codebase (symbols DB, labels DB,
 * extension_metadata, menu_item_targets). Nothing is assumed from training
 * data — a reference is either proven by the index or reported.
 *
 * Verified reference kinds:
 *   - Intrinsic functions: classStr/tableStr/fieldStr/enumStr/extendedTypeStr/
 *     formStr/queryStr/methodStr/menuItem*Str(...) — args are compile-time
 *     checked by the real X++ compiler, so they must exist in the index
 *   - Static member access  Type::member  (incl. arity check from signature)
 *   - Variable declarations TypeName varName — type must exist
 *   - Bound buffer access   buffer.Field / buffer.method() when the variable
 *     was declared in the snippet with a table/view type from the index
 *   - Label references      "@File:Id" and legacy "@SYS12345"
 *
 * Severity model (conservative — false blocks are worse than misses):
 *   error   — intrinsic target missing, static type/method missing,
 *             field missing on a confidently-bound table, arity mismatch,
 *             modern label id missing in a known label file
 *   warning — unknown declared type (kernel classes are not in metadata XML),
 *             instance method missing, legacy label not found,
 *             label file unknown (may be created later in the same task)
 */

import { z } from 'zod';
import { KERNEL_ENUM_NAMES } from '../../knowledge/kernelEnums.js';
import type { XppServerContext } from '../../types/context.js';
import { canonicalSymbolName, distinctSymbolTypesNocase, lookupSymbolNocase } from '../../utils/symbolLookup.js';
import {
  UNKNOWN_PARAMETER_LIST,
  parseXppDeclaration,
  renderMethodSignature,
} from '../../metadata/xppDeclaration.js';
import {
  getModelVisibility,
  packagesRootFromPath,
  type ModelVisibility,
} from '../../metadata/modelDescriptor.js';
import { getConfigManager } from '../../utils/configManager.js';

export const resolveReferencesArgsSchema = z.object({
  code: z.string().describe(
    'X++ source code to resolve. Paste the full generated method/class text.'
  ),
  context: z.string().optional().describe(
    'Optional: owning class/table name, used in diagnostic messages.'
  ),
});

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.

export interface ReferenceViolation {
  /**
   * The check could not run at all — the index held nothing to check against —
   * as opposed to running and finding the reference acceptable. Carried
   * separately from `severity` because the two audiences differ: a reader wants
   * a warning, while the write gate must treat "unchecked" as unproven.
   */
  unverifiable?: boolean;
  kind:
    | 'unknown-type'
    | 'unknown-static-member'
    | 'unknown-method'
    | 'unknown-field'
    | 'unknown-label'
    | 'label-placeholder-mismatch'
    | 'unknown-intrinsic-target'
    | 'arity-mismatch'
    | 'not-visible-from-model';
  severity: 'error' | 'warning';
  line: number;
  identifier: string;
  detail: string;
}

export interface ResolveResult {
  violations: ReferenceViolation[];
  /** Count of references that were positively verified against the index */
  verifiedCount: number;
}

/** Minimal DB surface the resolver needs — satisfied by src/database/sqlite.ts. */
export interface ResolverDeps {
  db: {
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
  };
  getLabelById(
    labelId: string,
    labelFileId?: string,
  ): Array<{ labelId: string; labelFileId: string; language?: string; text?: string }>;
  getLabelFileIds(): Array<{ labelFileId: string }>;
  /**
   * Optional Descriptor-backed answer to "may the target model see this type?".
   * Presence in the index is not visibility. Absent, the check is not run.
   */
  visibility?: ModelVisibility;
}

const XPP_KEYWORDS = new Set([
  'abstract', 'anytype', 'as', 'asc', 'at', 'avg', 'break', 'breakpoint', 'by',
  'byref', 'case', 'catch', 'changecompany', 'class', 'client', 'const', 'container',
  'continue', 'count', 'crosscompany', 'default', 'delegate', 'delete_from', 'desc',
  'display', 'div', 'do', 'edit', 'element', 'else', 'eventhandler', 'exists',
  'extends', 'false', 'final', 'finally', 'firstfast', 'firstonly', 'firstonly10',
  'firstonly100', 'firstonly1000', 'flush', 'for', 'forceliterals', 'forcenestedloop',
  'forceplaceholders', 'forceselectorder', 'forupdate', 'from', 'generateonly',
  'group', 'if', 'implements', 'index', 'insert_recordset', 'interface', 'internal',
  'is', 'join', 'like', 'maxof', 'minof', 'mod', 'new', 'next', 'nofetch',
  'notexists', 'null', 'optimisticlock', 'order', 'outer', 'pause', 'pessimisticlock',
  'print', 'private', 'protected', 'public', 'readonly', 'repeatableread', 'retry',
  'return', 'reverse', 'select', 'server', 'setting', 'static', 'sum', 'super',
  'switch', 'tablelock', 'this', 'throw', 'true', 'try', 'ttsabort', 'ttsbegin',
  'ttscommit', 'update_recordset', 'using', 'validtimestate', 'void', 'where',
  'while', 'window',
]);

const XPP_BUILTIN_TYPES = new Set([
  'int', 'int64', 'real', 'str', 'boolean', 'date', 'utcdatetime', 'timeofday',
  'anytype', 'container', 'guid', 'void', 'var',
]);

/**
 * Kernel (binary) classes are NOT present in PackagesLocalDirectory metadata
 * XML, so the index cannot prove them. Common ones are allow-listed; unknown
 * declared types degrade to warnings precisely because this list is not
 * exhaustive.
 */
const KERNEL_TYPES = new Set([
  'object', 'xrecord', 'common', 'xsession', 'xinfo', 'xglobal', 'xapplication',
  'xversion', 'args', 'classfactory',
  // Forms
  'formrun', 'formdatasource', 'formdataobject', 'formcontrol', 'formdesign',
  'formstringcontrol', 'formbuttoncontrol', 'formcheckboxcontrol',
  'formcomboboxcontrol', 'formdatecontrol', 'formdatetimecontrol',
  'formintcontrol', 'formint64control', 'formrealcontrol', 'formgridcontrol',
  'formgroupcontrol', 'formtabcontrol', 'formtabpagecontrol',
  'formreferencegroupcontrol', 'formfunctionbuttoncontrol',
  'formcommandbuttoncontrol', 'formmenubuttoncontrol', 'formactionpanecontrol',
  'formactionpanetabcontrol', 'formbuttongroupcontrol', 'formstaticcontrol',
  'formwindowcontrol', 'formtreecontrol', 'formlistcontrol',
  // Query framework
  'query', 'queryrun', 'querybuilddatasource', 'querybuildrange',
  'querybuildlink', 'querybuildfieldlist', 'queryfilter', 'queryhavingfilter',
  // Collections
  'map', 'set', 'list', 'array', 'struct', 'listenumerator', 'listiterator',
  'mapenumerator', 'setenumerator', 'recordinsertlist', 'recordsortedlist',
  'recordlinklist',
  // Reflection
  'dicttable', 'dictfield', 'dictclass', 'dictenum', 'dicttype', 'dictindex',
  'dictrelation', 'dictview', 'treenode',
  // IO / misc
  'textbuffer', 'binary', 'xmldocument', 'xmlelement', 'xmlnode', 'xmlnodelist',
  'xmlattribute', 'xmlreader', 'xmlwriter', 'textio', 'commaio', 'asciiio',
  'connection', 'userconnection', 'statement', 'resultset', 'sqlsystem',
  'sqldatadictionary', 'sqlstatementexecutepermission', 'executepermission',
  'fileiopermission', 'runaspermission', 'datetimeutil', 'timezone', 'random',
  'runbase', 'image', 'clrinterop', 'clrobject', 'thread', 'webrequest',
  'webresponse', 'gc', 'session', 'infolog', 'debug', 'global',
  // Kernel ENUMS come from knowledge/kernelEnums.ts. They used to be spelled out
  // here, which is why this path accepted NoYes:: while the XML <EnumType> checker
  // hard-errored on the same enum — the knowledge existed in one path only.
  ...KERNEL_ENUM_NAMES,
]);

/** Methods available on every table buffer via the kernel xRecord/Common base. */
const TABLE_BUILTIN_METHODS = new Set([
  'insert', 'doinsert', 'update', 'doupdate', 'delete', 'dodelete', 'write',
  'validatewrite', 'validatedelete', 'validatefield', 'validatefieldvalue',
  'initvalue', 'modifiedfield', 'modifiedfieldvalue', 'clear', 'selectforupdate',
  'selectlocked', 'reread', 'checkrecord', 'skipdatamethods', 'skipdatabaselog',
  'skipevents', 'skipdeleteactions', 'skipdeletemethod', 'skipaosvalidation',
  'merge', 'data', 'orig', 'postload', 'caption', 'helpfield', 'tooltipfield',
  'tooltiprecord', 'defaultfield', 'defaultrow', 'settmp', 'settmpdata',
  'istmp', 'wasvalidated', 'recordlevelsecurity', 'cansubmittoworkflow',
  'tablename', 'fieldbuffercount', 'dispose', 'getfieldvalue', 'setfieldvalue',
  'existsalready', 'renameprimarykey', 'aosvalidatedelete', 'aosvalidateinsert',
  'aosvalidateread', 'aosvalidateupdate', 'joinchildren', 'rowcount', 'queryrun',
]);

/** System fields present on every table (kernel-managed, not in metadata XML). */
const TABLE_SYSTEM_FIELDS = new Set([
  'recid', 'tableid', 'dataareaid', 'recversion', 'partition',
  'createddatetime', 'createdby', 'modifieddatetime', 'modifiedby',
  'createdtransactionid', 'modifiedtransactionid',
]);

/** Methods available on every class instance via the kernel Object base. */
const OBJECT_BUILTIN_METHODS = new Set([
  'new', 'finalize', 'tostring', 'handle', 'notify', 'wait', 'objectonserver',
  'usagecount', 'owner', 'gettimeouttimerhandle', 'cancurrenttimeout',
  'setrefcountzero', 'equal',
]);

const TABLE_LIKE_TYPES = new Set(['table', 'view', 'map', 'data-entity', 'table-extension']);

// Intrinsic function → expected symbol types of the FIRST argument.
// null = any indexed symbol type counts (e.g. identifierStr).
const INTRINSIC_TARGET_TYPES: Record<string, string[] | null> = {
  classstr: ['class', 'class-extension'],
  classnum: ['class', 'class-extension'],
  tablestr: ['table', 'view', 'map', 'data-entity', 'table-extension'],
  tablenum: ['table', 'view', 'map', 'data-entity'],
  fieldstr: ['table', 'view', 'map', 'data-entity'],
  fieldnum: ['table', 'view', 'map', 'data-entity'],
  enumstr: ['enum'],
  enumnum: ['enum'],
  enumcnt: ['enum'],
  extendedtypestr: ['edt'],
  extendedtypenum: ['edt'],
  formstr: ['form'],
  querystr: ['query'],
  viewstr: ['view'],
  mapstr: ['map'],
  methodstr: ['class', 'table', 'form', 'class-extension'],
  staticmethodstr: ['class', 'class-extension'],
  dataentitydatasourcestr: ['data-entity'],
  tablefieldgroupstr: ['table', 'table-extension'],
  menuitemdisplaystr: null,
  menuitemactionstr: null,
  menuitemoutputstr: null,
  tilestr: null,
  resourcestr: null,
  reportstr: ['report'],
  // 2nd argument is the DESIGN name inside the report — not an indexed symbol,
  // so only the report itself is resolved here (design existence is a build check).
  ssrsreportstr: ['report'],
  delegatestr: ['class', 'table', 'form', 'class-extension'],
  staticdelegatestr: ['class', 'table', 'form', 'class-extension'],
  attributestr: ['class', 'class-extension'],
  indexstr: ['table', 'view', 'data-entity', 'table-extension'],
  tablemethodstr: ['table', 'view', 'map', 'data-entity', 'table-extension'],
  tablestaticmethodstr: ['table', 'view', 'map', 'data-entity', 'table-extension'],
};

interface CleanedCode {
  /** Code with comments and string literals blanked (length-preserving). */
  cleaned: string;
  /** String literals with their offsets (for label extraction). */
  strings: Array<{ value: string; index: number }>;
}

/** Blank comments and string literals while preserving offsets/line numbers. */
function cleanCode(code: string): CleanedCode {
  const strings: Array<{ value: string; index: number }> = [];
  const chars = code.split('');
  const n = chars.length;
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (chars[k] !== '\n') chars[k] = ' ';
  };
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && code[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && next === '*') {
      let j = code.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let value = '';
      while (j < n) {
        if (code[j] === '\\' && j + 1 < n) { value += code[j] + code[j + 1]; j += 2; continue; }
        if (code[j] === quote) break;
        value += code[j];
        j++;
      }
      strings.push({ value, index: i + 1 });
      blank(i + 1, Math.min(j, n));
      i = Math.min(j + 1, n);
    } else {
      i++;
    }
  }
  return { cleaned: chars.join(''), strings };
}

function lineOf(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) {
    if (code[i] === '\n') line++;
  }
  return line;
}

function symbolTypes(deps: ResolverDeps, name: string): string[] {
  try {
    // Index-safe nocase lookup — the former `name = ? COLLATE NOCASE` shape
    // full-scanned the symbols table per identifier (13+ s cold).
    return distinctSymbolTypesNocase(deps.db, name);
  } catch {
    return [];
  }
}

function menuItemExists(deps: ResolverDeps, name: string): boolean {
  try {
    const exact = deps.db
      .prepare('SELECT 1 AS x FROM menu_item_targets WHERE menu_item_name = ? LIMIT 1')
      .get(name);
    if (exact !== undefined) return true;
    // Rare differently-cased fallback: bounded covering-index scan (~18k rows).
    const row = deps.db
      .prepare('SELECT 1 AS x FROM menu_item_targets WHERE menu_item_name = ? COLLATE NOCASE LIMIT 1')
      .get(name);
    return row !== undefined;
  } catch {
    return false;
  }
}

interface MethodRow {
  signature: string | null;
  /** X++ body as indexed — arityOf() re-derives the parameter list from it. */
  source: string | null;
}

/** Look up a method on an object, walking the extends_class chain (classes). */
function findMethod(
  deps: ResolverDeps,
  ownerName: string,
  methodName: string,
  depth = 0,
): MethodRow | undefined {
  if (depth > 10) return undefined;
  try {
    // Canonicalize the owner once (exact probe + FTS fallback) so every probe
    // below stays BINARY on idx_parent_type_name / idx_em_base — the former
    // `parent_name = ? COLLATE NOCASE` shape scanned all 627k method rows.
    const ownerHit = lookupSymbolNocase(deps.db, ownerName);
    const owner = ownerHit?.name ?? ownerName;
    const row = deps.db.prepare(
      `SELECT signature, source FROM symbols
       WHERE parent_name = ? AND type = 'method' AND name = ? COLLATE NOCASE
       LIMIT 1`,
    ).get(owner, methodName) as MethodRow | undefined;
    if (row) return row;
    // Extension-added methods (CoC wrappers, augmentation classes)
    let extRows = deps.db.prepare(
      `SELECT added_methods, coc_methods FROM extension_metadata
       WHERE base_object_name = ?`,
    ).all(owner) as Array<{ added_methods: string | null; coc_methods: string | null }>;
    if (extRows.length === 0) {
      // An extension spells its base object however its own name spells it, and
      // that need not match the object's own casing — see the note on
      // extensionAddedFields below for the shipped metadata that proves it.
      // This used to be gated on `!ownerHit`, which skipped the re-probe in
      // exactly the case that needs it: the owner IS indexed, under the other
      // casing. The nocase scan is bounded by extension_metadata, which is small
      // (single-digit thousands of rows) and reached only after the binary probe
      // came back empty.
      extRows = deps.db.prepare(
        `SELECT added_methods, coc_methods FROM extension_metadata
         WHERE base_object_name = ? COLLATE NOCASE`,
      ).all(ownerName) as Array<{ added_methods: string | null; coc_methods: string | null }>;
    }
    const target = methodName.toLowerCase();
    for (const ext of extRows) {
      for (const col of [ext.added_methods, ext.coc_methods]) {
        if (!col) continue;
        try {
          const names = JSON.parse(col) as unknown[];
          if (names.some(m =>
            (typeof m === 'string' ? m : (m as { name?: string })?.name ?? '')
              .toLowerCase() === target,
          )) {
            return { signature: null, source: null };
          }
        } catch { /* malformed JSON — skip */ }
      }
    }
    // Walk inheritance chain
    const parent = lookupSymbolNocase(deps.db, owner, ['class', 'table']);
    if (parent?.extends_class && parent.extends_class.toLowerCase() !== ownerName.toLowerCase()) {
      return findMethod(deps, parent.extends_class, methodName, depth + 1);
    }
  } catch { /* DB error — treat as not found */ }
  return undefined;
}

/**
 * Report a top-level type that IS in the index but lives in a package the target
 * model does not reference. Silent whenever the answer would be a guess; it only
 * fires when EVERY indexed occurrence is provably out of reach.
 *
 * `lookupSymbolsNocase` with a multi-row limit is NOT usable here: a type name
 * never yields that many top-level rows, so its short-circuit never fires and
 * the FTS5 fallback runs to exhaustion — measured 45 ms → 5003 ms for one class
 * body. Canonicalize at limit 1, then probe BINARY `name = ?` on idx_name_type.
 * A differently cased duplicate elsewhere is missed, which only makes the check
 * quieter — the direction it must fail in.
 */
function checkModelVisibility(
  deps: ResolverDeps,
  typeName: string,
  line: number,
): ReferenceViolation | undefined {
  const vis = deps.visibility;
  if (!vis) return undefined;
  let hits: Array<{ file_path: string | null }>;
  try {
    const canonical = canonicalSymbolName(deps.db, typeName);
    if (!canonical) return undefined;
    hits = deps.db
      .prepare('SELECT file_path FROM symbols WHERE name = ? AND parent_name IS NULL LIMIT 16')
      .all(canonical) as Array<{ file_path: string | null }>;
  } catch {
    return undefined;
  }
  if (hits.length === 0) return undefined;

  const packages = new Set<string>();
  for (const hit of hits) {
    const pkg = hit.file_path ? vis.packageOf(hit.file_path) : null;
    if (!pkg) return undefined;                                  // cannot tell
    if (vis.visiblePackages.has(pkg.toLowerCase())) return undefined; // reachable
    packages.add(pkg);
  }

  return {
    kind: 'not-visible-from-model',
    severity: 'error',
    line,
    identifier: typeName,
    detail:
      `"${typeName}" is indexed, but only in package ${[...packages].join(' / ')}, which model ` +
      `${vis.model} does not reference. xppc will reject it ("does not denote a class, a table, ` +
      `or an extended data type"). Add the package to ${vis.model}'s Descriptor ModuleReferences, ` +
      `or use a type from a referenced package.`,
  };
}

/**
 * Extension kinds whose `added_fields` really are columns of a table-like
 * object. `table-extension` alone was too narrow: `fieldExists` is reached for
 * every TABLE_LIKE_TYPES buffer, so a column a VIEW extension contributes
 * (DirPartyPostalAddressView.IsSimplifiedAddress_RU, and 21 more in the shipped
 * metadata on a stock box) was reported as hallucinated.
 *
 * `query-extension` is deliberately absent: it adds a field to a query data
 * source, not to the table, and a query commonly shares its name with the table
 * it reads — so counting it would vouch for columns that do not exist.
 */
const FIELD_ADDING_EXTENSION_TYPES = [
  'table-extension', 'view-extension', 'map-extension', 'data-entity-extension',
] as const;

const FIELD_ADDING_EXTENSION_PLACEHOLDERS =
  FIELD_ADDING_EXTENSION_TYPES.map(() => '?').join(', ');

/** Every field name the indexed extensions contribute to one table-like object. */
function extensionAddedFields(deps: ResolverDeps, tableName: string): string[] {
  let rows = deps.db.prepare(
    `SELECT added_fields FROM extension_metadata
     WHERE base_object_name = ? AND extension_type IN (${FIELD_ADDING_EXTENSION_PLACEHOLDERS})`,
  ).all(tableName, ...FIELD_ADDING_EXTENSION_TYPES) as Array<{ added_fields: string | null }>;

  if (rows.length === 0) {
    // An extension spells its base object the way its OWN name spells it, and
    // that need not match the object's own casing. This is not hypothetical:
    // `vendVendorParametersStaging.*Extension` (4 models), `MarkUpTransTmp.*`
    // and `HCMWorkerActionTerminate.*` all ship against tables the AOT spells
    // `VendVendorParametersStaging`, `MarkupTransTmp`, `HcmWorkerActionTerminate`.
    // The re-probe used to be gated on "the base object is not in the index",
    // which skipped it in exactly the case that hits — the table IS indexed,
    // under the other casing — and every field those extensions add came back
    // `unknown-field`, an ERROR that refuses the write under GROUNDING_ENFORCE.
    //
    // NOCASE cannot use idx_em_base, so this is a scan; it is bounded by
    // extension_metadata (~8k rows, ~0.8 ms) and runs only after the binary
    // probe came back empty.
    rows = deps.db.prepare(
      `SELECT added_fields FROM extension_metadata
       WHERE base_object_name = ? COLLATE NOCASE
         AND extension_type IN (${FIELD_ADDING_EXTENSION_PLACEHOLDERS})`,
    ).all(tableName, ...FIELD_ADDING_EXTENSION_TYPES) as Array<{ added_fields: string | null }>;
  }

  const names: string[] = [];
  for (const ext of rows) {
    if (!ext.added_fields) continue;
    try {
      for (const f of JSON.parse(ext.added_fields) as unknown[]) {
        const name = typeof f === 'string' ? f : (f as { name?: string })?.name ?? '';
        if (name) names.push(name);
      }
    } catch { /* malformed JSON — skip */ }
  }
  return names;
}

/**
 * `AslFinSK_QualityTier` → `qualitytier`. A member added to another model's
 * object carries that model's prefix (applyExtensionMemberPrefix mints it), so
 * the name in the agent's X++ and the name on disk routinely differ by exactly
 * this token.
 */
function withoutMemberPrefix(name: string): string {
  const cut = name.indexOf('_');
  return (cut > 0 ? name.slice(cut + 1) : name).toLowerCase();
}

/** A real field that differs from `wanted` only by a model prefix, if there is one. */
function prefixVariantOf(wanted: string, candidates: readonly string[]): string | undefined {
  const exact = wanted.toLowerCase();
  const bare = withoutMemberPrefix(wanted);
  return candidates.find(c => {
    const lower = c.toLowerCase();
    if (lower === exact) return false;
    const cBare = withoutMemberPrefix(c);
    return cBare === bare || cBare === exact || lower === bare;
  });
}

/** What the index can say about `table.field`. */
type FieldVerdict =
  | { found: true }
  /**
   * `judgeable` is the honest part: false means the index holds NO field list
   * for this object at all (no columns, no field-adding extension), so "not
   * found" is a statement about the index, not about the code. Reporting that
   * as an error blocks a write over a gap in our own data.
   */
  | { found: false; judgeable: boolean; suggestion?: string };

/** Check a field on a table: indexed fields, system fields, extension fields. */
function fieldVerdict(deps: ResolverDeps, tableName: string, fieldName: string): FieldVerdict {
  if (TABLE_SYSTEM_FIELDS.has(fieldName.toLowerCase())) return { found: true };
  try {
    // Canonicalize the table once so the probes stay BINARY on the indexes
    // (see findMethod above for the rationale).
    const table = lookupSymbolNocase(deps.db, tableName)?.name ?? tableName;
    const row = deps.db.prepare(
      `SELECT 1 AS x FROM symbols
       WHERE parent_name = ? AND type = 'field' AND name = ? COLLATE NOCASE
       LIMIT 1`,
    ).get(table, fieldName);
    if (row !== undefined) return { found: true };

    const extFields = extensionAddedFields(deps, table);
    const target = fieldName.toLowerCase();
    if (extFields.some(f => f.toLowerCase() === target)) return { found: true };

    // Missed. Only now is it worth paying for the full column list — to decide
    // whether the index is even in a position to judge, and to name the field
    // the caller most likely meant.
    const ownFields = (deps.db.prepare(
      `SELECT name FROM symbols
       WHERE parent_name = ? AND type = 'field'
       LIMIT 512`,
    ).all(table) as Array<{ name: string }>).map(r => r.name);

    return {
      found: false,
      judgeable: ownFields.length > 0 || extFields.length > 0,
      suggestion: prefixVariantOf(fieldName, [...ownFields, ...extFields]),
    };
  } catch {
    // DB error — say we could not look, rather than that the field is missing.
    return { found: false, judgeable: false };
  }
}

/**
 * The diagnostic for a field the index could not confirm.
 *
 * The old text sent the caller to `get_object_info(objectType="table")`, which
 * lists the table's OWN columns and nothing else — so an agent chasing a field a
 * table extension contributes was pointed at the one reader that cannot show it.
 * (Observed: a session called exactly that, learned nothing, and only got
 * unstuck on the next call, to `objectType="table-extension"`.)
 */
function unknownFieldViolation(
  verdict: Extract<FieldVerdict, { found: false }>,
  tableName: string,
  fieldName: string,
  line: number,
): ReferenceViolation {
  const where =
    `\`get_object_info(objectType="table", name="${tableName}")\` lists only ${tableName}'s own ` +
    `columns; a field a table or view EXTENSION adds is under ` +
    `\`get_object_info(objectType="table-extension", name="${tableName}")\`.`;

  if (!verdict.judgeable) {
    return {
      kind: 'unknown-field',
      severity: 'warning',
      // Not an ordinary warning: nothing was checked. gateOnReferenceErrors
      // refuses on this too, because "the index could not tell" is not the
      // proof GROUNDING_ENFORCE exists to demand — and for maps the gap is
      // total (377 of 377 carry no field rows), so without this the gate is
      // simply off for every map buffer.
      unverifiable: true,
      line,
      identifier: `${tableName}.${fieldName}`,
      detail:
        `Could not verify "${fieldName}" on ${tableName}: the index holds no column list for ` +
        `${tableName} at all (0 fields, 0 field-adding extensions), so this is a gap in the ` +
        `index, not evidence the field is missing. ${where}`,
    };
  }

  const didYouMean = verdict.suggestion
    ? ` Did you mean \`${verdict.suggestion}\`? (A member added to another model's object carries ` +
      `that model's prefix.)`
    : '';

  return {
    kind: 'unknown-field',
    severity: 'error',
    line,
    identifier: `${tableName}.${fieldName}`,
    detail:
      `Field "${fieldName}" not found on ${tableName} (checked its own columns, the system ` +
      `fields, and every table/view extension in the index).${didYouMean} ${where}`,
  };
}

interface Arity { min: number; max: number }

/**
 * Parse "ReturnType name(Type a, Type b = x)" → {min, max}; undefined when the
 * signature licenses no arity claim. `(...)` is renderMethodSignature's marker
 * for a declaration it could not read and must not be read as zero parameters.
 */
function parseSignatureArity(signature: string): Arity | undefined {
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  if (open === -1 || close === -1 || close < open) return undefined;
  const inner = signature.slice(open + 1, close).trim();
  if (inner === UNKNOWN_PARAMETER_LIST) return undefined;
  if (inner === '') return { min: 0, max: 0 };
  const params = splitTopLevel(inner);
  const optional = params.filter(p => p.includes('=')).length;
  return { min: params.length - optional, max: params.length };
}

/**
 * Arity to hold a call against: the method's own declaration first, the rendered
 * `signature` only as a fallback.
 *
 * The rendering that produced the rows already in the index dropped parameter
 * defaults, so `CustTable::find` is stored as `find(CustAccount, boolean)` and
 * the legal `find(_account)` reads as a mismatch. Fixing the renderer fixes
 * future rows; parsing the stored declaration fixes today's, with no reindex.
 *
 * Returns the text to quote alongside, so the diagnostic shows whichever list
 * the verdict came from.
 */
function arityOf(method: MethodRow, methodName: string): { arity: Arity; shown: string } | undefined {
  if (method.source) {
    const decl = parseXppDeclaration(method.source, methodName);
    if (decl) {
      const optional = decl.parameters.filter(p => p.defaultValue !== undefined).length;
      return {
        arity: { min: decl.parameters.length - optional, max: decl.parameters.length },
        shown: renderMethodSignature({
          name: decl.name,
          returnType: decl.returnType,
          parameters: decl.parameters,
        }),
      };
    }
    // An unreadable stored declaration is exactly the case that rendered as
    // `()`, so falling through to the signature would trust that lie.
    return undefined;
  }
  if (!method.signature) return undefined;
  const arity = parseSignatureArity(method.signature);
  return arity ? { arity, shown: method.signature.trim() } : undefined;
}

/** Split on top-level commas (ignores commas inside (), [], <>). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

/** Extract the balanced argument list starting at the '(' at `openIdx`. */
function extractCallArgs(code: string, openIdx: number): string | undefined {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') {
      depth--;
      if (depth === 0) return code.slice(openIdx + 1, i);
    }
  }
  return undefined;
}

function countCallArgs(argsText: string): number {
  if (argsText.trim() === '') return 0;
  return splitTopLevel(argsText).length;
}

interface LocalScope {
  /** Identifiers declared inside the snippet (class names, vars, params). */
  declaredNames: Set<string>;
  /** varName(lower) → declared TypeName */
  bindings: Map<string, string>;
}

const DECL_STOPWORDS = new Set([
  ...XPP_KEYWORDS,
  'next', // CoC: `next methodName(...)`
]);

function collectLocals(cleaned: string): LocalScope {
  const declaredNames = new Set<string>();
  const bindings = new Map<string, string>();

  // Class / interface declarations inside the snippet
  for (const m of cleaned.matchAll(/\b(?:class|interface)\s+([A-Za-z_]\w*)/g)) {
    declaredNames.add(m[1].toLowerCase());
  }

  // `Type var;`, `Type var = ...`, `Type var, var2;` — statement-leading position
  const declRe = /(^|[;{}\n])\s*([A-Za-z_]\w*)\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?=[=;,)])/g;
  for (const m of cleaned.matchAll(declRe)) {
    const typeName = m[2];
    if (DECL_STOPWORDS.has(typeName.toLowerCase())) continue;
    for (const varName of m[3].split(',').map(v => v.trim())) {
      if (!varName || XPP_KEYWORDS.has(varName.toLowerCase())) continue;
      declaredNames.add(varName.toLowerCase());
      bindings.set(varName.toLowerCase(), typeName);
    }
  }

  // Method parameters: `(Type _a, Type _b = default)`
  for (const m of cleaned.matchAll(/\(([^()]*)\)/g)) {
    for (const param of splitTopLevel(m[1])) {
      const pm = param.trim().match(/^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)/);
      if (!pm) continue;
      if (XPP_KEYWORDS.has(pm[1].toLowerCase())) continue;
      declaredNames.add(pm[2].toLowerCase());
      bindings.set(pm[2].toLowerCase(), pm[1]);
    }
  }

  return { declaredNames, bindings };
}

export function resolveXppReferences(code: string, deps: ResolverDeps): ResolveResult {
  const violations: ReferenceViolation[] = [];
  let verifiedCount = 0;
  const { cleaned, strings } = cleanCode(code);
  const locals = collectLocals(cleaned);
  // Names this source DECLARES. A new class calling its own static is spelled
  // `MyClass::helper()` — X++ accepts nothing else, since a bare name resolves
  // only against predefined functions, Global statics and local functions — so
  // every non-trivial new class refers to something the index cannot contain
  // yet. Reporting that as unknown-type blocks writes of correct code under
  // GROUNDING_ENFORCE, and the fix needs no new plumbing: the declaration is in
  // the very text being checked.
  const selfDeclared = new Set<string>(
    [...cleaned.matchAll(/\b(?:class|interface)\s+([A-Za-z_]\w*)/g)].map(d => d[1].toLowerCase()),
  );

  const typeExistsCache = new Map<string, string[]>();
  const lookupTypes = (name: string): string[] => {
    const key = name.toLowerCase();
    let types = typeExistsCache.get(key);
    if (types === undefined) {
      types = symbolTypes(deps, name);
      typeExistsCache.set(key, types);
    }
    return types;
  };

  const isKnownType = (name: string): boolean => {
    const lower = name.toLowerCase();
    return XPP_BUILTIN_TYPES.has(lower)
      || KERNEL_TYPES.has(lower)
      || locals.declaredNames.has(lower)
      || lookupTypes(name).length > 0;
  };

  // Memoised per call and reported once per type — a name commonly appears as
  // both a declared buffer and a `Type::member` receiver. True when invisible,
  // so callers can skip the checks that assume the type is usable.
  const visibilityVerdicts = new Map<string, ReferenceViolation | null>();
  const reportIfInvisible = (name: string, line: number): boolean => {
    if (!deps.visibility) return false;
    const lower = name.toLowerCase();
    if (XPP_BUILTIN_TYPES.has(lower) || KERNEL_TYPES.has(lower)) return false;
    let verdict = visibilityVerdicts.get(lower);
    if (verdict === undefined) {
      verdict = checkModelVisibility(deps, name, line) ?? null;
      visibilityVerdicts.set(lower, verdict);
      if (verdict) violations.push(verdict);
    }
    return verdict !== null;
  };

  // 1. Label references (from original string literals)
  for (const s of strings) {
    const modern = s.value.match(/^@([A-Za-z][A-Za-z0-9_]*):([A-Za-z0-9_]+)$/);
    const legacy = s.value.match(/^@([A-Z]{2,4}\d+)$/);
    if (modern) {
      const [, fileId, labelId] = modern;
      const hits = deps.getLabelById(labelId, fileId);
      if (hits.length > 0) {
        verifiedCount++;
        const v = checkLabelPlaceholders(hits, `@${fileId}:${labelId}`, cleaned, s.index, code);
        if (v) violations.push(v);
      } else {
        // Known label file with missing id is an error; unknown file is a warning.
        const fileKnown = labelFileExists(deps, fileId);
        violations.push({
          kind: 'unknown-label',
          severity: fileKnown ? 'error' : 'warning',
          line: lineOf(code, s.index),
          identifier: `@${fileId}:${labelId}`,
          detail: fileKnown
            ? `Label id "${labelId}" not found in label file "${fileId}". Use labels to find the right id or labels to add it.`
            : `Label file "${fileId}" not found in the index. If it is new, create the label first (labels), then re-run.`,
        });
      }
    } else if (legacy) {
      // The whole literal, not the capture group (#888). The regex strips the
      // '@' that the 27 legacy label files store as part of the key, so looking
      // up `SYS12345` against an index holding `@SYS12345` could never hit and
      // EVERY legacy label in X++ drew an unknown-label warning during write
      // validation. getLabelById accepts either spelling; passing the literal
      // keeps this branch honest even if that ever narrows again.
      if (deps.getLabelById(s.value).length > 0) {
        verifiedCount++;
      } else {
        violations.push({
          kind: 'unknown-label',
          severity: 'warning',
          line: lineOf(code, s.index),
          identifier: `@${legacy[1]}`,
          detail: `Legacy label "@${legacy[1]}" not found in the labels index. Verify with labels.`,
        });
      }
    }
  }

  // 2. Intrinsic functions
  const intrinsicRe = /\b([A-Za-z]+[Ss]tr|tableNum|classNum|enumNum|enumCnt|fieldNum|extendedTypeNum)\s*\(\s*([A-Za-z_]\w*)\s*(?:,\s*([A-Za-z_]\w*)\s*)?\)/g;
  for (const m of cleaned.matchAll(intrinsicRe)) {
    const fn = m[1].toLowerCase();
    const expected = INTRINSIC_TARGET_TYPES[fn];
    if (expected === undefined) continue; // not an intrinsic we know (e.g. subStr)
    const target = m[2];
    const member = m[3];
    const line = lineOf(cleaned, m.index ?? 0);

    if (locals.declaredNames.has(target.toLowerCase())) { verifiedCount++; continue; }
    // A kernel type has no metadata anywhere, so `methodStr(FormStringControl,
    // lookup)` can never resolve — and the DECLARED-type path already knows
    // that and only warns. Reporting the same name as an ERROR here was the two
    // rules disagreeing about the same fact; an eval run hit it on the one
    // spelling X++ accepts for a control override.
    if (KERNEL_TYPES.has(target.toLowerCase())) { verifiedCount++; continue; }
    // …and the class being written is not in the index yet either.
    if (selfDeclared.has(target.toLowerCase())) { verifiedCount++; continue; }

    const types = lookupTypes(target);
    const targetOk = expected === null
      ? (types.length > 0 || menuItemExists(deps, target))
      : types.some(t => expected.includes(t));
    if (!targetOk) {
      violations.push({
        kind: 'unknown-intrinsic-target',
        severity: 'error',
        line,
        identifier: `${m[1]}(${target}${member ? `, ${member}` : ''})`,
        detail: expected === null
          ? `"${target}" not found in the index (checked symbols and menu items).`
          : `"${target}" is not a known ${expected.join('/')} in the index. Use search() to find the correct name.`,
      });
      continue;
    }

    // Second argument: fieldStr(T, F) / methodStr(C, m) / tableFieldGroupStr(T, G)
    if (member) {
      if (fn === 'fieldstr' || fn === 'fieldnum') {
        const verdict = fieldVerdict(deps, target, member);
        if (verdict.found) {
          verifiedCount++;
        } else {
          violations.push(unknownFieldViolation(verdict, target, member, line));
        }
      } else if (fn === 'methodstr' || fn === 'staticmethodstr') {
        if (findMethod(deps, target, member)) {
          verifiedCount++;
        } else {
          violations.push({
            kind: 'unknown-method',
            severity: 'error',
            line,
            identifier: `${target}.${member}`,
            detail: `Method "${member}" not found on ${target} (checked inheritance chain and extensions). Use get_object_info(objectType="class", name="${target}").`,
          });
        }
      } else {
        verifiedCount++;
      }
    } else {
      verifiedCount++;
    }
  }

  // 3. Static member access Type::member
  const staticRe = /\b([A-Za-z_]\w*)\s*::\s*([A-Za-z_]\w*)/g;
  for (const m of cleaned.matchAll(staticRe)) {
    const typeName = m[1];
    const member = m[2];
    const line = lineOf(cleaned, m.index ?? 0);
    const lower = typeName.toLowerCase();

    // No declaredNames guard, unlike the instance path: `::` only ever applies
    // to a type, and `CustTable custTable;` differs only in the first letter's
    // case — so the guard disabled this check for the commonest code there is.
    if (KERNEL_TYPES.has(lower)) { verifiedCount++; continue; } // no metadata for kernel statics
    // The class being written cannot be in the index yet; its own members are
    // checked by the compiler a moment later.
    if (selfDeclared.has(lower)) { verifiedCount++; continue; }

    const types = lookupTypes(typeName);
    if (types.length === 0) {
      violations.push({
        kind: 'unknown-type',
        severity: 'error',
        line,
        identifier: `${typeName}::${member}`,
        detail: `"${typeName}" not found in the index. Use search("${typeName}") to find the correct name.`,
      });
      continue;
    }
    // Indexed is not the same as reachable from the model being compiled.
    if (reportIfInvisible(typeName, line)) continue;
    if (types.includes('enum')) {
      // Enum values are not indexed as symbols — the enum itself is proven.
      verifiedCount++;
      continue;
    }

    const method = findMethod(deps, typeName, member);
    if (!method) {
      violations.push({
        kind: 'unknown-static-member',
        severity: 'error',
        line,
        identifier: `${typeName}::${member}`,
        detail: `Static method "${member}" not found on ${typeName} (checked inheritance chain and extensions). Use get_object_info(objectType="class", name="${typeName}") — add options:{"method":"${member}","include":"signature"} for that one method.`,
      });
      continue;
    }
    verifiedCount++;

    // Arity check when the call site and the declaration are both parseable
    {
      const resolved = arityOf(method, member);
      const callOpen = cleaned.indexOf('(', (m.index ?? 0) + m[0].length);
      const between = callOpen === -1
        ? ''
        : cleaned.slice((m.index ?? 0) + m[0].length, callOpen);
      if (resolved && callOpen !== -1 && between.trim() === '') {
        const { arity, shown } = resolved;
        const argsText = extractCallArgs(cleaned, callOpen);
        if (argsText !== undefined) {
          const n = countCallArgs(argsText);
          if (n < arity.min || n > arity.max) {
            violations.push({
              kind: 'arity-mismatch',
              severity: 'error',
              line,
              identifier: `${typeName}::${member}`,
              detail: `Call passes ${n} argument(s), but the declaration expects ${
                arity.min === arity.max ? arity.min : `${arity.min}–${arity.max}`
              }: ${shown}`,
            });
          }
        }
      }
    }
  }

  // 4. Declared types
  const reportedTypes = new Set<string>();
  for (const [, typeName] of locals.bindings) {
    const lower = typeName.toLowerCase();
    if (reportedTypes.has(lower)) continue;
    reportedTypes.add(lower);
    if (isKnownType(typeName)) {
      if (!reportIfInvisible(typeName, 0)) verifiedCount++;
    } else {
      violations.push({
        kind: 'unknown-type',
        severity: 'warning',
        line: 0,
        identifier: typeName,
        detail: `Declared type "${typeName}" not found in the index. ` +
          `If it is a kernel class this is a false positive; otherwise use search("${typeName}").`,
      });
    }
  }

  // 5. Bound buffer member access var.Field / var.method()
  for (const [varLower, typeName] of locals.bindings) {
    const types = lookupTypes(typeName);
    const isTableLike = types.some(t => TABLE_LIKE_TYPES.has(t));
    const isClass = !isTableLike && types.includes('class');
    if (!isTableLike && !isClass) continue;

    const memberRe = new RegExp(String.raw`\b${varLower}\s*\.\s*([A-Za-z_]\w*)\s*(\()?`, 'gi');
    const checkedMembers = new Set<string>();
    for (const m of cleaned.matchAll(memberRe)) {
      const member = m[1];
      const isCall = m[2] === '(';
      const key = `${member.toLowerCase()}:${isCall}`;
      if (checkedMembers.has(key)) continue;
      checkedMembers.add(key);
      const line = lineOf(cleaned, m.index ?? 0);

      if (isCall) {
        const builtin = isTableLike
          ? TABLE_BUILTIN_METHODS.has(member.toLowerCase())
          : OBJECT_BUILTIN_METHODS.has(member.toLowerCase());
        if (builtin || findMethod(deps, typeName, member)) {
          verifiedCount++;
        } else {
          violations.push({
            kind: 'unknown-method',
            severity: 'warning',
            line,
            identifier: `${typeName}.${member}()`,
            detail: `Method "${member}" not found on ${typeName} (checked builtins, inheritance, extensions). Verify with get_${isTableLike ? 'table' : 'class'}_info("${typeName}").`,
          });
        }
      } else if (isTableLike) {
        const verdict = fieldVerdict(deps, typeName, member);
        if (verdict.found) {
          verifiedCount++;
        } else {
          violations.push(unknownFieldViolation(verdict, typeName, member, line));
        }
      }
    }
  }

  return { violations, verifiedCount };
}

/**
 * Descriptor visibility oracle for the configured target model, or undefined.
 * Resolution stays limited to values already in the loaded configuration: this
 * runs on every resolve_references call, and ConfigManager's drive-probing
 * discovery would be exactly the blocking scan that gets the server killed.
 */
export function resolverModelVisibility(): ModelVisibility | undefined {
  try {
    const ctx = getConfigManager().getContext();
    const model = (ctx?.modelName ?? process.env.D365FO_MODEL_NAME ?? '').trim();
    if (!model) return undefined;
    const root = packagesRootFromPath(ctx?.packagePath)
      ?? packagesRootFromPath(ctx?.workspacePath);
    return getModelVisibility(root, model) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * A label's %n placeholders against the arguments the call site supplies.
 *
 * Both directions are silent at compile time and wrong at runtime: a label with
 * %1 used without strFmt shows the user a literal "%1", and arguments passed to
 * a label that has no placeholders are discarded.
 */
function checkLabelPlaceholders(
  hits: Array<{ language?: string; text?: string }>,
  identifier: string,
  cleaned: string,
  index: number,
  code: string,
): ReferenceViolation | null {
  const preferred = hits.find(h => h.language?.toLowerCase() === 'en-us') ?? hits[0];
  if (!preferred?.text) return null;

  const needed = placeholderCount(preferred.text);
  const supplied = strFmtArgs(cleaned, index);
  const line = lineOf(code, index);
  const quoted = `"${preferred.text}"`;

  if (needed === 0 && supplied !== null && supplied > 0) {
    return {
      kind: 'label-placeholder-mismatch',
      severity: 'error',
      line,
      identifier,
      detail:
        `${identifier} is ${quoted} — no %1 placeholder, so the ${supplied} strFmt argument(s) are discarded. ` +
        `Drop strFmt, or add %1…%${supplied} to the label text with labels(action="update").`,
    };
  }
  if (needed > 0 && supplied === null) {
    return {
      kind: 'label-placeholder-mismatch',
      severity: 'error',
      line,
      identifier,
      detail:
        `${identifier} is ${quoted} — it takes ${needed} argument(s) and must be wrapped: ` +
        `strFmt("${identifier}", …). Used bare, the user sees the literal %1.`,
    };
  }
  if (needed > 0 && supplied !== null && supplied !== needed) {
    return {
      kind: 'label-placeholder-mismatch',
      severity: 'error',
      line,
      identifier,
      detail:
        `${identifier} is ${quoted} — it takes ${needed} argument(s), strFmt supplies ${supplied}.`,
    };
  }
  return null;
}

/** Highest %n in a label's text; 0 when it takes no arguments. */
function placeholderCount(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/%(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/**
 * How a label literal at `index` is being passed: as strFmt's format argument,
 * and if so with how many further arguments.
 *
 * Scans backwards for the nearest unclosed `(` chain, so `checkFailed(strFmt(@X,
 * a, b))` reports the strFmt, not the checkFailed. `literalStr(@X)` is
 * transparent — it wraps the literal without changing who receives it.
 */
function strFmtArgs(cleaned: string, index: number): number | null {
  let depth = 0;
  let i = index - 1;
  for (; i >= 0; i--) {
    const c = cleaned[i];
    if (c === ')') depth++;
    else if (c === '(') {
      if (depth === 0) break;
      depth--;
    }
  }
  if (i < 0) return null;

  const callee = /([A-Za-z_]\w*)\s*$/.exec(cleaned.slice(0, i));
  if (!callee) return null;
  if (/^literalStr$/i.test(callee[1])) return strFmtArgs(cleaned, callee.index);
  if (!/^strFmt$/i.test(callee[1])) return null;

  // Commas at this call's own depth, from the format argument to the close.
  let args = 0;
  let d = 0;
  for (let k = i + 1; k < cleaned.length; k++) {
    const c = cleaned[k];
    if (c === '(') d++;
    else if (c === ')') { if (d === 0) break; d--; }
    else if (c === ',' && d === 0) args++;
  }
  return args;
}

/** True when the label file id is present in the labels index. */
function labelFileExists(deps: ResolverDeps, fileId: string): boolean {
  try {
    const target = fileId.toLowerCase();
    return deps.getLabelFileIds().some(f => f.labelFileId.toLowerCase() === target);
  } catch {
    return false;
  }
}

/**
 * When GROUNDING_ENFORCE=true, run the resolver over X++ source about to be
 * written and reject the write if any ERROR-severity violation is found.
 * Returns null when the gate passes (disabled, no code, or clean).
 */
export function gateOnReferenceErrors(
  code: string | undefined,
  symbolIndex: {
    getReadDb(): ResolverDeps['db'];
    getLabelById: ResolverDeps['getLabelById'];
    getLabelFileIds: ResolverDeps['getLabelFileIds'];
  } | undefined,
  operationDescription: string,
): { isError: true; content: [{ type: 'text'; text: string }] } | null {
  if (process.env.GROUNDING_ENFORCE !== 'true') return null;
  if (!code || !symbolIndex) return null;
  let result: ResolveResult;
  try {
    result = resolveXppReferences(code, {
      db: symbolIndex.getReadDb(),
      getLabelById: symbolIndex.getLabelById.bind(symbolIndex),
      getLabelFileIds: symbolIndex.getLabelFileIds.bind(symbolIndex),
      visibility: resolverModelVisibility(),
    });
  } catch {
    return null; // never block writes on resolver failure
  }
  // Unverifiable is blocking here even though it is only a warning elsewhere:
  // this gate's promise is that every identifier was PROVEN, and a reference the
  // index could not check has not been.
  const blocking = result.violations.filter(v => v.severity === 'error' || v.unverifiable);
  if (blocking.length === 0) return null;
  const list = blocking
    .map(v => `  • [${v.kind}] line ${v.line}: \`${v.identifier}\` — ${v.detail}`)
    .join('\n');
  return {
    isError: true,
    content: [{
      type: 'text',
      text:
        `❌ Unresolved references in ${operationDescription} (GROUNDING_ENFORCE=true).\n\n` +
        `The following identifiers could NOT be proven against the indexed codebase:\n\n` +
        `${list}\n\n` +
        `Some of these may be REAL and simply unindexed — the detail line says which. ` +
        `Fix the ones that are wrong; for one the index cannot see, run ` +
        `update_symbol_index on the object that declares it, or set GROUNDING_ENFORCE=false ` +
        `for this write. Then retry. ` +
        `Run \`validate_code(mode="references")\` on the corrected code to confirm it is clean.`,
    }],
  };
}

export async function resolveReferencesTool(
  request: { params: { arguments?: unknown } },
  context: XppServerContext,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const parsed = resolveReferencesArgsSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    return {
      isError: true,
      content: [{ type: 'text', text: `❌ validate_code(references): invalid arguments — ${parsed.error.message}` }],
    };
  }
  const { code, context: objContext } = parsed.data;

  let result: ResolveResult;
  try {
    result = resolveXppReferences(code, {
      db: context.symbolIndex.getReadDb(),
      getLabelById: context.symbolIndex.getLabelById.bind(context.symbolIndex),
      getLabelFileIds: context.symbolIndex.getLabelFileIds.bind(context.symbolIndex),
      visibility: resolverModelVisibility(),
    });
  } catch (error) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `❌ validate_code(references) failed: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }

  const errors = result.violations.filter(v => v.severity === 'error');
  const warnings = result.violations.filter(v => v.severity === 'warning');
  const suffix = objContext ? ` in ${objContext}` : '';

  if (result.violations.length === 0) {
    return {
      content: [{
        type: 'text',
        text:
          `✅ validate_code(references): all ${result.verifiedCount} reference(s) verified against the index${suffix}.\n` +
          `No hallucinated symbols detected. This is a name-existence check, not a compile: ` +
          `arity/type compatibility, table extensions contributed by unreferenced packages, ` +
          `and anything the index could not read are outside its reach. ` +
          `build_d365fo_project remains the only proof it compiles.`,
      }],
    };
  }

  const lines: string[] = [
    `${errors.length > 0 ? '❌' : '⚠️'} validate_code(references): ` +
    `${errors.length} error(s), ${warnings.length} warning(s)${suffix} — ` +
    `${result.verifiedCount} reference(s) verified OK.`,
    '',
  ];
  for (const v of result.violations) {
    lines.push(
      `${v.severity === 'error' ? '❌' : '⚠️'} **${v.kind}**` +
      `${v.line > 0 ? ` (line ${v.line})` : ''}: \`${v.identifier}\``,
    );
    lines.push(`   ${v.detail}`);
    lines.push('');
  }
  if (errors.length > 0) {
    lines.push(
      '**Fix all errors before writing** — these identifiers could not be resolved against the ' +
      'indexed codebase (`not-visible-from-model` means the name exists but its package is not ' +
      'referenced by the target model).',
    );
  } else {
    lines.push('Warnings are informational (kernel classes and new labels are not indexable). Review, then proceed.');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    ...(errors.length > 0 ? { isError: true } : {}),
  };
}
