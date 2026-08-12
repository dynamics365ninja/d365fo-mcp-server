/**
 * Placement + serialization for a control added to an AxFormExtension.
 *
 * A form extension expresses a new control in one of TWO mutually exclusive
 * shapes, and which one is correct depends entirely on WHERE the parent lives:
 *
 *   1. Parent is a control of the BASE FORM → an <AxFormExtensionControl>
 *      envelope in the extension's ROOT <Controls>, carrying its own wrapper
 *      <Name>, the real control under <FormControl>, and a <Parent> reference:
 *
 *        <Controls>                                   ← root, child of AxFormExtension
 *          <AxFormExtensionControl xmlns="">
 *            <Name>FormExtensionControlfse38xiwz</Name>
 *            <FormControl xmlns="" i:type="AxFormCheckBoxControl"> … </FormControl>
 *            <Parent>Grid</Parent>
 *          </AxFormExtensionControl>
 *        </Controls>
 *
 *   2. Parent is a container THE EXTENSION ITSELF DEFINES → a bare
 *      <AxFormControl i:type="…"> in that container's NESTED <Controls>. No
 *      envelope and no <Parent>: the nesting already encodes parentage, so a
 *      <Parent> element there is meaningless.
 *
 *        <FormControl xmlns="" i:type="AxFormGroupControl">
 *          <Name>QualityOrders</Name>
 *          <Controls>                                 ← nested
 *            <AxFormControl xmlns="" i:type="AxFormCheckBoxControl"> … </AxFormControl>
 *          </Controls>
 *          <DataGroup>QualityOrders</DataGroup>
 *        </FormControl>
 *
 * The previous implementation built shape 1 unconditionally and spliced it in
 * with `content.replace('</Controls>', …)`. A string pattern replaces the FIRST
 * occurrence, and when the extension defines its own container the nested
 * </Controls> closes first — so the envelope landed inside the nested
 * collection, which is typed to AxFormControl. `parentControl` was never
 * resolved to a node at all; it only supplied the <Parent> text. The result was
 * well-formed XML in the wrong collection, reported as a success.
 *
 * This module resolves the parent against the extension's own control tree and
 * derives BOTH the representation and the insertion offset from where that
 * parent turns out to live. Pure and side-effect-free so it is trivially
 * testable — the file I/O stays in the caller.
 */

// ─── Minimal offset-preserving XML reader ────────────────────────────────────
//
// A real parse + re-serialize would reformat the whole file (D365FO metadata XML
// is diffed by humans and by TFVC), so this walks the tags and records offsets
// instead, leaving every byte we don't touch exactly as it was.

