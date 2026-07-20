/**
 * Shared symbol-index lookup for the knowledge audit (ROADMAP P1).
 *
 * Extracted from knowledgeAuditCli so the CLI (`--capture`) and the CI test
 * (tests/knowledge/apiSymbols.test.ts) resolve knowledge references through the
 * exact same query logic — a single source of truth for "does this AOT element
 * exist". Pure I/O: opens the read-only 2 GB SQLite index and returns a
 * {@link SymbolLookup} plus the index's `last_indexed_at` stamp.
 */

import * as fs from 'fs';
import type { SymbolLookup } from './knowledgeAudit.js';

/** AOT element types worth resolving a knowledge reference against. */
export const ELEMENT_TYPES = [
  'class', 'table', 'enum', 'edt', 'interface', 'form', 'view', 'query', 'map',
  'report', 'macro', 'data-entity', 'service', 'configuration-key',
  'menu-item-display', 'menu-item-action', 'menu-item-output',
];

/**
 * Loads the whole element-name table into memory once (~135k rows). A
 * per-name `COLLATE NOCASE` query would full-scan the 2 GB index for every
 * lookup (see memory/sqlite-query-antipatterns); one sequential pass over the
 * indexed `type` column is both correct and ~1000x cheaper here.
 */
export async function openSymbolLookup(
  dbPath: string,
): Promise<{ lookup: SymbolLookup; indexedAt: string }> {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`symbol index not found at ${dbPath} (set DB_PATH).`);
  }
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });

  const byLower = new Map<string, { canonical: string; types: Set<string> }>();
  const placeholders = ELEMENT_TYPES.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT name, type FROM symbols WHERE type IN (${placeholders})`)
    .all(...ELEMENT_TYPES) as Array<{ name: string; type: string }>;
  for (const r of rows) {
    const key = r.name.toLowerCase();
    const hit = byLower.get(key);
    if (hit) hit.types.add(r.type);
    else byLower.set(key, { canonical: r.name, types: new Set([r.type]) });
  }

  // Tier-2 evidence: names that no symbol row owns, but real elements declare
  // as their base/interface. Scanned off the indexed `type` column, never a
  // full table scan.
  const referenced = new Set<string>();
  const baseRows = db
    .prepare(`SELECT extends_class, implements_interfaces FROM symbols WHERE type IN ('class','interface','table','form','view','map','query')`)
    .all() as Array<{ extends_class: string | null; implements_interfaces: string | null }>;
  for (const r of baseRows) {
    if (r.extends_class) referenced.add(r.extends_class.trim().toLowerCase());
    for (const i of (r.implements_interfaces ?? '').split(',')) {
      const t = i.trim().toLowerCase();
      if (t) referenced.add(t);
    }
  }

  const memberStmt = db.prepare(
    `SELECT name FROM symbols WHERE parent_name = ? AND type = 'method'`,
  );
  const memberCache = new Map<string, Set<string>>();

  const lookup: SymbolLookup = {
    resolve(name) {
      const hit = byLower.get(name.toLowerCase());
      return hit ? { canonical: hit.canonical, types: [...hit.types] } : null;
    },
    isReferencedBase(name) {
      return referenced.has(name.toLowerCase());
    },
    hasMember(canonical, member) {
      let set = memberCache.get(canonical);
      if (!set) {
        set = new Set((memberStmt.all(canonical) as Array<{ name: string }>).map(r => r.name.toLowerCase()));
        memberCache.set(canonical, set);
      }
      return set.has(member.toLowerCase());
    },
  };

  const meta = db.prepare(`SELECT value FROM _index_meta WHERE key = 'last_indexed_at'`).get() as
    | { value: string }
    | undefined;
  return { lookup, indexedAt: meta?.value ?? 'unknown' };
}
