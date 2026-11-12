/**
 * add-method "Control.method" on a form: the first override of a form CONTROL.
 *
 * The bridge's AddMethod routes a dotted name to a data source ("DS.method",
 * "DS.Field.method") and updates a control override that already exists, but a
 * NEW control override ("OkButton.clicked") fell through to the form-class path
 * and became a form method literally named "OkButton.clicked" (#1161).
 *
 * Control overrides do not live in the design tree. They live beside the form's
 * own methods, in a holder per control:
 *
 *   <SourceCode>
 *     <Methods xmlns=""> … </Methods>
 *     <DataSources xmlns=""> … </DataSources>
 *     <DataControls xmlns="">
 *       <Control>
 *         <Name>OkButton</Name>
 *         <Type>CommandButton</Type>          ← the design control's own <Type>
 *         <Methods>
 *           <Method>
 *             <Name>clicked</Name>
 *             <Source><![CDATA[ … ]]></Source>
 *           </Method>
 *         </Methods>
 *       </Control>
 *     </DataControls>
 *     <Members xmlns="" />
 *   </SourceCode>
 *
 * An override that is already there is found with methodSourceSpans, the locator
 * replace-code uses, so add and replace agree on where a control override is.
 *
 * Pure and side-effect-free: the file I/O stays in the caller. Works on text with
 * LF line endings, as the other method writers do, and stores `source` as given
 * (the caller applies the doc comment and indentation pass every add-method gets).
 */

import { type XmlNode, parseNodes, firstChild, textValueOf, lineIndentOf } from './xmlNodeTree.js';
import { methodSourceSpans } from './methodSourceSpans.js';
import { levenshteinDistance } from './fuzzyMatching.js';

export type FormControlMethodOutcome =
  /** Not an AxForm: nothing to decide here. */
  | { kind: 'not-a-form' }
  /** The first segment is a data source of the form: the bridge's data source path. */
  | { kind: 'data-source' }
  /** The override is already there: add-method updates it in place, as before. */
  | { kind: 'exists' }
  /** The first segment is neither a data source nor a control of the form. */
  | { kind: 'no-such-owner'; owner: string; close: string[]; controlCount: number }
  | { kind: 'refused'; reason: string }
  | { kind: 'added'; xml: string; controlName: string; methodName: string; firstOverride: boolean };

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ITYPE = /\bi:type\s*=\s*"AxForm(\w+?)Control"/;

const nameOf = (xml: string, node: XmlNode): string => {
  const n = firstChild(node, 'Name');
  return n ? textValueOf(xml, n) : '';
};

function walk(node: XmlNode, visit: (n: XmlNode) => void): void {
  for (const child of node.children) {
    visit(child);
    walk(child, visit);
  }
}

/** Up to `max` control names close to `wanted`: one contains the other, or a small edit distance. */
function closeNames(wanted: string, names: string[], max = 5): string[] {
  const w = wanted.toLowerCase();
  const limit = Math.max(2, Math.floor(w.length / 3));
  return names
    .map(n => {
      const c = n.toLowerCase();
      return { n, d: c.includes(w) || w.includes(c) ? 0 : levenshteinDistance(w, c) };
    })
    .filter(x => x.d <= limit)
    .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))
    .slice(0, max)
    .map(x => x.n);
}

/** `<Method>` as the designer writes it: CDATA opening on its own line, a blank line before `]]>`. */
export function renderSourceMethod(methodName: string, source: string, indent: string, unit = '\t'): string {
  return (
    `${indent}<Method>\n${indent}${unit}<Name>${methodName}</Name>\n${indent}${unit}<Source><![CDATA[\n` +
    `${source.replace(/\s+$/, '')}\n\n]]></Source>\n${indent}</Method>`
  );
}

/** Insert `block` (whole lines, no trailing newline) as the last child of the open element `parent`. */
function appendChild(xml: string, parent: XmlNode, block: string, parentIndent: string): string {
  let at = parent.closeStart;
  while (at > parent.openEnd && /\s/.test(xml[at - 1])) at--;
  const tail = at === parent.openEnd ? `\n${parentIndent}` : '';
  return `${xml.slice(0, at)}\n${block}${tail}${xml.slice(at === parent.openEnd ? parent.closeStart : at)}`;
}

/**
 * Add the override `Control.method` (`qualifiedName`) with `source` to an AxForm.
 * See FormControlMethodOutcome for what each answer means to the caller.
 */
