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
 *   COC004  next not reached exactly once and unconditionally (SYS10028)
 *   COC005  Global function (checkFailed/error/…) called as this.<fn>() on a table buffer
 *   COC006  Re-reading the record the buffer already holds, instead of this.orig()
 *   BP001   Hardcoded string literal in info/warning/error/checkFailed
 *   BP002   doInsert/doUpdate/doDelete outside explicit migration comment
 *   BP003   Generic doc-comment (/// Foo class. / /// methodName.)
 *   BP004   Developer-only statements left in code (pause / print)
 *   BP005   an enum SYMBOL (enum2Symbol / value2Symbol) in user-facing text — never translated
 *   FN001   fixed-arity built-in called with the wrong number of arguments
 *   TTS001  Unbalanced ttsbegin / ttscommit
 *   TTS002  Dead catch inside an open tts scope (only UpdateConflict/DuplicateKeyException reach it)
 *   TTS003  retry with no visible guard in its catch block (infinite-loop risk)
 *   SEL006  index hint without allowIndexHint(true)
 *   SEL007  left/right join or join…on — SQL/C# join syntax that is not X++
 *   CS001   C# constructs that do not compile in X++ ($"…", =>, foreach, ??, string type)
 *   RPT001  DP reads parmDataContract() but declares no [SRSReportParameterAttribute]
 *   RPT002  DP has processReport() but no [SRSReportDataSetAttribute] getter
 *   RPT101  AxReport XML without a design node (codeType="xml-report")
 *   RPT102  AxReport dataset without <Query> (codeType="xml-report")
 *   XML001  AxTable XML missing an index with <AlternateKey>Yes</AlternateKey>
 *   XML006  AxTable elements out of canonical order (silently dropped by the AOT)
 *   XML007  Table-level property that does not exist in the AxTable model
 *
 * Added from compiler diagnostics (see src/knowledge/compilerFacts.ts):
 *   FN002   a call to a predefined function this platform version does not have
 *   BP006   pause / window / tableLock / changeSite — removed from the language
 *   MAC001  a precompiler directive written without its dot (#define X)
 *   SEL008  order by / group by after the where of the same segment
 *   SEL009  the in operator with an inline container literal
 *   SEL010  a select expression on an aliased buffer; validTimeState given an expression
 *   ATTR001 an attribute argument that is not a compile-time literal
 *   ATTR002 [SysObsolete] without message, isError AND date (xppbp moniker)
 *   EXT001  an extension-method class whose class or methods are not static
 *   KW001   a variable named after a reserved word
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
import { findControlElementOrderViolations } from '../../validation/formControlElementOrder.js';
import {
  AX_TABLE_ELEMENT_ORDER,
  AX_TABLE_NON_EXISTENT_PROPERTIES,
  axTableElementRank,
} from '../../utils/axTablePropertyOrder.js';
import { maskXpp } from '../../utils/xppLexer.js';
import {
  COMPILER_VERSION,
  acceptsArgumentCount,
  describeArity,
  intrinsicInfo,
  isReservedKeyword,
  isUnknownFunction,
  runtimeFunctionInfo,
} from '../../knowledge/compilerFacts.js';

// Schema

export const validateXppArgsSchema = z.object({
  code: z.string().describe(
    'X++ source code or XML metadata to validate. Paste the full generated text.'
  ),
  codeType: z.enum(['xpp', 'xml-table', 'xml-form', 'xml-any', 'xml-report']).optional().default('xpp').describe(
    '"xpp" for X++ source (default), "xml-table" for AxTable XML, "xml-form" for AxForm/AxFormExtension XML, ' +
    '"xml-report" for AxReport XML, "xml-any" for other XML.'
  ),
  context: z.string().optional().describe(
    'Optional: owning class/table name, used in diagnostic messages.'
  ),
});

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.

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
 * Masked copy of `code` — see src/utils/xppLexer.ts, the single masker this repo
 * has. Kept as a named export because every rule below calls it and the tests
 * exercise it directly. Both quote styles and @verbatim strings are recognised;
 * before that was true, `strFind(x, ',', 1, n)` was an FN001 error on shipped code.
 */
export function maskStringsAndComments(code: string): string {
  return maskXpp(code);
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
    // xppc compiles today() — this is a best-practice finding (BPUpgradeCodeToday),
    // not a compile error, and the severity must say so.
    'warning',
    'Replace today() with DateTimeUtil::getToday(DateTimeUtil::getUserPreferredTimeZone()). ' +
    'today() ignores user time zone and fails BPUpgradeCodeToday.',
  );
}

/**
 * SEL002 — forceLiterals reveals the where-clause values to SQL Server.
 *
 * A warning, not an error: xppc accepts the keyword and the platform itself ships
 * 57 uses of it (LeanCost_CalcProdFlow_Multi, CostStatementCache). The risk is real
 * only when a value in the where clause comes from user input.
 */
function checkForceLiterals(code: string): ValidationViolation[] {
  return matchAll(
    maskStringsAndComments(code),
    /\bforceLiterals\b/gi,
    'SEL002',
    'warning',
    'Avoid forceLiterals: it reveals the where-clause values to the query optimiser and, ' +
    'with values that come from user input, exposes the statement to SQL injection. ' +
    'Use forcePlaceholders (the default for non-join selects) or omit the hint. ' +
    'Standard code uses it only where the plan measurably needs the literal.',
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
 * The body of the method whose declaration starts at `declIdx`, as masked lines,
 * located by brace depth. Returns [] when the declaration has no body.
 */
function methodBodyLines(maskedLines: string[], declIdx: number): string[] {
  let depth = 0;
  let started = false;
  const body: string[] = [];
  for (let i = declIdx; i < maskedLines.length; i++) {
    const line = maskedLines[i];
    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') depth--;
    }
    if (started) {
      if (i > declIdx) body.push(line);
      if (depth <= 0) break;
    } else if (i > declIdx + 2) {
      break; // a declaration with no body within reach (interface method, abstract)
    }
  }
  return body;
}

/** True when the method declared at `declIdx` calls `next` — i.e. it is a CoC wrapper. */
function methodBodyCallsNext(maskedLines: string[], declIdx: number): boolean {
  return methodBodyLines(maskedLines, declIdx).some(l => /\bnext\s+[A-Za-z_]/.test(l));
}

/**
 * The class declaration that follows line `fromIdx`, skipping doc comments and blank
 * lines. Scanning the raw text found `class` inside `/// Extends the <c>X</c> class …`
 * and reported the comment as the declaration (COC003 on
 * ProjVersioningPurchaseOrder_Extension), so the search runs on masked lines where
 * comment content is blank.
 */
function classDeclarationAfter(
  maskedLines: string[],
  fromIdx: number,
  maxLookahead = 12,
): { index: number; text: string } | null {
  const end = Math.min(fromIdx + maxLookahead, maskedLines.length - 1);
  for (let j = fromIdx; j <= end; j++) {
    if (/\bclass\b/i.test(maskedLines[j])) return { index: j, text: maskedLines[j] };
  }
  return null;
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
  const maskedLines = maskStringsAndComments(code).split('\n');
  lines.forEach((rawLine, i) => {
    if (rawLine.trimStart().startsWith('//')) return;
    // Only a CoC WRAPPER inherits the base signature; a brand-new method that an
    // extension class merely adds may carry defaults like any other method, and the
    // platform ships 20 such classes (HRMAbsenceCode_AppSuite_Extension.findByJobId,
    // SalesLineType_ApplicationSuite_Extension.saveStockPurchaseLine, …). The
    // distinguishing mark is a call to next inside the body.
    if (!methodBodyCallsNext(maskedLines, i)) return;
    // Method-like line with a default param: "public Foo method(Type _p = val)".
    // The second alternative catches declarations with NO access modifier (legal
    // X++ — members default to public). get_method's CoC template deliberately
    // strips access modifiers, so a modifier-only regex misses the single most
    // likely source of this defect: an agent pasting that template verbatim.
    // It is anchored to a whole-line declaration (no trailing ';') so that call
    // statements containing '=' inside parens — strFmt("a = %1", x) — don't match.
    const withModifier = /\b(public|protected|private|internal)\b.*\([^)]*=\s*[^,)]+\)/.test(rawLine);
    const bareDeclaration =
      /^\s*(?:(?:static|final|abstract|display|edit|server|client)\s+)*[A-Za-z_]\w*\s+[A-Za-z_]\w*\s*\([^)]*=\s*[^,)]+\)\s*$/.test(rawLine);
    if (withModifier || bareDeclaration) {
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
  const maskedLines = maskStringsAndComments(code).split('\n');
  for (let i = 0; i < maskedLines.length; i++) {
    if (!/\[\s*ExtensionOf/i.test(maskedLines[i])) continue;
    const decl = classDeclarationAfter(maskedLines, i);
    if (!decl) continue;
    // final = a CoC class (wrappers); static = an extension-method class. Both carry
    // [ExtensionOf] and both compile — the platform ships static ones, e.g.
    // TaxCalculationAdjustment_ApplicationSuite_Extension.
    if (!/\bfinal\b/i.test(decl.text) && !/\bstatic\b/i.test(decl.text)) {
      violations.push({
        rule: 'COC002',
        severity: 'error',
        line: decl.index + 1,
        excerpt: lines[decl.index]?.trim() ?? decl.text.trim(),
        fix: 'An [ExtensionOf] class must be final (Chain of Command wrappers) or static ' +
          '(extension methods): "[ExtensionOf(...)] final class MyClass_Extension". ' +
          'Without either the compiler rejects the file.',
      });
    }
    i = decl.index;
  }
  return violations;
}

/**
 * COC003 — [ExtensionOf] class name not ending in _Extension.
 */
function checkExtensionOfNaming(code: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const lines = code.split('\n');
  const maskedLines = maskStringsAndComments(code).split('\n');
  for (let i = 0; i < maskedLines.length; i++) {
    if (!/\[\s*ExtensionOf/i.test(maskedLines[i])) continue;
    const decl = classDeclarationAfter(maskedLines, i);
    if (!decl) continue;
    const m = /\bclass\s+(\w+)/i.exec(decl.text);
    // Case-insensitively: the platform itself ships
    // `[ExtensionOf(classStr(JournalCheckPost))] internal final class
    // JournalCheckPostIV_extension`, and X++ identifiers are case-insensitive, so
    // a lower-case suffix is the convention kept, not broken.
    if (m && !/_extension$/i.test(m[1])) {
      violations.push({
        rule: 'COC003',
        severity: 'error',
        line: decl.index + 1,
        excerpt: lines[decl.index]?.trim() ?? decl.text.trim(),
        fix: `Rename class to "${m[1]}_Extension". ` +
          'Extension classes must end with _Extension per MS naming guidelines.',
      });
    }
    i = decl.index;
  }
  return violations;
}

/** Global functions, not members of `Common` — unqualified on a table buffer. */
const GLOBAL_FUNCTIONS_NOT_ON_TABLE = [
  'checkFailed', 'error', 'warning', 'info', 'strFmt', 'setPrefix', 'funcName',
];

/**
 * COC005 — a Global function called as `this.<fn>()` on a table buffer.
 *
 * `this.checkFailed(...)` reads as consistent next to `this.orig()`, and xppc
 * rejects it with ClassDoesNotContainMethod. Nothing but a build caught it:
 * xppbp does not diagnose it and the symbol index resolves the name.
 *
 * Scoped to `[ExtensionOf(tableStr(...))]` — on a RunBase descendant the same
 * call is legal.
 */
function checkGlobalFunctionOnTableBuffer(code: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  if (!/\[ExtensionOf\s*\(\s*tableStr\s*\(/i.test(code)) return violations;

  const lines = code.split('\n');
  const masked = maskStringsAndComments(code).split('\n');
  const pattern = new RegExp(
    `\\bthis\\s*\\.\\s*(${GLOBAL_FUNCTIONS_NOT_ON_TABLE.join('|')})\\s*\\(`,
    'gi',
  );

  masked.forEach((clean, i) => {
    pattern.lastIndex = 0;
    const m = pattern.exec(clean);
    if (!m) return;
    const fn = m[1];
    violations.push({
      rule: 'COC005',
      severity: 'error',
      line: i + 1,
      excerpt: lines[i].trim(),
      fix:
        `"${fn}" is a Global function, not a method of the table buffer. The compiler rejects ` +
        `"this.${fn}(…)" with "Table '<name>' does not contain a definition for method '${fn}'". ` +
        `Call it unqualified: "${fn}(…)"` +
        (fn === 'checkFailed'
          ? ' — the idiom in a validateWrite wrapper is "ret = checkFailed(\'@Model:LabelId\');".'
          : '.'),
    });
  });

  return violations;
}

/**
 * COC006 — re-reading the record the buffer already holds, instead of `this.orig()`.
 *
 * Inside `[ExtensionOf(tableStr(X))]`, `this` IS the record: the current values are
 * its fields and the values it was fetched with are `this.orig()`, a buffer already
 * in memory. Fetching the row again by its own RecId buys nothing and costs a
 * database round trip on every write of the table — and it is not even the same
 * answer, because it reads the CURRENT stored state rather than this buffer's
 * pre-image.
 *
 * It compiles, xppbp has nothing to say about it and the build is green, so
 * nothing else in the toolchain reports it: SEL004 only sees a nested
 * `while select`, and the rest of the set is about compile failures.
 *
 * `RecId == this.RecId` is the whole signal and it is self-identifying: RecIds are
 * unique per table, so comparing another buffer's to this one's is only meaningful
 * when the other buffer is this same record. The static-find spelling
 * (`MyTable::findRecId(this.RecId)`) is the same defect and is matched too.
 *
 * severity 'warning' — the code runs and returns the right answer in the common
 * case. It is a round trip and a semantic drift, not a broken build.
 */
function checkRecordReReadInTableCoc(code: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  if (!/\[ExtensionOf\s*\(\s*tableStr\s*\(/i.test(code)) return violations;

  const masked = maskStringsAndComments(code);
  const lines = code.split('\n');
  const reported = new Set<number>();

  const report = (offset: number, excerptSuffix: string, spelling: string) => {
    const lineNo = lineNumber(masked, offset);
    if (reported.has(lineNo)) return;
    reported.add(lineNo);
    violations.push({
      rule: 'COC006',
      severity: 'warning',
      line: lineNo,
      excerpt: lines[lineNo - 1]?.trim() ?? excerptSuffix,
      fix:
        `This re-reads the record the buffer already holds. Inside a table CoC, ${spelling} ` +
        'the pre-image is `this.orig()` — already in memory, filled when the record was fetched — ' +
        'and the new values are `this` itself. Compare `this.MyField` against `this.orig().MyField` ' +
        'and delete the lookup: it costs a database round trip on every write of the table, and it ' +
        'returns the CURRENT stored state, not the values this buffer was fetched with. ' +
        'On an insert `this.orig()` is empty, so `this.orig().RecId == 0` is the "new record" test.',
    });
  };

  // A select whose where clause ties another buffer's RecId to this one's. The
  // where clause is usually on its own line, so the statement — up to its ';' or
  // the '{' of a while select — is the unit to scan, not the line.
  const selectRe = /\bselect\b/gi;
  const sameRecId =
    /(?:\w+\s*\.\s*RecId\s*==\s*this\s*\.\s*RecId)|(?:this\s*\.\s*RecId\s*==\s*\w+\s*\.\s*RecId)/i;
  let m: RegExpExecArray | null;
  while ((m = selectRe.exec(masked)) !== null) {
    const semi = masked.indexOf(';', m.index);
    const brace = masked.indexOf('{', m.index);
    const ends = [semi, brace].filter(i => i !== -1);
    const end = ends.length > 0 ? Math.min(...ends) : masked.length;
    const span = masked.slice(m.index, end);
    const hit = sameRecId.exec(span);
    if (hit) report(m.index + hit.index, hit[0], 'a select on the same table is never the way to it —');
  }

  // The same fetch spelled as a static find.
  const findRe = /\b\w+\s*::\s*find\w*\s*\(([^)]*)\)/gi;
  while ((m = findRe.exec(masked)) !== null) {
    if (!/\bthis\s*\.\s*RecId\b/i.test(m[1])) continue;
    report(m.index, m[0], 'a find() on your own RecId is never the way to it —');
  }

  return violations;
}

/**
 * BP005 — an enum's SYMBOL feeding user-facing text.
 *
 * `enum2Symbol()` / `DictEnum.value2Symbol()` return the AOT name ('Gold'), which is
 * not a label and is never translated, so a message built from one stays English on a
 * Czech or Slovak client no matter how carefully the enum was labelled.
 *
 * NOT enum2str, which this rule used to flag: enum2str resolves the value's <Label> in
 * the session language, and the platform ships it inside checkFailed, throw error and
 * control captions. `Global::enum2Symbol` is itself `new DictEnum(_id).value2Symbol()`
 * — a separate function for the symbol only makes sense because enum2str is not it.
 * DictEnum.value2Label remains the answer when the enum type is known only at runtime.
 *
 * Scoped to the message builders (info/warning/error/checkFailed/strFmt): a symbol is
 * correct for a log line, a filename or a comparison key, and it is the only safe thing
 * to persist for an extensible enum, whose integers are assigned at deployment time.
 *
 * Matched over the call's whole argument span: in a wrapped
 * `checkFailed(strFmt("@M:Id",\n enum2Symbol(a),\n enum2Symbol(b)))` the message
 * builder and the symbol call never share a line, which a per-line scan misses.
 */
function checkEnumSymbolInMessage(code: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const masked = maskStringsAndComments(code);
  const lines = code.split('\n');
  const reported = new Set<number>();

  const callRe = /\b(?:info|warning|error|checkFailed|strFmt)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(masked)) !== null) {
    // Walk from the opening paren to its match so nested calls and multi-line
    // argument lists are one span.
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < masked.length; end++) {
      const ch = masked[end];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const span = masked.slice(m.index, Math.min(end + 1, masked.length));

    // Both spellings: the Global wrapper and the DictEnum method it delegates to.
    const inner = /(?:\benum2Symbol|\.\s*value2Symbol)\s*\(/gi;
    let hit: RegExpExecArray | null;
    while ((hit = inner.exec(span)) !== null) {
      const lineNo = lineNumber(masked, m.index + hit.index);
      if (reported.has(lineNo)) continue;
      reported.add(lineNo);
      violations.push({
        rule: 'BP005',
        severity: 'warning',
        line: lineNo,
        excerpt: lines[lineNo - 1].trim(),
        fix:
          'This prints the enum\'s AOT name, which is never translated — the message stays English in ' +
          'every locale. Use enum2str(value) when the enum type is known at compile time; when it is ' +
          'only known at runtime, new DictEnum(enumId).value2Label(value). Keep the symbol for logs, ' +
          'filenames and anything persisted.',
      });
    }
  }

  return violations;
}

/**
 * The built-ins FN001 knows the arity of.
 *
 * Deliberately tiny, and all one family: these convert between an enum, its
 * label and its symbol, they are the ones a caller reaches for in the same
 * breath, and they do NOT agree on how many arguments they take. That is the
 * whole trap — enum2Str takes the value alone, its neighbours take an enum id
 * AND a value, so the wrong one of the pair compiles in the head and not in
 * xppc. Adding a built-in here is only safe when its arity is genuinely fixed:
 * one with an optional parameter belongs nowhere near this rule.
 */
/**
 * Extra guidance for the built-ins whose arity is a documented trap. The ARITY
 * itself is never written here — it comes from the compiler's own answer (see
 * src/knowledge/compilerFacts.ts); this map only adds the sentence that explains
 * why the wrong count looked right.
 */
const BUILTIN_ARITY_NOTES: Record<string, string> = {
  enum2str: 'enum2Str(value) — the value alone. It resolves that value\'s <Label> in the session language, which is why it needs no enum id',
  enum2symbol: 'enum2Symbol(enumNum(MyEnum), value) — enum id AND value',
  symbol2enum: 'symbol2Enum(enumNum(MyEnum), symbolString) — enum id AND symbol',
  enumnum: 'enumNum(MyEnum) — the enum TYPE name alone, not a value',
  substr: 'subStr(text, position, number) — position is 1-based',
  strfind: 'strFind(text, characters, start, count)',
  strscan: 'strScan(text, pattern, start, count)',
  conpeek: 'conPeek(container, position) — 1-based',
  condel: 'conDel(container, start, number)',
  mkdate: 'mkDate(day, month, year)',
  date2str: 'date2Str(date, sequence, day, sep1, month, sep2, year [, DateFlags]) — the 8th argument is optional',
  datetime2str: 'datetime2Str(utcdatetime [, DateFlags]) — the flags argument is optional',
  num2str: 'num2Str(value, characters, decimals, decimalSeparator, thousandSeparator)',
  fieldid2name: 'fieldId2Name(tableId, fieldId [, arrayIndex])',
  ssrsreportstr: 'ssrsReportStr(MyReport, MyDesign) — report AND design name; the design must exist inside that AxReport (scaffolded reports name it Report)',
};

/**
 * Arguments in the call whose '(' sits at `open`, or null when the parentheses
 * never close — a snippet cut mid-call is not something to have an opinion about.
 *
 * Counts top-level commas only, so a nested call or an indexer contributes none.
 * Runs on masked source, where a comma inside a string literal is already a space.
 */
function countCallArguments(masked: string, open: number): number | null {
  let parens = 0;
  let brackets = 0;
  let commas = 0;
  let hasContent = false;

  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(') { parens++; continue; }
    if (ch === ')') {
      parens--;
      if (parens === 0) return hasContent ? commas + 1 : 0;
      continue;
    }
    if (ch === '[') { brackets++; continue; }
    if (ch === ']') { brackets--; continue; }
    if (parens === 1 && brackets === 0 && ch === ',') { commas++; continue; }
    if (!/\s/.test(ch)) hasContent = true;
  }

  return null;
}

/**
 * FN001 — a fixed-arity built-in called with the wrong number of arguments.
 *
 * xppc catches every one of these, but only after a build, and that is the cost:
 * run 7b8de4ba shipped `enum2Str(this.orig().X), enum2Str(this.X)` as a 2-argument
 * call, which bought a 76 s failed compile, a repair round trip and two more
 * builds — ~9 AIU and 130 s for a mistake visible in the source as written. The
 * knowledge base offers `enum2Symbol(enumNum(…), any2Int(…))` as its only
 * conversion example, so reaching for the 2-argument shape is the documented
 * confusion, not a careless one.
 *
 * Runs on every write through inlineXppValidation, which is the point: the reply
 * to the d365fo_file call that creates the CoC class already carries the finding.
 *
 * severity 'error' — this is a compile failure, not a preference.
 */
/**
 * Words that may legally precede a predefined-function CALL. Anything else that is
 * a bare identifier in front of `name(` marks a method DECLARATION (`Type name()`).
 */
const CALL_PRECEDING_KEYWORDS = new Set([
  'return', 'if', 'while', 'for', 'switch', 'case', 'throw', 'else', 'do', 'and', 'or',
  'not', 'select', 'where', 'join', 'setting', 'by', 'in', 'next', 'new', 'super', 'print',
]);

/**
 * Does this source declare a local function (or a method) with that name?
 *
 * X++ resolves a bare call in three places, in the order the compiler's own error
 * text lists them: a predefined function, a static on Global, "nor a previously
 * defined local function". A local function therefore SHADOWS a predefined name,
 * and its signature is the one that counts — so any arity claim about the
 * predefined version is wrong for the rest of that source.
 *
 * Deliberately file-wide rather than scope-accurate: this decides whether to STAY
 * SILENT, and for an error-severity rule the safe direction is silence.
 */
function declaresLocalFunction(masked: string, name: string): boolean {
  const re = new RegExp(
    String.raw`\b(?:void|int|int64|str|boolean|real|container|date|utcdatetime|anytype|guid|` +
    String.raw`[A-Z]\w*)\s+${name}\s*\([^)]*\)\s*[\r\n]*\s*\{`,
    'i',
  );
  return re.test(masked);
}

function checkBuiltinArity(code: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const masked = maskStringsAndComments(code);
  const lines = code.split('\n');

  const callRe = /\b([A-Za-z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(masked)) !== null) {
    const called = m[1];
    const intrinsic = intrinsicInfo(called);
    const runtime = intrinsic ? null : runtimeFunctionInfo(called);
    const unknown = !intrinsic && !runtime && isUnknownFunction(called);
    if (!intrinsic && !runtime && !unknown) continue;
    // Variadic — the compiler has no count to check (strFmt, conIns, max, min).
    if (runtime && runtime.arity.max === 'variadic') continue;
    // `something.enum2Str(…)` is a method on another type, not the global.
    const before = masked.slice(0, m.index).trimEnd();
    if (before.endsWith('.')) continue;
    // `MyClass::year(…)` is that class's own static; only Global:: shares the
    // predefined names.
    if (before.endsWith('::') && !/\bGlobal\s*::$/.test(before)) continue;
    // A DECLARATION, not a call: `public IntEditAdaptor Year()` in a form adaptor
    // reads as a call to the predefined year() unless the preceding token is
    // recognised as a type name. In a call the previous token is an operator, a
    // separator or a statement keyword — never a bare identifier.
    const prevToken = /([A-Za-z_]\w*)\s*$/.exec(before)?.[1];
    if (prevToken && !CALL_PRECEDING_KEYWORDS.has(prevToken.toLowerCase())) continue;
    // `new Info()` is a constructor, not a call to the predefined info(). `new` has
    // to stay in the keyword set above (it precedes real calls too), so the
    // constructor form is excluded here.
    if (prevToken?.toLowerCase() === 'new') continue;
    // A LOCAL FUNCTION shadows a predefined name, and the compiler says so in its
    // own error text: "…nor a previously defined local function". BatchRun declares
    // `void info() { … }` and then calls `info();` with no arguments, which FN001
    // read as the predefined info() being called with too few.
    if (declaresLocalFunction(masked, called)) continue;

    const lineNo = lineNumber(masked, m.index);
    const excerpt = lines[lineNo - 1].trim();

    if (unknown) {
      violations.push({
        rule: 'FN002',
        severity: 'error',
        line: lineNo,
        excerpt,
        fix:
          `${called} is not a predefined function on this platform (xppc ${COMPILER_VERSION}): ` +
          `"The name '${called}' does not denote a predefined function, a static method on the Global ` +
          'class nor a previously defined local function". It reads as one because AX 2012 had it — ' +
          'call get_knowledge(topic="runtime-functions") for the function that replaced it.',
      });
      continue;
    }

    const actual = countCallArguments(masked, m.index + m[0].length - 1);
    if (actual === null) continue;

    const note = BUILTIN_ARITY_NOTES[called.toLowerCase()];
    if (intrinsic) {
      if (actual === intrinsic.args) continue;
      violations.push({
        rule: 'FN001',
        severity: 'error',
        line: lineNo,
        excerpt,
        fix:
          `${intrinsic.name} is a compile-time intrinsic taking ${intrinsic.args} argument(s); ` +
          `${actual} given.${note ? ` ${note}.` : ''}`,
      });
      continue;
    }

    const arity = runtime!.arity;
    if (acceptsArgumentCount(arity, actual)) continue;
    const expected = arity.max === 'variadic' ? arity.min : arity.max;
    violations.push({
      rule: 'FN001',
      severity: 'error',
      line: lineNo,
      excerpt,
      fix:
        `${runtime!.name} takes ${describeArity(arity)}; ${actual} given. xppc rejects this with ` +
        `"'${runtime!.name}' expects ${expected} argument(s), but ${actual} specified"` +
        (actual < arity.min ? ` or "is missing argument ${arity.min}"` : '') +
        `.${note ? ` ${note}.` : ''}`,
    });
  }

  return violations;
}

/**
 * COC004 — `next` not reached exactly once and unconditionally (compiler SYS10028).
 *
 * The X++ compiler rejects a CoC method whose `next` sits inside an `if`, is called
 * twice, or can be skipped by an earlier `return`. It is the one CoC mistake that
 * looks completely reasonable as ordinary X++ — `if (ret) { ret = next foo(); }` is
 * how you would write a short-circuit anywhere else — and neither run_bp_check nor
 * the reference checks catch it, because xppbp does not diagnose it and every symbol
 * in the method resolves fine. Only a build did, which meant it was only ever found
 * by whoever remembered to run one.
 *
 * Brace depths are counted on the masked copy, so a '{' inside a literal or a doc
 * comment cannot shift the method boundaries.
 */
function checkCocNextUnconditional(code: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  if (!/\[ExtensionOf\s*\(/i.test(code)) return violations;

  const lines = code.split('\n');
  const masked = maskStringsAndComments(code).split('\n');
  const METHOD_DECL =
    /^\s*(?:(?:public|protected|private|internal|static|final|display|edit|server|client)\s+)*[A-Za-z_]\w*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*$/;

  let depth = 0;
  let classBodyDepth: number | null = null;
  // The method currently being walked, if any.
  let method: { name: string; bodyDepth: number; nexts: Array<{ line: number; excerpt: string; conditional: boolean }>; earlyReturn: number | null } | null = null;

  const closeMethod = (): void => {
    if (!method) return;
    const { name, nexts, earlyReturn } = method;

    for (const n of nexts) {
      if (n.conditional) {
        violations.push({
          rule: 'COC004',
          severity: 'error',
          line: n.line,
          excerpt: n.excerpt,
          fix:
            `"next ${name}" is inside a conditional block. The compiler rejects this with ` +
            'SYS10028 "Call to \'next\' should be done only once and unconditionally". ' +
            `Call it as the first statement instead — "ret = next ${name}();" — then apply the ` +
            'business rule afterwards and use "ret = checkFailed(\'@Model:Label\')" to fail the write.',
        });
      }
    }

    if (nexts.length > 1) {
      violations.push({
        rule: 'COC004',
        severity: 'error',
        line: nexts[1].line,
        excerpt: nexts[1].excerpt,
        fix:
          `"next ${name}" is called ${nexts.length} times in one CoC method; SYS10028 allows exactly one. ` +
          'Store the single result in a local and reuse it.',
      });
    }

    if (earlyReturn !== null && nexts.length > 0 && earlyReturn < nexts[0].line) {
      violations.push({
        rule: 'COC004',
        severity: 'error',
        line: earlyReturn,
        excerpt: lines[earlyReturn - 1].trim(),
        fix:
          `This "return" can skip "next ${name}" below it, so the call is not unconditional (SYS10028). ` +
          `Call "next ${name}" first, then let the rule decide the return value.`,
      });
    }

    method = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const clean = masked[i] ?? '';
    const depthAtLineStart = depth;

    if (classBodyDepth === null && /\bclass\b/i.test(clean) && clean.includes('{')) {
      classBodyDepth = depthAtLineStart + 1;
    } else if (classBodyDepth === null && /\bclass\b/i.test(clean)) {
      // Brace on the following line — the class body opens one deeper than here.
      classBodyDepth = depthAtLineStart + 1;
    }

    if (method) {
      const nextCall = new RegExp(`\\bnext\\s+${method.name}\\b`).exec(clean);
      if (nextCall) {
        method.nexts.push({
          line: i + 1,
          excerpt: lines[i].trim(),
          // Deeper than the method body means it sits inside if/while/switch/try;
          // the same-line form "if (ret) ret = next foo();" never opens a block.
          conditional: depthAtLineStart > method.bodyDepth || /\b(if|while|for|switch|case)\b/.test(clean),
        });
      } else if (
        method.earlyReturn === null &&
        depthAtLineStart > method.bodyDepth &&
        /\breturn\b/.test(clean)
      ) {
        method.earlyReturn = i + 1;
      }
    } else if (classBodyDepth !== null && depthAtLineStart === classBodyDepth) {
      const decl = METHOD_DECL.exec(clean);
      if (decl && !/\bnew\s*\(/.test(clean)) {
        method = { name: decl[1], bodyDepth: classBodyDepth + 1, nexts: [], earlyReturn: null };
      }
    }

    for (const ch of clean) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (method && depth < method.bodyDepth) closeMethod();
      }
    }
  }
  closeMethod();

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
    // Match: info("...") / warning('...') / error("...") / checkFailed("...")
    // where the first argument is a raw string (not starting with @).
    // Both quote styles count — the platform writes single-quoted literals as often
    // as double-quoted ones. The lookbehind keeps the rule off member calls such as
    // AifChangeTrackingEventSource::…Info("…") and this.error(…) on a logger: only
    // the Global functions carry the label obligation.
    const pattern = /(?<![.\w:])(?:info|warning|error|checkFailed)\s*\(\s*(["'])(?!@)([^"']{1,200})\1/gi;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(rawLine)) !== null) {
      violations.push({
        rule: 'BP001',
        // xppc compiles a hardcoded string; xppbp reports BPErrorLabelIsText.
        severity: 'warning',
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
 * Warning, not error: xppbp raises BPCheckAlternateKeyAbsent as a warning and the
 * table still builds. As an error it made a legitimately single-index table
 * unsatisfiable (eval #7).
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
      severity: 'warning',
      excerpt: '<AxTable> — no index with <AlternateKey>Yes</AlternateKey>',
      fix: 'Add an <AxTableIndex> with <AlternateKey>Yes</AlternateKey> unless the table ' +
        'deliberately has none — xppbp reports BPCheckAlternateKeyAbsent as a warning and ' +
        'the table still builds. generate_object(mode="scaffold") adds one via buildPrimaryKeyIndex.',
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
  const lines = masked.split('\n');

  // Count per top-level brace block — i.e. per method when the input is a method
  // source or a concatenated class. Counting across the whole text conflated
  // separate methods and reported 21 shipped classes as unbalanced: one method
  // opening two transactions and another closing three is not a defect.
  type Region = { line: number; begins: number; commits: number; aborts: number };
  const regions: Region[] = [];
  let current: Region | null = null;
  let depth = 0;
  lines.forEach((line, i) => {
    if (depth === 0 && line.includes('{')) current = { line: i + 1, begins: 0, commits: 0, aborts: 0 };
    const target = current;
    if (target) {
      target.begins += (line.match(/\bttsbegin\b/gi) ?? []).length;
      target.commits += (line.match(/\bttscommit\b/gi) ?? []).length;
      target.aborts += (line.match(/\bttsabort\b/gi) ?? []).length;
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth <= 0 && target) { regions.push(target); current = null; depth = 0; }
  });
  if (current) regions.push(current);
  if (regions.length === 0) {
    regions.push({
      line: 1,
      begins: (masked.match(/\bttsbegin\b/gi) ?? []).length,
      commits: (masked.match(/\bttscommit\b/gi) ?? []).length,
      aborts: (masked.match(/\bttsabort\b/gi) ?? []).length,
    });
  }

  const violations: ValidationViolation[] = [];
  for (const r of regions) {
    if (r.begins === 0 && r.commits === 0) continue;
    if (r.begins === r.commits) continue;
    // ttsabort closes a transaction too, so a guard clause that aborts on one path
    // legitimately leaves fewer commits than begins.
    if (r.begins > r.commits && r.begins <= r.commits + r.aborts) continue;
    violations.push({
      rule: 'TTS001',
      severity: 'warning',
      line: r.line,
      excerpt: `ttsbegin × ${r.begins}, ttscommit × ${r.commits}` +
        (r.aborts ? `, ttsabort × ${r.aborts}` : ''),
      fix: 'Balance every ttsbegin with a matching ttscommit (or a ttsabort on the failure path). ' +
        'An unmatched ttsbegin leaves the transaction open; an unmatched ttscommit throws at runtime.',
    });
  }
  return violations;
}

/**
 * BP004 — Developer-only statements left in code (pause / print).
 * These block the AOS / write to the console and must not ship.
 */
function checkDevArtifacts(code: string): ValidationViolation[] {
  return matchAll(
    maskStringsAndComments(code),
    /^\s*(?:print|breakpoint)\b/gm,
    'BP004',
    'warning',
    'Remove developer-only statements (print / breakpoint) before shipping — they still ' +
    'compile but go nowhere useful in the cloud. Use the Infolog (info/warning) or telemetry.',
  );
}

/**
 * BP006 — statements that were REMOVED from the language.
 *
 * pause, window, tableLock and changeSite are no longer keywords (they are absent
 * from the parser's reserved-word set), so xppc does not report them as deprecated:
 * it reports a syntax error, and the message names the token rather than the
 * statement — "Invalid token '10'" for `window 10, 10;`, "does not denote a class,
 * a table, or an extended data type" for `tableLock T;`. Code carried over from AX
 * 2012 fails here first, and the message does not say why.
 */
function checkRemovedStatements(code: string): ValidationViolation[] {
  const masked = maskStringsAndComments(code);
  const violations: ValidationViolation[] = [];
  const removed: Array<{ re: RegExp; fix: string }> = [
    {
      re: /^\s*pause\s*;/gm,
      fix: 'pause was removed from X++ (xppc: "Invalid token \';\'"). Delete it — a batch or ' +
        'a service has no console to pause.',
    },
    {
      re: /^\s*window\s+\d/gm,
      fix: 'window was removed from X++ (xppc: "Invalid token"). Delete it together with the ' +
        'print statements it sized.',
    },
    {
      re: /^\s*tableLock\b/gm,
      fix: 'tableLock was removed from X++ (xppc: "The name \'tableLock\' does not denote a class, ' +
        'a table, or an extended data type"). Use the select lock hints (pessimisticLock, ' +
        'optimisticLock) or a transaction scope.',
    },
    {
      re: /\bchangeSite\s*\(/gi,
      fix: 'changeSite was removed from X++ (xppc: "\';\' expected"). Use changeCompany, or set ' +
        'the site through the record\'s InventDim.',
    },
  ];
  for (const r of removed) {
    violations.push(...matchAll(masked, r.re, 'BP006', 'error', r.fix));
  }
  return violations;
}

/**
 * MAC001 — a precompiler directive written without its dot.
 *
 * `#define X(1)` does not define anything: the precompiler reads `#define` as a
 * macro REFERENCE, and the failure surfaces far away as "The macro 'define' is not
 * defined". Every directive that names a macro takes the dot form (#define.Name,
 * #localmacro.Name, #macrolib.Library, #if.Name, #ifnot.Name, #undef.Name).
 */
function checkMacroDirectiveForm(code: string): ValidationViolation[] {
  return matchAll(
    code,
    /^\s*#(define|localmacro|macro|macrolib|globaldefine|globalmacro|if|ifnot|undef|defInc|defDec)\s+\w/gim,
    'MAC001',
    'error',
    'Precompiler directives that name a macro use a DOT, not a space: "#define.MyMacro(42)", ' +
    '"#localmacro.MyBlock", "#macrolib.MyLibrary", "#if.MyMacro". Written with a space the ' +
    'precompiler reads the directive as a macro reference and reports ' +
    '"The macro \'define\' is not defined".',
    false,
  );
}

/**
 * CS001 — C# constructs that do not exist in X++.
 *
 * Every one of these is a guaranteed compile failure that reads perfectly
 * naturally to anyone who writes C# all day, which is exactly why they slip
 * into generated X++: string interpolation, lambdas, foreach, ?? and the
 * `string` type name. The fix message carries the X++ equivalent so the
 * repair is one edit, not a search.
 */
function checkCSharpIsms(code: string): ValidationViolation[] {
  const masked = maskStringsAndComments(code);
  const violations: ValidationViolation[] = [];
  const patterns: Array<{ re: RegExp; fix: string }> = [
    {
      re: /\$"/g,
      fix: 'X++ has no string interpolation ($"…") — use strFmt("%1 / %2", a, b).',
    },
    {
      re: /=>/g,
      fix: 'X++ has no lambdas/anonymous methods (=>) — use a named (private) method, or a delegate plus an eventhandler subscription.',
    },
    {
      re: /\bforeach\b/g,
      fix: 'X++ has no foreach — iterate collections with their Enumerator (while (en.moveNext()) { en.current(); }) and tables with while select.',
    },
    {
      re: /\?\?/g,
      fix: 'X++ has no null-coalescing operator (??) — value types hold null-EQUIVALENT values (0, empty string, 1900-01-01); test explicitly.',
    },
    {
      re: /\bstring\s+\w+\s*[;=]/g,
      fix: 'The X++ string type is str (or an EDT) — "string" is C#.',
    },
    {
      // xppc: "The name 'bool' does not denote a class, a table, or an extended data type."
      re: /\b(?:bool|decimal|double|long|uint)\s+\w+\s*[;=,)]/g,
      fix: 'C# primitive names do not exist in X++: use boolean, real, int64 and int. ' +
        'There are no unsigned types.',
    },
    {
      // xppc: "';' expected." — X++ has no override/virtual; every non-final
      // instance method is virtual and redeclaring the signature overrides it.
      re: /\b(?:public|protected|private|internal)\s+(?:override|virtual)\b/g,
      fix: 'X++ has no override/virtual keywords — redeclare the method with the same signature ' +
        'to override it, and mark it final to forbid further overriding.',
    },
    {
      // xppc: "Conflicting modifiers 'protected private'."
      re: /\bprivate\s+protected\b/g,
      fix: 'private protected is not an X++ access combination ("Conflicting modifiers"). ' +
        'protected internal does compile.',
    },
    // NO generics rule. `List<str>` fails in a sandbox model with "The name 'List<str>'
    // does not denote a class, a table, or an extended data type" — but that is a
    // RESOLUTION failure, not a syntax one ("Class 'List<str>' was not found. Are you
    // missing a module reference?"), and ApplicationSuite ships
    // `private List<str> operatingUnitNumbers;` plus
    // `Microsoft.Dynamics.Ax.Xpp.FormObservable<int> tracker;`. An offline rule cannot
    // tell which references a model has, so this one would report Microsoft's own
    // compiling code. It stays knowledge (xpp-class-rules) until a probe explains
    // which reference makes the bare form resolve.
    {
      // xppc: "')' expected." — the catch variable must be DECLARED first and then
      // named alone: `System.Exception ex; … catch (ex)`.
      re: /\bcatch\s*\(\s*(?:System|Microsoft)\.[\w.]+\s+\w+\s*\)/g,
      fix: 'X++ cannot declare the exception variable in the catch: declare it first ' +
        '("System.ArgumentException ex;") and write catch (ex).',
    },
  ];
  // A `using` ALIAS makes a C#-looking name legal X++. GlobalUnifiedPricing ships
  // 448 files that open with
  //     using string  = System.String;
  //     using decimal = System.Decimal;
  // and then declare `public string ConstructGroupKey(...)` — which compiles,
  // because `string` now denotes a CLR type. Flagging those was 3 error-severity
  // findings on shipped code, and the same alias form is what dotnet-interop teaches.
  const aliased = new Set(
    [...masked.matchAll(/\busing\s+([A-Za-z_]\w*)\s*=/g)].map(m => m[1].toLowerCase()),
  );

  for (const p of patterns) {
    for (const v of matchAll(masked, p.re, 'CS001', 'error', p.fix)) {
      const name = /^([A-Za-z_]\w*)/.exec(v.excerpt)?.[1]?.toLowerCase();
      if (name && aliased.has(name)) continue;
      violations.push(v);
    }
  }
  return violations;
}

/**
 * TTS002 — a catch inside an open ttsbegin/ttscommit scope that can never fire.
 *
 * Inside a transaction only Exception::UpdateConflict and
 * Exception::DuplicateKeyException are deliverable to an INNER catch, and only
 * when named explicitly — everything else aborts the transaction and unwinds
 * to the first catch OUTSIDE the tts block. A bare `catch` inside tts is the
 * classic shape (see the WRONG example in the transactions knowledge topic):
 * it looks defensive and is dead code.
 *
 * Depth is approximated by counting ttsbegin minus ttscommit/ttsabort before
 * the catch on the masked source — heuristic, hence warning severity.
 */
function checkCatchInsideTts(code: string): ValidationViolation[] {
  const masked = maskStringsAndComments(code);
  if (!/\bttsbegin\b/i.test(masked)) return [];
  const violations: ValidationViolation[] = [];
  const catchRe = /\bcatch\b\s*(?:\(([^)]*)\))?/g;
  let m: RegExpExecArray | null;
  while ((m = catchRe.exec(masked)) !== null) {
    const before = masked.slice(0, m.index);
    const depth =
      (before.match(/\bttsbegin\b/gi)?.length ?? 0) -
      (before.match(/\bttscommit\b/gi)?.length ?? 0) -
      (before.match(/\bttsabort\b/gi)?.length ?? 0);
    if (depth <= 0) continue;
    const filter = m[1] ?? '';
    if (/(?:UpdateConflict|DuplicateKeyException)\b/i.test(filter) && !/NotRecovered/i.test(filter)) continue;
    violations.push({
      rule: 'TTS002',
      severity: 'warning',
      line: lineNumber(code, m.index),
      excerpt: m[0].trim() || 'catch',
      fix:
        'Inside an open transaction only Exception::UpdateConflict and Exception::DuplicateKeyException reach an inner catch, ' +
        'and only when named explicitly — this catch is dead code; every other exception unwinds to the first catch OUTSIDE the tts block. ' +
        'Move the try/catch outside ttsbegin/ttscommit (knowledge topic: transactions).',
    });
  }
  return violations;
}

/**
 * TTS003 — `retry` with no visible guard in its catch block.
 *
 * retry jumps back to the START of the try block and discards the infolog
 * entries logged since try entry; on a deterministic error an unguarded retry
 * loops forever. The heuristic asks only that the catch block containing the
 * retry shows SOME guard shape (a counter ++/+=, or an if) before it.
 */
function checkUnguardedRetry(code: string): ValidationViolation[] {
  const masked = maskStringsAndComments(code);
  const violations: ValidationViolation[] = [];
  const retryRe = /\bretry\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = retryRe.exec(masked)) !== null) {
    const before = masked.slice(0, m.index);
    const catchIdx = before.search(/\bcatch\b(?![\s\S]*\bcatch\b)/);
    if (catchIdx === -1) continue; // retry outside catch — the compiler rejects it
    const segment = masked.slice(catchIdx, m.index);
    if (/(\+\+|\+=|\bif\s*\()/.test(segment)) continue;
    violations.push({
      rule: 'TTS003',
      severity: 'warning',
      line: lineNumber(code, m.index),
      excerpt: 'retry;',
      fix:
        'retry jumps back to the start of the try block and discards infolog messages logged since try entry — ' +
        'unguarded, it loops forever on a deterministic error. Guard it with a counter ' +
        '(retryCount++; if (retryCount > maxRetries) throw …; retry;).',
    });
  }
  return violations;
}

/** SEL006 — `index hint` used without evidence of allowIndexHint(true). */
function checkIndexHint(code: string): ValidationViolation[] {
  const masked = maskStringsAndComments(code);
  if (/\ballowIndexHint\s*\(\s*true\s*\)/i.test(masked)) return [];
  return matchAll(
    masked,
    /\bindex\s+hint\s+\w+/gi,
    'SEL006',
    'warning',
    '"index hint" is silently IGNORED unless the buffer called allowIndexHint(true) first — and it overrides the ' +
    'optimizer, so use it only when measured. For sort order use plain "index IndexName" (no hint).',
  );
}

/** SEL007 — SQL/C# join syntax that does not exist in X++. */
function checkForeignJoinSyntax(code: string): ValidationViolation[] {
  const masked = maskStringsAndComments(code);
  const violations = matchAll(
    masked,
    /\b(?:left|right)\s+(?:outer\s+)?join\b/gi,
    'SEL007',
    'error',
    'X++ has no left/right join keywords — "outer join" IS the left outer join; there is no right outer (swap the buffers). ' +
    'Join kinds: join, outer join, exists join, notexists join.',
  );
  violations.push(...matchAll(
    masked,
    /\bjoin\s+\w+\s+on\b/gi,
    'SEL007',
    'error',
    'X++ joins have no "on" keyword — put the join criteria in the joined buffer\'s own where clause: ' +
    'join otherTable where otherTable.Field == driver.Field.',
  ));
  return violations;
}

/**
 * RPT001/RPT002 — SSRS data-provider class shape.
 *
 * A DP that reads parmDataContract() without [SRSReportParameterAttribute]
 * binds no contract (the dialog values never arrive), and a DP without a
 * single [SRSReportDataSetAttribute] getter gives SSRS no dataset to read.
 * Both compile clean and fail only at report run time, which is why they are
 * worth catching at write time. PreProcess variants are exempt from RPT001
 * (their contract can travel via the controller).
 */
function checkReportDpShape(code: string): ValidationViolation[] {
  const masked = maskStringsAndComments(code);
  const extendsMatch = masked.match(/\bextends\s+(SRSReportDataProvider(?:Base|PreProcess(?:TempDB)?))\b/i);
  if (!extendsMatch) return [];
  const violations: ValidationViolation[] = [];
  const isPreProcess = /PreProcess/i.test(extendsMatch[1]);
  // An ABSTRACT DP base declares the shared processReport()/parmDataContract() work
  // and leaves the contract to its concrete subclasses, which carry the attribute.
  // Shipped example: `abstract class CustVendAdvanceInvoiceDP extends
  // SRSReportDataProviderBase`, the base of CustAdvanceInvoice and VendAdvanceInvoice.
  const isAbstract = /\babstract\s+(?:final\s+)?class\b/i.test(masked);

  if (!isPreProcess
      && !isAbstract
      && /\bparmDataContract\s*\(/i.test(masked)
      && !/SRSReportParameterAttribute/i.test(code)) {
    violations.push({
      rule: 'RPT001',
      severity: 'error',
      line: lineNumber(code, masked.search(/\bparmDataContract\s*\(/i)),
      excerpt: 'parmDataContract() without [SRSReportParameterAttribute]',
      fix:
        'The DP reads parmDataContract() but declares no contract — add ' +
        '[SRSReportParameterAttribute(classStr(MyContract))] on the DP class, or the dialog values never reach processReport(). ' +
        'Compiles clean, fails at report run time.',
    });
  }

  if (/\bprocessReport\s*\(/i.test(masked) && !/SRSReportDataSetAttribute/i.test(code)) {
    violations.push({
      rule: 'RPT002',
      severity: 'warning',
      line: lineNumber(code, masked.search(/\bprocessReport\s*\(/i)),
      excerpt: 'processReport() without any [SRSReportDataSetAttribute] getter',
      fix:
        'SSRS reads report data through [SRSReportDataSetAttribute(tableStr(MyTmp))] getter methods — without one this DP ' +
        'fills a table nothing reads. Add the getter (returns the tmp buffer after select * from it), or ignore if the ' +
        'getters live in a separate partial listing.',
    });
  }
  return violations;
}

// AxReport XML rules (codeType="xml-report")

/** RPT101 — AxReport without a design node. */
function checkReportHasDesign(code: string): ValidationViolation[] {
  if (!/<AxReport[\s>]/i.test(code)) return [];
  if (/<AxReportDesign\b/i.test(code)) return [];
  return [{
    rule: 'RPT101',
    severity: 'error',
    excerpt: '<AxReport> — no <AxReportDesign>',
    fix:
      'The report declares no design — ssrsReportStr(report, design) can never reference it and the report cannot run. ' +
      'Scaffolded reports carry one precision design named "Report" (generate_object(mode="scaffold", objectType="report")).',
  }];
}

/** RPT102 — report dataset without a Query. */
function checkReportDatasetShape(code: string): ValidationViolation[] {
  if (!/<AxReport[\s>]/i.test(code)) return [];
  const violations: ValidationViolation[] = [];
  const dsRe = /<AxReportDataSet\b[\s\S]*?<\/AxReportDataSet>/gi;
  let m: RegExpExecArray | null;
  while ((m = dsRe.exec(code)) !== null) {
    if (/<Query>/i.test(m[0])) continue;
    violations.push({
      rule: 'RPT102',
      severity: 'warning',
      line: lineNumber(code, m.index),
      excerpt: '<AxReportDataSet> without <Query>',
      fix:
        'A ReportDataProvider dataset needs <Query>SELECT * FROM DPClass.TmpTable</Query> (with ' +
        '<DataSourceType>ReportDataProvider</DataSourceType>) — without it the dataset is empty at run time.',
    });
  }
  return violations;
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

/**
 * Select statements in masked source: from `select` to the `;` or `{` that ends
 * the statement — the `{` matters because a `while select` body holds statements
 * of its own and must not be read as part of the header.
 */
function selectStatements(masked: string): Array<{ text: string; index: number }> {
  const out: Array<{ text: string; index: number }> = [];
  const re = /\bselect\b[^;{]*[;{]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    // A macro directive ends the statement even without a semicolon. Inside a
    // #localmacro the select is a FRAGMENT with no terminator, so the match ran on
    // past #endmacro and swallowed the next macro's clauses: that is how SEL008
    // reported "order by after where" on DocuRefSearch, where each macro on its own
    // is in the right order. Cutting at the directive keeps the two apart.
    const macroAt = /^[ \t]*#/m.exec(m[0]);
    const text = macroAt ? m[0].slice(0, macroAt.index) : m[0];
    out.push({ text, index: m.index });
  }
  return out;
}

/**
 * SEL008 — order by / group by placed after the where of the same segment.
 *
 * X++ fixes the clause order inside each segment of a select:
 *   select [options] buffer [index] [order by | group by] [where] [join …]
 * and a where before the ordering is a COMPILE error whose message names neither:
 * xppc answers "'join' expected", because after a where it can only accept another
 * join. After a join the next segment starts over, so `… join t order by t.f where
 * t.c` is correct and only the segment-local order is wrong.
 */
function checkSelectClauseOrder(code: string): ValidationViolation[] {
  const masked = maskStringsAndComments(code);
  const violations: ValidationViolation[] = [];

  for (const stmt of selectStatements(masked)) {
    // Segment boundaries are the join keywords; each segment orders independently.
    const segments: Array<{ text: string; offset: number }> = [];
    let last = 0;
    const joinRe = /\bjoin\b/gi;
    let j: RegExpExecArray | null;
    while ((j = joinRe.exec(stmt.text)) !== null) {
      segments.push({ text: stmt.text.slice(last, j.index), offset: last });
      last = j.index;
    }
    segments.push({ text: stmt.text.slice(last), offset: last });

    for (const seg of segments) {
      const where = /\bwhere\b/i.exec(seg.text);
      const ordering = /\b(?:order|group)\s+by\b/i.exec(seg.text);
      if (!where || !ordering || where.index >= ordering.index) continue;
      const at = stmt.index + seg.offset + ordering.index;
      violations.push({
        rule: 'SEL008',
        severity: 'error',
        line: lineNumber(masked, at),
        excerpt: `${ordering[0]} after where`,
        fix: 'Put order by / group by BEFORE the where of the same segment: ' +
          '"select t order by Field where t.Field != \'\'". Written after the where, xppc ' +
          'reports "\'join\' expected" — after a where clause it can only accept another join. ' +
          'Each joined buffer starts a new segment with the same order.',
      });
    }
  }
  return violations;
}

/**
 * SEL009 — the `in` operator with an inline container literal.
 *
 * xppc: "Container literals in 'in' expression are not supported. Declare container
 * variable instead." The operator is narrower still — the left side must be an ENUM
 * field, and a str/int64/real/date field answers "Types 'str(CustAccount)' and
 * 'container' are not compatible with operator 'in'" — but that half needs the field
 * type, which only the index knows, so it stays in the knowledge entry.
 */
function checkInOperatorLiteral(code: string): ValidationViolation[] {
  const masked = maskStringsAndComments(code);
  const violations: ValidationViolation[] = [];
  for (const stmt of selectStatements(masked)) {
    const re = /\bin\s*\[/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stmt.text)) !== null) {
      const at = stmt.index + m.index;
      violations.push({
        rule: 'SEL009',
        severity: 'error',
        line: lineNumber(masked, at),
        excerpt: stmt.text.slice(Math.max(0, m.index - 40), m.index + 20).trim(),
        fix: 'The `in` operator needs a container VARIABLE, not an inline literal: ' +
          'declare "container statuses = [Status::A, Status::B];" and write ' +
          '"where t.Status in statuses". xppc: "Container literals in \'in\' expression are ' +
          'not supported. Declare container variable instead." Note the left side must be an ' +
          'ENUM field — for a string or number field, write the OR chain.',
      });
    }
  }
  return violations;
}

/**
 * SEL010 — a select EXPRESSION that names a buffer variable, and validTimeState
 * given an expression.
 *
 * `(select firstOnly cg).Name` looks like the natural shorthand when `cg` is already
 * declared, but the expression form takes the TABLE name — xppc answers "Table 'cg'
 * is not found". Likewise validTimeState takes variables or literals only:
 * `validTimeState(DateTimeUtil::utcNow())` fails as "Invalid token '::'".
 */
function checkSelectExpressionAndValidTimeState(code: string): ValidationViolation[] {
  const masked = maskStringsAndComments(code);
  const violations: ValidationViolation[] = [];

  // Scoped per method: `QueryBuildDataSource inventSerial = …` in one method must
  // not decide what `inventSerial` means in another, where it is the table name.
  for (const region of topLevelRegions(masked)) {
    violations.push(...selectExpressionViolations(masked, region.offset, region.text));
  }
  violations.push(...validTimeStateViolations(masked));
  return violations;
}

/**
 * Top-level brace blocks of the masked source — one per method when the input is a
 * method body or a concatenated class. Text outside any block is returned as the
 * first region so class-declaration fields stay visible.
 */
function topLevelRegions(masked: string): Array<{ text: string; offset: number }> {
  const regions: Array<{ text: string; offset: number }> = [];
  let depth = 0;
  let start = 0;
  let outside = '';
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '{') {
      if (depth === 0) { outside += masked.slice(start, i); start = i; }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth <= 0) { regions.push({ text: masked.slice(start, i + 1), offset: start }); start = i + 1; depth = 0; }
    }
  }
  if (start < masked.length) outside += masked.slice(start);
  if (regions.length === 0) return [{ text: masked, offset: 0 }];
  // The prelude (class declaration / field list) prefixes every region so a class
  // field counts as declared in each method.
  return regions.map(r => ({ text: outside + r.text, offset: r.offset - outside.length }));
}

function selectExpressionViolations(
  masked: string,
  regionOffset: number,
  regionText: string,
): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  // Buffers declared here as `Type name;` — and only those whose NAME differs from
  // their TYPE. X++ is case-insensitive, so the common `UserGroupInfo userGroupInfo;`
  // leaves an identifier that resolves as the table either way and compiles (the
  // platform relies on this in 180 classes); `CustGroup cg;` does not, and
  // `(select firstonly cg)` is then "Table 'cg' is not found" in every form —
  // with or without firstonly, with or without a where, field list or not
  // (xppc 7.0.7996.33, probe round 4).
  const aliasedBuffers = new Set<string>();
  for (const m of regionText.matchAll(/^[ \t]*([A-Za-z_]\w*)[ \t]+([A-Za-z_]\w*)[ \t]*[;,=]/gm)) {
    const [, type, name] = m;
    // `flush CustParameters;` is a statement, not a declaration — the type slot has
    // to be a real type name, and the compiler's own keyword set is what says so.
    if (isReservedKeyword(type) || CALL_PRECEDING_KEYWORDS.has(type.toLowerCase())) continue;
    if (type.toLowerCase() === name.toLowerCase()) continue;
    aliasedBuffers.add(name.toLowerCase());
  }

  const exprRe = /\(\s*select\b((?:\s+\w+)*?)\s+([A-Za-z_]\w*)\s*[).]/gi;
  let m: RegExpExecArray | null;
  while ((m = exprRe.exec(regionText)) !== null) {
    if (!aliasedBuffers.has(m[2].toLowerCase())) continue;
    const at = regionOffset + m.index;
    if (at < 0 || at >= masked.length) continue;
    violations.push({
      rule: 'SEL010',
      severity: 'error',
      line: lineNumber(masked, at),
      excerpt: m[0].trim(),
      fix: `A select EXPRESSION names the TABLE, not a buffer: "(select firstOnly MyTable).Field". ` +
        `"${m[2]}" is declared as a buffer in this method, so xppc answers "Table '${m[2]}' is not found". ` +
        'Either name the table, or use an ordinary select statement into the buffer.',
    });
  }

  return violations;
}

function validTimeStateViolations(masked: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  let m: RegExpExecArray | null;
  // validTimeState takes plain identifiers only: a call ("Invalid token '::'"), a
  // field access ("Invalid token '.'") and even a date literal ("'identifier'
  // expected") are all parse errors.
  //
  // …but only as a SELECT CLAUSE. `validTimeState` is also an ordinary method name
  // in the SysDa API (SysDaFindObject.validTimeState(SysDaValidTimeState _v = null))
  // and on date-effective tables, where every argument the clause would reject is
  // perfectly legal. Restricting the scan to select statements removed 14
  // error-severity findings on shipped ApplicationPlatform code.
  const statements = selectStatements(masked);
  const vtsRe = /\bvalidTimeState\s*\(([^)]*)\)/gi;
  while ((m = vtsRe.exec(masked)) !== null) {
    const at = m.index;
    const inSelect = statements.some(s => at >= s.index && at < s.index + s.text.length);
    if (!inSelect) continue;
    const operands = m[1].split(',').map(s => s.trim()).filter(Boolean);
    if (operands.length > 0 && operands.every(o => /^[A-Za-z_]\w*$/.test(o))) continue;
    violations.push({
      rule: 'SEL010',
      severity: 'error',
      line: lineNumber(masked, m.index),
      excerpt: m[0].trim(),
      fix: 'validTimeState takes plain variable names — not a call ("Invalid token \'::\'"), ' +
        'not a field ("Invalid token \'.\'") and not a date literal ("\'identifier\' expected"). ' +
        'Assign it first: "utcdatetime asOf = DateTimeUtil::utcNow(); select validTimeState(asOf) t;".',
    });
  }
  return violations;
}

/** Values an attribute argument may take: the compiler stores literals, nothing else. */
const ATTRIBUTE_LITERAL_RE =
  /^(?:-?\d+(?:\.\d+)?|true|false|null|#\w+|\w+\s*::\s*\w+|\d{1,2}\\\d{1,2}\\\d{4}|@?["'][^"']*["'])$/i;

/**
 * ATTR001 — an attribute argument that is not a compile-time literal.
 * ATTR002 — [SysObsolete] without all three arguments.
 *
 * The compiler does not construct the attribute: it stores the class name and the
 * literal values, so a variable is "Invalid token ','" and a call is "Invalid token
 * '('". An intrinsic is fine (it IS a literal after compilation) and so is a macro,
 * which expands before the compiler sees it. SysObsolete is the one whose optional
 * arguments are not optional in practice: xppbp answers
 * BPCheckSysObsoleteAttributeParametersMismatch unless message, isError AND the date
 * are all given.
 */
/**
 * True when the bracket content is a list of attributes rather than a container
 * literal or a multi-assignment: at depth 0 an attribute list holds only names and
 * commas, while `[DatabaseLogType::Update, tableNum(X)]` shows `::` and `[a, b] = c`
 * shows an assignment.
 */
function looksLikeAttributeList(body: string): boolean {
  let depth = 0;
  let sawName = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(' || ch === '[') { depth++; continue; }
    if (ch === ')' || ch === ']') { depth--; continue; }
    if (depth > 0) continue;
    if (/\s|,/.test(ch)) continue;
    if (/[A-Za-z_]/.test(ch)) {
      const rest = /^[A-Za-z_]\w*/.exec(body.slice(i))![0];
      i += rest.length - 1;
      sawName = true;
      continue;
    }
    return false; // ::, quotes, digits, operators — not an attribute list
  }
  return sawName;
}

function checkAttributeArguments(code: string): ValidationViolation[] {
  const masked = maskStringsAndComments(code);
  const lines = code.split('\n');
  const violations: ValidationViolation[] = [];

  // One bracket may carry several attributes, and they may span lines:
  //   [DataMemberAttribute('SalesId'),
  //    BusinessEventsDataMemberAttribute('@Label')]
  // so the bracket is located first and each Name(args) inside it read separately.
  // The bracket must BE the line (nothing after the closing ]), must not contain a
  // statement, and at depth 0 may hold only attribute names and commas. Without the
  // last test a container literal at the start of a line — `[DatabaseLogType::Update,
  // tableNum(X), fieldNum(X, Y)]` — and a multi-assignment `[a, b] = f();` read as
  // attributes, which is 195 shipped classes' worth of noise.
  const bracketRe = /^[ \t]*\[([^\];=]*(?:\n[^\];=]*){0,5}?)\]\s*$/gm;
  const attrInBracket = /([A-Za-z_]\w*)\s*\(/g;
  let bracket: RegExpExecArray | null;
  const found: Array<{ name: string; argText: string; at: number }> = [];
  while ((bracket = bracketRe.exec(masked)) !== null) {
    const body = bracket[1];
    if (!looksLikeAttributeList(body)) continue;
    // A container literal of intrinsics — `[fieldNum(T, A), fieldNum(T, B)]` on its
    // own line — passes the shape test, because an intrinsic name followed by a
    // parenthesis is exactly what an attribute looks like. An attribute is never an
    // intrinsic, so the head settles it.
    const head = /^\s*([A-Za-z_]\w*)/.exec(body)?.[1];
    if (head && intrinsicInfo(head)) continue;
    const bodyStart = bracket.index + bracket[0].indexOf('[') + 1;
    attrInBracket.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = attrInBracket.exec(body)) !== null) {
      // Skip a nested call — only the attribute name sits at depth 0.
      let depth = 0;
      let nested = false;
      for (let i = 0; i < a.index; i++) {
        if (body[i] === '(') depth++;
        else if (body[i] === ')') depth--;
      }
      if (depth !== 0) nested = true;
      if (nested) continue;
      // Read the balanced argument list.
      let d = 0;
      let end = a.index + a[0].length - 1;
      for (let i = end; i < body.length; i++) {
        if (body[i] === '(') d++;
        else if (body[i] === ')') { d--; if (d === 0) { end = i; break; } }
      }
      found.push({
        name: a[1],
        argText: body.slice(a.index + a[0].length, end),
        at: bodyStart + a.index,
      });
      attrInBracket.lastIndex = end;
    }
  }

  for (const { name, argText, at } of found) {
    const lineNo = lineNumber(masked, at);
    const excerpt = lines[lineNo - 1]?.trim() || `[${name}(…)]`;

    // Split on top-level commas so a nested intrinsic call stays one argument.
    const args: string[] = [];
    let depth = 0;
    let buf = '';
    for (const ch of argText) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      if (ch === ',' && depth === 0) { args.push(buf.trim()); buf = ''; continue; }
      buf += ch;
    }
    if (buf.trim()) args.push(buf.trim());

    for (const raw of args) {
      // Shipped code documents attribute arguments constantly —
      // `SysSetupConfig(true /*ContinueOnError*/, 600 /*10 minutes*/)` — and the
      // masked form of that is not what it looks like: the lexer keeps the OPENING
      // `/*` and blanks the closing `*/` along with the content, so the argument
      // arrives as `true /*                  ` with no terminator at all. Matching
      // only the closed form left 11 error-severity false positives in the first
      // 3,000 files swept, so both forms are stripped here.
      const arg = raw
        .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ')
        .replace(/\/\/.*$/gm, ' ')
        .trim();
      if (!arg) continue;
      if (ATTRIBUTE_LITERAL_RE.test(arg)) continue;
      const call = /^([A-Za-z_]\w*)\s*\(/.exec(arg);
      if (call && intrinsicInfo(call[1])) continue; // classStr(...), tableStr(...), …
      violations.push({
        rule: 'ATTR001',
        severity: 'error',
        line: lineNo,
        excerpt,
        fix: `Attribute arguments must be compile-time literals — "${arg}" is not one. ` +
          'The compiler stores the literal values without constructing the attribute, so a ' +
          'variable reads as "Invalid token \',\'" and a call as "Invalid token \'(\'". ' +
          'Allowed: a number, a quoted string, true/false/null, an enum value (MyEnum::Value), ' +
          'a date literal, an intrinsic (classStr/tableStr/methodStr/…) or a #define macro.',
      });
    }

    if (/^SysObsolete(Attribute)?$/i.test(name) && args.length < 3) {
      violations.push({
        rule: 'ATTR002',
        severity: 'warning',
        line: lineNo,
        excerpt,
        fix: 'Give SysObsolete all three arguments — message, isError AND the date: ' +
          '[SysObsolete("Use MyNewClass instead.", false, 31\\12\\2026)]. The constructor defaults ' +
          'them, but xppbp answers BPCheckSysObsoleteAttributeParametersMismatch when they are ' +
          'omitted, and attribute arguments are positional so the date cannot be skipped.',
      });
    }
  }
  return violations;
}

/**
 * EXT001 — an extension-method class whose members do not match its shape.
 *
 * A static class holds extension methods; every method in it must be static and the
 * first parameter is the extended type. The compiler is explicit about both:
 * "The method 'bad' must be declared as static because it is declared in a static
 * class" and "Extension class 'X_Extension' must be static and public or internal".
 */
function checkExtensionMethodClassShape(code: string): ValidationViolation[] {
  const masked = maskStringsAndComments(code);
  const lines = code.split('\n');
  const violations: ValidationViolation[] = [];

  const classDecl = /\b(?:(public|internal|private)\s+)?(static\s+)?(?:final\s+)?class\s+(\w+_Extension)\b/i
    .exec(masked);
  if (!classDecl) return violations;
  const isStatic = Boolean(classDecl[2]);
  const isCoc = /\[\s*ExtensionOf/i.test(masked);

  if (!isStatic && !isCoc) {
    const lineNo = lineNumber(masked, classDecl.index);
    violations.push({
      rule: 'EXT001',
      severity: 'error',
      line: lineNo,
      excerpt: lines[lineNo - 1]?.trim() ?? classDecl[0],
      fix: `An _Extension class is one of two things, and this one is neither: a Chain of Command ` +
        'class ([ExtensionOf(...)] final class) or an extension-method class (public static class ' +
        'whose methods are all static and take the extended type first). xppc: "Extension class ' +
        `'${classDecl[3]}' must be static and public or internal".`,
    });
    return violations;
  }
  if (!isStatic) return violations;

  masked.split('\n').forEach((line, i) => {
    const decl = /^\s*(?:public|protected|private|internal)\s+(?!static\b)[A-Za-z_][\w.]*\s+(\w+)\s*\(/.exec(line);
    if (!decl) return;
    violations.push({
      rule: 'EXT001',
      severity: 'error',
      line: i + 1,
      excerpt: lines[i]?.trim() ?? line.trim(),
      fix: `Every method in a static extension class must be static: "public static <Type> ${decl[1]}` +
        '(<ExtendedType> _target, …)". xppc: "The method \'' + decl[1] + '\' must be declared as ' +
        'static because it is declared in a static class".',
    });
  });
  return violations;
}

/**
 * KW001 — a variable named after a reserved word.
 *
 * The reserved set is the parser's own (115 words, read from the shipped compiler),
 * and it is not the set the language reference lists: `having`, `foreach`, `async`,
 * `await` and `namespace` are reserved without being implemented, so a variable
 * called `having` fails with a syntax error that names the following token instead.
 * `in` is reserved but exempted and stays legal.
 */
function checkReservedIdentifiers(code: string): ValidationViolation[] {
  const masked = maskStringsAndComments(code);
  const lines = code.split('\n');
  const violations: ValidationViolation[] = [];
  const declRe =
    /^\s*(?:(?:public|protected|private|internal|static|final|const|readonly)\s+)*(str\s+\d+|str|int64|int|real|boolean|date|utcdatetime|timeOfDay|guid|container|anytype)\s+([A-Za-z_]\w*)\s*[;,=]/gim;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(masked)) !== null) {
    if (!isReservedKeyword(m[2])) continue;
    const lineNo = lineNumber(masked, m.index);
    violations.push({
      rule: 'KW001',
      severity: 'error',
      line: lineNo,
      excerpt: lines[lineNo - 1]?.trim() ?? m[0].trim(),
      fix: `"${m[2]}" is a reserved word in X++ (the parser's own keyword set) and cannot name a ` +
        'variable. Rename it — the compiler reports the failure on the token that follows, not on ' +
        'the name, so the message will not point here.',
    });
  }
  return violations;
}

/**
 * DOC001 — a bare `&` or `<` inside a `///` doc comment.
 *
 * X++ doc comments are parsed as XML, so an ampersand in prose is not prose:
 * xppbp answers BPXmlDocMalformed and the build carries the finding. Worse for
 * this server, pre-escaping it as `&amp;` does NOT survive the write path (found
 * during the G-VM capture, 2026-08-30) — so the fix is to rewrite the sentence,
 * which only helps if the problem is visible BEFORE the write.
 *
 * WARNING, not error, and the sweep is why. Across 6,000 shipped AxClass files
 * Microsoft writes a bare `&` in a doc comment in 4 of them ("F&O") and a bare
 * `<` in 9 ("version < CTP8", "2 <= maxVal"). BPXmlDocMalformed is a
 * best-practice finding, not a compile failure, and a rule that stops a build on
 * code the product ships is our defect rather than theirs.
 */
function checkDocCommentXml(code: string): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = line.indexOf('///');
    if (at < 0) continue;
    const text = line.slice(at + 3);

    // `&` that does not open a character entity (&amp; &#39; &lt;).
    const amp = /&(?!#?\w+;)/.exec(text);
    // `<` that cannot start a tag: followed by a space, a digit or an operator.
    const lt = /<(?![/!?a-zA-Z])/.exec(text);
    const found = amp ?? lt;
    if (!found) continue;

    violations.push({
      rule: 'DOC001',
      severity: 'warning',
      line: i + 1,
      excerpt: line.trim().slice(0, 120),
      fix:
        `A /// comment is parsed as XML, so a bare "${found[0]}" makes xppbp report ` +
        'BPXmlDocMalformed. Name the operator in words ("and", "less than") rather than escaping it: ' +
        'an entity written here does not survive the write path, so the escape silently comes back.',
    });
  }
  return violations;
}

/**
 * SET001 — a set-based statement with no `where`.
 *
 * `update_recordset t setting f = 1;` and `delete_from t;` both compile and both
 * touch EVERY row of the table, in every company the statement can see. It is
 * occasionally what the author meant; it is never what they meant by accident,
 * and the mistake is invisible until production data is gone.
 *
 * Warning, not error: the compiler accepts it and shipped code does it on purpose
 * (staging tables, temp tables), so an error would fire on correct code.
 */
function checkSetBasedWithoutWhere(code: string): ValidationViolation[] {
  const masked = maskStringsAndComments(code);
  const violations: ValidationViolation[] = [];
  const re = /\b(update_recordset|delete_from)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    // The statement runs to its terminating semicolon; `where` may follow
    // `setting …` or a `join …`, so the whole statement has to be read.
    const end = masked.indexOf(';', m.index);
    const statement = masked.slice(m.index, end < 0 ? masked.length : end);
    if (/\bwhere\b/i.test(statement)) continue;
    violations.push({
      rule: 'SET001',
      severity: 'warning',
      line: lineNumber(code, m.index),
      excerpt: code.slice(m.index, Math.min(code.length, m.index + 90)).split('\n')[0].trim(),
      fix:
        `${m[1]} with no where clause touches EVERY row of the table (and, unless the query is ` +
        'restricted, every company it can see). If that is deliberate — a temp or staging table — say ' +
        'so in a comment; otherwise add the where before this reaches data anyone cares about.',
    });
  }
  return violations;
}

/**
 * OP001 — `||` followed by `&&` in one expression, unparenthesised.
 *
 * In X++ the two have EQUAL precedence and evaluate left to right, unlike C#,
 * Java, SQL and every language a developer arrives from — where `&&` binds
 * tighter. Only ONE order actually diverges, and it is worth being exact about
 * which:
 *
 *   a || b && c   X++ reads (a || b) && c   ·   C# reads a || (b && c)   ← differs
 *   a && b || c   X++ reads (a && b) || c   ·   C# reads (a && b) || c   ← same
 *
 * So the rule fires on the first order only. Flagging both was measurably wrong
 * as advice: over the 105,686 shipped files it produced 971 findings, roughly
 * half of them on the `&&`-first order that means the same thing in every
 * language — noise that trains a reader to skip the rule that matters.
 */
function checkMixedBooleanOperators(code: string): ValidationViolation[] {
  const masked = maskStringsAndComments(code);
  const violations: ValidationViolation[] = [];
  const lines = masked.split('\n');
  const original = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('&&') || !line.includes('||')) continue;

    // Only unparenthesised mixing matters. Blank out every parenthesised group,
    // innermost first, and see whether both operators survive at the top level.
    let flat = line;
    for (let pass = 0; pass < 8; pass++) {
      const next = flat.replace(/\([^()]*\)/g, group => ' '.repeat(group.length));
      if (next === flat) break;
      flat = next;
    }
    // Only `||` BEFORE `&&` reads differently in X++ than in C#. The reverse
    // order groups identically in both, so it is not worth a word.
    const firstOr = flat.indexOf('||');
    const lastAnd = flat.lastIndexOf('&&');
    if (firstOr < 0 || lastAnd < 0 || firstOr > lastAnd) continue;

    violations.push({
      rule: 'OP001',
      severity: 'warning',
      line: i + 1,
      excerpt: original[i]?.trim().slice(0, 120) ?? line.trim(),
      fix:
        '&& and || have EQUAL precedence in X++ and evaluate left to right — unlike C#, Java and SQL, ' +
        'where && binds tighter. So "a || b && c" is (a || b) && c HERE and a || (b && c) almost ' +
        'everywhere else, and the line reads correct under both. Parenthesise the intended grouping ' +
        'so it means the same thing to the compiler and to the next reader. ' +
        '("a && b || c" needs nothing — that order groups the same in every language.)',
    });
  }
  return violations;
}

const XPP_RULES = [
  checkTodayDeprecated,
  checkDocCommentXml,
  checkSetBasedWithoutWhere,
  checkMixedBooleanOperators,
  checkForceLiterals,
  checkCrossCompanyPlacement,
  checkNestedWhileSelect,
  checkFunctionInWhere,
  checkCocDefaultParam,
  checkExtensionOfNotFinal,
  checkExtensionOfNaming,
  checkCocNextUnconditional,
  checkGlobalFunctionOnTableBuffer,
  checkRecordReReadInTableCoc,
  checkEnumSymbolInMessage,
  checkBuiltinArity,
  checkHardcodedStrings,
  checkDoMethods,
  checkGenericDocComment,
  checkUnbalancedTts,
  checkDevArtifacts,
  checkCSharpIsms,
  checkCatchInsideTts,
  checkUnguardedRetry,
  checkIndexHint,
  checkForeignJoinSyntax,
  checkReportDpShape,
  checkRemovedStatements,
  checkMacroDirectiveForm,
  checkSelectClauseOrder,
  checkInOperatorLiteral,
  checkSelectExpressionAndValidTimeState,
  checkAttributeArguments,
  checkExtensionMethodClassShape,
  checkReservedIdentifiers,
];

const REPORT_XML_RULES = [
  checkReportHasDesign,
  checkReportDatasetShape,
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
 * document (the 2026-07-21 eval sweep, finding #13).
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

/**
 * XML008 — an AxTableExtension carrying a `<Methods>` element.
 *
 * It reads perfectly and it is not a thing: not one shipped table extension in
 * ApplicationSuite has `<Methods>`, and the deserializer ignores the block, so
 * the build stays green and the method simply does not exist. The failure then
 * lands somewhere else entirely — at the call site, as "the method is not found".
 *
 * Display, edit and helper methods for a table you do not own belong in an
 * `[ExtensionOf(tableStr(…))] final class`. This cost a captured eval case its
 * first run (G-VM, 2026-08-30).
 */
function checkTableExtensionMethods(code: string): ValidationViolation[] {
  if (!/<AxTableExtension[\s>]/.test(code)) return [];
  const at = code.search(/<Methods\b/);
  if (at < 0) return [];
  const name = /<Name>([^<]+)<\/Name>/.exec(code)?.[1] ?? 'the extension';
  return [{
    rule: 'XML008',
    severity: 'error',
    line: lineNumber(code, at),
    excerpt: '<Methods> inside an AxTableExtension',
    fix:
      'An AxTableExtension has no <Methods> element — the deserializer drops the block SILENTLY, ' +
      'the build stays green, and the method is missing only at its call site. Put the methods in ' +
      `an extension class instead: [ExtensionOf(tableStr(${name.split('.')[0]}))] final class ` +
      `${name.replace(/\./g, '')}_Extension. Display and edit methods work there too.`,
  }];
}

/**
 * XML009 — a form control bound to a field group the table does not declare.
 *
 * `<DataGroup>Overview</DataGroup>` on a grid names a field group by string. If
 * the table has no such group the AOT reports
 * "Field group 'Overview' does not exist" — but only on a FULL build. An
 * incremental build passes it, which is how this survived several captures
 * before it was found (PR #967).
 *
 * The rule can only see what is in front of it: a single document naming a group
 * cannot be checked without the table. What it CAN catch is the shape that
 * actually shipped broken — a generated document that declares the table's field
 * groups AND references a different one.
 */
function checkDataGroupDeclared(code: string): ValidationViolation[] {
  if (!/<DataGroup>/.test(code)) return [];
  // Only decidable when the same document declares the groups (a table + its form,
  // or a table document). Otherwise stay quiet rather than guess.
  const groupBlock = /<FieldGroups>([\s\S]*?)<\/FieldGroups>/.exec(code);
  if (!groupBlock) return [];
  const declared = new Set(
    [...groupBlock[1].matchAll(/<AxTableFieldGroup>[\s\S]*?<Name>([^<]+)<\/Name>/g)].map(m => m[1]),
  );
  if (declared.size === 0) return [];

  const violations: ValidationViolation[] = [];
  const seen = new Set<string>();
  for (const m of code.matchAll(/<DataGroup>([^<]+)<\/DataGroup>/g)) {
    const group = m[1].trim();
    if (!group || declared.has(group) || seen.has(group)) continue;
    seen.add(group);
    violations.push({
      rule: 'XML009',
      severity: 'error',
      line: lineNumber(code, m.index ?? 0),
      excerpt: `<DataGroup>${group}</DataGroup>`,
      fix:
        `The table declares no field group named "${group}" (it has: ` +
        `${[...declared].join(', ')}). A full build answers "Field group '${group}' does not exist"; ` +
        'an INCREMENTAL build passes it silently, so this is easy to ship. Either add the group to ' +
        'the table or point the control at one that exists.',
    });
  }
  return violations;
}

/**
 * XML010 — a form control element written out of the order shipped metadata uses.
 *
 * Same failure as XML006 one level down, and with the same silence: the
 * deserializer skips the misplaced element and carries on. When the element is a
 * container's `<Controls>`, every control under it is in the file and invisible
 * to the platform — verified against the live metadata provider in #979, where a
 * scaffolded form held 16 controls of which the compiler could reach 14.
 *
 * The canonical order is not written here. It is mined per control `i:type` from
 * 309,668 shipped controls by scripts/capture-form-element-order.ts; over that
 * whole corpus this rule fires three times, each on a file where Microsoft
 * itself put an element where the deserializer drops it.
 *
 * Only the `order` kind is reported. The checker's weaker `unknown` kind ("no
 * shipped control of this type carries this element") is useful in the scaffold
 * self-test but too soft for a caller-facing validator.
 */
function checkFormControlElementOrder(code: string): ValidationViolation[] {
  if (!/<(?:AxFormControl|FormControl)[\s>]/.test(code)) return [];
  return findControlElementOrderViolations(code)
    .filter(v => v.kind === 'order')
    .map(v => ({
      rule: 'XML010',
      severity: 'error' as const,
      line: v.line,
      excerpt: `${v.controlType} "${v.controlName}": <${v.element}> appears before <${v.beforeElement}>`,
      fix:
        `AxForm XML is order-sensitive and a misordered element is dropped SILENTLY — ` +
        `anything under a dropped <Controls> is in the file and invisible to the compiler. ` +
        `Move <${v.element}> after <${v.beforeElement}>. The canonical sequence per control ` +
        `type is in src/validation/formControlElementOrder.generated.ts (e.g. on a group ` +
        `control, <DataGroup> and <DataSource> come AFTER </Controls>).`,
    }));
}

const XML_RULES = [
  checkMissingAlternateKey,
  checkTableElementOrder,
  checkNonExistentTableProperties,
  checkTableExtensionMethods,
  checkDataGroupDeclared,
];

/**
 * Rules for a form document. The table rules do not apply, and the X++ keyword
 * rules would only produce noise over metadata XML.
 */
const FORM_XML_RULES = [
  checkFormControlElementOrder,
  checkDataGroupDeclared,
];

const XML_PROPERTY_RULES = [
  checkTableProperties,
  checkFieldEdt,
];

export function runRules(
  code: string,
  codeType: 'xpp' | 'xml-table' | 'xml-form' | 'xml-any' | 'xml-report',
  stats?: PropertyStatsProvider,
): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  if (codeType === 'xpp') {
    for (const rule of XPP_RULES) {
      violations.push(...rule(code));
    }
  } else if (codeType === 'xml-report') {
    // AxReport XML embeds RDL in CDATA — running the X++ keyword rules over it
    // would only produce noise, so the report document gets its own rule set.
    for (const rule of REPORT_XML_RULES) {
      violations.push(...rule(code));
    }
  } else if (codeType === 'xml-form') {
    // The route an agent needs to check a form BEFORE handing it to
    // d365fo_file(action="create"), which now refuses this shape (#989).
    for (const rule of FORM_XML_RULES) {
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
        text: `✅ validate_code(syntax): no violations found${context ? ` in ${context}` : ''}.\n` +
          `Checked ${XPP_RULES.length + (codeType !== 'xpp' ? XML_RULES.length + XML_PROPERTY_RULES.length : 0)} rule groups` +
          `${codeType !== 'xpp' && stats ? ' (property rules driven by mined standard-model statistics)' : ''}.`,
      }],
    };
  }

  const lines: string[] = [];
  lines.push(
    `${errors.length > 0 ? '❌' : '⚠️'} validate_code(syntax): ` +
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
