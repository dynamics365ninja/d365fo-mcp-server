/**
 * Structural edits of an AxForm's control tree: move a control under another parent,
 * and wrap existing controls in a new Group, Tab or TabPage.
 *
 * Converting a form to a standard pattern is mostly this: the fields that sat in the
 * design go into a FieldsFieldGroups group, the groups become FastTab pages of a Tab, a
 * grid moves under a TabPage. Without these edits the only route was rewriting the
 * whole form through create + overwrite, which risks every control, datasource and
 * method of the form for a change of nesting.
 *
 * Built on the offset-preserving tree (xmlNodeTree): a moved control is cut and spliced
 * back byte for byte, only re-indented to its new depth, so its own element order —
 * which the metadata deserializer enforces by silently DROPPING a member it meets out
 * of sequence — cannot change. A new container is written in the order the shipped
 * census gives for its type (formControlElementOrder.generated.ts): Name, Pattern,
 * PatternVersion, Type, FormControlExtension, Controls, then Caption and Style. A
 * property its type never carries (Caption on a Tab) is refused, not written.
 *
 * Plain AxForm only: in a form extension a base control's parent belongs to the base
 * form. Pure: string in, string out; the file I/O stays in the caller.
 */

import { type XmlNode, parseNodes, firstChild, textValueOf, lineIndentOf, isWithin } from '../../utils/xmlNodeTree.js';
import { FORM_CONTROL_ELEMENT_ORDER } from '../../validation/formControlElementOrder.generated.js';
import { resolvePatternExact, resolveSubPattern } from '../../knowledge/formPatterns/index.js';
import { detectIndentUnit } from './tableFieldPropertyEdit.js';

export type RestructureResult =
  | { ok: true; xml: string; changed: boolean; detail: string; warnings: string[] }
  | { ok: false; message: string };

export interface MoveControlSpec {
  controlName: string;
  /** Target parent: a container control, or the design ("Design", "FormDesign", ""). */
  parentControl?: string;
  previousSibling?: string;
  /** "AfterItem" (with previousSibling), "Begin" or "End" (default). */
  positionType?: string;
}

export type ContainerType = 'Group' | 'Tab' | 'TabPage';

export interface WrapControlsSpec {
  controlNames: string[];
  containerName: string;
  containerType?: string;
  pattern?: string;
  patternVersion?: string;
  caption?: string;
  style?: string;
}

interface Ctl {
  name: string;
  node: XmlNode;
  /** The <Controls> this control is a direct child of. */
  collection: XmlNode;
  /** The control that owns `collection`, undefined for the design. */
  owner?: XmlNode;
}

const DESIGN = 'Design';
const fail = (message: string): RestructureResult => ({ ok: false, message });
const escapeText = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ITYPE = /\bi:type\s*=\s*"([^"]+)"/;

/** Same sentinels as add-control (FormAuthoringDefaults.IsDesignRootSentinel). */
function isDesignRoot(name: string | undefined, formName: string): boolean {
  const n = (name ?? '').trim().toLowerCase();
  const f = formName.trim().toLowerCase();
  return n === '' || n === 'design' || n === 'formdesign' || n === 'root' || (!!f && (n === f || n === `${f}design`));
}

interface Doc {
  xml: string;
  root: XmlNode;
  design: XmlNode;
  formName: string;
  controls: Ctl[];
  unit: string;
}

function readDoc(xml: string): Doc | string {
  const root = parseNodes(xml);
  if (!root) return 'the form XML could not be parsed; nothing was changed';
  if (root.name === 'AxFormExtension') {
    return 'this is a form extension: a base control\'s parent belongs to the base form. ' +
      'Move or wrap controls in the form itself (objectType="form"); in an extension, add-control places the controls it adds';
  }
  if (root.name !== 'AxForm') return 'not an AxForm';
  const design = firstChild(root, 'Design');
  if (!design) return 'the form has no <Design>';
  const nameNode = firstChild(root, 'Name');
  const controls: Ctl[] = [];
  const visit = (node: XmlNode, owner: XmlNode | undefined): void => {
    const collection = firstChild(node, 'Controls');
    if (!collection) return;
    for (const child of collection.children) {
      if (child.name !== 'AxFormControl') continue;
      const n = firstChild(child, 'Name');
      if (n) controls.push({ name: textValueOf(xml, n), node: child, collection, owner });
      visit(child, child);
    }
  };
  visit(design, undefined);
  return { xml, root, design, formName: nameNode ? textValueOf(xml, nameNode) : '', controls, unit: detectIndentUnit(xml) };
}

