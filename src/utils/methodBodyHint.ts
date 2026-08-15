/**
 * The one sentence that tells a caller a class listing withheld method bodies,
 * and how to ask for them.
 *
 * It lives here, rather than beside either renderer, because three places have
 * to agree on it and none of them owns the other two: the bridge class view
 * (bridge/bridgeAdapter.ts), the DB-only view (tools/readers/classInfo.ts), and
 * the plural response that collapses repeats of it (tools/readers/
 * getObjectInfo.ts). A copy per renderer is how the two class paths came to
 * give different, and in one case wrong, advice for the same situation.
 *
 * It names `options` on get_object_info, NOT the old `get_method` tool: that
 * one is no longer published in ListTools (toolHandler.ts keeps the route only
 * so an agent still holding the name from an earlier session gets an answer
 * rather than "unknown tool"). And it asks for `include:"source"` — the value
 * that returns a body. `include:"signature"` returns the signature instead,
 * which is what the DB-only hint used to advertise for "a full method body".
 */
export const COMPACT_METHODS_HINT =
  '> 💡 Signatures only. Pass `options:{"compact":false}` for method bodies, or `options:{"method":"<name>","include":"source"}` for one method.';

/**
 * The same situation reached the other way round: bodies WERE requested and the
 * source could not be read (no D365FO install on this host, or the XML parse
 * timed out). Repeating "pass compact:false" there would send the caller round
 * the loop they just came from.
 */
export const SOURCE_UNAVAILABLE_HINT =
  '> 💡 Signatures only — the source file could not be read (no D365FO install here, or the parse timed out). `options:{"method":"<name>","include":"source"}` may still resolve a single method.';

/** How to ask for the rest of a body that was truncated in a listing. */
export function fullBodyHint(methodName: string): string {
  return `options:{"method":"${methodName}","include":"source"} for the full body`;
}
