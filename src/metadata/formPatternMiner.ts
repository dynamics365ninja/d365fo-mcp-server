/**
 * Form Design tree walker shared by the XML parser (extraction), the form
 * pattern validator, and the pattern mining pipeline.
 *
 * Input is the <Design> node of an AxForm parsed with xml2js options
 * { explicitArray: false, mergeAttrs: true, trim: true } — i.e. single
 * children are plain objects, repeated children are arrays, and attributes
 * (notably i:type) are merged as keys.
 *
 * Real AxForm XML nests controls as:
 *   <Design>
 *     <Pattern>SimpleList</Pattern>
 *     <PatternVersion>1.1</PatternVersion>
 *     <Controls>
 *       <AxFormControl i:type="AxFormActionPaneControl">
 *         <Name>ActionPane</Name>
 *         <Type>ActionPane</Type>
 *         <Controls>...</Controls>
 *       </AxFormControl>
 *     </Controls>
 *   </Design>
 *
 * Container controls carry their own <Pattern>/<PatternVersion> (sub-patterns).
 * Extension controls (QuickFilter etc.) are plain <AxFormControl> without an
 * i:type, identified by <FormControlExtension><Name>.
 */

/** Normalized node of the form design tree */
export interface FormControlNode {
  name: string;
  /** Normalized control type: i:type minus AxForm/Control affixes (e.g. 'Grid', 'ActionPane', 'TabPage', 'String'), the <Type> element value, or the FormControlExtension name (e.g. 'QuickFilterControl'). */
  type: string;
  /** Raw i:type attribute when present (e.g. 'AxFormGridControl') */
  axType?: string;
  /** Sub-pattern declared on this container (e.g. 'CustomAndQuickFilters') */
  pattern?: string;
  patternVersion?: string;
  properties: Record<string, string>;
  children: FormControlNode[];
}

/** Normalized form Design info */
export interface FormDesignInfo {
  /** Top-level form pattern declared on Design (e.g. 'SimpleList') */
  pattern?: string;
  patternVersion?: string;
  style?: string;
  properties: Record<string, string>;
  controls: FormControlNode[];
}

/** Flat record of one patterned node — input for the form_patterns index table */
export interface PatternNodeRecord {
  /** 'Design' for the form root, else 'Design/Tab[TabHeader]/TabPage[General]'-style path */
  nodePath: string;
  /** '' for the Design root */
  controlName: string;
  /** '' for the Design root, else normalized control type */
  controlType: string;
  pattern: string;
  patternVersion?: string;
  /** Ordered normalized control types of direct children */
  childSequence: string[];
}

/** Control/Design properties surfaced into `properties` (when present as simple values) */
const PROPERTY_KEYS = [
  'Caption',
  'Visible',
  'Enabled',
  'AutoDeclaration',
  'DataSource',
  'DataField',
  'DataMethod',
  // A container carrying DataGroup is populated by the compiler from that table
  // field group — one generated control per member, named <DataGroup>_<Field>.
  'DataGroup',
  'HelpText',
  'Label',
  'Width',
  'Height',
  'AllowEdit',
  'Mandatory',
  'Style',
  'TitleDataSource',
  'ArrangeMethod',
  'MultiSelect',
  'ShowRowLabels',
  'WidthMode',
  'HeightMode',
];

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Elements that carry attributes (e.g. <Pattern xmlns="">SimpleList</Pattern>)
  // parse with mergeAttrs into { _: 'SimpleList', xmlns: '' } — text is under '_'.
  if (value && typeof value === 'object' && typeof (value as any)._ === 'string') {
    const text = (value as any)._;
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

/** Wrap single xml2js children (explicitArray:false) into arrays; drop empty-string placeholders from empty elements. */
function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value === '') return [];
  return [value];
}

/**
 * Extension control type names that end in 'Control' and must NOT have the suffix stripped,
 * because they are identified by that full name via FormControlExtension.Name in the validator.
 */
const EXTENSION_CONTROL_NAMES = new Set(['QuickFilterControl', 'SegmentedEntryControl']);

/**
 * 'AxFormGridControl' → 'Grid', 'AxFormActionPaneControl' → 'ActionPane', 'AxFormControl' → ''
 * Exception: extension controls like 'QuickFilterControl' keep their full suffix so they
 * match FormControlExtension.Name lookups used by the form pattern validator.
 */
