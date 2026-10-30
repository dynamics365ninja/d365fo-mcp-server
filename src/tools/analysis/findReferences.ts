/**
 * Find References Tool
 * Find all usages of a symbol (method, class, field, table)
 * Critical for understanding impact before making changes
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { buildObjectTypeMismatchMessage, detectObjectTypeInDb } from '../../utils/metadataResolver.js';
import { tryBridgeReferences } from '../../bridge/bridgeAdapter.js';
import { xrefAvailability, type BridgeReadinessSource } from '../../bridge/bridgeReadiness.js';
import { xrefSetupAdvice } from '../../config/xrefSetup.js';
import * as fs from 'fs';
import { readIndexedMethodSources } from '../../utils/indexedMethodSource.js';

export const FindReferencesArgsSchema = z.object({
  // "name" is accepted as an alias for "targetName"
  targetName: z.string().optional().describe('Name of the target. For a precise, type-scoped method where-used, qualify it as "Owner.method" (e.g. "SalesTable.initFromSalesQuotationTable") or pass an AOT path ("/Tables/SalesTable/Methods/initFromSalesQuotationTable"). A bare method name matches that name on every type. For a label, pass the label id ("@WAX2194" or "@LabelFile:LabelId").'),
  name: z.string().optional().describe('Alias for targetName.'),
  targetType: z.enum(['method', 'class', 'table', 'field', 'enum', 'edt', 'form', 'query', 'view', 'data-entity', 'map', 'report', 'menu-item', 'index', 'field-group', 'label', 'all']).optional().describe('Type of the target to search for. For an enum value pass "Enum::Value" (or "Enum.Value") with targetType "enum"; for a table index or field group, "Table.Name" with targetType "index" or "field-group"; for a form data source method, "Form.DataSource.method".'),
  ownerName: z.string().optional().describe('Declaring table/class/form that owns the method, when targetName is just the bare method name. Used to scope the where-used to a single type (matches Visual Studio xref).'),
  scope: z.enum(['all', 'workspace', 'standard', 'custom']).optional().default('all').describe('Search scope'),
  limit: z.number().optional().default(50).describe('Maximum results to return'),
  // Default OFF: code-context snippets roughly quadruple the token cost of this tool.
  includeContext: z.boolean().optional().default(false).describe('Include code context around reference (opt-in to reduce token usage)'),
}).refine(a => a.targetName || a.name, { message: "must have required property 'targetName'" });

/**
 * Map a symbol-index `type` value to its DYNAMICSXREFDB container segment.
 * Only types that can own methods/fields are listed — these are the containers
 * the xref path "/<Container>/<Owner>/<Methods|Fields>/<member>" is built from.
 * Enums are intentionally absent: their values are not methods or fields here.
 */
const TYPE_TO_XREF_CONTAINER: Record<string, string> = {
  table: 'Tables',
  class: 'Classes',
  form: 'Forms',
  query: 'Queries',
  view: 'Views',
  map: 'Maps',
  'data-entity': 'DataEntityViews',
};

/**
 * The xref container a `targetType` names. A bare name reaches the bridge as a
 * bare name, which it expands across EVERY container — so a where-used on the
 * table CustTable also counted the form, the menu item and the query named
 * CustTable (963 extra references on a live database). A targetType that names
 * a type scopes the lookup to it: "/Tables/CustTable", whose metadata twin the
 * bridge adds itself.
 */
const TARGET_TYPE_TO_XREF_CONTAINER: Record<string, string[]> = {
  table: ['Tables'],
  class: ['Classes'],
  enum: ['Enums'],
  edt: ['Edts'],
  form: ['Forms'],
  query: ['Queries'],
  view: ['Views'],
  // An entity is not a view to the xref DB: "/Views/<entity>" matches nothing.
  'data-entity': ['DataEntityViews'],
  map: ['Maps'],
  report: ['Reports'],
  // A menu item very often shares its name with the controller class or the report
  // it runs; without this there is no way to leave those out.
  'menu-item': ['MenuItemDisplays', 'MenuItemActions', 'MenuItemOutputs'],
};

/**
 * Detect and normalize a label where-used target. Labels live in the xref DB
 * under "/Labels/@<ref>", where <ref> is either the old concatenated form
 * ("@WAX2194") or the newer "@LabelFile:LabelId" form
 * ("@ApplicationPlatform:AbortButtonText"). Both forms are stored verbatim in
 * the xref Names table, so we match exactly and never convert between them.
 * Returns the "/Labels/@…" path, or null when the target isn't a label.
 */
