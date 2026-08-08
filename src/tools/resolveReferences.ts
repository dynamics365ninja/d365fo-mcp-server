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
import type { XppServerContext } from '../types/context.js';
import { canonicalSymbolName, distinctSymbolTypesNocase, lookupSymbolNocase } from '../utils/symbolLookup.js';
import {
  UNKNOWN_PARAMETER_LIST,
  parseXppDeclaration,
  renderMethodSignature,
} from '../metadata/xppDeclaration.js';
import {
  getModelVisibility,
  packagesRootFromPath,
  type ModelVisibility,
} from '../metadata/modelDescriptor.js';
import { getConfigManager } from '../utils/configManager.js';

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
  kind:
    | 'unknown-type'
    | 'unknown-static-member'
    | 'unknown-method'
    | 'unknown-field'
    | 'unknown-label'
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
  ): Array<{ labelId: string; labelFileId: string }>;
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
  // Kernel enums (not in metadata XML). 'exception' has no AxEnum at all, and the
  // index does not prove 'noyes' — without both, every try/catch and NoYes:: use
  // hard-errors in the static-access path.
  'types', 'tablescope', 'utcdatetimeorder', 'dateorder', 'dateday',
  'datemonth', 'dateyear', 'statementtype', 'concurrencymodel', 'isolationlevel',
  'exception', 'noyes',
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
    if (extRows.length === 0 && !ownerHit) {
      // Owner not in symbols under any casing — nocase scan is bounded by
      // extension_metadata, which is small (single-digit thousands of rows;
      // indexing class extensions in #693 roughly doubled it).
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

/** Check a field on a table: indexed fields, system fields, extension fields. */
function fieldExists(deps: ResolverDeps, tableName: string, fieldName: string): boolean {
  if (TABLE_SYSTEM_FIELDS.has(fieldName.toLowerCase())) return true;
  try {
    // Canonicalize the table once so the probes stay BINARY on the indexes
    // (see findMethod above for the rationale).
    const tableHit = lookupSymbolNocase(deps.db, tableName);
    const table = tableHit?.name ?? tableName;
    const row = deps.db.prepare(
      `SELECT 1 AS x FROM symbols
       WHERE parent_name = ? AND type = 'field' AND name = ? COLLATE NOCASE
       LIMIT 1`,
    ).get(table, fieldName);
    if (row !== undefined) return true;
    let extRows = deps.db.prepare(
      `SELECT added_fields FROM extension_metadata
       WHERE base_object_name = ? AND extension_type = 'table-extension'`,
    ).all(table) as Array<{ added_fields: string | null }>;
    if (extRows.length === 0 && !tableHit) {
      extRows = deps.db.prepare(
        `SELECT added_fields FROM extension_metadata
         WHERE base_object_name = ? COLLATE NOCASE AND extension_type = 'table-extension'`,
      ).all(tableName) as Array<{ added_fields: string | null }>;
    }
    const target = fieldName.toLowerCase();
    for (const ext of extRows) {
      if (!ext.added_fields) continue;
      try {
        const names = JSON.parse(ext.added_fields) as unknown[];
        if (names.some(f =>
          (typeof f === 'string' ? f : (f as { name?: string })?.name ?? '')
            .toLowerCase() === target,
        )) {
          return true;
        }
      } catch { /* malformed JSON — skip */ }
    }
  } catch { /* DB error — treat as not found */ }
  return false;
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
      if (deps.getLabelById(labelId, fileId).length > 0) {
        verifiedCount++;
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
      if (deps.getLabelById(legacy[1]).length > 0) {
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
        if (fieldExists(deps, target, member)) {
          verifiedCount++;
        } else {
          violations.push({
            kind: 'unknown-field',
            severity: 'error',
            line,
            identifier: `${target}.${member}`,
            detail: `Field "${member}" not found on ${target} (checked fields, system fields, table extensions). Use get_object_info(objectType="table", name="${target}").`,
          });
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
        detail: `Static method "${member}" not found on ${typeName} (checked inheritance chain and extensions). Use get_object_info(objectType="class", name="${typeName}") or get_method(include="signature").`,
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
        if (fieldExists(deps, typeName, member)) {
          verifiedCount++;
        } else {
          violations.push({
            kind: 'unknown-field',
            severity: 'error',
            line,
            identifier: `${typeName}.${member}`,
            detail: `Field "${member}" not found on ${typeName} (checked fields, system fields, table extensions). Use get_object_info(objectType="table", name="${typeName}").`,
          });
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
  const errors = result.violations.filter(v => v.severity === 'error');
  if (errors.length === 0) return null;
  const list = errors
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
        `Fix the identifiers (use the suggested lookup tools), then retry. ` +
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