const find = (doc: Doc, name: string) => doc.controls.find(c => c.name.toLowerCase() === name.trim().toLowerCase());
const parentNameOf = (doc: Doc, c: Ctl) => (c.owner ? doc.controls.find(o => o.node === c.owner)?.name ?? '?' : DESIGN);
const childrenOf = (doc: Doc, collection: XmlNode) => doc.controls.filter(c => c.collection === collection);

/** The element's own lines: from the start of its line through the newline that ends it. */
function lineSpan(xml: string, node: XmlNode): [number, number] {
  const lineStart = xml.lastIndexOf('\n', node.start - 1) + 1;
  const from = /^[ \t]*$/.test(xml.slice(lineStart, node.start)) ? lineStart : node.start;
  let to = node.end;
  while (to < xml.length && (xml[to] === ' ' || xml[to] === '\t')) to++;
  if (xml[to] === '\n') to++;
  return [from, to];
}

/** Shift every line of a block from one indent to another; null when a line lacks the old indent. */
function reindent(block: string, from: string, to: string): string | null {
  if (from === to) return block;
  const lines = block.split('\n');
  const last = lines.pop(); // '' after the final newline
  const out: string[] = [];
  for (const l of lines) {
    if (l.trim() === '') { out.push(l); continue; }
    if (!l.startsWith(from)) return null;
    out.push(to + l.slice(from.length));
  }
  return out.join('\n') + '\n' + (last ?? '');
}

/** Cut a set of controls' lines out of the document. Returns the new text and the blocks, in document order. */
function cutBlocks(xml: string, nodes: XmlNode[]): { xml: string; blocks: string[] } | null {
  const spans = nodes.map(n => lineSpan(xml, n)).sort((a, b) => a[0] - b[0]);
  const blocks = spans.map(([a, b]) => xml.slice(a, b));
  if (blocks.some(b => !b.endsWith('\n'))) return null;
  let out = xml;
  for (const [a, b] of [...spans].reverse()) out = out.slice(0, a) + out.slice(b);
  return { xml: out, blocks };
}

function resolveTarget(doc: Doc, parent: string | undefined): { collection: XmlNode; name: string; owner?: Ctl } | string {
  const asked = parent?.trim() ?? '';
  const byName = asked ? find(doc, asked) : undefined;
  if (byName) {
    const collection = firstChild(byName.node, 'Controls');
    if (!collection) {
      const type = ITYPE.exec(doc.xml.slice(byName.node.start, byName.node.openEnd))?.[1] ?? 'control';
      return `"${byName.name}" (${type}) is not a container: it has no <Controls>`;
    }
    return { collection, name: byName.name, owner: byName };
  }
  if (isDesignRoot(asked, doc.formName)) {
    const collection = firstChild(doc.design, 'Controls');
    if (!collection) return 'the design has no <Controls>';
    return { collection, name: DESIGN };
  }
  return `parent "${asked}" is not a control of this form`;
}

/**
 * Insert line blocks into a <Controls> collection (re-indented to its children's depth).
 * `after` = insert after that sibling; null = first; undefined = last.
 */
function insertIntoCollection(xml: string, collection: XmlNode, blocks: Array<{ text: string; indent: string }>, unit: string, after: XmlNode | null | undefined): string | null {
  const ownIndent = lineIndentOf(xml, collection.start);
  const childIndent = ownIndent + unit;
  const moved: string[] = [];
  for (const b of blocks) {
    const r = reindent(b.text, b.indent, childIndent);
    if (r === null) return null;
    moved.push(r);
  }
  const text = moved.join('');
  if (collection.selfClosing) {
    const [a, b] = lineSpan(xml, collection);
    return xml.slice(0, a) + `${ownIndent}<Controls>\n${text}${ownIndent}</Controls>\n` + xml.slice(b);
  }
  const kids = collection.children.filter(c => c.name === 'AxFormControl');
  let at: number;
  if (after) at = lineSpan(xml, after)[1];
  else if (after === null && kids.length) at = lineSpan(xml, kids[0])[0];
  else at = xml.lastIndexOf('\n', collection.closeStart - 1) + 1;
  return xml.slice(0, at) + text + xml.slice(at);
}

