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

  it('offers word-overlap suggestions on a miss instead of dead-ending', () => {
    // The failure this catalog exists for: a name close to the real one, typed
    // from memory. `found` must stay false — the suggestion is a candidate to
    // confirm, never a correction applied on the caller's behalf.
    const result = validateMoniker('BPErrorPrivilegeNotCoveredByDuties');
    expect(result.found).toBe(false);
    expect(result.suggestions).toContain(REAL_MONIKER);
  });

  it('returns no suggestions when the input shares no words with any rule', () => {
    expect(validateMoniker('PurpleGiraffeAstronaut').suggestions).toEqual([]);
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
  // Measured, not assumed. Every <Diagnostic> in all 299 AxIgnoreDiagnosticList
  // files of a 10.0 PackagesLocalDirectory was parsed; among the 1,447
  // BestPractices entries carrying both <ElementType> and <Path>, the path
  // segment was the type name minus its 'Ax' prefix in 1,447 of 1,447 cases.
  // The pairs below are a sample of that observed set. Plural forms such as
  // 'Classes' or 'ExtendedDataTypes' occur in zero real entries.
  const REAL_TYPE_TO_SEGMENT = [
    ['AxClass', 'Class'],
    ['AxTable', 'Table'],
    ['AxForm', 'Form'],
    ['AxView', 'View'],
    ['AxEnum', 'Enum'],
    ['AxDataEntityView', 'DataEntityView'],
    ['AxSecurityPrivilege', 'SecurityPrivilege'],
    ['AxSecurityDuty', 'SecurityDuty'],
    ['AxTableExtension', 'TableExtension'],
    ['AxFormExtension', 'FormExtension'],
    ['AxEdtString', 'EdtString'],
    ['AxMenuItemDisplay', 'MenuItemDisplay'],
    ['AxAggregateMeasurement', 'AggregateMeasurement'],
    ['AxConfigurationKey', 'ConfigurationKey'],
  ] as const;

  it.each(REAL_TYPE_TO_SEGMENT)('derives the real dynamics:// segment for %s', (elementType, segment) => {
    const { xml } = buildSuppressionXml({ moniker: REAL_MONIKER, elementType, elementName: 'ConDemoFoo' });
    expect(xml).toContain(`<Path>dynamics://${segment}/ConDemoFoo</Path>`);
  });

  it('never emits a pluralised segment — the shape that silently suppresses nothing', () => {
    const plurals = ['Classes', 'Tables', 'Forms', 'Views', 'Enums', 'ExtendedDataTypes', 'DataEntityViews', 'Queries', 'Reports'];
    for (const [elementType] of REAL_TYPE_TO_SEGMENT) {
      const { xml } = buildSuppressionXml({ moniker: REAL_MONIKER, elementType, elementName: 'ConDemoFoo' });
      const path = xml.split('\n').find(l => l.includes('<Path>'))!;
      for (const wrong of plurals) expect(path).not.toContain(`dynamics://${wrong}/`);
    }
  });

  it("renders the elements Microsoft's own template lists, in real-file order", () => {
    const { xml, errors } = buildSuppressionXml({
      moniker: REAL_MONIKER,
      elementType: 'AxSecurityPrivilege',
      elementName: 'ConDemoFooMaintain',
      justification: 'Covered by the SystemUser role in a downstream model.',
    });
    expect(errors).toEqual([]);
    // The template comment at the top of every real *_BPSuppressions.xml lists
    // exactly these five, in this order.
    const order = ['<DiagnosticType>', '<Severity>', '<Path>', '<Moniker>', '<Justification>'];
    const positions = order.map(t => xml.indexOf(t));
    expect(positions.every(p => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('takes a verbatim path — the only way to address a sub-element', () => {
    // Real shape, copied from ApplicationFoundation_BPSuppressions.xml.
    const path = 'dynamics://Enum/SRSReportPrintOrientation/EnumValue/Potrait?Value';
    const { xml, errors } = buildSuppressionXml({ moniker: REAL_MONIKER, path, justification: 'x' });
    expect(errors).toEqual([]);
    expect(xml).toContain(`<Path>${path}</Path>`);
  });

  it('rejects a path that is not a dynamics:// URI rather than emitting it', () => {
    const { errors } = buildSuppressionXml({ moniker: REAL_MONIKER, path: 'Classes/Foo', justification: 'x' });
    expect(errors.join(' ')).toContain("must start with 'dynamics://'");
  });

  it('errors when neither a path nor an elementType+elementName is given', () => {
    const { errors } = buildSuppressionXml({ moniker: REAL_MONIKER });
    expect(errors.join(' ')).toContain('Need either');
  });

  it('always emits a <Justification>, and warns when the caller did not supply one', () => {
    // 10,384 of 10,915 real BestPractices entries carry one; a blank reason is
    // what a reviewer rejects, so it is never silently omitted.
    const { xml, warnings } = buildSuppressionXml({
      moniker: REAL_MONIKER, elementType: 'AxSecurityPrivilege', elementName: 'ConDemoFooMaintain',
    });
    expect(xml).toContain('<Justification>');
    expect(xml).toContain('TODO');
    expect(warnings.join(' ')).toContain('No justification given');
  });

  it("uses the caller's justification verbatim and drops the warning", () => {
    const { xml, warnings } = buildSuppressionXml({
      moniker: REAL_MONIKER, elementType: 'AxSecurityPrivilege', elementName: 'ConDemoFooMaintain',
      justification: 'Privilege is granted through the SystemUser role.',
    });
    expect(xml).toContain('<Justification>Privilege is granted through the SystemUser role.</Justification>');
    expect(warnings.join(' ')).not.toContain('No justification');
  });

  it('omits <ItemSpecific> by default and adds it only on request', () => {
    // Only 999 of 10,915 real entries carry it — it is the exception.
    const base = { moniker: REAL_MONIKER, elementType: 'AxSecurityPrivilege' as const, elementName: 'ConDemoFooMaintain', justification: 'x' };
    expect(buildSuppressionXml(base).xml).not.toContain('<ItemSpecific>');
    const opted = buildSuppressionXml({ ...base, itemSpecific: true });
    expect(opted.xml).toContain('<ItemSpecific>');
    expect(opted.xml).toContain('<ElementName>ConDemoFooMaintain</ElementName>');
  });

  it('fills a single-placeholder catalog template with the element name', () => {
    const { xml } = buildSuppressionXml({
      moniker: REAL_MONIKER, elementType: 'AxSecurityPrivilege', elementName: 'ConDemoFooMaintain', justification: 'x',
    });
    expect(xml).toContain('ConDemoFooMaintain');
    expect(xml).not.toContain('{0}');
  });

  it('emits no <Message> when the template needs more than one distinct value', () => {
    // 'BPCheckCodeRefactoring' reads "Number of Lines found in class method {0}
    // is greater than {2} within class {1}". Substituting the element name into
    // all three produced "greater than MyClass within class MyClass" — an
    // invented sentence. <Message> is absent from 57% of real entries anyway.
    const multi = BP_MONIKER_CATALOG.find(e => new Set(e.message?.match(/\{\d+\}/g) ?? []).size > 1);
    expect(multi).toBeDefined();
    const { xml } = buildSuppressionXml({
      moniker: multi!.moniker, elementType: 'AxClass', elementName: 'ConDemoFooClass', justification: 'x',
    });
    expect(xml).not.toContain('<Message>');
  });

  it('prefers an explicitly supplied real message over the catalog template', () => {
    const { xml } = buildSuppressionXml({
      moniker: REAL_MONIKER, elementType: 'AxSecurityPrivilege', elementName: 'ConDemoFooMaintain',
      message: 'The exact text from a real run_bp_check finding.', justification: 'x',
    });
    expect(xml).toContain('<Message>The exact text from a real run_bp_check finding.</Message>');
  });

  it('warns, but still renders, for a moniker not in the catalog — never silently fabricates confidence', () => {
    const { xml, warnings } = buildSuppressionXml({
      moniker: 'BPErrorThisMonikerDoesNotExistAtAll12345',
      elementType: 'AxTable',
      elementName: 'ConDemoFooTable',
      justification: 'x',
    });
    expect(warnings.join(' ')).toContain('not in the extracted catalog');
    expect(xml).toContain('<Moniker>BPErrorThisMonikerDoesNotExistAtAll12345</Moniker>');
  });

  it('escapes XML-special characters in the element name and message', () => {
    const { xml } = buildSuppressionXml({
      moniker: REAL_MONIKER, elementType: 'AxSecurityPrivilege', elementName: 'A&B<C>',
      justification: 'x', itemSpecific: true,
    });
    expect(xml).toContain('A&amp;B&lt;C&gt;');
    expect(xml).not.toContain('<ElementName>A&B<C>');
  });

  it('defaults severity to Warning', () => {
    const { xml } = buildSuppressionXml({
      moniker: REAL_MONIKER, elementType: 'AxSecurityPrivilege', elementName: 'ConDemoFooMaintain', justification: 'x',
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

  it('validate: does NOT call a resource-only string a real BP moniker', async () => {
    // The rule DLLs also carry upgrade- and form-conversion-tool messages.
    // Checked against this VM's ApplicationPlatform/AxRuleSet/BPRules.xml:
    // 'DECReplaceCode' and friends appear in no rule set, so a ✅ there would
    // be exactly the false confirmation this catalog exists to prevent.
    const resourceOnly = BP_MONIKER_CATALOG.find(e => !e.canonical);
    expect(resourceOnly).toBeDefined();
    const text = textOf(await bpMonikerHelpTool(req({ action: 'validate', moniker: resourceOnly!.moniker })));
    expect(text).not.toContain('✅');
    expect(text).toContain('not confirmed as a BP rule');
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

  it('suppress: requires either a path or elementType+elementName', async () => {
    const result = await bpMonikerHelpTool(req({ action: 'suppress', moniker: REAL_MONIKER }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('`path`');
  });

  it('suppress: accepts a verbatim path with no elementType', async () => {
    const result = await bpMonikerHelpTool(req({
      action: 'suppress',
      moniker: REAL_MONIKER,
      path: 'dynamics://SecurityPrivilege/ConDemoFooMaintain',
      justification: 'Granted via SystemUser.',
    }));
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('<Path>dynamics://SecurityPrivilege/ConDemoFooMaintain</Path>');
  });

  it('rejects an invalid action', async () => {
    const result = await bpMonikerHelpTool(req({ action: 'not-a-real-action' }));
    expect(result.isError).toBe(true);
  });
});
