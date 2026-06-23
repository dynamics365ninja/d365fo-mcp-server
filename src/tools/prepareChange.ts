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
import type { XppServerContext } from '../types/context.js';
import { createProvenanceToken } from '../utils/provenanceStore.js';
import { tryBridgeCocExtensions } from '../bridge/bridgeAdapter.js';
import { getConfigManager } from '../utils/configManager.js';
import { rankContext, renderRankedContext } from '../workspace/contextRanker.js';

// ── Schema ────────────────────────────────────────────────────────────────────

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
    'data-entity', 'map', 'report',
  ]).optional().describe(
    'D365FO object type. Auto-detected from the symbol index when omitted.',
  ),
  proposedName: z.string().optional().describe(
    'Proposed name for the new extension class/object. ' +
    'When provided, naming validation runs and the result is included in the bundle.',
  ),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve object type from the symbol index. */
async function resolveObjectType(
  objectName: string,
  context: XppServerContext,
): Promise<string | undefined> {
  try {
    const db = context.symbolIndex.getReadDb();
    const row = db
      .prepare('SELECT type FROM symbols WHERE name = ? COLLATE NOCASE LIMIT 1')
      .get(objectName) as { type: string } | undefined;
    return row?.type;
  } catch {
    return undefined;
  }
}

/** Look up method signature directly from the symbol index. */
async function fetchMethodSignature(
  objectName: string,
  methodName: string,
  context: XppServerContext,
): Promise<string> {
  try {
    const db = context.symbolIndex.getReadDb();
    const row = db.prepare(
      `SELECT signature, tags FROM symbols
       WHERE parentName = ? AND name = ? AND type = 'method'
       COLLATE NOCASE LIMIT 1`,
    ).get(objectName, methodName) as { signature: string; tags: string } | undefined;
    if (row) {
      const lines = [`Signature : ${row.signature ?? '(unavailable)'}`];
      const tags = row.tags ?? '';
      if (tags.includes('hookable:false')) lines.push('⛔ [Hookable(false)] — CoC is blocked.');
      if (tags.includes('wrappable:false')) lines.push('⛔ [Wrappable(false)] — wrapping is blocked.');
      if (/\bfinal\b/i.test(row.signature ?? '')) {
        lines.push('⚠️  Method is final — requires [Wrappable(true)] to enable CoC.');
      }
      return lines.join('\n');
    }
  } catch {
    // ignore DB errors
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
  try {
    const db = context.symbolIndex.getReadDb();
    const row = db.prepare(
      `SELECT signature, tags FROM symbols
       WHERE parentName = ? AND name = ? AND type = 'method'
       COLLATE NOCASE LIMIT 1`,
    ).get(objectName, methodName) as { signature: string; tags: string } | undefined;
    if (row) {
      const tags = row.tags ?? '';
      if (tags.includes('hookable:false')) return '⛔ [Hookable(false)] — CoC is blocked on this method.';
      if (tags.includes('wrappable:false')) return '⛔ [Wrappable(false)] — wrapping is blocked on this method.';
      if (/\bfinal\b/i.test(row.signature ?? '')) {
        return '⚠️  Method is final — requires [Wrappable(true)] attribute to enable CoC.';
      }
      return '✅ Method appears CoC-eligible.';
    }
  } catch {
    // ignore
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
    const db = context.symbolIndex.getReadDb();
    const existing = db.prepare(
      `SELECT name, model FROM symbols WHERE name = ? COLLATE NOCASE LIMIT 1`,
    ).get(proposedName) as { name: string; model: string } | undefined;
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
    const rows = db.prepare(
      `SELECT name, description FROM symbols
       WHERE type = ? AND description != ''
       ORDER BY CASE WHEN name LIKE ? THEN 0 ELSE 1 END
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

// ── Tool handler ──────────────────────────────────────────────────────────────

export async function prepareChangeTool(request: any, context: XppServerContext): Promise<any> {
  const raw = request?.params?.arguments ?? request;
  const parsed = prepareChangeArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      isError: true,
      content: [{ type: 'text', text: `❌ Invalid parameters: ${parsed.error.message}` }],
    };
  }

  const { goal, objectName, methodName, objectType: explicitType, proposedName } = parsed.data;

  // Resolve object type when not provided
  const resolvedType = explicitType ?? await resolveObjectType(objectName, context);

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

  // Ranked neighborhood: goal-driven, anchored on the target object. Best-effort.
  try {
    const ranked = rankContext(context, {
      intent: `${goal} ${objectName} ${methodName ?? ''}`,
      activeObject: { name: objectName, type: resolvedType },
    });
    lines.push(...renderRankedContext(ranked));
    lines.push('');
  } catch {
    // Ranked context is additive — omit on failure.
  }

  if (namingText !== null) {
    lines.push(`### Naming validation for \`${proposedName}\``);
    lines.push(namingText);
    lines.push('');
  }

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

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.
