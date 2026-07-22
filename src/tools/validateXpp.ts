/**
 * Offline X++ / XML Best Practice validator.
 *
 * Checks generated code against the rule set in systemInstructions.ts without
 * requiring xppbp.exe or a Windows VM. Returns structured violations that the
 * model can action in one step.
 *
 * Rules implemented:
 *   SEL001  today() deprecated
 *   SEL002  forceLiterals forbidden (SQL injection risk)
 *   SEL003  crossCompany on joined buffer (must be on driving buffer)
 *   SEL004  Nested while select (N+1 query anti-pattern)
 *   SEL005  Function call in where clause (assign to variable first)
 *   COC001  Default param value copied into CoC wrapper signature
 *   COC002  [ExtensionOf] class not declared final
 *   COC003  [ExtensionOf] class name not ending _Extension
 *   BP001   Hardcoded string literal in info/warning/error/checkFailed
 *   BP002   doInsert/doUpdate/doDelete outside explicit migration comment
 *   BP003   Generic doc-comment (/// Foo class. / /// methodName.)
 *   BP004   Developer-only statements left in code (pause / print)
 *   TTS001  Unbalanced ttsbegin / ttscommit
 *   XML001  AxTable XML missing an index with <AlternateKey>Yes</AlternateKey>
 *   XML006  AxTable elements out of canonical order (silently dropped by the AOT)
 *   XML007  Table-level property that does not exist in the AxTable model
 *
 * Keyword scans run against a comment/string-masked copy of the source
 * (maskStringsAndComments) to avoid false positives inside literals/comments.
 *
 * Data-driven property rules (thresholds mined from STANDARD models into the
 * property_stats table during build-database; static defaults when no stats):
 *   XML002  AxTable missing <Label>
 *   XML003  AxTable missing <TableGroup> (suggests the most common standard values)
 *   XML004  AxTableField without <ExtendedDataType>/<EnumType>
 *   XML005  AxTable missing <ClusteredIndex> (only when standard usage ≥ threshold)
 */

import { z } from 'zod';
import {
  AX_TABLE_ELEMENT_ORDER,
  AX_TABLE_NON_EXISTENT_PROPERTIES,
  axTableElementRank,
} from '../utils/axTablePropertyOrder.js';

// Schema

export const validateXppArgsSchema = z.object({
  code: z.string().describe(
    'X++ source code or XML metadata to validate. Paste the full generated text.'
  ),
  codeType: z.enum(['xpp', 'xml-table', 'xml-any']).optional().default('xpp').describe(
    '"xpp" for X++ source (default), "xml-table" for AxTable XML, "xml-any" for other XML.'
  ),
  context: z.string().optional().describe(
    'Optional: owning class/table name, used in diagnostic messages.'
  ),
});

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.

// Types

export interface ValidationViolation {
  rule: string;
  severity: 'error' | 'warning';
  line?: number;
  excerpt: string;
  fix: string;
}

// Helpers

function lineNumber(code: string, index: number): number {
  return code.slice(0, index).split('\n').length;
}

/**
 * Lightweight tokenizer-lite: returns a copy of `code` with the CONTENT of string
 * literals, line comments (//…) and block comments (/* … *\/) replaced by spaces,
 * preserving every newline (so line numbers stay correct) and overall length (so
 * offsets stay correct). Keyword/regex scans run against this masked text to avoid
 * false positives from keywords that appear inside strings or comments.
 */
export function maskStringsAndComments(code: string): string {
  const out = code.split('');
  const n = code.length;
  let i = 0;
  type State = 'code' | 'line' | 'block' | 'string';
  let state: State = 'code';
  while (i < n) {
    const c = code[i];
    const c2 = i + 1 < n ? code[i + 1] : '';
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue; }
      if (c === '"') { state = 'string'; i++; continue; }
      i++;
    } else if (state === 'line') {
      if (c === '\n') { state = 'code'; i++; continue; }
      out[i] = ' '; i++;
    } else if (state === 'block') {
      if (c === '*' && c2 === '/') { out[i] = ' '; out[i + 1] = ' '; state = 'code'; i += 2; continue; }
      if (c !== '\n') out[i] = ' ';
      i++;
    } else { // string
      if (c === '\\') { out[i] = ' '; if (c2 && c2 !== '\n') out[i + 1] = ' '; i += 2; continue; }
      if (c === '"') { state = 'code'; i++; continue; }
      if (c !== '\n') out[i] = ' ';
      i++;
    }
  }
  return out.join('');
}

