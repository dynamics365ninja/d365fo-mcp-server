/**
 * Binary ISV models — conversion of a `BinaryModelExtractor` dump into the per-object JSON
 * the index build already reads (`classes/`, `class-extensions/`, `tables/`, `edts/`, `enums/`).
 *
 * A BINARY model (compiled DLL/netmodule only, no AxClass/AxTable XML) cannot be read by
 * `extract-metadata`, which walks `<Package>/<Model>/Ax*` XML folders. The C# extractor
 * (`bridge/BinaryModelExtractor`) reads it through Microsoft's runtime metadata provider
 * instead. This module turns its output into the existing JSON shapes, so every downstream
 * consumer — symbol search, exact signatures, validate_code references — works unchanged.
 *
 * Invariants:
 *  - SIGNATURES ONLY. `source` is always '' (a binary model has no X++ bodies, and none is
 *    fabricated); `raw` is never set, so no object source is stored.
 *  - Every object carries `binaryIsv`, and its description/tags say "binary ISV, signatures
 *    only", so a reader never mistakes the entry for an indexed source model.
 */

import type { XppClassInfo, XppMethodInfo, XppTableInfo, XppFieldInfo } from './types.js';
import { buildClassExtensionRecord, type XppClassExtensionRecord } from './xmlParser.js';
import { parseExtensionOfAttribute, parseXppClassHeader, type XppVisibility } from './xppDeclaration.js';

export const BINARY_ISV_NOTE = 'binary ISV, signatures only';

/** Module name the extractor gives the objects the provider serves from StaticMetadata (Common, xRecord, Object, ...). */
export const KERNEL_MODEL = 'Kernel';

// ---- extractor dump shapes (BinaryModelExtractor/Program.cs, JSON is PascalCase) ----

export interface DumpAttr {
  Name: string;
  Args?: string[];
}
export interface DumpParam {
  Name: string;
  Type: string;
  Kind?: string;
  DefaultValue?: string;
}
export interface DumpMethod {
  Name: string;
  Visibility?: string;
  IsStatic?: boolean;
  IsAbstract?: boolean;
  IsFinal?: boolean;
  IsDelegate?: boolean;
  IsDisplay?: boolean;
  IsEdit?: boolean;
  IsExtended?: boolean;
  ReturnType?: string;
  Parameters?: DumpParam[];
  Attributes?: DumpAttr[];
  EventHandlers?: string[];
  Doc?: string;
}
export interface DumpClass {
  Name: string;
  Extends?: string;
  Implements?: string[];
  IsAbstract?: boolean;
  IsFinal?: boolean;
  IsInterface?: boolean;
  IsStatic?: boolean;
  IsInternal?: boolean;
  IsPublic?: boolean;
  IsPrivate?: boolean;
  IsObsolete?: boolean;
  Declaration?: string;
  Attributes?: DumpAttr[];
  Methods?: DumpMethod[];
}
export interface DumpField {
  Name: string;
  Type?: string;
  Edt?: string;
  EnumType?: string;
  Mandatory?: boolean;
  Label?: string;
  StringSize?: number;
}
export interface DumpTable {
  Name: string;
  Label?: string;
  TableGroup?: string;
  PrimaryIndex?: string;
  ClusteredIndex?: string;
  Extends?: string;
  IsObsolete?: boolean;
  TableType?: string;
  Fields?: DumpField[];
  Methods?: DumpMethod[];
  Indexes?: Array<{ Name: string; Unique?: boolean; Fields?: string[] }>;
  Relations?: Array<{
    Name: string;
    RelatedTable: string;
    Constraints?: Array<{ Field: string; RelatedField: string }>;
  }>;
}
export interface DumpEdt {
  Name: string;
  Extends?: string;
  Label?: string;
  BaseType?: string;
  ReferenceTable?: string;
  StringSize?: number;
}
export interface DumpEnum {
  Name: string;
  Label?: string;
  IsExtensible?: boolean;
  Values?: Array<{ Name: string; Value: number; Label?: string }>;
}
export interface DumpCocMethod {
  Name: string;
  IsStatic?: boolean;
  Owner?: string;
  NestedKind?: string;
  RootForm?: string;
}
export interface DumpCocClass {
  Class: string;
  Target?: string;
  TargetType?: string;
  Methods?: DumpCocMethod[];
}
export interface DumpPlatform {
  ProviderFileVersion?: string;
  PackagesPath?: string;
  Modules?: Record<string, string>;
  MissingModules?: string[];
}
export interface DumpUnresolved {
  Checked: number;
  Count: number;
  Examples?: string[];
}
export interface BinaryModelDump {
  Model: string;
  ModelInfo?: Record<string, string>;
  ProviderFileVersion?: string;
  Classes?: DumpClass[];
  Tables?: DumpTable[];
  Edts?: DumpEdt[];
  Enums?: DumpEnum[];
  /** Chain-of-command wraps recorded by the X++ compiler (bin\Dynamics.AX.<Module>.ChainOfCommand.xml). */
  ChainOfCommand?: DumpCocClass[];
  Platform?: DumpPlatform;
  Unresolved?: DumpUnresolved;
  Errors?: string[];
  /** Object counts exported as AOT XML (AxForm, AxQuery, ...). */
  Exported?: Record<string, number>;
  /** Label texts exported per language. */
  Labels?: Record<string, number>;
}

