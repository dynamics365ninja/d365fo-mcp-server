/**
 * Lightweight, ADVISORY X++ select-statement linter.
 *
 * replace-code / add-method write X++ source verbatim — they are not a compiler — so a
 * structural select mistake reaches disk and only surfaces as a build error later (with a
 * line number the agent then hunts via filesystem grep). This catches the one mistake that
 * is both common in AI-generated X++ and unambiguous to detect:
 *
 *   a main-table WHERE clause placed AFTER a join.
 *
 * In X++ a select reads:
 *   select [field] from Main [where mainCond]
 *       [ [exists|notexists|outer] join Buf from T where joinCond ]...
 * The main WHERE must precede every join, and each join clause carries at most ONE where.
 * Two `where` keywords inside a single join segment therefore means a stray where landed
 * after the join — exactly the "WHERE after exists join" bug.
 *
 * ADVISORY ONLY: returns human-readable warnings, never throws or blocks. A compiler this is
 * not, and a false positive must never break a legitimate write — at worst it adds a note.
 */

/** Strip X++ line/block/doc comments and string literals so 'where'/'join' tokens inside
 *  them don't skew the scan. Replaces stripped spans with spaces to preserve offsets loosely. */
function stripCommentsAndStrings(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const two = s.slice(i, i + 2);
    if (two === '//') {
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? s.length : nl;
      continue;
    }
    if (two === '/*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; }
      i++;
      out += '""';
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

/**
 * Inspect X++ source for misplaced WHERE clauses in select statements. Returns a list of
 * advisory warning strings (empty when clean).
 */
export function lintXppSelect(source: string | undefined): string[] {
  if (!source || !/\bselect\b/i.test(source)) return [];
  const cleaned = stripCommentsAndStrings(source);
  const warnings: string[] = [];

  // Each select statement spans from `select` to its terminating `;`.
  const selectRe = /\bselect\b[\s\S]*?;/gi;
  let m: RegExpExecArray | null;
  while ((m = selectRe.exec(cleaned)) !== null) {
    const stmt = m[0];
    if (!/\bjoin\b/i.test(stmt)) continue; // only join-bearing selects can have this bug

    // Split into segments at each `join` keyword. Segment 0 is the main-table region
    // (its where is legal); every later segment is one join's clause and may hold at
    // most ONE where. Two wheres in a single join segment ⇒ a stray (main-table) where.
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
