/**
 * What an extension BINDS to: Chain of Command wrappers, event handlers and
 * calls to obsolete methods, checked against the indexed declaration (#1225).
 *
 * The rest of the resolver proves that names exist. These checks read the
 * declaration a name resolves to and compare it with what the snippet expects of
 * it, which is what breaks when a dependency is updated underneath code that
 * compiled yesterday, and what an agent gets wrong when it writes a wrapper from
 * memory.
 *
 * Every ERROR here is a case xppc rejects, confirmed by a compile probe
 * (scripts/oracles/probes/extension-targets.ts). What the compiler accepts, even
 * with a warning of its own, is at most a warning here:
 *  - a wrapper of a method only a base class declares compiles; the chain walk
 *    finds it there;
 *  - a kernel table or Object method needs no declaration (`postLoad` on a
 *    table that never overrides it);
 *  - `[Wrappable(false)]` stops a wrapper only on a PUBLIC method; on a
 *    protected one the wrapper compiles;
 *  - a parameter typed with another EDT (even an unrelated one) compiles with a
 *    warning, so only primitive-vs-primitive and primitive-vs-enum mismatches
 *    are errors;
 *  - `[SysObsolete]` is an error only with its isError argument set to true.
 *
 * Silent whenever the index cannot answer: an owner that is not indexed, a base
 * class outside the index, a declaration the parser cannot read, a method that
 * an extension contributes. A missed finding is cheaper than a false block, since
 * this runs inside the write gate under GROUNDING_ENFORCE.
 */

import { blankCommentsAndStrings, parseXppDeclaration, type XppDeclaration } from '../../metadata/xppDeclaration.js';
import { KERNEL_EDT_NAMES } from '../../knowledge/kernelEdts.js';
import { distinctSymbolTypesNocase, lookupSymbolNocase, type DbLike } from '../../utils/symbolLookup.js';
import type { ReferenceViolation } from './resolveReferences.js';

/** Kernel methods every table / every class instance has without a declaration. */
export interface KernelMethodSets {
  table: ReadonlySet<string>;
  object: ReadonlySet<string>;
}

/** Where a member resolved, walking the owner's `extends` chain. */
type MemberLookup =
  | { state: 'found'; owner: string; name: string; source: string | null }
  /** Contributed by an extension: present, but its declaration is not indexed as a method row. */
  | { state: 'extension' }
  /** A kernel Common / Object method: present, no declaration to read. */
  | { state: 'kernel' }
  /** Every type in the chain is indexed and none declares it. */
  | { state: 'missing'; chain: string[] }
  /** The chain left the index; nothing can be said. */
  | { state: 'unknown' };

const MAX_CHAIN = 15;

export type OwnerKind = 'class' | 'table';

/** The AOT kind an intrinsic names (`classStr` → class); undefined for kinds these checks do not read. */
export function ownerKindOf(intrinsic: string): OwnerKind | undefined {
  const lower = intrinsic.toLowerCase();
  if (lower === 'classstr') return 'class';
  if (lower === 'tablestr') return 'table';
  return undefined;
}

/**
 * Resolve `member` on `ownerName` or the first base type that declares it.
 *
 * `kind` is the one the attribute names. A form, a table and a class can share a
 * name (`HcmPosition` is a table and a form), and form methods are not in the
 * index, so a lookup that accepted any kind reported the form's delegates as
 * missing from the table: 40 of the first sweep's false errors.
 */
export function lookupMember(
  db: DbLike,
  ownerName: string,
  member: string,
  kernel: KernelMethodSets,
  kind: OwnerKind,
): MemberLookup {
  const chain: string[] = [];
  let current = ownerName;
  try {
    for (let depth = 0; depth < MAX_CHAIN; depth++) {
      const hit = lookupSymbolNocase(db, current, [kind]);
      if (!hit) return { state: 'unknown' };
      chain.push(hit.name);

      const row = db.prepare(
        `SELECT name, source FROM symbols
         WHERE parent_name = ? AND type = 'method' AND name = ? COLLATE NOCASE
         LIMIT 1`,
      ).get(hit.name, member) as { name: string; source: string | null } | undefined;
      if (row) return { state: 'found', owner: hit.name, name: row.name, source: row.source };

      if (extensionContributes(db, hit.name, member)) return { state: 'extension' };

      const base = hit.extends_class?.trim();
      if (!base || base.toLowerCase() === hit.name.toLowerCase()) {
        const builtins = kind === 'table' ? kernel.table : kernel.object;
        return builtins.has(member.toLowerCase()) ? { state: 'kernel' } : { state: 'missing', chain };
      }
      current = base;
    }
  } catch {
    // DB error: say nothing.
  }
  return { state: 'unknown' };
}

