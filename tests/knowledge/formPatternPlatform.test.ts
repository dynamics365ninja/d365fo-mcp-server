/**
 * The curated form pattern catalog must speak the platform's language.
 *
 * Generators write `spec.xmlName` and `spec.versions[0]` into new forms, so a
 * curated name or version the platform does not define produces a form the
 * compiler rejects (the catalog once said TaskSingle, Lookup, Workspace_Tiles,
 * FillText 1.0, ToolbarList 1.1). These tests pin the catalog to
 * src/knowledge/formPatterns/platform.generated.ts — regenerate that with
 * scripts/capture-form-pattern-definitions.ts and this file says what to update.
 */
import { describe, expect, it } from 'vitest';
import { FORM_PATTERN_CATALOG } from '../../src/knowledge/formPatterns';
import {
  controlPropertyDefault,
  currentPlatformPattern,
  isOneOf,
  platformPattern,
  platformVersions,
  type PlatformPatternNode,
} from '../../src/knowledge/formPatterns/platform';
import { PLATFORM_PATTERN_DEFINITIONS } from '../../src/knowledge/formPatterns/platform.generated';

const curated = [
  ...FORM_PATTERN_CATALOG.patterns.map((p) => ({ kind: 'pattern', id: p.id, xmlName: p.xmlName, versions: p.versions })),
  ...FORM_PATTERN_CATALOG.subPatterns.map((p) => ({ kind: 'sub-pattern', id: p.id, xmlName: p.xmlName, versions: p.versions })),
].filter((e) => e.xmlName !== 'Custom');

describe('curated catalog vs platform definitions', () => {
  it.each(curated.map((e) => [`${e.kind} ${e.id} (${e.xmlName})`, e] as const))('%s', (_label, e) => {
    const defs = platformVersions(e.xmlName);
    expect(defs.length, `"${e.xmlName}" is not a platform pattern name`).toBeGreaterThan(0);
    expect(e.versions).toEqual(defs.map((d) => d.version));
  });

  it('has no two entries claiming the same pattern name', () => {
    const names = curated.map((e) => e.xmlName.toLowerCase());
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });
});

function parts(node: PlatformPatternNode): PlatformPatternNode[] {
  return (node.nodes ?? []).flatMap((c) => (isOneOf(c) ? c.oneOf : [c]));
}

describe('generated platform definitions', () => {
  it('are unique per name and version', () => {
    const keys = PLATFORM_PATTERN_DEFINITIONS.map((d) => `${d.name}@${d.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('know Task, not TaskSingle', () => {
    expect(currentPlatformPattern('Task')?.version).toBe('1.2');
    expect(platformVersions('TaskSingle')).toEqual([]);
  });

  it('define TaskParentChild 1.2 with ParentTab, a splitter group and ChildTab as a Tab', () => {
    const root = platformPattern('TaskParentChild', '1.2')!.root;
    const p = parts(root);
    expect(p.find((n) => n.part === 'ParentTab')?.type).toBe('Tab');
    expect(p.find((n) => n.part === 'ChildTab')?.type).toBe('Tab');
    const splitter = p.find((n) => n.props?.some((r) => r.name === 'Style' && r.value === 'SplitterHorizontalContainer'));
    expect(splitter?.type).toBe('Group');
  });

  it('define FillText "UX7 1.0" as one StaticText or String that fills the space', () => {
    expect(platformVersions('FillText').map((d) => d.version)).toEqual(['UX7 1.0']);
    const root = platformPattern('FillText', 'UX7 1.0')!.root;
    const alternatives = parts(root);
    expect(alternatives.map((n) => n.type).sort()).toEqual(['StaticText', 'String']);
    for (const alt of alternatives) {
      expect(alt.props).toEqual(expect.arrayContaining([{ name: 'HeightMode', value: 'SizeToAvailable' }]));
    }
  });

  it('know ToolbarList 1.2 as current and CustomFilters 1.1 with ViewEditMode Edit', () => {
    expect(currentPlatformPattern('ToolbarList')?.version).toBe('1.2');
    const cf = platformPattern('CustomFilters', '1.1')!.root;
    expect(cf.props).toEqual(expect.arrayContaining([{ name: 'ViewEditMode', value: 'Edit' }]));
  });

  it('carry the metamodel defaults the property rules compare against', () => {
    expect(controlPropertyDefault('Group', 'ViewEditMode')).toBe('Auto');
    expect(controlPropertyDefault('StaticText', 'HeightMode')).toBe('SizeToContent');
    // Extension controls are plain AxFormControl in the metamodel.
    expect(controlPropertyDefault('QuickFilterControl', 'WidthMode')).toBe('SizeToContent');
    // A property the type does not have has no default (the rule is skipped).
    expect(controlPropertyDefault('StaticText', 'ViewEditMode')).toBeUndefined();
  });
});
