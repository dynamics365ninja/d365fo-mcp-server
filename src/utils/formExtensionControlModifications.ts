/**
 * Property modifications a form extension applies to a control of its BASE form.
 *
 * This is the other half of "customise a base form from an extension". Adding a
 * NEW control is formExtensionControlXml.ts; CHANGING a property of a control the
 * base form already defines is here, and it is a different collection entirely:
 *
 *   <AxFormExtension>
 *     <Name>MyForm.Extension</Name>
 *     <ConfigurationKey>…</ConfigurationKey>
 *     <ControlModifications>                      ← this one
 *       <AxExtensionModification xmlns="">
 *         <Name>ButtonGroup</Name>                ← the BASE form's control
 *         <PropertyModifications>
 *           <AxPropertyModification>
 *             <Name>Visible</Name>
 *             <Value>No</Value>
 *           </AxPropertyModification>
 *         </PropertyModifications>
 *       </AxExtensionModification>
 *     </ControlModifications>
 *     <Controls> … </Controls>                    ← new controls (the other module)
 *   </AxFormExtension>
 *
 * Why it exists: `modify-property` on a form extension used to hand every request
 * to the generic property writer, which appends to the extension's own ROOT
 * <PropertyModifications>. So "hide control X" wrote a FORM-level Visible=No —
 * it hid the whole form — and reported success. A request naming a dotted path
 * (`HeaderNoteId.Visible`) fared worse: the root writer took the last segment or
 * wrote the dotted string verbatim as a property name that is not a member of
 * AxFormExtension at all, again under a ✅. Found by eval case
 * L2-form-control-removal-lifecycle, whose refusal message recommends exactly
 * this remedy — the tool advised something it could not do.
 *
 * Every shape decision below is measured against the shipped AOT
 * (ApplicationSuite + ApplicationFoundation + ApplicationPlatform, 416
 * AxFormExtension files, 83 of them carrying a non-empty <ControlModifications>
 * with 1102 property modifications between them):
 *
 *  - **Placement.** <ControlModifications> is immediately followed by <Controls>
 *    in 83 of 83 files, and by nothing else, ever. That is the anchor. Without a
 *    <Controls> sibling there is no evidence to place it from, so this declines
 *    rather than guessing — the same rule createControlsCollection follows.
 *  - **One envelope per control.** Zero of the 83 files repeat an
 *    <AxExtensionModification> <Name>, so a second property on the same control
 *    joins the existing envelope's <PropertyModifications> instead of opening a
 *    second envelope.
 *  - **Not just Visible.** The 1102 modifications name Visible (1093), Enabled
 *    (3), CountryRegionCodes (2), Caption (2), HelpText (1) and Label (1), so the
 *    property name stays a parameter.
 *  - **`xmlns=""`** sits on <AxExtensionModification> in every shipped file.
 *
 * Pure and side-effect-free: the file I/O stays in the caller. Indentation is
 * derived from the collection actually found rather than hard-coded — a fixed tab
 * depth is the tell that a writer assumed one nesting level.
 */

import {
  type XmlNode, parseNodes, firstChild, textValueOf, lineIndentOf,
} from './xmlNodeTree.js';
import { detectEol } from './eolUtils.js';

export type ControlModificationOutcome =
  | {
      ok: true;
      xml: string;
      /** False when the file already carried exactly this value — nothing was written. */
      changed: boolean;
      /** Human-readable account of what happened, for the tool reply. */
      detail: string;
    }
  | { ok: false; reason: string };

/** An AOT element/property name. Anything else is a caller mistake, not a value to escape. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const escapeXmlText = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Direct <AxExtensionModification> child whose own <Name> is `controlName`. */
function findControlEnvelope(
  xml: string,
  controlModifications: XmlNode,
  controlName: string,
): XmlNode | undefined {
  const wanted = controlName.toLowerCase();
  return controlModifications.children.find(c => {
    if (c.name !== 'AxExtensionModification') return false;
    const nameNode = firstChild(c, 'Name');
    return !!nameNode && textValueOf(xml, nameNode).toLowerCase() === wanted;
  });
}

/** Direct <AxPropertyModification> child whose own <Name> is `propertyName`. */
function findPropertyModification(
  xml: string,
  propertyModifications: XmlNode,
  propertyName: string,
): XmlNode | undefined {
  const wanted = propertyName.toLowerCase();
  return propertyModifications.children.find(c => {
    if (c.name !== 'AxPropertyModification') return false;
    const nameNode = firstChild(c, 'Name');
    return !!nameNode && textValueOf(xml, nameNode).toLowerCase() === wanted;
  });
}

