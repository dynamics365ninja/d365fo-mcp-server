/**
 * One object, one name — checked before the bytes reach disk.
 *
 * An AOT object states its identity three times: the FILE NAME, the root
 * `<Name>` element, and (for the types that carry X++) the class declaration
 * inside `<Declaration>`. xppc requires all three to agree — "must be named X
 * instead of Y to be consistent with its file name" — and it says so at BUILD
 * time, one round trip after the write reported ✅.
 *
 * The 2026-08-31 capture run of L2-event-handler-basic produced exactly that:
 * `create(class, objectName:"EvalL2…Test", xmlContent:<verbatim AxClass XML>)`
 * wrote `ConDemoEvalL2…Test.xml` containing `class ConDemoEvalL2…Test` and
 * `<Name>EvalL2…Test</Name>` — three identities, two of them prefixed, one not.
 * The create path rewrote the X++ declaration (and `classnum`/`classStr`) when it
 * applied the model prefix, but never the metadata `<Name>`, and the write
 * verification only asked whether a file existed. So the defect was invisible
 * until the next build died.
 *
 * Two rules, in this order:
 *   1. REWRITE what can be rewritten — the root `<Name>`, alongside the prefix
 *      rewrite the create path already does for the declaration.
 *   2. REFUSE what is left. A file whose identities disagree does not build, so
 *      writing it and reporting success is strictly worse than not writing it:
 *      the caller pays a build cycle to learn what this check knows for free.
 *
 * Extension objects are named `Base.Suffix` in metadata while their X++ says
 * `class Base_Extension`, so the declaration half is skipped for any dotted
 * name — comparing those two would refuse every correct extension.
 */

import { firstLeafText } from '../../utils/xmlScan.js';
import { maskXpp } from '../../utils/xppLexer.js';

/**
 * The root element's own `<Name>`, or null.
 *
 * A CHILD OF THE ROOT, specifically — not "the first `<Name>` in the file". A
 * field, a control or a method carries a `<Name>` too, and a commented-out
 * example carries one that is not an identity at all. scanXmlLeaves answers the
 * structural question directly instead of deleting the parts of the document
 * that would otherwise confuse a regex; see xmlScan.ts for why the deleting
 * version is a bug and not just a lint finding.
 */
export function readRootObjectName(xml: string): string | null {
  return firstLeafText(xml, 'Name')?.trim() || null;
}

/**
 * The class/interface name the X++ `<Declaration>` block declares, or null when
 * the document carries no declaration (a table extension, a form, an enum).
 *
 * Read through the shared lexer, not off the raw text. Every generated class
 * opens with a `///` block, and "Provides my new class MyNewClass functionality"
 * contains the word `class` — matching that as a declaration made this gate
 * refuse perfectly good creates on its first full-suite run. maskXpp blanks
 * comment and string CONTENT while preserving offsets, so the match runs over
 * code only and its offset still points into the original source.
 */
export function readDeclarationName(xml: string): string | null {
  const decl = /<Declaration>([\s\S]*?)<\/Declaration>/.exec(xml)?.[1];
  if (!decl) return null;
  const source = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(decl)?.[1] ?? decl;
  const m = /\b(?:public\s+|private\s+|protected\s+|internal\s+|final\s+|abstract\s+|static\s+)*(?:class|interface)\s+([A-Za-z_]\w*)/
    .exec(maskXpp(source));
  if (!m) return null;
  // Read the name back out of the ORIGINAL text at the same offset: the mask
  // keeps positions, and a name the mask blanked would have been inside a
  // comment, which is exactly the case this rules out.
  const at = m.index + m[0].length - m[1].length;
  return source.slice(at, at + m[1].length);
}

/**
 * Rewrite the root `<Name>` from one identity to another. Only the root element
 * is touched: a field or control that happens to share the object's name keeps
 * its own name, which is why this replaces one occurrence and not all of them.
 */
export function rewriteRootObjectName(xml: string, from: string, to: string): string {
  if (from === to) return xml;
  const current = readRootObjectName(xml);
  if (current !== from) return xml;
  return xml.replace(`<Name>${from}</Name>`, `<Name>${to}</Name>`);
}

export interface IdentityProblem {
  /** Where the disagreeing identity lives. */
  where: 'root-name' | 'declaration';
  found: string;
}

/**
 * Compare the identities inside the document against the name the object is
 * being written under. An empty array means all of them agree.
 */
export function checkObjectIdentity(xml: string, expectedName: string): IdentityProblem[] {
  const problems: IdentityProblem[] = [];
  const rootName = readRootObjectName(xml);
  if (rootName && rootName !== expectedName) {
    problems.push({ where: 'root-name', found: rootName });
  }
  // `Base.Suffix` in metadata is `Base_Extension` in X++ — a legal disagreement.
  if (!expectedName.includes('.')) {
    const declName = readDeclarationName(xml);
    if (declName && declName !== expectedName) {
      problems.push({ where: 'declaration', found: declName });
    }
  }
  return problems;
}

/** The refusal an identity mismatch earns, written so the caller can act on it. */
export function renderIdentityRefusal(
  objectType: string,
  expectedName: string,
  fileName: string,
  problems: readonly IdentityProblem[],
): string {
  const lines = problems.map(p =>
    p.where === 'root-name'
      ? `  • <Name> says "${p.found}"`
      : `  • the X++ declaration says "class ${p.found}"`,
  );
  // The name out of the document is UNTRUSTED text — it is whatever the caller's
  // xmlContent said. Only a legal AOT identifier is echoed back as a ready-to-run
  // objectName= argument; anything else is described, never quoted into a call
  // the reader might paste (CodeQL js/incomplete-html-attribute-sanitization).
  const found = problems[0]?.found ?? '';
  const suggestion = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(found)
    ? `, or pass objectName="${found}" and let the tool apply the model prefix itself ` +
      `(never hand-build the prefix)`
    : ` (the name the document carries is not a legal AOT identifier, so there is nothing ` +
      `to pass as objectName)`;
  return (
    `❌ create ${objectType} "${expectedName}": the object would state two different identities and ` +
    `nothing was written.\n` +
    `  • the file would be ${fileName}\n` +
    lines.join('\n') + '\n\n' +
    `xppc refuses that at build time ("must be named ... to be consistent with its file name"), so the ` +
    `write is refused here instead — a build cycle earlier.\n` +
    `Fix the xmlContent to use "${expectedName}" throughout${suggestion}.`
  );
}
