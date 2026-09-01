/**
 * AxForm element-order check.
 *
 * AOT metadata XML is order-sensitive, and NOTHING says so when you get it wrong:
 * the metadata deserializer skips an element that arrives out of sequence and
 * carries on. The file keeps the text; the platform never sees it.
 *
 * How that presented (issue #979): the SimpleListDetails scaffold wrote
 *
 *     <Name>Overview</Name>
 *     <Type>Group</Type>
 *     <DataGroup>Overview</DataGroup>      ← both of these belong AFTER <Controls>
 *     <DataSource>MyTable</DataSource>
 *     <FormControlExtension i:nil="true" />
 *     <Controls> …two child controls… </Controls>
 *
 * and the C# bridge — reading through the same IMetadataProvider the compiler
 * uses — reported that group with NO children and the form with 14 controls
 * where the file held 16. Moving the two lines below `</Controls>` (the order
 * every shipped form uses) made all 16 appear. The reader had been telling the
 * truth the whole time; the writer was dropping controls on the floor.
 *
 * The canonical order per control type is not asserted here — it is mined from
 * shipped metadata by scripts/capture-form-element-order.ts. This module only
 * compares a document against that census.
 *
 * Deliberately text-based: every XML object model this repo parses with
 * (`explicitArray: false`, `mergeAttrs`) discards sibling order, which is the
 * one property being checked.
 */
import { createXmlTokenScanner } from '../utils/xmlScan.js';
import { FORM_CONTROL_ELEMENT_ORDER } from './formControlElementOrder.generated.js';

export interface ElementOrderViolation {
  /** i:type of the control whose children are out of order. */
  controlType: string;
  /** `<Name>` of that control, or '(unnamed)'. */
  controlName: string;
  /** The element that appears too early. */
  element: string;
  /**
   * The element it wrongly precedes, or `null` for an `unknown` violation —
   * one this control type carries nowhere in the census.
   */
  beforeElement: string | null;
  /**
   * `order`  — the element is ranked for this type but written too early.
   * `unknown`— the element was never seen on this type in 25k shipped controls,
   *            which in practice means the type does not have that property and
   *            the platform will ignore it. Reported separately because "never
   *            observed" is weaker evidence than "observed in the other order".
   */
  kind: 'order' | 'unknown';
  /** 1-based line of `element` in the document, for a clickable message. */
  line: number;
}

const ITYPE = /i:type="([^"]+)"/;

interface Frame {
  tag: string;
  itype: string | null;
  /** Direct children, in document order, with the offset each was seen at. */
  children: Array<{ name: string; index: number }>;
  /** Offset just past this element's opening tag, for reading its text. */
  contentStart: number;
  /** The control's own `<Name>` text, filled in when that child closes. */
  nameValue?: string;
}

/**
 * How many `<AxFormControl>` elements a form document actually contains.
 *
 * Uses the shared token scanner, so a control written inside an XML COMMENT (the
 * Workspace pattern template ships two such examples) is not counted as a real
 * one. Lives here rather than beside its first caller because the number is now
 * used to answer two different questions: what the scaffold wrote, and whether
 * the document disagrees with what the metadata provider can see.
 */
export function countFormControls(xml: string): number {
  const scanner = createXmlTokenScanner();
  let count = 0;
  let token: RegExpExecArray | null;
  while ((token = scanner.exec(xml)) !== null) {
    if (token[2] === 'AxFormControl') count++;
  }
  return count;
}

/**
 * Every place a form control writes a child element earlier than the canonical
 * order for its `i:type` allows.
 *
 * Only elements the census actually observed for that type are ranked; anything
 * else (a property no shipped form of that type carries, or an unknown control
 * type) is skipped rather than guessed at — the point is to catch a KNOWN
 * mis-ordering, never to invent one.
 *
 * Reports the first offending pair per element so one displaced line yields one
 * finding, not one per element it jumped over.
 */