export function resolveLabelTarget(targetName: string, targetType?: string): string | null {
  const t = targetName.trim();
  if (/^\/Labels\//i.test(t)) return t;                          // already an xref label path
  if (t.startsWith('@')) return `/Labels/${t}`;                  // "@WAX2194" / "@ApplicationPlatform:Foo"
  if (targetType === 'label') return `/Labels/@${t}`;            // bare id + explicit targetType
  return null;
}

function isEnumName(db: any, name: string): boolean {
  return detectObjectTypeInDb(db, name).some(t => t.type === 'enum');
}

/**
 * Resolve which xref containers an owner name exists as (Tables/Classes/…).
 * Usually one; returns several only when a name collides across object types.
 */

function resolveXrefContainers(db: any, ownerName: string): string[] {
  const types = detectObjectTypeInDb(db, ownerName);
  const containers = new Set<string>();
  for (const { type } of types) {
    const container = TYPE_TO_XREF_CONTAINER[type];
    if (container) containers.add(container);
    // The index records a data entity as a 'view' (the kind is in its signature),
    // but the xref DB keeps entities under DataEntityViews. Only the path that
    // exists matches, so query both.
    if (type === 'view') containers.add('DataEntityViews');
  }
  return [...containers];
}

/**
 * [ExtensionOf] classes of `ownerName` that declare `memberName`.
 *
 * A method added to a table or class by an extension class is stored in
 * DYNAMICSXREFDB under the EXTENSION class — "/Classes/<Ext>/Methods/<m>" — and
 * only there: "/Tables/<Owner>/Methods/<m>" does not exist. So "Owner.m" has to
 * look there too, or a method every caller reaches as Owner.m reports 0. The
 * index already records each class extension, its base and its methods.
 */
function extensionClassesDeclaring(db: any, ownerName: string, memberName: string): string[] {
  let rows: Array<{ extension_name?: string; added_methods?: string | null }> = [];
  try {
    rows = db.prepare(
      `SELECT extension_name, added_methods FROM extension_metadata
       WHERE base_object_name = ? COLLATE NOCASE AND extension_type = 'class-extension'`,
    ).all(ownerName);
  } catch {
    return []; // extension_metadata not built
  }
  const wanted = memberName.toLowerCase();
  const out = new Set<string>();
  for (const row of rows) {
    if (!row?.extension_name || !row.added_methods) continue;
    let methods: unknown;
    try { methods = JSON.parse(row.added_methods); } catch { continue; }
    if (Array.isArray(methods) && methods.some(m => typeof m === 'string' && m.toLowerCase() === wanted)) {
      out.add(row.extension_name);
    }
  }
  return [...out];
}

/** Past this many declaring types a bare method name stays a bare-name lookup. */
const MAX_DECLARING_TYPES = 25;

/**
 * Every type that declares a method called `methodName`, as xref paths — or
 * null when there are none or too many to query one by one.
 *
 * A bare method name reached the bridge as a bare name, which it expands to
 * TYPE paths ("/Tables/<name>", …): for a method that matches nothing, and the
 * caller fell back to the name-based search. Resolving the declaring types from
 * the index queries the paths the calls are actually recorded under, extension
 * classes included (their methods are indexed with the extension as parent).
 */
function declaringMethodPaths(db: any, methodName: string): string[] | null {
  let rows: Array<{ parent_name?: string }> = [];
  try {
    rows = db.prepare(
      `SELECT DISTINCT parent_name FROM symbols
       WHERE type = 'method' AND name = ? AND parent_name IS NOT NULL
       LIMIT ${MAX_DECLARING_TYPES + 1}`,
    ).all(methodName);
  } catch {
    return null;
  }
  const parents = rows.map(r => r?.parent_name).filter((p): p is string => !!p);
  if (parents.length === 0 || parents.length > MAX_DECLARING_TYPES) return null;
  const paths = parents.flatMap(parent =>
    resolveXrefContainers(db, parent).map(c => `/${c}/${parent}/Methods/${methodName}`));
  return paths.length > 0 ? paths : null;
}

/**
 * Authoritative "no references" result for a member-scoped lookup that cleanly
 * returned nothing from the xref bridge. Does NOT fall back to the name-only FTS
 * scan — that would pool callers of every same-named member across all types.
 */
function buildScopedEmptyResult(displayName: string, bridgeTargets: string[]): { content: Array<{ type: 'text'; text: string }> } {
  let out = `# References to \`${displayName}\`\n\n`;
  out += `**Total References Found:** 0\n`;
  out += `_Source: C# bridge (DYNAMICSXREFDB) — scoped to the declaring type_\n\n`;
  out += `No callers found for this specific member.\n\n`;
  out += `Resolved xref path(s):\n`;
  for (const t of bridgeTargets) out += `- \`${t}\`\n`;
  out += `\n**If you expected results:** verify the owner type and method name, `;
  out += `or pass an explicit AOT path as \`targetName\` (e.g. \`/Classes/MyClass/Methods/myMethod\`).\n`;
  return { content: [{ type: 'text', text: out }] };
}

/**
 * targetTypes the name-based fallback can actually search for. The tool schema
 * advertises five more (edt, form, query, view, report) that have no branch in
 * the scan below, so asking for one ran NO query at all and reported
 * "Total References Found: 0" — a confident zero that meant "never searched".
 * Those are answered by describeUnsearchableType() instead.
 */
const FALLBACK_SEARCHABLE_TYPES = new Set(['method', 'class', 'table', 'field', 'enum', 'all']);

/**
 * Why the xref bridge did not answer, as a clause for the "_Source:_" line.
 * Every fallback used to be labelled "xref bridge unavailable", including the
 * common case where the bridge was up and healthy and simply had no rows for the
 * target — which reads as an outage and sends the reader off diagnosing one that
 * isn't happening. That mislabel cost a real investigation: an EDT where-used
 * returned this text while the bridge was serving 161 label references fine.
 *
 * 'unavailable' is two faults with different fixes, and it used to say "in this
 * server mode" for both. A running bridge without a cross-reference database is
 * the usual one on a traditional VM, where no XPP config names DYNAMICSXREFDB —
 * a setting, not a mode. A bridge still starting is a third, and needs no fix at
 * all: calling it "not connected" is the conflation behind issue #826.
 */
function bridgeFallbackReason(
  status: 'empty' | 'error' | 'unavailable',
  context: BridgeReadinessSource,
): string {
  switch (status) {
    case 'empty': return 'the cross-reference database returned no rows for this target';
    case 'error': return 'the cross-reference query failed';
    case 'unavailable':
      switch (xrefAvailability(context)) {
        case 'starting':
          return 'the C# bridge is still starting (a cold-start race, not a configuration problem)';
        case 'not-connected':
          return 'the C# bridge is not connected, and only it reads the cross-reference database';
        default:
          return 'the C# bridge runs without a cross-reference database: none is configured, ' +
            'or the configured one could not be reached';
      }
  }
}

/**
 * What to do about a missing cross-reference database, or '' when there is no
 * specific advice. A line of its own rather than part of bridgeFallbackReason,
 * whose clause is reused mid-sentence. Without the setting names the reader learns
 * that something is not configured, and not what to configure.
 */
function bridgeFallbackAdvice(
  status: 'empty' | 'error' | 'unavailable',
  context: BridgeReadinessSource,
): string {
  if (status !== 'unavailable') return '';
  switch (xrefAvailability(context)) {
    case 'starting': return 'Retry the identical call in a few seconds, once the C# bridge has started.';
    case 'no-xref': return `To get exact cross-references: ${xrefSetupAdvice()}`;
    default: return '';
  }
}

/**
 * Answer for a targetType the name-based fallback cannot serve. Returning the
 * scan's empty result here would be a lie by omission: the scan reads only X++
 * method bodies (and only each method's first ten indexed lines), while an EDT,
 * form, query, view or report is referenced mostly from declarative metadata —
 * table fields, control properties, dataset bindings — that the text index does
 * not contain. So there is no number to report, only that fact.
 *
 * Unless the bridge answered. See the 'empty' branch.
 */
function describeUnsearchableType(
  targetName: string,
  targetType: string,
  status: 'empty' | 'error' | 'unavailable',
  context: BridgeReadinessSource,
): { content: Array<{ type: 'text'; text: string }> } {
  // 'empty' is a real zero, not a missing answer. tryBridgeReferences returns it
  // only when every candidate query ran and none of them errored — anything else
  // is 'error' — so the count is as authoritative as a non-zero one, and the label
  // path above already reports its own 'empty' that way.
  //
  // It is authoritative for these five types specifically BECAUSE of the container
  // fix in this change: a bare name now expands to /Edts/, /Forms/, /Queries/,
  // /Views/ and /Reports/ — and to the metadata shape of each (EdtString/, Form/,
  // QuerySimple/, View/, Report/ …, where table fields, data sources and control
  // bindings are recorded) — so the query reaches the rows that exist instead of
  // matching nothing by construction. Calling that "inconclusive" would put back
  // the defect this function was written to remove, one layer down — and the text
  // did worse than hedge, telling the reader to "re-run once the xref bridge is
  // available" at the moment the bridge had finished answering them.
  if (status === 'empty') {
    let out = `# References to \`${targetName}\`\n\n`;
    out += `**Target Type:** ${targetType}\n`;
    out += `**Total References Found:** 0\n`;
    out += `_Source: C# bridge (DYNAMICSXREFDB)_\n\n`;
    out += `The cross-reference database was queried and matched no rows. For a \`${targetType}\` `;
    out += `that is the entire answer: its usages live in declarative metadata (table fields, form `;
    out += `control properties, dataset bindings) that only the xref DB records, so no other source `;
    out += `here could add to it.\n\n`;
    out += `Before concluding it is unused, confirm the name is written exactly as stored — a `;
    out += `misspelling is indistinguishable from a genuine miss. Check it with \`search\`/\`get_object_info\`.\n`;
    return { content: [{ type: 'text', text: out }] };
  }

  // 'error'/'unavailable': no query ran, so there is no number — only that fact.
  // The explicit AOT path is worth suggesting only here. On 'empty' it would be
  // noise: the bare name already expanded to that same path and a strict subset
  // of what was just queried, so re-running it cannot change the answer.
  const suggestion = targetName.startsWith('/') ? null : ({
    edt: `/Edts/${targetName}`, report: `/Reports/${targetName}`,
    form: `/Forms/${targetName}`, query: `/Queries/${targetName}`, view: `/Views/${targetName}`,
    'data-entity': `/DataEntityViews/${targetName}`, map: `/Maps/${targetName}`,
  } as Record<string, string>)[targetType];

  let out = `# References to \`${targetName}\`\n\n`;
  out += `**Target Type:** ${targetType}\n`;
  out += `**Result:** inconclusive — this is NOT a count of zero\n\n`;
  out += `A \`${targetType}\` where-used needs the cross-reference database (DYNAMICSXREFDB), `;
  out += `and ${bridgeFallbackReason(status, context)}.\n\n`;
  out += `The name-based index fallback cannot stand in for it here: it scans only X++ method `;
  out += `bodies, and only the first ten lines of each, whereas a ${targetType} is referenced `;
  out += `mostly from declarative metadata that is not in the text index at all. Running it would `;
  out += `have produced a number with no relationship to the real answer.\n\n`;
  out += `**What to do:**\n`;
  // Each cause gets its own fix. This used to be one "re-run once the xref bridge is
  // available … set bridge.xrefDbName" for all of them, which told a failed query
  // that the bridge it had just used was missing, and a disconnected bridge to set
  // a database name that was not the problem.
  const advice = bridgeFallbackAdvice(status, context) || (status === 'error'
    ? 'Check the bridge log for why the cross-reference query failed, then re-run'
    : 'Ensure the C# bridge exe is built and D365FO metadata is accessible ' +
      '(`.mcp.json` → `context.packagePath`), then re-run');
  out += `- ${advice}\n`;
  if (suggestion) {
    out += `- Or pass the explicit AOT path as \`targetName\`: \`${suggestion}\`\n`;
  }
  out += `- Confirm the name with \`search\`/\`get_object_info\` — a misspelling is indistinguishable from a miss\n`;
  return { content: [{ type: 'text', text: out }] };
}

interface Reference {
  file: string;
  model: string;
  line?: number;
  context: string;
  referenceType: 'call' | 'extends' | 'implements' | 'field-access' | 'instantiation' | 'type-reference';
  caller?: string;
}

export async function findReferencesTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = FindReferencesArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    const { targetType, scope, limit, includeContext, ownerName } = args;
    const targetName = (args.targetName ?? args.name)!; // accept "name" alias

    // LABEL where-used — route to the xref bridge with a "/Labels/@…" path.
    // Every referencing object type (tables, forms, EDTs, enums, reports, menu
    // items, security objects, views, maps, …) comes back — most label uses are
    // declarative metadata (captions, field/EDT labels), not X++ code.
    const labelPath = resolveLabelTarget(targetName, targetType);
    if (labelPath) {
      const outcome = await tryBridgeReferences(context.bridge, labelPath, limit, targetName, 'label');
      if (outcome.status === 'ok') return outcome.result;
      if (outcome.status === 'empty') {
        return { content: [{ type: 'text', text:
          `# References to label \`${targetName}\`\n\n**Total References Found:** 0\n` +
          `_Source: C# bridge (DYNAMICSXREFDB)_\n\n` +
          `No references found. Verify the label id is written exactly as stored — ` +
          `\`@WAX2194\` (old format) or \`@LabelFile:LabelId\` (new format, e.g. \`@ApplicationPlatform:AbortButtonText\`). ` +
          `Use labels(action="search") to find the exact id from label text.\n` }] };
      }
      // error / unavailable — label where-used needs the xref DB. The name-only
      // FTS scan can't see declarative metadata references, so don't fake a
      // partial answer by falling through to it.
      const why = outcome.status === 'unavailable'
        ? `Here, ${bridgeFallbackReason('unavailable', context)}.`
        : 'The cross-reference query failed — check the bridge log.';
      const advice = bridgeFallbackAdvice(outcome.status, context);
      return { content: [{ type: 'text', text:
        `# References to label \`${targetName}\`\n\n` +
        `⚠️ Label where-used requires the cross-reference database (DYNAMICSXREFDB), available when ` +
        `the server runs in full mode with a UDE/local xref DB configured. ${why}\n\n` +
        `Unlike code symbols, label references live mostly in declarative metadata (form captions, ` +
        `field/EDT labels, menu-item captions, …) that is not in the text index — so there is no ` +
        `reliable fallback.\n` +
        (advice ? `\n${advice}\n` : '') }], isError: outcome.status === 'error' };
    }

    // Target shape: AOT path ("/Tables/SalesTable/Methods/initFromSalesQuotationTable"),
    // owner-qualified ("SalesTable.initFromSalesQuotationTable"), or bare name.
    // Strip trailing parens; "Enum::Value" is the X++ spelling of an enum value's Owner.member.
    const cleanTargetName = targetName.replace(/\(.*$/, '').trim().replace('::', '.');
    const isAotPath = cleanTargetName.startsWith('/');

    let owner: string | null = ownerName?.trim() || null;
    let memberName = cleanTargetName;
    if (!isAotPath && cleanTargetName.includes('.')) {
      const dot = cleanTargetName.lastIndexOf('.');
      owner = owner ?? (cleanTargetName.slice(0, dot).trim() || null);
      memberName = cleanTargetName.slice(dot + 1).trim();
    }

    // An index or field group is a member of its table. Sent as a bare name, the bridge
    // expands it to "/Tables/<name>", "/Classes/<name>", … and matches nothing, which the
    // unsearchable-type answer then reported as an authoritative zero.
    if ((targetType === 'index' || targetType === 'field-group') && !owner && !isAotPath) {
      const what = targetType === 'index' ? 'a table index' : 'a field group';
      return { content: [{ type: 'text', text:
        `# References to \`${cleanTargetName}\`\n\n` +
        `**Target Type:** ${targetType}\n` +
        `**Result:** not searched — this is NOT a count of zero\n\n` +
        `${what[0].toUpperCase()}${what.slice(1)} is looked up under its table. Pass \`Table.${cleanTargetName}\` ` +
        `as targetName (e.g. \`CustTable.AccountIdx\`) or set \`ownerName\`.\n` }] };
    }

    // parentObjectName powers the cross-type ("you used a form name as a class") hint,
    // which is only for a name looked up AS a class. The owner of a member is not one:
    // a field's owner is a table, and a method's may be a table, form or view as well.
    let parentObjectName: string | null = null;
    if (targetType === 'class') {
      parentObjectName = owner ?? memberName;
    } else if (targetType === 'method' && !owner) {
      parentObjectName = memberName;
    }

    const wantsMethod = !targetType || targetType === 'method' || targetType === 'all';
    // AOT child segments to scope an "Owner.member" target to. Default covers both
    // Methods and Fields since we don't know which the member is.
    const memberSegments: string[] = [];
    if (wantsMethod) memberSegments.push('Methods');
    if (!targetType || targetType === 'field' || targetType === 'all') memberSegments.push('Fields');

    // The DYNAMICSXREFDB bridge only scopes a member to its declaring type when given
    // a member-qualified path — a bare member name matches nothing there. When an owner
    // is known, resolve its container type and build "/<Container>/<Owner>/<Methods|Fields>/<member>".
    let bridgeTargets: string[] = [cleanTargetName];
    let memberScoped = false;
    // The enum of an "Enum::Value" target, for the name-based fallback below.
    let enumValueOwner: string | null = null;
    const typeContainers = targetType ? TARGET_TYPE_TO_XREF_CONTAINER[targetType] : undefined;
    if (isAotPath) {
      memberScoped = /\/(Methods|Fields|EnumValues|TableIndexs|TableFieldGroups)\//.test(cleanTargetName);
    } else if (owner && targetType === 'enum') {
      // "Enum.Value": an enum's members are its values, "/Enums/<E>/EnumValues/<v>".
      bridgeTargets = [`/Enums/${owner}/EnumValues/${memberName}`];
      memberScoped = true;
      enumValueOwner = owner;
    } else if (owner && (targetType === 'index' || targetType === 'field-group')) {
      // Only when asked for: an index or field group very often has the name of a field of
      // the same table (1,751 tables have such a field group on a live database, 886 such an
      // index), so an untyped "Table.Name" must stay the field. X++ spells the segments
      // "TableIndexs" and "TableFieldGroups".
      const db = symbolIndex.getReadDb();
      const segment = targetType === 'index' ? 'TableIndexs' : 'TableFieldGroups';
      const allowed = targetType === 'index' ? ['Tables', 'Maps'] : ['Tables', 'Views', 'DataEntityViews', 'Maps'];
      const containers = resolveXrefContainers(db, owner).filter(c => allowed.includes(c));
      bridgeTargets = (containers.length > 0 ? containers : ['Tables'])
        .map(c => `/${c}/${owner}/${segment}/${memberName}`);
      memberScoped = true;
    } else if (owner && wantsMethod && /^[^.]+\.[^.]+$/.test(owner)) {
      // "Form.DataSource.method": the data source's own method, stored under the data
      // source by its name (not its table's).
      const [form, dataSource] = owner.split('.');
      bridgeTargets = [`/Forms/${form}/DataSources/${dataSource}/Methods/${memberName}`];
      memberScoped = true;
    } else if (owner && memberSegments.length > 0) {
      const db = symbolIndex.getReadDb();
      const paths = resolveXrefContainers(db, owner)
        .flatMap(c => memberSegments.map(seg => `/${c}/${owner}/${seg}/${memberName}`));
      // Untyped "Owner.member" on an enum can only be one of its values.
      if (targetType !== 'method' && targetType !== 'field' && isEnumName(db, owner)) {
        paths.push(`/Enums/${owner}/EnumValues/${memberName}`);
        enumValueOwner = owner;
      }
      // Owner not indexed — hand the qualified name to the bridge to resolve across container types.
      bridgeTargets = paths.length > 0 ? paths : [`${owner}.${memberName}`];
      // A method an [ExtensionOf] class adds to the owner lives under that class.
      if (wantsMethod) {
        for (const ext of extensionClassesDeclaring(db, owner, memberName)) {
          bridgeTargets.push(`/Classes/${ext}/Methods/${memberName}`);
        }
      }
      memberScoped = true;
    } else if (typeContainers && !cleanTargetName.includes('/')) {
      bridgeTargets = typeContainers.map(c => `/${c}/${cleanTargetName}`);
    } else if (wantsMethod && targetType !== 'all') {
      // A bare method name, when it is not also a type name (then it stays a type
      // lookup): query the types that declare it, extension classes included.
      const db = symbolIndex.getReadDb();
      // Any object type counts, not only the ones that own members: an EDT or enum
      // named like some method must stay a type lookup.
      const isTypeName = targetType !== 'method' && detectObjectTypeInDb(db, memberName).length > 0;
      const paths = isTypeName ? null : declaringMethodPaths(db, memberName);
      if (paths) {
        bridgeTargets = paths;
        memberScoped = true;
      }
    }

    // Try C# bridge first (DYNAMICSXREFDB — live cross-references)
    const bridgeOutcome = await tryBridgeReferences(context.bridge, bridgeTargets, limit, targetName);
    if (bridgeOutcome.status === 'ok') return bridgeOutcome.result;

    // For a member-scoped lookup, the bridge is authoritative only on a clean 'empty'.
    // On 'error'/'unavailable' fall through to the FTS heuristic instead of reporting
    // a confident "0 references" we can't stand behind.
    if (memberScoped && bridgeOutcome.status === 'empty') {
      return buildScopedEmptyResult(targetName, bridgeTargets);
    }

    // The scan below has no branch for edt/form/query/view/report, so for those a
    // "0" would mean "not searched" rather than "not found". Say that outright
    // instead of running a scan that structurally cannot see their usages.
    if (targetType && !FALLBACK_SEARCHABLE_TYPES.has(targetType)) {
      return describeUnsearchableType(targetName, targetType, bridgeOutcome.status, context);
    }

    // FTS fallback (xref bridge unavailable) — name-based heuristic, cannot scope
    // a method to its declaring type; match on the bare member name.
    const ftsName = isAotPath
      ? (cleanTargetName.split('/').pop() || cleanTargetName)
      : memberName;
    const references: Reference[] = [];
    let totalReferences = 0;

    // 1. Search for method calls
    if (!targetType || targetType === 'method' || targetType === 'all') {
      const methodRefs = findMethodReferences(symbolIndex, ftsName, scope, limit);
      references.push(...methodRefs);
    }

    // 2. Search for class references (extends, implements, instantiations)
    if (!targetType || targetType === 'class' || targetType === 'all') {
      const classRefs = findClassReferences(symbolIndex, ftsName, scope, limit);
      references.push(...classRefs);
    }

    // 3. Search for table references (select statements, table buffers)
    if (!targetType || targetType === 'table' || targetType === 'all') {
      const tableRefs = findTableReferences(symbolIndex, ftsName, scope, limit);
      references.push(...tableRefs);
    }

    // 4. Search for field references
    if (!targetType || targetType === 'field' || targetType === 'all') {
      const fieldRefs = findFieldReferences(symbolIndex, ftsName, scope, limit);
      references.push(...fieldRefs);
    }

    // 5. Search for enum references
    if (!targetType || targetType === 'enum' || targetType === 'all') {
      // An enum value is written "Enum::Value" in code: search the enum, keep that value.
      const enumRefs = enumValueOwner
        ? findEnumReferences(symbolIndex, enumValueOwner, scope, limit, memberName)
        : findEnumReferences(symbolIndex, ftsName, scope, limit);
      references.push(...enumRefs);
    }

    // 6. The previews cannot show a call site past line 10 of its caller, and
    // intra-type calls are where that bites hardest. Recover them from the
    // declaring type's own source — one indexed lookup and up to three files.
    const intraTypeRefs = wantsMethod
      ? scanDeclaringTypeSource(symbolIndex, ftsName, limit).filter(
          // Same call site already reported from the index. The two paths cut
          // different windows around it (±1 line here, ±2 there), so equal
          // contexts never matched and every call both found was listed twice.
          // Compared by the call line, not the whole window: a call on the first
          // line of a method body takes its leading line from the FILE here but
          // has none in the indexed body, so the window is not a substring there.
          r => {
            const callLine = r.context.split('\n').find(l => callOf(ftsName).test(l))?.trim();
            return !references.some(
              existing => existing.file === r.file && (existing.context.includes(r.context) || (!!callLine && existing.context.includes(callLine))),
            );
          },
        )
      : [];
    references.push(...intraTypeRefs);

    totalReferences = references.length;
    const limitedReferences = references.slice(0, limit);
    const summary = generateReferenceSummary(limitedReferences);

    let output = `# References to \`${targetName}\`\n\n`;
    output += `**Total References Found:** ${totalReferences}\n`;
    output += `**Showing:** ${limitedReferences.length} results\n`;
    if (targetType) {
      output += `**Target Type:** ${targetType}\n`;
    }
    output += `**Scope:** ${scope}\n`;
    output += `_Source: name-based index scan — ${bridgeFallbackReason(bridgeOutcome.status, context)}; heuristic, not scoped to a declaring type._\n`;
    const advice = bridgeFallbackAdvice(bridgeOutcome.status, context);
    if (advice) output += `> ℹ️ ${advice}\n`;
    if (intraTypeRefs.length > 0) {
      output += `_${intraTypeRefs.length} of these came from reading the declaring type's source directly — ` +
        `the index only previews a method's first 10 lines, so calls below that are invisible to the scan above._\n`;
    }
    if (wantsMethod && !isAotPath) {
      // The note used to print only when no owner was given, so a caller who DID
      // scope the lookup got an unscoped answer that looked scoped — the worse of
      // the two cases, and the one silently ignoring the parameter it accepted.
      output += owner
        ? `> ⚠️ \`ownerName\` could NOT be honoured: this fallback matches the bare method name, ` +
          `so a same-named method on an unrelated type is counted as a hit. Only the xref bridge ` +
          `can scope a member to its declaring type.\n`
        : `> ℹ️ This counts every method named \`${ftsName}\` regardless of owner. For a type-scoped where-used, pass \`ownerName\` or qualify as \`Owner.${ftsName}\`.\n`;
    }
    // A table is referenced from metadata as much as from code, and this scan
    // sees only code — the same reason an EDT gets "inconclusive" above. A table
    // still has code references worth counting, so say what the number leaves out.
    const tableTarget = targetType === 'table' ||
      (!targetType && !isAotPath && resolveXrefContainers(symbolIndex.getReadDb(), ftsName).includes('Tables'));
    // form_datasources records which base forms bind this table, so the fallback can list
    // them; form extensions are not indexed.
    const formsUsingTable = tableTarget ? findFormsUsingTable(symbolIndex.getReadDb(), ftsName, limit) : null;
    if (tableTarget) {
      output += `> ⚠️ For a table this counts X++ code only. Its declarative references — ` +
        `relations, data entity mappings, fields bound on forms — are recorded only in the cross-reference ` +
        `database, and ${bridgeFallbackReason(bridgeOutcome.status, context)}.` +
        (formsUsingTable?.indexed
          ? ` Its form data sources are listed below from the index (base forms only: form extensions, ` +
            `views, maps and code inside forms are not covered).`
          : ` Its form data sources are not available from this index.`) +
        `\n`;
    }
    output += `\n`;
    if (formsUsingTable) output += renderFormsUsingTable(ftsName, formsUsingTable);

    // Detect when the caller used a form/table/view name as if it were a class
    const typeMismatchSection = parentObjectName
      ? buildObjectTypeMismatchMessage(symbolIndex.getReadDb(), parentObjectName)
      : '';

    if (limitedReferences.length === 0) {
      // A zero from this path is NOT evidence of anything. The xref bridge is
      // down, so the answer comes from a name scan over whatever source the index
      // extracted — and if the target's own source was never extracted, the scan
      // had nothing to match in the first place. Reported live on the VM: an
      // agent read `Total References Found: 0 … Symbol might be unused` for a
      // method with two real call sites, and acted on it.
      output += `${formsUsingTable && formsUsingTable.total > 0 ? 'No X++ code references found' : 'No references found'} for \`${targetName}\` — **this is not evidence that it is unused.**\n\n`;
      output += `⚠️ Because ${bridgeFallbackReason(bridgeOutcome.status, context)}, call sites are matched against each method's indexed ` +
        `\`source_snippet\`, which holds only its FIRST TEN LINES. A call on line 11 or later of its ` +
        `caller cannot be seen from here, and long methods are exactly where calls hide. The declaring ` +
        `type's own source was read directly and had none either, which is the strongest statement ` +
        `this run can make.\n\n`;
      output += `**Before treating this as "unused":**\n`;
      output += `- Re-run once the xref bridge (DYNAMICSXREFDB) is available; it is the only authoritative where-used\n`;
      output += `- Read the callers you suspect — a caller in another type is still invisible past its tenth line\n`;
      output += `- Confirm the name and spelling with \`search\`/\`get_object_info\` — a wrong name also returns zero here\n`;
      if (typeMismatchSection) {
        output += `\n${typeMismatchSection}`;
      }
    } else {
      const byType = groupByReferenceType(limitedReferences);

      output += `## 📊 Summary by Type\n\n`;
      for (const [type, refs] of Object.entries(byType)) {
        output += `- **${type}**: ${refs.length} reference(s)\n`;
      }
      output += `\n`;

      // Show top callers
      if (summary.topCallers.length > 0) {
        output += `## 🔝 Top Callers\n\n`;
        for (const caller of summary.topCallers.slice(0, 10)) {
          output += `- **${caller.caller}** (${caller.count} call(s))\n`;
        }
        output += `\n`;
      }

      output += `## 📍 All References\n\n`;
      for (const ref of limitedReferences) {
        output += `### ${ref.referenceType} in \`${ref.file}\`\n\n`;
        output += `**Model:** ${ref.model}\n`;
        if (ref.caller) {
          output += `**Caller:** ${ref.caller}\n`;
        }
        if (includeContext && ref.context) {
          output += `\n**Context:**\n\`\`\`xpp\n${ref.context}\n\`\`\`\n`;
        }
        output += `\n`;
      }

      // Show even when references were found — they might be fuzzy-match false positives
      if (typeMismatchSection) {
        output += `\n---\n\n${typeMismatchSection}`;
      }
    }

    const finalResult = {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };

    return finalResult;
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error finding references: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Run an FTS5 search on source_snippet (and optionally extra columns) for method symbols.
 * Dramatically faster than `source_snippet LIKE '%term%'` — uses the pre-built FTS index.
 * FTS5 tokenizes on non-word characters (., :, (, ), etc.) so the bare symbol name matches
 * all surrounding call patterns (.name(, ::name(, new name(, etc.).
 * Falls back to an empty array when the FTS query fails (e.g. single-char or reserved word).
 */
function ftsMethodSearch(db: any, term: string, limit: number, extraColumns?: string): any[] {
  // Strip chars that would break FTS5 query syntax
  const safe = term.replace(/["\(\)\\]/g, '').trim();
  if (!safe) return [];
  const cols = extraColumns ? `{source_snippet ${extraColumns}}` : '{source_snippet}';
  const ftsQuery = `${cols} : "${safe}"`;
  try {
    const stmt = db.prepare(`
      SELECT s.name, s.parent_name, s.file_path, s.model, s.source_snippet, s.source
      FROM symbols s
      WHERE s.type = 'method'
        AND s.id IN (SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ?)
      LIMIT ?
    `);
    return stmt.all(ftsQuery, limit) as any[];
  } catch {
    return [];
  }
}

/**
 * The text a matched row's context is extracted from: the whole indexed body,
 * falling back to the ten-line preview.
 *
 * The FTS index covers `source_snippet`, not `source`, so what this can and
 * cannot FIND is unchanged — a caller whose first ten lines never mention the
 * name is still invisible, and fixing that means indexing `source` into
 * symbols_fts, which is a schema change and a re-index, not this.
 *
 * What it changes is what happens AFTER a match. The extractors were handed the
 * same ten lines FTS matched on, so a method that mentions the name in its
 * preview (a declaration, a comment, an early call) but makes the call being
 * reported further down yielded no context and was silently dropped from the
 * results — a row FTS had correctly matched, discarded at the rendering step.
 */
function bodyOf(row: { source?: string | null; source_snippet?: string | null }): string {
  return row.source || row.source_snippet || '';
}

/**
 * The blind spot this fallback cannot see out of, and the one read that covers
 * the commonest case.
 *
 * `source_snippet` is the method's FIRST TEN LINES — a preview, by construction
 * (xmlParser.ts, enhancedParser.ts: "First 10 lines for preview"). The FTS
 * fallback matches against those previews, so a call site on line 11 or later of
 * ANY caller is structurally invisible to it. Measured on the VM:
 * `find_references(buildAdjustIn)` returned `Total References Found: 0 … Symbol
 * might be unused` while `WHSWorkExecuteDisplayAdjustIn.displayForm` — hundreds
 * of lines long — calls it twice; the single "hit" the tool did report on a
 * sibling method was that method's own declaration, which of course sits in its
 * own first ten lines.
 *
 * Intra-type calls are both the commonest miss and the cheapest to recover: the
 * declaring type is one indexed lookup away and its source is ONE file. This
 * reads that file and returns the real call sites, rather than telling the
 * caller to go and do it by hand.
 */
function scanDeclaringTypeSource(symbolIndex: any, methodName: string, limit: number): Reference[] {
  const found: Reference[] = [];
  if (!methodName) return found;
  try {
    const db = symbolIndex?.getReadDb?.();
    if (!db) return found;
    // Declaring types for this member — indexed by name, never a scan. Bounded:
    // a name shared by many types is exactly the unscoped case, and reading
    // every one of their files would cost more than the answer is worth.
    const owners = db
      .prepare(
        `SELECT DISTINCT parent_name, file_path FROM symbols
         WHERE name = ? AND type = 'method' AND parent_name IS NOT NULL AND file_path IS NOT NULL
         LIMIT 3`,
      )
      .all(methodName) as Array<{ parent_name: string; file_path: string }>;

    for (const owner of owners) {
      let source: string | undefined;
      // "Reachable but deliberately not read" is not the same as "cannot be
      // read": falling through to the index for an 8 MB owner would spend the
      // very cost this guard exists to refuse, just on a different source.
      let refusedByGuard = false;
      try {
        const stat = fs.statSync(owner.file_path);
        // An AOT class file is source; anything enormous is not worth the read.
        if (stat.isFile() && stat.size <= 8_000_000) {
          source = fs.readFileSync(owner.file_path, 'utf-8');
        } else {
          refusedByGuard = true;
        }
      } catch { /* not reachable from here — try the index below */ }
      if (refusedByGuard) continue;

      // The file is a Windows-VM path, so on Azure the read above can never
      // succeed and this recovery returned nothing at all. The same bodies are
      // in the index — each scanned on its own, NOT concatenated: the rows come
      // back in no particular order, so a call on a body's first line would take
      // its leading context line from the closing brace of an unrelated method
      // and show the agent source that does not exist anywhere.
      let texts: string[];
      if (source !== undefined) {
        texts = [source];
      } else {
        const bodies = readIndexedMethodSources(db, owner.parent_name);
        if (bodies.size === 0) continue;
        texts = [...bodies.values()].map(m => m.source);
      }

      const call = callOf(methodName);
      const qualifiedCall = new RegExp(`::\\s*${escapeRegExp(methodName)}\\s*\\(`, 'i');
      for (const text of texts) {
        if (found.length >= limit) break;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && found.length < limit; i++) {
          // `this.m(` and `Type::m(` are calls; `m(` alone would match the
          // declaration and every same-named member in the file.
          if (!/\bthis\s*\.\s*\w+\s*\(/.test(lines[i]) && !qualifiedCall.test(lines[i])) continue;
          if (!call.test(lines[i])) continue;
          found.push({
            file: owner.file_path,
            model: '',
            context: lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2)).join('\n').trim(),
            referenceType: 'call',
            caller: owner.parent_name,
          });
        }
      }
    }
  } catch {
    // Best-effort recovery — it must never turn a degraded answer into no answer.
  }
  return found;
}

function findMethodReferences(symbolIndex: any, methodName: string, _scope: string, limit: number): Reference[] {
  const references: Reference[] = [];
  const rdb = symbolIndex.getReadDb();

  const rows = ftsMethodSearch(rdb, methodName, limit * 3, 'signature');

  for (const row of rows) {
    // Match on the preview, render from the whole body. FTS can only find a
    // method whose FIRST TEN LINES mention the name, but once it has, the call
    // being reported is often further down — and extracting context from the
    // preview then returned nothing, dropping a row FTS had correctly matched.
    // In the method's own body the first "name(" is its declaration, not a call.
    const isDeclaringMethod = typeof row.name === 'string' && row.name.toLowerCase() === methodName.toLowerCase();
    const context = extractMethodCallContext(bodyOf(row), methodName, isDeclaringMethod);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'call',
        caller: row.parent_name ? `${row.parent_name}.${row.name}` : row.name,
      });
    }
  }

  return references;
}

/** Find class references (extends, implements, instantiations) */
function findClassReferences(symbolIndex: any, className: string, _scope: string, limit: number): Reference[] {
  const references: Reference[] = [];
  const rdb = symbolIndex.getReadDb();

  // 1. Find classes that extend this class
  const extendsStmt = rdb.prepare(`
    SELECT name, file_path, model, extends_class
    FROM symbols
    WHERE type = 'class'
      AND extends_class = ?
    LIMIT ?
  `);

  const extendRows = extendsStmt.all(className, limit);
  for (const row of extendRows) {
    references.push({
      file: row.file_path,
      model: row.model,
      context: `class ${row.name} extends ${className}`,
      referenceType: 'extends',
      caller: row.name,
    });
  }

  // 2. Find classes that implement this interface
  const implementsStmt = rdb.prepare(`
    SELECT name, file_path, model, implements_interfaces
    FROM symbols
    WHERE type = 'class'
      AND implements_interfaces LIKE ?
    LIMIT ?
  `);

  const implRows = implementsStmt.all(`%${className}%`, limit);
  for (const row of implRows) {
    if (row.implements_interfaces && row.implements_interfaces.includes(className)) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: `class ${row.name} implements ${className}`,
        referenceType: 'implements',
        caller: row.name,
      });
    }
  }

  // 3. Find instantiations (new ClassName())
  // FTS5: search for className in source_snippet; extractInstantiationContext filters for 'new ClassName('
  const instRows = ftsMethodSearch(rdb, className, limit);
  for (const row of instRows) {
    const context = extractInstantiationContext(bodyOf(row), className);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'instantiation',
        caller: row.parent_name ? `${row.parent_name}.${row.name}` : row.name,
      });
    }
  }

  // 4. Find general type references (classStr(), variable declarations, static calls)
  // FTS5: a single indexed lookup replaces three LIKE full-table scans
  const typeRefRows = ftsMethodSearch(rdb, className, limit);
  const existingCallers = new Set(references.map(r => r.caller));
  for (const row of typeRefRows) {
    const caller = row.parent_name ? `${row.parent_name}.${row.name}` : row.name;
    if (existingCallers.has(caller)) continue; // skip duplicates
    const context = extractTableReferenceContext(bodyOf(row), className);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'type-reference',
        caller,
      });
      existingCallers.add(caller);
    }
  }

  return references;
}

