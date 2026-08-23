/**
 * parseBpFindings / renderFindingsSection — turning xppbp's plain-text output
 * into structured, catalog-cross-referenced findings so the moniker is a field
 * to read, not a name to eyeball off the raw log (the actual pain point this
 * feature was built for).
 *
 * Sample lines below match the real shape captured in tests/tools/runBpCheck.test.ts
 * (`<Moniker>: <path>`), not an invented format.
 */

import { describe, it, expect } from 'vitest';
import { parseBpFindings, renderFindingsSection } from '../../src/tools/sdlc/runBpCheck.js';
import { BP_MONIKER_CATALOG } from '../../src/knowledge/bpMonikers/index.js';

// Real per the extracted catalog (see tests/knowledge/bpMonikers.test.ts for
// why this specific one is used as ground truth throughout).
const REAL_MONIKER = 'BPErrorPrivilegeNotCoveredByDuty';

describe('parseBpFindings', () => {
  it('extracts moniker and target from real xppbp plain-text output', () => {
    const output =
      'BPErrorTableMissingFormRef: K:\\Pkg\\Contoso\\Contoso\\AxTable\\ConDemoTicket.xml\n' +
      'BPErrorTableFieldGroupEmpty: K:\\Pkg\\Contoso\\Contoso\\AxTable\\ConDemoLine.xml\n';
    const findings = parseBpFindings(output);
    expect(findings).toHaveLength(2);
    expect(findings[0].moniker).toBe('BPErrorTableMissingFormRef');
    expect(findings[0].target).toBe('K:\\Pkg\\Contoso\\Contoso\\AxTable\\ConDemoTicket.xml');
    expect(findings[1].moniker).toBe('BPErrorTableFieldGroupEmpty');
  });

  it('cross-references a real moniker against the catalog and fills in its description', () => {
    const findings = parseBpFindings(`${REAL_MONIKER}: dynamics://SecurityPrivilege/ConDemoFooMaintain`);
    expect(findings).toHaveLength(1);
    expect(findings[0].knownMoniker).toBe(true);
    expect(findings[0].description).toBeTruthy();
  });

  it('flags a moniker not in the catalog as unknown, without dropping it from the results', () => {
    const findings = parseBpFindings('BPErrorTotallyMadeUpForThisTest999: some/path.xml');
    expect(findings).toHaveLength(1);
    expect(findings[0].knownMoniker).toBe(false);
    expect(findings[0].description).toBeNull();
  });

  it('treats a bare severity prefix as unnamed, not as an unknown moniker', () => {
    // Real captured sample from tests/tools/runBpCheck.test.ts. 'BPError' is a
    // severity prefix, not a rule name — reading it as a moniker put a "verify
    // the spelling" flag on output the compiler itself had just emitted.
    const findings = parseBpFindings('BPError: LocalVariableNotUsed\nErrors: 1');
    expect(findings).toHaveLength(1);
    expect(findings[0].moniker).toBeNull();
    expect(findings[0].target).toBe('LocalVariableNotUsed');
    expect(renderFindingsSection('BPError: LocalVariableNotUsed')).not.toContain('verify the spelling');
  });

  it('ignores non-finding lines (banners, summary counts, blank lines)', () => {
    const output =
      'X++ Best Practice Check\n' +
      '\n' +
      `${REAL_MONIKER}: dynamics://SecurityPrivilege/ConDemoFooMaintain\n` +
      'Errors: 0\n' +
      'Warnings: 1\n';
    const findings = parseBpFindings(output);
    expect(findings).toHaveLength(1);
    expect(findings[0].moniker).toBe(REAL_MONIKER);
  });

  it('returns an empty array for clean output with no findings', () => {
    expect(parseBpFindings('X++ Best Practice Check\nErrors: 0\nWarnings: 0\n')).toEqual([]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseBpFindings('')).toEqual([]);
  });

  it('handles multiple findings for the same moniker on different objects', () => {
    const output =
      `${REAL_MONIKER}: dynamics://SecurityPrivilege/ConDemoFooMaintain\n` +
      `${REAL_MONIKER}: dynamics://SecurityPrivilege/ConDemoBarMaintain\n`;
    const findings = parseBpFindings(output);
    expect(findings).toHaveLength(2);
    expect(findings.every(f => f.moniker === REAL_MONIKER)).toBe(true);
  });
});

describe('renderFindingsSection', () => {
  it('is empty for output with no findings — adds nothing to a clean result', () => {
    expect(renderFindingsSection('Errors: 0\nWarnings: 0\n')).toBe('');
  });

  it('lists each finding with its real description and the target it was raised against', () => {
    const output = `${REAL_MONIKER}: dynamics://SecurityPrivilege/ConDemoFooMaintain\n`;
    const section = renderFindingsSection(output);
    expect(section).toContain(REAL_MONIKER);
    expect(section).toContain('ConDemoFooMaintain');
    expect(section).toContain(String(BP_MONIKER_CATALOG.length));
  });

  it('flags an unrecognised moniker inline rather than silently passing it through', () => {
    const section = renderFindingsSection('BPErrorTotallyMadeUpForThisTest999: some/path.xml');
    expect(section).toContain('not in the extracted moniker catalog');
  });
});

