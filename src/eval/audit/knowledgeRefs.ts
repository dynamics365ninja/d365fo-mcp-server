/**
 * Knowledge-base reference extraction.
 *
 * Pulls every *named AOT type / API* out of the embedded KNOWLEDGE_BASE
 * (src/tools/xppKnowledge.ts) so it can be resolved against the real symbol
 * index. Rationale: generated code is gated fail-closed by validate_code and
 * the build, but knowledge content shipped to the model was never gated at
 * all — that asymmetry is what the public review of the part-4 article
 * exposed (a `SysRunnable::run()` that does not exist in the AOT).
 *
 * Extraction is deliberately *conservative*: only shapes where a PascalCase
 * token is unambiguously an AOT element reference are emitted, so an
 * unresolved reference is a real defect rather than prose noise. Everything
 * this module does is pure string work — no DB, no VM — so it is unit
 * testable and runs anywhere.
 */

import type { KnowledgeEntry } from '../../tools/knowledge/xppKnowledge.js';

/** How a reference was recognised — drives the resolver's expectations. */
export type RefKind =
  | 'static-call'      // Foo::bar()
  | 'extends'          // extends Foo / implements Foo
  | 'new'              // new Foo()
  | 'attribute'        // [FooAttribute(...)]
  | 'intrinsic'        // classStr(Foo), tableStr(Foo), ...
  | 'declaration';     // Foo fooVar;

export interface KnowledgeRef {
  /** Knowledge entry id the reference came from. */
  entryId: string;
  /** The AOT element name as written in the knowledge content. */
  name: string;
  /** For 'static-call': the method after `::`. */
  member?: string;
  kind: RefKind;
  /** Which field of the entry it was found in (for defect reporting). */
  field: string;
  /** Stable key used by the snapshot: entryId|kind|name[::member]. */
  key: string;
}

/**
 * X++ primitives, keywords and framework pseudo-types that are NOT AOT
 * elements and therefore never resolve against `symbols`. Lowercase.
 */
const NON_AOT = new Set([
  // primitives / built-in types
  'str', 'int', 'int64', 'real', 'date', 'utcdatetime', 'boolean', 'container',
  'anytype', 'guid', 'void', 'timeofday', 'enum', 'class', 'interface', 'table',
  'common', 'blob', 'varstring',
  // control-flow / statement keywords that can precede an identifier
  'if', 'else', 'while', 'for', 'switch', 'case', 'return', 'throw', 'new',
  'select', 'firstonly', 'from', 'where', 'join', 'order', 'group', 'by',
  'public', 'private', 'protected', 'static', 'final', 'abstract', 'extends',
  'implements', 'using', 'true', 'false', 'null', 'this', 'super', 'next',
  'ttsbegin', 'ttscommit', 'ttsabort', 'changecompany', 'delete_from',
  'insert_recordset', 'update_recordset', 'validtimestate', 'crosscompany',
  'display', 'edit', 'client', 'server', 'internal', 'const', 'var',
  // Prose placeholders and grammar terms the knowledge text uses to stand in
  // for a name the reader supplies. Not AOT elements by construction.
  'target', 'classname', 'tablename', 'formname', 'enumname', 'methodname',
  'findoptions', 'fieldlist', 'tablebuffer',
]);

/** PascalCase-ish AOT element name. */
const IDENT = '[A-Z][A-Za-z0-9_]*';

/**
 * Intrinsic functions whose first argument is an AOT element name.
 * `methodStr` is handled separately (two args → type + method).
 */
const INTRINSICS = [
  'classStr', 'tableStr', 'formStr', 'enumStr', 'queryStr', 'reportStr',
  'extendedTypeStr', 'menuItemDisplayStr', 'menuItemActionStr',
  'menuItemOutputStr', 'classNum', 'tableNum', 'enumNum', 'delegateStr',
  'staticMethodStr', 'formControlStr', 'formDataSourceStr', 'dataEntityDataSourceStr',
];

/**
 * Illustrative placeholder names. The knowledge base writes hypothetical
 * elements as `MyFoo` / `IMyFoo` (an existing, consistent convention), so
 * these are *supposed* not to resolve — flagging them would bury the real
 * defects. Anything outside this convention must be a real AOT element.
 */
const PLACEHOLDER = /^I?My[A-Z0-9]/;

/** `class Foo`, `interface Foo` etc. declared inside the example itself. */
function locallyDeclared(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(new RegExp(`\\b(?:class|interface)\\s+(${IDENT})`, 'g'))) {
      out.add(m[1]);
    }
  }
  return out;
}