function findTableReferences(symbolIndex: any, tableName: string, _scope: string, limit: number): Reference[] {
  const references: Reference[] = [];
  const rdb = symbolIndex.getReadDb();

  const rows = ftsMethodSearch(rdb, tableName, limit);

  for (const row of rows) {
    const context = extractTableReferenceContext(bodyOf(row), tableName);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'type-reference',
        caller: row.parent_name ? `${row.parent_name}.${row.name}` : row.name,
      });
    }
  }

  return references;
}

function findFieldReferences(symbolIndex: any, fieldName: string, _scope: string, limit: number): Reference[] {
  const references: Reference[] = [];
  const rdb = symbolIndex.getReadDb();

  const rows = ftsMethodSearch(rdb, fieldName, limit);

  for (const row of rows) {
    const context = extractFieldAccessContext(bodyOf(row), fieldName);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'field-access',
        caller: row.parent_name ? `${row.parent_name}.${row.name}` : row.name,
      });
    }
  }

  return references;
}

function findEnumReferences(symbolIndex: any, enumName: string, _scope: string, limit: number, value?: string): Reference[] {
  const references: Reference[] = [];
  const rdb = symbolIndex.getReadDb();

  const rows = ftsMethodSearch(rdb, enumName, limit);

  for (const row of rows) {
    const context = extractEnumReferenceContext(bodyOf(row), enumName, value);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'type-reference',
        caller: row.parent_name ? `${row.parent_name}.${row.name}` : row.name,
      });
    }
  }

  return references;
}

