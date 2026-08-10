/**
 * Run the offline X++ rule set on the source a write is carrying, inside the
 * write itself.
 *
 * The rules (COC001-005, BP001-005, SEL*, TTS001) already existed — but only
 * behind the `validate_code` tool, i.e. only when the agent thought to ask. In
 * run a5677c99 it never did: `d365fo_file(action="create")` happily wrote a CoC
 * wrapper calling `this.checkFailed(...)`, run_bp_check reported it clean (xppbp
 * does not diagnose ClassDoesNotContainMethod), and the mistake only surfaced
 * 211 seconds later as a failed build — then cost thirteen turns to walk back.
 *
 * Every one of those rules is pure string analysis over source we are holding
 * anyway, so there is no reason to charge a round trip for them. This module
 * runs them on the caller's own text and folds the result into the write's
 * reply.
 *
 * Advisory, not blocking. A rule that refuses a write has to be right every
 * time; a rule that annotates one only has to be useful, and the agent fixes it
 * in the same turn either way. `buildMarker` made the same call for the same
 * reason.
 */

import { runRules, type ValidationViolation } from '../analysis/validateXpp.js';
import { decodeXmlEntitiesFromXppSource } from '../../utils/xmlEscape.js';

/** Lines prepended by `withClassContext`; subtracted again before reporting. */
const SYNTHETIC_HEADER_LINES = 3;

/**
 * Pull the `<Declaration>` block out of an AOT class/table XML.
 *
 * Only the declaration — not the methods. The point is to learn what the
 * enclosing class IS (`[ExtensionOf(tableStr(...))]`, `final`, its name), never
 * to validate code the caller did not write in this call. Flagging a
 * pre-existing violation in some other method would train the agent to ignore
 * the whole block.
 */
export function extractDeclaration(xml: string): string | null {
  const m = /<Declaration>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/Declaration>/.exec(xml);
  if (!m) return null;
  const decl = decodeXmlEntitiesFromXppSource(m[1]).trim();
  return decl.length > 0 ? decl : null;
}

/**
 * Wrap a bare method/snippet in the class header it will actually live under, so
 * the class-scoped rules can see their context.
 *
 * COC004 walks brace depth to find method boundaries and COC005 gates on
 * `[ExtensionOf(tableStr(...))]` — hand either of them a naked method body and
 * they correctly find nothing. The on-disk declaration carries an empty `{}`
 * body (AOT XML keeps methods in their own elements), so it cannot be prepended
 * verbatim; a header of the same shape is synthesised instead.
 */
function withClassContext(snippet: string, declaration: string | null): { code: string; offset: number } {
  if (!declaration) return { code: snippet, offset: 0 };
  // Already a whole class (the create path passes one) — nothing to add.
  if (/\bclass\s+\w+/i.test(snippet)) return { code: snippet, offset: 0 };

  const extensionOf = /^\s*\[ExtensionOf\s*\([^\]]*\)\]/im.exec(declaration);
  const className = /\bclass\s+(\w+)/i.exec(declaration);
  if (!extensionOf || !className) return { code: snippet, offset: 0 };

  return {
    code: `${extensionOf[0].trim()}\nfinal class ${className[1]}\n{\n${snippet}\n}`,
    offset: SYNTHETIC_HEADER_LINES,
  };
}

/** True for text that is a JSON document rather than X++. */
function isJson(source: string): boolean {
  if (!/^\s*[[{]/.test(source)) return false;
  try {
    const parsed = JSON.parse(source);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

/** Violations rendered as the note that rides along with a write's reply. */
function render(violations: ValidationViolation[]): string {
  if (violations.length === 0) return '';

  const errors = violations.filter(v => v.severity === 'error');
  const warnings = violations.filter(v => v.severity === 'warning');

  const lines: string[] = [''];
  lines.push(
    errors.length > 0
      ? `❌ X++ validation of the source just written — ${errors.length} error(s)` +
        (warnings.length > 0 ? `, ${warnings.length} warning(s)` : '') +
        '. The file IS on disk; these will fail the build.'
      : `⚠️ X++ validation of the source just written — ${warnings.length} warning(s).`,
  );
  for (const v of violations) {
    const icon = v.severity === 'error' ? '🔴' : '🟡';
    const where = v.line ? ` (line ${v.line} of the code you sent)` : '';
    lines.push(`${icon} [${v.rule}]${where} \`${v.excerpt}\``);
    lines.push(`   ${v.fix}`);
  }
  if (errors.length > 0) {
    lines.push(
      '➡️  Fix these with d365fo_file(action="modify") BEFORE build_d365fo_project — ' +
      'a full build costs minutes and will only tell you the same thing.',
    );
  }
  return `\n${lines.join('\n')}`;
}

/**
 * Validate the X++ a write is carrying.
 *
 * @param suppliedSource  the caller's own text (sourceCode / methodCode / newCode).
 *                        Nothing else is inspected — never the rest of the file.
 * @param declarationXml  raw XML of the target object, when the write has one on
 *                        disk; used only to recover the enclosing class header.
 * @returns a markdown note to append to the write's reply, or '' when clean.
 */
export function validateWrittenXpp(
  suppliedSource: string | undefined,
  declarationXml?: string | null,
): string {
  if (!suppliedSource || suppliedSource.trim().length === 0) return '';
  // XML markup handed in as "X++" is somebody else's bug (assertCleanXppSource
  // catches it upstream); do not add a second, more confusing report of it.
  if (/^\s*</.test(suppliedSource)) return '';
  // A table create carries its field definitions as JSON in the same argument.
  // Sniffed by parsing, not by the first character: every CoC class begins with
  // `[ExtensionOf(...)]`, so a bare bracket test would silently exempt exactly the
  // source these rules exist for.
  if (isJson(suppliedSource)) return '';

  const declaration = declarationXml ? extractDeclaration(declarationXml) : null;
  const { code, offset } = withClassContext(suppliedSource, declaration);

  let violations: ValidationViolation[];
  try {
    violations = runRules(code, 'xpp');
  } catch {
    // A lint must never be the reason a successful write reports failure.
    return '';
  }

  const rebased = violations
    .map(v => (v.line === undefined ? v : { ...v, line: v.line - offset }))
    // A violation inside the synthetic header is the header's, not the caller's.
    .filter(v => v.line === undefined || v.line > 0);

  return render(rebased);
}
