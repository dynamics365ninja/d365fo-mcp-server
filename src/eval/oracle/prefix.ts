/**
 * EXTENSION_PREFIX canonicalisation for the eval golden oracle.
 *
 * Split out of normalize.ts so the artifact-key layer (artifactKey.ts) can use
 * it without an import cycle back through the normalizer.
 */

/** Escape a literal string for embedding in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Stable placeholder a canonicalised prefix occurrence is replaced with. */
export const PREFIX_PLACEHOLDER = 'PFX';

/** One or more EXTENSION_PREFIX tokens to canonicalise a document against. */
export type PrefixSpec = string | readonly string[];

/**
 * The Microsoft extension-class suffix, as an anchored lookahead: the prefix
 * token must be IMMEDIATELY followed by `_Extension`, and `_Extension` must END
 * the identifier.
 *
 * Both halves are load-bearing:
 *
 *  - "immediately" is what keeps the branch non-greedy. It would be tempting to
 *    consume the whole PascalCase run before `_Extension` (`Con[A-Za-z0-9]*`),
 *    since the session-chosen prefix can be longer than the golden's
 *    (`Con` vs `ConDemo`) — but then `FMVehicleDataContractConfig_Extension`
 *    would canonicalise onto `FMVehicleDataContractCon_Extension` and a diff
 *    between two DIFFERENT objects would silently pass. Each side is
 *    canonicalised against ITS OWN prefix token, so exact adjacency is enough.
 *  - the end-of-identifier guard keeps the branch confined to the naming
 *    convention it is named after; `…Con_ExtensionHelper` is left alone.
 */
const EXTENSION_CLASS_SUFFIX = '(?=_Extension(?![A-Za-z0-9_]))';

/**
 * Canonicalise occurrences of `prefix` — the model-naming EXTENSION_PREFIX in
 * effect for THIS document (the golden's fixed capture-time prefix, or the
 * actual's current session-configured prefix) — into a stable placeholder, so
 * a value/key built under one prefix session compares equal to the same
 * value/key built under a different one.
 *
 * TWO placements are recognised, because D365FO names prefixed objects in two
 * different shapes:
 *
 *   PREFIX (`{Prefix}{Name}`) — the prefix leads the identifier. Matched at an
 *     identifier-start boundary (string start, or immediately after a
 *     non-alphanumeric character — `.`, `(`, `,`, `_`, whitespace, …) AND
 *     required to be followed by an uppercase letter, i.e. the PascalCase
 *     continuation of the object's own name: `ContosoXyzNoteSubject`,
 *     `CustGroup.ContosoExtension`, `classStr(ContosoXyzNoteSubject)`.
 *
 *   INFIX (`{Base}{Prefix}_Extension`) — the Microsoft extension-class
 *     convention, where the prefix sits MID-identifier (preceded by the base
 *     object's name) and is followed by an underscore, so NEITHER half of the
 *     prefix rule applies: `FMVehicleDataContractCon_Extension`. Matched only
 *     when the token is immediately followed by a terminal `_Extension`
 *     (`EXTENSION_CLASS_SUFFIX`), with no leading-boundary requirement.
 *
 * Both keep the substitution narrow: an incidental occurrence of the prefix text
 * inside unrelated free-form content (e.g. a label), or as a PascalCase word
 * inside a longer name (`SalesConNote`, `…Config_Extension`), is left alone. That
 * narrowness is the point — this function is deliberately lossy and is used to
 * compare artifact names ACROSS prefix sessions, so a rule greedy enough to
 * canonicalise a prefix-shaped substring of an unrelated identifier would make
 * two different objects compare equal and let a real diff pass silently. That is
 * a worse failure than a false mismatch, and `tests/eval/oraclePrefixExtensionInfix.test.ts`
 * pins the boundaries in both directions.
 *
 * Regression: without the INFIX branch, a CoC extension class captured as
 * `FMVehicleDataContractCon_Extension` and reproduced under session prefix
 * `ConDemo` scored `golden_match: 0` on a runtime-verified-correct
 * implementation (corpus: 2026-08-31T23__L2-coc-extension__278eee3; the same gap
 * reported in 2026-07-07T04__L2-coc-extension__cb1b73d, whose proposed fix —
 * widening the lookahead to `[A-Z_]` — was measured insufficient, since the
 * leading boundary is the actual blocker).
 *
 * `prefix` may be a SET of tokens (see `GOLDEN_CAPTURE_PREFIXES`). Tokens are
 * applied longest-first so a longer prefix is consumed before a shorter one
 * that is its own leading substring (`Contoso` before `Con`) can split it.
 */
export function canonicalizePrefix(value: string, prefix: PrefixSpec): string {
  const tokens = (typeof prefix === 'string' ? [prefix] : [...prefix])
    .filter(p => !!p)
    .sort((a, b) => b.length - a.length);
  let out = value;
  for (const token of tokens) {
    const t = escapeRegExp(token);
    // Prefix placement: `{Prefix}{Name}` at an identifier start.
    out = out.replace(
      new RegExp(`(^|[^A-Za-z0-9])${t}(?=[A-Z])`, 'g'),
      `$1${PREFIX_PLACEHOLDER}`,
    );
    // Infix placement: `{Base}{Prefix}_Extension`.
    out = out.replace(
      new RegExp(`${t}${EXTENSION_CLASS_SUFFIX}`, 'g'),
      PREFIX_PLACEHOLDER,
    );
  }
  return out;
}

