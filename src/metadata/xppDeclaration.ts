/**
 * X++ method declaration parser.
 *
 * Shared by the signature tool (src/tools/methodSignature.ts) and the XML
 * metadata parser (src/metadata/xmlParser.ts) — both used to carry their own
 * regex-based extractor, and both got multi-line declarations wrong in
 * different ways.
 *
 * X++ declarations routinely wrap the parameter list across several lines
 * (every standard construct/new* pattern with defaulted params does), so the
 * declaration is located by position and closed by balanced-paren scanning —
 * never by assuming it fits on one line, and never by stopping at the first
 * ')' (which sits inside defaults like `= classStr(FormletterService)`).
 *
 * A parse that cannot be trusted returns null so callers fall through to their
 * own fallbacks, rather than emitting a confidently wrong signature.
 */

export interface XppDeclaration {
  modifiers: string[];
  returnType: string;
  parameters: XppDeclarationParameter[];
}

export interface XppClassHeader {
  kind: 'class' | 'interface';
  name: string;
  extends?: string;
  implements: string[];
  isAbstract: boolean;
  isFinal: boolean;
}

export interface XppDeclarationParameter {
  type: string;
  name: string;
  defaultValue?: string;
}

export const MODIFIER_KEYWORDS = [
  'public', 'private', 'protected', 'internal', 'static', 'final', 'abstract', 'display', 'edit',
];

/**
 * Keywords that can legally sit directly before `name(` in an expression
 * (`return foo();`, `if (foo())`). A declaration's return type is never one of
 * them, so seeing one means we matched a call.
 */
const STATEMENT_KEYWORDS = [
  'return', 'if', 'while', 'for', 'switch', 'throw', 'else', 'do', 'new',
];

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Produce a same-length copy of X++ source where comment content and
 * string-literal content are blanked out with spaces (newlines preserved, so
 * line structure and every index map 1:1 to the original).
 *
 * Declaration search, paren balancing and modifier detection all run on this
 * copy, so they can't be fooled by a method name or keyword mentioned in a
 * comment/attribute string, or by parens/commas inside string defaults.
 */
export function blankCommentsAndStrings(src: string): string {
  const out = src.split('');
  let state: 'code' | 'line' | 'block' | 'str' = 'code';
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out[i] = out[i + 1] = ' '; i++; }
      else if (c === '/' && d === '*') { state = 'block'; out[i] = out[i + 1] = ' '; i++; }
      else if (c === "'" || c === '"') { state = 'str'; quote = c; }
    } else if (state === 'line') {
      if (c === '\n') state = 'code';
      else out[i] = ' ';
    } else if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out[i] = out[i + 1] = ' '; i++; }
      else if (c !== '\n') out[i] = ' ';
    } else {
      // Inside a string. Escapes are consumed as a pair so `\'` can't end it —
      // but never swallow a newline, which would break the 1:1 line mapping.
      if (c === '\\') { out[i] = ' '; if (d !== undefined && d !== '\n') { out[i + 1] = ' '; i++; } }
      else if (c === quote) state = 'code';
      else if (c !== '\n') out[i] = ' ';
    }
  }
  return out.join('');
}

/**
 * Split a parameter list on top-level commas only — commas nested inside
 * parens (intrinsic defaults like methodStr(A, b)) or brackets (container
 * literals) belong to the parameter, not the list. `blanked` is the
 * comment/string-blanked twin of `paramSrc` used for structural decisions;
 * slices are taken from the original so default values stay verbatim.
 */
