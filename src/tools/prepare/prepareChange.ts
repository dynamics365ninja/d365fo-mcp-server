/**
 * prepare_change — single-round context aggregator for D365FO extension work.
 *
 * Gathers in one call everything an AI needs to safely extend an existing
 * D365FO object:
 *   - exact method signature from the symbol index
 *   - existing CoC wrappers (bridge-first via DYNAMICSXREFDB, index fallback)
 *   - CoC/event-handler eligibility
 *   - recommended extension strategy
 *   - object naming validation for the proposed new name
 *   - relevant code patterns
 *
 * Internally runs up to 5 index/bridge queries in parallel. Returns a
 * provenance token (SHA-256, 30-min TTL) that proves the model looked at
 * the real codebase before writing code.
 *
 * Fail-closed enforcement: when GROUNDING_ENFORCE=true, extension patterns
 * in generate_object(mode="pattern") and d365fo_file(action="create") require this token.
 */

import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { createProvenanceToken } from '../../utils/provenanceStore.js';
import { tryBridgeCocExtensions } from '../../bridge/bridgeAdapter.js';
import { checkObjectNaming } from '../../utils/objectNamingRules.js';
import { lookupSymbolNocase, lookupSymbolsNocase, type SymbolHit } from '../../utils/symbolLookup.js';
import { findDeclaringAncestor } from '../../utils/inheritanceChain.js';
import {
  hasTableDataMethods,
  lookupTableDataMethod,
  renderTableDataMethodEligibility,
  renderTableDataMethodSignature,
} from '../../knowledge/tableDataMethods.js';
import { renderPrepareOpSpec } from '../specs/opSpecs.js';
import { rankContext, renderRankedContext } from '../../workspace/contextRanker.js';

// Schema

export const prepareChangeArgsSchema = z.object({
  goal: z.string().describe(
    'One-sentence description of the intended change. ' +
    'Example: "Add CoC on CustTable.validateWrite to enforce a custom rule."',
  ),
  objectName: z.string().describe(
    'Name of the D365FO object to extend or modify (class, table, form, etc.). ' +
    'Example: "CustTable", "SalesFormLetter", "CustPostInvoice".',
  ),
  methodName: z.string().optional().describe(
    'Target method name when the change involves a specific method (CoC or event handlers). ' +
    'Example: "validateWrite", "insert", "post".',
  ),
  objectType: z.enum([
    'class', 'table', 'form', 'query', 'view', 'enum', 'edt',
    'data-entity', 'map', 'report', 'security-duty', 'security-role',
  ]).optional().describe(
    'D365FO object type. Auto-detected from the symbol index when omitted.',
  ),
  proposedName: z.string().optional().describe(
    'Proposed name for the new extension class/object. ' +
    'When provided, naming validation runs and the result is included in the bundle.',
  ),
});

// Helpers

/** Case-insensitive top-level object lookup — see src/utils/symbolLookup.ts. */
function lookupObjectNocase(
  objectName: string,
  context: XppServerContext,
): { name: string; type: string; model: string | null } | undefined {
  return lookupSymbolNocase(context.symbolIndex.getReadDb(), objectName);
}

/**
 * Deterministic tie-break when one name exists as several top-level types.
 *
 * Order is by how likely the type is to be the thing someone says "change X"
 * about, most likely first; anything not listed sorts after all of these.
 */
const TYPE_PREFERENCE: readonly string[] = [
  'table', 'class', 'form', 'view', 'query', 'data-entity', 'report',
];

function typeRank(type: string): number {
  const i = TYPE_PREFERENCE.indexOf(type);
  return i === -1 ? TYPE_PREFERENCE.length : i;
}

export interface ResolvedObject {
  name: string;
  type: string;
  /** Other top-level types the same name resolves to, for the disclosure line. */
  alsoTypes: string[];
  /** True when the winner was picked because it DECLARES the requested method. */
  byMethod: boolean;
}

