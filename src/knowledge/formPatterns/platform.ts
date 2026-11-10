/**
 * Platform form pattern definitions — the grammar the X++ compiler validates
 * forms against, generated from Microsoft.Dynamics.AX.Metadata.Patterns.dll by
 * scripts/capture-form-pattern-definitions.ts.
 *
 * The curated catalog (./catalog) carries guidance: purpose, when to use,
 * reference forms, lifecycle notes. This module carries the rules: which pattern
 * names and versions exist, which parts a pattern has, how often each may occur,
 * in which order, which sub-patterns a slot accepts and which property values the
 * compiler requires. src/validation/platformPatternMatcher.ts interprets it.
 *
 * Semantics (measured with scripts/oracles/patternAnalyzer.ts against the
 * platform's own PatternAnalyzer, not guessed from the XML):
 *   - a pattern is looked up by exact name AND version. An unknown name, an
 *     unknown version and an empty version all resolve to nothing, and the
 *     compiler rejects the form;
 *   - Count absent = exactly one; '0..1'; '0..*' and '*' = any number; '1..*';
 *   - Children '*' = the control's children are not checked; 'Unordered' = the
 *     child parts may come in any order; otherwise children must follow the part
 *     order, and a part without child parts or sub-patterns takes no children;
 *   - a part listing SubPatterns accepts a container that declares one of them
 *     or declares none; its children are then the sub-pattern's business;
 *   - a property rule compares the control's value, or the metamodel default
 *     when the XML omits the property (./platformDefaults.generated.ts). A rule
 *     naming a property the control type does not have is skipped;
 *   - every patterned node (the Design and each container with a <Pattern>) is
 *     validated on its own against its own definition.
 */

import { PLATFORM_PATTERN_DEFINITIONS } from './platform.generated.js';
import { PLATFORM_CONTROL_DEFAULTS } from './platformDefaults.generated.js';

export interface PlatformPropertyRule {
  name: string;
  value: string;
  /** Absent = Equals */
  op?: 'Not' | 'Contains';
  /** 'WhenExists' = only when the control type has this property */
  when?: 'WhenExists';
}

export interface PlatformPatternNode {
  /** Control type, an alias ('$Field', '$Container', '$ContainerOrDesign', '$Button', '$List') or a comma list */
  type: string;
  part?: string;
  alias?: string;
  /** '0..1' | '0..*' | '*' | '1..*'; absent = exactly one */
  count?: string;
  /** '*' = children unconstrained, 'Unordered' = parts in any order */
  children?: string;
  props?: PlatformPropertyRule[];
  subPatterns?: string[];
  nodes?: PlatformPatternChild[];
}

export interface PlatformOneOf {
  oneOf: PlatformPatternNode[];
}

export type PlatformPatternChild = PlatformPatternNode | PlatformOneOf;

export interface PlatformPatternDefinition {
  name: string;
  version: string;
  alias?: string;
  active: boolean;
  category?: string;
  kind: 'form' | 'sub';
  /** Resource file the definition came from ('…_previous.xml' = superseded versions) */
  file: string;
  root: PlatformPatternNode;
}

export function isOneOf(child: PlatformPatternChild): child is PlatformOneOf {
  return Array.isArray((child as PlatformOneOf).oneOf);
}

// Type aliases, copied from PatternNodeIdentity's static arrays in the platform DLL.
const BUTTON_TYPES = ['Button', 'MenuFunctionButton', 'MenuButton', 'CommandButton', 'DropDialogButton', 'ButtonSeparator'];
const CONTAINER_TYPES = ['Group', 'TabPage'];
const FIELD_TYPES = [
  'String', 'Integer', 'Int64', 'Real', 'Date', 'Time', 'DateTime', 'ComboBox', 'RadioButton',
  'CheckBox', 'ReferenceGroup', 'SegmentedEntry', 'Guid',
];
const LIST_TYPES = ['Tree', 'Grid', 'Table', 'ListView'];

