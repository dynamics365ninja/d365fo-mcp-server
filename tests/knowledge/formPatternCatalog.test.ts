/**
 * Form Pattern Catalog integrity tests.
 * Semantic invariants the TypeScript compiler cannot enforce.
 */

import { describe, it, expect } from 'vitest';
import { currentPlatformPattern } from '../../src/knowledge/formPatterns/platform';
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

  it('lists the current platform version first', () => {
    // "Newest" is not numeric: "UX7 1.0" predates "1.1", and FillText's only
    // version is "UX7 1.0". The platform definitions decide (formPatternPlatform.test.ts
    // pins the whole list); generators emit versions[0].
    for (const spec of [...FORM_PATTERN_CATALOG.patterns, ...FORM_PATTERN_CATALOG.subPatterns]) {
      if (spec.versions.length === 0) continue;
      expect(spec.versions[0], spec.id).toBe(currentPlatformPattern(spec.xmlName)?.version);
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
    const inWorkspace = subPatternsFor('TabPage', 'WorkspaceOperational').map((sp) => sp.id);
    expect(inWorkspace).toContain('WorkspaceSectionTiles');
    const inSimpleList = subPatternsFor('TabPage', 'SimpleList').map((sp) => sp.id);
    expect(inSimpleList).not.toContain('WorkspaceSectionTiles');
  });
});
