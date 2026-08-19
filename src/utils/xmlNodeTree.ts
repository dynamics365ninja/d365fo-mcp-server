/**
 * Minimal offset-preserving XML reader for AOT metadata files.
 *
 * A real parse + re-serialize would reformat the whole file (D365FO metadata XML
 * is diffed by humans and by TFVC), so this walks the tags and records offsets
 * instead, leaving every byte we don't touch exactly as it was. Every writer
 * built on it splices strings at those offsets.
 *
 * It lived inside formExtensionControlXml.ts, which is where the shape was first
 * needed. It is not about form extensions: the control-REMOVAL writer needs the
 * same tree over an AxForm's <Design>, and a second copy of a tag scanner that
 * has to get CDATA, comments and quoted attributes right is the kind of
 * duplication that drifts silently — one copy learns about `<SourceCode>` CDATA
 * and the other does not, and the second one corrupts a file under a ✅.
 */

export interface XmlNode {
  name: string;
  /** Offset of '<' of the open tag. */
  start: number;
  /** Offset just past '>' of the open tag. */
  openEnd: number;
  /** Offset of '<' of the close tag (=== start when self-closing). */
  closeStart: number;
  /** Offset just past '>' of the close tag. */
  end: number;
  selfClosing: boolean;
  children: XmlNode[];
}

/** Find the '>' that ends the tag opening at `from`, ignoring '>' inside attribute values. */
export function findTagEnd(xml: string, from: number): number {
  let quote: string | null = null;
  for (let i = from + 1; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

/**
 * Build an offset-carrying element tree. Returns null when the document is
 * unbalanced or otherwise not something we should be splicing into — the caller
 * then declines rather than guessing.
 */
export function parseNodes(xml: string): XmlNode | null {
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let i = 0;

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;

    // Prologue / comments / CDATA / doctype carry no structure we care about,
    // but they DO carry '<' and '>' that would otherwise be read as tags.
    // (AxForm and AxFormExtension hold <SourceCode> methods wrapped in CDATA.)
    if (xml.startsWith('<?', lt)) { const e = xml.indexOf('?>', lt); if (e < 0) return null; i = e + 2; continue; }
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt); if (e < 0) return null; i = e + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) { const e = xml.indexOf(']]>', lt); if (e < 0) return null; i = e + 3; continue; }
    if (xml.startsWith('<!', lt)) { const e = xml.indexOf('>', lt); if (e < 0) return null; i = e + 1; continue; }

    const gt = findTagEnd(xml, lt);
    if (gt < 0) return null;
    const raw = xml.slice(lt, gt + 1);

    if (raw.startsWith('</')) {
      const name = raw.slice(2, -1).trim();
      const top = stack.pop();
      if (!top || top.name !== name) return null; // mismatched close → decline
      top.closeStart = lt;
      top.end = gt + 1;
      i = gt + 1;
      continue;
    }

    const nameMatch = /^<([^\s/>]+)/.exec(raw);
    if (!nameMatch) return null;
    const selfClosing = raw.endsWith('/>');
    const node: XmlNode = {
      name: nameMatch[1],
      start: lt,
      openEnd: gt + 1,
      closeStart: selfClosing ? lt : -1,
      end: selfClosing ? gt + 1 : -1,
      selfClosing,
      children: [],
    };
    if (stack.length > 0) stack[stack.length - 1].children.push(node);
    else if (!root) root = node;
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }

  if (stack.length > 0) return null; // unclosed element → decline
  return root;
}

export const firstChild = (n: XmlNode, name: string): XmlNode | undefined =>
  n.children.find(c => c.name === name);

export const textOf = (xml: string, n: XmlNode): string =>
  n.selfClosing ? '' : xml.slice(n.openEnd, n.closeStart).trim();

/**
 * Element text as the caller spelled it, undoing the escaping the emitters apply
 * (see escapeXmlText). Without this the round trip breaks: a name written as
 * `A &amp; B` would never match the `A & B` the caller passes back, so an
 * idempotency check would miss it and a removal would report "not found".
 *
 * `&amp;` last, mirroring the escape order.
 */
export const decodeXmlText = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Element text, decoded — the form to compare against caller input or display. */
export const textValueOf = (xml: string, n: XmlNode): string => decodeXmlText(textOf(xml, n));

/** True when `n` is `container` itself or lives inside its subtree. */
export const isWithin = (n: XmlNode, container: XmlNode): boolean =>
  n.start >= container.start && n.end <= container.end;

/** Leading whitespace of the line `offset` sits on, for matching the file's indentation. */
export function lineIndentOf(xml: string, offset: number): string {
  const lineStart = xml.lastIndexOf('\n', offset - 1) + 1;
  const seg = xml.slice(lineStart, offset);
  return /^[ \t]*$/.test(seg) ? seg : '\t';
}
