/**
 * Platform pattern matcher — a TypeScript re-implementation of the platform's
 * PatternAnalyzer.TestPattern, driven by the generated definitions in
 * src/knowledge/formPatterns/platform.generated.ts.
 *
 * It validates ONE patterned node (the form Design, or a container that declares
 * a sub-pattern) against ONE definition, exactly as the compiler does: nested
 * containers that declare their own sub-pattern are checked by their own call.
 *
 * Held to the original by tests/validation/platformPatternMatcher.test.ts (the
 * engine's verdicts on tests/fixtures/formPatterns, recorded by
 * scripts/oracles/patternAnalyzer.ts) and by scripts/oracles/formPatternSweep.ts
 * (zero errors on every form Microsoft ships).
 *
 * Several parts of one pattern can share a control type (FieldsFieldGroups has
 * a plain field group and an "actionable field" group, both Group). The engine
 * tells them apart by whether the control's subtree fits, so the matcher scores
 * every candidate part by the findings its subtree would produce and keeps the
 * alignment with the fewest: first fewest missing/extra controls, then fewest
 * findings below. For a form the engine accepts, an alignment without findings
 * exists, so the matcher accepts it too.
 */

import type { FormControlNode } from '../metadata/formPatternMiner.js';
import {
  canonicalControlType,
  controlPropertyDefault,
  isOneOf,
  typesForNode,
  type PlatformPatternChild,
  type PlatformPatternDefinition,
  type PlatformPatternNode,
  type PlatformPropertyRule,
} from '../knowledge/formPatterns/platform.js';

export type PlatformIssueKind = 'missing' | 'extra' | 'order' | 'subPattern' | 'property' | 'target' | 'unspecified';

export interface PlatformIssue {
  kind: PlatformIssueKind;
  /** Tree path, e.g. 'Design/Tab[TabHeader]/TabPage[General]' */
  path: string;
  message: string;
  fix: string;
}

/** What the matcher needs from a control or the Design. */
export interface PatternTarget {
  name: string;
  /** Normalized control type; 'FormDesign' for the Design */
  type: string;
  /** FormControlExtension name, when the control hosts one */
  extension?: string;
  pattern?: string;
  properties: Record<string, string>;
  children: FormControlNode[];
}

interface Slot {
  alternatives: PlatformPatternNode[];
  min: number;
  max: number;
  label: string;
}

/** Cost of a missing required part or an extra control: outweighs any subtree finding count. */
const STRUCTURAL = 10_000;

function countRange(count: string | undefined): [number, number] {
  switch (count) {
    case '0..1': return [0, 1];
    case '0..*':
    case '*': return [0, Infinity];
    case '1..*': return [1, Infinity];
    default: return [1, 1];
  }
}

function nodeLabel(node: PlatformPatternNode): string {
  return node.part ?? node.alias ?? node.type;
}

function slotOf(node: PlatformPatternNode): Slot {
  const [min, max] = countRange(node.count);
  return { alternatives: [node], min, max, label: nodeLabel(node) };
}

/**
 * The part sequences a child list allows. A OneOf is one of its alternatives,
 * each with its own count (TabularFields: Cells 1..* OR SecondaryColumnLabel
 * 1..*), so every OneOf multiplies the sequences to try. Real definitions have
 * at most two OneOfs in one list.
 */
function slotSequences(children: PlatformPatternChild[] | undefined): Slot[][] {
  let sequences: Slot[][] = [[]];
  for (const child of children ?? []) {
    if (isOneOf(child)) {
      const next: Slot[][] = [];
      for (const seq of sequences) {
        for (const alt of child.oneOf) next.push([...seq, slotOf(alt)]);
      }
      sequences = next;
    } else {
      sequences = sequences.map((seq) => [...seq, slotOf(child)]);
    }
  }
  return sequences;
}

/**
 * The names the engine identifies a control by: its control type, and the
 * FormControlExtension it hosts. A tile is a MenuFunctionButton hosting
 * TileButtonControl, a form part a Container hosting FormPartControl, a ledger
 * account a SegmentedEntry hosting SegmentedEntryControl — each matches a part
 * typed by either name.
 */
function identityTypes(control: { type: string; extension?: string }): string[] {
  const own = canonicalControlType(control.type);
  return control.extension && control.extension !== own ? [own, control.extension] : [own];
}

