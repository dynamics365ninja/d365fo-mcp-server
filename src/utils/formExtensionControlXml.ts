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

import {
  type XmlNode, parseNodes, firstChild, textValueOf, isWithin, lineIndentOf,
} from './xmlNodeTree.js';

/**
 * The extension's own <Name> — the object the caller and the file are named
 * after, which is what an error banner has to identify. The control name is not
 * a substitute: in the report-a-bug path the reader needs to know WHICH FILE to
 * attach, and every extension has controls.
 */
const extensionNameOf = (xml: string, root: XmlNode): string => {
  const nameNode = firstChild(root, 'Name');
  return (nameNode ? textValueOf(xml, nameNode) : '') || '(unnamed form extension)';
};

/**
 * Every control the EXTENSION itself defines, keyed by lowercased name and
 * split by whether the deserializer will actually read it.
 *
 * Only <FormControl> (inside an envelope) and <AxFormControl> (nested) are
 * controls. <AxFormExtensionControl>'s own <Name> is the auto-generated wrapper
 * id, NOT a control name, so reading names off the wrapper would make
 * `parentControl: "FormExtensionControlfse38xiwz"` resolve to something real.
 *
 * The split matters because a control inside a misplaced element is discarded
 * whole (see findFormExtensionPlacementProblems) — it is in the file and it is
 * not on the form. Treating it as present made the two things a caller does
 * with a damaged file both wrong: re-adding the control reported "already
 * present, skipped", and naming it as a parent nested the new control inside
 * the dead subtree, so that one was discarded too.
 */
interface ExtensionControls {
  /** Controls the deserializer reads. */
  live: Map<string, XmlNode>;
  /** Controls present in the file but inside a discarded subtree. */
  discarded: Map<string, XmlNode>;
}

