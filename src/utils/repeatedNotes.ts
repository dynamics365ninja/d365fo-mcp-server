/**
 * Advisories that describe the WORKSPACE rather than the write, said in full
 * once per server process and abbreviated afterwards.
 *
 * Measured: in a project-less, non-git workspace every single write carried the
 * forced-backup line (~200 chars) and the "no projectPath could be resolved"
 * block (~230 chars). Neither is a fact about the object being written — both
 * are properties of the tree it is written into — so a session of twenty edits
 * paid ~8 KB to learn the same two facts twenty times, and every one of those
 * bytes is re-read by every later request in the session.
 *
 * The first occurrence stays fully informative, because a caller seeing it for
 * the first time needs the whole explanation. Later ones shrink to a line that
 * still carries the part that genuinely differs each time — the backup path is
 * a new file on every write and must never be dropped.
 *
 * Lives in utils/ rather than in one of the write tools because both
 * createD365File and modifyD365File need it and `tests/utils/layering.test.ts`
 * forbids those two from importing each other.
 *
 * Module-level and unbounded by design: the key space is the set of model
 * folders one server process has written to, which is small and bounded by the
 * workspace.
 */

const advisoriesAlreadySpelledOut = new Set<string>();

/** Full text the first time this (kind, scope) is seen; the short line after. */
export function sayOncePerSession(kind: string, scope: string, full: string, short: string): string {
  const id = `${kind}|${scope.toLowerCase()}`;
  if (advisoriesAlreadySpelledOut.has(id)) return short;
  advisoriesAlreadySpelledOut.add(id);
  return full;
}

/** Test seam — the set is process-wide and outlives a single tool call. */
export function resetRepeatedNoteMemory(): void {
  advisoriesAlreadySpelledOut.clear();
}