/**
 * Find all regex matches in code and map them to violations.
 * @param skipIfComment — skip match when the line starts with // (already commented out)
 */
function matchAll(
  code: string,
  pattern: RegExp,
  rule: string,
  severity: 'error' | 'warning',
  fix: string,
  skipIfComment = true,
): ValidationViolation[] {
  const lines = code.split('\n');
  const violations: ValidationViolation[] = [];
  let match: RegExpExecArray | null;
  // Always use a fresh regex with 'g' flag to avoid state contamination
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  while ((match = re.exec(code)) !== null) {
    const lineIdx = lineNumber(code, match.index) - 1;
    const lineText = lines[lineIdx]?.trimStart() ?? '';
    if (skipIfComment && (lineText.startsWith('//') || lineText.startsWith('*'))) continue;
    violations.push({
      rule,
      severity,
      line: lineIdx + 1,
      excerpt: match[0].trim(),
      fix,
    });
  }
  return violations;
}

// Rule implementations

/** SEL001 — today() is deprecated; use DateTimeUtil::getToday(...). */
function checkTodayDeprecated(code: string): ValidationViolation[] {
  return matchAll(
    code,
    /\btoday\s*\(\s*\)/gi,
    'SEL001',
    'error',
    'Replace today() with DateTimeUtil::getToday(DateTimeUtil::getUserPreferredTimeZone()). ' +
    'today() ignores user time zone and fails BPUpgradeCodeToday.',
  );
}

/** SEL002 — forceLiterals is forbidden (SQL injection). */
function checkForceLiterals(code: string): ValidationViolation[] {
  return matchAll(
    code,
    /\bforceLiterals\b/gi,
    'SEL002',
    'error',
    'Remove forceLiterals. Use forcePlaceholders (default for non-join selects) or omit. ' +
    'forceLiterals exposes the query to SQL injection.',
  );
}

/**
 * SEL003 — crossCompany on a joined buffer instead of the driving (outer) buffer.
 * Pattern: "join crossCompany tableName" — crossCompany must appear on the outer select.
 */
function checkCrossCompanyPlacement(code: string): ValidationViolation[] {
  return matchAll(
    code,
    /\bjoin\s+crossCompany\b/gi,
    'SEL003',
    'error',
    'Move crossCompany to the outer select (driving buffer): "select crossCompany tableBuffer join …". ' +
    'crossCompany is a query-level option, not a per-join option.',
  );
}

/**
 * SEL004 — Nested while select (N+1 anti-pattern).
 * Heuristic: two or more "while select" in the same code block without a join.
 */
function checkNestedWhileSelect(code: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const masked = maskStringsAndComments(code);
  const lines = masked.split('\n');
  const whileSelectLines: number[] = [];
  lines.forEach((l, i) => {
    if (/\bwhile\s+select\b/i.test(l) && !l.trimStart().startsWith('//')) {
      whileSelectLines.push(i + 1);
    }
  });
  if (whileSelectLines.length >= 2) {
    // Only flag when there's no nearby "join" keyword (rough heuristic)
    const hasJoin = /\bjoin\b/i.test(masked);
    if (!hasJoin) {
      violations.push({
        rule: 'SEL004',
        severity: 'warning',
        line: whileSelectLines[1],
        excerpt: `while select at lines ${whileSelectLines.join(', ')}`,
        fix: 'Replace nested while select with a join in a single while select, or ' +
          'pre-load the inner data into a Map/temp table. ' +
          'Nested while select causes N+1 database queries (BPCheckNestedLoopinCode).',
      });
    }
  }
  return violations;
}

/**
 * SEL005 — Function call directly in a where clause.
 * Excludes compile-time intrinsics: fieldNum, tableNum, classStr, methodStr, formStr,
 * tableStr, enumNum, extendedTypeNum, identifierStr, literalStr, resourceStr, ssrsReportStr,
 * fieldStr, queryStr, dataEntityDataSourceStr, formDataSourceStr, formControlStr, delegateStr.
 */
