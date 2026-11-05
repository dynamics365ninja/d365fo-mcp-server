/**
 * Upgrade impact — "will OUR code survive the next version of a model we depend on", answered
 * without a build, from two extracted-metadata directories (see versionDiff.ts) plus the source
 * of our own models.
 *
 * Two layers, because neither alone is enough:
 *
 *  1. `resolveXppReferences` (what `validate_code(mode="references")` runs; see
 *     src/tools/analysis/upgradeImpactReferences.ts, which lives under tools) against an index of
 *     the old version and an index of the new one. Only violations that exist against the NEW
 *     index and not against the old one are reported, so everything the index never knew
 *     (kernel classes, models that are not in either extract) cancels out instead of becoming
 *     noise. See referenceFindings().
 *  2. Checks that need the diff, not just "does the name resolve": a Chain of Command wrapper
 *     must repeat the base signature, a `[SubscribesTo]` handler must match its delegate, an
 *     overriding method must still override, a field used in code changed type, a call's
 *     arguments no longer fit. See analyzeImpact().
 *
 * Findings are classified by what happens to the customer:
 *  - `error`     the model will not compile;
 *  - `behaviour` it compiles but does something else, or silently stops doing it (an override that
 *                no longer overrides, a field whose EDT changed);
 *  - `warning`   it compiles and runs (`[SysObsolete]`, a new optional parameter).
 *
 * The same models are compared on both sides. A dependency present in only one of the two
 * directories is listed under `notCompared`, never reported as removed: a missing module is a
 * gap in the extract, not a breaking change.
 *
 * Calls are found by scanning the stored method source, not by parsing X++: a call is
 * `Type::method(...)`, `variable.method(...)` with the variable's declared type, or
 * `this.method(...)`. Inherited members are followed through `extends` within the compared models.
 * Calls that cannot be typed are not reported (a missed finding is better than a false error here).
 */

import {
  diffSnapshots,
  isObsolete,
  leadingAttributes,
  methodAttributes,
  methodFlags,
  type ModelDiff,
  type ModelSnapshot,
  type RawClass,
  type RawEdt,
  type RawMethod,
  type RawTable,
} from './versionDiff.js';

export type ImpactLevel = 'error' | 'behaviour' | 'warning';

export interface ImpactFinding {
  level: ImpactLevel;
  /** Stable id of the kind of break, e.g. `coc-signature`, `method-removed`. */
  kind: string;
  model: string;
  /** Our object: `Class.method`. */
  object: string;
  file?: string;
  /** Line inside the method's stored source (1 = its first line). */
  line?: number;
  /** The dependency member that changed: `Class.method`, `Table.Field`, `Enum::Value`. */
  dependency: string;
  message: string;
  before?: string;
  after?: string;
  fix?: string;
}

export interface ImpactChecked {
  ourMethods: number;
  calls: number;
  cocWrappers: number;
  handlers: number;
  fieldAccesses: number;
}

export interface ImpactReport {
  from: string;
  to: string;
  ourModels: string[];
  dependencyModels: string[];
  notCompared: { onlyInFrom: string[]; onlyInTo: string[] };
  diffs: ModelDiff[];
  /** How much of our code the check could place against the compared dependencies (a clean report with 0 here proves nothing). */
  checked: ImpactChecked;
  findings: ImpactFinding[];
  totals: Record<ImpactLevel, number>;
}

// ---- dependency index (case-insensitive, like X++) ----

const lc = (s: string | undefined): string => (s ?? '').toLowerCase();
const norm = (t: string | undefined): string => (t ?? '').replace(/\s+/g, '').toLowerCase();

export interface DependencyIndex {
  classes: Map<string, RawClass>;
  tables: Map<string, RawTable>;
  edts: Map<string, RawEdt>;
  enums: Map<string, string[]>;
}

export const hasName = (idx: DependencyIndex, name: string): boolean =>
  [idx.classes, idx.tables, idx.edts, idx.enums].some(m => m.has(lc(name)));

export function buildDependencyIndex(snapshots: ModelSnapshot[]): DependencyIndex {
  const idx: DependencyIndex = { classes: new Map(), tables: new Map(), edts: new Map(), enums: new Map() };
  for (const s of snapshots) {
    for (const c of s.classes) if (c.name) idx.classes.set(lc(c.name), c);
    for (const t of s.tables) if (t.name) idx.tables.set(lc(t.name), t);
    for (const e of s.edts) if (e.name) idx.edts.set(lc(e.name), e);
    for (const e of s.enums) {
      if (!e.name) continue;
      const values = e.values
        ? e.values.map(v => v.name)
        : [...(e.raw ?? '').matchAll(/<AxEnumValue[^>]*>[\s\S]*?<Name>([^<]+)<\/Name>/g)].map(m => m[1]);
      idx.enums.set(lc(e.name), values);
    }
  }
  return idx;
}