/**
 * Which candidate declares `methodName`, identified by file.
 *
 * The symbols table has no parent_type column, so a method row cannot name its
 * owner's type directly — but every row carries `file_path`, and a method row
 * with `parent_name = <canonical name>` sits in the file of the object that
 * declares it. Matching that against each candidate's own `file_path` picks the
 * owner unambiguously.
 */
function candidateDeclaringMethod(
  db: ReturnType<XppServerContext['symbolIndex']['getReadDb']>,
  candidates: SymbolHit[],
  methodName: string,
): SymbolHit | undefined {
  const names = [...new Set(candidates.map(c => c.name))];
  const stmt = db.prepare(
    `SELECT file_path FROM symbols
     WHERE parent_name = ? AND type = 'method' AND name = ? COLLATE NOCASE
     LIMIT 20`,
  );
  const owners = new Set<string>();
  for (const n of names) {
    for (const row of stmt.all(n, methodName) as Array<{ file_path: string | null }>) {
      if (row.file_path) owners.add(row.file_path);
    }
  }
  if (owners.size === 0) return undefined;
  return [...candidates]
    .sort((a, b) => typeRank(a.type) - typeRank(b.type))
    .find(c => c.file_path != null && owners.has(c.file_path));
}

/**
 * Resolve an object's canonical name + type from the symbol index.
 *
 * VERIFIED LIVE: `prepare(mode="change", objectName="CustTable",
 * methodName="validateWrite")` resolved CustTable as a **form** and answered
 * with form-extension strategies. `lookupSymbolNocase` runs
 * `WHERE s.name = ? AND s.parent_name IS NULL LIMIT 1` with no ORDER BY, so
 * whichever row the index happened to yield first won — and CustTable exists as
 * form, menu-item-display, query AND table. Nothing in the output said the name
 * was ambiguous, which is what made the wrong answer invisible.
 *
 * So: take ALL candidates, and pick on evidence rather than row order —
 * the object that actually declares the requested method first, an explicitly
 * passed objectType before that, and the documented preference order last.
 * symbolLookup.ts is deliberately left alone; other callers depend on it.
 */
async function resolveObject(
  objectName: string,
  explicitType: string | undefined,
  methodName: string | undefined,
  context: XppServerContext,
): Promise<ResolvedObject | undefined> {
  try {
    const db = context.symbolIndex.getReadDb();
    // 10 is well above the worst real case (CustTable: 4 top-level rows) and
    // keeps the FTS fallback in lookupSymbolsNocase bounded.
    const candidates = lookupSymbolsNocase(db, objectName, { limit: 10 });
    if (candidates.length === 0) return undefined;

    const others = (winner: SymbolHit): string[] =>
      [...new Set(candidates.map(c => c.type))].filter(t => t !== winner.type).sort();

    // An explicit objectType is the caller's answer to the ambiguity — honour it
    // (and use the row's canonical casing) before any inference.
    if (explicitType) {
      const match = candidates.find(c => c.type === explicitType);
      if (match) return { name: match.name, type: match.type, alsoTypes: others(match), byMethod: false };
    }

    if (methodName) {
      const owner = candidateDeclaringMethod(db, candidates, methodName);
      if (owner) return { name: owner.name, type: owner.type, alsoTypes: others(owner), byMethod: true };
    }

    const best = [...candidates].sort((a, b) => typeRank(a.type) - typeRank(b.type))[0];
    return { name: best.name, type: best.type, alsoTypes: others(best), byMethod: false };
  } catch {
    return undefined;
  }
}

interface MethodLookup {
  row: { signature: string; tags: string };
  /** Class the row was actually read from. */
  owner: string;
  /** True when `owner` is an ancestor rather than the object the caller named. */
  inherited: boolean;
}

/**
 * Method row for `objectName::methodName`, falling back to the ancestor that
 * DECLARES it.
 *
 * `parent_name = ?` matches declared members only, so a leaf class reported a
 * bare "not found" for everything it inherits — and prepare is the aggregator
 * agents are told to start from, so that read as "the method does not exist"
 * and the CoC path was abandoned. The class worth wrapping is usually a leaf
 * (SalesFormLetter_Invoice does not declare `promptAndRun`; SalesFormLetter
 * does), which made the miss the common case rather than an edge one.
 *
 * Index-safe: the extra probe reuses `findDeclaringAncestor`, which walks
 * `extends_class` and keeps `parent_name` BINARY on idx_parent_type_name.
 */