/** A symbol name as a literal regex fragment. */
function escapeRegExp(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * "name(" the way X++ may write it: identifiers are case-insensitive and a
 * space may stand before the parenthesis, so "validatewrite()" and
 * "validateWrite ()" call validateWrite just as much. An exact
 * includes("validateWrite(") dropped them — after the case-insensitive FTS
 * lookup had already matched the method — and it also matched the tail of a
 * longer name ("myValidateWrite(").
 */
function callOf(name: string): RegExp {
  return new RegExp(`(?<![\\w$])${escapeRegExp(name)}\\s*\\(`, 'i');
}

/** Leading words that make a "name(" line a statement, not a declaration. */
const STATEMENT_START = /^\s*(?:return|if|while|for|switch|case|throw|else|print|info|warning|error|next|super)\b/i;

/**
 * Whether a line declares `methodName` — "public static void name(", "display Name name(" —
 * rather than calling it. Only the declaring method's own body is checked, so a
 * same-named call elsewhere is never dropped by this.
 */
function isMethodDeclarationLine(line: string, methodName: string): boolean {
  const declaration = new RegExp(`^\\s*(?:[A-Za-z_][\\w.<>\\[\\]]*\\s+)+${escapeRegExp(methodName)}\\s*\\(`, 'i');
  // No "=" test: an assignment ("real t = calcTotal(") cannot match the anchored
  // type-and-modifier prefix anyway, while a default parameter value
  // ("void foo(int _x = 5)") is still a declaration.
  return declaration.test(line) && !STATEMENT_START.test(line);
}

function extractMethodCallContext(source: string, methodName: string, skipDeclaration = false): string | null {
  if (!source) return null;

  const call = callOf(methodName);
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (call.test(lines[i])) {
      // The declaration counted as a call of the method to itself.
      if (skipDeclaration && isMethodDeclarationLine(lines[i], methodName)) continue;
      // Return 2 lines before and after
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length, i + 3);
      return lines.slice(start, end).join('\n').trim();
    }
  }

  return null;
}

