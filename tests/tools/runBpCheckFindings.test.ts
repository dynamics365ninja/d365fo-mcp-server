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
