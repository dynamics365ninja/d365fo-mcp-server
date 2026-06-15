/**
 * Form Pattern Catalog integrity tests.
 * Semantic invariants the TypeScript compiler cannot enforce.
 */

import { describe, it, expect } from 'vitest';
import {
  FORM_PATTERN_CATALOG,
  resolvePattern,
  resolvePatternExact,
  resolveSubPattern,
  subPatternsFor,
  type NodeSpec,
} from '../../src/knowledge/formPatterns/index';

function walkSpecs(nodes: NodeSpec[] | undefined, visit: (n: NodeSpec) => void): void {
  for (const n of nodes ?? []) {
    visit(n);
    walkSpecs(n.children, visit);
  }
}

describe('catalog integrity', () => {
  it('pattern ids and xmlNames are unique', () => {
    const ids = FORM_PATTERN_CATALOG.patterns.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const xmlNames = FORM_PATTERN_CATALOG.patterns.map((p) => p.xmlName);
    expect(new Set(xmlNames).size).toBe(xmlNames.length);
  });

  it('sub-pattern ids and xmlNames are unique', () => {
    const ids = FORM_PATTERN_CATALOG.subPatterns.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const xmlNames = FORM_PATTERN_CATALOG.subPatterns.map((p) => p.xmlName);
    expect(new Set(xmlNames).size).toBe(xmlNames.length);
  });

  it('xmlAliases never collide with ids, xmlNames, or other aliases (within each registry)', () => {
    for (const specs of [FORM_PATTERN_CATALOG.patterns, FORM_PATTERN_CATALOG.subPatterns] as const) {
      const seen = new Map<string, string>();
      for (const spec of specs) {
        for (const key of [spec.id, spec.xmlName, ...(spec.xmlAliases ?? [])]) {
          const k = key.toLowerCase();
          const owner = seen.get(k);
          expect(
            owner === undefined || owner === spec.id,
            `key "${key}" claimed by both ${owner} and ${spec.id}`,
          ).toBe(true);
          seen.set(k, spec.id);
        }
      }
    }
  });

  it('every pattern has versions, purpose, whenToUse, referenceForms and root', () => {
    for (const p of FORM_PATTERN_CATALOG.patterns) {
      if (p.id === 'Custom') continue; // sentinel — no structure enforced
      expect(p.versions.length, p.id).toBeGreaterThan(0);
      expect(p.purpose.length, p.id).toBeGreaterThan(0);
      expect(p.whenToUse.length, p.id).toBeGreaterThan(0);
      expect(p.referenceForms.length, p.id).toBeGreaterThan(0);
      expect(p.root.length, p.id).toBeGreaterThan(0);
    }
  });

  it('every sub-pattern has versions and appliesToControlTypes', () => {
    for (const sp of FORM_PATTERN_CATALOG.subPatterns) {
      if (sp.id === 'Custom') continue; // sentinel — no structure enforced
      expect(sp.versions.length, sp.id).toBeGreaterThan(0);
      expect(sp.appliesToControlTypes.length, sp.id).toBeGreaterThan(0);
    }
  });

  it('versions are sorted newest-first', () => {
    const numeric = (v: string) => {
      // Strip non-numeric prefixes like 'UX7 ' before parsing
      const clean = v.replace(/^[^0-9]+/, '');
      return clean.split('.').map((n) => parseInt(n, 10) || 0);
    };
    const isNewerOrEqual = (a: string, b: string) => {
      const pa = numeric(a); const pb = numeric(b);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d > 0;
      }
      return true;
    };
    for (const spec of [...FORM_PATTERN_CATALOG.patterns, ...FORM_PATTERN_CATALOG.subPatterns]) {
      for (let i = 1; i < spec.versions.length; i++) {
        expect(
          isNewerOrEqual(spec.versions[i - 1], spec.versions[i]),
          `${spec.id}: ${spec.versions.join(',')}`,
        ).toBe(true);
      }
    }
  });

  it('every allowedSubPatterns reference resolves to a known sub-pattern', () => {
    for (const p of FORM_PATTERN_CATALOG.patterns) {
      walkSpecs(p.root, (n) => {
        for (const name of n.allowedSubPatterns ?? []) {
          expect(resolveSubPattern(name), `${p.id}/${n.id} → ${name}`).toBeDefined();
        }
      });
    }
  });

  it('every variantOf and parentPatterns reference resolves to a known pattern', () => {
    for (const p of FORM_PATTERN_CATALOG.patterns) {
      if (p.variantOf) expect(resolvePatternExact(p.variantOf), p.id).toBeDefined();
    }
    for (const sp of FORM_PATTERN_CATALOG.subPatterns) {
      for (const parent of sp.parentPatterns ?? []) {
        expect(resolvePatternExact(parent), `${sp.id} → ${parent}`).toBeDefined();
      }
    }
  });

  it('every NodeSpec has at least one controlType', () => {
    for (const p of FORM_PATTERN_CATALOG.patterns) {
      walkSpecs(p.root, (n) => expect(n.controlTypes.length, `${p.id}/${n.id}`).toBeGreaterThan(0));
    }
    for (const sp of FORM_PATTERN_CATALOG.subPatterns) {
      walkSpecs(sp.root, (n) => expect(n.controlTypes.length, `${sp.id}/${n.id}`).toBeGreaterThan(0));
    }
  });
});

describe('resolvePattern', () => {
  it('resolves exact ids and xmlNames case-insensitively', () => {
    expect(resolvePattern('SimpleList')?.id).toBe('SimpleList');
    expect(resolvePattern('simplelist')?.id).toBe('SimpleList');
    expect(resolvePattern('detailsmaster')?.id).toBe('DetailsMaster');
  });

  it('resolves free-text aliases (normalizePattern compatibility)', () => {
    expect(resolvePattern('list')?.id).toBe('SimpleList');
    expect(resolvePattern('master')?.id).toBe('DetailsMaster');
    expect(resolvePattern('transaction')?.id).toBe('DetailsTransaction');
    expect(resolvePattern('simple list details')?.id).toBe('SimpleListDetails');
    expect(resolvePattern('drop dialog')?.id).toBe('DropDialog');
    expect(resolvePattern('toc')?.id).toBe('TableOfContents');
    expect(resolvePattern('parameters')?.id).toBe('TableOfContents');
    expect(resolvePattern('panorama')?.id).toBe('Workspace');
    expect(resolvePattern('operational workspace')?.id).toBe('WorkspaceOperational');
  });

  it('exact resolver does not fall back to aliases', () => {
    expect(resolvePatternExact('SimpleListy')).toBeUndefined();
    expect(resolvePatternExact('SimpleList')).toBeDefined();
  });

  it('returns undefined for garbage', () => {
    expect(resolvePattern('xyzzy')).toBeUndefined();
    expect(resolvePattern('')).toBeUndefined();
    expect(resolvePattern(undefined)).toBeUndefined();
  });
});

describe('subPatternsFor', () => {
  it('returns Group-applicable sub-patterns', () => {
    const ids = subPatternsFor('Group').map((sp) => sp.id);
    expect(ids).toContain('CustomAndQuickFilters');
    expect(ids).toContain('FieldsFieldGroups');
  });

  it('respects parentPatterns restriction', () => {
    const inSld = subPatternsFor('Group', 'SimpleListDetails').map((sp) => sp.id);
    expect(inSld).toContain('SidePanel');
    const inSimpleList = subPatternsFor('Group', 'SimpleList').map((sp) => sp.id);
    expect(inSimpleList).not.toContain('SidePanel');
  });
});