interface FoundMethod {
  owner: string;
  method: RawMethod;
}

/** A method of a class or table, following `extends` inside the compared models. */
function findMethod(idx: DependencyIndex, typeName: string, methodName: string): FoundMethod | undefined {
  let cur: string | undefined = typeName;
  for (let depth = 0; cur && depth < 12; depth++) {
    const c = idx.classes.get(lc(cur));
    const t = c ? undefined : idx.tables.get(lc(cur));
    const methods = c?.methods ?? t?.methods ?? [];
    const m = methods.find(x => lc(x.name) === lc(methodName));
    if (m) return { owner: c?.name ?? t?.name ?? cur, method: m };
    cur = c?.extends;
  }
  return undefined;
}

// ---- small renderers ----

const requiredParams = (m: RawMethod): number => (m.parameters ?? []).filter(p => !p.defaultValue).length;

function signature(m: RawMethod, withVisibility = true): string {
  const params = (m.parameters ?? []).map(p => `${p.type} ${p.name}`).join(', ');
  const mods = [withVisibility ? (m.visibility ?? 'public') : '', m.isStatic ? 'static' : ''].filter(Boolean).join(' ');
  return `${mods ? `${mods} ` : ''}${m.returnType ?? 'void'} ${m.name}(${params})`;
}

function paramTypesDiffer(a: RawMethod, b: RawMethod): boolean {
  const pa = a.parameters ?? [];
  const pb = b.parameters ?? [];
  return pa.length !== pb.length || pa.some((p, i) => norm(p.type) !== norm(pb[i].type));
}

/**
 * Methods every table buffer has from the kernel (`Common`). A table that stops overriding one of them
 * still has it: a wrapper or call still compiles, but whatever the table's override did is gone.
 */
const COMMON_METHODS = new Set(
  'insert update delete doinsert doupdate dodelete validatewrite validatedelete validatefield validatefieldvalue modifiedfield modifiedfieldvalue initvalue postload defaultrow aosvalidateinsert aosvalidateupdate aosvalidatedelete aosvalidateread write'.split(
    ' ',
  ),
);

const isKernelTableMethod = (idx: DependencyIndex, type: string, method: string | undefined): boolean =>
  idx.tables.has(lc(type)) && COMMON_METHODS.has(lc(method));

const visibilityRank = (v: string | undefined): number => ({ private: 1, protected: 2, internal: 2 })[v ?? ''] ?? 3;

// ---- scanning stored X++ source ----

/** Comments and string contents blanked, same length and same line breaks, so offsets still map to lines. */
export function stripSource(src: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank)
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, m => `${m[0]}${' '.repeat(Math.max(0, m.length - 2))}${m[0]}`);
}

const NOT_A_TYPE = new Set(
  'return new else case if while for throw select from where join in is as next super this true false using ttsbegin ttscommit break continue do switch try catch finally const extern display edit server client readonly var changecompany crosscompany void public private protected internal static final abstract delegate'.split(
    ' ',
  ),
);

/** Declared type of each variable and parameter in a method; `this` maps to the owning type. */
export function variableTypes(clean: string, thisType: string | undefined): Map<string, string> {
  const types = new Map<string, string>();
  if (thisType) types.set('this', thisType);
  const re = /\b([A-Za-z_]\w*)(?:\s*<[^<>]*>)?\s+([A-Za-z_]\w*)\s*(?=[=;,)[])/g;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    if (NOT_A_TYPE.has(lc(m[1])) || NOT_A_TYPE.has(lc(m[2]))) continue;
    if (!types.has(lc(m[2]))) types.set(lc(m[2]), m[1]);
  }
  return types;
}

interface Call {
  type: string;
  member: string;
  argc: number;
  line: number;
  isStatic: boolean;
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function countArgs(clean: string, open: number): number {
  let depth = 0;
  let commas = 0;
  let any = false;
  for (let i = open; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) return any ? commas + 1 : 0;
    } else if (depth === 1) {
      if (ch === ',') commas++;
      else if (!/\s/.test(ch)) any = true;
    }
  }
  return any ? commas + 1 : 0;
}

