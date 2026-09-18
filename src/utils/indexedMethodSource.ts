/**
 * Method bodies read straight from the symbol index.
 *
 * The readers resolve a method body bridge-first, then by parsing the object's
 * XML off disk. Both of those are Windows-VM facilities, so on an Azure
 * `read-only` deployment every body request fell through to "not found" — while
 * the answer sat in the database the whole time. Measured on a production-size
 * index (2.0 GB, `data/xpp-metadata.db`): 620,851 method rows, 100% of them with
 * a non-empty `source`, averaging 763 characters against the 331-character
 * `source_snippet` preview that `find_references` had been limited to.
 *
 * `source` is written at index time for every method-owning type — classes
 * (509k), tables (93k), forms (46k), views, queries, reports — by the indexer's
 * addSymbol call, and until now exactly one caller read it back, on the WRITE
 * path (`resolveReferences.findMethod`). These helpers give the read path the
 * same access.
 *
 * This is a FALLBACK, never a primary: the index is a snapshot built by a
 * pipeline, so the bridge and the on-disk XML both see newer state and both
 * still run first. It answers where they cannot reach at all.
 *
 * Index safety: `parent_name = ? AND type = 'method' AND name = ? COLLATE
 * NOCASE` plans on `idx_parent_type_name(parent_name, type, name)`. The
 * NOCASE compare is confined to the already-narrow (parent, type) range, which
 * is the pattern symbolLookup.ts documents as acceptable — callers are expected
 * to canonicalize the OWNER name first (see `canonicalSymbolName`), since a
 * NOCASE compare on `parent_name` itself would scan every method row.
 */

import type { DbLike } from './symbolLookup.js';

export interface IndexedMethodSource {
  /** The AOT's own spelling of the method name, not the caller's casing. */
  name: string;
  source: string;
  signature: string | null;
  model: string | null;
}

interface MethodSourceRow {
  name: string;
  source: string | null;
  signature: string | null;
  model: string | null;
}

/**
 * One method body from the index, or null when the row is absent or predates
 * the `source` column.
 *
 * A database built before `source` was added answers NULL for every row (the
 * column is additive — see the migration list in symbolIndex.ts), which is
 * "not indexed yet", not "empty method". Both collapse to null here so callers
 * fall through to their existing not-found path rather than rendering a blank
 * code fence.
 */
export function readIndexedMethodSource(
  db: DbLike,
  ownerName: string,
  methodName: string,
): IndexedMethodSource | null {
  try {
    const row = db.prepare(
      `SELECT name, source, signature, model FROM symbols
       WHERE parent_name = ? AND type = 'method' AND name = ? COLLATE NOCASE
       LIMIT 1`,
    ).get(ownerName, methodName) as MethodSourceRow | undefined;

    if (!row?.source) return null;
    return { name: row.name, source: row.source, signature: row.signature, model: row.model };
  } catch {
    return null; // DB not available — caller keeps its existing fallback chain
  }
}

/**
 * Every indexed method body for one owner, keyed by lowercased method name.
 *
 * Used by the class reader, which needs the whole set in one pass; a per-method
 * call would issue one statement per method on a class that can carry hundreds.
 */
export function readIndexedMethodSources(
  db: DbLike,
  ownerName: string,
): Map<string, IndexedMethodSource> {
  const out = new Map<string, IndexedMethodSource>();
  try {
    const rows = db.prepare(
      `SELECT name, source, signature, model FROM symbols
       WHERE parent_name = ? AND type = 'method'`,
    ).all(ownerName) as MethodSourceRow[];

    for (const row of rows) {
      if (!row?.source) continue;
      out.set(row.name.toLowerCase(), {
        name: row.name, source: row.source, signature: row.signature, model: row.model,
      });
    }
  } catch { /* DB not available — caller renders signatures only, as before */ }
  return out;
}

/**
 * The `[SysObsolete]` / `[Obsolete]` banner for a body, or '' when absent.
 *
 * Shared so the index path cannot quietly omit the warning that the XML path
 * emits — the two render the same source text and must agree about it.
 */
export function obsoleteWarning(source: string): string {
  const match = source.match(/\[\s*SysObsolete\s*\(\s*['"]([^'"]*)['"]/i)
    ?? source.match(/\[\s*Obsolete\s*\(\s*['"]([^'"]*)['"]/i);
  if (!match) return '';
  return (
    `\n\n> ⚠️ **This method is marked obsolete.** Do NOT generate calls to it.\n` +
    `> Replacement hint from the attribute: _"${match[1]}"_\n` +
    `> Read the hint above and use the stated replacement instead.`
  );
}