function position(spec: { previousSibling?: string; positionType?: string }): { kind: 'after'; sibling: string } | { kind: 'begin' } | { kind: 'end' } | string {
  const t = spec.positionType?.trim().toLowerCase() ?? '';
  const sib = spec.previousSibling?.trim();
  if (sib) {
    if (t && t !== 'afteritem') return `previousSibling goes with positionType "AfterItem" (or none), not "${spec.positionType}"`;
    return { kind: 'after', sibling: sib };
  }
  if (t === 'begin') return { kind: 'begin' };
  if (t === '' || t === 'end') return { kind: 'end' };
  if (t === 'afteritem') return 'positionType "AfterItem" needs previousSibling';
  return `positionType must be "AfterItem", "Begin" or "End", not "${spec.positionType}"`;
}

/** Re-read the result: it must parse, and every named control must be once under the expected parent. */
function verify(xml: string, expect: Array<[string, string]>): string | null {
  const doc = readDoc(xml);
  if (typeof doc === 'string') return doc;
  for (const [name, parent] of expect) {
    const hits = doc.controls.filter(c => c.name.toLowerCase() === name.toLowerCase());
    if (hits.length !== 1 || parentNameOf(doc, hits[0]).toLowerCase() !== parent.toLowerCase()) {
      return `internal check failed for "${name}"; the file was left unchanged. Please report this with the form XML`;
    }
  }
  return null;
}

const withEol = (src: string, fn: (lf: string) => RestructureResult): RestructureResult => {
  const crlf = src.includes('\r\n');
  const r = fn(crlf ? src.replace(/\r\n/g, '\n') : src);
  return r.ok && crlf && r.changed ? { ...r, xml: r.xml.replace(/\n/g, '\r\n') } : r.ok && !r.changed ? { ...r, xml: src } : r;
};

/** move-control: put an existing control under another parent (or elsewhere in its own), at a position. */
export function moveFormControl(source: string, spec: MoveControlSpec): RestructureResult {
  return withEol(source, xml => {
    const doc = readDoc(xml);
    if (typeof doc === 'string') return fail(doc);
    const ctl = find(doc, spec.controlName);
    if (!ctl) return fail(`control "${spec.controlName}" is not on the form. Controls: ${doc.controls.map(c => c.name).join(', ') || '(none)'}`);
    const target = resolveTarget(doc, spec.parentControl);
    if (typeof target === 'string') return fail(target);
    if (target.owner && isWithin(target.owner.node, ctl.node)) {
      return fail(`"${target.name}" is "${ctl.name}" itself or inside it; a control cannot move into its own subtree`);
    }
    const pos = position(spec);
    if (typeof pos === 'string') return fail(pos);
    const siblings = childrenOf(doc, target.collection).filter(c => c !== ctl);
    let anchor: XmlNode | null | undefined;
    let where: string;
    if (pos.kind === 'after') {
      const s = siblings.find(c => c.name.toLowerCase() === pos.sibling.toLowerCase());
      if (!s) {
        return fail(`previousSibling "${pos.sibling}" is not a direct child of "${target.name}". ` +
          `Its children are: ${siblings.map(c => c.name).join(', ') || '(none)'}`);
      }
      anchor = s.node; where = `after "${s.name}"`;
    } else if (pos.kind === 'begin') { anchor = null; where = 'first'; }
    else { anchor = undefined; where = 'last'; }

    const from = parentNameOf(doc, ctl);
    const all = childrenOf(doc, target.collection);
    const idx = all.indexOf(ctl);
    if (idx >= 0) {
      const already = anchor ? idx > 0 && all[idx - 1].node === anchor : anchor === null ? idx === 0 : idx === all.length - 1;
      if (already) return { ok: true, xml, changed: false, detail: `"${ctl.name}" is already ${where} in "${target.name}"`, warnings: [] };
    }
    // Same rule as wrap-controls: of 14,500 shipped TabPages all sit in a Tab, and a Tab holds nothing else.
    const typeOf = (n: XmlNode) => ITYPE.exec(xml.slice(n.start, n.openEnd))?.[1];
    const isPage = typeOf(ctl.node) === 'AxFormTabPageControl';
    const intoTab = !!target.owner && typeOf(target.owner.node) === 'AxFormTabControl';
    if (intoTab && !isPage) return fail(`a Tab holds TabPages only; "${ctl.name}" is not one. Wrap it in a TabPage first`);
    const warnings = isPage && !intoTab ? [`the TabPage "${ctl.name}" now sits in "${target.name}", which is not a Tab: wrap it (with its sibling pages) in a Tab next`] : [];
    const indent = lineIndentOf(xml, ctl.node.start);
    const cut = cutBlocks(xml, [ctl.node]);
    if (!cut) return fail(`"${ctl.name}" does not sit on lines of its own; it cannot be moved safely`);
    // Offsets after the cut point moved; re-read and resolve the target and anchor again.
    const doc2 = readDoc(cut.xml) as Doc;
    const target2 = resolveTarget(doc2, target.owner ? target.name : DESIGN) as Exclude<ReturnType<typeof resolveTarget>, string>;
    const anchor2 = anchor ? find(doc2, (pos as { sibling: string }).sibling)!.node : anchor;
    const out = insertIntoCollection(cut.xml, target2.collection, [{ text: cut.blocks[0], indent }], doc.unit, anchor2);
    if (out === null) return fail(`"${ctl.name}" is not indented consistently; it cannot be re-indented safely`);
    const bad = verify(out, [[ctl.name, target.name]]);
    if (bad) return fail(bad);
    return {
      ok: true, xml: out, changed: true, warnings,
      detail: from.toLowerCase() === target.name.toLowerCase()
        ? `moved "${ctl.name}" ${where} in "${target.name}"`
        : `moved "${ctl.name}" from "${from}" to "${target.name}", ${where}`,
    };
  });
}