export function findControlElementOrderViolations(xml: string): ElementOrderViolation[] {
  const violations: ElementOrderViolation[] = [];
  const stack: Frame[] = [];

  // Offset → line number, computed once for the offsets we actually report.
  const lineAt = (offset: number): number => {
    let line = 1;
    for (let i = 0; i < offset && i < xml.length; i++) if (xml.charCodeAt(i) === 10) line++;
    return line;
  };

  // The shared token scanner, so a control example written inside an XML COMMENT
  // (the Workspace template ships one) is skipped whole instead of opening a
  // frame that never closes — see src/utils/xmlScan.ts for why this repo does
  // not strip comments before matching.
  const scanner = createXmlTokenScanner();
  let m: RegExpExecArray | null;
  while ((m = scanner.exec(xml)) !== null) {
    const closing = m[1];
    const starting = m[2];
    const attrs = m[3] ?? '';
    const isSelfClosing = m[4] === '/';

    if (closing) {
      const top = stack[stack.length - 1];
      if (!top || top.tag !== closing) continue;
      stack.pop();
      const parent = stack[stack.length - 1];
      if (top.tag === 'Name' && parent?.tag === 'AxFormControl' && parent.nameValue === undefined) {
        parent.nameValue = xml.slice(top.contentStart, m.index).trim();
      }
      if (top.tag === 'AxFormControl' && top.itype) checkFrame(top, violations, lineAt);
      continue;
    }

    if (!starting) continue; // comment / CDATA / PI / doctype — consumed whole

    if (stack.length > 0) stack[stack.length - 1].children.push({ name: starting, index: m.index });

    if (!isSelfClosing) {
      const itype = starting === 'AxFormControl' ? (ITYPE.exec(attrs)?.[1] ?? null) : null;
      stack.push({ tag: starting, itype, children: [], contentStart: m.index + m[0].length });
    }
  }

  return violations;
}

function checkFrame(
  frame: Frame,
  out: ElementOrderViolation[],
  lineAt: (offset: number) => number,
): void {
  const canonical = FORM_CONTROL_ELEMENT_ORDER[frame.itype!];
  if (!canonical) return;

  const rank = new Map<string, number>();
  canonical.forEach((el, i) => rank.set(el, i));

  const controlName = frame.nameValue || '(unnamed)';

  const seen: Array<{ name: string; rank: number; index: number }> = [];
  for (const child of frame.children) {
    const r = rank.get(child.name);
    if (r === undefined) {
      out.push({
        controlType: frame.itype!,
        controlName,
        element: child.name,
        beforeElement: null,
        kind: 'unknown',
        line: lineAt(child.index),
      });
      continue;
    }
    // Report against the LAST already-seen element this one should have followed.
    for (let i = seen.length - 1; i >= 0; i--) {
      if (seen[i].rank > r) {
        out.push({
          controlType: frame.itype!,
          controlName,
          element: child.name,
          beforeElement: seen[i].name,
          kind: 'order',
          line: lineAt(child.index),
        });
        break;
      }
    }
    seen.push({ name: child.name, rank: r, index: child.index });
  }
}

/**
 * A one-line-per-finding message block for a tool response, or '' when clean.
 */
export function formatElementOrderViolations(violations: ElementOrderViolation[]): string {
  if (violations.length === 0) return '';
  return violations
    .map((v) =>
      v.kind === 'order'
        ? `🔴 [ORDER] ${v.controlType} "${v.controlName}" line ${v.line}: ` +
          `<${v.element}> must come AFTER <${v.beforeElement}> — ` +
          `the metadata deserializer drops out-of-order elements silently.`
        : `🟠 [UNKNOWN] ${v.controlType} "${v.controlName}" line ${v.line}: ` +
          `<${v.element}> appears on no ${v.controlType} in shipped metadata — ` +
          `the type most likely has no such property, and the platform will ignore it.`,
    )
    .join('\n');
}