export function scanCalls(clean: string, types: Map<string, string>): Call[] {
  const calls: Call[] = [];
  const statics = /\b([A-Za-z_]\w*)::([A-Za-z_]\w*)\s*\(/g;
  for (let m = statics.exec(clean); m; m = statics.exec(clean)) {
    calls.push({
      type: m[1],
      member: m[2],
      argc: countArgs(clean, m.index + m[0].length - 1),
      line: lineOf(clean, m.index),
      isStatic: true,
    });
  }
  const instance = /\b([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(/g;
  for (let m = instance.exec(clean); m; m = instance.exec(clean)) {
    const type = types.get(lc(m[1]));
    if (!type || lc(m[2]) === 'next') continue;
    calls.push({
      type,
      member: m[2],
      argc: countArgs(clean, m.index + m[0].length - 1),
      line: lineOf(clean, m.index),
      isStatic: false,
    });
  }
  return calls;
}

interface Access {
  table: string;
  field: string;
  line: number;
}

function scanFieldAccess(clean: string, types: Map<string, string>, tables: DependencyIndex['tables']): Access[] {
  const out: Access[] = [];
  const dot = /\b([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\b(?!\s*\()/g;
  for (let m = dot.exec(clean); m; m = dot.exec(clean)) {
    const table = types.get(lc(m[1])) ?? m[1];
    if (tables.has(lc(table))) out.push({ table, field: m[2], line: lineOf(clean, m.index) });
  }
  const intrinsic = /\b(?:fieldStr|fieldNum|fieldId2Name)\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)/g;
  for (let m = intrinsic.exec(clean); m; m = intrinsic.exec(clean))
    out.push({ table: m[1], field: m[2], line: lineOf(clean, m.index) });
  return out;
}

// ---- analysis ----

export interface Subject {
  model: string;
  cls: RawClass;
  method: RawMethod;
  object: string;
}

export function* ourMethods(ours: ModelSnapshot[]): Generator<Subject> {
  for (const s of ours) {
    for (const cls of s.classes) {
      for (const method of cls.methods ?? [])
        yield { model: s.model, cls, method, object: `${cls.name}.${method.name}` };
    }
    for (const t of s.tables) {
      for (const method of t.methods ?? []) {
        yield {
          model: s.model,
          cls: { name: t.name, sourcePath: t.sourcePath },
          method,
          object: `${t.name}.${method.name}`,
        };
      }
    }
  }
}

/** `[SysObsolete(..., true)]`: the second argument is the error flag. */
function obsoleteIsError(attrs: string[]): boolean {
  const a = attrs.find(x => /^\[\s*SysObsolete\b/i.test(x));
  if (!a) return false;
  const args = a.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""').replace(/^[^(]*\(|\)\s*\]$/g, '');
  return /^\s*true\s*$/i.test(args.split(',')[1] ?? '');
}

function hasWrappableFalse(attrs: string[]): boolean {
  return attrs.some(a => /^\[\s*Wrappable\s*\(\s*false\s*\)/i.test(a));
}

function hasHookableFalse(attrs: string[]): boolean {
  return attrs.some(a => /^\[\s*Hookable\s*\(\s*false\s*\)/i.test(a));
}

/** Everything the diff-specific layer reports for one version step. */
export function analyzeImpact(input: {
  from: string;
  to: string;
  fromDeps: ModelSnapshot[];
  toDeps: ModelSnapshot[];
  ours: ModelSnapshot[];
  notCompared?: { onlyInFrom: string[]; onlyInTo: string[] };
}): ImpactReport {
  const a = buildDependencyIndex(input.fromDeps);
  const b = buildDependencyIndex(input.toDeps);
  const toByModel = new Map(input.toDeps.map(s => [s.model, s]));
  const diffs = input.fromDeps
    .filter(s => toByModel.has(s.model))
    .map(s => diffSnapshots(s, toByModel.get(s.model) as ModelSnapshot));
  const findings: ImpactFinding[] = [];
  const seen = new Set<string>();
  const checked: ImpactChecked = { ourMethods: 0, calls: 0, cocWrappers: 0, handlers: 0, fieldAccesses: 0 };

  const add = (s: Subject, f: Omit<ImpactFinding, 'model' | 'object' | 'file'>): void => {
    const key = `${s.object}|${f.kind}|${f.dependency}|${f.line ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ model: s.model, object: s.object, file: s.cls.sourcePath, ...f });
  };

  // Names that disappeared or changed in a way every user of the name has to know about.
  const removedTypes = new Set<string>();
  for (const [k, c] of a.classes) if (!b.classes.has(k) && c.name) removedTypes.add(k);
  for (const [k, t] of a.tables) if (!b.tables.has(k) && t.name) removedTypes.add(k);
  for (const [k] of a.edts) if (!b.edts.has(k)) removedTypes.add(k);
  for (const [k] of a.enums) if (!b.enums.has(k)) removedTypes.add(k);
  const edtChanged = new Map<string, string>();
  for (const [k, e] of a.edts) {
    const n = b.edts.get(k);
    if (n && (lc(e.extends) !== lc(n.extends) || e.stringSize !== n.stringSize)) {
      edtChanged.set(
        k,
        `extends ${e.extends ?? '-'} size ${e.stringSize ?? '-'} -> extends ${n.extends ?? '-'} size ${n.stringSize ?? '-'}`,
      );
    }
  }
  const obsoleteClasses = new Map<string, boolean>();
  for (const [k, c] of b.classes) {
    const old = a.classes.get(k);
    const attrs = leadingAttributes(c.declaration);
    if (old && isObsolete(attrs) && !isObsolete(leadingAttributes(old.declaration)))
      obsoleteClasses.set(k, obsoleteIsError(attrs));
  }

  for (const s of ourMethods(input.ours)) {
    checked.ourMethods++;
    const source = s.method.source ?? '';
    const clean = stripSource(source);
    const ext = s.cls.extensionOf;
    const thisType = ext && (ext.baseKind === 'class' || ext.baseKind === 'table') ? ext.baseObjectName : s.cls.name;
    const types = variableTypes(clean, thisType);

    // -- Chain of Command: the wrapper must still match the method it wraps --
    if (ext && (ext.baseKind === 'class' || ext.baseKind === 'table') && /\bnext\s+[A-Za-z_]\w*\s*\(/.test(clean)) {
      const oldBase = findMethod(a, ext.baseObjectName, s.method.name ?? '');
      const newBase = findMethod(b, ext.baseObjectName, s.method.name ?? '');
      const baseKnownBefore = a.classes.has(lc(ext.baseObjectName)) || a.tables.has(lc(ext.baseObjectName));
      const baseKnownNow = b.classes.has(lc(ext.baseObjectName)) || b.tables.has(lc(ext.baseObjectName));
      if (baseKnownBefore) checked.cocWrappers++;
      if (baseKnownBefore && !baseKnownNow) {
        add(s, {
          level: 'error',
          kind: 'coc-base-removed',
          dependency: ext.baseObjectName,
          message: `${ext.baseObjectName}, the target of [ExtensionOf], no longer exists.`,
        });
      } else if (oldBase && !newBase && baseKnownNow && isKernelTableMethod(b, ext.baseObjectName, s.method.name)) {
        add(s, {
          level: 'behaviour',
          kind: 'kernel-override-removed',
          dependency: `${ext.baseObjectName}.${s.method.name}`,
          message: `${ext.baseObjectName} no longer overrides ${s.method.name}(): the wrapper still compiles and chains to the kernel method, but the logic the table ran there is gone.`,
          before: signature(oldBase.method),
        });
      } else if (oldBase && !newBase && baseKnownNow) {
        add(s, {
          level: 'error',
          kind: 'coc-method-removed',
          dependency: `${ext.baseObjectName}.${s.method.name}`,
          message: `The method this wrapper chains to was removed from ${ext.baseObjectName}.`,
          before: signature(oldBase.method),
          fix: 'Remove the wrapper, or move the logic to the replacement the new version offers.',
        });
      } else if (oldBase && newBase) {
        const nb = newBase.method;
        const nbAttrs = methodAttributes(nb);
        const nbFlags = methodFlags(nb);
        const obAttrs = methodAttributes(oldBase.method);
        const wasWrappable =
          !methodFlags(oldBase.method).final &&
          visibilityRank(oldBase.method.visibility) > 1 &&
          !hasWrappableFalse(obAttrs);
        const wrappable =
          !(nbFlags.final && !/Wrappable\s*\(\s*true/i.test(nbAttrs.join(''))) &&
          nb.visibility !== 'private' &&
          !hasWrappableFalse(nbAttrs);
        if (wasWrappable && !wrappable) {
          add(s, {
            level: 'error',
            kind: 'coc-not-wrappable',
            dependency: `${newBase.owner}.${nb.name}`,
            message: `${newBase.owner}.${nb.name} can no longer be wrapped (${nb.visibility === 'private' ? 'private' : nbFlags.final ? 'final' : '[Wrappable(false)]'}).`,
            before: signature(oldBase.method),
            after: signature(nb),
          });
        } else if (paramTypesDiffer(s.method, nb) && !paramTypesDiffer(s.method, oldBase.method)) {
          add(s, {
            level: 'error',
            kind: 'coc-signature',
            dependency: `${newBase.owner}.${nb.name}`,
            message: 'A Chain of Command wrapper must repeat the signature of the method it wraps; the base changed.',
            before: signature(oldBase.method),
            after: signature(nb),
            fix: `public ${signature(nb, false)}`,
          });
        } else if (
          norm(nb.returnType) !== norm(s.method.returnType) &&
          norm(oldBase.method.returnType) === norm(s.method.returnType)
        ) {
          add(s, {
            level: 'error',
            kind: 'coc-signature',
            dependency: `${newBase.owner}.${nb.name}`,
            message: 'The return type of the wrapped method changed; the wrapper must return the same type.',
            before: signature(oldBase.method),
            after: signature(nb),
          });
        }
      }
    }

    // -- Event handlers: delegate subscriptions and pre/post handlers --
    const attrs = leadingAttributes(source);
    for (const attr of attrs) {
      const sub = /SubscribesTo\s*\(\s*classStr\s*\(\s*(\w+)\s*\)\s*,\s*delegateStr\s*\(\s*\w+\s*,\s*(\w+)\s*\)/i.exec(
        attr,
      );
      const prepost =
        /(Pre|Post)HandlerFor\s*\(\s*(?:class|table)Str\s*\(\s*(\w+)\s*\)\s*,\s*(?:table)?[Mm]ethodStr\s*\(\s*\w+\s*,\s*(\w+)\s*\)/.exec(
          attr,
        );
      const target = sub
        ? { type: sub[1], member: sub[2], isDelegate: true }
        : prepost
          ? { type: prepost[2], member: prepost[3], isDelegate: false }
          : undefined;
      if (!target) continue;
      const before = findMethod(a, target.type, target.member);
      const after = findMethod(b, target.type, target.member);
      const dep = `${target.type}.${target.member}`;
      if (!before) continue;
      checked.handlers++;
      if (!after) {
        add(s, {
          level: 'error',
          kind: target.isDelegate ? 'subscription-target-removed' : 'handler-target-removed',
          dependency: dep,
          message: `${target.isDelegate ? 'The delegate' : 'The method'} this handler is attached to no longer exists, so the handler never runs (and the attribute does not compile).`,
          before: signature(before.method),
        });
        continue;
      }
      if (target.isDelegate && methodFlags(before.method).delegate && !methodFlags(after.method).delegate) {
        add(s, {
          level: 'error',
          kind: 'subscription-target-removed',
          dependency: dep,
          message: 'The delegate became an ordinary method.',
          before: signature(before.method),
          after: signature(after.method),
        });
      } else if (
        target.isDelegate &&
        paramTypesDiffer(s.method, after.method) &&
        !paramTypesDiffer(s.method, before.method)
      ) {
        add(s, {
          level: 'error',
          kind: 'subscription-signature',
          dependency: dep,
          message: 'The handler parameters no longer match the delegate.',
          before: signature(before.method),
          after: signature(after.method),
          fix: `Change the handler parameters to (${(after.method.parameters ?? []).map(p => `${p.type} ${p.name}`).join(', ')}).`,
        });
      }
      if (hasHookableFalse(methodAttributes(after.method)) && !hasHookableFalse(methodAttributes(before.method))) {
        add(s, {
          level: 'error',
          kind: 'not-hookable',
          dependency: dep,
          message: `${dep} is now [Hookable(false)]: handlers cannot be attached.`,
          before: signature(before.method),
          after: signature(after.method),
        });
      }
    }

    // -- Subclassing and overriding --
    if (s.cls.extends && !ext) {
      const oldM = findMethod(a, s.cls.extends, s.method.name ?? '');
      if (oldM && lc(oldM.owner) === lc(s.cls.extends)) {
        const newM = findMethod(b, s.cls.extends, s.method.name ?? '');
        if (!newM) {
          add(s, {
            level: 'behaviour',
            kind: 'override-orphaned',
            dependency: `${s.cls.extends}.${s.method.name}`,
            message:
              'The base method was removed: this method no longer overrides anything and is never called by the base.',
            before: signature(oldM.method),
          });
        } else if (methodFlags(newM.method).final && !methodFlags(oldM.method).final) {
          add(s, {
            level: 'error',
            kind: 'override-final',
            dependency: `${newM.owner}.${s.method.name}`,
            message: 'The base method became final and can no longer be overridden.',
            before: signature(oldM.method),
            after: signature(newM.method),
          });
        } else if (
          paramTypesDiffer(oldM.method, newM.method) ||
          norm(oldM.method.returnType) !== norm(newM.method.returnType)
        ) {
          add(s, {
            level: 'error',
            kind: 'override-signature',
            dependency: `${newM.owner}.${s.method.name}`,
            message: 'The base method signature changed; the override no longer matches.',
            before: signature(oldM.method),
            after: signature(newM.method),
            fix: signature(newM.method),
          });
        }
      }
    }

    // -- Calls into the dependency --
    for (const call of scanCalls(clean, types)) {
      const before = findMethod(a, call.type, call.member);
      const after = findMethod(b, call.type, call.member);
      const dep = `${call.type}${call.isStatic ? '::' : '.'}${call.member}`;
      if (!before) continue;
      checked.calls++;
      const typeStillThere = b.classes.has(lc(call.type)) || b.tables.has(lc(call.type));
      if (!after) {
        if (typeStillThere && isKernelTableMethod(b, call.type, call.member)) {
          add(s, {
            level: 'behaviour',
            kind: 'kernel-override-removed',
            line: call.line,
            dependency: dep,
            message: `${call.type} no longer overrides ${call.member}(): the call compiles against the kernel method, but the logic the table ran there is gone.`,
            before: signature(before.method),
          });
        } else if (typeStillThere) {
          add(s, {
            level: 'error',
            kind: 'method-removed',
            line: call.line,
            dependency: dep,
            message: 'The method was removed.',
            before: signature(before.method),
          });
        }
        continue;
      }
      const o = before.method;
      const n = after.method;
      const fits = (m: RawMethod): boolean =>
        m.parametersUnknown === true || (call.argc >= requiredParams(m) && call.argc <= (m.parameters ?? []).length);
      if (!fits(n) && fits(o)) {
        add(s, {
          level: 'error',
          kind: 'arity',
          line: call.line,
          dependency: dep,
          message: `The call passes ${call.argc} argument(s); the method now takes ${requiredParams(n)}–${(n.parameters ?? []).length}.`,
          before: signature(o),
          after: signature(n),
          fix: `Pass the new required argument(s): ${signature(n, false)}`,
        });
      } else if (fits(n) && (n.parameters ?? []).length > (o.parameters ?? []).length && fits(o)) {
        add(s, {
          level: 'warning',
          kind: 'optional-parameter-added',
          line: call.line,
          dependency: dep,
          message: 'New optional parameter; the call still compiles and uses the default.',
          before: signature(o),
          after: signature(n),
        });
      } else if (paramTypesDiffer(o, n) && (o.parameters ?? []).length === (n.parameters ?? []).length) {
        add(s, {
          level: 'error',
          kind: 'param-type',
          line: call.line,
          dependency: dep,
          message: 'A parameter type changed; the argument may no longer be accepted.',
          before: signature(o),
          after: signature(n),
        });
      }
      if (norm(o.returnType) !== norm(n.returnType)) {
        add(s, {
          level: 'error',
          kind: 'return-type',
          line: call.line,
          dependency: dep,
          message: 'The return type changed; code that uses the result may no longer compile.',
          before: signature(o),
          after: signature(n),
        });
      }
      const sameOwnerModel = lc(s.cls.model) === lc(b.classes.get(lc(call.type))?.model);
      const callerSubclasses = !!s.cls.extends && lc(s.cls.extends) === lc(call.type);
      if (
        visibilityRank(n.visibility) < visibilityRank(o.visibility) &&
        !(n.visibility === 'protected' && callerSubclasses) &&
        !(n.visibility === 'internal' && sameOwnerModel)
      ) {
        add(s, {
          level: 'error',
          kind: 'not-visible',
          line: call.line,
          dependency: dep,
          message: `The method is now ${n.visibility}.`,
          before: signature(o),
          after: signature(n),
        });
      }
      if (!!o.isStatic !== !!n.isStatic) {
        add(s, {
          level: 'error',
          kind: 'static-changed',
          line: call.line,
          dependency: dep,
          message: `The method is now ${n.isStatic ? 'static' : 'an instance method'}.`,
          before: signature(o),
          after: signature(n),
        });
      }
      const nowObsolete = isObsolete(methodAttributes(n)) && !isObsolete(methodAttributes(o));
      if (nowObsolete) {
        const isErr = obsoleteIsError(methodAttributes(n));
        add(s, {
          level: isErr ? 'error' : 'warning',
          kind: 'obsolete',
          line: call.line,
          dependency: dep,
          message: isErr
            ? 'The method is [SysObsolete] with the error flag: the call does not compile.'
            : 'The method is [SysObsolete].',
          before: signature(o),
          after: methodAttributes(n).join(''),
        });
      }
    }

    // -- Fields used in code --
    for (const acc of scanFieldAccess(clean, types, a.tables)) {
      const ta = a.tables.get(lc(acc.table));
      const tb = b.tables.get(lc(acc.table));
      const fa = ta?.fields?.find(f => lc(f.name) === lc(acc.field));
      if (!ta || !fa) continue;
      checked.fieldAccesses++;
      const dep = `${acc.table}.${acc.field}`;
      const fb = tb?.fields?.find(f => lc(f.name) === lc(acc.field));
      if (tb && !fb) {
        add(s, {
          level: 'error',
          kind: 'field-removed',
          line: acc.line,
          dependency: dep,
          message: 'The field was removed.',
          before: `${fa.type ?? ''} ${fa.extendedDataType ?? fa.enumType ?? ''}`.trim(),
        });
      } else if (fb && norm(fa.type) !== norm(fb.type)) {
        add(s, {
          level: 'error',
          kind: 'field-type',
          line: acc.line,
          dependency: dep,
          message: 'The field base type changed.',
          before: fa.type,
          after: fb.type,
        });
      } else if (fb && lc(fa.extendedDataType ?? fa.enumType) !== lc(fb.extendedDataType ?? fb.enumType)) {
        add(s, {
          level: 'behaviour',
          kind: 'field-edt',
          line: acc.line,
          dependency: dep,
          message: 'The field now uses another EDT or enum: size, labels and lookups may differ.',
          before: fa.extendedDataType ?? fa.enumType,
          after: fb.extendedDataType ?? fb.enumType,
        });
      }
    }

    // -- Enum values --
    const enumRe = /\b([A-Za-z_]\w*)::([A-Za-z_]\w*)\b(?!\s*\()/g;
    for (let m = enumRe.exec(clean); m; m = enumRe.exec(clean)) {
      const before = a.enums.get(lc(m[1]));
      const after = b.enums.get(lc(m[1]));
      if (before?.some(v => lc(v) === lc(m[2])) && after && !after.some(v => lc(v) === lc(m[2]))) {
        add(s, {
          level: 'error',
          kind: 'enum-value-removed',
          line: lineOf(clean, m.index),
          dependency: `${m[1]}::${m[2]}`,
          message: 'The enum value was removed.',
          fix: `Values now: ${after.join(', ')}`,
        });
      }
    }

    // -- Names that vanished or changed --
    const ids = new Set(clean.match(/\b[A-Za-z_]\w*\b/g)?.map(lc) ?? []);
    for (const id of ids) {
      if (removedTypes.has(id)) {
        add(s, {
          level: 'error',
          kind: 'type-removed',
          dependency: a.classes.get(id)?.name ?? a.tables.get(id)?.name ?? a.edts.get(id)?.name ?? id,
          message: 'The class, table, EDT or enum this code names no longer exists.',
        });
      } else if (edtChanged.has(id)) {
        add(s, {
          level: 'behaviour',
          kind: 'edt-changed',
          dependency: a.edts.get(id)?.name ?? id,
          message: `The EDT changed: ${edtChanged.get(id)}.`,
        });
      } else if (obsoleteClasses.has(id)) {
        const isErr = obsoleteClasses.get(id) === true;
        add(s, {
          level: isErr ? 'error' : 'warning',
          kind: 'obsolete',
          dependency: a.classes.get(id)?.name ?? id,
          message: isErr ? 'The class is [SysObsolete] with the error flag.' : 'The class is [SysObsolete].',
        });
      }
    }
  }

  const totals: Record<ImpactLevel, number> = { error: 0, behaviour: 0, warning: 0 };
  for (const f of findings) totals[f.level]++;
  return {
    from: input.from,
    to: input.to,
    ourModels: input.ours.map(s => s.model),
    dependencyModels: [...toByModel.keys()].filter(m => input.fromDeps.some(s => s.model === m)),
    notCompared: input.notCompared ?? { onlyInFrom: [], onlyInTo: [] },
    diffs,
    checked,
    findings,
    totals,
  };
}

/** `Class.method()`, `Class.method` and `Class::method` are the same member. */
const memberKey = (dependency: string): string => dependency.replace(/\(.*$/, '').replace(/\./g, '::');

/** Merge the reference layer into a report; a finding the diff layer already made for the same member wins. */
export function mergeFindings(report: ImpactReport, extra: ImpactFinding[]): ImpactReport {
  const have = new Set(report.findings.map(f => `${f.object}|${memberKey(f.dependency)}`));
  const findings = [...report.findings];
  for (const f of extra) {
    const key = `${f.object}|${memberKey(f.dependency)}`;
    if (have.has(key)) continue;
    have.add(key);
    findings.push(f);
  }
  const totals: Record<ImpactLevel, number> = { error: 0, behaviour: 0, warning: 0 };
  for (const f of findings) totals[f.level]++;
  return { ...report, findings, totals };
}

// ---- Markdown ----

const LEVEL_ORDER: ImpactLevel[] = ['error', 'behaviour', 'warning'];
const LEVEL_TITLE: Record<ImpactLevel, string> = {
  error: 'Will not compile',
  behaviour: 'Compiles, behaves differently',
  warning: 'Compiles and runs',
};

function diffSummaryRow(d: ModelDiff): string {
  const n = (xs: unknown[]): number => xs.length;
  return `| ${d.model} | +${n(d.classesAdded)} / -${n(d.classesRemoved)} | +${n(d.methodsAdded)} / -${n(d.methodsRemoved)} | ${n(d.methodsChanged)} | ${n(d.newlyObsolete)} | +${n(d.fieldsAdded)} / -${n(d.fieldsRemoved)} / ~${n(d.fieldsChanged)} | +${n(d.enumValuesAdded)} / -${n(d.enumValuesRemoved)} |`;
}

export function renderImpactMarkdown(r: ImpactReport): string {
  const lines: string[] = [];
  lines.push(`# Upgrade impact: ${r.from} -> ${r.to}`, '');
  lines.push(`Our models: ${r.ourModels.join(', ') || '-'}. Dependencies compared: ${r.dependencyModels.length}.`, '');
  lines.push(
    `Checked against the compared dependencies: ${r.checked.calls} calls, ${r.checked.cocWrappers} Chain of Command wrappers, ${r.checked.handlers} event handlers, ${r.checked.fieldAccesses} field accesses (in ${r.checked.ourMethods} methods).`,
    '',
  );
  lines.push(
    `**${r.totals.error} will not compile, ${r.totals.behaviour} change behaviour, ${r.totals.warning} warnings.**`,
    '',
  );

  lines.push('## What changed in the dependencies', '');
  lines.push(
    '| Model | Classes | Methods | Signatures changed | Newly obsolete | Fields | Enum values |',
    '|---|---|---|---|---|---|---|',
  );
  for (const d of r.diffs) lines.push(diffSummaryRow(d));
  lines.push('');
  if (r.notCompared.onlyInFrom.length || r.notCompared.onlyInTo.length) {
    lines.push('Not compared (present in only one version, a gap in the extract rather than a breaking change):');
    if (r.notCompared.onlyInFrom.length) lines.push(`- only in ${r.from}: ${r.notCompared.onlyInFrom.join(', ')}`);
    if (r.notCompared.onlyInTo.length) lines.push(`- only in ${r.to}: ${r.notCompared.onlyInTo.join(', ')}`);
    lines.push('');
  }

  lines.push('## How this affects us', '');
  if (r.findings.length === 0) lines.push('Nothing found.', '');
  for (const level of LEVEL_ORDER) {
    const group = r.findings.filter(f => f.level === level);
    if (!group.length) continue;
    lines.push(`### ${LEVEL_TITLE[level]} (${group.length})`, '');
    const byObject = new Map<string, ImpactFinding[]>();
    for (const f of group)
      byObject.set(`${f.model}: ${f.object}`, [...(byObject.get(`${f.model}: ${f.object}`) ?? []), f]);
    for (const [object, fs] of [...byObject].sort(([x], [y]) => x.localeCompare(y))) {
      lines.push(
        `**${object}**${fs[0].file ? ` (${fs[0].file.replace(/^.*[\\/](?=[^\\/]+[\\/][^\\/]+$)/, '')})` : ''}`,
        '',
      );
      for (const f of fs) {
        lines.push(`- \`${f.kind}\` ${f.line ? `line ${f.line}: ` : ''}\`${f.dependency}\` — ${f.message}`);
        if (f.before) lines.push(`  - was: \`${f.before}\``);
        if (f.after) lines.push(`  - now: \`${f.after}\``);
        if (f.fix) lines.push(`  - fix: ${f.fix}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
