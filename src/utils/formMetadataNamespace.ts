/**
 * Put caller-written AxForm / AxFormExtension XML into the namespace layout every
 * shipped file has, before it is written.
 *
 * Census of K:\AosService\PackagesLocalDirectory (2026-10-10): of all the AOT root
 * types, only AxForm (9,442 of 9,442 files) and AxFormExtension (1,088 of 1,088)
 * declare xmlns="Microsoft.Dynamics.AX.Metadata.V6" — no other root does, anywhere.
 * Inside those files the rule holds for all 5.6 million elements without one
 * exception: the root and its children are in V6, everything from the grandchildren
 * down is in no namespace (each grandchild carries its own xmlns="").
 *
 * Why it matters: a form extension written without the namespace BUILDS — xppc
 * accepts it — but xppbp reports "Error reading FormExtension … not found", so the
 * object is broken in a way the build never shows. That is what a benchmark agent
 * handed d365fo_file(action="create", form-extension, xmlContent=…) and got ✅ for.
 */

export const FORM_METADATA_NAMESPACE = 'Microsoft.Dynamics.AX.Metadata.V6';

/** The root elements the layout applies to — the only two that carry the namespace. */
const NAMESPACED_ROOTS = new Set(['AxForm', 'AxFormExtension']);

export interface FormNamespaceResult {
  xml: string;
  /** True when anything was added or corrected. */
  changed: boolean;
}

const DEFAULT_NS_ATTR = /\sxmlns\s*=\s*(["'])(.*?)\1/;

/**
 * Rewrite the start tags whose namespace breaks the rule; leave everything else —
 * text, CDATA, comments, attribute order, whitespace — byte for byte. XML whose
 * root is not AxForm / AxFormExtension is returned unchanged.
 */
export function ensureFormMetadataNamespace(xml: string): FormNamespaceResult {
  if (!xml) return { xml, changed: false };
  let out = '';
  let depth = 0;
  let changed = false;
  let applies: boolean | null = null; // decided at the root
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { out += xml.slice(i); break; }
    out += xml.slice(i, lt);

    // Constructs that are not elements: copied through untouched.
    const skipTo = (terminator: string) => {
      const end = xml.indexOf(terminator, lt);
      const stop = end < 0 ? xml.length : end + terminator.length;
      out += xml.slice(lt, stop);
      i = stop;
    };
    if (xml.startsWith('<!--', lt)) { skipTo('-->'); continue; }
    if (xml.startsWith('<![CDATA[', lt)) { skipTo(']]>'); continue; }
    if (xml.startsWith('<?', lt)) { skipTo('?>'); continue; }
    if (xml.startsWith('<!', lt)) { skipTo('>'); continue; }

    const end = tagEnd(xml, lt);
    const tag = xml.slice(lt, end);
    i = end;

    if (tag.startsWith('</')) {
      depth--;
      out += tag;
      continue;
    }

    const selfClosing = tag.endsWith('/>');
    const name = /^<([\w:.-]+)/.exec(tag)?.[1] ?? '';
    if (applies === null) applies = NAMESPACED_ROOTS.has(name);

    let next = tag;
    if (applies) {
      const want = depth <= 1 ? (depth === 0 ? FORM_METADATA_NAMESPACE : null) : depth === 2 ? '' : undefined;
      const own = DEFAULT_NS_ATTR.exec(tag);
      if (want === FORM_METADATA_NAMESPACE) {
        // Root: must declare V6.
        if (!own) next = insertAttr(tag, name, `xmlns="${FORM_METADATA_NAMESPACE}"`);
        else if (own[2] !== FORM_METADATA_NAMESPACE) next = tag.replace(DEFAULT_NS_ATTR, ` xmlns="${FORM_METADATA_NAMESPACE}"`);
      } else if (want === null) {
        // Children of the root inherit V6 — a declaration of anything else moves them out.
        if (own && own[2] !== FORM_METADATA_NAMESPACE) next = tag.replace(DEFAULT_NS_ATTR, '');
      } else if (want === '') {
        // Grandchildren leave V6: each carries its own xmlns="".
        if (!own) next = insertAttr(tag, name, 'xmlns=""');
        else if (own[2] !== '') next = tag.replace(DEFAULT_NS_ATTR, ' xmlns=""');
      }
      // Deeper elements inherit "" from their depth-2 ancestor: untouched.
    }
    if (next !== tag) changed = true;
    out += next;
    if (!selfClosing) depth++;
  }
  return { xml: changed ? out : xml, changed };
}

/** Index just past the `>` that closes the tag starting at `lt` — quoted `>` skipped. */
function tagEnd(xml: string, lt: number): number {
  let quote: string | null = null;
  for (let k = lt + 1; k < xml.length; k++) {
    const c = xml[k];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return k + 1;
  }
  return xml.length;
}

/** Appended as the last attribute — where shipped files have it (after xmlns:i). */
function insertAttr(tag: string, _name: string, attr: string): string {
  const close = tag.endsWith('/>') ? tag.length - 2 : tag.length - 1;
  const head = tag.slice(0, close).replace(/\s+$/, '');
  return `${head} ${attr}${tag.endsWith('/>') && /\s\/>$/.test(tag) ? ' ' : ''}${tag.slice(close)}`;
}