/** Newest version the catalogue knows for a pattern name (top-level or sub-pattern). */
export function latestPatternVersion(pattern: string): string | undefined {
  const spec = resolvePatternExact(pattern) ?? resolveSubPattern(pattern);
  return spec?.versions[0];
}

function containerXml(indent: string, unit: string, type: ContainerType, props: Record<string, string>, inner: string): string {
  const order = (FORM_CONTROL_ELEMENT_ORDER as Record<string, readonly string[]>)[`AxForm${type}Control`];
  const all: Record<string, string> = { ...props, Type: type };
  const i1 = indent + unit;
  const lines = [`${indent}<AxFormControl xmlns=""`, `${i1}i:type="AxForm${type}Control">`, `${i1}<Name>${escapeText(props.Name)}</Name>`];
  const pre = order.slice(0, order.indexOf('FormControlExtension'));
  const post = order.slice(order.indexOf('Controls') + 1);
  for (const k of pre) if (k !== 'Name' && all[k] !== undefined) lines.push(`${i1}<${k}>${escapeText(all[k])}</${k}>`);
  lines.push(`${i1}<FormControlExtension`, `${i1}${unit}i:nil="true" />`, `${i1}<Controls>`);
  const tail = [`${i1}</Controls>`];
  for (const k of post) if (all[k] !== undefined) tail.push(`${i1}<${k}>${escapeText(all[k])}</${k}>`);
  tail.push(`${indent}</AxFormControl>`);
  return lines.join('\n') + '\n' + inner + tail.join('\n') + '\n';
}

