/**
 * Set a property ON a control the document itself defines.
 *
 * `modify-property` reached three of the four places a form control can live:
 * the form's own Design properties, and — through <ControlModifications>, see
 * formExtensionControlModifications.ts — a BASE-form control from an extension.
 * It could not reach a control of the agent's OWN form, nor a control an
 * extension ADDS: for those it only had the form-level writer, which edits
 * <Design> and nothing below it. So setting MenuItemName / MultiSelect /
 * NeedsRecord on a button meant rewriting the whole form XML by hand.
 *
 * The control is found by its <Name>, wherever it is nested:
 *
 *   <AxForm> … <AxFormControl i:type="AxFormMenuFunctionButtonControl">
 *                <Name>PostButton</Name> …
 *   <AxFormExtension> … <AxFormExtensionControl> <FormControl i:type="…">
 *                <Name>PostButton</Name> …
 *
 * and the property is written as a direct child of that control, in the order
 * shipped metadata uses for its i:type. That order is not decided here: it is
 * the census in formControlElementOrder.generated.ts, mined from 309,668 shipped
 * controls. It matters because the metadata deserializer DROPS an element it
 * meets out of sequence, without a word (#979) — a property appended at the end
 * would be written, reported, and ignored. The same census also refuses a
 * property the type never carries (MenuItemName on a plain AxFormButtonControl):
 * that is a different control type, not a missing property.
 *
 * Pure and side-effect-free: the file I/O stays in the caller. Offsets come from
 * the offset-preserving tree, so every byte outside the touched element is kept.
 */

import { type XmlNode, parseNodes, firstChild, textValueOf, lineIndentOf } from './xmlNodeTree.js';
import { detectEol } from './eolUtils.js';
import { FORM_CONTROL_ELEMENT_ORDER } from '../validation/formControlElementOrder.generated.js';

export type FormControlPropertyOutcome =
  | {
      ok: true;
      xml: string;
      /** False when the file already carried exactly this value — nothing to write. */
      changed: boolean;
      /** Human-readable account of what happened, for the tool reply. */
      detail: string;
    }
  | { ok: false; reason: string };

/** An AOT element/property name. Anything else is a caller mistake, not a value to escape. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The elements that hold a form control: <AxFormControl> in a form, <FormControl> in an extension. */
const CONTROL_ELEMENTS = new Set(['AxFormControl', 'FormControl']);

/**
 * Children that are structure, not properties: renaming the control or replacing
 * its child collection through a text value would break the form, and a <Type>
 * that disagrees with i:type describes a control the file does not contain — so
 * these stay with the operations built for them (rename, add-control /
 * remove-control; a different type is a different control).
 */
const STRUCTURAL = new Set(['name', 'type', 'controls', 'formcontrolextension']);

const ITYPE = /\bi:type\s*=\s*"([^"]+)"/;

const escapeXmlText = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function controlsNamed(xml: string, node: XmlNode, wanted: string, out: XmlNode[]): void {
  for (const child of node.children) {
    if (CONTROL_ELEMENTS.has(child.name)) {
      const nameNode = firstChild(child, 'Name');
      if (nameNode && textValueOf(xml, nameNode).toLowerCase() === wanted) out.push(child);
    }
    controlsNamed(xml, child, wanted, out);
  }
}

/** Remove [start, end) together with the line it sat on, when it sat alone on it. */
function removeElementLine(xml: string, node: XmlNode): string {
  let from = node.start;
  while (from > 0 && (xml[from - 1] === '\t' || xml[from - 1] === ' ')) from--;
  if (from > 0 && xml[from - 1] === '\n') {
    from--;
    if (from > 0 && xml[from - 1] === '\r') from--;
  } else {
    from = node.start;
  }
  return xml.slice(0, from) + xml.slice(node.end);
}

/** Every block is built with '\n'; re-emit the document in the line ending it came with. */
function applyEol(text: string, eol: '\r\n' | '\n'): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

/**
 * Set `propertyName` = `propertyValue` on the control named `controlName` in an
 * AxForm, or on a control an AxFormExtension adds. An empty value removes the
 * element — absence is the default, and shipped metadata never writes it empty.
 *
 * Returns `null` when the document defines no control of that name, so the
 * caller can fall back (a form extension then means a BASE-form control, which
 * goes to <ControlModifications>). Returns `{ ok: false }` — never a partial
 * write — when the name is ambiguous, the control type or property is not in the
 * census, or the existing element is not a plain value.
 */
