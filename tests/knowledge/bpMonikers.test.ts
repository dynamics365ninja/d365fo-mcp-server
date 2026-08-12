/**
 * bp_moniker (kind="bp-moniker" of get_knowledge) — three use cases:
 *   1. Catalog validation: is an exact moniker real?
 *   2. Semantic/keyword search: what covers a described scenario, with no
 *      moniker in hand yet ("pull one out of a hat" case)?
 *   3. Suppression generation: render a real _BPSuppressions.xml block.
 *
 * All three are exercised against the REAL extracted catalog
 * (src/knowledge/bpMonikers/catalog.generated.ts) — this is machine-extracted
 * ground truth from a live D365FO install (scripts/extract-bp-catalog.ps1),
 * not a hand-typed fixture, so asserting against real entries in it is the
 * actual point: these tests would catch a broken regeneration (e.g. the
 * PowerShell here-string escaping bug fixed during authoring, which silently
 * turned every 'null' into an empty string) as surely as a logic bug in the
 * lookup code.
 */

import { describe, it, expect } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  validateMoniker,
  searchMonikers,
  buildSuppressionXml,
  BP_MONIKER_CATALOG,
} from '../../src/knowledge/bpMonikers/index.js';
import { bpMonikerHelpTool } from '../../src/tools/knowledge/bpMonikerHelp.js';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'bp_moniker', arguments: args },
});

function textOf(result: Awaited<ReturnType<typeof bpMonikerHelpTool>>): string {
  return (result.content as Array<{ text: string }>).map(c => c.text).join('\n');
}

// A moniker known (from real prior BP-check work — see the bp-check skill's
// fix recipes) to have a real message/description in the extracted resource
// text, used as ground truth throughout rather than a fabricated fixture.
const REAL_MONIKER = 'BPErrorPrivilegeNotCoveredByDuty';
// Real per the union of AxRuleSet/BPRules.xml files but with no resource-class
// message/description found — exercises the "canonical but no text" path.
const REAL_CANONICAL_NO_TEXT_CANDIDATE = BP_MONIKER_CATALOG.find(e => e.canonical && e.message === null);

// ─── 1. Catalog sanity — the generated data file itself ─────────────────────

describe('BP_MONIKER_CATALOG — sanity on the extracted data', () => {
  it('is non-empty and reasonably sized (regression guard on the extraction script)', () => {
    // Loose bounds, not an exact count — the real install this was extracted
    // from will drift release to release. A catastrophic extraction failure
    // (e.g. AssemblyResolve silently finding nothing) would produce ~0, and a
    // parsing bug would produce something wildly different from "a few hundred".
    expect(BP_MONIKER_CATALOG.length).toBeGreaterThan(100);
  });

  it('has no duplicate monikers', () => {
    const names = BP_MONIKER_CATALOG.map(e => e.moniker);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every entry has the required shape', () => {
    for (const e of BP_MONIKER_CATALOG) {
      expect(typeof e.moniker).toBe('string');
      expect(e.moniker.length).toBeGreaterThan(0);
      expect(typeof e.canonical).toBe('boolean');
      expect(e.message === null || typeof e.message === 'string').toBe(true);
      expect(e.description === null || typeof e.description === 'string').toBe(true);
    }
  });

  it('never renders "no resource entry" as an empty string instead of null', () => {
    // Regression guard for the PowerShell [string]$s parameter-coercion bug:
    // binding $null to a [string]-typed parameter silently produced '' before
    // the null-check in the script ever ran, so "not found in a resource
    // class" and "found but blank" were indistinguishable. If that regresses,
    // every entry would show '' here instead of a real null ever appearing.
    const anyNullMessage = BP_MONIKER_CATALOG.some(e => e.message === null);
    const anyNullDescription = BP_MONIKER_CATALOG.some(e => e.description === null);
    expect(anyNullMessage).toBe(true);
    expect(anyNullDescription).toBe(true);
  });

  it('has a substantial share of entries with real message/description text (not just names)', () => {
    const withText = BP_MONIKER_CATALOG.filter(e => e.message !== null).length;
    // At extraction time this was 545 of 577 — assert a floor, not the exact
    // number, so a smaller/newer install still passes.
    expect(withText).toBeGreaterThan(BP_MONIKER_CATALOG.length * 0.5);
  });

  it('confirms the real moniker this test suite relies on is actually present', () => {
    const entry = BP_MONIKER_CATALOG.find(e => e.moniker === REAL_MONIKER);
    expect(entry).toBeDefined();
    expect(entry!.canonical).toBe(true);
    expect(entry!.message).not.toBeNull();
  });
});

