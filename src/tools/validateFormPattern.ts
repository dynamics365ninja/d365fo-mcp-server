/**
 * validate_form_pattern — structural validator for AxForm XML against the
 * curated D365FO form pattern catalog (src/knowledge/formPatterns).
 *
 * Validates control hierarchy, ordering, sub-pattern usage, pattern versions
 * and datasource expectations. Rules FP001-FP010 (see
 * src/validation/formPatternValidator.ts). Errors block form writes in
 * create_d365fo_file when FORM_PATTERN_ENFORCE is enabled (default: true).
 */

import * as fs from 'fs/promises';
import { z } from 'zod';
import { Parser } from 'xml2js';
import {
  validateFormPatternXml,
  hasPatternErrors,
  type FormPatternReport,
  type FormPatternViolation,
} from '../validation/formPatternValidator.js';
import { resolveSubPattern } from '../knowledge/formPatterns/index.js';
import {
  walkFormDesign,
  type FormControlNode,
} from '../metadata/formPatternMiner.js';

// ── Schema ──────────────────────────────────────────────────────────────────

export const validateFormPatternArgsSchema = z.object({
  xml: z.string().optional().describe(
    'Complete AxForm XML to validate. Provide this OR formName/filePath.'
  ),
  formName: z.string().optional().describe(
    'Name of an indexed form — its XML is loaded from the metadata store via the symbol index.'
  ),
  filePath: z.string().optional().describe(
    'Explicit path to an AxForm XML file (e.g. a freshly created form not yet indexed).'
  ),
});

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.

// ── Formatting ──────────────────────────────────────────────────────────────

function formatReport(report: FormPatternReport, source: string): string {
  const errors = report.violations.filter((v) => v.severity === 'error');
  const warnings = report.violations.filter((v) => v.severity === 'warning');
  const lines: string[] = [];

  const header = report.pattern
    ? `pattern **${report.pattern}**${report.patternVersion ? ` v${report.patternVersion}` : ''}`
    : 'no pattern declared';

  if (report.violations.length === 0) {
    lines.push(`✅ object_patterns(domain="form", action="validate"): ${source} conforms to ${header}.`);
  } else {
    lines.push(
      `${errors.length > 0 ? '❌' : '⚠️'} object_patterns(domain="form", action="validate"): ` +
        `${errors.length} error(s), ${warnings.length} warning(s) — ${source}, ${header}`,
    );
    lines.push('');
    report.violations.forEach((v: FormPatternViolation, idx: number) => {
      const icon = v.severity === 'error' ? '🔴' : '🟡';
      lines.push(`${icon} [${v.rule}] — ${v.severity.toUpperCase()} at \`${v.path}\``);
      lines.push(`   Issue : ${v.excerpt}`);
      lines.push(`   Fix   : ${v.fix}`);
      if (idx < report.violations.length - 1) lines.push('');
    });
  }

  lines.push('');
  lines.push(
    `Pattern coverage: ${report.coverage.containersPatterned}/${report.coverage.containersTotal} containers carry a sub-pattern.`,
  );
  if (errors.length > 0) {
    lines.push('⛔ Fix all errors before calling d365fo_file(action="create") — they will block the write.');
  }
  return lines.join('\n');
}

// ── Tool handler ────────────────────────────────────────────────────────────

export async function validateFormPatternTool(
  request: any,
  context?: { symbolIndex?: any },
): Promise<any> {
  const raw = request?.params?.arguments ?? request;
  const parsed = validateFormPatternArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      isError: true,
      content: [{ type: 'text', text: `❌ Invalid parameters: ${parsed.error.message}` }],
    };
  }

  const { xml, formName, filePath } = parsed.data;

  let formXml = xml;
  let source = 'provided XML';

  try {
    if (!formXml && filePath) {
      formXml = await fs.readFile(filePath, 'utf-8');
      source = filePath;
    } else if (!formXml && formName) {
      const db = context?.symbolIndex?.getReadDb?.();
      const row = db
        ?.prepare(`SELECT file_path FROM symbols WHERE type = 'form' AND name = ? LIMIT 1`)
        ?.get(formName) as { file_path?: string } | undefined;
      if (!row?.file_path) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `❌ Form "${formName}" not found in the symbol index. Pass filePath or xml directly.`,
          }],
        };
      }
      formXml = await fs.readFile(row.file_path, 'utf-8');
      source = `${formName} (${row.file_path})`;
    }
  } catch (error) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `❌ Could not read form XML: ${error instanceof Error ? error.message : error}`,
      }],
    };
  }

  if (!formXml) {
    return {
      isError: true,
      content: [{ type: 'text', text: '❌ Provide one of: xml, formName, or filePath.' }],
    };
  }

  const report = await validateFormPatternXml(formXml);
  return {
    isError: hasPatternErrors(report),
    content: [{ type: 'text', text: formatReport(report, source) }],
  };
}