function collectExtensionControls(
  xml: string,
  root: XmlNode,
  discardedRoots: XmlNode[] = [],
): ExtensionControls {
  const live = new Map<string, XmlNode>();
  const discarded = new Map<string, XmlNode>();
  const visit = (n: XmlNode): void => {
    if (n.name === 'FormControl' || n.name === 'AxFormControl') {
      const nameNode = firstChild(n, 'Name');
      if (nameNode) {
        const name = textValueOf(xml, nameNode).toLowerCase();
        const target = discardedRoots.some(d => isWithin(n, d)) ? discarded : live;
        if (name && !target.has(name)) target.set(name, n);
      }
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  return { live, discarded };
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
  return findPlacementIssues(xml, root).map(i => i.problem);
}

/**
 * A misplaced element paired with its node.
 *
 * The node is what makes the difference between "this file has a problem" and
 * "THIS control is the problem": everything inside a misplaced element is
 * discarded along with it, so the writer has to be able to ask whether a
 * particular control it just resolved happens to live in the dead subtree.
 */
interface FormExtPlacementIssue {
  node: XmlNode;
  problem: FormExtPlacementProblem;
}

function findPlacementIssues(xml: string, root: XmlNode): FormExtPlacementIssue[] {
  const issues: FormExtPlacementIssue[] = [];
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
        issues.push({
          node: child,
          problem: {
          element: child.name,
          line: lineAt(child.start),
          detail:
            `<${child.name}> is in the extension's ROOT <Controls>, which holds ` +
            `<AxFormExtensionControl> envelopes. A control attached to a base-form parent needs the ` +
            `envelope (wrapper <Name>, <FormControl i:type="…">, <Parent>); a control nested under a ` +
            `container this extension defines belongs in THAT container's <Controls> instead.`,
          },
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
        const owner = ownerName ? textValueOf(xml, ownerName) : '(unnamed)';
        for (const child of nested.children) {
          if (child.name !== 'AxFormControl') {
            issues.push({
              node: child,
              problem: {
              element: child.name,
              line: lineAt(child.start),
              detail:
                `<${child.name}> is nested inside the <Controls> of "${owner}", which is typed to ` +
                `<AxFormControl>. The D365FO deserializer DISCARDS it — the build reports no error and ` +
                `the control simply never appears on the form. Nesting already encodes parentage, so a ` +
                `child control here is a bare <AxFormControl i:type="…"> with no wrapper and no <Parent>.`,
              },
            });
          }
        }
      }
    }
    for (const c of n.children) visit(c);
  };
  visit(root);

  return issues;
}

/**
 * Stable identity for a placement problem, deliberately excluding the line
 * number: inserting a control shifts every line below it, so line-bearing keys
 * would make untouched pre-existing problems look brand new. Element + detail
 * still distinguishes the cases that matter, and equal keys are compared by
 * COUNT, so a genuinely new duplicate of an existing problem is still caught.
 */
const problemKey = (p: FormExtPlacementProblem): string => `${p.element} ${p.detail}`;

const tallyProblems = (problems: FormExtPlacementProblem[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const p of problems) counts.set(problemKey(p), (counts.get(problemKey(p)) ?? 0) + 1);
  return counts;
};

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
  /**
   * Name of the existing sibling to place the control after.
   *
   * Nested shape: the control is spliced directly after that sibling in the
   * parent's <Controls>. Envelope shape: position among the BASE FORM's children
   * is not expressible by splice order, so it is written as
   * <PositionType>AfterItem</PositionType><PreviousSibling>…</PreviousSibling>.
   */
  previousSibling?: string;
  /** "AfterItem" (needs previousSibling), "Begin", or "End" (default). Envelope shape only. */
  positionType?: string;
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

  // Problems the file arrived with. The post-write check compares against these
  // rather than against zero: a file damaged by an earlier writer must still
  // accept a correct write, or the release that fixes the bug is also the
  // release that locks every already-damaged file out of the repair.
  const preExisting = findPlacementIssues(xml, root);
  const baseline = tallyProblems(preExisting.map(i => i.problem));
  const discardedRoots = preExisting.map(i => i.node);

  const owned = collectExtensionControls(xml, root, discardedRoots);
  const notes: string[] = [];

  if (preExisting.length > 0) {
    notes.push(
      `this file already contained ${preExisting.length} misplaced control ` +
      `element(s) (line(s) ${preExisting.map(i => i.problem.line).join(', ')}), which the D365FO ` +
      `deserializer discards. They were left exactly as they are — this write neither caused nor ` +
      `fixed them. Delete them once the replacement control is confirmed on the form.`,
    );
  }

  // Idempotency, by resolved control name rather than a bare `<Name>X</Name>`
  // substring search — the latter also matches data sources, fields and the
  // extension's own <Name>, turning a real add into a silent no-op "success".
  // Only a LIVE control counts: a discarded one is not on the form, and the
  // caller re-running the identical add is precisely how it gets repaired.
  if (owned.live.has(spec.controlName.toLowerCase())) return { kind: 'exists' };

  const discardedTwin = owned.discarded.get(spec.controlName.toLowerCase());
  if (discardedTwin) {
    notes.push(
      `a control named "${spec.controlName}" already exists in this file but sits in a collection the ` +
      `deserializer discards, so it never reached the form. A correctly-placed one was written; the ` +
      `dead copy is still there and should be deleted.`,
    );
  }

  const parentNode = owned.live.get(spec.parentControl.toLowerCase());

  // A parent that is itself discarded cannot host anything: nesting into it
  // buys a second discarded control and another silent ✅.
  if (!parentNode && owned.discarded.has(spec.parentControl.toLowerCase())) {
    return {
      kind: 'refused',
      message:
        `Parent control "${spec.parentControl}" exists in this extension but sits inside a misplaced ` +
        `element that the D365FO deserializer discards, so it is not on the form and cannot hold a ` +
        `child — anything nested under it would be discarded with it.\n\n` +
        `Fix the misplaced element first (see the placement problems reported for this file), then ` +
        `re-run add-control.`,
    };
  }

  if (parentNode) {
    // ── Shape 2: parent is extension-owned → bare AxFormControl, nested ──────
    const dataGroup = firstChild(parentNode, 'DataGroup');
    if (dataGroup) {
      const dsNode = firstChild(parentNode, 'DataSource');
      notes.push(dataGroupWarning(
        spec,
        textValueOf(xml, dataGroup),
        dsNode ? textValueOf(xml, dsNode) : undefined,
      ));
    }

    const block = nestedControlLines(spec);
    const controls = firstChild(parentNode, 'Controls');

    // No <Controls> yet — the parent is childless. This is the normal state of a
    // group this very tool just created (innerControlLines emits Name, Type and
    // FormControlExtension, never Controls), so refusing here broke the tool's
    // own create-group-then-fill-it workflow and sent the caller to Visual Studio
    // for the one job add-control exists to do.
    if (!controls) {
      const created = createControlsCollection(xml, parentNode, block);
      if (!created) {
        return {
          kind: 'refused',
          message:
            `Parent control "${spec.parentControl}" is defined by this extension, has no <Controls> ` +
            `collection, and carries no <FormControlExtension> element to position one after — the ` +
            `serializer's property order cannot be reproduced from this file, and guessing risks XML ` +
            `the deserializer rejects.\n\n` +
            `Add the first child in the form designer (it emits <Controls>), then re-run add-control ` +
            `for any further children.`,
        };
      }
      if (spec.previousSibling) {
        notes.push(
          `previousSibling "${spec.previousSibling}" was ignored: "${spec.parentControl}" had no ` +
          `children yet, so the new control is the first one.`,
        );
      }
      return finish(created, spec, 'nested', notes, baseline);
    }

    const updated = insertIntoControls(xml, controls, block, spec.previousSibling, notes);
    return finish(updated, spec, 'nested', notes, baseline);
  }

  // ── Shape 1: parent is a base-form control → envelope in the ROOT Controls ─
  const rootControls = firstChild(root, 'Controls');
  if (!rootControls) return { kind: 'unsupported' };

  // Position among the BASE FORM's children is carried by the envelope itself,
  // via <PositionType>/<PreviousSibling> next to <Parent> — not by where the
  // envelope sits in the extension's root <Controls>. Order in that collection
  // really is irrelevant to layout; the earlier note was right about that and
  // wrong to conclude the request could not be honoured.
  const position = resolvePosition(spec);
  if (position.kind === 'invalid') return { kind: 'refused', message: position.message };
  if (position.note) notes.push(position.note);

  const block = envelopeControlLines(spec, position);
  const updated = insertIntoControls(xml, rootControls, block, undefined, notes);
  return finish(updated, spec, 'envelope', notes, baseline);
}

