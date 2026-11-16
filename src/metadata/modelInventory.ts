/**
 * Model inventory and descriptor authoring.
 *
 * modelDescriptor.ts reads and edits ONE list of ONE descriptor
 * (`<ModuleReferences>`). This module is what the model lifecycle needs on top:
 * every descriptor under a set of packages roots read as a whole (name, id,
 * layer, publisher, version, package), the questions asked across them (who
 * references this package, is there a reference cycle, does every reference
 * resolve, is this Id taken), and the two transforms the lifecycle writes —
 * a new descriptor, and one scalar property of an existing one.
 *
 * Pure apart from scanDescriptors, which reads directories. Nothing here
 * decides whether a write is ALLOWED; that is the handler's job
 * (src/tools/write/modelLifecycle.ts).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import * as path from 'path';
import { isValidModuleReferenceName, parseModuleReferences } from './modelDescriptor.js';

/** Layer names in descriptor order: `<Layer>` holds the INDEX (usr = 14). */
export const MODEL_LAYERS = [
  'sys', 'syp', 'gls', 'glp', 'fpk', 'fpp', 'sln', 'slp',
  'isv', 'isp', 'var', 'vap', 'cus', 'cup', 'usr', 'usp',
] as const;

/** `<Layer>` number for a layer given by name ("cus") or number (12 / "12"); null when it is neither. */
export function layerNumber(layer: unknown): number | null {
  if (typeof layer === 'number' && Number.isInteger(layer)) {
    return layer >= 0 && layer < MODEL_LAYERS.length ? layer : null;
  }
  if (typeof layer !== 'string') return null;
  const t = layer.trim().toLowerCase();
  if (/^\d+$/.test(t)) return layerNumber(Number(t));
  const index = (MODEL_LAYERS as readonly string[]).indexOf(t);
  return index >= 0 ? index : null;
}

/** "cus (12)" for a `<Layer>` number; the bare number when it is out of range. */
export function describeLayer(layer: number | null): string {
  if (layer === null) return '(unknown)';
  const name = MODEL_LAYERS[layer];
  return name ? `${name} (${layer})` : String(layer);
}

export interface ModelVersion {
  major: number;
  minor: number;
  build: number;
  revision: number;
}

/** "1.0.0.0" → parts; missing trailing parts are 0. Null when it is not a dotted number. */
export function parseVersion(version: unknown): ModelVersion | null {
  if (typeof version !== 'string' && typeof version !== 'number') return null;
  const text = String(version).trim();
  // Each part is a descriptor int: at most 9 digits keeps it inside Int32.
  if (!/^\d{1,9}(\.\d{1,9}){0,3}$/.test(text)) return null;
  const [major, minor = 0, build = 0, revision = 0] = text.split('.').map(Number);
  return { major, minor, build, revision };
}

export function formatVersion(v: ModelVersion): string {
  return `${v.major}.${v.minor}.${v.build}.${v.revision}`;
}

