/**
 * Inheritance-chain helpers for method lookup.
 *
 * Every method reader probes the object the caller named: the bridge reads
 * `Classes.Read(name).Methods`, the XML path parses that one file, and SQLite
 * matches `parent_name = <name>`. All three see *declared* members only, so a
 * method the class inherits reports a false "not found" — the CoC path hits
 * this constantly, because the class worth wrapping is often a leaf whose
 * interesting methods live on a base class (SalesFormLetter_Invoice does not
 * declare `promptAndRun`; SalesFormLetter does).
 *
 * These helpers climb `symbols.extends_class` so a reader can retry against the
 * class that actually declares the method. SQLite is the locator (indexed,
 * sub-ms) and the bridge/XML stays the reader.
 */

import { lookupSymbolNocase, type DbLike } from './symbolLookup.js';

/**
 * Object types whose `extends_class` carries method inheritance. Tables are
 * included for table inheritance (SupportInheritance/Extends); EDT `extends`
 * is a type chain, not a method chain, so EDTs are deliberately absent.
 */
const INHERITING_TYPES = ['class', 'table'] as const;

/**
 * Depth cap. Real AOT chains are under ten (SalesFormLetter_Invoice → … →
 * RunBase is five); the cap only bounds the damage from a cyclic
 * `extends_class` in a corrupt index — a name-based cycle guard runs too.
 */
const MAX_DEPTH = 12;

/**
 * Ancestors of `name`, nearest first, in canonical (as-indexed) casing.
 * The class itself is not included. Returns [] when the object is unknown,
 * has no base, or the DB is unavailable.
 */
export function inheritanceAncestors(db: DbLike, name: string, maxDepth = MAX_DEPTH): string[] {
  if (!name) return [];
  const chain: string[] = [];
  try {
    const seen = new Set<string>([name.toLowerCase()]);
    let current = lookupSymbolNocase(db, name, INHERITING_TYPES);
    while (current?.extends_class && chain.length < maxDepth) {
      const parentName = current.extends_class.trim();
      if (!parentName || seen.has(parentName.toLowerCase())) break;
      seen.add(parentName.toLowerCase());

      const parent = lookupSymbolNocase(db, parentName, INHERITING_TYPES);
      // Emit the base even when it is not indexed (e.g. a kernel class such as
      // Object): the bridge may still be able to read it. Climbing stops there
      // because there is no row to read the next `extends_class` from.
      chain.push(parent?.name ?? parentName);
      if (!parent) break;
      current = parent;
    }
  } catch { /* DB error — treat as "no chain known" */ }
  return chain;
}

/**
 * Nearest ancestor of `className` that declares `methodName` according to the
 * symbol index, or undefined when no ancestor does (or the index doesn't know).
 *
 * `className` itself is not probed — callers have already tried it directly.
 *
 * Index-safe: `parent_name = ?` stays BINARY on idx_parent_type_name (the
 * ancestor names come back canonically cased from `inheritanceAncestors`), so
 * `COLLATE NOCASE` applies only inside one object's already-narrow member range.
 */
export function findDeclaringAncestor(
  db: DbLike,
  className: string,
  methodName: string,
): string | undefined {
  if (!className || !methodName) return undefined;
  try {
    const stmt = db.prepare(
      `SELECT 1 AS x FROM symbols
       WHERE type = 'method' AND parent_name = ? AND name = ? COLLATE NOCASE
       LIMIT 1`,
    );
    for (const ancestor of inheritanceAncestors(db, className)) {
      if (stmt.get(ancestor, methodName) !== undefined) return ancestor;
    }
  } catch { /* DB error — fall through to "unknown" */ }
  return undefined;
}

/**
 * Owners to retry a failed method read against, nearest ancestor first.
 *
 * When the index knows which ancestor declares the method, that is the only
 * candidate — one extra read instead of a walk. Otherwise the answer depends on
 * how expensive a miss is: the bridge answers in-process, so probing the whole
 * chain is fine, but the XML path pays a file parse with a 3 s timeout per
 * level, so an unlocated method is not worth walking blindly.
 */
export function inheritedOwnerCandidates(
  db: DbLike,
  className: string,
  methodName: string,
  bridgeAvailable: boolean,
): string[] {
  const declaring = findDeclaringAncestor(db, className, methodName);
  if (declaring) return [declaring];
  return bridgeAvailable ? inheritanceAncestors(db, className) : [];
}