function readMethodRow(
  context: XppServerContext,
  objectName: string,
  methodName: string,
): MethodLookup | undefined {
  try {
    const db = context.symbolIndex.getReadDb();
    // parent_name stays BINARY (canonical casing resolved upstream) so the
    // probe uses idx_parent_type_name; NOCASE applies only to the method name
    // within that object's few hundred method rows.
    const stmt = db.prepare(
      `SELECT signature, tags FROM symbols
       WHERE parent_name = ? AND type = 'method' AND name = ? COLLATE NOCASE
       LIMIT 1`,
    );
    const own = stmt.get(objectName, methodName) as MethodLookup['row'] | undefined;
    if (own) return { row: own, owner: objectName, inherited: false };

    const declaring = findDeclaringAncestor(db, objectName, methodName);
    if (!declaring) return undefined;
    const inheritedRow = stmt.get(declaring, methodName) as MethodLookup['row'] | undefined;
    return inheritedRow ? { row: inheritedRow, owner: declaring, inherited: true } : undefined;
  } catch {
    // ignore DB errors
    return undefined;
  }
}

/** Look up method signature from the symbol index, including inherited methods. */
async function fetchMethodSignature(
  objectName: string,
  methodName: string,
  objectType: string | undefined,
  context: XppServerContext,
): Promise<string> {
  const found = readMethodRow(context, objectName, methodName);
  if (found) {
    const { row, owner, inherited } = found;
    const lines = [`Signature : ${row.signature ?? '(unavailable)'}`];
    if (inherited) {
      lines.push(
        `ℹ️  Inherited — \`${objectName}\` does not declare \`${methodName}\`; ` +
        `it is declared on \`${owner}\`, which is where this signature comes from.`,
      );
    }
    const tags = row.tags ?? '';
    if (tags.includes('hookable:false')) lines.push('⛔ [Hookable(false)] — CoC is blocked.');
    if (tags.includes('wrappable:false')) lines.push('⛔ [Wrappable(false)] — wrapping is blocked.');
    if (/\bfinal\b/i.test(row.signature ?? '')) {
      lines.push('⚠️  Method is final — requires [Wrappable(true)] to enable CoC.');
    }
    return lines.join('\n');
  }
  // A table's data methods are declared by a kernel type, so "not in the index"
  // is the normal answer for them rather than evidence that they do not exist.
  const inherited = hasTableDataMethods(objectType) ? lookupTableDataMethod(methodName) : undefined;
  if (inherited) return renderTableDataMethodSignature(inherited, objectName);

  return '(not found in symbol index)';
}