/** What a descriptor says about its model. */
export interface DescriptorInfo {
  name: string;
  displayName: string;
  description: string;
  id: number | null;
  layer: number | null;
  publisher: string;
  /** `<ModelModule>` — the package (module) the model belongs to. */
  modelModule: string;
  customization: string;
  version: ModelVersion;
  moduleReferences: string[];
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function encodeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Text of a top-level scalar element, or '' when it is absent, empty or self-closing. */
function scalar(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeXml(m[1]) : '';
}

function int(xml: string, tag: string): number | null {
  const text = scalar(xml, tag).trim();
  return /^-?\d+$/.test(text) ? Number(text) : null;
}

/** Parse an `<AxModelInfo>` document; null when it is not one. */
export function parseDescriptor(xml: string): DescriptorInfo | null {
  if (!/<AxModelInfo[\s>]/.test(xml)) return null;
  const name = scalar(xml, 'Name').trim();
  if (!name) return null;
  return {
    name,
    displayName: scalar(xml, 'DisplayName'),
    description: scalar(xml, 'Description'),
    id: int(xml, 'Id'),
    layer: int(xml, 'Layer'),
    publisher: scalar(xml, 'Publisher'),
    modelModule: scalar(xml, 'ModelModule').trim(),
    customization: scalar(xml, 'Customization').trim(),
    version: {
      major: int(xml, 'VersionMajor') ?? 0,
      minor: int(xml, 'VersionMinor') ?? 0,
      build: int(xml, 'VersionBuild') ?? 0,
      revision: int(xml, 'VersionRevision') ?? 0,
    },
    moduleReferences: parseModuleReferences(xml),
  };
}

/** One descriptor found on disk. */
export interface ModelEntry extends DescriptorInfo {
  /** Packages root the descriptor was found under. */
  root: string;
  /** Package FOLDER holding the descriptor — what a `<ModuleReferences>` entry names. */
  packageName: string;
  /** `<root>/<Package>/Descriptor/<Model>.xml`. */
  descriptorPath: string;
  /** `<root>/<Package>/<Model>` — the folder the model's Ax* folders live in. */
  modelFolder: string;
}

export interface ModelInventory {
  models: ModelEntry[];
  /** Package folders under any scanned root, descriptor or not: lower-cased name → name on disk. */
  packages: Map<string, string>;
  roots: string[];
}

const eqi = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Read every `<root>/<Package>/Descriptor/*.xml` under the given roots.
 *
 * A root listed twice (or a custom root that is also the configured one) is
 * scanned once. When two roots hold a model of the same name the FIRST root
 * wins, which is the order every lookup in this server prefers them in:
 * caller's root, custom write root, configured root, Microsoft root.
 */
export function scanDescriptors(roots: Array<string | null | undefined>): ModelInventory {
  const seenRoots = new Set<string>();
  const models: ModelEntry[] = [];
  const packages = new Map<string, string>();
  const seenModels = new Set<string>();
  const used: string[] = [];

  for (const raw of roots) {
    if (!raw) continue;
    const root = path.resolve(raw);
    if (seenRoots.has(root.toLowerCase())) continue;
    seenRoots.add(root.toLowerCase());
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    used.push(root);
    for (const pkg of entries) {
      const descriptorDir = path.join(root, pkg, 'Descriptor');
      let files: string[];
      try {
        files = readdirSync(descriptorDir);
      } catch {
        // Not a package with a descriptor. Still a package folder a reference may
        // name (a binary-only package ships no Descriptor folder).
        try {
          if (statSync(path.join(root, pkg)).isDirectory() && !packages.has(pkg.toLowerCase())) packages.set(pkg.toLowerCase(), pkg);
        } catch { /* gone */ }
        continue;
      }
      if (!packages.has(pkg.toLowerCase())) packages.set(pkg.toLowerCase(), pkg);
      for (const file of files) {
        if (!file.toLowerCase().endsWith('.xml')) continue;
        const descriptorPath = path.join(descriptorDir, file);
        let info: DescriptorInfo | null;
        try {
          info = parseDescriptor(readFileSync(descriptorPath, 'utf-8'));
        } catch {
          continue;
        }
        if (!info) continue;
        const key = info.name.toLowerCase();
        if (seenModels.has(key)) continue;
        seenModels.add(key);
        models.push({
          ...info,
          root,
          packageName: pkg,
          descriptorPath,
          modelFolder: path.join(root, pkg, info.name),
        });
      }
    }
  }
  return { models, packages, roots: used };
}

export function findModel(inventory: ModelInventory, modelName: string): ModelEntry | undefined {
  return inventory.models.find(m => eqi(m.name, modelName));
}

/** Models sharing a package folder with `model` (itself excluded). */
export function packageMates(inventory: ModelInventory, model: ModelEntry): ModelEntry[] {
  return inventory.models.filter(
    m => m !== model && eqi(m.packageName, model.packageName) && eqi(m.root, model.root),
  );
}

/** Models whose `<ModuleReferences>` names `packageName` (models OF that package excluded). */
export function dependentsOfPackage(inventory: ModelInventory, packageName: string): ModelEntry[] {
  return inventory.models.filter(
    m => !eqi(m.packageName, packageName) && m.moduleReferences.some(r => eqi(r, packageName)),
  );
}

/** References of `model` that name no package folder under any scanned root. */
export function unresolvedReferences(inventory: ModelInventory, references: readonly string[]): string[] {
  return references.filter(r => !inventory.packages.has(r.toLowerCase()));
}

/**
 * Reference cycles among packages, each as the path that closes it
 * (`["A", "B", "A"]`). xppc builds packages in reference order, so a cycle is
 * a set of packages none of which can be built first.
 *
 * `extra` adds or replaces one package's references before the search — the
 * question a create or an add-module-reference asks BEFORE writing.
 */
export function findReferenceCycles(
  inventory: ModelInventory,
  extra?: { packageName: string; references: readonly string[] },
): string[][] {
  const graph = new Map<string, { label: string; refs: Set<string> }>();
  const node = (pkg: string) => {
    const key = pkg.toLowerCase();
    let n = graph.get(key);
    if (!n) {
      n = { label: pkg, refs: new Set() };
      graph.set(key, n);
    }
    return n;
  };
  for (const m of inventory.models) {
    const n = node(m.packageName);
    for (const r of m.moduleReferences) if (!eqi(r, m.packageName)) n.refs.add(r.toLowerCase());
  }
  if (extra) {
    const n = node(extra.packageName);
    for (const r of extra.references) if (!eqi(r, extra.packageName)) n.refs.add(r.toLowerCase());
  }

  const cycles: string[][] = [];
  const seenCycles = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (key: string) => {
    state.set(key, 1);
    stack.push(key);
    for (const next of graph.get(key)?.refs ?? []) {
      if (!graph.has(next)) continue;
      const s = state.get(next);
      if (s === 1) {
        const loop = stack.slice(stack.indexOf(next));
        const id = [...loop].sort().join('|');
        if (!seenCycles.has(id)) {
          seenCycles.add(id);
          cycles.push([...loop, next].map(k => graph.get(k)!.label));
        }
      } else if (s === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(key, 2);
  };
  for (const key of graph.keys()) if (!state.has(key)) visit(key);
  return cycles;
}

/**
 * Could `name` be a model (and package folder) name?
 *
 * The name becomes a folder, a file name, `<Name>`, usually `<ModelModule>`,
 * and the assembly name `Dynamics.AX.<Name>.dll` — so it is held to what all
 * of those accept: a letter first, then letters, digits and `_`.
 */
export function modelNameProblem(name: string): string | null {
  if (!name) return 'the model name is empty';
  if (name.length > 80) return 'the model name is longer than 80 characters';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) return 'a Windows device name cannot be a folder name';
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    return 'a model name starts with a letter and holds only letters, digits and "_" ' +
      '(it becomes a folder, a file and an assembly name)';
  }
  if (!isValidModuleReferenceName(name)) return 'the model name is not a valid package folder name';
  return null;
}

/**
 * Model ids Visual Studio hands out for new models sit in this band (the
 * custom models observed beside a 10.0 PackagesLocalDirectory are 895,9xx,xxx
 * to 896,0xx,xxx); Microsoft's own are far below it.
 */
export const MODEL_ID_MIN = 895_000_000;
export const MODEL_ID_MAX = 896_999_999;

/**
 * An Id no visible descriptor uses.
 *
 * Only as good as what is visible: a model that exists in another repository
 * or branch and is not on this box cannot be seen, so the reply that reports
 * the Id says so.
 */
export function allocateModelId(usedIds: Iterable<number>, random: () => number = Math.random): number {
  const used = new Set(usedIds);
  const span = MODEL_ID_MAX - MODEL_ID_MIN + 1;
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = MODEL_ID_MIN + Math.floor(random() * span);
    if (!used.has(candidate)) return candidate;
  }
  for (let candidate = MODEL_ID_MIN; candidate <= MODEL_ID_MAX; candidate++) {
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('no free model Id in the custom range');
}

export interface NewDescriptorSpec {
  name: string;
  displayName: string;
  description: string;
  id: number;
  layer: number;
  publisher: string;
  modelModule: string;
  version: ModelVersion;
  moduleReferences: readonly string[];
}

const ARRAYS_NS = 'xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays"';

/**
 * A new descriptor, in the shape Visual Studio writes one: elements in
 * alphabetical order (the data-contract serializer's), two-space indent, and
 * the arrays namespace declared on each list element. Returned with LF line
 * ends and no BOM — the writer adds both, as it does for every descriptor.
 *
 * References are written sorted, the convention the custom descriptors a
 * write targets keep (see addModuleReference).
 */
export function buildDescriptorXml(spec: NewDescriptorSpec): string {
  const refs = [...new Set(spec.moduleReferences.map(r => r.trim()).filter(Boolean))]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const moduleReferences = refs.length
    ? [
        `  <ModuleReferences ${ARRAYS_NS}>`,
        ...refs.map(r => `    <d2p1:string>${encodeXml(r)}</d2p1:string>`),
        `  </ModuleReferences>`,
      ]
    : [`  <ModuleReferences ${ARRAYS_NS} />`];
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<AxModelInfo xmlns:i="http://www.w3.org/2001/XMLSchema-instance">`,
    `  <AppliedUpdates ${ARRAYS_NS} />`,
    `  <Customization>Allow</Customization>`,
    `  <Description>${encodeXml(spec.description)}</Description>`,
    `  <DisplayName>${encodeXml(spec.displayName)}</DisplayName>`,
    `  <Id>${spec.id}</Id>`,
    `  <Layer>${spec.layer}</Layer>`,
    `  <Locked>false</Locked>`,
    `  <ModelModule>${encodeXml(spec.modelModule)}</ModelModule>`,
    `  <ModelReferences ${ARRAYS_NS} i:nil="true" />`,
    ...moduleReferences,
    `  <Name>${encodeXml(spec.name)}</Name>`,
    `  <Publisher>${encodeXml(spec.publisher)}</Publisher>`,
    `  <VersionBuild>${spec.version.build}</VersionBuild>`,
    `  <VersionMajor>${spec.version.major}</VersionMajor>`,
    `  <VersionMinor>${spec.version.minor}</VersionMinor>`,
    `  <VersionRevision>${spec.version.revision}</VersionRevision>`,
    `</AxModelInfo>`,
  ].join('\n');
}

/** Descriptor properties modify-property may change, keyed lower-case → the element(s) written. */
const EDITABLE_SCALARS: Record<string, string> = {
  description: 'Description',
  displayname: 'DisplayName',
  publisher: 'Publisher',
  layer: 'Layer',
  versionmajor: 'VersionMajor',
  versionminor: 'VersionMinor',
  versionbuild: 'VersionBuild',
  versionrevision: 'VersionRevision',
};

/** What modify-property accepts on a descriptor, for messages and the op-spec. */
export const EDITABLE_DESCRIPTOR_PROPERTIES = [
  'Description', 'DisplayName', 'Publisher', 'Layer', 'Version',
  'VersionMajor', 'VersionMinor', 'VersionBuild', 'VersionRevision',
] as const;

/** Why a property is refused, for the ones a caller is most likely to try. */
const REFUSED_PROPERTIES: Record<string, string> = {
  name: 'Name is the model\'s identity (file, folder, references from other models) — changing it is a rename, which this server does not perform',
  modelmodule: 'ModelModule is the package the model lives in — changing it moves the model between packages, which this server does not perform',
  id: 'Id identifies the model in every environment it is installed in — it is assigned once, at creation',
  modulereferences: 'use operation="add-module-reference" / "remove-module-reference"',
  customization: 'Customization is not edited by this server',
  locked: 'Locked is not edited by this server',
};

export type SetPropertyResult =
  | { kind: 'changed'; xml: string; changes: Array<{ element: string; from: string; to: string }> }
  | { kind: 'unchanged'; element: string; value: string }
  | { kind: 'refused'; reason: string };

/** Replace the text of one existing scalar element, or insert it in alphabetical position. */
function writeScalar(xml: string, element: string, value: string): { xml: string; from: string } {
  const encoded = encodeXml(value);
  const paired = new RegExp(`<${element}>([\\s\\S]*?)</${element}>`).exec(xml);
  if (paired) {
    return {
      xml: xml.slice(0, paired.index) + `<${element}>${encoded}</${element}>` + xml.slice(paired.index + paired[0].length),
      from: decodeXml(paired[1]),
    };
  }
  const empty = new RegExp(`<${element}\\s*/>`).exec(xml);
  if (empty) {
    return {
      xml: xml.slice(0, empty.index) + `<${element}>${encoded}</${element}>` + xml.slice(empty.index + empty[0].length),
      from: '',
    };
  }
  // Absent (Microsoft's older descriptors omit elements): insert before the first
  // top-level element that sorts after it, keeping the serializer's order.
  const lineRe = /\n([\t ]*)<([A-Za-z]+)[\s>/]/g;
  let match: RegExpExecArray | null;
  let insertAt = -1;
  let indent = '  ';
  let depthIndent: string | null = null;
  while ((match = lineRe.exec(xml))) {
    if (match[2] === 'AxModelInfo') continue;
    if (depthIndent === null) depthIndent = match[1];
    if (match[1] !== depthIndent) continue;
    indent = match[1];
    if (match[2].localeCompare(element) > 0) {
      insertAt = match.index;
      break;
    }
  }
  if (insertAt < 0) insertAt = xml.lastIndexOf('\n</AxModelInfo>');
  if (insertAt < 0) return { xml, from: '' };
  return {
    xml: xml.slice(0, insertAt) + `\n${indent}<${element}>${encoded}</${element}>` + xml.slice(insertAt),
    from: '',
  };
}

/**
 * Set one descriptor property. `Version` takes a dotted "1.2.0.0" and writes
 * the four Version* elements; `Layer` takes a name or a number.
 */
export function setDescriptorProperty(xml: string, property: string, rawValue: string): SetPropertyResult {
  const key = property.trim().toLowerCase();
  if (REFUSED_PROPERTIES[key]) return { kind: 'refused', reason: REFUSED_PROPERTIES[key] };
  if (!/<AxModelInfo[\s>]/.test(xml)) return { kind: 'refused', reason: 'the file is not an <AxModelInfo> descriptor' };

  const targets: Array<[string, string]> = [];
  if (key === 'version') {
    const v = parseVersion(rawValue);
    if (!v) return { kind: 'refused', reason: `Version takes a dotted number such as "1.2.0.0" — got ${JSON.stringify(rawValue)}` };
    targets.push(['VersionMajor', String(v.major)], ['VersionMinor', String(v.minor)],
      ['VersionBuild', String(v.build)], ['VersionRevision', String(v.revision)]);
  } else {
    const element = EDITABLE_SCALARS[key];
    if (!element) {
      return {
        kind: 'refused',
        reason: `"${property}" is not an editable descriptor property. Editable: ${EDITABLE_DESCRIPTOR_PROPERTIES.join(', ')}`,
      };
    }
    let value = rawValue;
    if (element === 'Layer') {
      const layer = layerNumber(rawValue);
      if (layer === null) {
        return { kind: 'refused', reason: `Layer takes one of ${MODEL_LAYERS.join(', ')} or its number 0-15 — got ${JSON.stringify(rawValue)}` };
      }
      value = String(layer);
    } else if (element.startsWith('Version')) {
      if (!/^\d+$/.test(rawValue.trim())) {
        return { kind: 'refused', reason: `${element} takes a non-negative whole number — got ${JSON.stringify(rawValue)}` };
      }
      value = String(Number(rawValue.trim()));
    } else if (/[\r\n]/.test(value)) {
      return { kind: 'refused', reason: `${element} must be a single line` };
    } else if (element !== 'Description' && !value.trim()) {
      return { kind: 'refused', reason: `${element} cannot be empty` };
    }
    targets.push([element, value]);
  }

  let out = xml;
  const changes: Array<{ element: string; from: string; to: string }> = [];
  for (const [element, value] of targets) {
    const written = writeScalar(out, element, value);
    if (written.from === value) continue;
    changes.push({ element, from: written.from, to: value });
    out = written.xml;
  }
  if (changes.length === 0) {
    return { kind: 'unchanged', element: targets.map(t => t[0]).join(', '), value: rawValue };
  }
  return { kind: 'changed', xml: out, changes };
}

/**
 * Is this one of Microsoft's own models? By its descriptor: the publisher is Microsoft, or the layer
 * is below isv. Shared by the reader and every writer so they cannot disagree about what is protected.
 */
export function isMicrosoftModel(model: { publisher: string; layer: number | null }): boolean {
  return /^\s*microsoft(\s+corp(oration|\.)?)?\s*$/i.test(model.publisher) || (model.layer !== null && model.layer < 8);
}

/** Does this folder exist as a directory? */
export function isDirectory(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}
