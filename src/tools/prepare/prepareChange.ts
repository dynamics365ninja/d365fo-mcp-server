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
import { getConfigManager } from '../../utils/configManager.js';
import { lookupSymbolNocase } from '../../utils/symbolLookup.js';
import { findDeclaringAncestor } from '../../utils/inheritanceChain.js';
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

/** Resolve an object's canonical name + type from the symbol index. */
async function resolveObject(
  objectName: string,
  context: XppServerContext,
): Promise<{ name: string; type: string } | undefined> {
  try {
    return lookupObjectNocase(objectName, context);
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
    const rows = db.prepare(
      `SELECT name, model FROM symbols
       WHERE type IN ('class', 'class-extension')
         AND (name LIKE ? OR name LIKE ?)
       LIMIT 20`,
    ).all(`${objectName}%Extension`, `${objectName}%_Extension`) as Array<{ name: string; model: string }>;
    if (rows.length > 0) {
      return rows.map(r => `  ${r.name} (${r.model})`).join('\n') +
        '\n_(source: symbol index — bridge unavailable for exact cross-reference)_';
    }
  } catch {
    // ignore
  }
  return 'None found.';
}

/** Determine CoC eligibility from the symbol index. */
async function fetchEligibility(
  objectName: string,
  methodName: string | undefined,
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

/** Validate proposed object name. */
async function fetchNamingValidation(
  proposedName: string,
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
  const modelName = getConfigManager().getModelName();
  if (modelName && !proposedName.includes(modelName) && !proposedName.endsWith('_Extension')) {
    issues.push(`ℹ️  Confirm naming follows your convention (active model: ${modelName}).`);
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
  const resolved = await resolveObject(rawObjectName, context);
  const objectName = resolved?.name ?? rawObjectName;
  const resolvedType = explicitType ?? resolved?.type;

  // Run all fact-gathering queries in parallel
  const [sigText, cocText, eligText, patternText, namingText] = await Promise.all([
    methodName
      ? fetchMethodSignature(objectName, methodName, context)
      : Promise.resolve(null as string | null),
    fetchCocExtensions(objectName, methodName, context),
    fetchEligibility(objectName, methodName, context),
    fetchPatterns(objectName, resolvedType, context),
    proposedName
      ? fetchNamingValidation(proposedName, context)
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

  // Format output
  const lines: string[] = [];
  lines.push(`## prepare(mode="change"): context for \`${objectName}\`${methodName ? `::${methodName}` : ''}`);
  lines.push('');
  lines.push(`**Goal:** ${goal}`);
  if (resolvedType) lines.push(`**Object type (resolved):** ${resolvedType}`);
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

  // Ranked neighborhood, anchored on the target object; additive, best-effort.
  try {
    const ranked = rankContext(context, {
      intent: `${goal} ${objectName} ${methodName ?? ''}`,
      activeObject: { name: objectName, type: resolvedType },
    });
    lines.push(...renderRankedContext(ranked));
    lines.push('');
  } catch {
    // omit on failure
  }

  if (namingText !== null) {
    lines.push(`### Naming validation for \`${proposedName}\``);
    lines.push(namingText);
    lines.push('');
  }

  // Same reasoning as prepare(create): hand over the write contract here rather
  // than making the agent fetch it in a separate call.
  lines.push(...renderPrepareOpSpec({
    mode: 'change',
    objectType: resolvedType,
    operation: (raw as any)?.operation,
    methodName,
  }));

  lines.push('---');
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

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.
