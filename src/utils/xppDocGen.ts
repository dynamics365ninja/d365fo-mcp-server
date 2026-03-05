/**
 * X++ XML documentation comment generator.
 *
 * D365FO best practice: every public and protected method must be documented
 * with /// <summary>, /// <param name="…"> and /// <returns> blocks.
 *
 * This module auto-generates those comments when they are absent so that
 * generated AX object XML always conforms to the standard.
 */

/** Access modifiers and non-type keywords that are NOT part of the return type. */
const XPP_MODIFIERS = new Set([
  'public', 'protected', 'private',
  'static', 'final', 'abstract', 'virtual', 'override',
  'internal', 'server', 'client', 'display', 'edit', 'new',
]);

/**
 * Parses an X++ method or class-declaration signature line.
 * Returns null when the line cannot be parsed or represents a private/internal member.
 */
function parseSig(sigLine: string): {
  isClass: boolean;
  name: string;
  returnType: string;
  params: Array<{ type: string; name: string }>;
} | null {
  const isPublic    = /\bpublic\b/.test(sigLine);
  const isProtected = /\bprotected\b/.test(sigLine);
  if (!isPublic && !isProtected) return null;

  const hasParens = sigLine.includes('(');

  // ── Class / struct declaration ────────────────────────────────────────────
  if (!hasParens) {
    const classMatch = sigLine.match(/\bclass\s+(\w+)/);
    if (!classMatch) return null;
    return { isClass: true, name: classMatch[1], returnType: '', params: [] };
  }

  // ── Method signature ──────────────────────────────────────────────────────
  const parenIdx    = sigLine.indexOf('(');
  const beforeParen = sigLine.substring(0, parenIdx).trim();
  const tokens      = beforeParen.split(/\s+/).filter(Boolean);
  const methodName  = tokens[tokens.length - 1] ?? '';
  const typeTokens  = tokens.filter(t => !XPP_MODIFIERS.has(t));
  // typeTokens: [ReturnType, methodName] — second-to-last is return type
  const returnType  = typeTokens.length >= 2 ? typeTokens[typeTokens.length - 2] : '';

  // ── Parameters ────────────────────────────────────────────────────────────
  const closeIdx = sigLine.lastIndexOf(')');
  const paramStr  = closeIdx > parenIdx
    ? sigLine.substring(parenIdx + 1, closeIdx).trim()
    : '';

  const params: Array<{ type: string; name: string }> = [];
  if (paramStr) {
    for (const chunk of paramStr.split(',')) {
      // Strip default value: "TransDate _fromDate = dateNull()" → ["TransDate", "_fromDate"]
      const eqIdx = chunk.indexOf('=');
      const parts = (eqIdx !== -1 ? chunk.substring(0, eqIdx) : chunk)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (parts.length >= 2) {
        params.push({ type: parts[0], name: parts[parts.length - 1] });
      } else if (parts.length === 1 && parts[0]) {
        params.push({ type: '', name: parts[0] });
      }
    }
  }

  return { isClass: false, name: methodName, returnType, params };
}

/**
 * Ensures every public or protected X++ method / class declaration has a
 * leading XML doc-comment block (/// <summary> … </summary>).
 *
 * Idempotent — if `/// <summary>` is already present the source is returned
 * unchanged. Private / internal methods are left as-is per D365FO convention.
 */
export function ensureXppDocComment(source: string): string {
  // Strip leading blank lines — prevents gap at top of <Declaration>
  const cleanSource = source.replace(/^\n+/, '');
  const lines = cleanSource.split('\n');

  // Already documented?
  const firstNonEmpty = lines.find(l => l.trim().length > 0);
  if (firstNonEmpty?.trim().startsWith('///')) {
    // Remove blank lines between /// doc-comment block and the next code line
    return stripDocCommentGap(cleanSource);
  }

  // Find the first "real" signature line (skip blanks, doc comments, attributes)
  let sigLine = '';
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('[')) {
      continue;
    }
    sigLine = t;
    break;
  }
  if (!sigLine) return cleanSource;

  const parsed = parseSig(sigLine);
  if (!parsed) return cleanSource;

  // Detect indentation from the signature line so doc comments align with the code
  const sigLineRaw = lines.find(l => l.trim() === sigLine) ?? '';
  const indent     = sigLineRaw.match(/^(\s*)/)?.[1] ?? '';

  // ── Build doc block ───────────────────────────────────────────────────────
  const doc: string[] = [];

  if (parsed.isClass) {
    doc.push(`${indent}/// <summary>`);
    doc.push(`${indent}/// ${parsed.name} class.`);
    doc.push(`${indent}/// </summary>`);
  } else {
    doc.push(`${indent}/// <summary>`);
    doc.push(`${indent}/// ${parsed.name}.`);
    doc.push(`${indent}/// </summary>`);
    for (const param of parsed.params) {
      doc.push(`${indent}/// <param name="${param.name}">${param.type ? param.type + '.' : ''}</param>`);
    }
    if (parsed.returnType && parsed.returnType !== 'void') {
      doc.push(`${indent}/// <returns>${parsed.returnType}.</returns>`);
    }
  }

  return doc.join('\n') + '\n' + cleanSource;
}

/**
 * Remove blank lines between the last /// doc-comment line and the next
 * non-blank code line (attribute or class/method keyword).
 *
 * D365FO convention: no gap between doc block and the declaration it documents.
 */
function stripDocCommentGap(source: string): string {
  // Match a /// line followed by one or more blank lines, then a non-blank line
  return source.replace(/(\/\/\/[^\n]*\n)(\s*\n)+(?=\s*\S)/g, '$1');
}
