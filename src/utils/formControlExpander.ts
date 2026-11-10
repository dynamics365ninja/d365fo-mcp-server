/**
 * Deterministic form control expander.
 *
 * Builds the control skeleton of a form straight from the platform's own pattern
 * definition (src/knowledge/formPatterns/platform.generated.ts, the grammar the
 * X++ compiler validates against), instead of cloning a reference form or
 * hand-writing per-pattern XML. The validator interprets the same definitions
 * (src/validation/platformPatternMatcher.ts), so the output is pattern-correct
 * by construction:
 *   - every required part (count absent or 1..*) gets one control of its type,
 *     in definition order; optional parts are left out of the skeleton;
 *   - a OneOf is skipped when one of its alternatives is optional, otherwise its
 *     first alternative is emitted (a Grid when there is one);
 *   - every Equals property rule the control's default does not already satisfy
 *     becomes an element, in canonical AOT order (FORM_CONTROL_ELEMENT_ORDER);
 *     a Not rule the default violates on Caption or Text gets the part name;
 *   - a part that lists sub-patterns declares the first named one and is
 *     expanded against that sub-pattern's definition in turn.
 *
 * The datasource, grid-field and caption behaviour is unchanged. The caller
 * (generateSmartForm) still self-tests the result against validateFormPatternXml
 * and falls back to the proven templates on error.
 *
 * The curated catalog walker ({@link buildControlXml}) stays for the form-repair
 * path, which materialises a single missing curated node.
 *
 * Indentation is intentionally simple: both the pattern validator (xml2js) and
 * the on-write normalizer (normalizeD365Xml) are whitespace-insensitive, so
 * exact AOT tabbing is applied at write time, not here.
 */

import type { FormPatternSpec, NodeSpec } from '../knowledge/formPatterns/index.js';
import {
  controlPropertyDefault,
  currentPlatformPattern,
  isKnownControlType,
  isOneOf,
  platformPattern,
  typesForNode,
  type PlatformPatternChild,
  type PlatformPatternDefinition,
  type PlatformPatternNode,
  type PlatformPropertyRule,
} from '../knowledge/formPatterns/platform.js';
import { FORM_CONTROL_ELEMENT_ORDER } from '../validation/formControlElementOrder.generated.js';
import { FormPatternTemplates } from './formPatternTemplates.js';
import type { FieldControlMap } from './fieldControlTypes.js';

export interface ExpandFormOptions {
  formName: string;
  dsName?: string;
  dsTable?: string;
  caption?: string;
  gridFields?: string[];
  fieldTypes?: FieldControlMap;
  linesDsName?: string;
  linesDsTable?: string;
  linesFields?: string[];
  linesFieldTypes?: FieldControlMap;
}

/** Normalized control type → AxForm i:type attribute. */
function iTypeFor(controlType: string): string {
  return `AxForm${controlType}Control`;
}

/** A node is concrete (emittable) when it names a single, specific control type. */
export function isConcrete(spec: NodeSpec): boolean {
  const t = spec.controlTypes[0];
  return spec.controlTypes.length >= 1 && t !== '*' && !!t;
}

/** Required containers only — optional/zeroOrMore slots are left out of the skeleton. */
export function isRequired(spec: NodeSpec): boolean {
  return spec.occurrence === 'required' || spec.occurrence === 'oneOrMore';
}

/** The platform definition a pattern spec expands against: its first curated version. */
function definitionFor(spec: FormPatternSpec): PlatformPatternDefinition | undefined {
  const version = spec.versions[0];
  return platformPattern(spec.xmlName, version);
}

/**
 * Whether the expander can build this pattern: the platform must define the
 * pattern at the version the catalog declares first. Patterns without versions
 * (the "Custom" escape hatch) or names the platform does not know cannot be
 * built — the compiler would reject the declaration itself. generate_smart_form
 * still self-tests every result and falls back to a template / clone when it is
 * not error-free.
 */
export function canExpandPattern(spec: FormPatternSpec): boolean {
  return definitionFor(spec) !== undefined;
}

/**
 * Public wrapper around {@link emitNode}: render a single pattern NodeSpec (and
 * its required descendants) as AxForm control XML at the given indent depth.
 * Used by the form-repair path to materialise a missing required control.
 * Returns '' for nodes that cannot be concretely emitted.
 */
export function buildControlXml(spec: NodeSpec, opt: ExpandFormOptions, depth: number): string {
  return emitNode(spec, opt, depth);
}