function extractInstantiationContext(source: string, className: string): string | null {
  if (!source) return null;

  const pattern = new RegExp(`\\bnew\\s+${escapeRegExp(className)}\\s*\\(`, 'i');
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      return lines.slice(start, end).join('\n').trim();
    }
  }

  return null;
}

interface FormsUsingTable {
  /** False when form_datasources is empty or unreadable — then a zero says nothing. */
  indexed: boolean;
  /** Distinct (form, model) pairs, not datasource rows: one form can bind a table twice. */
  total: number;
  rows: Array<{ form_name: string; model: string; datasources: string }>;
}

/**
 * Forms with a datasource on `tableName`, from the index's form_datasources.
 *
 * COLLATE NOCASE on purpose: some rows store a mis-cased table_name (a form's XML names
 * the table as the author typed it), and a BINARY match on the canonical name misses
 * them. Any failure — an old database, a stub DB — reads as "not indexed", never as a
 * confident zero.
 */
function findFormsUsingTable(db: any, tableName: string, limit: number): FormsUsingTable {
  const none: FormsUsingTable = { indexed: false, total: 0, rows: [] };
  try {
    const probe = db.prepare('SELECT EXISTS(SELECT 1 FROM form_datasources) AS indexed').get() as { indexed?: number } | undefined;
    if (!probe?.indexed) return none;
    const rows = db.prepare(
      `SELECT form_name, model, group_concat(datasource_name) AS datasources
         FROM form_datasources
        WHERE table_name = ? COLLATE NOCASE
        GROUP BY form_name, model
        ORDER BY form_name
        LIMIT ?`,
    ).all(tableName, limit) as FormsUsingTable['rows'];
    const count = db.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM form_datasources WHERE table_name = ? COLLATE NOCASE GROUP BY form_name, model)`,
    ).get(tableName) as { n?: number } | undefined;
    return { indexed: true, total: count?.n ?? rows.length, rows };
  } catch {
    return none;
  }
}

function renderFormsUsingTable(tableName: string, forms: FormsUsingTable): string {
  let out = `## 🧾 Forms using \`${tableName}\` as a datasource\n\n`;
  if (!forms.indexed) {
    out += `No form datasources indexed — this index holds none, so forms cannot be listed from it.\n\n`;
    return out;
  }
  if (forms.total === 0) {
    out += `No base forms use this table as a datasource (form extensions are not indexed).\n\n`;
    return out;
  }
  out += `**Forms:** ${forms.total}\n\n`;
  for (const f of forms.rows) {
    out += `- \`${f.form_name}\` (${f.model}) — datasource${f.datasources.includes(',') ? 's' : ''}: ${f.datasources.split(',').join(', ')}\n`;
  }
  if (forms.total > forms.rows.length) {
    out += `- … and ${forms.total - forms.rows.length} more\n`;
  }
  out += `\n`;
  return out;
}

