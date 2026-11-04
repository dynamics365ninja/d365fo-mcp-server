/**
 * Cross-references from a SQLite export of DYNAMICSXREFDB, for servers without
 * the C# bridge (D365FO_XREF_SQLITE_PATH).
 *
 * The file holds the bridge's three tables 1:1 — Modules(Id, Module),
 * Names(Id, Path, ModuleId), "References"(SourceId, TargetId, Kind, Line,
 * "Column") — with the source database's ids, indexes on Names(Path COLLATE
 * NOCASE), References(TargetId) and References(SourceId), and a meta(key,
 * value) table whose `schema` must be '1'. This provider ports the bridge's
 * four xref queries (CrossReferenceService.cs) and returns the bridge's result
 * shapes, so the tool formatters render either source the same way.
 *
 * What differs from the bridge, and why:
 *  - Bounded. On a full export (5.6M names, 22.7M references) one target can
 *    have 338K references; joining all of them to Names costs seconds on a cold
 *    cache. Every list is a LIMIT without ORDER BY (sorted afterwards, in JS),
 *    every count and scan stops at a cap, and the result says when it did
 *    (`totalCapped`, `scanCapped`, `more`). For a target below the caps — the
 *    usual case — rows and totals are the bridge's own. Above them the rows are
 *    another sample of the same size than the bridge's alphabetical first 500.
 *    A file whose export left out the references without a source name (meta
 *    `refs_without_source_removed`) has its totals counted from the TargetId
 *    index, up to 500,000 instead of 20,000: exact for any real target.
 *  - Read-only by construction: opened as `file:…?mode=ro&immutable=1` with
 *    `query_only` and extensions off, so no lock, journal or WAL file is ever
 *    created next to it and nothing can be written. immutable=1 tells SQLite the
 *    file never changes, so the file's identity (device, inode, size, mtime) is
 *    checked before every call: a file replaced by rename (the supported way) or
 *    rewritten in place is closed and reopened, never read through a stale view.
 *    No mmap: a file truncated under a mapping kills the process.
 *  - Lazy. Constructing the provider touches nothing; the first use opens and
 *    validates the file (a few small reads). A missing, unreadable or invalid
 *    file is a status with a reason, logged once — never a thrown error at
 *    startup — and callers fall back as they do without a bridge.
 *  - One file, one connection: no ATTACH, no second database.
 */

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSyncClass, type DatabaseSync, type StatementSync } from '../database/nodeSqlite.js';
import type {
  BridgeApiUsageCallerEntry,
  BridgeApiUsageCallersByClass,
  BridgeApiUsageCallersResult,
  BridgeEventSubscriberEntry,
  BridgeEventSubscriberResult,
  BridgeExtensionClassEntry,
  BridgeExtensionClassResult,
  BridgeReferenceInfo,
  BridgeReferenceResult,
} from '../bridge/bridgeTypes.js';
import {
  EVENT_SOURCE_FILTER,
  EXTENSION_OF_ATTRIBUTE_PATH,
  KIND_ATTRIBUTE,
  KIND_CALL,
  KIND_TYPE_REF,
  apiUsageTargets,
  categorizeReference,
  classifyHandlerType,
  eventSubscriberTargets,
  extensionCandidateTargets,
  extractEventName,
  foldNocase,
  isRequestedOrNested,
  leafSegment,
  parsePath,
  prefixRange,
  referenceTargets,
  resolveExtendedElement,
  type PathTargets,
} from './xrefPaths.js';

/** Rows per target shape (X++ code, declarative metadata): the bridge's TOP (500). */
export const XREF_SQLITE_ROWS_PER_SHAPE = 500;
/** A per-shape total stops counting here (joined to Names, as the bridge counts). */
export const XREF_SQLITE_COUNT_CAP = 20_000;
/**
 * The same, for a file whose export left out every reference without a source
 * name (meta key below). There a reference counts exactly when the bridge's join
 * would count it, so the total is read from the TargetId index alone: entries in
 * sequence, no Names row touched. That is cheap enough for an exact total of any
 * target in a full export (the busiest has about 340K references).
 */
export const XREF_SQLITE_INDEX_COUNT_CAP = 500_000;
/**
 * meta key an export writes when it copied only references whose SourceId has a
 * Names row (its value: how many it left out). On a full DYNAMICSXREFDB about a
 * third of the references have no source name (Microsoft test classes); no tool
 * can show them, but without this key they have to be skipped on every count.
 */
export const XREF_META_REFS_WITHOUT_SOURCE_REMOVED = 'refs_without_source_removed';
/** References examined at most by the event-subscriber and API-caller scans. */
export const XREF_SQLITE_SCAN_CAP = 20_000;
/** Names one lookup resolves to at most (a bare name's children included). */
export const XREF_SQLITE_TARGET_CAP = 50_000;
/**
 * findExtensionClasses starts from the candidate elements' references when they
 * have at most this many, else from the [ExtensionOf] declarations (one per
 * extension class in the file, a constant few thousand).
 */