export function normalizeControlType(axType: string | undefined): string {
  if (!axType) return '';
  let t = axType;
  if (t.startsWith('AxForm')) t = t.slice('AxForm'.length);
  if (t.endsWith('Control') && !EXTENSION_CONTROL_NAMES.has(t)) t = t.slice(0, -'Control'.length);
  return t;
}

/** Resolve the display type of a control node: i:type → <Type> element → extension name → 'Control'. */
function resolveControlType(node: any): { type: string; axType?: string } {
  const axType = asString(node['i:type']);
  const fromAxType = normalizeControlType(axType);
  if (fromAxType) return { type: fromAxType, axType };

  const typeElement = asString(node.Type);
  if (typeElement) return { type: typeElement, axType };

  const extension = node.FormControlExtension;
  if (extension && typeof extension === 'object' && extension['i:nil'] !== 'true') {
    const extName = asString(extension.Name);
    if (extName) return { type: extName, axType };
  }
  return { type: 'Control', axType };
}

function extractControlNode(node: any): FormControlNode | null {
  if (!node || typeof node !== 'object') return null;

  const { type, axType } = resolveControlType(node);
  const control: FormControlNode = {
    name: asString(node.Name) ?? 'Unknown',
    type,
    properties: {},
    children: [],
  };
  if (axType) control.axType = axType;

  const pattern = asString(node.Pattern);
  if (pattern) control.pattern = pattern;
  const patternVersion = asString(node.PatternVersion);
  if (patternVersion) control.patternVersion = patternVersion;

  for (const prop of PROPERTY_KEYS) {
    const value = asString(node[prop]);
    if (value !== undefined) control.properties[prop] = value;
  }

  // Child controls live under <Controls><AxFormControl>…
  const controlsNode = node.Controls;
  if (controlsNode && typeof controlsNode === 'object') {
    for (const childNode of asArray(controlsNode.AxFormControl)) {
      const child = extractControlNode(childNode);
      if (child) control.children.push(child);
    }
  }

  return control;
}

/**
 * Walk a parsed <Design> node into a normalized tree.
 * Tolerates both Design > Controls > AxFormControl and a bare Design > AxForm* shape.
 */
export function walkFormDesign(designNode: any): FormDesignInfo {
  const design: FormDesignInfo = { properties: {}, controls: [] };
  if (!designNode || typeof designNode !== 'object') return design;

  design.pattern = asString(designNode.Pattern);
  design.patternVersion = asString(designNode.PatternVersion);
  design.style = asString(designNode.Style);

  for (const prop of PROPERTY_KEYS) {
    const value = asString(designNode[prop]);
    if (value !== undefined) design.properties[prop] = value;
  }

  const controlsNode = designNode.Controls;
  if (controlsNode && typeof controlsNode === 'object') {
    for (const node of asArray(controlsNode.AxFormControl)) {
      const control = extractControlNode(node);
      if (control) design.controls.push(control);
    }
  } else {
    // Fallback: direct AxForm*-keyed children (no Controls wrapper)
    for (const key of Object.keys(designNode).filter((k) => k.startsWith('AxForm'))) {
      for (const node of asArray(designNode[key])) {
        const control = extractControlNode(node);
        if (control) {
          if (!control.axType) control.axType = key;
          if (control.type === 'Control') control.type = normalizeControlType(key) || control.type;
          design.controls.push(control);
        }
      }
    }
  }

  return design;
}

/**
 * Flatten a design tree into records of every node that declares a pattern
 * (the Design root plus sub-patterned containers) — mining input.
 */
export function collectPatternNodes(design: FormDesignInfo): PatternNodeRecord[] {
  const records: PatternNodeRecord[] = [];

  if (design.pattern) {
    records.push({
      nodePath: 'Design',
      controlName: '',
      controlType: '',
      pattern: design.pattern,
      patternVersion: design.patternVersion,
      childSequence: design.controls.map((c) => c.type),
    });
  }

  const visit = (node: FormControlNode, parentPath: string): void => {
    const nodePath = `${parentPath}/${node.type}[${node.name}]`;
    if (node.pattern) {
      records.push({
        nodePath,
        controlName: node.name,
        controlType: node.type,
        pattern: node.pattern,
        patternVersion: node.patternVersion,
        childSequence: node.children.map((c) => c.type),
      });
    }
    for (const child of node.children) visit(child, nodePath);
  };

  for (const control of design.controls) visit(control, 'Design');
  return records;
}