/**
 * Emit one control node and its required descendants. Returns '' for nodes that
 * cannot be concretely emitted (wildcard slots). `gridFields` are rendered as
 * column controls when the node is a Grid bound to the primary datasource.
 */
function emitNode(
  spec: NodeSpec,
  opt: ExpandFormOptions,
  depth: number,
): string {
  if (!isConcrete(spec)) return '';

  const indent = '\t'.repeat(depth);
  const controlType = spec.controlTypes[0];
  const name = spec.nameHint || spec.id;
  const iType = iTypeFor(controlType);
  // Element name → its line(s); written out in canonical order at the end.
  const elements = new Map<string, string>();

  elements.set('Name', `${indent}\t<Name>${name}</Name>`);
  elements.set('Type', `${indent}\t<Type>${controlType}</Type>`);
  elements.set('FormControlExtension', `${indent}\t<FormControlExtension i:nil="true" />`);

  // Required child containers (recursive), plus field columns for a Grid.
  const childSpecs = (spec.children ?? []).filter(isRequired).filter(isConcrete);
  const childXml = childSpecs
    .map((c) => emitNode(c, opt, depth + 2))
    .filter(Boolean)
    .join('\n');

  let gridColumns = '';
  if (controlType === 'Grid' && opt.dsName && (opt.gridFields?.length ?? 0) > 0) {
    gridColumns = opt
      .gridFields!.map((f) =>
        FormPatternTemplates.fieldControl(f, opt.dsName!, '\t'.repeat(depth + 2), 'Grid_', opt.fieldTypes),
      )
      .join('')
      .replace(/\n$/, '');
  }

  const inner = [childXml, gridColumns].filter(Boolean).join('\n');
  elements.set('Controls', inner
    ? `${indent}\t<Controls>\n${inner}\n${indent}\t</Controls>`
    : `${indent}\t<Controls />`);

  for (const [k, v] of Object.entries(spec.properties ?? {})) {
    elements.set(k, `${indent}\t<${k}>${v}</${k}>`);
  }

  // Grid needs a DataSource binding to be useful (and FP-correct).
  if (controlType === 'Grid' && opt.dsName) {
    elements.set('DataSource', `${indent}\t<DataSource>${opt.dsName}</DataSource>`);
  }

  // AOT XML is order-sensitive: the deserializer silently drops an element
  // written out of sequence (WidthMode after Style on a Tab, say). Write every
  // element in the order shipped forms use; one the table does not rank goes last.
  const order = FORM_CONTROL_ELEMENT_ORDER[iType] ?? [];
  const rank = (k: string): number => {
    const i = order.indexOf(k);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const lines = [`${indent}<AxFormControl xmlns="" i:type="${iType}">`];
  for (const k of [...elements.keys()].sort((a, b) => rank(a) - rank(b))) lines.push(elements.get(k)!);
  lines.push(`${indent}</AxFormControl>`);
  return lines.join('\n');
}

/** Build the <DataSources> block (primary + optional lines datasource). */
function emitDataSources(opt: ExpandFormOptions): string {
  const ds = (name: string, table: string): string =>
    `\t\t<AxFormDataSource xmlns="">\n` +
    `\t\t\t<Name>${name}</Name>\n` +
    `\t\t\t<Table>${table}</Table>\n` +
    `\t\t\t<Fields />\n` +
    `\t\t\t<ReferencedDataSources />\n` +
    `\t\t\t<InsertIfEmpty>No</InsertIfEmpty>\n` +
    `\t\t\t<DataSourceLinks />\n` +
    `\t\t\t<DerivedDataSources />\n` +
    `\t\t</AxFormDataSource>`;

  const blocks: string[] = [];
  if (opt.dsName && opt.dsTable) blocks.push(ds(opt.dsName, opt.dsTable));
  if (opt.linesDsName && opt.linesDsTable) blocks.push(ds(opt.linesDsName, opt.linesDsTable));
  if (blocks.length === 0) return `\t<DataSources />`;
  return `\t<DataSources>\n${blocks.join('\n')}\n\t</DataSources>`;
}


// Platform-driven expansion

/** Concrete control type the expander emits for a definition's Type, preferring the obvious member of an alias. */
const ALIAS_PREFERENCE: Record<string, string> = {
  $List: 'Grid',
  $Container: 'Group',
  $ContainerOrDesign: 'Group',
  $Field: 'String',
  $Button: 'Button',
};

/**
 * Extension controls the metamodel does not know as a control type: the base
 * control that hosts them. A tile is a MenuFunctionButton hosting
 * TileButtonControl, a form part a Container hosting FormPartControl. The rest
 * (QuickFilterControl, charts, dimension controls, Power BI) are plain
 * AxFormControl elements hosting the extension.
 */
const EXTENSION_HOSTS: Record<string, string> = {
  TileButtonControl: 'MenuFunctionButton',
  FormPartControl: 'Container',
};

/**
 * The control type to emit for a part. For an alias or a type list, the first
 * member (the preferred one first) that has every property the part's rules
 * require: a dialog's OK button is a `$Button` whose rule sets Command, which
 * only a CommandButton has.
 */
function emittedType(nodeType: string, rules?: PlatformPropertyRule[]): string {
  const members = typesForNode(nodeType);
  const preferred = ALIAS_PREFERENCE[nodeType.trim()];
  const ordered = preferred ? [preferred, ...members.filter((t) => t !== preferred)] : members;
  const needed = (rules ?? []).filter((r) => r.op !== 'Not').map((r) => r.name);
  const fits = ordered.find((t) => !isKnownControlType(t)
    || needed.every((p) => controlPropertyDefault(t, p) !== undefined));
  return fits ?? ordered[0] ?? 'Group';
}

function isMandatory(count: string | undefined): boolean {
  return count === undefined || count === '1..*';
}

/** The alternative of a OneOf to emit, or undefined when the OneOf may be left empty. */
function pickAlternative(oneOf: PlatformPatternNode[]): PlatformPatternNode | undefined {
  if (oneOf.some((alt) => !isMandatory(alt.count))) return undefined;
  return oneOf.find((alt) => emittedType(alt.type) === 'Grid') ?? oneOf[0];
}

/** Required parts of a child list, OneOfs resolved. */
function requiredParts(children: PlatformPatternChild[] | undefined): PlatformPatternNode[] {
  const out: PlatformPatternNode[] = [];
  for (const child of children ?? []) {
    if (isOneOf(child)) {
      const alt = pickAlternative(child.oneOf);
      if (alt) out.push(alt);
    } else if (isMandatory(child.count)) {
      out.push(child);
    }
  }
  return out;
}

/** 'SecondaryInstruction' → 'Secondary instruction': a readable placeholder caption. */
function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

function xmlEscape(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Property elements a control needs so the definition's rules hold. A rule on a
 * property the control type does not have is skipped, as the platform does. A
 * value the metamodel default already gives is left implicit. A Not rule the
 * default violates takes its value from `fill` (a placeholder caption, the
 * sibling default-action button), or stays unmet when there is none.
 */
function requiredProperties(
  controlType: string,
  rules: PlatformPropertyRule[] | undefined,
  fill: Record<string, string | undefined>,
  into: Map<string, string>,
): void {
  for (const rule of rules ?? []) {
    const current = into.get(rule.name) ?? controlPropertyDefault(controlType, rule.name);
    if (current === undefined) continue;
    const a = current.trim().toLowerCase();
    const e = rule.value.trim().toLowerCase();
    if (rule.op === 'Not') {
      if (a !== e) continue;
      const value = fill[rule.name];
      if (value) into.set(rule.name, value);
      continue;
    }
    if (rule.op === 'Contains') {
      if (!a.includes(e)) into.set(rule.name, rule.value);
      continue;
    }
    if (a !== e) into.set(rule.name, rule.value);
  }
}

interface EmitContext {
  opt: ExpandFormOptions;
  usedNames: Set<string>;
  /** Name of the first Grid emitted, the QuickFilter target. */
  gridName?: string;
}

const GRID_TOKEN = '\u0000GRID\u0000';

function uniqueName(ctx: EmitContext, wanted: string): string {
  const base = (wanted.replace(/[^A-Za-z0-9_]/g, '') || 'Control').replace(/^(\d)/, '_$1');
  let name = base;
  for (let i = 2; ctx.usedNames.has(name.toLowerCase()); i++) name = `${base}${i}`;
  ctx.usedNames.add(name.toLowerCase());
  return name;
}

/**
 * The sub-pattern a part declares. FieldsFieldGroups when the part lists it: it
 * is the general-purpose content of a tab page or group, where the first listed
 * one is often a specialised control (DimensionEntryControl). Otherwise the
 * first named one whose definition fits the control type.
 */
const PREFERRED_SUB_PATTERN = 'FieldsFieldGroups';

function subPatternFor(node: PlatformPatternNode, controlType: string): PlatformPatternDefinition | undefined {
  const listed = node.subPatterns ?? [];
  const ordered = listed.includes(PREFERRED_SUB_PATTERN)
    ? [PREFERRED_SUB_PATTERN, ...listed.filter((s) => s !== PREFERRED_SUB_PATTERN)]
    : listed;
  for (const name of ordered) {
    if (name === 'Custom') continue;
    const def = currentPlatformPattern(name);
    if (def && typesForNode(def.root.type).includes(controlType)) return def;
  }
  return undefined;
}

function extensionXml(extension: string, indent: string): string {
  const head = `${indent}\t<FormControlExtension>\n${indent}\t\t<Name>${extension}</Name>\n${indent}\t\t<ExtensionComponents />\n`;
  const tail = `${indent}\t</FormControlExtension>`;
  if (extension !== 'QuickFilterControl') return `${head}${indent}\t\t<ExtensionProperties />\n${tail}`;
  const prop = (name: string, value?: string): string =>
    `${indent}\t\t\t<AxFormControlExtensionProperty>\n` +
    `${indent}\t\t\t\t<Name>${name}</Name>\n` +
    `${indent}\t\t\t\t<Type>String</Type>\n` +
    (value ? `${indent}\t\t\t\t<Value>${value}</Value>\n` : '') +
    `${indent}\t\t\t</AxFormControlExtensionProperty>\n`;
  return `${head}${indent}\t\t<ExtensionProperties>\n` +
    prop('targetControlName', GRID_TOKEN) + prop('placeholderText') +
    `${indent}\t\t</ExtensionProperties>\n${tail}`;
}

/** Emit one control for a definition part, with its required descendants. */
function emitPart(
  node: PlatformPatternNode,
  name: string,
  defaultAction: string | undefined,
  ctx: EmitContext,
  depth: number,
): string {
  const indent = '\t'.repeat(depth);
  const nodeType = emittedType(node.type, node.props);
  const extension = isKnownControlType(nodeType) ? undefined : nodeType;
  const hostType = extension ? EXTENSION_HOSTS[extension] : nodeType;
  const label = partName(node);
  const iType = hostType ? iTypeFor(hostType) : 'AxFormControl';
  // Property rules are checked against the control's own type.
  const propType = hostType ?? 'Control';

  const fill = { Caption: humanize(label), Text: humanize(label), DefaultAction: defaultAction };
  const props = new Map<string, string>();
  requiredProperties(propType, node.props, fill, props);

  const sub = node.subPatterns?.length ? subPatternFor(node, propType) : undefined;
  if (sub) requiredProperties(propType, sub.root.props, fill, props);

  const elements = new Map<string, string>();
  elements.set('Name', `${indent}\t<Name>${name}</Name>`);
  if (hostType) elements.set('Type', `${indent}\t<Type>${hostType}</Type>`);
  elements.set('FormControlExtension', extension
    ? extensionXml(extension, indent)
    : `${indent}\t<FormControlExtension i:nil="true" />`);
  if (sub) {
    elements.set('Pattern', `${indent}\t<Pattern>${sub.name}</Pattern>`);
    elements.set('PatternVersion', `${indent}\t<PatternVersion>${sub.version}</PatternVersion>`);
  }
  for (const [k, v] of props) elements.set(k, `${indent}\t<${k}>${xmlEscape(v)}</${k}>`);

  let inner = '';
  if (hostType === 'Grid') {
    if (!ctx.gridName) ctx.gridName = name;
    const { opt } = ctx;
    if (opt.dsName) {
      elements.set('DataSource', `${indent}\t<DataSource>${opt.dsName}</DataSource>`);
      // Grid parts leave their children unchecked ('*'): the field columns go here.
      if (node.children === '*' && (opt.gridFields?.length ?? 0) > 0) {
        inner = opt.gridFields!
          .map((f) => FormPatternTemplates.fieldControl(f, opt.dsName!, '\t'.repeat(depth + 2), 'Grid_', opt.fieldTypes))
          .join('')
          .replace(/\n$/, '');
      }
    }
  } else if (sub) {
    inner = sub.root.children === '*' ? '' : emitParts(requiredParts(sub.root.nodes), ctx, depth + 2);
  } else if (!node.subPatterns?.length && node.children !== '*') {
    inner = emitParts(requiredParts(node.nodes), ctx, depth + 2);
  }

  // A plain extension control (no host type) carries no Controls element.
  if (hostType) {
    elements.set('Controls', inner
      ? `${indent}\t<Controls>\n${inner}\n${indent}\t</Controls>`
      : `${indent}\t<Controls />`);
  }

  // AOT XML is order-sensitive: the deserializer silently drops an element
  // written out of sequence (WidthMode after Style on a Tab, say). Write every
  // element in the order shipped forms use. One the table does not rank goes last.
  const order = FORM_CONTROL_ELEMENT_ORDER[iType] ?? [];
  const rank = (k: string): number => {
    const i = order.indexOf(k);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const open = hostType
    ? `${indent}<AxFormControl xmlns="" i:type="${iType}">`
    : `${indent}<AxFormControl xmlns="">`;
  const lines = [open];
  for (const k of [...elements.keys()].sort((a, b) => rank(a) - rank(b))) lines.push(elements.get(k)!);
  lines.push(`${indent}</AxFormControl>`);
  return lines.join('\n');
}

function partName(node: PlatformPatternNode): string {
  return node.part ?? node.alias ?? emittedType(node.type);
}

/**
 * Emit sibling parts. Names are assigned up front so a list can point its
 * DefaultAction at the sibling button the definition provides for it
 * (DetailsMaster's MainGrid → MainGridDefaultAction).
 */
function emitParts(parts: PlatformPatternNode[], ctx: EmitContext, depth: number): string {
  const names = parts.map((p) => uniqueName(ctx, partName(p)));
  const actionIndex = parts.findIndex((p) => /DefaultAction$/i.test(p.part ?? ''));
  const defaultAction = actionIndex >= 0 ? names[actionIndex] : undefined;
  return parts.map((p, i) => emitPart(p, names[i], defaultAction, ctx, depth)).join('\n');
}

/**
 * Expand a form pattern spec into complete AxForm XML, deterministically and
 * straight from the platform's definition of the pattern. Used for patterns
 * that have no dedicated hand-written template.
 */
export function expandPatternToXml(spec: FormPatternSpec, opt: ExpandFormOptions): string {
  const version = spec.versions[0] ?? '1.0';
  const def = definitionFor(spec);
  const ctx: EmitContext = { opt, usedNames: new Set([opt.formName.toLowerCase()]) };

  // Design properties: the definition's root rules, then caption and datasource.
  // Never the pattern name as Style: "SimpleDetails-ToolbarFields" is not a Style value.
  const design = new Map<string, string>();
  if (opt.caption) design.set('Caption', opt.caption);
  const designCaption = opt.caption ?? opt.formName;
  if (def) requiredProperties('FormDesign', def.root.props, { Caption: designCaption, Text: designCaption }, design);
  else if (spec.designProperties?.Style) design.set('Style', spec.designProperties.Style);
  if (opt.dsName) {
    design.set('DataSource', opt.dsName);
    design.set('TitleDataSource', opt.dsName);
  }
  design.set('Pattern', spec.xmlName);
  design.set('PatternVersion', version);

  let controls: string;
  if (def) {
    controls = def.root.children === '*' ? '' : emitParts(requiredParts(def.root.nodes), ctx, 3);
  } else {
    controls = spec.root
      .filter(isRequired)
      .filter(isConcrete)
      .map((node) => emitNode(node, opt, 3))
      .filter(Boolean)
      .join('\n');
  }
  controls = controls.split(GRID_TOKEN).join(ctx.gridName ?? 'Grid');

  // Design's direct-child properties are alphabetical and <Controls> closes the
  // block (see src/utils/axFormDesignProperties.ts).
  const designProps = [...design.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((k) => `\t\t<${k} xmlns="">${xmlEscape(design.get(k)!)}</${k}>\n`)
    .join('');

  const controlsBlock = controls
    ? `\t\t<Controls xmlns="">\n${controls}\n\t\t</Controls>`
    : `\t\t<Controls xmlns="" />`;

  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">\n` +
    `\t<Name>${opt.formName}</Name>\n` +
    `\t<SourceCode>\n` +
    `\t\t<Methods xmlns="">\n` +
    `\t\t\t<Method>\n` +
    `\t\t\t\t<Name>classDeclaration</Name>\n` +
    `\t\t\t\t<Source><![CDATA[\n` +
    `[Form]\n` +
    `public class ${opt.formName} extends FormRun\n` +
    `{\n` +
    `}\n\n` +
    `]]></Source>\n` +
    `\t\t\t</Method>\n` +
    `\t\t</Methods>\n` +
    `\t\t<DataSources xmlns="" />\n` +
    `\t\t<DataControls xmlns="" />\n` +
    `\t\t<Members xmlns="" />\n` +
    `\t</SourceCode>\n` +
    `${emitDataSources(opt)}\n` +
    `\t<Design>\n` +
    designProps +
    `${controlsBlock}\n` +
    `\t</Design>\n` +
    `\t<Parts />\n` +
    `</AxForm>\n`
  );
}