const INTRINSIC_FUNCTIONS = new Set([
  'fieldnum', 'tablenum', 'classstr', 'methodstr', 'formstr', 'tablestr',
  'enumnum', 'extendedtypenum', 'identifierstr', 'literalstr', 'resourcestr',
  'ssrsreportstr', 'fieldstr', 'querystr', 'dataentitydatasourcestr',
  'formdatasourcestr', 'formcontrolstr', 'delegatestr', 'enumstr',
  'classnum', 'formnum', 'reportstr', 'menuitemactionstr', 'menuitemdisplaystr',
  'menuitemoutputstr', 'varstr', 'con2str', 'int2str', 'num2str',
]);

function checkFunctionInWhere(code: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  // Scan masked text so function-like tokens inside strings/comments aren't flagged.
  const lines = maskStringsAndComments(code).split('\n');
  // `inWhere` tracks an open where-clause spanning multiple lines; it must close at
  // the clause's actual boundary (`;` or `{`), otherwise later unrelated code gets
  // misattributed to "inside where clause".
  let inWhere = false;
  lines.forEach((rawLine, i) => {
    const line = rawLine.trimStart();
    if (line.startsWith('//') || line.startsWith('*')) return;

    // Scan starts right after `where` if a new clause starts here, otherwise from line start.
    let scanStart = 0;
    if (!inWhere) {
      const whereMatch = /\bwhere\b/i.exec(rawLine);
      if (!whereMatch) return;
      inWhere = true;
      scanStart = whereMatch.index + whereMatch[0].length;
    }

    // Clause ends at the first `;` or `{` at/after scanStart — don't scan past it.
    const rest = rawLine.slice(scanStart);
    const endMatch = /[;{]/.exec(rest);
    const scanSegment = endMatch ? rest.slice(0, endMatch.index) : rest;

    // Find function calls (word followed by '(') that are not intrinsics
    const callPattern = /\b([a-zA-Z_]\w*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callPattern.exec(scanSegment)) !== null) {
      const fnName = m[1].toLowerCase();
      if (INTRINSIC_FUNCTIONS.has(fnName)) continue;
      // Skip common X++ keywords
      if (['if', 'while', 'for', 'switch', 'catch', 'str', 'int', 'new', 'where'].includes(fnName)) continue;
      violations.push({
        rule: 'SEL005',
        severity: 'warning',
        line: i + 1,
        excerpt: `${m[1]}(...) inside where clause`,
        fix: `Assign the result of ${m[1]}() to a local variable BEFORE the select statement, ` +
          'then use the variable in the where clause. ' +
          'Function calls in where clauses prevent index usage and may cause unexpected results.',
      });
      break; // one violation per line is enough
    }

    if (endMatch) inWhere = false;
  });
  return violations;
}

/**
 * COC001 — Default parameter value copied into CoC wrapper signature.
 * Detects: inside an [ExtensionOf] class, any method whose parameter list
 * contains "= " (assignment default).
 * Pattern: public <type> <method>(...= ...) inside [ExtensionOf(...)] final class
 */
function checkCocDefaultParam(code: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  if (!/\[ExtensionOf\s*\(/i.test(code)) return violations;

  const lines = code.split('\n');
  lines.forEach((rawLine, i) => {
    if (rawLine.trimStart().startsWith('//')) return;
    // Method-like line with a default param: "public Foo method(Type _p = val)"
    if (/\b(public|protected|private|internal)\b.*\([^)]*=\s*[^,)]+\)/.test(rawLine)) {
      // Skip constructors (new()) — defaults there are intentional
      if (/\bnew\s*\(/.test(rawLine)) return;
      // Skip parm* accessor methods (standard DataContract pattern: parmX(T _v = v))
      if (/\bparm[A-Z]/.test(rawLine)) return;
      violations.push({
        rule: 'COC001',
        severity: 'error',
        line: i + 1,
        excerpt: rawLine.trim(),
        fix: 'Remove default parameter values from CoC wrapper signatures. ' +
          'The base method\'s defaults are already in effect when calling next. ' +
          'Example: "public void salute(str message)" NOT "public void salute(str message = \\"Hi\\")".',
      });
    }
  });
  return violations;
}

/**
 * COC002 — [ExtensionOf] class not declared final.
 * Extension classes MUST be final.
 */
function checkExtensionOfNotFinal(code: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('[ExtensionOf') && !line.includes('[extensionof')) continue;
    // Look ahead up to 3 lines for the class declaration
    for (let j = i; j <= Math.min(i + 3, lines.length - 1); j++) {
      const declLine = lines[j];
      if (/\bclass\b/i.test(declLine)) {
        if (!/\bfinal\b/i.test(declLine)) {
          violations.push({
            rule: 'COC002',
            severity: 'error',
            line: j + 1,
            excerpt: declLine.trim(),
            fix: 'Extension classes must be declared final: "[ExtensionOf(...)] final class MyClass_Extension". ' +
              'Without final the compiler will reject the file.',
          });
        }
        break;
      }
    }
  }
  return violations;
}

