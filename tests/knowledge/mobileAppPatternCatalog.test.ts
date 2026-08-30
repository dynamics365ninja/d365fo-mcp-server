/**
 * Warehouse-app pattern catalog gates.
 *
 * Three things are pinned here:
 *  1. Shape — ids/aliases resolvable, related topics real (the same class of
 *     defect entryIntegrity.test.ts catches for KNOWLEDGE_BASE: a dangling id
 *     is presented to the agent as callable and costs a round trip).
 *  2. Content — every shipped X++ skeleton passes the offline best-practice
 *     validator that backs validate_code(mode="syntax"). docs/KNOWLEDGE_AUTHORING.md
 *     §4: "templates the tools emit must obey the rules the topics state" —
 *     the CoC template behind an earlier tool violated COC001 for exactly this
 *     reason.
 *  3. The decision — the list view must lead with the two frameworks. The whole
 *     catalog exists because picking the wrong one is a rewrite, and an agent
 *     that never sees the choice makes it by accident.
 */

import { describe, it, expect } from 'vitest';
import {
  listMobileAppPatterns,
  renderMobileAppPatternList,
  renderMobileAppPatternSpec,
  resolveMobileAppPattern,
} from '../../src/knowledge/mobileAppPatterns/index';
import { objectPatternsTool } from '../../src/tools/knowledge/objectPatterns';
import { KNOWLEDGE_BASE } from '../../src/tools/knowledge/xppKnowledge';
import { runRules } from '../../src/tools/analysis/validateXpp';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'object_patterns', arguments: args },
});
const text = (r: any): string => r.content?.[0]?.text ?? '';
const ctx: any = { symbolIndex: {}, parser: {} };

describe('mobile-app pattern catalog shape', () => {
  const patterns = listMobileAppPatterns();

  it('ships a recipe for each thing a screen task can be', () => {
    expect(patterns.length).toBeGreaterThanOrEqual(6);
  });

  it('ids are unique and kebab-case', () => {
    const ids = patterns.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter(id => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id))).toEqual([]);
  });

  it('every id and alias resolves back to its own pattern', () => {
    for (const p of patterns) {
      expect(resolveMobileAppPattern(p.id)?.id, p.id).toBe(p.id);
      for (const alias of p.aliases ?? []) {
        expect(resolveMobileAppPattern(alias)?.id, `${p.id} ← ${alias}`).toBe(p.id);
      }
    }
  });

  it('no alias is claimed by two patterns', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const p of patterns) {
      for (const a of [p.id, ...(p.aliases ?? [])]) {
        const norm = a.toLowerCase().replace(/[-_\s]/g, '');
        if (seen.has(norm)) dupes.push(`${a}: ${seen.get(norm)} vs ${p.id}`);
        else seen.set(norm, p.id);
      }
    }
    expect(dupes).toEqual([]);
  });

  it('every relatedTopics id is a real knowledge topic', () => {
    const ids = new Set(KNOWLEDGE_BASE.map(e => e.id));
    const dangling: string[] = [];
    for (const p of patterns) {
      for (const t of p.relatedTopics ?? []) if (!ids.has(t)) dangling.push(`${p.id} → ${t}`);
    }
    expect(dangling, `\ndangling knowledge topics:\n${dangling.join('\n')}`).toEqual([]);
  });

  it('covers both frameworks, not just the current one', () => {
    const frameworks = new Set(patterns.map(p => p.framework));
    expect(frameworks.has('process-guide')).toBe(true);
    expect(frameworks.has('legacy')).toBe(true);
  });

  it('every pattern says what it produces and how to check it', () => {
    for (const p of patterns) {
      expect(p.purpose.length, p.id).toBeGreaterThan(20);
      expect(p.whenToUse.length, p.id).toBeGreaterThan(0);
      expect(p.methodNotes.length, p.id).toBeGreaterThan(0);
      expect(p.crossChecks.length, p.id).toBeGreaterThan(0);
    }
  });
});

describe('mobile-app skeletons are valid X++ by the shipped rules', () => {
  const skeletons = listMobileAppPatterns().flatMap(p =>
    (p.skeletons ?? []).map(s => ({ pattern: p.id, label: s.label, code: s.code })),
  );

  it('ships copy-ready X++ for the create and modify recipes', () => {
    expect(skeletons.length).toBeGreaterThanOrEqual(5);
  });

  it('no skeleton carries an error-severity best-practice violation', () => {
    const bad: string[] = [];
    for (const s of skeletons) {
      for (const v of runRules(s.code, 'xpp').filter(x => x.severity === 'error')) {
        bad.push(`${s.pattern} :: ${s.label} :: ${v.rule} — ${v.excerpt ?? ''}`);
      }
    }
    expect(bad, `\n${bad.join('\n')}`).toEqual([]);
  });

  it('never puts operator-facing text in a literal', () => {
    // The shop floor reads these screens in its own language; a literal caption
    // fails BPErrorLabelIsText and cannot be translated.
    for (const s of skeletons) {
      const captions = [...s.code.matchAll(/add(?:TextBox|Label|Button)\s*\([^)]*"([^"@][^"]*)"/g)];
      expect(captions.map(m => m[1]), `${s.pattern} :: ${s.label}`).toEqual([]);
    }
  });
});

describe('object_patterns(domain="mobile-app")', () => {
  it('leads with the two-framework decision', async () => {
    const out = text(await objectPatternsTool(req({ domain: 'mobile-app' }), ctx));
    expect(out).toContain('ONE OF TWO FRAMEWORKS');
    expect(out).toContain('ProcessGuide');
    expect(out).toContain('WHSWorkExecuteDisplay');
    // …and tells the agent how to find out which one owns the flow at hand.
    expect(out).toContain('look at what it extends');
  });

  it('returns the full spec for a pattern id', async () => {
    const out = text(await objectPatternsTool(req({ domain: 'mobile-app', pattern: 'processguide-flow' }), ctx));
    expect(out).toContain('ProcessGuideController');
    expect(out).toContain('initializeNavigationRoute');
    expect(out).toContain('```xpp');
  });

  it('accepts an alias and a bare pattern id as the discriminator', async () => {
    const viaAlias = text(await objectPatternsTool(req({ domain: 'mobile-app', pattern: 'add-control' }), ctx));
    expect(viaAlias).toContain('Add a control to an existing screen');

    // An agent that types the recipe name where the domain goes still lands.
    const viaDomain = text(await objectPatternsTool(req({ domain: 'processguide-flow' }), ctx));
    expect(viaDomain).toContain('New flow (process guide framework)');
  });

  it('names the alternatives when the pattern is unknown', async () => {
    const r: any = await objectPatternsTool(req({ domain: 'mobile-app', pattern: 'nope' }), ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('processguide-flow');
  });

  it('keeps the modify recipes distinct from the create one', async () => {
    // The catalog is only worth its bytes if "add a control" and "replace the
    // page" do not collapse into "write a new flow".
    const replace = text(await objectPatternsTool(req({ domain: 'mobile-app', pattern: 'processguide-page-replace' }), ctx));
    expect(replace).toContain('pageBuilderName');
    const insert = text(await objectPatternsTool(req({ domain: 'mobile-app', pattern: 'processguide-step-insert' }), ctx));
    expect(insert).toContain('addFollowingStep');
    expect(insert).toContain('next initializeNavigationRoute');
  });

  it('renders every pattern without throwing', () => {
    for (const p of listMobileAppPatterns()) {
      expect(renderMobileAppPatternSpec(p).length, p.id).toBeGreaterThan(200);
    }
    expect(renderMobileAppPatternList()).toContain('gs1-scan-input');
  });
});
