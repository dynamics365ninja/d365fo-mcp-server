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
 */

const INDENT_UNIT = '    ';

/** A `{ … }` block currently open, and whether a case label is open inside it. */
interface OpenBlock {
  /** The block is a switch body, so `case`/`default` labels indent their bodies. */
  isSwitch: boolean;
  /** A case label in this switch body has opened a level not yet closed. */
  caseOpen: boolean;
}

/** `{` and `}` in source order, ignoring string literals and comments. */
function braceEvents(line: string): { braces: Array<'{' | '}'>; leadingCloses: number } {
  const braces: Array<'{' | '}'> = [];
  let leadingCloses = 0;
  let sawNonCloseNonSpace = false;
  let inString = false;
  let inBlockComment = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];

    if (inBlockComment) {
      if (c === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inString) {
      if (c === "'" && next === "'") { i++; continue; } // escaped '' inside a string
      if (c === "'") inString = false;
      continue;
    }
    if (c === "'") { inString = true; continue; }
    if (c === '/' && next === '/') break;
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }

    if (c === '{') { braces.push('{'); sawNonCloseNonSpace = true; }
    else if (c === '}') {
      braces.push('}');
      if (!sawNonCloseNonSpace) leadingCloses++;
    } else if (c !== ' ' && c !== '\t') {
      sawNonCloseNonSpace = true;
    }
  }
  return { braces, leadingCloses };
}

/** A `case X:` or `default:` label — the statements after it belong one level in. */
function isCaseLabel(trimmed: string): boolean {
  return /^(case\b|default\s*:)/.test(trimmed);
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
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '') { out.push(''); continue; }

    const { braces, leadingCloses } = braceEvents(trimmed);
    const startsCase = isCaseLabel(trimmed);

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

    out.push(INDENT_UNIT.repeat(depthNow()) + trimmed);

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
    if (/^switch\b/.test(trimmed) && !braces.includes('{')) pendingSwitch = true;

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
