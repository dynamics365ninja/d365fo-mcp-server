/**
 * The intrinsic catalog is GENERATED, and this pins that it stays so (G-09).
 *
 * A hand-written list of 80 names is wrong the moment the platform adds one, and
 * nothing notices — a knowledge entry has no build to fail and no test unless
 * someone writes it. So the `intrinsic-functions` entry builds its catalog line
 * from `XPP_INTRINSICS`, captured from the running compiler by reflection
 * (scripts/capture-compiler-facts.ts).
 *
 * What this file is really defending: the failure mode where someone "tidies"
 * the generated line into prose. That change looks harmless in review and
 * silently freezes the catalog at whatever the platform shipped that week.
 */

import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_BASE } from '../../src/tools/knowledge/xppKnowledge';
import { XPP_INTRINSICS, COMPILER_VERSION } from '../../src/knowledge/compilerFacts.generated';

const entry = KNOWLEDGE_BASE.find(e => e.id === 'intrinsic-functions');
const catalogRule = entry?.rules.find(r => r.includes('The complete catalog is'));

describe('intrinsic-functions carries a generated catalog', () => {
  it('has the catalog rule at all', () => {
    expect(entry).toBeDefined();
    expect(catalogRule).toBeDefined();
  });

  it('states the count the compiler table actually holds', () => {
    const count = Object.keys(XPP_INTRINSICS).length;
    expect(catalogRule).toContain(`${count} intrinsics`);
    // Not a magic number in prose: if the table grows, the line grows with it.
    expect(count).toBeGreaterThan(50);
  });

  it('names the compiler build it was captured from', () => {
    expect(catalogRule).toContain(COMPILER_VERSION);
  });

  it('lists EVERY intrinsic in the table, none invented', () => {
    const listed = new Set(
      (catalogRule ?? '')
        .split('argument')
        .join(' ')
        .split(/[\s,·:]+/)
        .filter(t => /^[a-zA-Z]\w*$/.test(t)),
    );
    const missing = Object.keys(XPP_INTRINSICS).filter(n => !listed.has(n));
    expect(missing).toEqual([]);
  });

  it('groups by arity, because that is the mistake FN001 exists for', () => {
    // ssrsReportStr takes two; the one-argument call is the classic error.
    expect(XPP_INTRINSICS.ssrsReportStr).toBe(2);
    expect(catalogRule).toContain('2 arguments');
    expect(catalogRule).toContain('1 argument:');
  });

  it('separates the zero-argument constants from the metadata assertions', () => {
    // maxInt/minInt/maxDate are in the compiler's intrinsic table but assert no
    // metadata, and calling them "intrinsics" alongside tableStr misleads.
    const zeroArg = Object.entries(XPP_INTRINSICS).filter(([, a]) => a === 0).map(([n]) => n);
    expect(zeroArg.length).toBeGreaterThan(0);
    expect(catalogRule).toContain('compile-time constants, not metadata assertions');
  });
});