export interface BinaryIsvInfo {
  kind: 'binary-isv';
  vendor?: string;
  version?: string;
  moduleName: string;
  displayName?: string;
  providerFileVersion?: string;
  /** Platform the model was read with (application module versions). */
  platform?: Record<string, string>;
}

/** On-disk model name: the package/module identifier, falling back to the display name. */
export function binaryModelName(d: BinaryModelDump): string {
  return (d.ModelInfo?.Module || d.Model).replace(/[\\/:*?"<>|]/g, '_');
}

export function binaryIsvInfo(d: BinaryModelDump): BinaryIsvInfo {
  const mi = d.ModelInfo ?? {};
  const v = [mi.VersionMajor, mi.VersionMinor, mi.VersionBuild, mi.VersionRevision];
  return {
    kind: 'binary-isv',
    vendor: mi.Publisher || undefined,
    version: v.every(x => x !== undefined) ? v.join('.') : undefined,
    moduleName: binaryModelName(d),
    displayName: mi.DisplayName || d.Model,
    providerFileVersion: d.ProviderFileVersion,
    platform: d.Platform?.Modules && Object.keys(d.Platform.Modules).length ? d.Platform.Modules : undefined,
  };
}

// ---- platform / ISV compatibility ----

export interface BinaryCompat {
  level: 'ok' | 'warn' | 'error';
  messages: string[];
}

/** Above this share of unresolved references the ISV was almost certainly built for another application version. */
export const UNRESOLVED_ERROR_RATIO = 0.25;

/**
 * Is the platform we READ the model with the one it was built against? The compiled model carries no
 * platform build stamp, so the check is on what the provider can resolve: every application module the
 * ISV references must be present, and the base classes / EDTs / enums / related tables its objects point at
 * must exist. A model compiled against a newer application references things an older one lacks.
 */
export function checkBinaryCompat(d: BinaryModelDump): BinaryCompat {
  const messages: string[] = [];
  let level: BinaryCompat['level'] = 'ok';
  const raise = (l: BinaryCompat['level']) => {
    if (l === 'error' || level === 'ok') level = l;
  };
  const plat = d.Platform;
  const where = `platform ${plat?.ProviderFileVersion ?? '?'}${plat?.Modules?.ApplicationSuite ? `, ApplicationSuite ${plat.Modules.ApplicationSuite}` : ''}`;
  const missing = plat?.MissingModules ?? [];
  const u = d.Unresolved;
  if (missing.length) {
    raise('warn');
    messages.push(
      `${d.Model}: references modules missing from the packages path (${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', ...' : ''}); base types cannot be verified (${where}). Point --packages-path at a full PackagesLocalDirectory.`,
    );
  } else if (u && u.Checked > 0 && u.Count > 0) {
    const ratio = u.Count / u.Checked;
    raise(ratio > UNRESOLVED_ERROR_RATIO ? 'error' : 'warn');
    messages.push(
      `${d.Model}: ${u.Count} of ${u.Checked} references point at objects absent from the ${where} (e.g. ${(u.Examples ?? []).slice(0, 3).join('; ')}). The model was probably built against another application version.`,
    );
  }
  if (d.Errors?.length) {
    raise('warn');
    messages.push(
      `${d.Model}: ${d.Errors.length} object(s) could not be read by the provider (first: ${d.Errors[0]}).`,
    );
  }
  if (!messages.length)
    messages.push(`${d.Model}: compatible with ${where}${u ? ` (${u.Checked} references resolved)` : ''}.`);
  return { level, messages };
}

function vis(v?: string): XppVisibility {
  return v === 'private' || v === 'protected' || v === 'internal' ? v : 'public';
}

/** `[Hookable(False)]`-style rendering of the attributes an extension author must know about. */
export function renderAttr(a: DumpAttr): string {
  const args = (a.Args ?? []).filter(x => x !== undefined && x !== '');
  const name = a.Name.replace(/Attribute$/, '');
  return args.length ? `[${name}(${args.join(', ')})]` : `[${name}]`;
}

/** Extensibility facts derived from attributes + modifiers (no source needed). */
export function methodFacts(m: DumpMethod): string[] {
  const tags = ['binary-isv'];
  const names = new Set((m.Attributes ?? []).map(a => a.Name.replace(/Attribute$/, '').toLowerCase()));
  for (const n of ['hookable', 'wrappable', 'replaceable', 'sysobsolete', 'subscribesto', 'extensionof']) {
    if (names.has(n)) tags.push(n);
  }
  if (m.IsFinal) tags.push('final');
  if (m.IsStatic) tags.push('static');
  if (m.IsAbstract) tags.push('abstract');
  if (m.IsDelegate) tags.push('delegate');
  if (m.IsDisplay) tags.push('display');
  if (m.IsEdit) tags.push('edit');
  tags.push(vis(m.Visibility));
  return tags;
}

export function toMethodInfo(m: DumpMethod): XppMethodInfo & Record<string, unknown> {
  const attrs = (m.Attributes ?? []).map(renderAttr);
  const mods = [
    vis(m.Visibility),
    m.IsStatic ? 'static' : '',
    m.IsFinal ? 'final' : '',
    m.IsAbstract ? 'abstract' : '',
    m.IsDelegate ? 'delegate' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const doc = [
    `${BINARY_ISV_NOTE}.`,
    attrs.length ? `Attributes: ${attrs.join(' ')}.` : '',
    `Modifiers: ${mods}.`,
    m.Doc ? m.Doc : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    name: m.Name,
    visibility: vis(m.Visibility),
    returnType: m.ReturnType || 'void',
    parameters: (m.Parameters ?? []).map(p => ({
      name: p.Name,
      type: p.Type,
      ...(p.DefaultValue ? { defaultValue: p.DefaultValue } : {}),
    })),
    isStatic: !!m.IsStatic,
    source: '', // a binary model has no X++ bodies
    documentation: doc,
    tags: methodFacts(m),
    // extra, not read by the index today; kept for tools/diffs
    isFinal: !!m.IsFinal,
    isAbstract: !!m.IsAbstract,
    isDelegate: !!m.IsDelegate,
    attributes: attrs,
    eventHandlers: m.EventHandlers?.length ? m.EventHandlers : undefined,
  };
}

/** First `/// <summary>` paragraph of a declaration, flattened. */
export function summaryFromDeclaration(decl?: string): string | undefined {
  if (!decl) return undefined;
  const m = /\/\/\/\s*<summary>([\s\S]*?)\/\/\/\s*<\/summary>/i.exec(decl);
  if (!m) return undefined;
  const s = m[1]
    .split(/\r?\n/)
    .map(l => l.replace(/^\s*\/\/\/\s?/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  return s || undefined;
}

export function sourcePathFor(info: BinaryIsvInfo, folder: string, name: string): string {
  return `binary-isv://${info.moduleName}/${folder}/${name}`;
}

export function toClassInfo(c: DumpClass, model: string, info: BinaryIsvInfo): XppClassInfo & Record<string, unknown> {
  const decl = c.Declaration ?? '';
  const header = parseXppClassHeader(decl);
  const extensionOf = parseExtensionOfAttribute(decl) ?? undefined;
  const attrs = (c.Attributes ?? []).map(renderAttr);
  const summary = summaryFromDeclaration(decl);
  const ext = c.Extends || header?.extends || undefined;
  const base: XppClassInfo = {
    name: c.Name,
    model,
    sourcePath: sourcePathFor(info, 'AxClass', c.Name),
    extends: ext,
    implements: c.Implements?.length ? c.Implements : (header?.implements ?? []),
    isAbstract: !!c.IsAbstract,
    isFinal: !!c.IsFinal,
    visibility: c.IsInternal ? 'internal' : header?.visibility,
    declaration: decl,
    extensionOf,
    methods: (c.Methods ?? []).map(toMethodInfo),
  };
  const kind = c.IsInterface ? 'interface' : 'class';
  return {
    ...base,
    tags: [
      'binary-isv',
      ...(extensionOf ? ['class-extension'] : []),
      ...(c.IsFinal ? ['final'] : []),
      ...(c.IsAbstract ? ['abstract'] : []),
    ],
    description: [
      `${c.Name} ${kind}${ext ? ` extending ${ext}` : ''} (${BINARY_ISV_NOTE}; ${info.vendor ?? 'vendor'} ${model}${info.version ? ' ' + info.version : ''}).`,
      summary ?? '',
      attrs.length ? `Attributes: ${attrs.join(' ')}.` : '',
    ]
      .filter(Boolean)
      .join(' '),
    binaryIsv: info,
  };
}

export function toTableInfo(t: DumpTable, model: string, info: BinaryIsvInfo): XppTableInfo & Record<string, unknown> {
  const clustered = t.ClusteredIndex;
  const fields: XppFieldInfo[] = (t.Fields ?? []).map(f => ({
    name: f.Name,
    type: f.Type ?? 'String',
    extendedDataType: f.Edt,
    enumType: f.EnumType,
    mandatory: !!f.Mandatory,
    label: f.Label,
  }));
  return {
    name: t.Name,
    model,
    sourcePath: sourcePathFor(info, 'AxTable', t.Name),
    label: t.Label || t.Name,
    tableGroup: t.TableGroup || 'Main',
    primaryIndex: t.PrimaryIndex,
    extends: t.Extends,
    clusteredIndex: clustered,
    fields,
    indexes: (t.Indexes ?? []).map(i => ({
      name: i.Name,
      fields: i.Fields ?? [],
      unique: !!i.Unique,
      clustered: i.Name === clustered,
    })),
    relations: (t.Relations ?? []).map(r => ({
      name: r.Name,
      relatedTable: r.RelatedTable,
      constraints: (r.Constraints ?? []).map(c => ({ field: c.Field, relatedField: c.RelatedField })),
    })),
    methods: (t.Methods ?? []).map(toMethodInfo),
    binaryIsv: info,
    description: `${t.Name} table (${BINARY_ISV_NOTE}).`,
  };
}

export function toEdtInfo(e: DumpEdt, model: string, info: BinaryIsvInfo): Record<string, unknown> {
  return {
    name: e.Name,
    model,
    sourcePath: sourcePathFor(info, 'AxEdt', e.Name),
    extends: e.Extends,
    label: e.Label,
    baseType: e.BaseType,
    referenceTable: e.ReferenceTable,
    stringSize: e.StringSize,
    binaryIsv: info,
  };
}

export function toEnumInfo(e: DumpEnum, model: string, info: BinaryIsvInfo): Record<string, unknown> {
  return {
    name: e.Name,
    model,
    sourcePath: sourcePathFor(info, 'AxEnum', e.Name),
    label: e.Label,
    isExtensible: e.IsExtensible,
    values: (e.Values ?? []).map(v => ({ name: v.Name, value: v.Value, label: v.Label })),
    binaryIsv: info,
  };
}

/** Chain-of-command wraps by extension class name (case-insensitive). */
export function cocByClass(d: BinaryModelDump): Map<string, DumpCocClass> {
  return new Map((d.ChainOfCommand ?? []).map(c => [c.Class.toLowerCase(), c]));
}

export interface ConvertedBinaryModel {
  model: string;
  info: BinaryIsvInfo;
  classes: Array<Record<string, unknown>>;
  classExtensions: XppClassExtensionRecord[];
  tables: Array<Record<string, unknown>>;
  edts: Array<Record<string, unknown>>;
  enums: Array<Record<string, unknown>>;
}

export function convertBinaryModel(d: BinaryModelDump): ConvertedBinaryModel {
  const info = binaryIsvInfo(d);
  const model = info.moduleName;
  const coc = cocByClass(d);
  const classes = (d.Classes ?? []).map(c => {
    const info_ = toClassInfo(c, model, info);
    const wraps = coc.get(c.Name.toLowerCase());
    if (!wraps?.Methods?.length) return info_;
    // The compiler's own list of wrapped methods: the only CoC evidence a binary model has (no bodies, no `next`).
    const names = new Set(wraps.Methods.map(m => m.Name.toLowerCase()));
    for (const m of info_.methods as Array<XppMethodInfo & { tags?: string[] }>) {
      if (names.has(m.name.toLowerCase())) m.tags = [...(m.tags ?? []), 'coc-wrapper'];
    }
    return {
      ...info_,
      chainOfCommand: { target: wraps.Target, targetType: wraps.TargetType, wrapped: wraps.Methods.map(m => m.Name) },
      description: `${info_.description} Chain of Command wrapper of ${wraps.Target} (${[...new Set(wraps.Methods.map(m => m.Name))].join(', ')}).`,
    };
  });
  const classExtensions: XppClassExtensionRecord[] = [];
  for (const c of classes) {
    const rec = buildClassExtensionRecord(c as unknown as XppClassInfo, model);
    if (!rec) continue;
    const wraps = coc.get(String(c.name).toLowerCase());
    classExtensions.push({
      ...rec,
      ...(wraps ? { cocMethods: [...new Set(wraps.Methods?.map(m => m.Name) ?? [])] } : {}),
      binaryIsv: info,
    } as XppClassExtensionRecord);
  }
  return {
    model,
    info,
    classes,
    classExtensions,
    tables: (d.Tables ?? []).map(t => toTableInfo(t, model, info)),
    edts: (d.Edts ?? []).map(e => toEdtInfo(e, model, info)),
    enums: (d.Enums ?? []).map(e => toEnumInfo(e, model, info)),
  };
}
