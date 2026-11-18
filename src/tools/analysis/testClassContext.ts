/**
 * Is the X++ being validated part of a SysTest test class?
 *
 * BP002 warns about doInsert()/doUpdate()/doDelete() because they skip the table's
 * own insert/update/delete logic and its event handlers. In a test class that is the
 * point: a fixture is set up with do* so the code under test is the only logic that
 * runs. Of the 359 shipped classes deriving from SysTestCase (platform 10.0.2790), 82
 * use do* (182 calls).
 *
 * Only 3 of those 82 extend SysTestCase directly, and 10 carry [SysTestMethod] in the
 * file. 76 reach SysTestCase through AtlWHSTestCase. So the source alone recognises a
 * few of them, and the rest need the symbol index, which follows the extends chain.
 *
 * Nothing here guesses from a name. 7 shipped PRODUCTION classes that use do* have
 * "Test" in their name, so a name heuristic would exempt real code. Every signal is
 * exact: the attribute, a literal `extends SysTestCase`, or SysTestCase among the
 * indexed ancestors.
 */

import { inheritanceAncestors } from '../../utils/inheritanceChain.js';
import type { DbLike } from '../../utils/symbolLookup.js';

const TEST_BASE = 'systestcase';

/** The class the code declares and its base, read from masked source. */
export function declaredClassAndBase(masked: string): { name: string; base: string | null } | null {
  const decl = /^[ \t]*(?:(?:public|private|protected|internal|final|abstract|static)\s+)*class\s+(\w+)([^{]*)/m
    .exec(masked);
  if (!decl) return null;
  const base = /\bextends\s+(\w+)/.exec(decl[2])?.[1] ?? null;
  return { name: decl[1], base };
}

/**
 * True when the masked source itself shows a test class: a [SysTestMethod] attribute,
 * or a class declaration that extends SysTestCase.
 */
export function isTestClassSource(masked: string): boolean {
  if (/\[[^\]]*\bSysTestMethod\b[^\]]*\]/.test(masked)) return true;
  return declaredClassAndBase(masked)?.base?.toLowerCase() === TEST_BASE;
}

/**
 * True when the index says the code belongs to a class that derives from SysTestCase.
 * Candidates: the declared class, its declared base, and the class named by
 * `context` ("ContosoRentTest" or "ContosoRentTest.setUp"). False when the index
 * cannot answer.
 */
export function isTestClassInIndex(db: DbLike, masked: string, context?: string): boolean {
  const decl = declaredClassAndBase(masked);
  const candidates = new Set<string>();
  if (decl) candidates.add(decl.name);
  if (decl?.base) {
    if (decl.base.toLowerCase() === TEST_BASE) return true;
    candidates.add(decl.base);
  }
  const owner = context?.split(/\.|::/)[0]?.trim();
  if (owner && /^\w+$/.test(owner)) candidates.add(owner);
  for (const name of candidates) {
    if (inheritanceAncestors(db, name).some(a => a.toLowerCase() === TEST_BASE)) return true;
  }
  return false;
}