/**
 * COC003 — [ExtensionOf] class name not ending in _Extension.
 */
function checkExtensionOfNaming(code: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('[ExtensionOf') && !line.includes('[extensionof')) continue;
    for (let j = i; j <= Math.min(i + 3, lines.length - 1); j++) {
      const declLine = lines[j];
      const m = /\bclass\s+(\w+)/i.exec(declLine);
      if (m) {
        if (!m[1].endsWith('_Extension')) {
          violations.push({
            rule: 'COC003',
            severity: 'error',
            line: j + 1,
            excerpt: declLine.trim(),
            fix: `Rename class to "${m[1]}_Extension". ` +
              'Extension classes must end with _Extension per MS naming guidelines.',
          });
        }
        break;
      }
    }
  }
  return violations;
}

/**
 * BP001 — Hardcoded string literal in info/warning/error/checkFailed.
 * Flags: info("literal") — must use label @Module:LabelId.
 * Excludes strFmt(labelRef, ...) and calls where the first arg is a label ref (@...).
 */
function checkHardcodedStrings(code: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const lines = code.split('\n');
  lines.forEach((rawLine, i) => {
    const line = rawLine.trimStart();
    if (line.startsWith('//') || line.startsWith('*')) return;
    // Match: info("...") / warning("...") / error("...") / checkFailed("...")
    // where the first argument is a raw string (not starting with @)
    const pattern = /\b(?:info|warning|error|checkFailed)\s*\(\s*"(?!@)([^"]{1,200})"/gi;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(rawLine)) !== null) {
      violations.push({
        rule: 'BP001',
        severity: 'error',
        line: i + 1,
        excerpt: m[0].trim(),
        fix: 'Replace the hardcoded string with a label reference: info("@ModelName:LabelId"). ' +
          'Call labels(action="search") to find an existing label, or labels(action="create") if none exists. ' +
          'Hardcoded strings fail BPErrorLabelIsText.',
      });
    }
  });
  return violations;
}

/**
 * BP002 — doInsert/doUpdate/doDelete usage outside a comment that marks it as intentional.
 * These bypass insert/update/delete overrides and event handlers.
 */
function checkDoMethods(code: string): ValidationViolation[] {
  return matchAll(
    code,
    /\.\s*do(?:Insert|Update|Delete)\s*\(\s*\)/gi,
    'BP002',
    'warning',
    'doInsert/doUpdate/doDelete bypasses overridden methods and event handlers. ' +
    'Use insert()/update()/delete() in production code. ' +
    'Reserve do* variants for data-fix / migration scripts and add a comment explaining why.',
  );
}

/**
 * BP003 — Generic doc-comment that just repeats the class/method name.
 * Patterns detected:
 *   /// ClassName class.
 *   /// methodName.
 *   /// ClassName class
 *   /// TODO: Add class description here.
 */
function checkGenericDocComment(code: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const lines = code.split('\n');
  // Look for <summary> blocks whose content is just "Foo class" or "foo."
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l.startsWith('///')) continue;
    // Detect "/// SomeName class." or "/// SomeName class" patterns
    if (/^\/\/\/\s+\w+\s+(?:class|method|table|form|enum|edt|query|view)\.?\s*$/i.test(l)) {
      violations.push({
        rule: 'BP003',
        severity: 'warning',
        line: i + 1,
        excerpt: l,
        fix: 'Replace the generic doc-comment with a meaningful description of what the class/method does. ' +
          'Example: "/// Validates the record before it is written to the database." ' +
          'Generic comments like "/// MyClass class." fail BPXmlDocNoDocumentationComments.',
      });
    }
    // Detect single-word comment that exactly matches the next class/method name
    // e.g.: /// validateWrite.  followed by  public boolean validateWrite()
    const singleWord = /^\/\/\/\s+(\w+)\.?\s*$/.exec(l);
    if (singleWord && i + 1 < lines.length) {
      const nextCode = lines[i + 1].trim();
      if (nextCode.includes(singleWord[1] + '(') || nextCode.includes(singleWord[1] + ' ')) {
        violations.push({
          rule: 'BP003',
          severity: 'warning',
          line: i + 1,
          excerpt: l,
          fix: `Replace "/// ${singleWord[1]}." with a sentence describing what this member does. ` +
            'Repeating the method name as the doc-comment fails BPXmlDocNoDocumentationComments.',
        });
      }
    }
  }
  return violations;
}