function splitTopLevelParams(paramSrc: string, blanked: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(paramSrc.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(paramSrc.slice(start));
  return parts;
}

/** `SalesTable`, `Microsoft.Dynamics.Foo`, or the length in `str 30 _name`. */
function isTypeToken(t: string): boolean {
  return /^[A-Za-z_][\w.]*$/.test(t) || /^\d+$/.test(t);
}

function isNameToken(t: string): boolean {
  return /^[A-Za-z_]\w*$/.test(t);
}

/**
 * Parse one "Type _name [= default]" parameter; null when it doesn't look like
 * a declared parameter (which is how a call's arguments are told apart from a
 * declaration's parameter list).
 */
function parseParameter(raw: string, blanked: string): XppDeclarationParameter | null {
  // Split off the default at the first top-level '='
  let eq = -1;
  let depth = 0;
  for (let i = 0; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '=' && depth === 0) { eq = i; break; }
  }
  const left = (eq >= 0 ? raw.slice(0, eq) : raw).trim().replace(/\s+/g, ' ');
  const defaultValue = eq >= 0 ? raw.slice(eq + 1).trim().replace(/\s+/g, ' ') : undefined;

  const tokens = left.split(' ').filter(Boolean);
  if (tokens.length < 2) return null;
  const name = tokens[tokens.length - 1];
  const typeTokens = tokens.slice(0, -1);
  if (!isNameToken(name) || !typeTokens.every(isTypeToken)) return null;
  if (eq >= 0 && !defaultValue) return null;

  const type = typeTokens.join(' ');
  return defaultValue ? { type, name, defaultValue } : { type, name };
}

/**
 * Try to read a declaration whose name starts at `nameStart`. Returns null when
 * this occurrence is a call rather than a declaration, or is malformed.
 */
function tryDeclarationAt(source: string, blanked: string, nameStart: number): XppDeclaration | null {
  const openParen = blanked.indexOf('(', nameStart);
  if (openParen < 0) return null;

  // Balanced scan (on the blanked copy) to the closing paren, across lines.
  let depth = 0;
  let closeParen = -1;
  for (let i = openParen; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) { closeParen = i; break; }
    }
  }
  if (closeParen < 0) return null;

  // A declaration is followed by its body, or by ';' for abstract/interface
  // methods. An expression call (`if (foo())`, `foo() + 1`) is not. Nothing
  // following at all means the source is the bare declaration, which is fine.
  const after = /^\s*(\S)/.exec(blanked.slice(closeParen + 1));
  if (after && after[1] !== '{' && after[1] !== ';') return null;

  // Modifiers and return type live on the declaration line, before the name.
  // Sliced from the blanked twin so a same-line comment or attribute string
  // can't inject a keyword (`/* static */ public void foo()`).
  const lineStart = blanked.lastIndexOf('\n', nameStart) + 1;
  const prefix = blanked.slice(lineStart, nameStart);

  // A declaration's prefix is `[attributes] [modifiers] ReturnType`; an '='
  // means we matched the right-hand side of an assignment (`x = foo();`).
  if (prefix.includes('=')) return null;

  const modifiers = MODIFIER_KEYWORDS.filter(k => new RegExp(`\\b${k}\\b`, 'i').test(prefix));

  // Return type: last identifier in the prefix that isn't a modifier keyword.
  const prefixTokens = prefix.match(/[\w.]+/g) ?? [];
  const typeTokens = prefixTokens.filter(t => !MODIFIER_KEYWORDS.includes(t.toLowerCase()));
  const returnType = typeTokens[typeTokens.length - 1];
  // Every X++ method declares a return type before its name. Without one this
  // is a bare call (`construct(1);`), not a declaration.
  if (!returnType || STATEMENT_KEYWORDS.includes(returnType.toLowerCase())) return null;

  // Parameters: original text between the balanced parens (defaults verbatim).
  const paramSrc = source.slice(openParen + 1, closeParen);
  const paramBlanked = blanked.slice(openParen + 1, closeParen);
  const parameters: XppDeclarationParameter[] = [];
  if (paramBlanked.trim()) {
    const rawParts = splitTopLevelParams(paramSrc, paramBlanked);
    const blankedParts = splitTopLevelParams(paramBlanked, paramBlanked);
    for (let i = 0; i < rawParts.length; i++) {
      const param = parseParameter(rawParts[i], blankedParts[i]);
      // All-or-nothing: emitting a partial list would produce a signature and a
      // CoC `next()` call with the wrong arity — the exact failure this parser
      // exists to prevent. A list we can't fully read means this isn't a
      // declaration (or is malformed), so let the caller fall back.
      if (!param) return null;
      parameters.push(param);
    }
  }

  return { modifiers, returnType, parameters };
}