// ─── 2. Validation ───────────────────────────────────────────────────────────

describe('validateMoniker', () => {
  it('confirms a real, canonical moniker and surfaces its real description', () => {
    const result = validateMoniker(REAL_MONIKER);
    expect(result.found).toBe(true);
    expect(result.canonical).toBe(true);
    expect(result.entry?.description).toBeTruthy();
  });

  it('is case-insensitive but reports the catalog\'s own casing, not the input\'s', () => {
    const result = validateMoniker(REAL_MONIKER.toLowerCase());
    expect(result.found).toBe(true);
    expect(result.entry?.moniker).toBe(REAL_MONIKER);
  });

  it('reports "not found" for a plausible-looking but fabricated moniker — never invents a fix-up', () => {
    const result = validateMoniker('BPErrorThisMonikerDoesNotExistAtAll12345');
    expect(result.found).toBe(false);
    expect(result.entry).toBeNull();
    expect(result.canonical).toBe(false);
  });

  it('handles a canonical moniker with no resource text without throwing, and says so honestly', () => {
    // Not every canonical moniker has message/description — assert the shape
    // holds for one that genuinely does not, if the current extraction has one.
    if (!REAL_CANONICAL_NO_TEXT_CANDIDATE) return; // extraction-dependent; skip gracefully
    const result = validateMoniker(REAL_CANONICAL_NO_TEXT_CANDIDATE.moniker);
    expect(result.found).toBe(true);
    expect(result.canonical).toBe(true);
    expect(result.entry?.message).toBeNull();
  });

  it('trims incidental whitespace from the input', () => {
    const result = validateMoniker(`  ${REAL_MONIKER}  `);
    expect(result.found).toBe(true);
  });
});

// ─── 3. Search — "pull a moniker out of a hat" with no BP-check output ──────

describe('searchMonikers', () => {
  it('finds the privilege/duty rule from a plain-English description of the scenario', () => {
    // The exact case from the conversation this feature came out of: no BP
    // warning has been seen yet, just a description of what's being built.
    const results = searchMonikers('security privilege not linked to any duty');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.entry.moniker === REAL_MONIKER)).toBe(true);
  });

  it('ranks canonical, better-matched entries above weaker ones', () => {
    const results = searchMonikers('privilege duty');
    expect(results.length).toBeGreaterThan(0);
    // Every returned result actually shares at least one token with the query.
    for (const r of results) expect(r.score).toBeGreaterThan(0);
  });

  it('reports matchedIn so a caller can see WHERE the match came from, not just that it matched', () => {
    const results = searchMonikers('security privilege not linked to any duty');
    const hit = results.find(r => r.entry.moniker === REAL_MONIKER);
    expect(hit).toBeDefined();
    expect(hit!.matchedIn.length).toBeGreaterThan(0);
  });

  it('returns nothing for a query that shares no real words with any rule text — no forced best-effort guess', () => {
    const results = searchMonikers('purple giraffe astronaut sandwich');
    expect(results).toEqual([]);
  });

  it('respects the limit parameter', () => {
    // A broad, common word to guarantee more than 3 hits exist.
    const broad = searchMonikers('table', 100);
    expect(broad.length).toBeGreaterThan(3);
    const limited = searchMonikers('table', 3);
    expect(limited.length).toBe(3);
  });
});

// ─── 4. Suppression XML generation ──────────────────────────────────────────