/** wrap-controls: a new container where the first of the controls was, holding them in their current order. */
export function wrapFormControls(source: string, spec: WrapControlsSpec): RestructureResult {
  return withEol(source, xml => {
    const doc = readDoc(xml);
    if (typeof doc === 'string') return fail(doc);
    const names = spec.controlNames.map(n => n.trim()).filter(Boolean);
    if (names.length === 0) return fail('controlNames is empty');
    const type = (['Group', 'Tab', 'TabPage'] as const).find(t => t.toLowerCase() === (spec.containerType ?? 'Group').trim().toLowerCase());
    if (!type) return fail(`containerType must be Group, Tab or TabPage, not "${spec.containerType}"`);
    const name = spec.containerName?.trim();
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return fail(`containerName "${spec.containerName ?? ''}" is not a control name`);
    if (find(doc, name)) return fail(`the form already has a control named "${name}"`);

    const ctls: Ctl[] = [];
    for (const n of names) {
      const c = find(doc, n);
      if (!c) return fail(`control "${n}" is not on the form. Controls: ${doc.controls.map(x => x.name).join(', ')}`);
      if (ctls.includes(c)) return fail(`control "${c.name}" is listed twice`);
      ctls.push(c);
    }
    const parent = ctls[0].collection;
    const stray = ctls.find(c => c.collection !== parent);
    if (stray) {
      return fail(`the controls must share one parent: "${ctls[0].name}" is in "${parentNameOf(doc, ctls[0])}", ` +
        `"${stray.name}" in "${parentNameOf(doc, stray)}". Move them together first with move-control`);
    }
    const parentName = parentNameOf(doc, ctls[0]);
    const warnings: string[] = [];
    if (type === 'Tab') {
      const notPage = ctls.find(c => ITYPE.exec(xml.slice(c.node.start, c.node.openEnd))?.[1] !== 'AxFormTabPageControl');
      if (notPage) return fail(`a Tab holds TabPages only; "${notPage.name}" is not one. Wrap it in a TabPage first`);
    }
    if (type === 'TabPage') {
      const ownerType = ctls[0].owner ? ITYPE.exec(xml.slice(ctls[0].owner.start, ctls[0].owner.openEnd))?.[1] : undefined;
      if (ownerType !== 'AxFormTabControl') warnings.push(`the new TabPage sits in "${parentName}", which is not a Tab: wrap it (with its sibling pages) in a Tab next`);
    }

    const order = (FORM_CONTROL_ELEMENT_ORDER as Record<string, readonly string[]>)[`AxForm${type}Control`];
    const props: Record<string, string> = { Name: name };
    let version = spec.patternVersion?.trim();
    if (spec.pattern?.trim()) {
      props.Pattern = spec.pattern.trim();
      version ||= latestPatternVersion(props.Pattern);
      if (!version) return fail(`pattern "${props.Pattern}" is not in the pattern catalogue; pass patternVersion as well`);
      props.PatternVersion = version;
    } else if (version) return fail('patternVersion was given without pattern');
    if (spec.caption?.trim()) {
      props.Caption = spec.caption.trim();
      if (!props.Caption.startsWith('@')) warnings.push(`Caption "${props.Caption}" is literal text; use a label id (BPErrorLabelIsText)`);
    }
    if (spec.style?.trim()) props.Style = spec.style.trim();
    const refused = Object.keys(props).filter(k => !order.includes(k));
    if (refused.length) return fail(`a ${type} carries no ${refused.join(' / ')} (shipped metadata never has it on AxForm${type}Control)`);

    const indent = lineIndentOf(xml, ctls[0].node.start);
    const docOrder = [...ctls].sort((a, b) => a.node.start - b.node.start);
    const firstName = docOrder[0].name;
    const cut = cutBlocks(xml, docOrder.map(c => c.node));
    if (!cut) return fail('a control does not sit on lines of its own; it cannot be moved safely');
    const inner: string[] = [];
    for (const [i, b] of cut.blocks.entries()) {
      const r = reindent(b, lineIndentOf(xml, docOrder[i].node.start), indent + doc.unit + doc.unit);
      if (r === null) return fail(`"${docOrder[i].name}" is not indented consistently; it cannot be re-indented safely`);
      inner.push(r);
    }
    const block = containerXml(indent, doc.unit, type, props, inner.join(''));
    // The container goes where the first wrapped control was.
    const at = lineSpan(xml, docOrder[0].node)[0];
    const out = cut.xml.slice(0, at) + block + cut.xml.slice(at);
    const bad = verify(out, [[name, parentName], ...ctls.map(c => [c.name, name] as [string, string])]);
    if (bad) return fail(bad);
    const what = [props.Pattern && `Pattern ${props.Pattern} ${props.PatternVersion}`, props.Caption && `Caption ${props.Caption}`, props.Style && `Style ${props.Style}`]
      .filter(Boolean).join(', ');
    return {
      ok: true, xml: out, changed: true, warnings,
      detail: `wrapped ${docOrder.map(c => `"${c.name}"`).join(', ')} in new ${type} "${name}"${what ? ` (${what})` : ''} ` +
        `in "${parentName}", where "${firstName}" was`,
    };
  });
}