function displayType(control: { type: string; extension?: string }): string {
  return control.extension ?? control.type;
}

function typeMatches(control: FormControlNode, node: PlatformPatternNode): boolean {
  const allowed = typesForNode(node.type);
  return identityTypes(control).some((t) => allowed.includes(t));
}

/**
 * A part that lists sub-patterns accepts a container declaring one of them, or
 * declaring none. A container declaring a sub-pattern the part does not list is
 * not this part (the engine then reports it as an extra child).
 */
function subPatternAllowed(control: FormControlNode, node: PlatformPatternNode): boolean {
  if (!control.pattern || !node.subPatterns || node.subPatterns.length === 0) return true;
  const declared = control.pattern.toLowerCase();
  return node.subPatterns.some((s) => s.toLowerCase() === declared);
}

function candidates(control: FormControlNode, slot: Slot): PlatformPatternNode[] {
  return slot.alternatives.filter((alt) => typeMatches(control, alt) && subPatternAllowed(control, alt));
}

function controlPath(parentPath: string, control: { type: string; name: string }): string {
  return `${parentPath}/${control.type}[${control.name}]`;
}

// Properties

function propertyValue(target: PatternTarget, name: string): string | undefined {
  const own = target.properties[name];
  if (own !== undefined) return own;
  return controlPropertyDefault(target.type, name);
}

function ruleHolds(rule: PlatformPropertyRule, actual: string): boolean {
  const a = actual.trim().toLowerCase();
  const e = rule.value.trim().toLowerCase();
  if (rule.op === 'Not') return a !== e;
  if (rule.op === 'Contains') return a.includes(e);
  return a === e;
}

function checkProperties(
  target: PatternTarget,
  rules: PlatformPropertyRule[] | undefined,
  path: string,
  label: string,
  issues: PlatformIssue[],
): void {
  for (const rule of rules ?? []) {
    const actual = propertyValue(target, rule.name);
    // The control type has no such property: the engine skips the rule.
    if (actual === undefined) continue;
    if (ruleHolds(rule, actual)) continue;
    const expected = rule.op === 'Not'
      ? `anything but "${rule.value}"`
      : rule.op === 'Contains' ? `a value containing "${rule.value}"` : `"${rule.value}"`;
    const set = target.properties[rule.name] !== undefined;
    issues.push({
      kind: 'property',
      path,
      message: `${label}: ${rule.name} must be ${expected}, is "${actual}"${set ? '' : ' (default)'}`,
      fix: rule.op === 'Not'
        ? `Set ${rule.name} on "${target.name}" to a value other than "${rule.value}".`
        : `Set <${rule.name}>${rule.value}</${rule.name}> on "${target.name}".`,
    });
  }
}

// Matching

class Matcher {
  constructor(private readonly label: string) {}

  /** Findings for one control matched to one part, cached: alignment asks repeatedly. */
  private readonly cache = new Map<FormControlNode, Map<PlatformPatternNode, PlatformIssue[]>>();

  evaluate(control: FormControlNode, node: PlatformPatternNode, path: string): PlatformIssue[] {
    let perControl = this.cache.get(control);
    if (!perControl) {
      perControl = new Map();
      this.cache.set(control, perControl);
    }
    const hit = perControl.get(node);
    if (hit) return hit;
    const issues: PlatformIssue[] = [];
    this.matchNode(control, node, path, issues);
    perControl.set(node, issues);
    return issues;
  }

  private static weight(issues: PlatformIssue[]): number {
    return issues.filter((i) => i.kind !== 'unspecified').length;
  }

  /** Best part among a slot's alternatives for this control, with its cost. */
  private best(control: FormControlNode, slot: Slot, path: string): { node: PlatformPatternNode; cost: number } | undefined {
    let pick: { node: PlatformPatternNode; cost: number } | undefined;
    for (const alt of candidates(control, slot)) {
      const cost = Matcher.weight(this.evaluate(control, alt, path));
      if (!pick || cost < pick.cost) pick = { node: alt, cost };
    }
    return pick;
  }