/** Replace the byte range [start, end) of `xml` with `text`. */
const splice = (xml: string, start: number, end: number, text: string): string =>
  xml.slice(0, start) + text + xml.slice(end);

/**
 * Append `block` as the last child of `parent`.
 *
 * The insertion point is NOT `parent.closeStart`: the whitespace run before a
 * closing tag is that tag's own indent, and leaving it in place puts it in front
 * of the new block, which then adds its own indent on top. (Rendered output:
 * `\t\t\t\t\t\t\t<AxPropertyModification>` under a `\t\t\t\t` collection.) So the
 * run is consumed and re-emitted around the block instead. Indents come from the
 * parent's own line, never from a constant.
 */
function appendChild(xml: string, parent: XmlNode, block: string): string {
  let from = parent.closeStart;
  while (from > parent.openEnd && /\s/.test(xml[from - 1])) from--;
  const parentIndent = lineIndentOf(xml, parent.start);
  return splice(xml, from, parent.closeStart, `\n${block}\n${parentIndent}`);
}

function propertyModificationBlock(indent: string, name: string, value: string): string {
  return (
    `${indent}<AxPropertyModification>\n` +
    `${indent}\t<Name>${name}</Name>\n` +
    `${indent}\t<Value>${escapeXmlText(value)}</Value>\n` +
    `${indent}</AxPropertyModification>`
  );
}

function envelopeBlock(indent: string, controlName: string, name: string, value: string): string {
  return (
    `${indent}<AxExtensionModification xmlns="">\n` +
    `${indent}\t<Name>${controlName}</Name>\n` +
    `${indent}\t<PropertyModifications>\n` +
    propertyModificationBlock(`${indent}\t\t`, name, value) + '\n' +
    `${indent}\t</PropertyModifications>\n` +
    `${indent}</AxExtensionModification>`
  );
}

/**
 * Re-emit a whole document in one line ending.
 *
 * Every block this module splices in is built with '\n', but AOT metadata on disk
 * is CRLF (with a BOM). Inserting into a real file therefore left it MIXED — CRLF
 * on every pre-existing line, LF on the new ones. xppc does not care, which is
 * why the eval run that exercised this writer still built clean; Visual Studio,
 * VCS diffs and any byte-comparison against a golden do care. Detected from the
 * input rather than assumed, via the same helper the label writers already use.
 */
function applyEol(text: string, eol: '\r\n' | '\n'): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

/**
 * Set `propertyName` = `propertyValue` on the BASE-form control `controlName`,
 * creating <ControlModifications>, the control's envelope and the property entry
 * as needed. Idempotent: re-issuing the same call reports `changed: false`.
 *
 * Returns `{ ok: false }` — never a partial write — when the document is not a
 * parseable AxFormExtension, or when <ControlModifications> is absent AND there
 * is no <Controls> sibling to anchor it against.
 */
export function upsertFormExtensionControlProperty(
  xml: string,
  controlName: string,
  propertyName: string,
  propertyValue: string,
): ControlModificationOutcome {
  const out = upsertControlProperty(xml, controlName, propertyName, propertyValue);
  return out.ok ? { ...out, xml: applyEol(out.xml, detectEol(xml)) } : out;
}