/**
 * Parse the header of an AxClass `<SourceCode><Declaration>` CDATA block —
 * `[attributes] [modifiers] class Name [extends Base] [implements A, B] {`.
 *
 * The inheritance clause exists ONLY as X++ text here; AxClass XML has no
 * <Extends>/<Implements>/<IsAbstract>/<IsFinal> elements, so reading those
 * (as this parser used to) yields undefined for every class in the AOT.
 *
 * Two traps this avoids, both measured against the real AOT:
 *  - The header routinely wraps across lines (~17% of implements lists are
 *    multi-line), so it is closed by the body's '{', never by end-of-line.
 *  - Doc comments above the class say things like "extends the base class",
 *    so a regex over the raw CDATA harvests `extends the`. Comments and
 *    strings are blanked first, and the search is anchored at the class
 *    keyword rather than run over the whole block.
 *
 * Returns null when no class/interface header is present.
 */
export function parseXppClassHeader(declaration: string): XppClassHeader | null {
  if (!declaration || typeof declaration !== 'string') return null;

  const blanked = blankCommentsAndStrings(declaration);
  const kw = /\b(class|interface)\s+([\w.]+)/.exec(blanked);
  if (!kw) return null;

  // The header runs from the keyword to the body's opening brace. A declaration
  // block with no brace (malformed/truncated) still yields a usable header.
  const braceIdx = blanked.indexOf('{', kw.index);
  const headEnd = braceIdx < 0 ? blanked.length : braceIdx;
  const head = blanked.slice(kw.index, headEnd);

  // Modifiers sit before the keyword on its own line; attributes on preceding
  // lines are excluded, and a blanked attribute body can't inject a keyword.
  const lineStart = blanked.lastIndexOf('\n', kw.index) + 1;
  const modifiers = blanked.slice(lineStart, kw.index);

  const extendsMatch = /\bextends\s+([\w.]+)/i.exec(head);
  const implementsMatch = /\bimplements\s+([\s\S]+)$/i.exec(head);
  const implementsList = implementsMatch
    ? implementsMatch[1].split(',').map(s => s.trim()).filter(Boolean)
    : [];

  return {
    kind: kw[1] as 'class' | 'interface',
    name: kw[2],
    extends: extendsMatch?.[1],
    implements: implementsList,
    isAbstract: /\babstract\b/i.test(modifiers),
    isFinal: /\bfinal\b/i.test(modifiers),
  };
}

/**
 * Locate and parse the declaration of `methodName` in X++ source.
 * Returns null when no trustworthy declaration is found.
 */
export function parseXppDeclaration(source: string, methodName: string): XppDeclaration | null {
  if (!source || !methodName) return null;

  const blanked = blankCommentsAndStrings(source);

  // Candidate occurrences: the method name not preceded by a word char, '.' or
  // ':' (which would make it a call like `this.name(` / `Owner::name(`),
  // followed by '('. Comments and string contents are blanked, so an attribute
  // like [SysObsolete('use construct() instead')] can't match. Occurrences are
  // tried in order and the first one that validates as a declaration wins, so a
  // call appearing before the declaration can't shadow it.
  const nameRe = new RegExp(`(^|[^\\w.:])(${escapeRegExp(methodName)})\\s*\\(`, 'gi');
  for (const m of blanked.matchAll(nameRe)) {
    const decl = tryDeclarationAt(source, blanked, m.index + m[1].length);
    if (decl) return decl;
  }
  return null;
}
