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
import type { XppServerContext } from '../../types/context.js';
import { validateXppTool } from './validateXpp.js';
import { resolveReferencesTool } from '../write/resolveReferences.js';
import { lookupSymbolNocase, type DbLike } from '../../utils/symbolLookup.js';
import { type XmlNode, parseNodes, firstChild, textValueOf } from '../../utils/xmlNodeTree.js';

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
  const re = new RegExp(`<${tag}>([^<]+)</${tag}>`, 'gi');
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const v = m[1].trim();
    if (v) results.push(v);
  }
  return results;
}

function symbolExistsInIndex(
  db: DbLike,
  name: string,
  type?: string,
): boolean {
  try {
    // Index-safe nocase lookup (exact probe + FTS fallback) — the former
    // `name = ? COLLATE NOCASE` shape full-scanned symbols PER IDENTIFIER.
    return lookupSymbolNocase(db, name, type ? [type] : undefined) !== undefined;
  } catch {
    return true; // index unavailable — don't false-block
  }
}

/**
 * The two element names a query data source can carry. An embedded (joined) one
 * is NOT a nested root — both spellings have to be walked or every joined table
 * is invisible.
 */
const QUERY_DATASOURCE_TAGS = ['AxQuerySimpleRootDataSource', 'AxQuerySimpleEmbeddedDataSource'];

/** Is `field` a column of `table` according to the index? */
function fieldExistsOnTable(db: DbLike, table: string, field: string): boolean {
  try {
    // COLLATE NOCASE is safe here only because parent_name + type already narrow
    // this to one table's columns — see the note in symbolLookup.ts.
    const row = db
      .prepare("SELECT 1 FROM symbols WHERE parent_name = ? AND type = 'field' AND name = ? COLLATE NOCASE LIMIT 1")
      .get(table, field);
    return row !== undefined;
  } catch {
    return true; // index unavailable — never false-block
  }
}