  /** Ordered alignment: control index → slot index (-1 = extra), with its cost. */
  private alignOrdered(controls: FormControlNode[], slots: Slot[], parentPath: string): { assignment: number[]; cost: number } {
    const n = controls.length;
    const m = slots.length;
    const fit = controls.map((c) => slots.map((s) => this.best(c, s, controlPath(parentPath, c))));
    const memo = new Map<string, number>();
    const capped = (j: number, c: number) => Math.min(c, Math.max(slots[j].min, 1));

    const cost = (i: number, j: number, c: number): number => {
      if (j === m) return (n - i) * STRUCTURAL;
      const key = `${i},${j},${capped(j, c)}`;
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      const slot = slots[j];
      let best = Math.max(0, slot.min - c) * STRUCTURAL + cost(i, j + 1, 0);
      if (i < n) {
        const f = fit[i][j];
        if (f && c < slot.max) best = Math.min(best, f.cost + cost(i + 1, j, c + 1));
        best = Math.min(best, STRUCTURAL + cost(i + 1, j, c));
      }
      memo.set(key, best);
      return best;
    };

    const assignment = new Array<number>(n).fill(-1);
    let i = 0;
    let j = 0;
    let c = 0;
    while (j < m) {
      const here = cost(i, j, c);
      const slot = slots[j];
      const f = i < n ? fit[i][j] : undefined;
      if (f && c < slot.max && f.cost + cost(i + 1, j, c + 1) === here) {
        assignment[i] = j;
        i++;
        c++;
      } else if (Math.max(0, slot.min - c) * STRUCTURAL + cost(i, j + 1, 0) === here) {
        j++;
        c = 0;
      } else {
        i++; // extra control
      }
    }
    return { assignment, cost: cost(0, 0, 0) };
  }

  /** Unordered alignment: each control takes the best-fitting part that still has room. */
  private alignUnordered(controls: FormControlNode[], slots: Slot[], parentPath: string): { assignment: number[]; cost: number } {
    const used = new Array<number>(slots.length).fill(0);
    let total = 0;
    const assignment = controls.map((control) => {
      let pick = -1;
      let pickCost = Infinity;
      slots.forEach((slot, j) => {
        if (used[j] >= slot.max) return;
        const f = this.best(control, slot, controlPath(parentPath, control));
        if (!f) return;
        // Fill parts still short of their minimum first, then the best fit.
        const cost = f.cost - (used[j] < slot.min ? 0.5 : 0);
        if (cost < pickCost) {
          pick = j;
          pickCost = cost;
        }
      });
      if (pick >= 0) {
        used[pick]++;
        total += this.best(control, slots[pick], controlPath(parentPath, control))!.cost;
      } else {
        total += STRUCTURAL;
      }
      return pick;
    });
    slots.forEach((slot, j) => { total += Math.max(0, slot.min - used[j]) * STRUCTURAL; });
    return { assignment, cost: total };
  }

