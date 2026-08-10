/**
 * Run the offline X++ rules (COC*, BP*, SEL*, TTS001) on the source a write is
 * carrying, so they no longer depend on the caller thinking to call
 * validate_code. Pure string analysis over text we already hold.
 *
 * Advisory, not blocking: a rule that refuses a write has to be right every
 * time, one that annotates it only has to be useful.
 */

import { runRules, type ValidationViolation } from '../analysis/validateXpp.js';
import { decodeXmlEntitiesFromXppSource } from '../../utils/xmlEscape.js';

/** Lines prepended by `withClassContext`; subtracted again before reporting. */
const SYNTHETIC_HEADER_LINES = 3;

/**
 * Pull the `<Declaration>` out of an AOT class/table XML — never the methods:
 * only code the caller sent in this call is validated.
 */
export function extractDeclaration(xml: string): string | null {
  const m = /<Declaration>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/Declaration>/.exec(xml);
  if (!m) return null;
  const decl = decodeXmlEntitiesFromXppSource(m[1]).trim();
  return decl.length > 0 ? decl : null;
}

/**
 * Wrap a bare snippet in its class header so COC004/COC005 can see the context
 * they gate on. The on-disk declaration has an empty `{}` body, so an
 * equivalent header is synthesised rather than prepended verbatim.
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
  // XML as "X++" is reported upstream by assertCleanXppSource.
  if (/^\s*</.test(suppliedSource)) return '';
  // A table create passes field definitions as JSON here. Sniffed by parsing:
  // a bare `[` test would exempt every `[ExtensionOf(...)]` class.
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
