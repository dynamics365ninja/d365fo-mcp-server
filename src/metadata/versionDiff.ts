/**
 * API surface diff between two versions of a model — "what changed in this ISV (or in a
 * Microsoft model) between update A and update B" — computed from two extracted-metadata
 * directories (`<dir>/<Model>/{classes,tables,edts,enums}/*.json`, what `extract-metadata`
 * and `extract-binary-models` write). Signatures only: the diff never looks at method bodies
 * except for the attribute lines in front of a declaration.
 *
 * Both sources of those directories are read the same way, so a source model and a binary
 * ISV model can be compared with each other, or each with its own earlier version.
 *
 * What counts as the signature of a method: visibility, `static`, return type, name and the
 * parameters (type, name, default), plus its attributes. An attribute-only change (a new
 * `[SysObsolete]`, a `[SuppressBPWarning]`) is reported as changed too, but `SysObsolete` is
 * also broken out on its own because it is the one an update check acts on.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface MethodChange {
  class: string;
  method: string;
  before: string;
  after: string;
}

export interface ModelDiff {
  model: string;
  classesAdded: string[];
  classesRemoved: string[];
  /** Class-level change: base class, modifiers or attributes. */
  classesChanged: Array<{ class: string; before: string; after: string }>;
  methodsAdded: string[];
  methodsRemoved: string[];
  methodsChanged: MethodChange[];
  /** Methods and classes that gained `[SysObsolete]` (`Class.method` or `Class`). */
  newlyObsolete: string[];
  tablesAdded: string[];
  tablesRemoved: string[];
  fieldsAdded: string[];
  fieldsRemoved: string[];
  fieldsChanged: Array<{ field: string; before: string; after: string }>;
  edtsAdded: string[];
  edtsRemoved: string[];
  edtsChanged: Array<{ edt: string; before: string; after: string }>;
  enumsAdded: string[];
  enumsRemoved: string[];
  enumValuesAdded: string[];
  enumValuesRemoved: string[];
}

export interface RawMethod {
  name?: string;
  visibility?: string;
  returnType?: string;
  isStatic?: boolean;
  parameters?: Array<{ name: string; type: string; defaultValue?: string }>;
  /** Present on binary-ISV methods, already rendered (`[Hookable(False)]`). */
  attributes?: string[];
  /** Binary-ISV modifiers; a source method states them in its declaration line. */
  isFinal?: boolean;
  isDelegate?: boolean;
  parametersUnknown?: boolean;
  source?: string;
}

export interface RawClass {
  name?: string;
  sourcePath?: string;
  model?: string;
  extends?: string;
  implements?: string[];
  extensionOf?: { baseObjectName: string; baseKind: string; memberName?: string };
  /** Binary-ISV classes: the compiler's record of the methods this extension class wraps. */
  chainOfCommand?: { target?: string; targetType?: string; wrapped?: string[] };
  isAbstract?: boolean;
  isFinal?: boolean;
  visibility?: string;
  declaration?: string;
  methods?: RawMethod[];
}

export interface RawTable {
  name?: string;
  /** The base table; source tables carry it only in the stored XML (`raw`). */
  extends?: string;
  raw?: string;
  sourcePath?: string;
  methods?: RawMethod[];
  fields?: Array<{ name: string; type?: string; extendedDataType?: string; enumType?: string }>;
}

export interface RawEdt {
  name?: string;
  extends?: string;
  baseType?: string;
  stringSize?: number;
}

export interface RawEnum {
  name?: string;
  values?: Array<{ name: string }>;
  /** Source enums are stored as their XML only. */
  raw?: string;
}

export interface ModelSnapshot {
  model: string;
  classes: RawClass[];
  tables: RawTable[];
  edts: RawEdt[];
  enums: RawEnum[];
}

/** Model folders of an extracted-metadata directory. */
export function listModels(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() || e.isSymbolicLink())
    .map(e => e.name)
    .filter(n => ['classes', 'tables', 'edts', 'enums'].some(sub => fs.existsSync(path.join(dir, n, sub))));
}

function readFolder<T>(dir: string): T[] {
  if (!fs.existsSync(dir)) return [];
  const out: T[] = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
    out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as T);
  }
  return out;
}

export function loadModelSnapshot(metadataDir: string, model: string): ModelSnapshot {
  const base = path.join(metadataDir, model);
  return {
    model,
    classes: readFolder<RawClass>(path.join(base, 'classes')),
    tables: readFolder<RawTable>(path.join(base, 'tables')),
    edts: readFolder<RawEdt>(path.join(base, 'edts')),
    enums: readFolder<RawEnum>(path.join(base, 'enums')),
  };
}

