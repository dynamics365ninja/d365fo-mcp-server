/**
 * Removal of <Diagnostic> suppressions from a model's suppression list
 * ({Model}_BPSuppressions.xml, in the AxIgnoreDiagnosticList metadata folder).
 *
 * Fixture shape (root <IgnoreDiagnostics>, <Name>/<Items> as its direct
 * children, <Diagnostic> as a direct child of <Items>) matches a real
 * production suppression file, not the folder name — see
 * ignoreDiagnosticListXml.ts's docblock for why that distinction matters.
 *
 * Mirrors tests/tools/securityPrivilegeXml.test.ts's removeSecurityEntryPoint
 * coverage: both mutate a flat list of sibling blocks by regex-scan-and-splice,
 * both refuse an ambiguous match rather than guessing, both collapse an emptied
 * collection to the self-closing spelling.
 */

import { describe, it, expect } from 'vitest';
import {
  removeDiagnosticSuppression,
  removeDiagnosticSuppressionsByPathPrefix,
  addDiagnosticSuppression,
  emptySuppressionListXml,
} from '../../src/utils/ignoreDiagnosticListXml';

function diagnostic(path: string, moniker: string, extra = ''): string {
  return (
    `\t\t<Diagnostic>\n` +
    `\t\t\t<DiagnosticType>BestPractices</DiagnosticType>\n` +
    `\t\t\t<Severity>Warning</Severity>\n` +
    `\t\t\t<Path>${path}</Path>\n` +
    `\t\t\t<Moniker>${moniker}</Moniker>\n` +
    extra +
    `\t\t\t<Justification>TODO</Justification>\n` +
    `\t\t</Diagnostic>\n`
  );
}