const EXT_TARGET_DRIVEN_MAX = 5_000;

const SOURCE = 'xref SQLite file (DYNAMICSXREFDB export)';
const SUPPORTED_SCHEMA = '1';

export type XrefSqliteStatus =
  | {
      state: 'ok';
      path: string;
      exportedAt?: string;
      modules: number;
      /** meta values as written by the export (counts as text). */
      meta: Record<string, string>;
      /** Totals come from the TargetId index (every source has a name), else joined to Names. */
      countsFromIndex: boolean;
    }
  | { state: 'missing' | 'invalid'; path: string; reason: string };

/** A page of a list: rows to return and rows to skip. */
export interface XrefPage {
  limit?: number;
  offset?: number;
}

type Row = Record<string, unknown>;

/** The connection flags every reader of an xref file uses: read-only, immutable, no extensions. */
export function openXrefSqliteReadOnly(filePath: string): DatabaseSync {
  const url = pathToFileURL(nodePath.resolve(filePath));
  url.search = '?mode=ro&immutable=1';
  const db = new DatabaseSyncClass(url, {
    readOnly: true,
    allowExtension: false,
    enableForeignKeyConstraints: false,
  });
  try {
    // The file is input from another machine: its schema may not run functions.
    db.exec('PRAGMA query_only = 1; PRAGMA trusted_schema = 0;');
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

const REQUIRED_COLUMNS: Record<string, string[]> = {
  Modules: ['Id', 'Module'],
  Names: ['Id', 'Path', 'ModuleId'],
  References: ['SourceId', 'TargetId', 'Kind', 'Line', 'Column'],
};

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The file's own names of the three indexes every query is pinned to (INDEXED BY). */
export interface XrefIndexes {
  namesPath: string;
  refTarget: string;
  refSource: string;
}

/** An index whose first column is `column` (with that collation, when given), by name. */
function findIndex(db: DatabaseSync, table: string, column: string, collation?: string): string | undefined {
  for (const idx of db.prepare(`PRAGMA index_list(${quoteIdent(table)})`).all() as Row[]) {
    if (Number(idx.partial) === 1) continue; // a partial index does not cover every row
    const keys = (db.prepare(`PRAGMA index_xinfo(${quoteIdent(String(idx.name))})`).all() as Row[]).filter(
      c => Number(c.key) === 1,
    );
    const first = keys[0];
    if (!first || String(first.name).toLowerCase() !== column.toLowerCase()) continue;
    if (!collation || String(first.coll).toUpperCase() === collation) return String(idx.name);
  }
  return undefined;
}

/** Why the file cannot be used, or what it holds. */
function validate(
  db: DatabaseSync,
): { reason: string } | { meta: Record<string, string>; modules: Map<number, string>; indexes: XrefIndexes } {
  const tables = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Row[]).map(r => String(r.name)),
  );
  if (!tables.has('meta')) {
    return { reason: 'the file has no meta table, so its format version is unknown' };
  }
  const meta: Record<string, string> = {};
  for (const r of db.prepare('SELECT key, value FROM meta').all() as Row[]) meta[String(r.key)] = String(r.value);
  if (meta.schema !== SUPPORTED_SCHEMA) {
    return {
      reason:
        `meta.schema is ${meta.schema === undefined ? 'missing' : `'${meta.schema}'`}; ` +
        `this server reads schema '${SUPPORTED_SCHEMA}'`,
    };
  }
  // A partial export would answer "no references" for everything it lacks.
  if (meta.kind !== undefined && meta.kind !== 'full') {
    return { reason: `meta.kind is '${meta.kind}'; this server reads only complete exports (kind 'full')` };
  }
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!tables.has(table)) return { reason: `table ${table} is missing` };
    const have = new Set(
      (db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Row[]).map(c => String(c.name).toLowerCase()),
    );
    const missing = columns.filter(c => !have.has(c.toLowerCase()));
    if (missing.length > 0) return { reason: `table ${table} has no column ${missing.join(', ')}` };
  }
  // Without these every lookup scans millions of rows.
  const namesPath = findIndex(db, 'Names', 'Path', 'NOCASE');
  if (!namesPath) return { reason: 'no index on Names(Path COLLATE NOCASE)' };
  const refTarget = findIndex(db, 'References', 'TargetId');
  if (!refTarget) return { reason: 'no index on References(TargetId)' };
  const refSource = findIndex(db, 'References', 'SourceId');
  if (!refSource) return { reason: 'no index on References(SourceId)' };
  // A couple of hundred rows: held in memory instead of joined into every query.
  const modules = new Map<number, string>();
  for (const r of db.prepare('SELECT Id, Module FROM Modules').all() as Row[])
    modules.set(Number(r.Id), String(r.Module));
  return { meta, modules, indexes: { namesPath, refTarget, refSource } };
}