function extensionContributes(db: DbLike, owner: string, member: string): boolean {
  const rows = db.prepare(
    `SELECT added_methods, coc_methods FROM extension_metadata WHERE base_object_name = ?`,
  ).all(owner) as Array<{ added_methods: string | null; coc_methods: string | null }>;
  const target = member.toLowerCase();
  for (const r of rows) {
    for (const col of [r.added_methods, r.coc_methods]) {
      if (!col) continue;
      try {
        const names = JSON.parse(col) as unknown[];
        if (names.some(m => (typeof m === 'string' ? m : (m as { name?: string })?.name ?? '').toLowerCase() === target)) {
          return true;
        }
      } catch { /* malformed JSON — skip */ }
    }
  }
  return false;
}

/** What the text in front of a method's body says about it. */
export interface MethodHeader {
  isDelegate: boolean;
  /** `[Hookable]` or `[HookableAttribute(true)]` → true, `(false)` → false, absent → undefined. */
  hookable: boolean | undefined;
  /** The same for `[Wrappable]`: shipped code writes the bare attribute far more than `(true)`. */
  wrappable: boolean | undefined;
  /** undefined when not obsolete; otherwise whether its isError argument is true. */
  obsoleteError: boolean | undefined;
}

/** `[Name]`, `[NameAttribute(true)]`, `[Name(false)]` → true/true/false; absent → undefined. */
function attributeFlag(header: string, name: string): boolean | undefined {
  const m = new RegExp(`\\b${name}(?:Attribute)?(?!\\w)\\s*(?:\\(\\s*(true|false)?\\s*\\))?`, 'i').exec(header);
  if (!m) return undefined;
  return m[1] ? m[1].toLowerCase() === 'true' : true;
}

/**
 * Read the attributes and the `delegate` keyword in front of the body.
 *
 * The indexed `source` of a method starts with its doc comment and attributes,
 * so everything before the first `{` is the header. Comments and strings are
 * blanked first, so `[SysObsolete('use the [Hookable(false)] one')]` cannot
 * produce a second attribute.
 */
export function readMethodHeader(source: string): MethodHeader {
  const blanked = blankCommentsAndStrings(source);
  const brace = blanked.indexOf('{');
  const header = brace >= 0 ? blanked.slice(0, brace) : blanked;
  const obsolete = /\bSysObsolete(?:Attribute)?\s*\(([^)]*)\)/i.exec(header);
  let obsoleteError: boolean | undefined;
  if (obsolete) {
    const args = obsolete[1].split(',').map(a => a.trim().toLowerCase());
    obsoleteError = args[1] === 'true';
  }
  return {
    isDelegate: /\bdelegate\b/i.test(header),
    hookable: attributeFlag(header, 'Hookable'),
    wrappable: attributeFlag(header, 'Wrappable'),
    obsoleteError,
  };
}

/**
 * The violation for a call that reaches an obsolete method, or undefined.
 *
 * `callerObsolete`: the calling code carries `[SysObsolete]` itself. The
 * compiler does not report obsolete calls from obsolete code; every one of the
 * 13 isError calls in the shipped sweep sat in such a class or method. Without a
 * reliable way to tell which method a call sits in, any `[SysObsolete]` in the
 * snippet downgrades the finding to a warning.
 */
export function obsoleteCallViolation(
  source: string | null,
  identifier: string,
  line: number,
  callerObsolete = false,
): ReferenceViolation | undefined {
  if (!source) return undefined;
  const { obsoleteError } = readMethodHeader(source);
  if (obsoleteError === undefined) return undefined;
  return {
    kind: 'obsolete-method',
    severity: obsoleteError && !callerObsolete ? 'error' : 'warning',
    line,
    identifier,
    detail: obsoleteError
      ? `${identifier} is marked [SysObsolete] with isError = true, so the compiler rejects every call to it. ` +
        `Read its declaration (get_object_info with options:{"method":…,"include":"source"}) for the replacement the attribute names.`
      : `${identifier} is marked [SysObsolete]; the build warns on this call. Prefer the replacement its attribute names.`,
  };
}

const PRIMITIVE_TYPES = new Set([
  'int', 'int64', 'real', 'str', 'boolean', 'date', 'utcdatetime', 'timeofday', 'guid', 'container',
]);
/** Types that accept anything: a mismatch against them says nothing. */
const OPEN_TYPES = new Set(['anytype', 'var', 'void']);