/**
 * XML001 — AxTable XML missing an index with <AlternateKey>Yes</AlternateKey>.
 * Every D365FO table must have at least one index marked as alternate key
 * for the BPCheckAlternateKeyAbsent rule.
 */
function checkMissingAlternateKey(code: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  // A table EXTENSION inherits the base table's alternate key — it must not be
  // required to declare its own. Only full AxTable definitions need one.
  if (/<AxTableExtension[\s>]/.test(code)) return violations;
  if (!code.includes('<AxTable')) return violations;
  // Check that at least one index declares AlternateKey = Yes
  if (!/<AlternateKey>\s*Yes\s*<\/AlternateKey>/i.test(code)) {
    violations.push({
      rule: 'XML001',
      severity: 'error',
      excerpt: '<AxTable> — no index with <AlternateKey>Yes</AlternateKey>',
      fix: 'Add at least one <AxTableIndex> with <AlternateKey>Yes</AlternateKey>. ' +
        'D365FO requires every table to have an alternate key index ' +
        '(BPCheckAlternateKeyAbsent). ' +
        'generate_smart adds this automatically via buildPrimaryKeyIndex.',
    });
  }
  return violations;
}

/**
 * TTS001 — Unbalanced ttsbegin / ttscommit.
 * Counts (on masked code) ttsbegin vs ttscommit. A mismatch usually means a
 * missing commit (transaction left open) or a stray commit. ttsabort lives in
 * catch blocks and is not required to balance the static count.
 */
function checkUnbalancedTts(code: string): ValidationViolation[] {
  const masked = maskStringsAndComments(code);
  const begins = (masked.match(/\bttsbegin\b/gi) ?? []).length;
  const commits = (masked.match(/\bttscommit\b/gi) ?? []).length;
  if (begins === 0 && commits === 0) return [];
  if (begins === commits) return [];
  const firstIdx = masked.search(/\bttsbegin\b/i);
  return [{
    rule: 'TTS001',
    severity: 'warning',
    line: firstIdx >= 0 ? lineNumber(code, firstIdx) : undefined,
    excerpt: `ttsbegin × ${begins}, ttscommit × ${commits}`,
    fix: 'Balance every ttsbegin with a matching ttscommit (and ttsabort in the catch). ' +
      'An unmatched ttsbegin leaves the transaction open; an unmatched ttscommit will throw at runtime.',
  }];
}

/**
 * BP004 — Developer-only statements left in code (pause / print).
 * These block the AOS / write to the console and must not ship.
 */
function checkDevArtifacts(code: string): ValidationViolation[] {
  return matchAll(
    maskStringsAndComments(code),
    /\b(?:pause|print)\b/g,
    'BP004',
    'warning',
    'Remove developer-only statements (pause / print) before shipping. ' +
    'Use the Infolog (info/warning) or telemetry for diagnostics instead.',
  );
}

// Data-driven property rules (XML002-XML005)

/**
 * Provider of mined property statistics — implemented by XppSymbolIndex.
 * When unavailable (offline use, stats not built), the rules fall back to
 * STATIC_PROPERTY_DEFAULTS.
 */
export interface PropertyStatsProvider {
  getPropertyPresenceRatio(nodeType: string, property: string): { present: number; total: number; ratio: number };
  getPropertyValueDistribution(nodeType: string, property: string, limit?: number): Array<{ value: string; count: number }>;
}

/** A property rule fires when the standard platform sets it at least this often. */
const PROPERTY_RULE_THRESHOLD = 0.8;