export function upsertFormControlProperty(
  xml: string,
  controlName: string,
  propertyName: string,
  propertyValue: string,
): FormControlPropertyOutcome | null {
  if (!IDENTIFIER.test(controlName)) {
    return { ok: false, reason: `"${controlName}" is not a plain control name.` };
  }
  if (!IDENTIFIER.test(propertyName)) {
    return { ok: false, reason: `"${propertyName}" is not a plain property name.` };
  }

  const root = parseNodes(xml);
  if (!root) return { ok: false, reason: 'the file is not balanced XML — refusing to splice into it.' };
  if (root.name !== 'AxForm' && root.name !== 'AxFormExtension') {
    return { ok: false, reason: `the root element is <${root.name}>, not <AxForm> or <AxFormExtension>.` };
  }

  const found: XmlNode[] = [];
  controlsNamed(xml, root, controlName.toLowerCase(), found);
  if (found.length === 0) return null;
  if (found.length > 1) {
    return { ok: false, reason: `${found.length} controls are named "${controlName}" — refusing to guess which one.` };
  }
  const control = found[0];

  const itype = ITYPE.exec(xml.slice(control.start, control.openEnd))?.[1];
  const canonical = itype ? FORM_CONTROL_ELEMENT_ORDER[itype] : undefined;
  if (!itype || !canonical) {
    return {
      ok: false,
      reason: `control "${controlName}" has ${itype ? `type ${itype}, which` : 'no i:type, so it'} is not in the ` +
        `element-order census — there is no evidence where its properties belong, so nothing was written.`,
    };
  }

  // The census spelling wins: a property written in the wrong case is a different element.
  const property = canonical.find(p => p.toLowerCase() === propertyName.toLowerCase());
  if (!property) {
    return {
      ok: false,
      reason: `${itype} has no property "${propertyName}" in shipped metadata (309,668 controls) — ` +
        `the platform would ignore it. If the control needs it, it is probably the wrong control type.`,
    };
  }
  if (STRUCTURAL.has(property.toLowerCase())) {
    return {
      ok: false,
      reason: `<${property}> is part of the control's structure, not a property value — use the operation ` +
        `built for it (rename, add-control / remove-control).`,
    };
  }

  const name = textValueOf(xml, firstChild(control, 'Name')!);
  const existing = control.children.find(c => c.name === property);
  const value = String(propertyValue);
  const eol = detectEol(xml);

  if (existing) {
    if (existing.children.length > 0) {
      return { ok: false, reason: `<${property}> on "${name}" holds child elements, not a value — nothing was written.` };
    }
    if (value === '') {
      return {
        ok: true,
        xml: applyEol(removeElementLine(xml, existing), eol),
        changed: true,
        detail: `removed ${name}.${property} (back to its default)`,
      };
    }
    const current = existing.selfClosing ? '' : textValueOf(xml, existing);
    if (current === value) {
      return { ok: true, xml, changed: false, detail: `${name}.${property} is already '${value}'` };
    }
    const replaced = `<${property}>${escapeXmlText(value)}</${property}>`;
    return {
      ok: true,
      xml: applyEol(xml.slice(0, existing.start) + replaced + xml.slice(existing.end), eol),
      changed: true,
      detail: `set ${name}.${property}='${value}' (was '${current}')`,
    };
  }

  if (value === '') {
    return { ok: true, xml, changed: false, detail: `${name}.${property} is not set — already its default` };
  }

  // Insert after the last child the census ranks BEFORE this property. <Name> is
  // first in every type's order, so there always is one.
  const rank = canonical.indexOf(property);
  let anchor: XmlNode | undefined;
  for (const child of control.children) {
    const r = canonical.indexOf(child.name);
    if (r !== -1 && r < rank) anchor = child;
  }
  if (!anchor) {
    return { ok: false, reason: `control "${name}" has no <Name> child to place <${property}> after — nothing was written.` };
  }
  const indent = lineIndentOf(xml, anchor.start);
  const block = `\n${indent}<${property}>${escapeXmlText(value)}</${property}>`;
  return {
    ok: true,
    xml: applyEol(xml.slice(0, anchor.end) + block + xml.slice(anchor.end), eol),
    changed: true,
    detail: `set ${name}.${property}='${value}' (added after <${anchor.name}>, in the order shipped ${itype} controls use)`,
  };
}
