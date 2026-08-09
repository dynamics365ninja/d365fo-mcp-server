/**
 * X++ method-source re-indentation.
 *
 * Re-derives indentation from block structure alone, discarding whatever leading
 * whitespace the input had, so output is consistent regardless of how the
 * caller indented a method body.
 *
 * Microsoft convention (verified against shipped platform code, e.g.
 * ApplicationFoundation/AxClass/AVActionCompletedEventData.xml): the doc
 * comment + signature line sit at one indent level (4 spaces) — the matching
 * `{`/`}` sit at that same level, and nested content goes one level deeper
 * per brace.
 *
 * A `case`/`default` label also opens a level even though it opens no brace
 * (ApplicationFoundation/AxClass/AVTimeframe.xml). Deriving depth from braces
 * alone flattened every case body onto its label —
 *
 *     case QualityTier::None:
 *     return "@None";
 *
 * — and it did that to correct input too, so a well-formatted switch handed in
 * came back wrong and had to be repaired by hand afterwards.
 *
 * A statement continued onto further lines indents those lines one level past
 * its first line. Brace depth alone cannot see this — no brace opens — so a
 * wrapped statement came back flattened onto one level, again including
 * correct input:
 *
 *     select firstonly oldRecord
 *     where oldRecord.RecId == this.RecId;
 *
 * That is what a caller who wrapped the `where` (and the `&&` of a wrapped
 * `if`) got back after `d365fo_file` wrote the method.
 *
 * "Is this statement finished?" is asked of the line's CODE, never its raw text.
 * Asked of the raw text, a trailing comment hid the `;` —
 *
 *     ttsbegin; // start
 *         ttscommit;
 *
 * — and every line after one got a level it had not earned. The result was
 * stable under re-formatting, so nothing ever put it back.
 */

const INDENT_UNIT = '    ';

/** A `{ … }` block currently open, and whether a case label is open inside it. */
interface OpenBlock {
  /** The block is a switch body, so `case`/`default` labels indent their bodies. */
  isSwitch: boolean;
  /** A case label in this switch body has opened a level not yet closed. */
  caseOpen: boolean;
}

/** What one line contributes, read once with strings and comments accounted for. */
interface LineScan {
  /** `{` and `}` in source order, ignoring string literals and comments. */
  braces: Array<'{' | '}'>;
  /** How many of those `}` precede any other code on the line. */
  leadingCloses: number;
  /**
   * The line with its comments removed — the only thing worth asking syntax
   * questions of. `x = 1; // set it` reads as an unfinished statement until the
   * comment is gone, and every line after it then got a continuation level it
   * had not earned.
   */
  code: string;
  /** A `/*` opened on this line (or before it) and is still open at its end. */
  blockCommentOpen: boolean;
}

/**
 * Read one line: brace events, and the code with comments stripped.
 *
 * X++ string literals take EITHER quote — `"text"` and `'text'` are the same
 * literal. Recognising only `'` let a brace inside a double-quoted string count
 * as real: `info("a } b");` popped a block and shifted every following line of
 * the method out by one level. Both quote styles escape by doubling (`""`) and
 * by backslash (`\"`).
 *
 * `inBlockCommentAtStart` carries a `/* …` that a previous line left open, so
 * the body of a multi-line comment is not read as code — a `}` in prose does
 * not pop a block, and a prose line does not continue the statement above it.
 */
function scanLine(line: string, inBlockCommentAtStart = false): LineScan {
  const braces: Array<'{' | '}'> = [];
  const code: string[] = [];
  let leadingCloses = 0;
  let sawNonCloseNonSpace = false;
  /** The quote character that opened the string literal we are inside, if any. */
  let stringQuote: '"' | "'" | null = null;
  let inBlockComment = inBlockCommentAtStart;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];

    if (inBlockComment) {
      if (c === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (stringQuote) {
      code.push(c);
      if (c === '\\' && next !== undefined) { code.push(next); i++; continue; } // \" \\ \n …
      if (c === stringQuote && next === stringQuote) { code.push(next); i++; continue; } // doubled quote
      if (c === stringQuote) stringQuote = null;
      continue;
    }
    if (c === "'" || c === '"') { stringQuote = c; code.push(c); continue; }
    if (c === '/' && next === '/') break;
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }

    code.push(c);
    if (c === '{') { braces.push('{'); sawNonCloseNonSpace = true; }
    else if (c === '}') {
      braces.push('}');
      if (!sawNonCloseNonSpace) leadingCloses++;
    } else if (c !== ' ' && c !== '\t') {
      sawNonCloseNonSpace = true;
    }
  }
  return { braces, leadingCloses, code: code.join('').trim(), blockCommentOpen: inBlockComment };
}

/** A `case X:` or `default:` label — the statements after it belong one level in. */
function isCaseLabel(trimmed: string): boolean {
  return /^(case\b|default\s*:)/.test(trimmed);
}