type TypeKind = 'primitive' | 'enum' | 'edt' | 'other' | 'unknown';

function typeKind(db: DbLike, name: string): TypeKind {
  const lower = name.toLowerCase();
  if (PRIMITIVE_TYPES.has(lower)) return 'primitive';
  if (KERNEL_EDT_NAMES.has(lower)) return 'edt';
  let types: string[] = [];
  try { types = distinctSymbolTypesNocase(db, name); } catch { /* unknown */ }
  if (types.includes('edt')) return 'edt';
  if (types.includes('enum')) return 'enum';
  return types.length > 0 ? 'other' : 'unknown';
}

/**
 * Severity of a type the wrapper/handler spells differently from the base, or
 * undefined when the two agree or nothing can be said.
 *
 * xppc errors only when the types cannot convert: probed int-vs-str,
 * boolean-vs-int (return) and int-vs-enum all fail. An EDT, even an unrelated
 * one of the same base type, compiles with the compiler's own warning, and a
 * class or table type is left as a warning because a base buffer type is
 * assignment compatible with its subtypes.
 */
function typeMismatchSeverity(db: DbLike, a: string, b: string): 'error' | 'warning' | undefined {
  const la = a.toLowerCase().replace(/\s+/g, '');
  const lb = b.toLowerCase().replace(/\s+/g, '');
  if (la === lb || OPEN_TYPES.has(la) || OPEN_TYPES.has(lb)) return undefined;
  const ka = typeKind(db, a);
  const kb = typeKind(db, b);
  if (ka === 'unknown' || kb === 'unknown') return undefined;
  if (ka === 'primitive' && kb === 'primitive') {
    const numeric = new Set(['int', 'int64']);
    return numeric.has(la) && numeric.has(lb) ? 'warning' : 'error';
  }
  if ((ka === 'primitive' && kb === 'enum') || (ka === 'enum' && kb === 'primitive')) return 'error';
  return 'warning';
}

function hasModifier(decl: XppDeclaration, modifier: string): boolean {
  return decl.modifiers.some(m => m.toLowerCase() === modifier);
}

function render(decl: XppDeclaration): string {
  const mods = decl.modifiers.length ? `${decl.modifiers.join(' ')} ` : '';
  const params = decl.parameters.map(p => `${p.type} ${p.name}`).join(', ');
  return `${mods}${decl.returnType} ${decl.name}(${params})`;
}

interface Compared {
  severity: 'error' | 'warning';
  reason: string;
}

/** Compare a wrapper's or handler's parameter list with the declaration it must repeat. */
function compareParameters(db: DbLike, mine: XppDeclaration, theirs: XppDeclaration): Compared[] {
  const out: Compared[] = [];
  if (mine.parameters.length !== theirs.parameters.length) {
    out.push({
      severity: 'error',
      reason: `it declares ${mine.parameters.length} parameter(s), the target ${theirs.parameters.length}`,
    });
    return out;
  }
  mine.parameters.forEach((p, i) => {
    const sev = typeMismatchSeverity(db, p.type, theirs.parameters[i].type);
    if (sev) {
      out.push({
        severity: sev,
        reason: `parameter ${i + 1} is ${p.type}, the target declares ${theirs.parameters[i].type}` +
          (sev === 'warning' ? ' (the compiler accepts a compatible type with a warning)' : ''),
      });
    }
  });
  return out;
}

function lineOf(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === '\n') line++;
  return line;
}

/** Index of `name(` as a declaration, i.e. not in `next name(`, `.name(` or `::name(`. */
function declarationIndex(blanked: string, name: string): number {
  const re = new RegExp(`(^|[^\\w.:])(${name})\\s*\\(`, 'gi');
  for (const m of blanked.matchAll(re)) {
    const at = (m.index ?? 0) + m[1].length;
    if (/\bnext\s*$/i.test(blanked.slice(Math.max(0, at - 10), at))) continue;
    return at;
  }
  return -1;
}

/** Parse the snippet's own declaration of `name`, refusing a `next name(...)` call. */
function ownDeclaration(code: string, name: string): XppDeclaration | null {
  const decl = parseXppDeclaration(code, name);
  if (!decl || decl.returnType.toLowerCase() === 'next') return null;
  return decl;
}