/** `[A(x)]`-style attribute lines in front of a declaration; empty when the text starts with the modifiers. */
export function leadingAttributes(text: string | undefined): string[] {
  if (!text) return [];
  const attrs: string[] = [];
  // Attributes may share a line (`[A][B] public void f()`) and carry brackets inside their arguments.
  const head = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l));
  const joined = head.join('\n').trimStart();
  const re = /^\[((?:[^[\]"']|"[^"]*"|'[^']*'|\[[^\]]*\])*)\]\s*/;
  let rest = joined;
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    attrs.push(`[${m[1].trim()}]`);
    rest = rest.slice(m[0].length);
  }
  return attrs;
}

export const isObsolete = (attrs: string[]): boolean => attrs.some(a => /^\[\s*SysObsolete\b/i.test(a));

export function methodAttributes(m: RawMethod): string[] {
  return m.attributes ?? leadingAttributes(m.source);
}

/** Canonical one-line form of a method, used for equality and for the report. */
export function canonicalMethod(m: RawMethod): string {
  const attrs = methodAttributes(m).slice().sort().join('');
  const mods = [m.visibility ?? 'public', m.isStatic ? 'static' : ''].filter(Boolean).join(' ');
  const params = (m.parameters ?? [])
    .map(p => `${p.type} ${p.name}${p.defaultValue ? ` = ${p.defaultValue}` : ''}`)
    .join(', ');
  return `${attrs ? `${attrs} ` : ''}${mods} ${m.returnType ?? 'void'} ${m.name}(${params})`;
}

function classHeader(c: RawClass): string {
  const attrs = leadingAttributes(c.declaration).slice().sort().join('');
  return [
    c.visibility === 'internal' ? 'internal' : '',
    c.isFinal ? 'final' : '',
    c.isAbstract ? 'abstract' : '',
    `extends ${c.extends ?? '-'}`,
    attrs,
  ]
    .filter(Boolean)
    .join(' ');
}

const byName = <T extends { name?: string }>(xs: T[]): Map<string, T> =>
  new Map(xs.filter(x => x.name).map(x => [x.name as string, x]));

function setDiff<T>(a: Map<string, T>, b: Map<string, T>): { added: string[]; removed: string[]; common: string[] } {
  return {
    added: [...b.keys()].filter(k => !a.has(k)).sort(),
    removed: [...a.keys()].filter(k => !b.has(k)).sort(),
    common: [...a.keys()].filter(k => b.has(k)).sort(),
  };
}

function enumValueNames(e: RawEnum): string[] {
  if (e.values) return e.values.map(v => v.name);
  return [...(e.raw ?? '').matchAll(/<AxEnumValue[^>]*>[\s\S]*?<Name>([^<]+)<\/Name>/g)].map(m => m[1]);
}

export function diffSnapshots(from: ModelSnapshot, to: ModelSnapshot): ModelDiff {
  const out: ModelDiff = {
    model: to.model,
    classesAdded: [],
    classesRemoved: [],
    classesChanged: [],
    methodsAdded: [],
    methodsRemoved: [],
    methodsChanged: [],
    newlyObsolete: [],
    tablesAdded: [],
    tablesRemoved: [],
    fieldsAdded: [],
    fieldsRemoved: [],
    fieldsChanged: [],
    edtsAdded: [],
    edtsRemoved: [],
    edtsChanged: [],
    enumsAdded: [],
    enumsRemoved: [],
    enumValuesAdded: [],
    enumValuesRemoved: [],
  };

  const ca = byName(from.classes);
  const cb = byName(to.classes);
  const cd = setDiff(ca, cb);
  out.classesAdded = cd.added;
  out.classesRemoved = cd.removed;
  for (const cn of cd.common) {
    const a = ca.get(cn) as RawClass;
    const b = cb.get(cn) as RawClass;
    const ha = classHeader(a);
    const hb = classHeader(b);
    if (ha !== hb) out.classesChanged.push({ class: cn, before: ha, after: hb });
    if (isObsolete(leadingAttributes(b.declaration)) && !isObsolete(leadingAttributes(a.declaration)))
      out.newlyObsolete.push(cn);
    const ma = byName(a.methods ?? []);
    const mb = byName(b.methods ?? []);
    const md = setDiff(ma, mb);
    out.methodsAdded.push(...md.added.map(m => `${cn}.${m}`));
    out.methodsRemoved.push(...md.removed.map(m => `${cn}.${m}`));
    for (const mn of md.common) {
      const x = ma.get(mn) as RawMethod;
      const y = mb.get(mn) as RawMethod;
      const sa = canonicalMethod(x);
      const sb = canonicalMethod(y);
      if (sa === sb) continue;
      out.methodsChanged.push({ class: cn, method: mn, before: sa, after: sb });
      if (isObsolete(methodAttributes(y)) && !isObsolete(methodAttributes(x))) out.newlyObsolete.push(`${cn}.${mn}`);
    }
  }

  const ta = byName(from.tables);
  const tb = byName(to.tables);
  const td = setDiff(ta, tb);
  out.tablesAdded = td.added;
  out.tablesRemoved = td.removed;
  for (const tn of td.common) {
    // Table methods are diffed like class methods: a table that stops declaring one is a change of the table.
    const tma = byName((ta.get(tn) as RawTable).methods ?? []);
    const tmb = byName((tb.get(tn) as RawTable).methods ?? []);
    const tmd = setDiff(tma, tmb);
    out.methodsAdded.push(...tmd.added.map(m => `${tn}.${m}`));
    out.methodsRemoved.push(...tmd.removed.map(m => `${tn}.${m}`));
    for (const mn of tmd.common) {
      const x = tma.get(mn) as RawMethod;
      const y = tmb.get(mn) as RawMethod;
      const sa = canonicalMethod(x);
      const sb = canonicalMethod(y);
      if (sa === sb) continue;
      out.methodsChanged.push({ class: tn, method: mn, before: sa, after: sb });
      if (isObsolete(methodAttributes(y)) && !isObsolete(methodAttributes(x))) out.newlyObsolete.push(`${tn}.${mn}`);
    }
    const fa = byName((ta.get(tn) as RawTable).fields ?? []);
    const fb = byName((tb.get(tn) as RawTable).fields ?? []);
    const fd = setDiff(fa, fb);
    out.fieldsAdded.push(...fd.added.map(f => `${tn}.${f}`));
    out.fieldsRemoved.push(...fd.removed.map(f => `${tn}.${f}`));
    for (const f of fd.common) {
      const a = fa.get(f) as NonNullable<RawTable['fields']>[number];
      const b = fb.get(f) as NonNullable<RawTable['fields']>[number];
      const sa = `${a.type ?? ''} ${a.extendedDataType ?? a.enumType ?? ''}`.trim();
      const sb = `${b.type ?? ''} ${b.extendedDataType ?? b.enumType ?? ''}`.trim();
      if (sa !== sb) out.fieldsChanged.push({ field: `${tn}.${f}`, before: sa, after: sb });
    }
  }

  const ea = byName(from.edts);
  const eb = byName(to.edts);
  const ed = setDiff(ea, eb);
  out.edtsAdded = ed.added;
  out.edtsRemoved = ed.removed;
  for (const en of ed.common) {
    const a = ea.get(en) as RawEdt;
    const b = eb.get(en) as RawEdt;
    const sa = `extends ${a.extends ?? '-'}${a.stringSize !== undefined ? ` size ${a.stringSize}` : ''}`;
    const sb = `extends ${b.extends ?? '-'}${b.stringSize !== undefined ? ` size ${b.stringSize}` : ''}`;
    if (sa !== sb) out.edtsChanged.push({ edt: en, before: sa, after: sb });
  }

  const na = byName(from.enums);
  const nb = byName(to.enums);
  const nd = setDiff(na, nb);
  out.enumsAdded = nd.added;
  out.enumsRemoved = nd.removed;
  for (const en of nd.common) {
    const va = new Set(enumValueNames(na.get(en) as RawEnum));
    const vb = new Set(enumValueNames(nb.get(en) as RawEnum));
    out.enumValuesAdded.push(...[...vb].filter(v => !va.has(v)).map(v => `${en}.${v}`));
    out.enumValuesRemoved.push(...[...va].filter(v => !vb.has(v)).map(v => `${en}.${v}`));
  }
  return out;
}

export function isEmptyDiff(d: ModelDiff): boolean {
  return Object.entries(d).every(([k, v]) => !Array.isArray(v) || v.length === 0 || k === 'model');
}

export interface MethodFlags {
  final: boolean;
  delegate: boolean;
  abstract: boolean;
}

/** `final`/`delegate`/`abstract` of a method: the stored flags for a binary model, the declaration line for source. */
export function methodFlags(m: RawMethod): MethodFlags {
  if (m.attributes !== undefined || m.isFinal !== undefined || m.isDelegate !== undefined) {
    return { final: !!m.isFinal, delegate: !!m.isDelegate, abstract: false };
  }
  const text = (m.source ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n').filter(l => l.trim() && !/^\s*(\/\/|\/\*|\*|\[)/.test(l));
  const head = (lines[0] ?? '').split('(')[0];
  return { final: /\bfinal\b/.test(head), delegate: /\bdelegate\b/.test(head), abstract: /\babstract\b/.test(head) };
}
