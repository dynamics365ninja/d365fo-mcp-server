/**
 * AxForm <Design> property upsert.
 *
 * The C# bridge rejects modify-property for forms outright ("modify-property not
 * supported for objectType form via bridge"), so the Design annotations
 * object_patterns(action="spec") prescribes — Pattern / PatternVersion / Style —
 * could not be set through any grounded path (findings #37, corpus
 * 2026-07-22T04__L2-form-over-view). The generic directXmlModifyProperty cannot
 * serve them either: Caption/Style also occur on controls, so it sees several
 * matches and refuses to guess.
 *
 * Ground truth for shape and order: eval/goldens/L1-form-listpage (VM-captured,
 * built clean) — Design's direct-child properties carry `xmlns=""`, are
 * alphabetical, and <Controls> terminates the block.
 */

/** Direct-child properties of <Design> the serialiser writes. */
const AX_FORM_DESIGN_PROPERTIES = new Set([
  'Caption',
  'ColumnsMode',
  'DataSource',
  'Pattern',
  'PatternVersion',
  'ShowDeleteButton',
  'ShowNewButton',
  'Style',
  'TitleDataSource',
  'ViewEditMode',
  'WindowResize',
  'WindowType',
]);

/**
 * Set a form Design property, inserting it in alphabetical order when absent; an
 * empty value removes it. Returns the updated XML, or null when the document is not
 * an AxForm, has no <Design>, or the property is not a Design property (so the caller
 * can surface the original error rather than write something invented).
 *
 * The edit runs on LF lines and a CRLF document comes back CRLF. Shipped and saved
 * forms are CRLF, and a match ending in `\n` never found the existing element there:
 * the property was added a second time and the deserializer kept the old one.
 */
export function upsertAxFormDesignProperty(
  xml: string,
  property: string,
  value: string,
): string | null {
  if (!xml.includes('\r\n')) return upsertLf(xml, property, value);
  const r = upsertLf(xml.replace(/\r\n/g, '\n'), property, value);
  return r === null ? null : r.replace(/\n/g, '\r\n');
}

function upsertLf(xml: string, property: string, value: string): string | null {
  if (!/<AxForm[\s>]/.test(xml)) return null;
  if (!AX_FORM_DESIGN_PROPERTIES.has(property)) return null;

  const designStart = xml.search(/^[ \t]*<Design>/m);
  if (designStart === -1) return null;
  const designOpen = xml.indexOf('>', designStart) + 1;

  // Everything before <Controls> (or </Design> on a control-less form) is the
  // direct-child property region — nested controls carry their own Caption/Style,
  // and must never be touched.
  const controlsRel = xml.slice(designOpen).search(/^[ \t]*<Controls[ />]/m);
  const endRel = controlsRel !== -1 ? controlsRel : xml.slice(designOpen).search(/^[ \t]*<\/Design>/m);
  if (endRel === -1) return null;
  const propsEnd = designOpen + endRel;

  const head = xml.slice(0, designOpen);
  const region = xml.slice(designOpen, propsEnd);
  const tail = xml.slice(propsEnd);

  const designIndent = /^([ \t]*)<Design>/m.exec(xml.slice(designStart))?.[1] ?? '\t';
  const indent = `${designIndent}\t`;
  const element = `${indent}<${property} xmlns="">${value}</${property}>\n`;

  const existing = new RegExp(
    `^[ \\t]*<${property}\\b[^>]*?/>[ \\t]*\\n|^[ \\t]*<${property}\\b[^>]*>[\\s\\S]*?</${property}>[ \\t]*\\n`,
    'm',
  );
  if (existing.test(region)) {
    return head + region.replace(existing, value === '' ? '' : element) + tail;
  }
  if (value === '') return xml;

  // Insert before the first existing property that sorts after this one.
  const propLine = /^[ \t]*<([A-Za-z_][\w.-]*)\b/gm;
  let insertAt: number | null = null;
  for (let m = propLine.exec(region); m; m = propLine.exec(region)) {
    if (AX_FORM_DESIGN_PROPERTIES.has(m[1]) && m[1].localeCompare(property) > 0) {
      insertAt = m.index;
      break;
    }
  }
  const patched = insertAt === null
    ? region.replace(/\s*$/, '\n') + element
    : region.slice(0, insertAt) + element + region.slice(insertAt);

  return head + patched + tail;
}
