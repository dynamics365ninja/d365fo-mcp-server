/**
 * Where in an object's AOT XML a `replace-code` scoped by `methodName` may act.
 *
 * The bridge (MetadataWriteService.ReplaceInMethods) honours methodName: it
 * replaces only inside the named method, the class declaration for
 * "classDeclaration", or a form control / data source override for
 * "Owner.method". The file-level preflight and the direct-XML fallback used to
 * look at the whole file instead, so an oldCode that also occurs in another
 * method was refused even though the bridge would have edited one site — and
 * the refusal told the caller to add the methodName it had already passed.
 * These spans let both checks see what the bridge sees.
 */

/** A [start, end) character range of method source inside the XML text. */
export interface SourceSpan {
  start: number;
  end: number;
}

const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Spans of the CDATA bodies of `<Method>`s named `name` within [from, to). */
function methodSpansIn(content: string, name: string, from: number, to: number): SourceSpan[] {
  const spans: SourceSpan[] = [];
  const re = new RegExp(`<Method>\\s*<Name>${escapeRegex(name)}</Name>\\s*<Source>${escapeRegex(CDATA_OPEN)}`, 'gi');
  re.lastIndex = from;
  for (let m = re.exec(content); m && m.index < to; m = re.exec(content)) {
    const start = m.index + m[0].length;
    const end = content.indexOf(CDATA_CLOSE, start);
    if (end === -1 || end > to) break;
    spans.push({ start, end });
    re.lastIndex = end;
  }
  return spans;
}

/**
 * The `<Methods>` block that directly belongs to the element named `owner`
 * (a form control or data source): `<Name>owner</Name>`, then only simple
 * properties, then `<Methods>`. Another `<Name>` in between means the block
 * belongs to something else.
 */
function ownerMethodBlocks(content: string, owner: string): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  const re = new RegExp(`<Name>${escapeRegex(owner)}</Name>`, 'gi');
  for (let m = re.exec(content); m; m = re.exec(content)) {
    const afterName = m.index + m[0].length;
    const open = content.indexOf('<Methods>', afterName);
    if (open === -1) break;
    if (content.slice(afterName, open).includes('<Name>')) continue;
    const close = content.indexOf('</Methods>', open);
    if (close === -1) break;
    blocks.push([open, close]);
  }
  return blocks;
}

/**
 * The source ranges a replace-code with this `methodName` may touch, or
 * `undefined` when no methodName was given (the whole file is in scope).
 * An empty array means the named method is not in this file.
 * Names compare case-insensitively, as the bridge compares them.
 */
export function methodSourceSpans(content: string, methodName?: string): SourceSpan[] | undefined {
  const name = methodName?.trim();
  if (!name) return undefined;

  if (name.toLowerCase() === 'classdeclaration') {
    const m = /<Declaration><!\[CDATA\[/.exec(content);
    if (!m) return [];
    const start = m.index + m[0].length;
    const end = content.indexOf(CDATA_CLOSE, start);
    return end === -1 ? [] : [{ start, end }];
  }

  const dot = name.indexOf('.');
  if (dot > 0) {
    const owner = name.slice(0, dot);
    const method = name.slice(dot + 1);
    return ownerMethodBlocks(content, owner).flatMap(([from, to]) => methodSpansIn(content, method, from, to));
  }

  return methodSpansIn(content, name, 0, content.length);
}

/**
 * 1-based line numbers at which `needle` occurs inside the method `methodName`,
 * or `undefined` when no methodName was given.
 */
export function methodScopedLines(content: string, needle: string, methodName?: string): number[] | undefined {
  const spans = methodSourceSpans(content, methodName);
  return spans && occurrencesInSpans(content, needle, spans).map(at => content.slice(0, at).split('\n').length);
}

/** Start offsets of `needle` that fall entirely inside one of `spans`. */
export function occurrencesInSpans(content: string, needle: string, spans: SourceSpan[]): number[] {
  const hits: number[] = [];
  for (const { start, end } of spans) {
    for (
      let at = content.indexOf(needle, start);
      at !== -1 && at + needle.length <= end;
      at = content.indexOf(needle, at + Math.max(needle.length, 1))
    ) {
      hits.push(at);
    }
  }
  return hits;
}