/** How many columns the index knows for `table` — 0 means "cannot judge its fields". */
function indexedFieldCount(db: DbLike, table: string): number {
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM symbols WHERE parent_name = ? AND type = 'field'")
      .get(table) as { c?: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/** Every query data source under `node`, at any depth, as name → table. */
function collectQueryDataSources(xml: string, node: XmlNode, into: Map<string, string>): void {
  for (const child of node.children) {
    if (QUERY_DATASOURCE_TAGS.includes(child.name)) {
      const nameNode = firstChild(child, 'Name');
      const tableNode = firstChild(child, 'Table');
      if (nameNode && tableNode) {
        const name = textValueOf(xml, nameNode);
        const table = textValueOf(xml, tableNode);
        if (name && table) into.set(name.toLowerCase(), table);
      }
    }
    collectQueryDataSources(xml, child, into);
  }
}

/**
 * References inside an AxDataEntityView — the ones the flat tag scan below cannot see.
 *
 * A data entity keeps its query in <ViewMetadata>, and NONE of its reference
 * elements are named like the ones the generic pass checks: the source table is
 * <Table>, a mapped column is <DataField> paired with a <DataSource>, and a query
 * field is <Field>. So `validate_code(mode="references")` on an entity reported
 * "all 0 reference(s) verified" — it had checked nothing, and a hallucinated
 * field name passed the static gate in silence (eval case
 * L2-entity-query-range-roundtrip, 2026-08-23).
 *
 * Walked with the node tree rather than a tag regex because embedded (joined)
 * data sources NEST: a flat scan pairs a <DataField> with whatever <DataSource>
 * happens to be nearest in document order, which is how a check like this
 * reports the wrong table with full confidence.
 *
 * Field violations are warnings, never errors, and are skipped entirely when the
 * index knows no columns for the table at all — a table created in this session
 * whose fields have not been indexed yet must not be reported as having none.
 */
function resolveDataEntityReferences(
  xml: string,
  db: DbLike,
): { violations: XmlRefViolation[]; verified: number } {
  const violations: XmlRefViolation[] = [];
  let verified = 0;

  const root = parseNodes(xml);
  if (!root || root.name !== 'AxDataEntityView') return { violations, verified };

  const dataSources = new Map<string, string>();
  collectQueryDataSources(xml, root, dataSources);

  const judgeable = new Map<string, boolean>();
  for (const table of new Set(dataSources.values())) {
    // A data entity is built over a table or a view; accept either.
    if (lookupSymbolNocase(db, table, ['table', 'view']) !== undefined) {
      verified++;
      judgeable.set(table.toLowerCase(), indexedFieldCount(db, table) > 0);
    } else {
      violations.push({
        element: 'Table',
        value: table,
        detail: `Table "${table}" not found in the symbol index (data-entity data source).`,
        severity: 'error',
      });
      judgeable.set(table.toLowerCase(), false);
    }
  }

  /** Check one column reference against the table its data source resolves to. */
  const checkField = (dataSourceName: string, field: string, element: string): void => {
    const table = dataSources.get(dataSourceName.toLowerCase());
    if (!table || !judgeable.get(table.toLowerCase())) return; // cannot judge — stay silent
    if (fieldExistsOnTable(db, table, field)) {
      verified++;
    } else {
      violations.push({
        element,
        value: field,
        detail:
          `Field "${field}" not found on table "${table}" (via data source "${dataSourceName}"). ` +
          `A field a table extension adds in this same session may not be indexed yet.`,
        severity: 'warning',
      });
    }
  };

  // Query fields: <Field> inside the data source that owns them.
  const walkQueryFields = (node: XmlNode): void => {
    for (const child of node.children) {
      if (QUERY_DATASOURCE_TAGS.includes(child.name)) {
        const nameNode = firstChild(child, 'Name');
        const dsName = nameNode ? textValueOf(xml, nameNode) : '';
        const fields = firstChild(child, 'Fields');
        if (dsName && fields) {
          for (const f of fields.children) {
            const fieldNode = firstChild(f, 'Field');
            if (fieldNode) checkField(dsName, textValueOf(xml, fieldNode), 'Field');
          }
        }
      }
      walkQueryFields(child);
    }
  };
  walkQueryFields(root);

  // Mapped entity fields: <DataField> paired with its own <DataSource>.
  const entityFields = firstChild(root, 'Fields');
  if (entityFields) {
    for (const f of entityFields.children) {
      const dataField = firstChild(f, 'DataField');
      const dsNode = firstChild(f, 'DataSource');
      if (dataField && dsNode) {
        checkField(textValueOf(xml, dsNode), textValueOf(xml, dataField), 'DataField');
      }
    }
  }

  return { violations, verified };
}

function resolveXmlReferences(
  xml: string,
  _contextName: string | undefined,
  ctx: XppServerContext,
): { violations: XmlRefViolation[]; verified: number } {
  const violations: XmlRefViolation[] = [];
  let verified = 0;

  let db: DbLike | undefined;
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

  // A data entity keeps its references under names none of the scans below use
  // (<Table>, <DataField> + <DataSource>, <Field>), so it needs its own pass or
  // it verifies literally nothing.
  const entity = resolveDataEntityReferences(xml, db);
  violations.push(...entity.violations);
  verified += entity.verified;

  // <ExtendedDataType> — EDT must exist
  for (const edt of extractTagValues(xml, 'ExtendedDataType')) {
    if (symbolExistsInIndex(db, edt, 'edt')) {
      verified++;
    } else {
      violations.push({
        element: 'ExtendedDataType',
        value: edt,
        detail: `EDT "${edt}" not found in the symbol index. Wrong EDT name — search the index or run prepare(mode="create") for a suggestion.`,
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

  // <Label> — check label references exist (skip raw text labels — those are
  // caught by syntax/BP). Both reference forms: `@File:Id` and the legacy
  // `@SYSnnnnn`, which used to match neither branch and fell through unverified
  // (#888) — on the form most likely to appear in metadata that reuses standard
  // product labels.
  for (const lbl of extractTagValues(xml, 'Label')) {
    if (!lbl.startsWith('@')) continue; // raw text handled by rawLabelBpWarning in create path
    const modern = /^@([A-Za-z0-9_]+):([A-Za-z0-9_]+)$/.exec(lbl);
    const legacy = /^@([A-Za-z]{2,4}\d+)$/.exec(lbl);
    if (modern || legacy) {
      const fileId = modern ? modern[1] : undefined;
      try {
        // getLabelById takes either spelling, so the reference goes in whole.
        const rows = ctx.symbolIndex.getLabelById(lbl);
        if (rows.length > 0) { verified++; } else {
          violations.push({
            element: 'Label',
            value: lbl,
            detail: modern
              ? `Label ${lbl} not found in label index (file "${fileId}", id "${modern[2]}").`
              : `Legacy label ${lbl} not found in label index.`,
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

  if (!a.code) return err('validate_code requires `code` (the X++/XML text to check).');

  switch (mode) {
    case 'both': {
      // This tool's own description said "Call both ... BEFORE writes", and the
      // sampled sessions obeyed it as two round trips for one decision (8 pairs
      // of 21 validate_code calls). The two checks are independent, so they run
      // together and come back as one answer.
      const [syntax, references] = await Promise.all([
        validateXppTool(request, context),
        runReferenceCheck(request, context),
      ]);
      const isError = Boolean((syntax as { isError?: boolean }).isError) ||
                      Boolean((references as { isError?: boolean }).isError);
      return {
        content: [{
          type: 'text' as const,
          text: `${resultText(syntax)}\n\n---\n\n${resultText(references)}`,
        }],
        ...(isError ? { isError: true } : {}),
      };
    }

    case 'syntax':
      return validateXppTool(request, context);

    case 'references':
      return runReferenceCheck(request, context);

    default:
      return err(`validate_code: unknown mode "${mode}". Use "both" (preferred), "syntax" (BP/best-practice rules) or "references" (symbol resolution).`);
  }
}

/** mode="references", as its own function so mode="both" can compose it. */
async function runReferenceCheck(request: CallToolRequest, context: XppServerContext) {
  const a = (request.params.arguments ?? {}) as Record<string, any>;
  const codeType = (a.codeType as string | undefined) ?? 'xpp';
  // X++ code → use the dedicated X++ reference resolver
  if (codeType === 'xpp') return resolveReferencesTool(request, context);

  // XML (xml-table or xml-any) → use the XML-aware reference checker
  const contextName = a.context as string | undefined;
  const { violations, verified } = resolveXmlReferences(a.code as string, contextName, context);

  if (violations.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: `✅ validate_code(references): all ${verified} reference(s) verified against the index${contextName ? ` in ${contextName}` : ''}.\n` +
          `No hallucinated symbols detected. This is a name-existence check, not a compile — ` +
          `build_d365fo_project remains the only proof it compiles.`,
      }],
    };
  }

  const errors = violations.filter(v => v.severity === 'error');
  const warns  = violations.filter(v => v.severity === 'warning');
  const lines: string[] = [
    `${errors.length > 0 ? '❌' : '⚠️'} validate_code(references): ${violations.length} issue(s) found (${errors.length} error(s), ${warns.length} warning(s)), ${verified} verified${contextName ? ` in ${contextName}` : ''}.`,
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

function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> })?.content;
  return content?.map(c => c?.text ?? '').join('\n') ?? '';
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/validateCode.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.