/**
 * Where the control sits among its parent's existing children, as the two
 * elements the envelope carries for it.
 *
 * Only `AfterItem` and `Begin` appear in shipped metadata (765 and 182
 * occurrences across the 1088 AxFormExtension files in PackagesLocalDirectory;
 * no other value occurs), so those are the two that get written. `End` is
 * spelled by omitting both elements — 1594 shipped envelopes carry no
 * <PositionType> at all — and anything else is refused rather than guessed at,
 * because an unknown enum value is exactly the kind of thing that deserializes
 * to a discarded node under a silent build.
 */
type ResolvedPosition =
  | { kind: 'none'; note?: string }
  | { kind: 'placed'; positionType: 'AfterItem' | 'Begin'; previousSibling?: string; note?: string }
  | { kind: 'invalid'; message: string };

function resolvePosition(spec: FormExtensionControlSpec): ResolvedPosition {
  const requested = spec.positionType?.trim();
  const sibling = spec.previousSibling?.trim() || undefined;

  if (!requested) {
    // previousSibling alone means "after this one" — the only reading that has one.
    return sibling
      ? { kind: 'placed', positionType: 'AfterItem', previousSibling: sibling }
      : { kind: 'none' };
  }

  const normalized = requested.toLowerCase();
  if (normalized === 'afteritem') {
    if (!sibling) {
      return {
        kind: 'invalid',
        message:
          `positionType="AfterItem" needs previousSibling — the name of the existing control in ` +
          `"${spec.parentControl}" to place this one after. Pass previousSibling, or use ` +
          `positionType="Begin" for first / "End" (the default) for last.`,
      };
    }
    return { kind: 'placed', positionType: 'AfterItem', previousSibling: sibling };
  }
  if (normalized === 'begin') {
    return {
      kind: 'placed',
      positionType: 'Begin',
      note: sibling
        ? `previousSibling "${sibling}" was ignored: positionType="Begin" places the control first.`
        : undefined,
    };
  }
  if (normalized === 'end') {
    return {
      kind: 'none',
      note: sibling
        ? `previousSibling "${sibling}" was ignored: positionType="End" places the control last.`
        : undefined,
    };
  }
  return {
    kind: 'invalid',
    message:
      `positionType="${requested}" is not a value D365FO form-extension metadata uses. Supported: ` +
      `"AfterItem" (with previousSibling), "Begin", "End" (default).`,
  };
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
  baseline: Map<string, number>,
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
  const issues = findPlacementIssues(updated, reparsed);
  const after = collectExtensionControls(updated, reparsed, issues.map(i => i.node));
  if (!after.live.has(spec.controlName.toLowerCase())) {
    return {
      kind: 'refused',
      message:
        `Internal check failed: "${spec.controlName}" is not readable as a live control after ` +
        `insertion. The file was left unchanged. Please report this with the extension XML.`,
    };
  }

  // Only problems this write INTRODUCED are the writer's fault. Comparing
  // against the file's own baseline by count (never by line, which insertion
  // shifts) keeps a pre-existing misplacement from vetoing a correct write,
  // while still catching a new duplicate of a problem that already existed.
  const introduced: FormExtPlacementProblem[] = [];
  const remaining = new Map(baseline);
  for (const { problem } of issues) {
    const key = problemKey(problem);
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else introduced.push(problem);
  }

  if (introduced.length > 0) {
    return { kind: 'refused', message: buildAbandonedWriteMessage(updated, spec.controlName, introduced) };
  }
  return { kind: 'inserted', xml: updated, representation, notes };
}