export function addFormControlMethod(xml: string, qualifiedName: string, source: string): FormControlMethodOutcome {
  const root = parseNodes(xml);
  if (!root || root.name !== 'AxForm') return { kind: 'not-a-form' };

  const parts = qualifiedName.split('.').map(p => p.trim());
  const owner = parts[0];
  const ownerKey = owner.toLowerCase();

  // ── A data source keeps the bridge's path ("DS.method", "DS.Field.method") ──
  const dataSourceNames: string[] = [];
  const dataSources = firstChild(root, 'DataSources');
  if (dataSources) {
    walk(dataSources, n => {
      if (/^AxForm\w*DataSource\w*$/.test(n.name)) dataSourceNames.push(nameOf(xml, n));
    });
  }
  const sourceCode = firstChild(root, 'SourceCode');
  const sourceDataSources = sourceCode && firstChild(sourceCode, 'DataSources');
  for (const holder of sourceDataSources?.children ?? []) dataSourceNames.push(nameOf(xml, holder));
  if (dataSourceNames.some(n => n.toLowerCase() === ownerKey)) return { kind: 'data-source' };

  // ── Already there: add-method keeps updating it in place ─────────────────
  if ((methodSourceSpans(xml, qualifiedName) ?? []).length > 0) return { kind: 'exists' };

  // ── The control: in the design tree, or already a holder in <DataControls> ─
  const controls: Array<{ name: string; type: string }> = [];
  const design = firstChild(root, 'Design');
  if (design) {
    walk(design, n => {
      if (n.name !== 'AxFormControl') return;
      const typeNode = firstChild(n, 'Type');
      const type = typeNode ? textValueOf(xml, typeNode) : (ITYPE.exec(xml.slice(n.start, n.openEnd))?.[1] ?? '');
      controls.push({ name: nameOf(xml, n), type });
    });
  }
  const dataControls = sourceCode && firstChild(sourceCode, 'DataControls');
  const holders = (dataControls?.children ?? []).filter(c => c.name === 'Control');
  const holder = holders.find(h => nameOf(xml, h).toLowerCase() === ownerKey);
  const control = controls.find(c => c.name.toLowerCase() === ownerKey);
  if (!control && !holder) {
    const names = [...new Set([...controls.map(c => c.name), ...holders.map(h => nameOf(xml, h))])].filter(Boolean);
    return { kind: 'no-such-owner', owner, close: closeNames(owner, names), controlCount: names.length };
  }
  const controlName = control?.name ?? nameOf(xml, holder!);

  if (parts.length !== 2 || !IDENTIFIER.test(parts[1])) {
    return {
      kind: 'refused',
      reason: `a control override is named "Control.method", and "${qualifiedName}" is not: '${controlName}' is a control, not a data source.`,
    };
  }
  const methodName = parts[1];
  if (source.includes(']]>')) {
    return { kind: 'refused', reason: `method source contains ']]>', which cannot be stored inside a CDATA section.` };
  }
  if (!sourceCode || sourceCode.selfClosing) {
    return { kind: 'refused', reason: 'the form has no <SourceCode> block to hold a control override.' };
  }

  // <SourceCode> is one level deep, so its indentation is the file's indent unit.
  const unit = lineIndentOf(xml, sourceCode.start) || '\t';
  const at = (depth: number): string => unit.repeat(depth);
  const method = renderSourceMethod(methodName, source, at(5), unit);
  const methods = `${at(4)}<Methods>\n${method}\n${at(4)}</Methods>`;

  // ── The control already has a holder: its next override ──────────────────
  if (holder) {
    if (holder.selfClosing) {
      return { kind: 'refused', reason: `the <Control> holder of '${controlName}' in <DataControls> is empty — nothing was written.` };
    }
    const own = firstChild(holder, 'Methods');
    if (own && !own.selfClosing) {
      const duplicate = own.children.some(m => m.name === 'Method' && nameOf(xml, m).toLowerCase() === methodName.toLowerCase());
      if (duplicate) return { kind: 'exists' };
      return { kind: 'added', xml: appendChild(xml, own, method, at(4)), controlName, methodName, firstOverride: false };
    }
    const updated = own
      ? `${xml.slice(0, own.start)}${methods.trimStart()}${xml.slice(own.end)}`
      : appendChild(xml, holder, methods, at(3));
    return { kind: 'added', xml: updated, controlName, methodName, firstOverride: true };
  }

  // ── Its first override: a new holder, typed like the design control ──────
  const type = control!.type;
  if (!type) {
    return { kind: 'refused', reason: `control '${controlName}' has no <Type> in the design, so its <DataControls> holder cannot be typed.` };
  }
  const block =
    `${at(3)}<Control>\n${at(4)}<Name>${controlName}</Name>\n${at(4)}<Type>${type}</Type>\n${methods}\n${at(3)}</Control>`;

  let updated: string;
  if (!dataControls) {
    // Directly after <DataSources> (and so before <Members>), where standard forms keep it.
    const members = firstChild(sourceCode, 'Members');
    const collection = `${at(2)}<DataControls xmlns="">\n${block}\n${at(2)}</DataControls>`;
    updated = sourceDataSources
      ? `${xml.slice(0, sourceDataSources.end)}\n${collection}${xml.slice(sourceDataSources.end)}`
      : members
        ? `${xml.slice(0, members.start)}${collection.trimStart()}\n${at(2)}${xml.slice(members.start)}`
        : appendChild(xml, sourceCode, collection, at(1));
  } else if (dataControls.selfClosing) {
    const open = xml.slice(dataControls.start, dataControls.openEnd).replace(/\s*\/>$/, '>');
    updated = `${xml.slice(0, dataControls.start)}${open}\n${block}\n${at(2)}</DataControls>${xml.slice(dataControls.end)}`;
  } else {
    updated = appendChild(xml, dataControls, block, at(2));
  }
  return { kind: 'added', xml: updated, controlName, methodName, firstOverride: true };
}