/**
 * The queries, with every big-table access pinned to its index. The planner has
 * no statistics for a json_each() id list, and on a small or oddly distributed
 * file it chose a full scan of References over the TargetId index: correct, but
 * on 22.7M rows that is seconds. INDEXED BY makes the plan a property of the SQL,
 * not of the file's statistics (and a plan that cannot use it fails to prepare).
 */
function buildSql(ix: XrefIndexes) {
  const NP = `INDEXED BY ${quoteIdent(ix.namesPath)}`;
  const RT = `INDEXED BY ${quoteIdent(ix.refTarget)}`;
  const RS = `INDEXED BY ${quoteIdent(ix.refSource)}`;
  return {
    exact: `SELECT Id, Path FROM Names ${NP} WHERE Path = ? COLLATE NOCASE`,
    range: `SELECT Id, Path FROM Names ${NP} WHERE Path >= ? COLLATE NOCASE AND Path < ? COLLATE NOCASE LIMIT ?`,
    rangeLike:
      `SELECT Id, Path FROM Names ${NP} WHERE Path >= ? COLLATE NOCASE AND Path < ? COLLATE NOCASE ` +
      `AND Path LIKE ? ESCAPE '\\' LIMIT ?`,
    pathOf: 'SELECT Path FROM Names WHERE Id = ?',
    // Index order (TargetId, rowid): paging is stable without a sort.
    refRows: `
    SELECT r.TargetId AS TargetId, src.Path AS SourcePath, src.ModuleId AS ModuleId,
           r.Kind AS Kind, r.Line AS Line, r."Column" AS Col
    FROM "References" r ${RT}
    CROSS JOIN Names src ON src.Id = r.SourceId
    WHERE r.TargetId IN (SELECT value FROM json_each(?))
    LIMIT ? OFFSET ?`,
    refCount: `
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM "References" r ${RT} CROSS JOIN Names src ON src.Id = r.SourceId
      WHERE r.TargetId IN (SELECT value FROM json_each(?)) LIMIT ?)`,
    // Index only: how many references exist, sources not resolved.
    refIndexCount: `
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM "References" ${RT} WHERE TargetId IN (SELECT value FROM json_each(?)) LIMIT ?)`,
    eventSources: `
    SELECT DISTINCT src.Path AS SourcePath, src.ModuleId AS ModuleId
    FROM (SELECT r.SourceId AS SourceId FROM "References" r ${RT}
          WHERE r.TargetId IN (SELECT value FROM json_each(?)) LIMIT ?) s
    CROSS JOIN Names src ON src.Id = s.SourceId
    WHERE ${EVENT_SOURCE_FILTER}`,
    apiCallers: `
    SELECT src.Path AS SourcePath, src.ModuleId AS ModuleId, s.Kind AS Kind, s.Line AS Line
    FROM (SELECT r.SourceId AS SourceId, r.Kind AS Kind, r.Line AS Line FROM "References" r ${RT}
          WHERE r.TargetId IN (SELECT value FROM json_each(?)) LIMIT ?) s
    CROSS JOIN Names src ON src.Id = s.SourceId
    WHERE src.Path LIKE '/Classes/%'
    LIMIT ? OFFSET ?`,
    perModule: `
    SELECT n.ModuleId AS ModuleId, COUNT(*) AS n
    FROM (SELECT r.SourceId AS SourceId FROM "References" r ${RT}
          WHERE r.TargetId IN (SELECT value FROM json_each(?)) LIMIT ?) s
    CROSS JOIN Names n ON n.Id = s.SourceId
    GROUP BY n.ModuleId`,
    // [ExtensionOf] lines naming a candidate element. Two ways to the same rows: from the
    // declarations (a constant few thousand per file) or from the candidates' own references
    // (cheap when they have few). CROSS JOIN fixes the order and "+" keeps the other index out.
    extCandidatesFromDeclarations: `
    WITH extLine AS MATERIALIZED (
      SELECT DISTINCT ra.SourceId AS SourceId, ra.Line AS Line, ra."Column" AS ExtCol
      FROM "References" ra ${RT}
      WHERE ra.TargetId IN (SELECT value FROM json_each(?)) AND ra.Kind = ${KIND_ATTRIBUTE})
    SELECT DISTINCT e.SourceId AS SourceId, e.Line AS Line, e.ExtCol AS ExtCol
    FROM extLine e CROSS JOIN "References" rc ${RS} ON rc.SourceId = e.SourceId
    WHERE rc.Line = e.Line AND rc.Kind = ${KIND_TYPE_REF} AND +rc.TargetId IN (SELECT value FROM json_each(?))`,
    extCandidatesFromTargets: `
    SELECT DISTINCT rc.SourceId AS SourceId, rc.Line AS Line, ra."Column" AS ExtCol
    FROM "References" rc ${RT} CROSS JOIN "References" ra ${RS} ON ra.SourceId = rc.SourceId
    WHERE rc.TargetId IN (SELECT value FROM json_each(?)) AND rc.Kind = ${KIND_TYPE_REF}
      AND ra.Line = rc.Line AND ra.Kind = ${KIND_ATTRIBUTE} AND +ra.TargetId IN (SELECT value FROM json_each(?))`,
    extLineRefs: `
    SELECT src.Path AS SourcePath, src.ModuleId AS ModuleId, tgt.Path AS TargetPath, r.Kind AS Kind, r."Column" AS Col
    FROM Names src
    CROSS JOIN "References" r ${RS} ON r.SourceId = src.Id
    CROSS JOIN Names tgt ON tgt.Id = r.TargetId
    WHERE src.Id = ? AND r.Line = ? AND r.Kind IN (${KIND_TYPE_REF}, ${KIND_ATTRIBUTE})`,
    wrappedCalls: `
    SELECT DISTINCT src.Path AS SourcePath, tgt.Path AS TargetPath
    FROM Names src ${NP}
    CROSS JOIN "References" r ${RS} ON r.SourceId = src.Id
    CROSS JOIN Names tgt ON tgt.Id = r.TargetId
    WHERE src.Path >= ? COLLATE NOCASE AND src.Path < ? COLLATE NOCASE AND r.Kind = ${KIND_CALL}
      AND tgt.Path >= ? COLLATE NOCASE AND tgt.Path < ? COLLATE NOCASE`,
  };
}