/**
 * The message for output this writer refuses to persist.
 *
 * It takes the DOCUMENT and derives the object name itself rather than accepting
 * a pre-picked string, because picking it at the call site is what went wrong:
 * the control name was passed into a parameter named `objectName`, so the banner
 * read `form-extension "NewCtl"` and never named the file the very next sentence
 * asks the reader to attach. Two names are in play and only one identifies the
 * object; deriving it here leaves the call site nothing to get wrong.
 *
 * Exported for tests. Ordinary input cannot reach it — the writer's output is
 * clean on all 1088 shipped extensions, and escaping closed the one route that
 * made it reachable — so a caller-level test cannot cover it.
 */
export function buildAbandonedWriteMessage(
  xml: string,
  controlName: string,
  introduced: FormExtPlacementProblem[],
): string {
  const root = parseNodes(xml);
  const objectName = root ? extensionNameOf(xml, root) : '(unparseable form extension)';
  return (
    `Internal check failed while adding "${controlName}" — the write was ABANDONED and the ` +
    `file left unchanged.\n\n` +
    buildFormExtensionPlacementError(objectName, introduced) +
    `\n\nThis is a bug in the writer, not in your call. Please report it with the extension XML.`
  );
}

/**
 * Give a childless parent a <Controls> collection holding `blockLines`.
 *
 * Position is not a guess: across the 1088 shipped AxFormExtension files an
 * opening <Controls> is preceded by <FormControlExtension> 2176 times and by
 * <ControlModifications> 996 times (the extension's own root collection) — and
 * by nothing else, ever. So inside a control, <Controls> goes immediately after
 * <FormControlExtension>, ahead of every other derived property regardless of
 * alphabetical order (shipped groups read Controls, ArrangeMethod, FrameType…).
 * Without that anchor element there is no evidence to place it from, and the
 * caller is told so rather than handed a plausible guess.
 */