/** Chain of Command wrappers in a `[ExtensionOf(classStr|tableStr(X))]` class. */
function checkWrappers(code: string, blanked: string, db: DbLike, kernel: KernelMethodSets): ReferenceViolation[] {
  const violations: ReferenceViolation[] = [];
  const ext = /\bExtensionOf\s*\(\s*(class|table)Str\s*\(\s*(\w+)\s*\)\s*\)/i.exec(blanked);
  if (!ext) return violations;
  const target = ext[2];
  const kind = ext[1].toLowerCase() as OwnerKind;

  const seen = new Set<string>();
  for (const m of blanked.matchAll(/\bnext\s+(\w+)\s*\(/gi)) {
    const name = m[1];
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());

    const at = declarationIndex(blanked, name);
    const line = lineOf(code, at >= 0 ? at : (m.index ?? 0));
    const identifier = `${target}.${name}`;
    const found = lookupMember(db, target, name, kernel, kind);

    if (found.state === 'missing') {
      violations.push({
        kind: 'coc-target',
        severity: 'error',
        line,
        identifier,
        detail: `Chain of Command wrapper of a method ${target} does not have: "${name}" is declared on none of ` +
          `${found.chain.join(' → ')} and is not a kernel method, so \`next ${name}()\` cannot compile. ` +
          `If it was renamed or removed by an update, find the replacement with get_object_info(name="${target}"); ` +
          `if it was added this session, run update_symbol_index first.`,
      });
      continue;
    }
    if (found.state !== 'found' || !found.source) continue;

    const header = readMethodHeader(found.source);
    const base = parseXppDeclaration(found.source, name);
    const where = found.owner === target ? target : `${found.owner} (inherited by ${target})`;
    const reasons: Compared[] = [];

    if (header.hookable === false) {
      reasons.push({ severity: 'error', reason: `the target is marked [Hookable(false)], which also forbids wrapping` });
    }
    if (base) {
      // `[Hookable(true)]` opens a private method to pre/post handlers; whether it
      // also opens it to wrappers is unprobed, so it silences this rule.
      if (hasModifier(base, 'private') && header.hookable !== true) {
        reasons.push({ severity: 'error', reason: 'the target is private; only public and protected methods can be wrapped' });
      }
      // Shipped code mostly writes the bare `[Wrappable]`, which means true.
      if (hasModifier(base, 'final') && header.wrappable !== true) {
        reasons.push({ severity: 'error', reason: 'the target is final and has no [Wrappable] / [Wrappable(true)]' });
      }
      if (header.wrappable === false && hasModifier(base, 'public')) {
        reasons.push({ severity: 'error', reason: 'the target is a public method marked [Wrappable(false)]' });
      }
    }

    const mine = ownDeclaration(code, name);
    if (base && mine) {
      const baseStatic = hasModifier(base, 'static');
      const mineStatic = hasModifier(mine, 'static');
      if (baseStatic !== mineStatic) {
        reasons.push({
          severity: baseStatic ? 'error' : 'warning',
          reason: baseStatic ? 'the target is static, the wrapper is not' : 'the wrapper is static, the target is not',
        });
      }
      reasons.push(...compareParameters(db, mine, base));
      const ret = typeMismatchSeverity(db, mine.returnType, base.returnType);
      if (ret) {
        reasons.push({ severity: ret, reason: `the wrapper returns ${mine.returnType}, the target ${base.returnType}` });
      }
    }

    if (reasons.length === 0) continue;
    const severity = reasons.some(r => r.severity === 'error') ? 'error' : 'warning';
    violations.push({
      kind: 'coc-target',
      severity,
      line,
      identifier,
      detail: `Chain of Command wrapper does not match its target on ${where}: ${reasons.map(r => r.reason).join('; ')}.` +
        (base ? ` The target is declared as \`${render(base)}\`; a wrapper repeats it without default values.` : ''),
    });
  }
  return violations;
}