/** Fetch existing CoC extensions — bridge-first, index fallback. */
async function fetchCocExtensions(
  objectName: string,
  methodName: string | undefined,
  context: XppServerContext,
): Promise<string> {
  // Bridge first (DYNAMICSXREFDB — authoritative)
  if (context.bridge) {
    try {
      const result = await tryBridgeCocExtensions(context.bridge, objectName, methodName);
      if (result) {
        const text = result.content
          .filter((i: any) => i?.type === 'text')
          .map((i: any) => i.text as string)
          .join('\n');
        if (text) return text;
      }
    } catch {
      // Fall through to index
    }
  }
  // Symbol index fallback
  try {
    const db = context.symbolIndex.getReadDb();
    // One pattern, not two: `<name>%_Extension` is a strict SUBSET of
    // `<name>%Extension` (`_` is LIKE's single-character wildcard), so the second
    // only ever re-matched rows the first already had.
    const rows = db.prepare(
      `SELECT name, model FROM symbols
       WHERE type IN ('class', 'class-extension')
         AND name LIKE ?
       LIMIT 40`,
    ).all(`${objectName}%Extension`) as Array<{ name: string; model: string }>;
    // Deduplicate. Verified live: the first three extension classes were listed
    // TWICE, because a class extension is indexed under both 'class' and
    // 'class-extension' — and a duplicated list reads as two separate wrappers
    // on the same method, which is exactly the fact this section is consulted for.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const r of rows) {
      const key = `${r.name}\0${r.model ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(`  ${r.name} (${r.model})`);
      if (unique.length >= 20) break;
    }
    if (unique.length > 0) {
      return unique.join('\n') + `\n_(source: symbol index — ${bridgeFallbackReason(context)})_`;
    }
  } catch {
    // ignore
  }
  return 'None found.';
}

/**
 * WHY this list came from the index instead of DYNAMICSXREFDB.
 *
 * It used to say "bridge unavailable for exact cross-reference" unconditionally.
 * Verified live with the bridge UP and only the xref database missing, so the
 * message was false — and it points at the wrong fix: reconnecting a bridge that
 * is already connected does nothing, whereas a missing xref DB is a configuration
 * fact the caller should know rather than chase.
 */
function bridgeFallbackReason(context: XppServerContext): string {
  const bridge = context.bridge as { isReady?: boolean; xrefAvailable?: boolean } | undefined;
  if (!bridge?.isReady) return 'bridge not connected';
  if (!bridge.xrefAvailable) return 'bridge connected, but the xref database (DYNAMICSXREFDB) is not available';
  return 'bridge returned no cross-reference rows';
}

/** Determine CoC eligibility from the symbol index. */
async function fetchEligibility(
  objectName: string,
  methodName: string | undefined,
  objectType: string | undefined,
  context: XppServerContext,
): Promise<string> {
  if (!methodName) return 'No specific method targeted — check base class documentation.';
  const found = readMethodRow(context, objectName, methodName);
  if (found) {
    const { row, owner, inherited } = found;
    const tags = row.tags ?? '';
    if (tags.includes('hookable:false')) return '⛔ [Hookable(false)] — CoC is blocked on this method.';
    if (tags.includes('wrappable:false')) return '⛔ [Wrappable(false)] — wrapping is blocked on this method.';
    if (/\bfinal\b/i.test(row.signature ?? '')) {
      return '⚠️  Method is final — requires [Wrappable(true)] attribute to enable CoC.';
    }
    if (!inherited) return '✅ Method appears CoC-eligible.';
    // An inherited method is wrappable on either class, verified against xppc:
    // both targets compile. They differ only in scope, and a signature mismatch
    // is reported against the DECLARING class whichever one is named.
    return [
      `✅ Method appears CoC-eligible — inherited from \`${owner}\`.`,
      `Pick the target deliberately; both compile:`,
      `- \`[ExtensionOf(classStr(${objectName}))]\` — wraps it for \`${objectName}\` only.`,
      `- \`[ExtensionOf(classStr(${owner}))]\` — wraps it at the declaration, so it runs for **every** subclass of \`${owner}\`.`,
      `Either way the signature must match \`${owner}\`'s declaration exactly — the compiler validates against it and names \`${owner}\` in any mismatch error.`,
    ].join('\n');
  }
  // Same fallback as the signature above, and the contract it carries is the
  // point: this section is the last thing prepare says before the model writes
  // the wrapper, so the pre-image rule belongs here rather than a topic away.
  const inherited = hasTableDataMethods(objectType) ? lookupTableDataMethod(methodName) : undefined;
  if (inherited) return renderTableDataMethodEligibility(inherited, objectName);

  return '(could not determine — method not found in symbol index)';
}

