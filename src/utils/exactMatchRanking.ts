/**
 * Exact-match-first ranking for object searches.
 *
 * Defect #15 (2026-07-21 sweep): `search(type="edt", query="Num")` at limit=40
 * never surfaced the EDT `Num` — the result window was filled with `NumberOf*` /
 * `Numeric*` prefix hits. Neither backing search ranks by match quality:
 *   • the C# bridge scans provider primary keys in provider order and stops at
 *     `Results.Count >= maxResults` (MetadataReadService.SearchObjects), and
 *   • the SQLite path orders by FTS5 `rank`, which is a token-frequency score,
 *     not a name-equality score.
 * So a short exact name that happens to sort/enumerate late is invisible.
 *
 * PERFORMANCE NOTE: ranking here is pure in-memory work over an already-bounded
 * result window — it never widens a SQL query. The companion "the exact match
 * was outside the window" probe must stay index-safe; see
 * `lookupSymbolsNocase` in utils/symbolLookup.ts (exact-case probe on
 * idx_name_type, bounded FTS phrase fallback — never `LIKE` and never
 * `COLLATE NOCASE` as the primary predicate).
 */

/** Lower is better. 0 = exact, 1 = exact ignoring case, 2 = prefix, 3 = everything else. */
export function exactMatchRank(query: string, name: string): 0 | 1 | 2 | 3 {
  if (name === query) return 0;
  const ln = name.toLowerCase();
  const lq = query.toLowerCase();
  if (ln === lq) return 1;
  if (ln.startsWith(lq)) return 2;
  return 3;
}

/** True when `name` equals `query` ignoring case. */
export function isExactNameMatch(query: string, name: string): boolean {
  return exactMatchRank(query, name) <= 1;
}

/**
 * Stable sort putting exact name matches first, then case-insensitive exact,
 * then prefix matches, leaving the backing search's own order intact within
 * each band (so bridge/FTS relevance is preserved where it says nothing about
 * name equality).
 */
export function rankExactFirst<T>(query: string, items: T[], nameOf: (item: T) => string): T[] {
  return items
    .map((item, idx) => ({ item, idx, rank: exactMatchRank(query, nameOf(item)) }))
    .sort((a, b) => (a.rank - b.rank) || (a.idx - b.idx))
    .map(entry => entry.item);
}
