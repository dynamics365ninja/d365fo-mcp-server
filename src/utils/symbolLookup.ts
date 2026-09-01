/**
 * Index-safe case-insensitive symbol lookups.
 *
 * `name = ? COLLATE NOCASE` cannot use the BINARY-collated name indexes and
 * degrades to a scan of the 1.17M-row symbols table — 13–180 s on a
 * production-size DB with a cold file cache. node:sqlite is synchronous,
 * so that scan blocks the event loop until MCP clients time out and kill the
 * server.
 *
 * Pattern (proven in prepare, d93f004): exact-case probe on idx_name_type
 * (sub-ms) first, FTS5 phrase match (case-folded by the tokenizer) as the
 * fallback for differently-cased input. The FTS candidates are re-checked
 * with `COLLATE NOCASE`, so FTS can only narrow the result, never widen it.
 *
 * `COLLATE NOCASE` stays acceptable only inside an already-narrow indexed
 * range — e.g. `WHERE parent_name = ? AND type = ? AND name = ? COLLATE
 * NOCASE` after the parent name has been canonicalized through one of these
 * lookups.
 */

/** Minimal DB surface these helpers need — satisfied by src/database/sqlite.ts. */
export interface DbLike {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export interface SymbolHit {
  name: string;
  type: string;
  model: string | null;
  extends_class: string | null;
  file_path: string | null;
}

/** Quote a name as an FTS5 phrase (strips embedded double quotes). */
function ftsPhrase(name: string): string {
  return `"${name.replace(/"/g, '')}"`;
}

const HIT_COLS = 's.name, s.type, s.model, s.extends_class, s.file_path';

function typeFilter(types?: readonly string[]): { sql: string; params: string[] } {
  if (!types || types.length === 0) return { sql: '', params: [] };
  return {
    sql: ` AND s.type IN (${types.map(() => '?').join(', ')})`,
    params: [...types],
  };
}

/**
 * Case-insensitive lookup of top-level symbols (parent_name IS NULL) by name,
 * optionally scoped to a set of types. Exact-case rows come first; rows with
 * different casing are found through the FTS fallback and deduplicated.
 */
export function lookupSymbolsNocase(
  db: DbLike,
  name: string,
  opts: { types?: readonly string[]; limit?: number } = {},
): SymbolHit[] {
  if (!name) return [];
  const limit = opts.limit ?? 1;
  const tf = typeFilter(opts.types);
  const exact = db.prepare(
    `SELECT ${HIT_COLS} FROM symbols s
     WHERE s.name = ?${tf.sql} AND s.parent_name IS NULL
     LIMIT ?`,
  ).all(name, ...tf.params, limit) as SymbolHit[];
  if (exact.length >= limit) return exact;

  const fts = db.prepare(
    `SELECT ${HIT_COLS} FROM symbols_fts fts
     JOIN symbols s ON s.id = fts.rowid
     WHERE symbols_fts MATCH ?
       AND s.name = ? COLLATE NOCASE${tf.sql} AND s.parent_name IS NULL
     LIMIT ?`,
  ).all(`{name} : ${ftsPhrase(name)}`, name, ...tf.params, limit) as SymbolHit[];

  const key = (r: SymbolHit) => `${r.name}\0${r.type}\0${r.model ?? ''}`;
  const seen = new Set(exact.map(key));
  const merged = [...exact];
  for (const r of fts) {
    if (!seen.has(key(r))) {
      seen.add(key(r));
      merged.push(r);
    }
  }
  return merged.slice(0, limit);
}

/** First case-insensitive top-level hit for a name, or undefined. */
export function lookupSymbolNocase(
  db: DbLike,
  name: string,
  types?: readonly string[],
): SymbolHit | undefined {
  return lookupSymbolsNocase(db, name, { types, limit: 1 })[0];
}

/**
 * Canonical (as-indexed) casing of a top-level object name, or undefined when
 * the name is not in the index. Use this to canonicalize a user-supplied name
 * once, so follow-up probes on parent_name/base_object_name stay BINARY and
 * on-index.
 */
export function canonicalSymbolName(
  db: DbLike,
  name: string,
  types?: readonly string[],
): string | undefined {
  return lookupSymbolNocase(db, name, types)?.name;
}

/**
 * All DISTINCT symbol types recorded for a name under any casing and any
 * parent (methods and fields included) — index-safe replacement for
 * `SELECT DISTINCT type FROM symbols WHERE name = ? COLLATE NOCASE`.
 */
export function distinctSymbolTypesNocase(db: DbLike, name: string, limit = 10): string[] {
  if (!name) return [];
  const types = new Set<string>();
  const exact = db.prepare(
    'SELECT DISTINCT type FROM symbols WHERE name = ? LIMIT ?',
  ).all(name, limit) as Array<{ type: string }>;
  for (const r of exact) types.add(r.type);
  if (types.size < limit) {
    // Cap the FTS candidate set: a name shared by tens of thousands of rows
    // (e.g. every table's `insert` method) would otherwise cost that many row
    // lookups (~10 s cold). Differently-cased rows beyond the cap are
    // sacrificed — the exact-case probe above already covered exact casing.
    const fts = db.prepare(
      `SELECT DISTINCT s.type FROM (
         SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ? LIMIT 3000
       ) f JOIN symbols s ON s.id = f.rowid
       WHERE s.name = ? COLLATE NOCASE
       LIMIT ?`,
    ).all(`{name} : ${ftsPhrase(name)}`, name, limit) as Array<{ type: string }>;
    for (const r of fts) types.add(r.type);
  }
  return [...types].slice(0, limit);
}

/**
 * Case-insensitive lookup of NON-top-level symbols by exact name — the rows
 * `lookupSymbolsNocase` deliberately cannot see.
 *
 * Every helper above requires `parent_name IS NULL`, which is the index's marker
 * for a top-level object. EXTENSION rows do not carry it: they record the object
 * they extend in `parent_name` instead (all 278 enum extensions in a production
 * index do). So an extension is invisible to every lookup in this module, and
 * `prepare`'s collision check cleared `NumberSeqModule.Kitting` — an
 * enum-extension that is right there in the index — as "no collision", moments
 * before a write (#995).
 *
 * Same two-step as `lookupSymbolsNocase`, and for the same reason: the exact-case
 * probe rides idx_name_type (0.2 ms), while `name = ? COLLATE NOCASE` alone
 * cannot use that BINARY index and scans it — measured at 60 SECONDS on a
 * production-size DB, which node:sqlite would spend blocking the event loop.
 */
export function lookupChildSymbolsNocase(
  db: DbLike,
  name: string,
  limit = 3,
): SymbolHit[] {
  if (!name) return [];
  const exact = db.prepare(
    `SELECT ${HIT_COLS} FROM symbols s INDEXED BY idx_name_type
     WHERE s.name = ? AND s.parent_name IS NOT NULL
     LIMIT ?`,
  ).all(name, limit) as SymbolHit[];
  if (exact.length >= limit) return exact;

  const fts = db.prepare(
    `SELECT ${HIT_COLS} FROM symbols_fts fts
     JOIN symbols s ON s.id = fts.rowid
     WHERE symbols_fts MATCH ?
       AND s.name = ? COLLATE NOCASE AND s.parent_name IS NOT NULL
     LIMIT ?`,
  ).all(`{name} : ${ftsPhrase(name)}`, name, limit) as SymbolHit[];

  const key = (r: SymbolHit) => `${r.name}\0${r.type}\0${r.model ?? ''}`;
  const seen = new Set(exact.map(key));
  const merged = [...exact];
  for (const r of fts) {
    if (!seen.has(key(r))) {
      seen.add(key(r));
      merged.push(r);
    }
  }
  return merged.slice(0, limit);
}