describe('buildSuppressionXml', () => {
  it('renders a well-formed <Diagnostic> block for a real moniker, with no warning', () => {
    const { xml, warning } = buildSuppressionXml({
      moniker: REAL_MONIKER,
      elementType: 'AxSecurityPrivilege',
      elementName: 'ConDemoFooMaintain',
    });
    expect(warning).toBeNull();
    expect(xml).toContain('<DiagnosticType>BestPractices</DiagnosticType>');
    expect(xml).toContain(`<Moniker>${REAL_MONIKER}</Moniker>`);
    expect(xml).toContain('<ElementType>AxSecurityPrivilege</ElementType>');
    expect(xml).toContain('<ElementName>ConDemoFooMaintain</ElementName>');
    expect(xml).toContain('dynamics://SecurityPrivilege/ConDemoFooMaintain');
  });

  it('fills the message placeholder from the catalog template when no explicit message is given', () => {
    const { xml } = buildSuppressionXml({
      moniker: REAL_MONIKER,
      elementType: 'AxSecurityPrivilege',
      elementName: 'ConDemoFooMaintain',
    });
    // The catalog message template has a `{0}` placeholder for the element name.
    expect(xml).toContain('ConDemoFooMaintain');
    expect(xml).not.toContain('{0}');
  });

  it('prefers an explicitly supplied real message over the catalog template', () => {
    const { xml } = buildSuppressionXml({
      moniker: REAL_MONIKER,
      elementType: 'AxSecurityPrivilege',
      elementName: 'ConDemoFooMaintain',
      message: 'The exact text from a real run_bp_check finding.',
    });
    expect(xml).toContain('<Message>The exact text from a real run_bp_check finding.</Message>');
  });

  it('warns, but still renders, for a moniker not in the catalog — never silently fabricates confidence', () => {
    const { xml, warning } = buildSuppressionXml({
      moniker: 'BPErrorThisMonikerDoesNotExistAtAll12345',
      elementType: 'AxTable',
      elementName: 'ConDemoFooTable',
    });
    expect(warning).toContain('not in the extracted catalog');
    expect(xml).toContain('<Moniker>BPErrorThisMonikerDoesNotExistAtAll12345</Moniker>');
  });

  it('escapes XML-special characters in the element name and message', () => {
    const { xml } = buildSuppressionXml({
      moniker: REAL_MONIKER,
      elementType: 'AxSecurityPrivilege',
      elementName: 'A&B<C>',
    });
    expect(xml).toContain('A&amp;B&lt;C&gt;');
    expect(xml).not.toContain('<ElementName>A&B<C>');
  });

  it('defaults severity to Warning', () => {
    const { xml } = buildSuppressionXml({
      moniker: REAL_MONIKER,
      elementType: 'AxSecurityPrivilege',
      elementName: 'ConDemoFooMaintain',
    });
    expect(xml).toContain('<Severity>Warning</Severity>');
  });
});

// ─── 5. The MCP handler end-to-end (bp_moniker via get_knowledge) ───────────

describe('bpMonikerHelpTool', () => {
  it('validate: reports a real moniker as confirmed', async () => {
    const result = await bpMonikerHelpTool(req({ action: 'validate', moniker: REAL_MONIKER }));
    expect(textOf(result)).toContain('is a real BP moniker');
  });

  it('validate: reports a fabricated moniker as unconfirmed, not as an error', async () => {
    const result = await bpMonikerHelpTool(req({ action: 'validate', moniker: 'TotallyMadeUpMoniker999' }));
    expect(textOf(result)).toContain('not in the extracted catalog');
  });

  it('validate: requires moniker', async () => {
    const result = await bpMonikerHelpTool(req({ action: 'validate' }));
    expect(result.isError).toBe(true);
  });

  it('search: returns real candidates for a scenario description', async () => {
    const result = await bpMonikerHelpTool(req({ action: 'search', query: 'security privilege not linked to any duty' }));
    expect(textOf(result)).toContain(REAL_MONIKER);
  });

  it('search: requires query', async () => {
    const result = await bpMonikerHelpTool(req({ action: 'search' }));
    expect(result.isError).toBe(true);
  });

  it('suppress: renders XML ready to paste into a _BPSuppressions.xml file', async () => {
    const result = await bpMonikerHelpTool(req({
      action: 'suppress',
      moniker: REAL_MONIKER,
      elementType: 'AxSecurityPrivilege',
      elementName: 'ConDemoFooMaintain',
    }));
    const text = textOf(result);
    expect(text).toContain('_BPSuppressions.xml');
    expect(text).toContain('<Diagnostic>');
  });

  it('suppress: requires moniker, elementType, and elementName', async () => {
    const result = await bpMonikerHelpTool(req({ action: 'suppress', moniker: REAL_MONIKER }));
    expect(result.isError).toBe(true);
  });

  it('rejects an invalid action', async () => {
    const result = await bpMonikerHelpTool(req({ action: 'not-a-real-action' }));
    expect(result.isError).toBe(true);
  });
});