  matchChildren(
    parent: PatternTarget,
    childNodes: PlatformPatternChild[] | undefined,
    unordered: boolean,
    path: string,
    issues: PlatformIssue[],
  ): void {
    const label = this.label;
    const controls = parent.children;
    let slots: Slot[] = [];
    let assignment: number[] = [];
    let bestCost = Infinity;
    for (const candidate of slotSequences(childNodes)) {
      const aligned = unordered
        ? this.alignUnordered(controls, candidate, path)
        : this.alignOrdered(controls, candidate, path);
      if (aligned.cost < bestCost) {
        bestCost = aligned.cost;
        slots = candidate;
        assignment = aligned.assignment;
      }
    }

    const used = new Array<number>(slots.length).fill(0);
    assignment.forEach((j) => { if (j >= 0) used[j]++; });

    slots.forEach((slot, j) => {
      if (used[j] >= slot.min) return;
      const alt = slot.alternatives[0];
      const sub = alt.subPatterns?.filter((s) => s !== 'Custom') ?? [];
      issues.push({
        kind: 'missing',
        path,
        message: `${label}: required part "${slot.label}" (${slot.alternatives.map((a) => a.type).join(' or ')}) is missing under "${parent.name}"`,
        fix: `Add a ${typesForNode(alt.type)[0]} control${alt.part ? ` for part ${alt.part}` : ''}${sub.length ? ` (sub-pattern ${sub.join(', ')})` : ''} under "${parent.name}"${slots.length > 1 ? `, in the order ${slots.map((s) => s.label).join(' → ')}` : ''}.`,
      });
    });

    controls.forEach((control, i) => {
      const j = assignment[i];
      const cPath = controlPath(path, control);
      if (j >= 0) {
        const f = this.best(control, slots[j], cPath)!;
        issues.push(...this.evaluate(control, f.node, cPath));
        return;
      }
      const typeOnly = slots.find((s) => s.alternatives.some((a) => typeMatches(control, a)));
      if (typeOnly && control.pattern && !typeOnly.alternatives.some((a) => subPatternAllowed(control, a))) {
        const allowed = [...new Set(typeOnly.alternatives.flatMap((a) => a.subPatterns ?? []))];
        issues.push({
          kind: 'subPattern',
          path: cPath,
          message: `${label}: sub-pattern "${control.pattern}" is not allowed on part "${typeOnly.label}" (allowed: ${allowed.join(', ')})`,
          fix: `Apply one of ${allowed.join(', ')} to "${control.name}", or remove its <Pattern> to leave it unspecified.`,
        });
      } else if (typeOnly) {
        issues.push({
          kind: 'order',
          path: cPath,
          message: `${label}: ${displayType(control)} "${control.name}" is out of place — parts under "${parent.name}" are ${slots.map((s) => `${s.label}${s.max > 1 ? '*' : s.min === 0 ? '?' : ''}`).join(' → ')}${unordered ? ' (any order)' : ''}`,
          fix: `Move "${control.name}" so the children of "${parent.name}" follow the part order, or remove it if that part already has its maximum count.`,
        });
      } else {
        const allowedTypes = [...new Set(slots.flatMap((s) => s.alternatives.flatMap((a) => typesForNode(a.type))))];
        issues.push({
          kind: 'extra',
          path: cPath,
          message: `${label}: ${displayType(control)} "${control.name}" is not allowed under "${parent.name}"${allowedTypes.length ? ` (allowed: ${allowedTypes.join(', ')})` : ' (this part takes no child controls)'}`,
          fix: `Remove or relocate "${control.name}".`,
        });
      }
    });
  }

  private matchNode(control: FormControlNode, node: PlatformPatternNode, path: string, issues: PlatformIssue[]): void {
    const target = asTarget(control);
    checkProperties(target, node.props, path, this.label, issues);
    if (node.children === '*') return;
    // A sub-pattern part: the container's content is its sub-pattern's business.
    if (node.subPatterns && node.subPatterns.length > 0) {
      if (!control.pattern) {
        const named = node.subPatterns.filter((s) => s !== 'Custom');
        issues.push({
          kind: 'unspecified',
          path,
          message: `${this.label}: container "${control.name}" (part ${nodeLabel(node)}) declares no sub-pattern`,
          fix: `Apply one of ${named.join(', ')}${node.subPatterns.includes('Custom') ? ' (or Custom)' : ''}. The compiler accepts it unspecified, but its content is then unchecked.`,
        });
      }
      return;
    }
    this.matchChildren(target, node.nodes, node.children === 'Unordered', path, issues);
  }
}

function asTarget(control: FormControlNode): PatternTarget {
  return {
    name: control.name,
    type: control.type,
    extension: control.extension,
    pattern: control.pattern,
    properties: control.properties,
    children: control.children,
  };
}

/**
 * Validate one patterned node against one platform definition. Returns every
 * finding; none of kind other than 'unspecified' means the platform accepts it.
 */
export function matchPlatformPattern(
  target: PatternTarget,
  def: PlatformPatternDefinition,
  path: string,
): PlatformIssue[] {
  const issues: PlatformIssue[] = [];
  const label = `${def.kind === 'form' ? 'pattern' : 'sub-pattern'} ${def.name} ${def.version}`;
  const allowed = typesForNode(def.root.type);
  if (!identityTypes(target).some((t) => allowed.includes(t))) {
    issues.push({
      kind: 'target',
      path,
      message: `${label} applies to ${allowed.join('/')}, not to ${displayType(target)} "${target.name}"`,
      fix: `Move the pattern to a ${allowed[0]} or choose a pattern for a ${target.type}.`,
    });
    return issues;
  }
  checkProperties(target, def.root.props, path, label, issues);
  if (def.root.children !== '*') {
    new Matcher(label).matchChildren(target, def.root.nodes, def.root.children === 'Unordered', path, issues);
  }
  return issues;
}