function upsertControlProperty(
  xml: string,
  controlName: string,
  propertyName: string,
  propertyValue: string,
): ControlModificationOutcome {
  if (!IDENTIFIER.test(controlName)) {
    return { ok: false, reason: `"${controlName}" is not a plain control name.` };
  }
  if (!IDENTIFIER.test(propertyName)) {
    return { ok: false, reason: `"${propertyName}" is not a plain property name.` };
  }

  const root = parseNodes(xml);
  if (!root) return { ok: false, reason: 'the file is not balanced XML — refusing to splice into it.' };
  if (root.name !== 'AxFormExtension') {
    return { ok: false, reason: `the root element is <${root.name}>, not <AxFormExtension>.` };
  }

  const controlModifications = firstChild(root, 'ControlModifications');

  // ── The collection does not exist yet ────────────────────────────────────
  if (!controlModifications || controlModifications.selfClosing) {
    const controls = firstChild(root, 'Controls');
    const anchor = controlModifications ?? controls;
    if (!anchor) {
      return {
        ok: false,
        reason:
          'the extension has neither a <ControlModifications> nor a <Controls> element, so there is ' +
          'no measured position to insert the collection at (shipped extensions place it immediately ' +
          'before <Controls>, 83 of 83). Nothing was written.',
      };
    }
    const indent = lineIndentOf(xml, anchor.start);
    const block =
      `${indent}<ControlModifications>\n` +
      envelopeBlock(`${indent}\t`, controlName, propertyName, propertyValue) + '\n' +
      `${indent}</ControlModifications>`;

    // Replace a self-closing <ControlModifications />; otherwise insert ahead of <Controls>.
    const updated = controlModifications
      ? splice(xml, controlModifications.start, controlModifications.end, block.trimStart())
      : splice(xml, anchor.start, anchor.start, `${block.trimStart()}\n${indent}`);

    return {
      ok: true,
      xml: updated,
      changed: true,
      detail:
        `created <ControlModifications> and set ${controlName}.${propertyName}='${propertyValue}'`,
    };
  }

  // ── The collection exists ────────────────────────────────────────────────
  const envelope = findControlEnvelope(xml, controlModifications, controlName);

  if (!envelope) {
    const inner = controlModifications.children[0];
    const indent = inner
      ? lineIndentOf(xml, inner.start)
      : lineIndentOf(xml, controlModifications.start) + '\t';
    const block = envelopeBlock(indent, controlName, propertyName, propertyValue);
    const updated = appendChild(xml, controlModifications, block);
    return {
      ok: true,
      xml: updated,
      changed: true,
      detail: `added a modification envelope for '${controlName}' and set ${propertyName}='${propertyValue}'`,
    };
  }

  const propertyModifications = firstChild(envelope, 'PropertyModifications');
  if (!propertyModifications) {
    return {
      ok: false,
      reason:
        `the existing modification envelope for '${controlName}' has no <PropertyModifications> ` +
        'element. Nothing was written.',
    };
  }

  const existing = propertyModifications.selfClosing
    ? undefined
    : findPropertyModification(xml, propertyModifications, propertyName);

  // ── The property is already modified: update its <Value> in place ────────
  if (existing) {
    const valueNode = firstChild(existing, 'Value');
    if (!valueNode) {
      return {
        ok: false,
        reason:
          `the existing modification of ${controlName}.${propertyName} has no <Value> element. ` +
          'Nothing was written.',
      };
    }
    const current = textValueOf(xml, valueNode);
    if (current === propertyValue) {
      return {
        ok: true,
        xml,
        changed: false,
        detail: `${controlName}.${propertyName} is already '${propertyValue}'`,
      };
    }
    const updated = valueNode.selfClosing
      ? splice(xml, valueNode.start, valueNode.end, `<Value>${escapeXmlText(propertyValue)}</Value>`)
      : splice(xml, valueNode.openEnd, valueNode.closeStart, escapeXmlText(propertyValue));
    return {
      ok: true,
      xml: updated,
      changed: true,
      detail: `changed ${controlName}.${propertyName} from '${current}' to '${propertyValue}'`,
    };
  }

  // ── A new property on an existing envelope ───────────────────────────────
  if (propertyModifications.selfClosing) {
    const indent = lineIndentOf(xml, propertyModifications.start);
    const block =
      `<PropertyModifications>\n` +
      propertyModificationBlock(`${indent}\t`, propertyName, propertyValue) + '\n' +
      `${indent}</PropertyModifications>`;
    return {
      ok: true,
      xml: splice(xml, propertyModifications.start, propertyModifications.end, block),
      changed: true,
      detail: `set ${controlName}.${propertyName}='${propertyValue}'`,
    };
  }

  const sibling = propertyModifications.children[0];
  const indent = sibling
    ? lineIndentOf(xml, sibling.start)
    : lineIndentOf(xml, propertyModifications.start) + '\t';
  const block = propertyModificationBlock(indent, propertyName, propertyValue);
  const updated = appendChild(xml, propertyModifications, block);
  return {
    ok: true,
    xml: updated,
    changed: true,
    detail: `set ${controlName}.${propertyName}='${propertyValue}'`,
  };
}

/**
 * Split a `modify-property` request into control + property when the caller
 * targeted a base-form control.
 *
 * Two spellings reach the tool, and BOTH used to be mis-served: an explicit
 * `controlName` was silently dropped (the operation never read it), and a dotted
 * `propertyPath` was truncated to its last segment or written verbatim as a
 * property name. Returns null when the request is for the extension's own
 * property, which still belongs to the generic writer.
 */
export function resolveControlPropertyTarget(
  propertyPath: string,
  controlName?: string,
): { controlName: string; propertyName: string } | null {
  if (controlName) {
    // A dotted path alongside an explicit control name: the last segment is the property.
    const propertyName = propertyPath.split('.').pop() ?? propertyPath;
    return { controlName, propertyName };
  }
  const parts = propertyPath.split('.');
  if (parts.length !== 2) return null;
  const [control, property] = parts;
  if (!IDENTIFIER.test(control) || !IDENTIFIER.test(property)) return null;
  return { controlName: control, propertyName: property };
}