/** Behaviour when no mined statistics are available. */
const STATIC_PROPERTY_DEFAULTS: Record<string, boolean> = {
  'AxTable.Label': true,
  'AxTable.TableGroup': true,
  'AxTableField.ExtendedDataType': true,
  'AxTable.ClusteredIndex': false, // only enforced when stats prove standard usage
};

/** Decide whether a property rule applies + build its evidence string. */
function propertyRuleApplies(
  stats: PropertyStatsProvider | undefined,
  nodeType: string,
  property: string,
): { applies: boolean; evidence: string } {
  if (stats) {
    try {
      const r = stats.getPropertyPresenceRatio(nodeType, property);
      if (r.total > 0) {
        return {
          applies: r.ratio >= PROPERTY_RULE_THRESHOLD,
          evidence: `${Math.round(r.ratio * 100)}% of ${r.total.toLocaleString('en-US')} standard ${nodeType} nodes set this property`,
        };
      }
    } catch { /* stats unavailable — fall through to defaults */ }
  }
  return {
    applies: STATIC_PROPERTY_DEFAULTS[`${nodeType}.${property}`] ?? false,
    evidence: 'static default (no mined statistics available — run build-database to mine standard models)',
  };
}

/** Extract the table-level header segment (before <Fields>) of an AxTable XML. */
function tableHeaderSegment(code: string): string {
  const fieldsIdx = code.search(/<Fields\b/i);
  return fieldsIdx === -1 ? code : code.slice(0, fieldsIdx);
}

/** XML002/XML003/XML005 — table-level property presence. */
function checkTableProperties(code: string, stats?: PropertyStatsProvider): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  if (!/<AxTable[\s>]/i.test(code)) return violations;
  const header = tableHeaderSegment(code);

  const label = propertyRuleApplies(stats, 'AxTable', 'Label');
  if (label.applies && !/<Label>[^<]+<\/Label>/i.test(header)) {
    violations.push({
      rule: 'XML002',
      severity: 'error',
      excerpt: '<AxTable> — missing <Label>',
      fix: `Add <Label>@YourModel:TableLabel</Label> to the table header (create the label first via labels). Evidence: ${label.evidence}.`,
    });
  }

  const tableGroup = propertyRuleApplies(stats, 'AxTable', 'TableGroup');
  if (tableGroup.applies && !/<TableGroup>[^<]+<\/TableGroup>/i.test(header)) {
    let suggestion = 'Main (master data), Transaction (postings), Parameter (settings), Group (groupings)';
    if (stats) {
      try {
        const dist = stats.getPropertyValueDistribution('AxTable', 'TableGroup', 4);
        if (dist.length > 0) {
          const total = dist.reduce((s, d) => s + d.count, 0);
          suggestion = dist
            .map(d => `${d.value} (${Math.round((d.count / total) * 100)}%)`)
            .join(', ');
        }
      } catch { /* keep static suggestion */ }
    }
    violations.push({
      rule: 'XML003',
      severity: 'error',
      excerpt: '<AxTable> — missing <TableGroup>',
      fix: `Add <TableGroup> to the table header. Most common standard values: ${suggestion}. Evidence: ${tableGroup.evidence}.`,
    });
  }

  const clustered = propertyRuleApplies(stats, 'AxTable', 'ClusteredIndex');
  if (clustered.applies && !/<ClusteredIndex>[^<]+<\/ClusteredIndex>/i.test(header)) {
    violations.push({
      rule: 'XML005',
      severity: 'warning',
      excerpt: '<AxTable> — missing <ClusteredIndex>',
      fix: `Set <ClusteredIndex> to the primary index name for predictable physical ordering. Evidence: ${clustered.evidence}.`,
    });
  }

  return violations;
}

/** XML004 — every AxTableField should carry an EDT (or EnumType for enums). */
function checkFieldEdt(code: string, stats?: PropertyStatsProvider): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  if (!/<AxTableField[\s>]/i.test(code)) return violations;
  const rule = propertyRuleApplies(stats, 'AxTableField', 'ExtendedDataType');
  if (!rule.applies) return violations;

  const fieldBlocks = code.split(/<AxTableField[\s>]/i).slice(1);
  for (const block of fieldBlocks) {
    const body = block.split(/<\/AxTableField>/i)[0] ?? block;
    if (/<ExtendedDataType>[^<]+<\/ExtendedDataType>/i.test(body)) continue;
    if (/<EnumType>[^<]+<\/EnumType>/i.test(body)) continue;
    const name = /<Name>([^<]+)<\/Name>/i.exec(body)?.[1] ?? '(unnamed)';
    violations.push({
      rule: 'XML004',
      severity: 'warning',
      excerpt: `<AxTableField> ${name} — no <ExtendedDataType> or <EnumType>`,
      fix: `Base field "${name}" on an EDT (use suggest_edt to find one) or an enum. ` +
        `Primitive-typed fields lose label, help text, and length governance. Evidence: ${rule.evidence}.`,
    });
  }
  return violations;
}

