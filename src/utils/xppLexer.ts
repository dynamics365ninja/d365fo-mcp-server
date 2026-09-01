/**
 * Shared X++ lexer-lite: the single place that knows where a string literal or a
 * comment starts and ends.
 *
 * Every keyword/regex scan in this repo runs against a *masked* copy of the source
 * so that a keyword inside a literal cannot fire a rule. Before this module there
 * were five independent maskers and two of them (validateXpp, xppSelectLint)
 * recognised only double-quoted strings. Measured on 7,649 shipped AOT files, that
 * single hole produced every error-severity false positive the validator had:
 *
 *   strFind(text, ',', 1, len)        → FN001 "expects 4 arguments" (the ',' counted)
 *   '????????-????-…' (a GUID mask)   → CS001 "?? is C#"
 *   ' LEFT JOIN %2 T2 ON …' (SQL)     → SEL007 "left join is not X++"
 *
 * X++ literal rules this implements (verified against xppc 7.0.7996.33):
 *  - "…" and '…' are both string literals; \ escapes the next character.
 *  - @"…" / @'…' are verbatim: the backslash is an ordinary character, the literal
 *    may span lines, and it ends at the next matching quote.
 *  - // to end of line, and /* … *\/ block comments (### and /// are ordinary text
 *    to the lexer; /// is a doc comment and callers that care about it check the
 *    prefix themselves).
 *
 * Masking preserves the byte length and every newline, so line numbers and offsets
 * taken from the masked text address the original source. Delimiters (the quotes,
 * the // and /*) survive; only the CONTENT becomes spaces, which is what lets a
 * rule still see that a call had a string argument at all.
 *
 * This is deliberately not a tokenizer and not a parser: rules stay regex-based
 * over this lexer's masked source. "No AST, one shared lexer" is a standing
 * decision — a rule that genuinely needs scope is rejected rather than
 * approximated (see docs/BACKLOG.md, "DECL001 / CONV001").
 */

export type XppSpanKind = 'string' | 'line-comment' | 'block-comment';

export interface XppSpan {
  /** Offset of the first character of the span (the opening delimiter). */
  start: number;
  /** Offset one past the last character of the span. */
  end: number;
  kind: XppSpanKind;
  /** For strings: the quote character used. */
  quote?: '"' | "'";
  /** For strings: true when the literal was introduced with @ (verbatim). */
  verbatim?: boolean;
}

export interface XppScan {
  /** Source with literal/comment CONTENT replaced by spaces; same length, same newlines. */
  masked: string;
  spans: XppSpan[];
}

/**
 * Scan X++ source, returning the masked copy plus the spans that were masked.
 */
export function scanXpp(code: string): XppScan {
  const out = code.split('');
  const spans: XppSpan[] = [];
  const n = code.length;
  let i = 0;

  while (i < n) {
    const c = code[i];
    const c2 = i + 1 < n ? code[i + 1] : '';

    // Line comment — content to end of line.
    if (c === '/' && c2 === '/') {
      const start = i;
      i += 2;
      while (i < n && code[i] !== '\n') { out[i] = ' '; i++; }
      spans.push({ start, end: i, kind: 'line-comment' });
      continue;
    }

    // Block comment — content up to the closing marker (both markers blanked as
    // before, so a stray */ cannot look like an operator).
    if (c === '/' && c2 === '*') {
      const start = i;
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      spans.push({ start, end: i, kind: 'block-comment' });
      continue;
    }

    // Verbatim string: @"…" or @'…' — no escape processing.
    if (c === '@' && (c2 === '"' || c2 === "'")) {
      const quote = c2 as '"' | "'";
      const start = i;
      i += 2; // past @ and the opening quote
      while (i < n && code[i] !== quote) {
        if (code[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) i++; // closing quote stays
      spans.push({ start, end: i, kind: 'string', quote, verbatim: true });
      continue;
    }

    // Ordinary string: "…" or '…' — backslash escapes the next character.
    if (c === '"' || c === "'") {
      const quote = c as '"' | "'";
      const start = i;
      i++; // opening quote stays
      while (i < n && code[i] !== quote) {
        if (code[i] === '\\') {
          out[i] = ' ';
          if (i + 1 < n && code[i + 1] !== '\n') out[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (code[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) i++; // closing quote stays
      spans.push({ start, end: i, kind: 'string', quote });
      continue;
    }

    i++;
  }

  return { masked: out.join(''), spans };
}

/**
 * Masked copy of the source: literal and comment content replaced by spaces,
 * delimiters and newlines preserved, length unchanged.
 */
export function maskXpp(code: string): string {
  return scanXpp(code).masked;
}

/** True when `offset` falls inside a string literal or a comment. */
export function isMasked(spans: XppSpan[], offset: number): boolean {
  return spans.some(s => offset >= s.start && offset < s.end);
}