function createControlsCollection(
  xml: string,
  parentNode: XmlNode,
  blockLines: string[],
): string | null {
  const anchor = firstChild(parentNode, 'FormControlExtension');
  if (!anchor) return null;

  const controlsIndent = lineIndentOf(xml, anchor.start);
  const block = indentBlock(blockLines, controlsIndent + '\t');
  const collection =
    '\n' + controlsIndent + '<Controls>\n' + block + '\n' + controlsIndent + '</Controls>';

  return xml.slice(0, anchor.end) + collection + xml.slice(anchor.end);
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
    `field group AS WELL — d365fo_file(action="modify", objectType="table-extension", ` +
    `operations=[{operation:"add-field-to-field-group", fieldGroupName:"${dataGroup}", ` +
    `fieldName:"${field}", extendBaseFieldGroup:true}]) — and keep this control, named ` +
    `\`${generated}\`, so the two agree.\n` +
    `  • The field group alone is NOT enough here: this parent belongs to the form EXTENSION, and only ` +
    `a BASE-FORM <DataGroup> group auto-generates its missing members. Both halves are required — the ` +
    `field group entry so a Refresh keeps the control, and the explicit control so the field renders.`
  );
}

/**
 * Escape a value on its way into element text.
 *
 * Every value below is interpolated into markup, and none of them were escaped:
 * a label reading "Cost & freight" produced XML with a bare & in it, which is
 * not well-formed and which the D365FO deserializer rejects. Object names cannot
 * carry markup, so the exposure was narrow, but "the input cannot be hostile" is
 * not a property this module can check — and the post-write guard catching the
 * damage afterwards is a worse answer than not causing it.
 *
 * `&` first: escaping it after the others would double-escape their output.
 */
const escapeXmlText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** As above, plus the quote that would otherwise close the attribute early. */
const escapeXmlAttr = (value: string): string =>
  escapeXmlText(value).replace(/"/g, '&quot;');

/** The bare nested shape — no wrapper, no <Parent>; nesting encodes parentage. */
function nestedControlLines(spec: FormExtensionControlSpec): string[] {
  return [
    `<AxFormControl xmlns="" i:type="${escapeXmlAttr(spec.iType)}">`,
    ...innerControlLines(spec).map(l => `\t${l}`),
    `</AxFormControl>`,
  ];
}

/**
 * The envelope shape — wrapper <Name>, the control under <FormControl>, then
 * <Parent>, then the optional position pair, in exactly the order shipped
 * metadata uses (`Name, FormControl, Parent, PositionType, PreviousSibling` —
 * 753 files, with the shorter prefixes accounting for the rest).
 */
function envelopeControlLines(
  spec: FormExtensionControlSpec,
  position: ResolvedPosition,
): string[] {
  const lines = [
    `<AxFormExtensionControl xmlns="">`,
    `\t<Name>${escapeXmlText(spec.wrapperName)}</Name>`,
    `\t<FormControl xmlns="" i:type="${escapeXmlAttr(spec.iType)}">`,
    ...innerControlLines(spec).map(l => `\t\t${l}`),
    `\t</FormControl>`,
    `\t<Parent>${escapeXmlText(spec.parentControl)}</Parent>`,
  ];
  if (position.kind === 'placed') {
    // positionType is one of two literals this module chose, never caller text.
    lines.push(`\t<PositionType>${position.positionType}</PositionType>`);
    if (position.previousSibling) {
      lines.push(`\t<PreviousSibling>${escapeXmlText(position.previousSibling)}</PreviousSibling>`);
    }
  }
  lines.push(`</AxFormExtensionControl>`);
  return lines;
}

/**
 * Control body, in the order the D365FO SDK serializes it:
 * Name → Type → FormControlExtension(nil) → DataField → DataSource → Label → [Items].
 */
function innerControlLines(spec: FormExtensionControlSpec): string[] {
  const lines = [
    `<Name>${escapeXmlText(spec.controlName)}</Name>`,
    `<Type>${escapeXmlText(spec.typeValue)}</Type>`,
    `<FormControlExtension i:nil="true" />`,
  ];
  if (spec.dataField) lines.push(`<DataField>${escapeXmlText(spec.dataField)}</DataField>`);
  if (spec.dataSource) lines.push(`<DataSource>${escapeXmlText(spec.dataSource)}</DataSource>`);
  if (spec.label) lines.push(`<Label>${escapeXmlText(spec.label)}</Label>`);
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
      return nameNode && textValueOf(xml, nameNode).toLowerCase() === previousSibling.toLowerCase();
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