interface XmlNode {
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
function findTagEnd(xml: string, from: number): number {
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
function parseNodes(xml: string): XmlNode | null {
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let i = 0;

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;

    // Prologue / comments / CDATA / doctype carry no structure we care about,
    // but they DO carry '<' and '>' that would otherwise be read as tags.
    // (AxFormExtension can hold <SourceCode> methods wrapped in CDATA.)
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

const firstChild = (n: XmlNode, name: string): XmlNode | undefined =>
  n.children.find(c => c.name === name);

const textOf = (xml: string, n: XmlNode): string =>
  n.selfClosing ? '' : xml.slice(n.openEnd, n.closeStart).trim();

/**
 * Every control the EXTENSION itself defines, keyed by lowercased name.
 *
 * Only <FormControl> (inside an envelope) and <AxFormControl> (nested) are
 * controls. <AxFormExtensionControl>'s own <Name> is the auto-generated wrapper
 * id, NOT a control name, so reading names off the wrapper would make
 * `parentControl: "FormExtensionControlfse38xiwz"` resolve to something real.
 */
function collectExtensionControls(xml: string, root: XmlNode): Map<string, XmlNode> {
  const byName = new Map<string, XmlNode>();
  const visit = (n: XmlNode): void => {
    if (n.name === 'FormControl' || n.name === 'AxFormControl') {
      const nameNode = firstChild(n, 'Name');
      if (nameNode) {
        const name = textOf(xml, nameNode);
        if (name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), n);
      }
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  return byName;
}

/** Leading whitespace of the line `offset` sits on, for matching the file's indentation. */
function lineIndentOf(xml: string, offset: number): string {
  const lineStart = xml.lastIndexOf('\n', offset - 1) + 1;
  const seg = xml.slice(lineStart, offset);
  return /^[ \t]*$/.test(seg) ? seg : '\t';
}

const indentBlock = (lines: string[], indent: string): string =>
  lines.map(l => (l === '' ? '' : indent + l)).join('\n');

// ─── Placement validation ────────────────────────────────────────────────────

export interface FormExtPlacementProblem {
  /** The misplaced element. */
  element: string;
  /** 1-based line in the supplied XML. */
  line: number;
  detail: string;
}

/**
 * Check that every control element sits in a collection typed to hold it.
 *
 * This exists because of how the platform actually behaves, measured 2026-08-12
 * by compiling the malformed file: an <AxFormExtensionControl> inside a nested
 * <Controls> does NOT fail the build. xppc returns 0 errors — the deserializer
 * silently DISCARDS the node. The control never reaches the form, and the only
 * trace is a metadata WARNING, and only when the parent happens to be
 * <DataGroup>-bound so there are two field sets to compare:
 *
 *   Metadata Warning: …/Controls/FormExtensionControl…/…/DataGroup: The form
 *   control has different fields from the field group '…' it is bound to.
 *   Use restore on the form control.
 *
 * That warning names neither the malformed node nor the control, and it arrived
 * among 52 pre-existing warnings. For a parent that is NOT DataGroup-bound there
 * is nothing to compare, so the discard is expected to be entirely silent.
 *
 * A compiler that stays quiet is the whole problem: nothing downstream will ever
 * catch this, so the check has to happen here, before the write. Name-based
 * validation (formExtensionShapeValidator) cannot see it — every element in the
 * malformed file is spelled correctly; only its POSITION is wrong.
 */
export function findFormExtensionPlacementProblems(xml: string): FormExtPlacementProblem[] {
  const root = parseNodes(xml);
  if (!root || root.name !== 'AxFormExtension') return [];

  const problems: FormExtPlacementProblem[] = [];
  const lineAt = (offset: number): number => {
    let line = 1;
    for (let i = 0; i < offset && i < xml.length; i++) if (xml[i] === '\n') line++;
    return line;
  };

  // The extension's ROOT <Controls> holds envelopes, and only envelopes.
  const rootControls = firstChild(root, 'Controls');
  if (rootControls && !rootControls.selfClosing) {
    for (const child of rootControls.children) {
      if (child.name !== 'AxFormExtensionControl') {
        problems.push({
          element: child.name,
          line: lineAt(child.start),
          detail:
            `<${child.name}> is in the extension's ROOT <Controls>, which holds ` +
            `<AxFormExtensionControl> envelopes. A control attached to a base-form parent needs the ` +
            `envelope (wrapper <Name>, <FormControl i:type="…">, <Parent>); a control nested under a ` +
            `container this extension defines belongs in THAT container's <Controls> instead.`,
        });
      }
    }
  }

  // A NESTED <Controls> holds bare controls, and only bare controls.
  const visit = (n: XmlNode): void => {
    if (n.name === 'FormControl' || n.name === 'AxFormControl') {
      const nested = firstChild(n, 'Controls');
      if (nested && !nested.selfClosing) {
        const ownerName = firstChild(n, 'Name');
        const owner = ownerName ? textOf(xml, ownerName) : '(unnamed)';
        for (const child of nested.children) {
          if (child.name !== 'AxFormControl') {
            problems.push({
              element: child.name,
              line: lineAt(child.start),
              detail:
                `<${child.name}> is nested inside the <Controls> of "${owner}", which is typed to ` +
                `<AxFormControl>. The D365FO deserializer DISCARDS it — the build reports no error and ` +
                `the control simply never appears on the form. Nesting already encodes parentage, so a ` +
                `child control here is a bare <AxFormControl i:type="…"> with no wrapper and no <Parent>.`,
            });
          }
        }
      }
    }
    for (const c of n.children) visit(c);
  };
  visit(root);

  return problems;
}

/** Render placement problems as a blocking, self-explaining error. */
export function buildFormExtensionPlacementError(
  objectName: string,
  problems: FormExtPlacementProblem[],
): string {
  const rows = problems
    .map(p => `  • line ${p.line}: <${p.element}>\n    ${p.detail}`)
    .join('\n');
  return (
    `⛔ form-extension "${objectName}" — a control element is in a collection that cannot hold it.\n\n` +
    `${rows}\n\n` +
    `This does NOT fail the build. The deserializer drops the misplaced node and xppc reports 0 errors, ` +
    `so the change looks applied and simply has no effect (verified by compiling the malformed shape).`
  );
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface FormExtensionControlSpec {
  controlName: string;
  parentControl: string;
  /** Element name emitted as i:type, e.g. "AxFormCheckBoxControl". */
  iType: string;
  /** <Type> value, e.g. "CheckBox". */
  typeValue: string;
  dataSource?: string;
  dataField?: string;
  label?: string;
  /**
   * Wrapper <Name> for the envelope shape. Injected rather than generated here so
   * this module stays deterministic; ignored for the nested shape, which has no
   * wrapper.
   */
  wrapperName: string;
  /** Insert directly after this existing sibling instead of at the end (nested shape only). */
  previousSibling?: string;
}

export type InsertFormExtensionControlResult =
  /** Control written. `representation` says which of the two shapes was emitted. */
  | { kind: 'inserted'; xml: string; representation: 'envelope' | 'nested'; notes: string[] }
  /** A control with this name is already present — nothing to do. */
  | { kind: 'exists' }
  /** Understood the file, but writing would be wrong. `message` is caller-facing. */
  | { kind: 'refused'; message: string }
  /** Not a shape this writer recognises; the caller should fall through. */
  | { kind: 'unsupported' };

/**
 * Insert a control into an AxFormExtension, choosing shape AND location from
 * where `parentControl` actually lives.
 */
export function insertFormExtensionControl(
  xml: string,
  spec: FormExtensionControlSpec,
): InsertFormExtensionControlResult {
  const root = parseNodes(xml);
  // Refuse anything that isn't a form extension outright, so a mis-typed
  // objectType can never splice control XML into an unrelated metadata file.
  if (!root || root.name !== 'AxFormExtension') return { kind: 'unsupported' };

  const owned = collectExtensionControls(xml, root);

  // Idempotency, by resolved control name rather than a bare `<Name>X</Name>`
  // substring search — the latter also matches data sources, fields and the
  // extension's own <Name>, turning a real add into a silent no-op "success".
  if (owned.has(spec.controlName.toLowerCase())) return { kind: 'exists' };

  const parentNode = owned.get(spec.parentControl.toLowerCase());
  const notes: string[] = [];

  if (parentNode) {
    // ── Shape 2: parent is extension-owned → bare AxFormControl, nested ──────
    const dataGroup = firstChild(parentNode, 'DataGroup');
    if (dataGroup) {
      const dsNode = firstChild(parentNode, 'DataSource');
      notes.push(dataGroupWarning(
        spec,
        textOf(xml, dataGroup),
        dsNode ? textOf(xml, dsNode) : undefined,
      ));
    }

    const controls = firstChild(parentNode, 'Controls');
    if (!controls) {
      return {
        kind: 'refused',
        message:
          `Parent control "${spec.parentControl}" is defined by this extension but has no <Controls> ` +
          `collection, and the position of a new one is property-order sensitive — writing it blind ` +
          `risks a file the deserializer rejects.\n\n` +
          `Add the first child in the form designer (it emits <Controls>), then re-run add-control for ` +
          `any further children.`,
      };
    }

    const block = nestedControlLines(spec);
    const updated = insertIntoControls(xml, controls, block, spec.previousSibling, notes);
    return finish(updated, spec, 'nested', notes);
  }

  // ── Shape 1: parent is a base-form control → envelope in the ROOT Controls ─
  const rootControls = firstChild(root, 'Controls');
  if (!rootControls) return { kind: 'unsupported' };

  if (spec.previousSibling) {
    notes.push(
      `previousSibling "${spec.previousSibling}" was ignored: "${spec.parentControl}" is a base-form ` +
      `control, so the new control is an <AxFormExtensionControl> whose siblings are other extension ` +
      `entries, not form controls. Order within the extension's root <Controls> does not affect layout.`,
    );
  }

  const block = envelopeControlLines(spec);
  const updated = insertIntoControls(xml, rootControls, block, undefined, notes);
  return finish(updated, spec, 'envelope', notes);
}

/**
 * Post-write invariant check. The fallback path used to report ✅ off a raw
 * string splice with nothing verifying the result, and the compiler will not
 * catch the mistake for us — a misplaced control is silently discarded at 0
 * errors (see findFormExtensionPlacementProblems). So this is the only gate
 * there is, and it has to check POSITION, not just presence.
 *
 * Presence alone is not enough: the malformed shape this module exists to
 * prevent keeps the control's <Name> perfectly readable — it is the enclosing
 * collection that is wrong. An earlier draft of this function asked only
 * "is the control findable?" and would have waved the bad output straight
 * through.
 */
function finish(
  updated: string,
  spec: FormExtensionControlSpec,
  representation: 'envelope' | 'nested',
  notes: string[],
): InsertFormExtensionControlResult {
  const reparsed = parseNodes(updated);
  if (!reparsed || reparsed.name !== 'AxFormExtension') {
    return {
      kind: 'refused',
      message:
        `Internal check failed: inserting "${spec.controlName}" produced XML that no longer parses as ` +
        `an AxFormExtension. The file was left unchanged. Please report this with the extension XML.`,
    };
  }
  if (!collectExtensionControls(updated, reparsed).has(spec.controlName.toLowerCase())) {
    return {
      kind: 'refused',
      message:
        `Internal check failed: "${spec.controlName}" is not readable as a control after insertion. ` +
        `The file was left unchanged. Please report this with the extension XML.`,
    };
  }
  const misplaced = findFormExtensionPlacementProblems(updated);
  if (misplaced.length > 0) {
    return {
      kind: 'refused',
      message:
        `Internal check failed — the write was ABANDONED and the file left unchanged.\n\n` +
        buildFormExtensionPlacementError(spec.controlName, misplaced) +
        `\n\nThis is a bug in the writer, not in your call. Please report it with the extension XML.`,
    };
  }
  return { kind: 'inserted', xml: updated, representation, notes };
}

/**
 * Advisory, deliberately NOT a refusal.
 *
 * The base-form guard elsewhere refuses, and is right to: a base-form
 * <DataGroup> container has its members generated by the compiler, so an
 * explicit control for one of them collides ("The duplicate name … was
 * detected"). That reasoning does not carry over here. A group created by a form
 * EXTENSION renders exactly its explicit <Controls> list and nothing ever tops
 * it up (measured 2026-08-12: a field-group member with no explicit control does
 * not appear on the running form). So on an extension-owned parent the explicit
 * control is not a duplicate — it is the only thing that puts the field on the
 * form, and refusing would send the caller to the Visual Studio designer for the
 * one job this tool exists to do without it.
 *
 * What remains true is that the control has to AGREE with the field group, or
 * the build warns ("different fields from the field group … use restore on the
 * form control") and the next designer Refresh rewrites the collection from the
 * field group. That is worth saying every time and not worth blocking on —
 * whether the written control agrees cannot be answered without reading the
 * table's field group, which this pure function has no access to.
 */
function dataGroupWarning(
  spec: FormExtensionControlSpec,
  dataGroup: string,
  dataSource: string | undefined,
): string {
  const onTable = dataSource ? ` on \`${dataSource}\`` : '';
  const field = spec.dataField ?? spec.controlName;
  const generated = `${dataGroup}_${field}`;
  return (
    `parent "${spec.parentControl}" renders field group **${dataGroup}**${onTable} via \`<DataGroup>\`, ` +
    `so its children are expected to mirror that field group.\n` +
    `  • If \`${field}\` IS a member of ${dataGroup}, name the control \`${generated}\` and type it from ` +
    `the field — that is what the designer's Refresh generates, so the two agree and a later Refresh ` +
    `has nothing to rewrite.\n` +
    `  • If \`${field}\` is NOT a member, the build warns ("different fields from the field group … use ` +
    `restore on the form control") and the next Refresh discards this control. Add the field to the ` +
    `field group instead — d365fo_file(action="modify", objectType="table-extension", ` +
    `operations=[{operation:"add-field-to-field-group", fieldGroupName:"${dataGroup}", ` +
    `fieldName:"${field}", extendBaseFieldGroup:true}]).\n` +
    `  • Note this parent belongs to the form EXTENSION, not the base form. Only a BASE-FORM ` +
    `<DataGroup> group auto-generates its missing members, so adding the field to the field group ` +
    `alone will NOT put it on the form here — an explicit control is required.`
  );
}

/** The bare nested shape — no wrapper, no <Parent>; nesting encodes parentage. */
function nestedControlLines(spec: FormExtensionControlSpec): string[] {
  return [
    `<AxFormControl xmlns="" i:type="${spec.iType}">`,
    ...innerControlLines(spec).map(l => `\t${l}`),
    `</AxFormControl>`,
  ];
}

/** The envelope shape — wrapper <Name>, the control under <FormControl>, then <Parent>. */
function envelopeControlLines(spec: FormExtensionControlSpec): string[] {
  return [
    `<AxFormExtensionControl xmlns="">`,
    `\t<Name>${spec.wrapperName}</Name>`,
    `\t<FormControl xmlns="" i:type="${spec.iType}">`,
    ...innerControlLines(spec).map(l => `\t\t${l}`),
    `\t</FormControl>`,
    `\t<Parent>${spec.parentControl}</Parent>`,
    `</AxFormExtensionControl>`,
  ];
}

/**
 * Control body, in the order the D365FO SDK serializes it:
 * Name → Type → FormControlExtension(nil) → DataField → DataSource → Label → [Items].
 */
function innerControlLines(spec: FormExtensionControlSpec): string[] {
  const lines = [
    `<Name>${spec.controlName}</Name>`,
    `<Type>${spec.typeValue}</Type>`,
    `<FormControlExtension i:nil="true" />`,
  ];
  if (spec.dataField) lines.push(`<DataField>${spec.dataField}</DataField>`);
  if (spec.dataSource) lines.push(`<DataSource>${spec.dataSource}</DataSource>`);
  if (spec.label) lines.push(`<Label>${spec.label}</Label>`);
  if (spec.typeValue === 'ComboBox') lines.push(`<Items />`);
  return lines;
}

/**
 * Splice `blockLines` into `controls`, at the end or directly after
 * `previousSibling`. Indentation is derived from the collection's own line so
 * the result matches whatever convention the file already uses.
 */
function insertIntoControls(
  xml: string,
  controls: XmlNode,
  blockLines: string[],
  previousSibling: string | undefined,
  notes: string[],
): string {
  const closeIndent = lineIndentOf(xml, controls.start);
  const childIndent = closeIndent + '\t';
  const block = indentBlock(blockLines, childIndent);

  // Empty collection: <Controls /> (attributes such as xmlns="" must survive).
  if (controls.selfClosing) {
    if (previousSibling) {
      notes.push(
        `previousSibling "${previousSibling}" was ignored: the parent's <Controls> collection is empty.`,
      );
    }
    const openTag = xml.slice(controls.start, controls.openEnd).replace(/\s*\/>$/, '>');
    return (
      xml.slice(0, controls.start) +
      openTag + '\n' + block + '\n' + closeIndent + `</${controls.name}>` +
      xml.slice(controls.openEnd)
    );
  }

  let at = controls.closeStart; // default: last position in the collection

  if (previousSibling) {
    const sibling = controls.children.find(c => {
      const nameNode = firstChild(c, 'Name');
      return nameNode && textOf(xml, nameNode).toLowerCase() === previousSibling.toLowerCase();
    });
    if (sibling) {
      at = sibling.end;
    } else {
      notes.push(
        `previousSibling "${previousSibling}" was not found among the parent's existing children — ` +
        `the control was appended last instead.`,
      );
    }
  }

  if (at === controls.closeStart) {
    let before = xml.slice(0, at).replace(/[ \t]*$/, '');
    if (!before.endsWith('\n')) before += '\n';
    return before + block + '\n' + closeIndent + xml.slice(at);
  }
  // After a sibling: the sibling's own line already ends where we splice.
  return xml.slice(0, at) + '\n' + block + xml.slice(at);
}