/** Suggest relevant extension strategies based on object type. */
function fetchStrategy(objectType: string | undefined): string {
  const strategies: string[] = [];
  if (objectType === 'table') {
    strategies.push('• Table extension (AxTableExtension) — add fields, indexes, relations, field groups');
    strategies.push('• Table extension class [ExtensionOf(tableStr(...))] — CoC on table methods');
    strategies.push('• Event handler [DataEventHandler(tableStr(X), DataEventType::...)] — subscribe to data events');
  } else if (objectType === 'class') {
    strategies.push('• Class extension [ExtensionOf(classStr(...))] — CoC on class methods');
    strategies.push('• Event handler [SubscribesTo(...)] — subscribe to delegate events');
  } else if (objectType === 'form') {
    strategies.push('• Form extension (AxFormExtension) — add controls, data sources, menu items');
    strategies.push('• Form extension class [ExtensionOf(formStr(...))] — CoC on form methods');
    strategies.push('• Form datasource extension [ExtensionOf(formDataSourceStr(...))] — CoC on DS methods');
  } else if (objectType === 'map') {
    strategies.push('• Map extension class [ExtensionOf(mapStr(...))] — add/wrap map methods');
  } else if (objectType === 'security-duty') {
    strategies.push('• security-duty-extension (AxSecurityDutyExtension) — add privileges to this EXISTING duty without overlaying it');
    strategies.push('• New standalone security-duty — only if this duty is not a fit for the new privilege at all');
  } else if (objectType === 'security-role') {
    strategies.push('• security-role-extension (AxSecurityRoleExtension) — add duties/privileges to this EXISTING role without overlaying it');
    strategies.push('• New standalone security-role — only if this role is not a fit for the new duty at all');
  } else {
    strategies.push('• Extension class via [ExtensionOf] — check the object type for supported extension mechanisms');
  }
  strategies.push('• New standalone class — if no suitable extension point exists');
  return strategies.join('\n');
}

/**
 * Validate the proposed name for the extension the caller is about to write.
 *
 * This used to be four hand-rolled rules, and the last of them —
 * `!proposedName.includes(modelName)` against the RAW model name — is the class of
 * bug #892/#901 that was fixed in the shared rules and pinned by
 * tests/tools/namingValidatorAgreement.test.ts. Worse, when it did not fire the
 * whole verdict was "ℹ️ Confirm naming follows your convention": live, a malformed
 * `CustTable_Ext` got that and nothing else, while validate_object_naming answered
 * with a hard error and the exact expected name `CustTable.ConChainExtension`.
 *
 * The rules now come from utils/objectNamingRules.ts. Which EXTENSION shape is
 * meant is read from the name itself: `…_Extension` is a CoC class, anything else
 * is the AOT element extension of the object being changed — and when the name
 * matches neither, the element-extension rules are the ones that name the expected
 * form.
 */
async function fetchNamingValidation(
  proposedName: string,
  objectName: string,
  resolvedType: string | undefined,
  context: XppServerContext,
): Promise<string> {
  const issues: string[] = [];
  if (proposedName.length > 81) {
    issues.push(`❌ Name exceeds 81-char AOT limit (${proposedName.length} chars). Shorten it.`);
  }
  if (!/^[A-Z]/.test(proposedName)) {
    issues.push('❌ Name must start with an uppercase letter (PascalCase).');
  }
  try {
    const existing = lookupObjectNocase(proposedName, context);
    if (existing) {
      issues.push(`⚠️  Name "${existing.name}" already exists in model "${existing.model}".`);
    }
  } catch {
    // ignore
  }
  // Which extension shape the caller means, from the name they proposed.
  const elementExtension = resolvedType ? `${resolvedType}-extension` : undefined;
  const namingType = proposedName.endsWith('_Extension')
    ? 'class-extension'
    : elementExtension;

  if (namingType) {
    try {
      const shared = await checkObjectNaming(context.symbolIndex.getReadDb(), {
        proposedName,
        objectType: namingType,
        baseObjectName: objectName,
      });
      for (const e of shared.errors) issues.push(`❌ ${e}`);
      for (const w of shared.warnings) issues.push(`⚠️  ${w}`);
      // One suggestion — prepare is already at its response cap, and the first is
      // the corrected name.
      const fix = shared.suggestions[0];
      if (fix) issues.push(`→ ${fix}`);
    } catch {
      // Index unavailable — the structural checks above still stand.
    }
  }
  return issues.length > 0 ? issues.join('\n') : `✅ "${proposedName}" looks valid.`;
}

