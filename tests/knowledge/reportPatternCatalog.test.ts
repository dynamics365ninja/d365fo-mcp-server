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
import { CODE_GEN_PATTERNS } from '../../src/tools/smart/codeGen';

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

  it('every pattern has a scaffold line that references a generation call that EXISTS', () => {
    for (const p of REPORT_PATTERN_CATALOG) {
      // Two kinds of recipe now: the seven that CREATE a report scaffold one,
      // and the three that EXTEND a standard report, which are mode="pattern"
      // calls. Both are checked against the real call rather than a substring
      // that happened to be true when there was only one kind.
      const scaffoldMode = p.scaffold.includes('generate_object(mode="scaffold", objectType="report"');
      const patternMode = /generate_object\(mode="pattern", pattern="([a-z-]+)"/.exec(p.scaffold);

      expect(
        scaffoldMode || patternMode !== null,
        `${p.id}: scaffold names neither the report scaffold nor a mode="pattern" call`,
      ).toBe(true);

      if (patternMode) {
        // A recipe naming a pattern the generator does not accept is worse than
        // no recipe: the agent spends a round trip on a call that cannot work.
        expect(
          (CODE_GEN_PATTERNS as readonly string[]).includes(patternMode[1]),
          `${p.id}: names pattern "${patternMode[1]}", which generate_object does not accept`,
        ).toBe(true);
      }

      expect(p.objects.length).toBeGreaterThan(0);
      expect(p.whenToUse.length).toBeGreaterThan(0);
      expect(p.crossChecks.length).toBeGreaterThan(0);
    }
  });

  it('the three extension recipes are resolvable under the name the generator uses', () => {
    // An agent that read the pattern name off generate_object must land on the
    // recipe, and vice versa.
    for (const pattern of ['report-dataset-extension', 'report-custom-design', 'report-menu-redirect']) {
      const spec = resolveReportPattern(pattern);
      expect(spec, `no recipe resolves "${pattern}"`).toBeDefined();
      expect(spec!.scaffold).toContain(`pattern="${pattern}"`);
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
