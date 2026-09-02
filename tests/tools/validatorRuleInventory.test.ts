/**
 * The rule roster in the docs, pinned to the rule roster in the code.
 *
 * `docs/ARCHITECTURE.md` carried "40 static rules … + 4 data-driven" and an
 * explicit id list for months after the count was 50 — it had missed COC006,
 * BP005, DOC001, OP001, SET001, RPT101/102 and XML008–010, i.e. two entire
 * coverage waves. A stale roster is worse than none: it is the table a reader
 * consults to decide whether a check already exists, so the answer it gives
 * ("no such rule") sends them to write a duplicate.
 *
 * Nothing here asserts a NUMBER a human typed. Both sides are derived: the ids
 * from the validator source, the claim from the doc. Adding a rule and forgetting
 * the doc fails here, in the same PR, on a machine with no D365FO install.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const VALIDATOR = path.join(REPO_ROOT, 'src', 'tools', 'analysis', 'validateXpp.ts');
const ARCHITECTURE = path.join(REPO_ROOT, 'docs', 'ARCHITECTURE.md');

/**
 * Every rule id the validator can emit.
 *
 * Ids are string literals in this one file by construction, but they are written
 * two ways — an inline `{ rule: 'X', severity: 'y' }` object and a
 * `matchAll(masked, re, 'X', 'y', fix)` call — so matching the emission shape
 * finds only 40 of the 50. Matching the id SHAPE finds all of them and cannot
 * drift with a refactor of how a violation is constructed.
 */
function ruleIdsInValidator(): string[] {
  const src = fs.readFileSync(VALIDATOR, 'utf8');
  return [...new Set([...src.matchAll(/'([A-Z]{2,5}\d{3})'/g)].map(m => m[1]))].sort();
}

describe('validator rule inventory', () => {
  const ids = ruleIdsInValidator();

  it('finds a plausible roster', () => {
    // A guard on the guard: a refactor that moved rule ids out of this file would
    // otherwise make every assertion below vacuously true.
    expect(ids.length).toBeGreaterThan(30);
    expect(ids).toContain('SEL001');
    expect(ids).toContain('XML010');
  });

  it('ARCHITECTURE.md states the current rule count', () => {
    const doc = fs.readFileSync(ARCHITECTURE, 'utf8');
    const claimed = /\*\*(\d+)\s+rules\*\*/.exec(doc)?.[1];
    expect(claimed, 'ARCHITECTURE.md must state the rule count as "**N rules**"').toBeDefined();
    expect(Number(claimed)).toBe(ids.length);
  });

  it('ARCHITECTURE.md names every rule family the validator emits', () => {
    const doc = fs.readFileSync(ARCHITECTURE, 'utf8');
    // Families, not every id: the doc uses ranges (`SEL001–010`), and expanding
    // them here would just re-implement the range syntax. A family that is absent
    // entirely is the drift that actually happened.
    const families = [...new Set(ids.map(id => id.replace(/\d+$/, '')))].sort();
    const missing = families.filter(f => !doc.includes(f));
    expect(missing).toEqual([]);
  });
});