/** Fetch relevant patterns from the index. */
async function fetchPatterns(
  objectName: string,
  objectType: string | undefined,
  context: XppServerContext,
): Promise<string> {
  try {
    const db = context.symbolIndex.getReadDb();
    // INDEXED BY: with `description != ''` alone the planner scans and fetches
    // every row of the type (77 s cold on a production DB). Forcing
    // idx_type_name evaluates the LIKE against the index, so only name
    // matches ever touch the table.
    const rows = db.prepare(
      `SELECT name, description FROM symbols INDEXED BY idx_type_name
       WHERE type = ? AND name LIKE ? AND description != ''
       ORDER BY LENGTH(name)
       LIMIT 3`,
    ).all(objectType ?? 'class', `%${objectName}%`) as Array<{ name: string; description: string }>;
    if (rows.length > 0) {
      return rows.map(r => `  ${r.name}: ${r.description}`).join('\n');
    }
  } catch {
    // ignore
  }
  return '(no similar patterns found in index)';
}

/**
 * Hard character budget for the ranked-context block, dropped item by item.
 *
 * This is the lowest value-per-byte section prepare renders — its lines read
 * "keyword match, 1 intent term, member of CustTable (score 6.5)" — and it sits
 * LAST precisely so a cut lands here. Giving it its own budget means the cut is
 * made by something that knows where an item ends: whole items go, and the
 * count of what went is stated, rather than the generic capper slicing an entry
 * in half.
 *
 * Exported so prepare(create) budgets the same block the same way.
 */
export const RANKED_CONTEXT_BUDGET = 1200;

export function budgetRankedContext(lines: string[], budget = RANKED_CONTEXT_BUDGET): string[] {
  if (lines.length === 0) return lines;
  // renderRankedContext emits a heading, then TWO lines per item ("• name […]"
  // and its "↳ reasons" line), so items are dropped in pairs from the tail.
  const [heading, ...body] = lines;
  let used = heading.length + 1;
  const kept: string[] = [heading];
  let i = 0;
  while (i < body.length) {
    const isItem = body[i].trimStart().startsWith('•');
    const chunk = isItem && i + 1 < body.length && body[i + 1].trimStart().startsWith('↳')
      ? body.slice(i, i + 2)
      : body.slice(i, i + 1);
    const cost = chunk.reduce((s, l) => s + l.length + 1, 0);
    if (used + cost > budget) break;
    kept.push(...chunk);
    used += cost;
    i += chunk.length;
  }
  const droppedItems = body.slice(i).filter(l => l.trimStart().startsWith('•')).length;
  if (droppedItems > 0) {
    kept.push(`  … ${droppedItems} lower-ranked item${droppedItems === 1 ? '' : 's'} omitted (context budget).`);
  }
  return kept;
}

// Tool handler