interface Source { field: string; text: string; }

function entrySources(entry: KnowledgeEntry): Source[] {
  const out: Source[] = [
    { field: 'summary', text: entry.summary },
    ...entry.rules.map((r, i) => ({ field: `rules[${i}]`, text: r })),
  ];
  if (entry.migration) {
    out.push({ field: 'migration.ax2012', text: entry.migration.ax2012 });
    out.push({ field: 'migration.d365fo', text: entry.migration.d365fo });
  }
  for (const [i, ex] of (entry.examples ?? []).entries()) {
    out.push({ field: `examples[${i}].code`, text: ex.code });
  }
  return out;
}

function push(
  acc: Map<string, KnowledgeRef>,
  entryId: string,
  field: string,
  kind: RefKind,
  name: string,
  member?: string,
): void {
  if (NON_AOT.has(name.toLowerCase())) return;
  if (name.length < 3) return;
  const key = `${entryId}|${kind}|${name}${member ? `::${member}` : ''}`;
  // First occurrence wins — keeps the reported field stable across edits
  // elsewhere in the same entry.
  if (!acc.has(key)) acc.set(key, { entryId, name, member, kind, field, key });
}

/** Extract every AOT reference from one knowledge entry. */
export function extractEntryRefs(entry: KnowledgeEntry): KnowledgeRef[] {
  const acc = new Map<string, KnowledgeRef>();
  const sources = entrySources(entry);
  const local = locallyDeclared(sources.map(s => s.text));

  for (const { field, text } of sources) {
    if (!text) continue;

    // Foo::bar(  — static call / member reference
    for (const m of text.matchAll(new RegExp(`\\b(${IDENT})::([A-Za-z_][A-Za-z0-9_]*)`, 'g'))) {
      push(acc, entry.id, field, 'static-call', m[1], m[2]);
    }

    // extends Foo / implements Foo (implements may list several)
    for (const m of text.matchAll(new RegExp(`\\b(?:extends|implements)\\s+(${IDENT}(?:\\s*,\\s*${IDENT})*)`, 'g'))) {
      for (const one of m[1].split(',')) push(acc, entry.id, field, 'extends', one.trim());
    }

    // new Foo(
    for (const m of text.matchAll(new RegExp(`\\bnew\\s+(${IDENT})\\s*\\(`, 'g'))) {
      push(acc, entry.id, field, 'new', m[1]);
    }

    // [FooAttribute] / [FooAttribute(...)]. Only the *leading* token of the
    // bracket is the attribute; brackets containing `::` are X++ container
    // literals (`[NoYes::Yes, NoYes::No]`), not attributes at all.
    for (const m of text.matchAll(/\[([^\]]+)\]/g)) {
      if (m[1].includes('::')) continue;
      const attr = m[1].match(new RegExp(`^\\s*(${IDENT})\\s*(?:\\(|$)`));
      if (attr) push(acc, entry.id, field, 'attribute', attr[1]);
    }

    // classStr(Foo), tableStr(Foo), ...
    for (const fn of INTRINSICS) {
      for (const m of text.matchAll(new RegExp(`\\b${fn}\\s*\\(\\s*(${IDENT})`, 'g'))) {
        push(acc, entry.id, field, 'intrinsic', m[1]);
      }
    }
    // methodStr(Foo, bar) — type + method
    for (const m of text.matchAll(new RegExp(`\\bmethodStr\\s*\\(\\s*(${IDENT})\\s*,\\s*([A-Za-z_][A-Za-z0-9_]*)`, 'g'))) {
      push(acc, entry.id, field, 'static-call', m[1], m[2]);
    }

    // Declarations at the start of a code line: `Foo fooVar;` / `Foo fooVar =`
    // Only inside code examples — prose sentences produce false positives.
    if (field.endsWith('.code')) {
      for (const line of text.split('\n')) {
        const m = line.match(new RegExp(`^\\s{0,8}(${IDENT})\\s+([a-z_][A-Za-z0-9_]*)\\s*(;|=[^=])`));
        if (m) push(acc, entry.id, field, 'declaration', m[1]);
      }
    }
  }

  return [...acc.values()].filter(r => !local.has(r.name) && !PLACEHOLDER.test(r.name));
}

/** Extract references from the whole knowledge base, in entry order. */
export function extractKnowledgeRefs(base: KnowledgeEntry[]): KnowledgeRef[] {
  return base.flatMap(extractEntryRefs);
}