// Runner

const XPP_RULES = [
  checkTodayDeprecated,
  checkForceLiterals,
  checkCrossCompanyPlacement,
  checkNestedWhileSelect,
  checkFunctionInWhere,
  checkCocDefaultParam,
  checkExtensionOfNotFinal,
  checkExtensionOfNaming,
  checkHardcodedStrings,
  checkDoMethods,
  checkGenericDocComment,
  checkUnbalancedTts,
  checkDevArtifacts,
];

/**
 * Collect the names of the direct children of the document root, in document order.
 *
 * Skips CDATA / comments / PIs in a single forward scan rather than stripping them with
 * chained `.replace()`. Two reasons that matters: removing one region can splice its
 * neighbours into a NEW delimiter (`<!<!-- -->--` leaves `<!--`), and a non-greedy
 * `<!--[\s\S]*?-->` does not match an UNTERMINATED comment at all, so it survives intact.
 * Skipping in place can do neither. CDATA is what makes this necessary in the first place:
 * X++ inside `<Source><![CDATA[…]]></Source>` is full of `<` that would read as tags.
 */
function rootChildElements(xml: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let i = 0;

  /** End of a skipped region; an unterminated one runs to EOF. */
  const skipTo = (from: number, terminator: string): number => {
    const end = xml.indexOf(terminator, from);
    return end === -1 ? xml.length : end + terminator.length;
  };

  const tagRe = /<(\/?)([A-Za-z_][\w.-]*)([^>]*?)(\/?)>/y;

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;

    // Order matters: the longer delimiters must be tested before the `<!` catch-all.
    if (xml.startsWith('<![CDATA[', lt)) { i = skipTo(lt + 9, ']]>'); continue; }
    if (xml.startsWith('<!--', lt)) { i = skipTo(lt + 4, '-->'); continue; }
    if (xml.startsWith('<?', lt)) { i = skipTo(lt + 2, '?>'); continue; }
    if (xml.startsWith('<!', lt)) { i = skipTo(lt + 2, '>'); continue; }

    tagRe.lastIndex = lt;
    const m = tagRe.exec(xml);
    if (!m) {
      i = lt + 1;
      continue;
    }
    if (m[1] === '/') {
      depth--;
    } else {
      if (depth === 1) out.push(m[2]);
      if (m[4] !== '/') depth++;
    }
    i = lt + m[0].length;
  }
  return out;
}

/**
 * XML006 — AxTable elements out of canonical order.
 *
 * The AOT deserializer drops a misordered property SILENTLY: xppbp then reports
 * BPErrorLabelNotDefined / BPErrorTableTitleField1NotDeclared /
 * BPErrorDeveloperDocumentationNotDefined for properties that are physically in
 * the file, and this validator used to answer "no violations" on exactly that
 * document (docs/eval-sweep-findings-2026-07-21.md #13).
 */
function checkTableElementOrder(code: string): ValidationViolation[] {
  if (!/<AxTable[\s>]/.test(code)) return [];
  const children = rootChildElements(code).filter(
    n => axTableElementRank(n) !== Number.MAX_SAFE_INTEGER,
  );
  const violations: ValidationViolation[] = [];
  for (let i = 1; i < children.length; i++) {
    const prev = children[i - 1];
    const cur = children[i];
    if (axTableElementRank(cur) >= axTableElementRank(prev)) continue;
    violations.push({
      rule: 'XML006',
      severity: 'error',
      line: lineNumber(code, code.indexOf(`<${cur}`)),
      excerpt: `<${cur}> appears after <${prev}>`,
      fix:
        `AxTable XML is order-sensitive and a misordered element is dropped SILENTLY ` +
        `(the build stays green, xppbp then reports the property as missing). ` +
        `Move <${cur}> before <${prev}>. Canonical order: ` +
        `${AX_TABLE_ELEMENT_ORDER.join(' → ')}.`,
    });
    break; // one report per document — fixing the order fixes them all
  }
  return violations;
}