/**
 * Our form walker normalizes i:type, the platform reads the metamodel's control
 * type. They differ in a few spellings.
 */
const TYPE_SYNONYMS: Record<string, string> = {
  Int: 'Integer',
  UtcDateTime: 'DateTime',
  Radio: 'RadioButton',
  SegmentedEntryControl: 'SegmentedEntry',
};

export function canonicalControlType(type: string): string {
  return TYPE_SYNONYMS[type] ?? type;
}

/** Concrete control types a pattern node's Type admits ('FormDesign' for the design root). */
export function typesForNode(type: string): string[] {
  const out: string[] = [];
  for (const raw of type.split(',')) {
    const t = raw.trim();
    switch (t) {
      case '$Button': out.push(...BUTTON_TYPES); break;
      case '$Container': out.push(...CONTAINER_TYPES); break;
      case '$ContainerOrDesign': out.push(...CONTAINER_TYPES, 'FormDesign'); break;
      case '$Field': out.push(...FIELD_TYPES); break;
      case '$List': out.push(...LIST_TYPES); break;
      default: if (t) out.push(t);
    }
  }
  return out;
}

// Lookup

const byNameVersion = new Map<string, PlatformPatternDefinition>();
const byName = new Map<string, PlatformPatternDefinition[]>();
for (const def of PLATFORM_PATTERN_DEFINITIONS) {
  byNameVersion.set(`${def.name.toLowerCase()}@${def.version}`, def);
  const list = byName.get(def.name.toLowerCase()) ?? [];
  list.push(def);
  byName.set(def.name.toLowerCase(), list);
}

/** Exact lookup, as the compiler does it (name case-insensitive, version exact). */
export function platformPattern(name: string, version: string | undefined): PlatformPatternDefinition | undefined {
  if (!name || !version) return undefined;
  return byNameVersion.get(`${name.trim().toLowerCase()}@${version.trim()}`);
}

/** All versions the platform knows for a pattern name; current definitions first. */
export function platformVersions(name: string): PlatformPatternDefinition[] {
  const list = byName.get(name.trim().toLowerCase()) ?? [];
  return [...list].sort((a, b) => {
    const pa = a.file.includes('_previous') ? 1 : 0;
    const pb = b.file.includes('_previous') ? 1 : 0;
    return pa - pb || compareVersionStrings(b.version, a.version);
  });
}

/** Newest current definition of a pattern name (what a new form should declare). */
export function currentPlatformPattern(name: string): PlatformPatternDefinition | undefined {
  return platformVersions(name)[0];
}

export function isPlatformPatternName(name: string): boolean {
  return byName.has(name.trim().toLowerCase());
}

export function platformPatternNames(kind?: 'form' | 'sub'): string[] {
  const names = new Set<string>();
  for (const def of PLATFORM_PATTERN_DEFINITIONS) {
    if (!kind || def.kind === kind) names.add(def.name);
  }
  return [...names].sort();
}

/** "UX7 1.1" < "1.0": the UX7-prefixed versions predate the plain numbered ones. */
export function compareVersionStrings(a: string, b: string): number {
  const ux = (v: string) => (/^UX7\s/i.test(v) ? 0 : 1);
  if (ux(a) !== ux(b)) return ux(a) - ux(b);
  const pa = a.replace(/^UX7\s+/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^UX7\s+/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Default value of a property on a control type when the XML omits it, or
 * undefined when the type has no such property. Extension controls (QuickFilter,
 * tiles, charts) are plain AxFormControl in the metamodel.
 */
export function controlPropertyDefault(controlType: string, property: string): string | undefined {
  const t = canonicalControlType(controlType);
  const table = PLATFORM_CONTROL_DEFAULTS[t] ?? PLATFORM_CONTROL_DEFAULTS.Control;
  return table?.[property];
}

/** True when the metamodel knows this control type (so a missing default means "no such property"). */
export function isKnownControlType(controlType: string): boolean {
  return canonicalControlType(controlType) in PLATFORM_CONTROL_DEFAULTS;
}