/**
 * Does this line leave nothing open, so the next line starts fresh at block depth?
 *
 * Takes the line's CODE (see `LineScan.code`), never the raw text: judged on the
 * raw text, `ttsbegin; // start` does not end in `;` and pushed `ttscommit;` a
 * level in — and the result was stable under re-formatting, so nothing put it
 * back. A trailing comment is the most ordinary thing in the language.
 *
 * True for a statement end (`;`), a brace, a label/`case` colon, a comment-only
 * line (which strips to nothing), a macro line, and a one-line attribute — false
 * for anything that reads as the middle of a statement (`if (a`,
 * `select firstonly t`, `&& b`, `_p1,`). A line the caller wrapped therefore
 * gets one extra level; the level does not accumulate, because the flag is
 * re-derived from the previous line each time, which is what shipped platform
 * code does for a three-line `if` condition.
 */
function terminatesStatement(code: string): boolean {
  if (code === '') return true; // comment-only line, or the body of a block comment
  if (code.startsWith('#')) return true; // #define / #macrolib
  if (code.startsWith('[') && code.endsWith(']')) return true; // [ExtensionOf(…)]
  return /[;{}:]$/.test(code);
}

/**
 * Re-indent an X++ method source block (doc comment + signature + body) to
 * the D365FO convention. `baseDepth` is the indent level (in 4-space units)
 * of the signature line itself — 1 for a method embedded in a class/table
 * <Source> element (the standard case), matching real shipped code.
 */
export function reindentXppSource(source: string, baseDepth = 1): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  // Trim leading/trailing all-blank lines; preserve blank lines in the middle.
  // Callers that store the result add the trailing blank line D365FO writes
  // between methods — see xppMethodSourceForXml.
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) return '';

  const blocks: OpenBlock[] = [];
  /** A `switch` was seen and its `{` has not opened yet. */
  let pendingSwitch = false;

  const openCases = () => blocks.reduce((n, b) => n + (b.caseOpen ? 1 : 0), 0);
  const depthNow = () => Math.max(baseDepth + blocks.length + openCases(), 0);
  const innermostSwitch = (): OpenBlock | undefined => {
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].isSwitch) return blocks[i];
    return undefined;
  };
  /** Close the case level of the innermost switch, if one is open. */
  const closeOpenCase = () => {
    const sw = innermostSwitch();
    if (sw?.caseOpen) sw.caseOpen = false;
  };

  const out: string[] = [];
  /** The previous non-blank line left a statement open, so this line continues it. */
  let continues = false;
  /** A `/* …` from an earlier line is still open, so this line is prose. */
  let inBlockComment = false;

  for (const raw of lines) {
    const trimmed = raw.trim();
    // A blank line inside a wrapped statement neither opens nor closes one, so
    // it passes the pending state through untouched.
    if (trimmed === '') { out.push(''); continue; }

    const { braces, leadingCloses, code, blockCommentOpen } = scanLine(trimmed, inBlockComment);
    inBlockComment = blockCommentOpen;
    const startsCase = isCaseLabel(code);

    // A new label ends the previous one; a `}` that closes the switch body ends
    // it too, and must do so before the block itself is popped.
    if (startsCase) closeOpenCase();

    let braceIdx = 0;
    for (let i = 0; i < leadingCloses; i++) {
      const top = blocks[blocks.length - 1];
      if (top?.isSwitch && top.caseOpen) top.caseOpen = false;
      blocks.pop();
      braceIdx++;
    }

    // The brace that opens or closes the wrapped statement's own block belongs
    // at block depth, not one level in — `if (a\n    && b)\n{` puts the `{`
    // under the `if`, not under the `&&`.
    const isBraceOnlyStart = code.startsWith('{') || code.startsWith('}');
    const continuationIndent = continues && !isBraceOnlyStart ? 1 : 0;

    out.push(INDENT_UNIT.repeat(depthNow() + continuationIndent) + trimmed);
    continues = !terminatesStatement(code);

    // Braces after the leading closes: opens push a block, further closes pop.
    for (; braceIdx < braces.length; braceIdx++) {
      if (braces[braceIdx] === '{') {
        blocks.push({ isSwitch: pendingSwitch, caseOpen: false });
        pendingSwitch = false;
      } else {
        const top = blocks[blocks.length - 1];
        if (top?.isSwitch && top.caseOpen) top.caseOpen = false;
        blocks.pop();
      }
    }

    // `switch (x)` with its `{` on the following line.
    if (/^switch\b/.test(code) && !braces.includes('{')) pendingSwitch = true;

    if (startsCase) {
      const sw = innermostSwitch();
      // Only indent under the label when we are actually inside a switch body;
      // a stray "case" outside one must not shift the rest of the method.
      if (sw) sw.caseOpen = true;
    }
  }
  return out.join('\n');
}

/**
 * A method's X++ as D365FO stores it inside `<Source><![CDATA[ … ]]>`.
 *
 * Shipped metadata ends every method with a blank line before the `]]>`, so the
 * methods of a class are separated by one when the AOT reassembles them. The
 * re-indenter deliberately trims trailing blanks, and the writers that did not
 * add one back produced classes whose methods sit directly on top of each
 * other — visible in Visual Studio, and in the XML against any shipped file.
 */
export function xppMethodSourceForXml(source: string): string {
  const body = reindentXppSource(source);
  return body === '' ? '' : `${body}\n`;
}
