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

/**
 * Bodies WERE requested, the source file could not be read, and the symbol
 * index supplied them instead — the Azure read-only case, where there is
 * neither a bridge nor a PackagesLocalDirectory to fall back to.
 *
 * Distinct from SOURCE_UNAVAILABLE_HINT because the caller is looking at real
 * bodies, and distinct from COMPACT_METHODS_HINT because `compact:false` is
 * already what they passed. It says where the code came from (a pipeline-built
 * snapshot, so it can lag the live model) and how to get one body in full,
 * since the listing truncates exactly as the on-disk path does.
 */
export const INDEXED_BODIES_HINT =
  '> 💡 Bodies from the symbol index — the metadata files are not reachable here, so this reflects the last indexed build. Truncated in this listing; `options:{"method":"<name>","include":"source"}` for one in full.';

/** How to ask for the rest of a body that was truncated in a listing. */
export function fullBodyHint(methodName: string): string {
  return `options:{"method":"${methodName}","include":"source"} for the full body`;
}

/**
 * The published call that reads one method, written out in full.
 *
 * Every instruction the server hands an agent goes through here so they cannot
 * drift apart, and so none of them names `get_method` again. That tool is not
 * in ListTools (toolHandler.ts keeps the route for agents holding the old name,
 * nothing more), and the even older `get_method_signature` is not routable at
 * all — it only ever existed as an internal sub-request inside getMethod.ts, so
 * an agent told to call it gets "unknown tool" with no way to recover.
 *
 * `include` is the part worth being exact about: "signature" returns the
 * signature, "source" the body. Asking for the wrong one is a wasted round trip
 * at best, and telling an agent to use "signature" to read a body — which the
 * class readers used to do — sends it away believing no body exists.
 */
export function readMethodCall(
  objectType: 'class' | 'table' | 'view' | 'data-entity',
  objectName: string,
  methodName: string,
  include: 'signature' | 'source' | 'both' = 'signature',
): string {
  return `get_object_info(objectType="${objectType}", name="${objectName}", options:{"method":"${methodName}","include":"${include}"})`;
}

/**
 * The same call as guidance rather than a concrete invocation, for prose that
 * has no particular object in hand.
 */
export const READ_METHOD_OPTIONS = 'get_object_info options:{"method":"<name>","include":"signature"}';