/**
 * XML007 — a table-level property that does not exist in the AxTable model.
 * `<AlternateKey>` at table level is the common one: it reads naturally, is
 * accepted by every writer, and does nothing at all (findings #13).
 */
function checkNonExistentTableProperties(code: string): ValidationViolation[] {
  if (!/<AxTable[\s>]/.test(code)) return [];
  const violations: ValidationViolation[] = [];
  for (const name of new Set(rootChildElements(code))) {
    const explanation = AX_TABLE_NON_EXISTENT_PROPERTIES[name];
    if (!explanation) continue;
    violations.push({
      rule: 'XML007',
      severity: 'error',
      line: lineNumber(code, code.indexOf(`<${name}`)),
      excerpt: `<${name}> is not an AxTable property`,
      fix: `${explanation} As written this element is ignored by the deserializer — silently.`,
    });
  }
  return violations;
}

const XML_RULES = [
  checkMissingAlternateKey,
  checkTableElementOrder,
  checkNonExistentTableProperties,
];

const XML_PROPERTY_RULES = [
  checkTableProperties,
  checkFieldEdt,
];

export function runRules(
  code: string,
  codeType: 'xpp' | 'xml-table' | 'xml-any',
  stats?: PropertyStatsProvider,
): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  if (codeType === 'xpp') {
    for (const rule of XPP_RULES) {
      violations.push(...rule(code));
    }
  } else if (codeType === 'xml-table') {
    for (const rule of [...XPP_RULES, ...XML_RULES]) {
      violations.push(...rule(code));
    }
    for (const rule of XML_PROPERTY_RULES) {
      violations.push(...rule(code, stats));
    }
  } else {
    for (const rule of XML_RULES) {
      violations.push(...rule(code));
    }
    for (const rule of XML_PROPERTY_RULES) {
      violations.push(...rule(code, stats));
    }
  }
  return violations;
}

// Tool handler

export async function validateXppTool(
  request: any,
  serverContext?: { symbolIndex?: PropertyStatsProvider },
): Promise<any> {
  const raw = request?.params?.arguments ?? request;
  const parsed = validateXppArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      isError: true,
      content: [{ type: 'text', text: `❌ Invalid parameters: ${parsed.error.message}` }],
    };
  }

  const { code, codeType = 'xpp', context } = parsed.data;
  const stats = typeof serverContext?.symbolIndex?.getPropertyPresenceRatio === 'function'
    ? serverContext.symbolIndex
    : undefined;
  const violations = runRules(code, codeType, stats);

  const errors = violations.filter(v => v.severity === 'error');
  const warnings = violations.filter(v => v.severity === 'warning');

  if (violations.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `✅ validate_xpp: no violations found${context ? ` in ${context}` : ''}.\n` +
          `Checked ${XPP_RULES.length + (codeType !== 'xpp' ? XML_RULES.length + XML_PROPERTY_RULES.length : 0)} rule groups` +
          `${codeType !== 'xpp' && stats ? ' (property rules driven by mined standard-model statistics)' : ''}.`,
      }],
    };
  }

  const lines: string[] = [];
  lines.push(
    `${errors.length > 0 ? '❌' : '⚠️'} validate_xpp: ` +
    `${errors.length} error(s), ${warnings.length} warning(s)` +
    (context ? ` in ${context}` : ''),
  );
  lines.push('');

  violations.forEach((v, idx) => {
    const icon = v.severity === 'error' ? '🔴' : '🟡';
    const lineInfo = v.line ? ` (line ${v.line})` : '';
    lines.push(`${icon} [${v.rule}]${lineInfo} — ${v.severity.toUpperCase()}`);
    lines.push(`   Excerpt : \`${v.excerpt}\``);
    lines.push(`   Fix     : ${v.fix}`);
    if (idx < violations.length - 1) lines.push('');
  });

  lines.push('');
  lines.push(
    errors.length > 0
      ? '⛔ Fix all errors before calling d365fo_file(action="create") or d365fo_file(action="modify").'
      : '⚠️  Address warnings where practical, then proceed.',
  );

  return {
    isError: errors.length > 0,
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}
