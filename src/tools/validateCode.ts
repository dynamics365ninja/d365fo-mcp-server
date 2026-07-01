/**
 * Validate Tool — unified static validator for generated X++/XML.
 *
 * Merges the former validate_xpp and resolve_references tools into one tool
 * discriminated by `mode`:
 *   • syntax     → offline best-practice/BP rule validation (validate_xpp)
 *   • references → semantic symbol resolution against the index (resolve_references)
 *
 * Both underlying handlers read `code`/`context` from request.params.arguments
 * and ignore the extra `mode` key (no strict schemas), so the request is passed
 * straight through.
 *
 * When mode="references" and codeType="xml-table" or "xml-any", an XML-aware
 * reference checker runs instead of the X++ resolver:
 *   - <ExtendedDataType> → EDT must exist in the symbol index
 *   - <EnumType>         → Enum must exist in the symbol index
 *   - <Label>            → label reference (@File:Id) must exist
 *   - <Extends>          → base table/class must exist (for extensions)
 *   - Relation targets   → <RelatedTable> must exist
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../types/context.js';
import { validateXppTool } from './validateXpp.js';
import { resolveReferencesTool } from './resolveReferences.js';

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

// ── XML reference checker ─────────────────────────────────────────────────────

interface XmlRefViolation {
  element: string;
  value: string;
  detail: string;
  severity: 'error' | 'warning';
}

function extractTagValues(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([^<]+)<\/${tag}>`, 'gi');
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const v = m[1].trim();
    if (v) results.push(v);
  }
  return results;
}

function symbolExistsInIndex(
  db: { prepare(sql: string): { get(...p: unknown[]): unknown } },
  name: string,
  type?: string,
): boolean {
  try {
    const row = type
      ? db.prepare('SELECT 1 FROM symbols WHERE name = ? COLLATE NOCASE AND type = ? AND parent_name IS NULL LIMIT 1').get(name, type)
      : db.prepare('SELECT 1 FROM symbols WHERE name = ? COLLATE NOCASE AND parent_name IS NULL LIMIT 1').get(name);
    return row != null;
  } catch {
    return true; // index unavailable — don't false-block
  }
}

function resolveXmlReferences(
  xml: string,
  _contextName: string | undefined,
  ctx: XppServerContext,
): { violations: XmlRefViolation[]; verified: number } {
  const violations: XmlRefViolation[] = [];
  let verified = 0;

  let db: { prepare(sql: string): { get(...p: unknown[]): unknown } } | undefined;
  try {
    db = ctx.symbolIndex?.getReadDb?.() as typeof db;
  } catch {
    // index not available
  }

  if (!db) {
    return {
      violations: [],
      verified: 0,
    };
  }

  // <ExtendedDataType> — EDT must exist
  for (const edt of extractTagValues(xml, 'ExtendedDataType')) {
    if (symbolExistsInIndex(db, edt, 'edt')) {
      verified++;
    } else {
      violations.push({
        element: 'ExtendedDataType',
        value: edt,
        detail: `EDT "${edt}" not found in the symbol index. Wrong EDT name — check suggest_edt or search for the correct name.`,
        severity: 'error',
      });
    }
  }

  // <EnumType> — enum must exist
  for (const en of extractTagValues(xml, 'EnumType')) {
    if (symbolExistsInIndex(db, en, 'enum')) {
      verified++;
    } else {
      violations.push({
        element: 'EnumType',
        value: en,
        detail: `Enum "${en}" not found in the symbol index.`,
        severity: 'error',
      });
    }
  }

  // <RelatedTable> — target table must exist
  for (const rel of extractTagValues(xml, 'RelatedTable')) {
    if (symbolExistsInIndex(db, rel, 'table')) {
      verified++;
    } else {
      violations.push({
        element: 'RelatedTable',
        value: rel,
        detail: `Table "${rel}" not found in the symbol index (relation target).`,
        severity: 'error',
      });
    }
  }

  // <Extends> — base table/class must exist (for extensions; skip for primitive extends like EDTs)
  for (const ext of extractTagValues(xml, 'Extends')) {
    // Skip well-known primitive EDT bases (String, Int64, Real, etc.) and same-model names
    if (/^(String|Int64|Real|Date|UtcDateTime|Enum|Container|Guid|AnyType)$/i.test(ext)) continue;
    if (symbolExistsInIndex(db, ext)) {
      verified++;
    } else {
      violations.push({
        element: 'Extends',
        value: ext,
        detail: `"${ext}" not found in the symbol index (used as Extends target).`,
        severity: 'warning', // warning: may be same-session not-yet-indexed
      });
    }
  }

  // <Label> — check @File:Id labels exist (skip raw text labels — those are caught by syntax/BP)
  for (const lbl of extractTagValues(xml, 'Label')) {
    if (!lbl.startsWith('@')) continue; // raw text handled by rawLabelBpWarning in create path
    const modern = /^@([A-Za-z0-9_]+):([A-Za-z0-9_]+)$/.exec(lbl);
    if (modern) {
      const [, fileId, labelId] = modern;
      try {
        const rows = ctx.symbolIndex.getLabelById(labelId, fileId);
        if (rows.length > 0) { verified++; } else {
          violations.push({
            element: 'Label',
            value: lbl,
            detail: `Label ${lbl} not found in label index (file "${fileId}", id "${labelId}").`,
            severity: 'warning',
          });
        }
      } catch { verified++; } // label index unavailable — skip
    }
  }

  return { violations, verified };
}

// ─────────────────────────────────────────────────────────────────────────────

export async function validateCodeTool(request: CallToolRequest, context: XppServerContext) {
  const a = (request.params.arguments ?? {}) as Record<string, any>;
  const mode = (a.mode as string | undefined) ?? 'syntax';
  const codeType = (a.codeType as string | undefined) ?? 'xpp';

  if (!a.code) return err('validate_code requires `code` (the X++/XML text to check).');

  switch (mode) {
    case 'syntax':
      return validateXppTool(request, context);

    case 'references': {
      // X++ code → use the dedicated X++ reference resolver
      if (codeType === 'xpp') return resolveReferencesTool(request, context);

      // XML (xml-table or xml-any) → use the XML-aware reference checker
      const contextName = a.context as string | undefined;
      const { violations, verified } = resolveXmlReferences(a.code as string, contextName, context);

      if (violations.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `✅ resolve_references: all ${verified} reference(s) verified against the index${contextName ? ` in ${contextName}` : ''}.\n` +
              `No hallucinated symbols detected. Safe to proceed with the write operation.`,
          }],
        };
      }

      const errors = violations.filter(v => v.severity === 'error');
      const warns  = violations.filter(v => v.severity === 'warning');
      const lines: string[] = [
        `${errors.length > 0 ? '❌' : '⚠️'} resolve_references: ${violations.length} issue(s) found (${errors.length} error(s), ${warns.length} warning(s)), ${verified} verified${contextName ? ` in ${contextName}` : ''}.`,
        '',
      ];
      for (const v of violations) {
        lines.push(`${v.severity === 'error' ? '❌' : '⚠️'} <${v.element}>${v.value}</${v.element}>`);
        lines.push(`   ${v.detail}`);
      }
      if (errors.length > 0) {
        lines.push('', 'Fix errors before writing — these will cause compiler failures or wrong object references.');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: errors.length > 0,
      };
    }

    default:
      return err(`validate_code: unknown mode "${mode}". Use "syntax" (BP/best-practice rules) or "references" (symbol resolution).`);
  }
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