/** The handler method declared right after an attribute that ends at `from`. */
function handlerAfter(code: string, blanked: string, from: number): XppDeclaration | null {
  const m = /^[^{};]*?\b(?:public|private|protected|internal|static|final)\b[^({};]*?\b(\w+)\s*\(/.exec(blanked.slice(from));
  if (!m) return null;
  return parseXppDeclaration(code.slice(from), m[1]);
}

/** `[SubscribesTo(…, delegateStr|staticDelegateStr(X, d))]` and `[Pre|PostHandlerFor(…, methodStr(X, m))]`. */
function checkHandlers(code: string, blanked: string, db: DbLike, kernel: KernelMethodSets): ReferenceViolation[] {
  const violations: ReferenceViolation[] = [];

  const subRe = /\bSubscribesTo\s*\(\s*(\w+Str)\s*\(\s*\w+\s*\)\s*,\s*(delegateStr|staticDelegateStr)\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*\)/gi;
  for (const m of blanked.matchAll(subRe)) {
    // formStr and the rest: their delegates are not in the index.
    const kind = ownerKindOf(m[1]);
    if (!kind) continue;
    const isStaticStr = m[2].toLowerCase() === 'staticdelegatestr';
    const owner = m[3];
    const name = m[4];
    const line = lineOf(code, m.index ?? 0);
    const identifier = `${owner}.${name}`;
    const found = lookupMember(db, owner, name, kernel, kind);

    if (found.state === 'missing') {
      violations.push({
        kind: 'handler-target',
        severity: 'error',
        line,
        identifier,
        detail: `[SubscribesTo] names a delegate ${owner} does not have: "${name}" is declared on none of ` +
          `${found.chain.join(' → ')}. If an update removed or renamed it, find the replacement with ` +
          `get_object_info(name="${owner}").`,
      });
      continue;
    }
    if (found.state !== 'found' || !found.source) continue;

    const header = readMethodHeader(found.source);
    const delegate = parseXppDeclaration(found.source, name);
    const reasons: Compared[] = [];
    if (!header.isDelegate) {
      reasons.push({
        severity: 'error',
        reason: `"${name}" is an ordinary method, not a delegate; subscribe with [PreHandlerFor]/[PostHandlerFor] or wrap it with Chain of Command`,
      });
    } else if (delegate) {
      const delegateStatic = hasModifier(delegate, 'static');
      if (delegateStatic && !isStaticStr) {
        reasons.push({ severity: 'error', reason: 'the delegate is static, so the attribute must name it with staticDelegateStr' });
      } else if (!delegateStatic && isStaticStr) {
        reasons.push({ severity: 'warning', reason: 'the delegate is an instance delegate, so the attribute should name it with delegateStr' });
      }
      const handler = handlerAfter(code, blanked, (m.index ?? 0) + m[0].length);
      if (handler) reasons.push(...compareParameters(db, handler, delegate));
    }

    if (reasons.length === 0) continue;
    violations.push({
      kind: 'handler-target',
      severity: reasons.some(r => r.severity === 'error') ? 'error' : 'warning',
      line,
      identifier,
      detail: `Event handler does not match its delegate: ${reasons.map(r => r.reason).join('; ')}.` +
        (delegate && header.isDelegate ? ` The delegate is declared as \`${render(delegate)}\`; the handler repeats its parameters.` : ''),
    });
  }

  const prePostRe = /\b(Pre|Post)HandlerFor\s*\(\s*(\w+Str)\s*\(\s*\w+\s*\)\s*,\s*\w*MethodStr\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*\)/gi;
  for (const m of blanked.matchAll(prePostRe)) {
    const kind = ownerKindOf(m[2]);
    if (!kind) continue;
    const owner = m[3];
    const name = m[4];
    const found = lookupMember(db, owner, name, kernel, kind);
    // A missing method is the intrinsic check's finding; reported once, there.
    if (found.state !== 'found' || !found.source) continue;
    const header = readMethodHeader(found.source);
    const decl = parseXppDeclaration(found.source, name);
    const reasons: string[] = [];
    if (header.hookable === false) reasons.push('the target is marked [Hookable(false)]');
    // Shipped code subscribes to private methods marked [HookableAttribute(true)].
    if (decl && hasModifier(decl, 'private') && header.hookable !== true) {
      reasons.push('the target is private and not marked [Hookable(true)]');
    }
    if (reasons.length === 0) continue;
    violations.push({
      kind: 'handler-target',
      severity: 'error',
      line: lineOf(code, m.index ?? 0),
      identifier: `${owner}.${name}`,
      detail: `[${m[1]}HandlerFor] cannot subscribe to ${owner}.${name}: ${reasons.join(' and ')}. ` +
        'Subscribe to a delegate or a public/protected hookable method instead.',
    });
  }

  return violations;
}

/** All extension-target findings for one snippet. */
export function checkExtensionTargets(code: string, db: DbLike, kernel: KernelMethodSets): ReferenceViolation[] {
  // `HandlerFor` without a leading \b: it is the tail of Pre/PostHandlerFor.
  if (!/\bnext\b|\bSubscribesTo\b|HandlerFor\b/i.test(code)) return [];
  const blanked = blankCommentsAndStrings(code);
  return [...checkWrappers(code, blanked, db, kernel), ...checkHandlers(code, blanked, db, kernel)];
}
