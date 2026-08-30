/**
 * The compiler's own answers about X++, as a queryable surface.
 *
 * Everything here comes from `eval/compiler-facts.snapshot.json`, captured on a VM
 * by `scripts/capture-compiler-facts.ts` from the shipped compiler:
 *   - reserved words   → XppParser.Keywords.KeywordHashSet (reflection)
 *   - intrinsics       → XppCompiler.Intrinsics.IntrinsicFunctionInfo (reflection)
 *   - run-time arities → xppc probe builds ("expects N argument(s)" / "is missing
 *                        argument K"), so optional trailing parameters are visible
 *                        as a min/max range rather than guessed
 *
 * Rules and knowledge read from here instead of carrying their own copy of a list.
 * The reason is a measured one: the hand-maintained arity table said date2Str took
 * 8 arguments and the shipped platform calls it with 7 (161 times), while the
 * language reference says `*=` does not exist and the platform ships 57 uses.
 * A table that is not the compiler's own drifts from it.
 *
 * tests/knowledge/compilerFacts.test.ts fails when the generated module and the
 * snapshot disagree, or when a validator table contradicts either.
 */
import {
  COMPILER_FACTS_CAPTURED_AT,
  COMPILER_VERSION,
  XPP_EXEMPTED_KEYWORDS,
  XPP_INTRINSICS,
  XPP_KEYWORDS,
  XPP_OBSOLETE_FUNCTIONS,
  XPP_RUNTIME_FUNCTIONS,
  XPP_UNKNOWN_FUNCTIONS,
} from './compilerFacts.generated.js';

export {
  COMPILER_FACTS_CAPTURED_AT,
  COMPILER_VERSION,
  XPP_EXEMPTED_KEYWORDS,
  XPP_INTRINSICS,
  XPP_KEYWORDS,
  XPP_OBSOLETE_FUNCTIONS,
  XPP_RUNTIME_FUNCTIONS,
  XPP_UNKNOWN_FUNCTIONS,
};

export interface RuntimeArity {
  min: number;
  max: number | 'variadic';
}

const KEYWORDS = new Set(XPP_KEYWORDS.map(k => k.toLowerCase()));
const EXEMPTED = new Set(XPP_EXEMPTED_KEYWORDS.map(k => k.toLowerCase()));
const INTRINSICS_LC = new Map(
  Object.entries(XPP_INTRINSICS).map(([name, args]) => [name.toLowerCase(), { name, args }]),
);
const RUNTIME_LC = new Map(
  Object.entries(XPP_RUNTIME_FUNCTIONS).map(([name, arity]) => [name.toLowerCase(), { name, arity }]),
);
const UNKNOWN_LC = new Set(XPP_UNKNOWN_FUNCTIONS.map(n => n.toLowerCase()));
const OBSOLETE_LC = new Set(XPP_OBSOLETE_FUNCTIONS.map(n => n.toLowerCase()));

/**
 * True when `word` is a reserved word the parser will not accept as an identifier.
 * X++ is case-insensitive. `in` is reserved but exempted, so it is NOT reported.
 */
export function isReservedKeyword(word: string): boolean {
  const w = word.toLowerCase();
  return KEYWORDS.has(w) && !EXEMPTED.has(w);
}

/** Canonical spelling + argument count of an intrinsic, or null when it is not one. */
export function intrinsicInfo(name: string): { name: string; args: number } | null {
  return INTRINSICS_LC.get(name.toLowerCase()) ?? null;
}

/** Canonical spelling + accepted argument counts of a run-time function, or null. */
export function runtimeFunctionInfo(name: string): { name: string; arity: RuntimeArity } | null {
  return RUNTIME_LC.get(name.toLowerCase()) ?? null;
}

/** True when the compiler accepts `count` arguments for this run-time function. */
export function acceptsArgumentCount(arity: RuntimeArity, count: number): boolean {
  if (arity.max === 'variadic') return count >= arity.min;
  return count >= arity.min && count <= arity.max;
}

/** How the compiler describes the accepted argument counts, for a fix message. */
export function describeArity(arity: RuntimeArity): string {
  if (arity.max === 'variadic') return 'a variable number of arguments';
  if (arity.min === arity.max) return `${arity.max} argument(s)`;
  return `${arity.min}–${arity.max} argument(s) (the last ${arity.max - arity.min} optional)`;
}

/** A name that looks predefined but does not exist on this platform version. */
export function isUnknownFunction(name: string): boolean {
  return UNKNOWN_LC.has(name.toLowerCase());
}

/** A predefined function the compiler reports as obsolete. */
export function isObsoleteFunction(name: string): boolean {
  return OBSOLETE_LC.has(name.toLowerCase());
}