type Statements = { -readonly [K in keyof ReturnType<typeof buildSql>]: StatementSync };

/** C#'s StringComparison.OrdinalIgnoreCase, which upper-cases ("_" sorts after letters). */
function compareIgnoreCase(a: string, b: string): number {
  const x = a.toUpperCase();
  const y = b.toUpperCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

const str = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export class SqliteXrefProvider {
  private db?: DatabaseSync;
  private stmts?: Statements;
  /** Modules(Id → Module) of the open file. */
  private modules = new Map<number, string>();
  /** The open file has no reference without a source name (XREF_META_REFS_WITHOUT_SOURCE_REMOVED). */
  private countsFromIndex = false;
  /** Identity of the file the current status describes (dev:ino:size:mtime). */
  private fileId?: string;
  private current?: XrefSqliteStatus;
  private lastLogged?: string;

  constructor(
    readonly path: string,
    private readonly log: (line: string) => void = line => console.error(line),
  ) {}

  /** Opened, validated and current — the gate the tool adapters check. */
  get isReady(): boolean {
    return this.status().state === 'ok';
  }

  get xrefAvailable(): boolean {
    return this.isReady;
  }

  /** "_Source:_" wording for tool output. */
  get sourceLabel(): string {
    const st = this.current;
    const when = st?.state === 'ok' && st.exportedAt ? `, exported ${st.exportedAt}` : '';
    return `xref SQLite file (DYNAMICSXREFDB export${when})`;
  }

  /** Where a per-shape total of the open file stops counting. */
  get countCap(): number {
    return this.countsFromIndex ? XREF_SQLITE_INDEX_COUNT_CAP : XREF_SQLITE_COUNT_CAP;
  }

  /** The file's status, (re)opening it when it is new or has changed since the last call. */
  status(): XrefSqliteStatus {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? String(e);
      return this.settle(undefined, { state: 'missing', path: this.path, reason: `cannot read the file (${code})` });
    }
    if (!st.isFile()) {
      return this.settle(undefined, { state: 'invalid', path: this.path, reason: 'not a regular file' });
    }
    const id = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
    if (id === this.fileId && this.current) return this.current;
    if (this.fileId !== undefined) this.log(`[XrefSqlite] ${this.path} changed — reopening`);
    return this.settle(id, this.open());
  }

  /** Release the file. The next call opens it again. */
  close(): void {
    this.stmts = undefined;
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* already closed */
      }
      this.db = undefined;
    }
    this.modules = new Map();
    this.countsFromIndex = false;
    this.fileId = undefined;
    this.current = undefined;
  }

  private settle(id: string | undefined, status: XrefSqliteStatus): XrefSqliteStatus {
    if (id === undefined) this.close();
    this.fileId = id;
    this.current = status;
    const key = status.state === 'ok' ? `ok:${id}` : `${status.state}:${status.reason}`;
    if (key !== this.lastLogged) {
      this.lastLogged = key;
      this.log(
        status.state === 'ok'
          ? `[XrefSqlite] using ${this.path}: exported ${status.exportedAt ?? '(unknown)'}, ${status.modules} modules`
          : `[XrefSqlite] not using ${this.path}: ${status.reason} — cross-references fall back to the name-based search`,
      );
    }
    return status;
  }

  private open(): XrefSqliteStatus {
    this.close();
    let db: DatabaseSync;
    try {
      db = openXrefSqliteReadOnly(this.path);
    } catch (e) {
      return { state: 'invalid', path: this.path, reason: `cannot open: ${(e as Error).message}` };
    }
    try {
      const v = validate(db);
      if ('reason' in v) {
        db.close();
        return { state: 'invalid', path: this.path, reason: v.reason };
      }
      const stmts = {} as Statements;
      for (const [k, sql] of Object.entries(buildSql(v.indexes))) stmts[k as keyof Statements] = db.prepare(sql);
      this.db = db;
      this.stmts = stmts;
      this.modules = v.modules;
      // Trusted as written: checking it would mean looking up every reference's source.
      this.countsFromIndex = /^\d+$/.test(v.meta[XREF_META_REFS_WITHOUT_SOURCE_REMOVED] ?? '');
      return {
        state: 'ok',
        path: this.path,
        exportedAt: v.meta.exported_at,
        modules: v.modules.size,
        meta: v.meta,
        countsFromIndex: this.countsFromIndex,
      };
    } catch (e) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      return { state: 'invalid', path: this.path, reason: `not a readable xref file: ${(e as Error).message}` };
    }
  }

  /**
   * Run one query against the current file. A failure is an error, never an
   * empty result (the bridge's rule), and drops the handle so the next call
   * revalidates the file.
   */
  private run<T>(operation: string, subject: string, fn: (s: Statements) => T): T {
    const status = this.status();
    if (status.state !== 'ok' || !this.stmts) {
      throw new Error(`xref SQLite file not available: ${status.state === 'ok' ? 'closed' : status.reason}`);
    }
    try {
      return fn(this.stmts);
    } catch (e) {
      this.close();
      this.log(`[XrefSqlite] ${operation}(${subject}) failed: ${(e as Error).message}`);
      throw new Error(
        `Cross-reference query ${operation}('${subject}') failed: ${(e as Error).message}. ` +
          'This is NOT an empty result — the cross-reference file did not answer, so nothing ' +
          'can be concluded about references to this object.',
      );
    }
  }

  /** The module name of a ModuleId (undefined for none, as the bridge's LEFT JOIN gives NULL). */
  private moduleOf(id: unknown): string | undefined {
    return id === null || id === undefined ? undefined : this.modules.get(Number(id));
  }

  /** Names matching a target set: id → path, and whether a cap cut it. */
  private resolve(s: Statements, targets: PathTargets): { ids: Map<number, string>; capped: boolean } {
    const ids = new Map<number, string>();
    let capped = false;
    for (const p of targets.exact) {
      for (const r of s.exact.all(p) as Row[]) ids.set(Number(r.Id), String(r.Path));
    }
    for (const pat of targets.patterns) {
      const { lo, hi } = prefixRange(pat.prefix);
      const rows = (
        pat.like
          ? s.rangeLike.all(lo, hi, pat.like, XREF_SQLITE_TARGET_CAP + 1)
          : s.range.all(lo, hi, XREF_SQLITE_TARGET_CAP + 1)
      ) as Row[];
      if (rows.length > XREF_SQLITE_TARGET_CAP) capped = true;
      for (const r of rows.slice(0, XREF_SQLITE_TARGET_CAP)) ids.set(Number(r.Id), String(r.Path));
    }
    if (ids.size > XREF_SQLITE_TARGET_CAP) {
      capped = true;
      for (const id of [...ids.keys()].slice(XREF_SQLITE_TARGET_CAP)) ids.delete(id);
    }
    return { ids, capped };
  }

  /** Count up to `cap` (joined to Names, or index only). */
  private bounded(stmt: StatementSync, ids: number[], cap: number): { n: number; capped: boolean } {
    if (ids.length === 0) return { n: 0, capped: false };
    const n = Number((stmt.get(JSON.stringify(ids), cap + 1) as Row).n);
    return n > cap ? { n: cap, capped: true } : { n, capped: false };
  }

  // ------------------------------------------------------------------ FindReferences

  async findReferences(targetName: string, _targetType?: string, page: XrefPage = {}): Promise<BridgeReferenceResult> {
    return this.findReferencesSync(targetName, page);
  }

  /** FindReferences: rows per target shape (code, metadata), totals counted up to a cap. */
  findReferencesSync(objectPath: string, page: XrefPage = {}): BridgeReferenceResult {
    const limit = page.limit ?? XREF_SQLITE_ROWS_PER_SHAPE;
    const offset = page.offset ?? 0;
    return this.run('findReferences', objectPath, s => {
      const { ids, capped: targetsCapped } = this.resolve(s, referenceTargets(objectPath));
      const code: number[] = [];
      const metadata: number[] = [];
      for (const [id, p] of ids) (p.startsWith('/') ? code : metadata).push(id);

      const shape = (shapeIds: number[]) => {
        const rows = shapeIds.length === 0 ? [] : (s.refRows.all(JSON.stringify(shapeIds), limit, offset) as Row[]);
        // A first page that is not full is everything there is: its size is the exact total.
        const counted =
          offset === 0 && rows.length < limit
            ? { n: rows.length, capped: false }
            : this.bounded(this.countsFromIndex ? s.refIndexCount : s.refCount, shapeIds, this.countCap);
        return { rows, ...counted };
      };
      const c = shape(code);
      const m = shape(metadata);

      const references = [...c.rows, ...m.rows].map(r => this.referenceInfo(r, ids));
      // The bridge's order: code targets first, then by source path and line.
      references.sort((a, b) => {
        const sa = a._code ? 0 : 1;
        const sb = b._code ? 0 : 1;
        return sa - sb || compareIgnoreCase(a.info.sourcePath, b.info.sourcePath) || a.info.line - b.info.line;
      });
      const result: BridgeReferenceResult = {
        objectPath,
        count: references.length,
        total: c.n + m.n,
        metadataTotal: m.n,
        references: references.map(r => r.info),
      };
      if (c.capped || m.capped || targetsCapped) result.totalCapped = true;
      return result;
    });
  }

  private referenceInfo(r: Row, ids: Map<number, string>): { info: BridgeReferenceInfo; _code: boolean } {
    const targetPath = ids.get(Number(r.TargetId)) ?? '';
    const sourcePath = String(r.SourcePath);
    const kind = r.Kind === null || r.Kind === undefined ? undefined : Number(r.Kind);
    const p = parsePath(sourcePath);
    const info: BridgeReferenceInfo = {
      sourcePath,
      line: num(r.Line),
      column: num(r.Col),
      referenceType: categorizeReference(kind, targetPath),
      callerClass: p.objectName,
    };
    const module = this.moduleOf(r.ModuleId);
    if (module !== undefined) info.sourceModule = module;
    if (kind !== undefined) info.kind = String(kind);
    if (p.segment === 'Methods' && p.segmentName !== undefined) info.callerMethod = p.segmentName;
    return { info, _code: targetPath.startsWith('/') };
  }

  // ------------------------------------------------------------------ FindExtensionClasses

  async findExtensionClasses(baseClassName: string): Promise<BridgeExtensionClassResult | null> {
    return this.findExtensionClassesSync(baseClassName);
  }

  /** FindExtensionClasses: the [ExtensionOf] classes of an object and the methods each wraps. */
  findExtensionClassesSync(baseClassName: string): BridgeExtensionClassResult {
    return this.run('findExtensionClasses', baseClassName, s => {
      const empty: BridgeExtensionClassResult = { baseClassName, count: 0, extensions: [], _source: SOURCE };
      const extOfIds = (s.exact.all(EXTENSION_OF_ATTRIBUTE_PATH) as Row[]).map(r => Number(r.Id));
      if (extOfIds.length === 0) return empty;
      const candIds = [...this.resolve(s, extensionCandidateTargets(baseClassName)).ids.keys()];
      if (candIds.length === 0) return empty;

      const targetRefs = this.bounded(s.refIndexCount, candIds, EXT_TARGET_DRIVEN_MAX);
      const candidates = (
        targetRefs.capped
          ? s.extCandidatesFromDeclarations.all(JSON.stringify(extOfIds), JSON.stringify(candIds))
          : s.extCandidatesFromTargets.all(JSON.stringify(candIds), JSON.stringify(extOfIds))
      ) as Row[];

      // The bridge's WHERE c.ExtCol = (SELECT MIN(c2.ExtCol) … WHERE c2.SourceId = c.SourceId).
      const minExtCol = new Map<number, number>();
      for (const c of candidates) {
        const id = Number(c.SourceId);
        minExtCol.set(id, Math.min(minExtCol.get(id) ?? Number.MAX_SAFE_INTEGER, num(c.ExtCol)));
      }
      const rows: Row[] = [];
      for (const c of candidates) {
        const id = Number(c.SourceId);
        if (num(c.ExtCol) === minExtCol.get(id)) rows.push(...(s.extLineRefs.all(id, num(c.Line)) as Row[]));
      }

      type Raw = { module?: string; extCol: number; refs: Array<{ target: string; kind: number; col: number }> };
      const raw = new Map<string, Raw>();
      rows.sort((a, b) => compareIgnoreCase(String(a.SourcePath), String(b.SourcePath)));
      for (const r of rows) {
        const path = String(r.SourcePath);
        const parts = path.split('/');
        const className = parts.length >= 3 ? parts[2] : path;
        const target = String(r.TargetPath);
        const kind = num(r.Kind);
        const col = num(r.Col);
        let entry = raw.get(className);
        if (!entry) {
          entry = { module: this.moduleOf(r.ModuleId), extCol: Number.MAX_SAFE_INTEGER, refs: [] };
          raw.set(className, entry);
        }
        entry.refs.push({ target, kind, col });
        if (kind === KIND_ATTRIBUTE && target === EXTENSION_OF_ATTRIBUTE_PATH && col < entry.extCol) entry.extCol = col;
      }

      const extensions: BridgeExtensionClassEntry[] = [];
      for (const [className, entry] of raw) {
        const element = resolveExtendedElement(entry.refs, entry.extCol);
        if (!element || !isRequestedOrNested(element, baseClassName)) continue;
        const src = prefixRange(`/Classes/${className}/Methods/`);
        const tgt = prefixRange(`${element}/Methods/`);
        const wrapped: string[] = [];
        for (const w of s.wrappedCalls.all(src.lo, src.hi, tgt.lo, tgt.hi) as Row[]) {
          const srcLeaf = leafSegment(String(w.SourcePath));
          const tgtLeaf = leafSegment(String(w.TargetPath));
          if (!srcLeaf || !tgtLeaf || foldNocase(srcLeaf) !== foldNocase(tgtLeaf)) continue;
          if (!wrapped.includes(tgtLeaf)) wrapped.push(tgtLeaf);
        }
        const ext: BridgeExtensionClassEntry = { className, extendedElement: element, wrappedMethods: wrapped };
        if (entry.module !== undefined) ext.module = entry.module;
        extensions.push(ext);
      }
      extensions.sort(
        (a, b) =>
          compareIgnoreCase(a.extendedElement ?? '', b.extendedElement ?? '') ||
          compareIgnoreCase(a.className, b.className),
      );
      return { baseClassName, count: extensions.length, extensions, _source: SOURCE };
    });
  }

  // ------------------------------------------------------------------ FindEventSubscribers

  async findEventSubscribers(
    targetName: string,
    eventName?: string,
    handlerType?: string,
  ): Promise<BridgeEventSubscriberResult | null> {
    return this.findEventSubscribersSync(targetName, eventName, handlerType);
  }

  /**
   * FindEventSubscribers: classes referencing the table/class whose names look
   * like handlers. The references are examined up to a cap, the object's own
   * first (that is where handler attributes point), then its members'.
   */
  findEventSubscribersSync(
    targetName: string,
    eventNameFilter?: string,
    handlerTypeFilter?: string,
  ): BridgeEventSubscriberResult {
    return this.run('findEventSubscribers', targetName, s => {
      const targets = eventSubscriberTargets(targetName);
      const { ids } = this.resolve(s, targets);
      const exact = new Set(targets.exact.map(foldNocase));
      const objectIds: number[] = [];
      const memberIds: number[] = [];
      for (const [id, p] of ids) (exact.has(foldNocase(p)) ? objectIds : memberIds).push(id);

      let budget = XREF_SQLITE_SCAN_CAP;
      let scanned = 0;
      let scanCapped = false;
      const sources = new Map<string, string | undefined>();
      for (const group of [objectIds, memberIds]) {
        if (group.length === 0) continue;
        if (budget <= 0) {
          scanCapped = true;
          break;
        }
        const c = this.bounded(s.refIndexCount, group, budget);
        for (const r of s.eventSources.all(JSON.stringify(group), budget) as Row[]) {
          const p = String(r.SourcePath);
          if (!sources.has(p)) sources.set(p, this.moduleOf(r.ModuleId));
        }
        scanned += c.n;
        budget -= c.n;
        if (c.capped) scanCapped = true;
      }

      const handlers: BridgeEventSubscriberEntry[] = [];
      const seen = new Set<string>();
      for (const path of [...sources.keys()].sort(compareIgnoreCase)) {
        const parts = path.split('/');
        const className = parts.length >= 3 ? parts[2] : path;
        const methodName = parts.length >= 5 ? parts[4] : undefined;
        const handlerType = classifyHandlerType(className, methodName);
        const eventName = extractEventName(methodName);
        if (eventNameFilter && eventName !== undefined && eventName.toLowerCase() !== eventNameFilter.toLowerCase())
          continue;
        if (
          handlerTypeFilter &&
          handlerTypeFilter !== 'all' &&
          handlerType.toLowerCase() !== handlerTypeFilter.toLowerCase()
        )
          continue;
        const key = `${className}.${methodName ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const h: BridgeEventSubscriberEntry = { className, handlerType };
        const module = sources.get(path);
        if (module !== undefined) h.module = module;
        if (methodName !== undefined) h.methodName = methodName;
        if (eventName !== undefined) h.eventName = eventName;
        handlers.push(h);
      }
      const result: BridgeEventSubscriberResult = { targetName, count: handlers.length, handlers, _source: SOURCE };
      if (scanCapped) {
        result.scanCapped = true;
        result.scanned = scanned;
      }
      return result;
    });
  }

  // ------------------------------------------------------------------ FindApiUsageCallers

  async findApiUsageCallers(
    apiName: string,
    limit?: number,
    page: XrefPage = {},
  ): Promise<BridgeApiUsageCallersResult | null> {
    return this.findApiUsageCallersSync(apiName, { limit: limit ?? page.limit, offset: page.offset });
  }

  /** FindApiUsageCallers: class callers of an API, a page at a time, grouped by class. */
  findApiUsageCallersSync(apiName: string, page: XrefPage = {}): BridgeApiUsageCallersResult {
    const limit = page.limit ?? 200;
    const offset = page.offset ?? 0;
    return this.run('findApiUsageCallers', apiName, s => {
      const ids = [...this.resolve(s, apiUsageTargets(apiName)).ids.keys()];
      const rows =
        ids.length === 0
          ? []
          : (s.apiCallers.all(JSON.stringify(ids), XREF_SQLITE_SCAN_CAP, limit + 1, offset) as Row[]);
      let more = rows.length > limit;
      if (!more && ids.length > 0) more = this.bounded(s.refIndexCount, ids, XREF_SQLITE_SCAN_CAP).capped;

      const callers: BridgeApiUsageCallerEntry[] = rows.slice(0, limit).map(r => {
        const p = parsePath(String(r.SourcePath));
        const entry: BridgeApiUsageCallerEntry = { callerClass: p.objectName, line: num(r.Line) };
        if (p.segment === 'Methods' && p.segmentName !== undefined) entry.callerMethod = p.segmentName;
        const module = this.moduleOf(r.ModuleId);
        if (module !== undefined) entry.module = module;
        if (r.Kind !== null && r.Kind !== undefined) entry.kind = String(Number(r.Kind));
        return entry;
      });
      // The bridge's ORDER BY sm.Module, src.Path, r.Line (a NULL module first).
      const paths = new Map(callers.map((c, i) => [c, String(rows[i].SourcePath)]));
      callers.sort(
        (a, b) =>
          compareIgnoreCase(a.module ?? '', b.module ?? '') ||
          compareIgnoreCase(paths.get(a)!, paths.get(b)!) ||
          a.line - b.line,
      );

      const byClass = new Map<string, BridgeApiUsageCallersByClass>();
      for (const c of callers) {
        let g = byClass.get(c.callerClass);
        if (!g) {
          g = { callerClass: c.callerClass, methods: [], callCount: 0 };
          if (c.module !== undefined) g.module = c.module;
          byClass.set(c.callerClass, g);
        }
        g.callCount++;
        if (c.callerMethod !== undefined && !g.methods.includes(c.callerMethod)) g.methods.push(c.callerMethod);
      }
      const callersByClass = [...byClass.values()].sort((a, b) => b.callCount - a.callCount);
      const result: BridgeApiUsageCallersResult = {
        apiName,
        totalCallers: callers.length,
        uniqueClasses: callersByClass.length,
        callersByClass,
        callers,
        _source: SOURCE,
      };
      if (more) result.more = true;
      return result;
    });
  }

  // ------------------------------------------------------------------ diagnostics (benchmark)

  /** Ids of the names equal to `path`, ignoring ASCII case. */
  lookupPath(path: string): number[] {
    return this.run('lookupPath', path, s => (s.exact.all(path) as Row[]).map(r => Number(r.Id)));
  }

  /** Up to `limit` names under `prefix` (an index range, not a LIKE). */
  pathsUnder(prefix: string, limit = 200): number[] {
    return this.run('pathsUnder', prefix, s => {
      const { lo, hi } = prefixRange(prefix);
      return (s.range.all(lo, hi, limit) as Row[]).map(r => Number(r.Id));
    });
  }

  /** The path of a name id, or undefined. */
  pathOf(id: number): string | undefined {
    return this.run('pathOf', String(id), s => str((s.pathOf.get(id) as Row | undefined)?.Path));
  }

  /**
   * References to one target per source module, over at most `cap` references:
   * the bounded form of the unbounded "GROUP BY module" over a busy target.
   */
  referencesPerModule(
    targetId: number,
    cap = XREF_SQLITE_COUNT_CAP,
  ): { modules: Map<string, number>; capped: boolean } {
    return this.run('referencesPerModule', String(targetId), s => {
      const modules = new Map<string, number>();
      for (const r of s.perModule.all(JSON.stringify([targetId]), cap) as Row[]) {
        const name = this.moduleOf(r.ModuleId) ?? '';
        modules.set(name, (modules.get(name) ?? 0) + Number(r.n));
      }
      return { modules, capped: this.bounded(s.refIndexCount, [targetId], cap).capped };
    });
  }
}

/** The provider's SQL, for tests that check every lookup stays on an index. */
export const __testing = { buildSql };