function extractTableReferenceContext(source: string, tableName: string): string | null {
  if (!source) return null;

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(tableName)) {
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      return lines.slice(start, end).join('\n').trim();
    }
  }

  return null;
}

function extractFieldAccessContext(source: string, fieldName: string): string | null {
  if (!source) return null;

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('.' + fieldName)) {
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      return lines.slice(start, end).join('\n').trim();
    }
  }

  return null;
}

function extractEnumReferenceContext(source: string, enumName: string, value?: string): string | null {
  if (!source) return null;

  // With a value, only "Enum::Value" itself — not "Enum::ValueOther" or another value.
  const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const valueRef = value ? new RegExp(`\\b${escapeRe(enumName)}::${escapeRe(value)}\\b`, 'i') : null;
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (valueRef ? valueRef.test(lines[i]) : lines[i].includes(enumName + '::')) {
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      return lines.slice(start, end).join('\n').trim();
    }
  }

  return null;
}

function generateReferenceSummary(references: Reference[]): {
  topCallers: Array<{ caller: string; count: number }>;
} {
  const callerCounts = new Map<string, number>();

  for (const ref of references) {
    if (ref.caller) {
      callerCounts.set(ref.caller, (callerCounts.get(ref.caller) || 0) + 1);
    }
  }

  const topCallers = Array.from(callerCounts.entries())
    .map(([caller, count]) => ({ caller, count }))
    .sort((a, b) => b.count - a.count);

  return { topCallers };
}

function groupByReferenceType(references: Reference[]): Record<string, Reference[]> {
  const groups: Record<string, Reference[]> = {};

  for (const ref of references) {
    if (!groups[ref.referenceType]) {
      groups[ref.referenceType] = [];
    }
    groups[ref.referenceType].push(ref);
  }

  return groups;
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/findReferences.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.