// ── Write-gate helper (used by create_d365fo_file / generate) ────

/** FORM_PATTERN_ENFORCE defaults to enabled; set to 'false'/'0' to disable blocking. */
export function isFormPatternEnforceEnabled(): boolean {
  const v = (process.env.FORM_PATTERN_ENFORCE ?? 'true').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off';
}

/** Result of the add-control pre-flight check */
export interface AddControlPatternVerdict {
  /** Sub-pattern declared on the parent container */
  parentPattern: string;
  allowed: boolean;
  allowedTypes: string[] | 'any';
}

/**
 * Pre-flight for modify_d365fo_file(add-control): when the target parent
 * container declares a sub-pattern, check the new control's type against the
 * children that sub-pattern allows. Returns null when the parent cannot be
 * found, declares no pattern, or the pattern is unknown — those cases never
 * block (the compiler / post-validation catches real issues).
 */
export async function checkAddControlAgainstParentPattern(
  baseFormXml: string,
  parentControlName: string,
  controlType: string,
): Promise<AddControlPatternVerdict | null> {
  let parsed: any;
  try {
    const parser = new Parser({ explicitArray: false, mergeAttrs: true, trim: true });
    parsed = await parser.parseStringPromise(baseFormXml);
  } catch {
    return null;
  }
  if (!parsed?.AxForm?.Design) return null;

  const design = walkFormDesign(parsed.AxForm.Design);
  const needle = parentControlName.toLowerCase();
  let parent: FormControlNode | undefined;
  const visit = (nodes: FormControlNode[]): void => {
    for (const n of nodes) {
      if (n.name.toLowerCase() === needle) { parent = n; return; }
      visit(n.children);
      if (parent) return;
    }
  };
  visit(design.controls);

  if (!parent?.pattern) return null;
  const sp = resolveSubPattern(parent.pattern);
  if (!sp) return null;

  const extra = sp.extraRootChildren ?? 'any';
  if (extra === 'any') {
    return { parentPattern: sp.xmlName, allowed: true, allowedTypes: 'any' };
  }

  const allowedTypes = new Set<string>(Array.isArray(extra) ? extra : []);
  for (const node of sp.root) node.controlTypes.forEach((t) => allowedTypes.add(t));
  const allowed = allowedTypes.has('*') || allowedTypes.has(controlType);
  return { parentPattern: sp.xmlName, allowed, allowedTypes: [...allowedTypes] };
}

/**
 * Gate a form write on pattern errors. Returns an MCP error result when the
 * XML has error-severity pattern violations and enforcement is enabled;
 * returns null (optionally with warnings text) when the write may proceed.
 */
export async function gateOnFormPatternErrors(
  xmlContent: string,
  operationDescription: string,
): Promise<{ blocked: { isError: true; content: Array<{ type: 'text'; text: string }> } | null; warningsText: string | null }> {
  const report = await validateFormPatternXml(xmlContent);
  const errors = report.violations.filter((v) => v.severity === 'error');
  const warnings = report.violations.filter((v) => v.severity === 'warning');

  const warningsText = warnings.length > 0
    ? `⚠️ Form pattern recommendations (${warnings.length}):\n` +
      warnings.map((v) => `   🟡 [${v.rule}] ${v.path}: ${v.excerpt}`).join('\n')
    : null;

  if (errors.length === 0 || !isFormPatternEnforceEnabled()) {
    if (errors.length > 0) {
      // Enforcement disabled — surface errors as warnings instead of blocking
      const downgraded =
        `⚠️ FORM_PATTERN_ENFORCE is disabled — ${errors.length} pattern error(s) NOT blocking:\n` +
        errors.map((v) => `   🔴 [${v.rule}] ${v.path}: ${v.excerpt}`).join('\n');
      return { blocked: null, warningsText: warningsText ? `${downgraded}\n${warningsText}` : downgraded };
    }
    return { blocked: null, warningsText };
  }

  return {
    blocked: {
      isError: true,
      content: [{
        type: 'text',
        text:
          `⛔ ${operationDescription} blocked — the form XML violates its declared pattern ` +
          `(${report.pattern ?? 'unknown'}${report.patternVersion ? ` v${report.patternVersion}` : ''}).\n\n` +
          formatReport(report, 'form XML') +
          `\n\nFix the structure (or set FORM_PATTERN_ENFORCE=false to bypass) and retry. ` +
          `Use object_patterns(domain="form", action="validate") to iterate quickly.`,
      }],
    },
    warningsText,
  };
}
