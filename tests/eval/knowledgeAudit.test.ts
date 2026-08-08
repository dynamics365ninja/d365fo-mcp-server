/**
 * Knowledge-audit unit tests — VM-free.
 *
 * Two things are pinned here: the *extractor* (what counts as a named AOT
 * reference in knowledge prose/code) and the *gate* (a knowledge edit that has
 * not been re-audited on the VM must fail the snapshot check). The real
 * resolution against the 2 GB symbol index runs only under `--capture` on the
 * VM, so the fake lookup below stands in for it.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractEntryRefs, extractKnowledgeRefs } from '../../src/eval/audit/knowledgeRefs';
import { auditRefs, verifyAgainstSnapshot, buildSnapshot, type SymbolLookup, type AuditSnapshot } from '../../src/eval/audit/knowledgeAudit';
import { KNOWLEDGE_BASE, type KnowledgeEntry } from '../../src/tools/knowledge/xppKnowledge';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function entry(partial: Partial<KnowledgeEntry>): KnowledgeEntry {
  return {
    id: 'test-entry',
    title: 'Test',
    keywords: [],
    summary: '',
    rules: [],
    ...partial,
  };
}

function fakeLookup(known: Record<string, string[]>, members: Record<string, string[]> = {}): SymbolLookup {
  const byLower = new Map(Object.entries(known).map(([k, v]) => [k.toLowerCase(), { canonical: k, types: v }]));
  return {
    resolve: name => byLower.get(name.toLowerCase()) ?? null,
    isReferencedBase: () => false,
    hasMember: (canonical, member) =>
      (members[canonical] ?? []).some(m => m.toLowerCase() === member.toLowerCase()),
  };
}

describe('knowledge reference extraction', () => {
  it('picks up static calls, extends, new, attributes and intrinsics', () => {
    const refs = extractEntryRefs(entry({
      rules: ['Use SrsReportRunController and call FooHelper::bar()'],
      examples: [{
        label: 'x',
        code: [
          '[SysObsoleteAttribute("gone")]',
          'class Sample extends SrsReportDataProviderBase',
          '{',
          '    NumberSeqDatatype datatype;',
          '    void run() { datatype = new NumberSeqDatatype(); info(classStr(CustTable)); }',
          '}',
        ].join('\n'),
      }],
    }));
    const byKind = (k: string) => refs.filter(r => r.kind === k).map(r => r.name).sort();

    expect(byKind('static-call')).toEqual(['FooHelper']);
    expect(byKind('extends')).toEqual(['SrsReportDataProviderBase']);
    expect(byKind('new')).toEqual(['NumberSeqDatatype']);
    expect(byKind('attribute')).toEqual(['SysObsoleteAttribute']);
    expect(byKind('intrinsic')).toEqual(['CustTable']);
    // `Sample` is declared inside the example — not an AOT reference.
    expect(refs.some(r => r.name === 'Sample')).toBe(false);
  });

  it('ignores My… placeholders, X++ keywords and container literals', () => {
    const refs = extractEntryRefs(entry({
      summary: 'Statement order: [FindOptions] fieldList tableBuffer.',
      rules: ['Resolve via MyFactory::construct() and IMyStrategy'],
      examples: [{ label: 'x', code: 'container c = [CustVendorBlocked::No, CustVendorBlocked::Invoice];' }],
    }));
    expect(refs.map(r => r.name)).not.toContain('MyFactory');
    expect(refs.map(r => r.name)).not.toContain('IMyStrategy');
    expect(refs.map(r => r.name)).not.toContain('FindOptions');
    // The container literal must not be read as an attribute.
    expect(refs.filter(r => r.kind === 'attribute')).toHaveLength(0);
  });
});

describe('reference auditing', () => {
  it('flags a type that is not in the index', () => {
    const refs = extractEntryRefs(entry({ rules: ['Call SysRunnable::run() to start it'] }));
    const result = auditRefs(refs, fakeLookup({}));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].status).toBe('unknown-type');
    expect(result.findings[0].detail).toContain('SysRunnable');
  });

  it('flags a method that the real class does not declare', () => {
    const refs = extractEntryRefs(entry({ rules: ['Call LedgerVoucher::newLedgerVoucher() first'] }));
    const result = auditRefs(refs, fakeLookup({ LedgerVoucher: ['class'] }, { LedgerVoucher: ['newLedgerPost'] }));
    expect(result.findings.map(f => f.status)).toEqual(['unknown-member']);
  });

  it('flags AOT casing drift but still checks the member', () => {
    const refs = extractEntryRefs(entry({ rules: ['DP extends SRSReportDataProviderBase'] }));
    const result = auditRefs(refs, fakeLookup({ SrsReportDataProviderBase: ['class'] }));
    expect(result.findings.map(f => f.status)).toEqual(['casing']);
  });

  it('accepts an attribute written without its Attribute suffix', () => {
    const refs = extractEntryRefs(entry({ rules: ['Decorate with [DataContract] on the class'] }));
    const result = auditRefs(refs, fakeLookup({ DataContractAttribute: ['class'] }));
    expect(result.findings).toHaveLength(0);
  });

  it('accepts allowlisted kernel/.NET names without touching the index', () => {
    const refs = extractEntryRefs(entry({ rules: ['Use DateTimeUtil::utcNow() for timestamps'] }));
    const result = auditRefs(refs, fakeLookup({}), { DateTimeUtil: 'X++ kernel class.' });
    expect(result.findings).toHaveLength(0);
    expect(result.allowed).toBe(1);
  });
});

describe('snapshot gate', () => {
  it('fails a reference that the captured snapshot does not cover', () => {
    const refs = extractEntryRefs(entry({ rules: ['Call FooHelper::bar()'] }));
    const empty: AuditSnapshot = { capturedAt: '', indexedAt: '', ok: [] };
    expect(verifyAgainstSnapshot(refs, empty)).toHaveLength(1);
    const full = buildSnapshot(refs, { checked: 1, resolved: 1, allowed: 0, findings: [] }, 'x');
    expect(verifyAgainstSnapshot(refs, full)).toHaveLength(0);
  });

  it('the committed snapshot covers every reference in the shipped KNOWLEDGE_BASE', () => {
    const snapshotPath = path.join(REPO_ROOT, 'eval', 'knowledge-audit.snapshot.json');
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as AuditSnapshot;
    const missing = verifyAgainstSnapshot(extractKnowledgeRefs(KNOWLEDGE_BASE), snapshot);
    expect(
      missing.map(m => `${m.entryId}·${m.field}·${m.name}`),
      'knowledge content changed — re-run `npm run eval:knowledge-audit -- --capture` on the VM',
    ).toEqual([]);
  });
});