/**
 * The DETAIL line shape — the one this parser used to skip.
 *
 * `FINDING_LINE` anchors `BP…:` at the start of a line, so a finding printed as
 * `BestPractices Warning: AxClass dynamics://…: BPMoniker: message` matched
 * nothing. What DID match was xppbp's per-moniker tally (`BPMoniker: 1`), so the
 * structured section reported a rule name and a COUNT and silently dropped the
 * severity, element type, source position, message — and the `dynamics://` path,
 * which is the single value `add-diagnostic-suppression` needs verbatim as
 * `diagnosticPath`. Suppressing a finding therefore meant reading the path out
 * of the raw log by eye.
 *
 * The shape was known (a comment in the module named it) but deliberately left
 * unmatched, because no captured sample existed and a guessed regex can misread
 * lines that are not findings at all. The sample below is verbatim from a live
 * run — eval case L2-bp-suppression-lifecycle, 2026-08-23.
 */
describe('parseBpFindings — detail lines', () => {
  const DETAIL =
    "BestPractices Warning: AxClass dynamics://Class/ConDemoSuppressProbe/Method/run: " +
    "[(6,5),(8,6)]: BPXmlDocNoDocumentationComments: No XML documentation headers are " +
    "provided for 'ConDemoSuppressProbe.run'.";

  it('extracts every field, keeping the dynamics:// path intact', () => {
    const [f] = parseBpFindings(DETAIL);
    expect(f.moniker).toBe('BPXmlDocNoDocumentationComments');
    expect(f.severity).toBe('Warning');
    expect(f.elementType).toBe('AxClass');
    // The path carries colons of its own — the reason the locus is split
    // separately instead of being delimited by one.
    expect(f.path).toBe('dynamics://Class/ConDemoSuppressProbe/Method/run');
    expect(f.position).toBe('[(6,5),(8,6)]');
    expect(f.message).toBe("No XML documentation headers are provided for 'ConDemoSuppressProbe.run'.");
    expect(f.knownMoniker).toBe(true);
  });

  it('drops the per-moniker tally line once the detail is in hand', () => {
    // Both are printed by the same run; keeping both reports one finding twice,
    // the second time as a bare number.
    const findings = parseBpFindings(`${DETAIL}
BPXmlDocNoDocumentationComments: 1`);
    expect(findings).toHaveLength(1);
    expect(findings[0].path).toBeDefined();
  });

  it('keeps a tally-shaped line when NO detail line reported that moniker', () => {
    const findings = parseBpFindings('BPErrorTableMissingFormRef: 3');
    expect(findings).toHaveLength(1);
    expect(findings[0].target).toBe('3');
  });

  it('leaves the terse shapes parsing exactly as before', () => {
    const findings = parseBpFindings(
      ['BPErrorTableMissingFormRef: K:\\Pkg\\Model\\ConDemoTicket.xml', 'BPError: LocalVariableNotUsed'].join('\n'),
    );
    expect(findings).toHaveLength(2);
    expect(findings[0].moniker).toBe('BPErrorTableMissingFormRef');
    expect(findings[1].moniker).toBeNull();
  });

  it('ignores prose that merely mentions Best Practices', () => {
    // The guard the module refused to guess at: a regex loose enough to catch
    // the detail shape must not turn banner lines into findings.
    expect(parseBpFindings('Starting Best Practices check...')).toHaveLength(0);
    expect(parseBpFindings('BestPractices check completed.')).toHaveLength(0);
  });

  it('labels the path on its own line so it can be copied into a suppression', () => {
    const section = renderFindingsSection(DETAIL);
    expect(section).toContain('path: dynamics://Class/ConDemoSuppressProbe/Method/run');
    expect(section).toContain('Warning AxClass [(6,5),(8,6)]');
  });
});

/**
 * data-entity had no row in the translation table, so it fell through to the
 * generic squash and reached xppbp as `dataentity`, which it rejects. The
 * recovery hint then advised "use the kebab-case objectType the other tools
 * take" — which is exactly what the caller had passed. Circular and
 * unactionable. Eval case L2-entity-query-range-roundtrip, 2026-08-23;
 * `DataEntityView` confirmed live.
 */
describe('run_bp_check — data-entity element type', () => {
  it('translates data-entity to the token xppbp accepts', async () => {
    const { normalizeElementType } = await import('../../src/tools/sdlc/runBpCheck');
    expect(normalizeElementType('data-entity')).toBe('dataentityview');
    expect(normalizeElementType('DataEntityView')).toBe('dataentityview');
  });

  it('names the translatable set instead of repeating the advice back', async () => {
    const { describeNonRun } = await import('../../src/tools/sdlc/runBpCheck');
    const hint = describeNonRun("The element type 'aggregatemeasurement' is invalid");
    expect(hint).toContain('aggregatemeasurement');
    expect(hint).toContain('data-entity');
    expect(hint).toContain('targetElementType');
    expect(hint).not.toContain('and it will be translated');
  });
});
