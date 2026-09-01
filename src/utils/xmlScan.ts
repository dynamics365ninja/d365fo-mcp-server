/**
 * Reading structure out of AOT XML without a sanitising `replace()`.
 *
 * The tempting one-liner is `xml.replace(/<!--[\s\S]*?-->/g, '')` and then a
 * regex for the element you want. It is wrong twice over. A single pass leaves
 * an UNTERMINATED `<!--` in place, so the very next match can read markup out of
 * a comment — the identity of an object, say — and CodeQL flags it as
 * `js/incomplete-multi-character-sanitization`. This repo has now paid for that
 * shape twice: once in the eval oracle's `aotRootElement` (commit 228fb58) and
 * once in the write-path guards that borrowed its idea but not its fix.
 *
 * So there is no sanitizer here. The document is walked TOKEN BY TOKEN with the
 * skippable forms first, which cannot leave a stray delimiter behind:
 *
 *   comment · CDATA · processing instruction · doctype · element
 *
 * The unterminated branches are load-bearing, not defensive padding. Without
 * them the scan fails to match at the `<!--`, advances one character, and
 * matches an element INSIDE the comment — the bug being fixed. Consuming to end
 * of input instead ends the scan, so a document whose remainder is commented out
 * yields nothing after that point, which is the honest answer.
 */

/**
 * One token of an XML document. Order matters: comment and CDATA (terminated,
 * then unterminated) come before anything that could match their contents.
 */
const XML_TOKEN =
  /<!--[\s\S]*?-->|<!--[\s\S]*$|<!\[CDATA\[[\s\S]*?\]\]>|<!\[CDATA\[[\s\S]*$|<\?[\s\S]*?\?>|<\?[\s\S]*$|<!DOCTYPE[^>]*>|<\/([A-Za-z_][\w.\-]*)\s*>|<([A-Za-z_][\w.\-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

/**
 * A private token scanner over the same grammar, for callers that need the raw
 * token stream rather than leaves — element ORDER, for instance, which no XML
 * object model in this repo preserves.
 *
 * Each caller gets its own RegExp: a module-level one carries `lastIndex`
 * between calls, so two scans that interleave (a nested walk, a generator the
 * caller stops early) would silently skip half a document.
 */
export function createXmlTokenScanner(): RegExp {
  return new RegExp(XML_TOKEN.source, 'g');
}

/** A leaf element: one with text content and no child element. */
export interface XmlLeaf {
  name: string;
  /** Raw text between the tags, untrimmed. */
  text: string;
  /** 1 for a child of the root element, 2 for its grandchildren, and so on. */
  depth: number;
}

/**
 * Every leaf element carrying text, in document order, with its nesting depth.
 *
 * CDATA is consumed whole, so the `<` characters inside an X++ `<Declaration>`
 * never look like markup and never disturb the depth count.
 */
export function scanXmlLeaves(xml: string): XmlLeaf[] {
  const leaves: XmlLeaf[] = [];
  let depth = 0;
  /** The last start tag seen, and where its content began. */
  let open: { name: string; contentAt: number } | null = null;

  XML_TOKEN.lastIndex = 0;
  let token: RegExpExecArray | null;
  while ((token = XML_TOKEN.exec(xml)) !== null) {
    const closing = token[1];
    const starting = token[2];
    const selfClosing = token[4] === '/';

    if (closing) {
      if (open && open.name === closing) {
        // No element opened in between, so everything between the tags is text.
        // `depth` counts the element itself; a child of the root has ONE
        // ancestor, so the reported depth is one less.
        leaves.push({ name: closing, text: xml.slice(open.contentAt, token.index), depth: depth - 1 });
      }
      open = null;
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (starting) {
      if (selfClosing) {
        // `<Fields />` — an empty collection, not a leaf with a value.
        open = null;
        continue;
      }
      depth++;
      open = { name: starting, contentAt: token.index + token[0].length };
    }
  }
  return leaves;
}

/** The text of the first leaf with this name at this depth, or undefined. */
export function firstLeafText(xml: string, name: string, depth = 1): string | undefined {
  for (const leaf of scanXmlLeaves(xml)) {
    if (leaf.depth === depth && leaf.name === name) return leaf.text;
  }
  return undefined;
}
