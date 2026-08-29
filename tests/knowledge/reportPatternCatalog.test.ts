/**
 * Report-pattern catalog gates — the report-side counterpart of
 * formPatternCatalog.test.ts. The catalog is served straight to the agent, so
 * ids must be unique/resolvable, every relatedTopics id must be a real
 * knowledge topic (a dangling id costs the agent a wasted round trip), and
 * every scaffold line must reference the real generation call.
 */
import { describe, it, expect } from 'vitest';
import { REPORT_PATTERN_CATALOG } from '../../src/knowledge/reportPatterns/catalog';
import {
  resolveReportPattern,
  renderReportPatternList,
  renderReportPatternSpec,
} from '../../src/knowledge/reportPatterns/index';
import { KNOWLEDGE_BASE } from '../../src/tools/knowledge/xppKnowledge';

describe('report pattern catalog integrity', () => {
  it('ids and aliases are unique (normalized)', () => {
    const seen = new Set<string>();
    for (const p of REPORT_PATTERN_CATALOG) {
      for (const k of [p.id, ...(p.aliases ?? [])]) {
        const norm = k.toLowerCase().replace(/[-_\s]/g, '');
        expect(seen.has(norm), `duplicate pattern key "${k}"`).toBe(false);
        seen.add(norm);
      }
    }
  });

  it('every relatedTopics id resolves to a real knowledge topic', () => {
    const ids = new Set(KNOWLEDGE_BASE.map(e => e.id));
    for (const p of REPORT_PATTERN_CATALOG) {
      for (const t of p.relatedTopics ?? []) {
        expect(ids.has(t), `${p.id} → dangling knowledge id "${t}"`).toBe(true);
      }
    }
  });

  it('every pattern has a scaffold line that references generate_object', () => {
    for (const p of REPORT_PATTERN_CATALOG) {
      expect(p.scaffold).toContain('generate_object(mode="scaffold", objectType="report"');
      expect(p.objects.length).toBeGreaterThan(0);
      expect(p.whenToUse.length).toBeGreaterThan(0);
      expect(p.crossChecks.length).toBeGreaterThan(0);
    }
  });

  it('resolver matches ids and aliases case/separator-insensitively', () => {
    expect(resolveReportPattern('SimpleList')?.id).toBe('SimpleList');
    expect(resolveReportPattern('print-mgmt-form-letter')?.id).toBe('PrintMgmtFormLetter');
    expect(resolveReportPattern('PREPROCESS')?.id).toBe('PreProcess');
    expect(resolveReportPattern('ui builder')?.id).toBe('UIBuilderDialog');
    expect(resolveReportPattern('nonsense')).toBeUndefined();
  });

  it('renderers include the roster and the scaffold call', () => {
    const list = renderReportPatternList();
    for (const p of REPORT_PATTERN_CATALOG) expect(list).toContain(p.id);

    const spec = renderReportPatternSpec(REPORT_PATTERN_CATALOG[0]);
    expect(spec).toContain('Objects:');
    expect(spec).toContain('generate_object(mode="scaffold"');
    expect(spec).toContain('Verify:');
  });

  it('the design-name invariant is stated (controller ↔ AxReport agreement)', () => {
    // The Phase A bug (Design vs Report) must stay visible in the catalog.
    const base = REPORT_PATTERN_CATALOG.find(p => p.id === 'SimpleList')!;
    const roster = JSON.stringify(base.objects);
    expect(roster).toContain('ssrsReportStr({Name}, Report)');
  });
});