export async function prepareChangeTool(request: any, context: XppServerContext): Promise<any> {
  const raw = request?.params?.arguments ?? request;
  const parsed = prepareChangeArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      isError: true,
      content: [{ type: 'text', text: `❌ Invalid parameters: ${parsed.error.message}` }],
    };
  }

  const { goal, objectName: rawObjectName, methodName, objectType: explicitType, proposedName } = parsed.data;

  // Resolve canonical casing + type from the index; downstream lookups use the
  // canonical name so they can stay on BINARY-collated indexes.
  const resolved = await resolveObject(rawObjectName, explicitType, methodName, context);
  const objectName = resolved?.name ?? rawObjectName;
  const resolvedType = explicitType ?? resolved?.type;

  // Run all fact-gathering queries in parallel
  const [sigText, cocText, eligText, patternText, namingText] = await Promise.all([
    methodName
      ? fetchMethodSignature(objectName, methodName, resolvedType, context)
      : Promise.resolve(null as string | null),
    fetchCocExtensions(objectName, methodName, context),
    fetchEligibility(objectName, methodName, resolvedType, context),
    fetchPatterns(objectName, resolvedType, context),
    proposedName
      ? fetchNamingValidation(proposedName, objectName, resolvedType, context)
      : Promise.resolve(null as string | null),
  ]);

  // Build provenance bundle
  const token = createProvenanceToken({
    goal,
    objectName,
    methodName,
    objectType: resolvedType,
    proposedName,
    methodSignature: sigText ?? undefined,
    cocExtensions: cocText,
    extensionEligibility: eligText,
    recommendedStrategy: fetchStrategy(resolvedType),
    namingValidation: namingText ?? undefined,
    patterns: patternText,
  });

  const strategy = fetchStrategy(resolvedType);

  // Format output.
  //
  // SECTION ORDER IS LOAD-BEARING. Measured over 1,400 real MCP calls: prepare's
  // result size was p50 4,966 / p90 5,011 chars against a 5,000-char cap, i.e.
  // essentially every response was cut, and a cut always removes the LAST
  // sections. The write contract and the grounding token used to be last, so the
  // two things the call exists to deliver were exactly the two things that went —
  // and with the token gone, `extractToken` in prepare.ts found nothing, so the
  // repeat-suppression never armed either and the next identical prepare paid in
  // full again. They now come immediately after the header; discovery sections
  // follow, and the ranked-context block (the lowest value per byte) is last with
  // a budget of its own.
  const lines: string[] = [];
  lines.push(`## prepare(mode="change"): context for \`${objectName}\`${methodName ? `::${methodName}` : ''}`);
  lines.push('');
  lines.push(`**Goal:** ${goal}`);
  if (resolvedType) lines.push(`**Object type (resolved):** ${resolvedType}`);
  // Ambiguity is stated, never silent: a name resolving to several top-level
  // types is how CustTable came back as a form (see resolveObject).
  if (resolved && resolved.alsoTypes.length > 0 && !explicitType) {
    lines.push(
      `ℹ️  \`${objectName}\` also exists as ${resolved.alsoTypes.join(', ')} — resolved as ${resolved.type}` +
      `${resolved.byMethod ? ` (it declares \`${methodName}\`)` : ''}; pass \`objectType\` to override.`,
    );
  }
  lines.push('');

  // The deliverable, first: the contract for the write this call is preparing,
  // and the token that authorizes it.
  lines.push(...renderPrepareOpSpec({
    mode: 'change',
    objectType: resolvedType,
    operation: (raw as any)?.operation,
    methodName,
  }));

  lines.push(`**Grounding token:** \`${token}\``);
  lines.push('');
  lines.push(
    process.env.GROUNDING_ENFORCE === 'true'
      ? '⚠️  **GROUNDING_ENFORCE=true** — pass `groundingToken` to `generate_object(mode="pattern")` ' +
        '(extension patterns), `d365fo_file(action="create")` and `d365fo_file(action="modify")` (extension objectTypes). ' +
        `The token is bound to \`${objectName}\` — it does not authorize writes to other objects. ` +
        'Token expires in 30 minutes.'
      : 'ℹ️  Pass `groundingToken` to `generate_object(mode="pattern")`, `d365fo_file(action="create")` or `d365fo_file(action="modify")` ' +
        'to confirm this context was used. Set `GROUNDING_ENFORCE=true` to require it.',
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  if (sigText !== null) {
    lines.push('### Method signature _(symbol index)_');
    lines.push(sigText);
    lines.push('');
  }

  lines.push('### Existing CoC extensions');
  lines.push(cocText);
  lines.push('');

  if (methodName) {
    lines.push('### CoC eligibility');
    lines.push(eligText);
    lines.push('');
  }

  lines.push('### Recommended extension strategies');
  lines.push(strategy);
  lines.push('');

  lines.push('### Related patterns _(symbol index)_');
  lines.push(patternText);
  lines.push('');

  if (namingText !== null) {
    lines.push(`### Naming validation for \`${proposedName}\``);
    lines.push(namingText);
    lines.push('');
  }

  // Ranked neighborhood, anchored on the target object; additive, best-effort,
  // and deliberately LAST — see the section-order note above.
  try {
    const ranked = rankContext(context, {
      intent: `${goal} ${objectName} ${methodName ?? ''}`,
      activeObject: { name: objectName, type: resolvedType },
    });
    lines.push(...budgetRankedContext(renderRankedContext(ranked)));
    lines.push('');
  } catch {
    // omit on failure
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.
