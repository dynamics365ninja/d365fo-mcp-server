/**
 * Lightweight, advisory X++ select-statement linter.
 *
 * Detects a main-table WHERE clause placed after a join. In X++ a select reads:
 *   select [field] from Main [where mainCond]
 *       [ [exists|notexists|outer] join Buf from T where joinCond ]...
 * The main WHERE must precede every join, and each join clause carries at most one where.
 * Two `where` keywords inside a single join segment means a stray where landed after
 * the join.
 *
 * Advisory only: returns human-readable warnings, never throws or blocks.
 */

import { maskXpp } from './xppLexer.js';

/**
 * Inspect X++ source for misplaced WHERE clauses in select statements. Returns a list of
 * advisory warning strings (empty when clean).
 */
export function lintXppSelect(source: string | undefined): string[] {
  if (!source || !/\bselect\b/i.test(source)) return [];
  const cleaned = maskXpp(source);
  const warnings: string[] = [];

  // A select statement ends at its `;` — or at the `{` that opens a `while select`
  // body, whichever comes first. Stopping only at `;` swallowed the loop body, so a
  // second, perfectly legal select inside the body contributed its own `where` to
  // the join segment and every `while select … join … { select … where …; }` in the
  // platform (41 shipped classes) was reported as a misplaced where.
  const selectRe = /\bselect\b[^;{]*[;{]/gi;
  let m: RegExpExecArray | null;
  while ((m = selectRe.exec(cleaned)) !== null) {
    const stmt = m[0];
    if (!/\bjoin\b/i.test(stmt)) continue; // only join-bearing selects can have this bug

    // Segment 0 is the main-table region (its where is legal); every later segment is
    // one join's clause and may hold at most one where.
    const segments = stmt.split(/\bjoin\b/i);
    for (let s = 1; s < segments.length; s++) {
      const whereCount = (segments[s].match(/\bwhere\b/gi) ?? []).length;
      if (whereCount >= 2) {
        const snippet = stmt.replace(/\s+/g, ' ').trim().slice(0, 120);
        warnings.push(
          `⚠️ Possible X++ select error: a WHERE clause appears AFTER a join.\n` +
          `   In X++ the main-table WHERE must come BEFORE any join, and each join has at most one WHERE.\n` +
          `   Move the main-table condition ahead of the join:\n` +
          `     select <field> from <Main> where <mainCond> exists join <Buf> from <T> where <joinCond>;\n` +
          `   Statement: ${snippet}${stmt.length > 120 ? '…' : ''}`,
        );
        break; // one warning per statement is enough
      }
    }
  }
  return warnings;
}