function suppressionFile(items: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<IgnoreDiagnostics>\n` +
    `\t<Name>ConDemo_BPSuppressions</Name>\n` +
    `\t<Items>\n${items}\t</Items>\n` +
    `</IgnoreDiagnostics>`
  );
}

const TWO_DIAGNOSTICS = suppressionFile(
  diagnostic('dynamics://Form/ConDemoTicketTable', 'BPErrorGridCaption') +
  diagnostic('dynamics://SecurityPrivilege/ConDemoTicketMaintain', 'BPErrorPrivilegeNotCoveredByDuty'),
);

describe('removeDiagnosticSuppression', () => {
  it('removes the diagnostic identified by exact <Path>', () => {
    const result = removeDiagnosticSuppression(TWO_DIAGNOSTICS, { path: 'dynamics://Form/ConDemoTicketTable' });
    expect(result.kind).toBe('removed');
    if (result.kind !== 'removed') return;

    expect(result.removed).toEqual({
      path: 'dynamics://Form/ConDemoTicketTable',
      moniker: 'BPErrorGridCaption',
    });
    expect(result.xml).not.toContain('BPErrorGridCaption');
    // The other diagnostic survives whole.
    expect(result.xml).toContain('dynamics://SecurityPrivilege/ConDemoTicketMaintain');
    expect(result.xml).toContain('BPErrorPrivilegeNotCoveredByDuty');
  });

  it('matches case-insensitively', () => {
    const result = removeDiagnosticSuppression(TWO_DIAGNOSTICS, { path: 'DYNAMICS://FORM/CONDEMOTICKETTABLE' });
    expect(result.kind).toBe('removed');
  });

  it('refuses a path that carries two diagnostics, without a moniker to narrow it', () => {
    const twoOnSamePath = suppressionFile(
      diagnostic('dynamics://Form/ConDemoTicketTable', 'BPErrorGridCaption') +
      diagnostic('dynamics://Form/ConDemoTicketTable', 'BPXmlDocMissingSummary'),
    );
    const result = removeDiagnosticSuppression(twoOnSamePath, { path: 'dynamics://Form/ConDemoTicketTable' });
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.matches.map(m => m.moniker)).toEqual(['BPErrorGridCaption', 'BPXmlDocMissingSummary']);
  });

  it('resolves the ambiguous case when moniker narrows it to one', () => {
    const twoOnSamePath = suppressionFile(
      diagnostic('dynamics://Form/ConDemoTicketTable', 'BPErrorGridCaption') +
      diagnostic('dynamics://Form/ConDemoTicketTable', 'BPXmlDocMissingSummary'),
    );
    const result = removeDiagnosticSuppression(twoOnSamePath, {
      path: 'dynamics://Form/ConDemoTicketTable',
      moniker: 'BPXmlDocMissingSummary',
    });
    expect(result.kind).toBe('removed');
    if (result.kind !== 'removed') return;
    expect(result.xml).toContain('BPErrorGridCaption');
    expect(result.xml).not.toContain('BPXmlDocMissingSummary');
  });

  it('collapses <Items> when the last diagnostic goes', () => {
    const one = suppressionFile(diagnostic('dynamics://Form/ConDemoTicketTable', 'BPErrorGridCaption'));
    const result = removeDiagnosticSuppression(one, { path: 'dynamics://Form/ConDemoTicketTable' });
    expect(result.kind).toBe('removed');
    if (result.kind !== 'removed') return;
    expect(result.xml).toContain('<Items />');
    expect(result.xml).not.toContain('<Diagnostic>');
  });

  it('reports not-found with the suppressions that ARE there', () => {
    const result = removeDiagnosticSuppression(TWO_DIAGNOSTICS, { path: 'dynamics://Table/NoSuchTable' });
    expect(result.kind).toBe('not-found');
    if (result.kind !== 'not-found') return;
    expect(result.present).toHaveLength(2);
  });

  it('reports not-found on a file with no suppressions at all', () => {
    const bare = suppressionFile('');
    const result = removeDiagnosticSuppression(bare, { path: 'dynamics://Form/Anything' });
    expect(result.kind).toBe('not-found');
    if (result.kind !== 'not-found') return;
    expect(result.present).toEqual([]);
  });

  it('declines a file that is not an AxIgnoreDiagnosticList', () => {
    const privilege = `<?xml version="1.0" encoding="utf-8"?>\n<AxSecurityPrivilege><Name>X</Name></AxSecurityPrivilege>`;
    expect(removeDiagnosticSuppression(privilege, { path: 'dynamics://Form/X' }).kind).toBe('unsupported');
  });
});

describe('removeDiagnosticSuppressionsByPathPrefix', () => {
  it('removes every diagnostic whose path is the prefix itself or a sub-element of it', () => {
    const mixed = suppressionFile(
      diagnostic('dynamics://Form/ConDemoTicketTable', 'BPErrorGridCaption') +
      diagnostic('dynamics://Form/ConDemoTicketTable/Design/Grid1', 'BPXmlDocMissingSummary') +
      diagnostic('dynamics://Form/ConDemoOtherForm', 'BPErrorGridCaption'),
    );
    const { xml, removed } = removeDiagnosticSuppressionsByPathPrefix(mixed, 'dynamics://Form/ConDemoTicketTable');
    expect(removed).toHaveLength(2);
    expect(xml).toContain('ConDemoOtherForm');
    expect(xml).not.toContain('ConDemoTicketTable');
  });

  it('does not match a different object whose name merely starts with the same string', () => {
    // ConDemoTicketTableExtra must not be swept up by a prefix targeting ConDemoTicketTable.
    const file = suppressionFile(
      diagnostic('dynamics://Form/ConDemoTicketTableExtra', 'BPErrorGridCaption'),
    );
    const { removed } = removeDiagnosticSuppressionsByPathPrefix(file, 'dynamics://Form/ConDemoTicketTable');
    expect(removed).toHaveLength(0);
  });

  it('collapses <Items> when every diagnostic is removed', () => {
    const one = suppressionFile(diagnostic('dynamics://Form/ConDemoTicketTable', 'BPErrorGridCaption'));
    const { xml, removed } = removeDiagnosticSuppressionsByPathPrefix(one, 'dynamics://Form/ConDemoTicketTable');
    expect(removed).toHaveLength(1);
    expect(xml).toContain('<Items />');
  });

  it('returns the input unchanged, with no removed entries, when nothing matches', () => {
    const { xml, removed } = removeDiagnosticSuppressionsByPathPrefix(TWO_DIAGNOSTICS, 'dynamics://Table/NoSuchTable');
    expect(removed).toEqual([]);
    expect(xml).toBe(TWO_DIAGNOSTICS);
  });

  it('never throws on a file that is not an AxIgnoreDiagnosticList — returns it unchanged', () => {
    const notASuppressionFile = `<?xml version="1.0" encoding="utf-8"?>\n<Project><ItemGroup></ItemGroup></Project>`;
    const { xml, removed } = removeDiagnosticSuppressionsByPathPrefix(notASuppressionFile, 'dynamics://Form/X');
    expect(removed).toEqual([]);
    expect(xml).toBe(notASuppressionFile);
  });
});

/** A rendered <Diagnostic> block, in the shape buildSuppressionXml produces. */
function built(path: string, moniker: string): string {
  return (
    `<Diagnostic>\n` +
    `  <DiagnosticType>BestPractices</DiagnosticType>\n` +
    `  <Severity>Warning</Severity>\n` +
    `  <Path>${path}</Path>\n` +
    `  <Moniker>${moniker}</Moniker>\n` +
    `  <Justification>TODO</Justification>\n` +
    `</Diagnostic>`
  );
}

describe('addDiagnosticSuppression', () => {
  it('inserts the new block as the last child of <Items>', () => {
    const result = addDiagnosticSuppression(TWO_DIAGNOSTICS, built('dynamics://Table/ConDemoNewTable', 'BPErrorMissingPKConstraint'));
    expect(result.kind).toBe('added');
    if (result.kind !== 'added') return;

    expect(result.xml).toContain('dynamics://Table/ConDemoNewTable');
    expect(result.xml).toContain('BPErrorMissingPKConstraint');
    // The two that were already there survive whole.
    expect(result.xml).toContain('dynamics://Form/ConDemoTicketTable');
    expect(result.xml).toContain('dynamics://SecurityPrivilege/ConDemoTicketMaintain');
    // Still well-formed: one <Items> open, one close, three <Diagnostic> blocks.
    expect(result.xml.match(/<Diagnostic>/g)).toHaveLength(3);
    expect(result.xml.match(/<\/Diagnostic>/g)).toHaveLength(3);
  });

  it('populates a self-closed <Items /> — the first suppression in a fresh file', () => {
    const skeleton = emptySuppressionListXml('ConDemo_BPSuppressions');
    const result = addDiagnosticSuppression(skeleton, built('dynamics://Form/ConDemoTicketTable', 'BPErrorGridCaption'));
    expect(result.kind).toBe('added');
    if (result.kind !== 'added') return;
    expect(result.xml).not.toContain('<Items />');
    expect(result.xml).toContain('<Items>');
    expect(result.xml).toContain('dynamics://Form/ConDemoTicketTable');
  });

  it('inserts into an <Items>...</Items> that is empty but not self-closed', () => {
    const empty = suppressionFile('');
    const result = addDiagnosticSuppression(empty, built('dynamics://Form/ConDemoTicketTable', 'BPErrorGridCaption'));
    expect(result.kind).toBe('added');
    if (result.kind !== 'added') return;
    expect(result.xml).toContain('dynamics://Form/ConDemoTicketTable');
    expect(result.xml.match(/<Diagnostic>/g)).toHaveLength(1);
  });

  it('refuses a duplicate — same <Path> AND <Moniker> already present', () => {
    const result = addDiagnosticSuppression(TWO_DIAGNOSTICS, built('dynamics://Form/ConDemoTicketTable', 'BPErrorGridCaption'));
    expect(result.kind).toBe('duplicate');
    if (result.kind !== 'duplicate') return;
    expect(result.existing).toEqual({ path: 'dynamics://Form/ConDemoTicketTable', moniker: 'BPErrorGridCaption' });
  });

  it('matches a duplicate case-insensitively', () => {
    const result = addDiagnosticSuppression(TWO_DIAGNOSTICS, built('DYNAMICS://FORM/CONDEMOTICKETTABLE', 'bperrorgridcaption'));
    expect(result.kind).toBe('duplicate');
  });

  it('allows the same <Path> with a DIFFERENT <Moniker> — two distinct rules on one target', () => {
    const result = addDiagnosticSuppression(TWO_DIAGNOSTICS, built('dynamics://Form/ConDemoTicketTable', 'BPXmlDocMissingSummary'));
    expect(result.kind).toBe('added');
  });

  it('declines a file that is not an AxIgnoreDiagnosticList', () => {
    const privilege = `<?xml version="1.0" encoding="utf-8"?>\n<AxSecurityPrivilege><Name>X</Name></AxSecurityPrivilege>`;
    expect(addDiagnosticSuppression(privilege, built('dynamics://Form/X', 'BPErrorGridCaption')).kind).toBe('unsupported');
  });
});

describe('emptySuppressionListXml', () => {
  it('produces a file addDiagnosticSuppression accepts', () => {
    const skeleton = emptySuppressionListXml('ConDemo_BPSuppressions');
    expect(skeleton).toContain('<IgnoreDiagnostics>');
    expect(skeleton).toContain('<Name>ConDemo_BPSuppressions</Name>');
    const result = addDiagnosticSuppression(skeleton, built('dynamics://Form/X', 'BPErrorGridCaption'));
    expect(result.kind).toBe('added');
  });
});
