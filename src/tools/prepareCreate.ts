/**
 * prepare_create — single-round context aggregator for NEW D365FO objects.
 *
 * Mirror of prepare_change for object creation: one call replaces the
 * search → validate_object_naming → suggest_edt → labels → patterns
 * sequence (4–6 agentic rounds) with a single parallel query bundle:
 *   - name collision check (exact + prefix variants) against the symbol index
 *   - naming validation incl. the prefix the write tool will actually apply
 *   - similar existing objects to copy patterns from
 *   - EDT suggestions for planned table fields (edt_metadata + symbols)
 *   - reusable existing labels matching the object name
 *   - mined property defaults from property_stats (what standard models set)
 *   - grounding token (object-bound, 30-min TTL)
 */

import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { createProvenanceToken } from '../utils/provenanceStore.js';
import { getConfigManager } from '../utils/configManager.js';
import { resolveObjectPrefix, applyObjectPrefix } from '../utils/modelClassifier.js';
import { rankContext, renderRankedContext } from '../workspace/contextRanker.js';

// ── Schema ────────────────────────────────────────────────────────────────────

export const prepareCreateArgsSchema = z.object({
  goal: z.string().describe(
    'One-sentence description of what the new object is for. ' +
    'Example: "Parameter table for the Contoso import feature."',
  ),
  objectName: z.string().describe(
    'Proposed BASE name of the new object WITHOUT model prefix ' +
    '(the same value you would pass to d365fo_file(action="create")). Example: "ImportParameters".',
  ),
  objectType: z.enum([
    'class', 'table', 'form', 'enum', 'edt', 'query', 'view',
    'data-entity', 'report', 'menu-item-display', 'menu-item-action',
    'menu-item-output', 'security-privilege', 'security-duty', 'security-role',
  ]).describe('Type of the new D365FO object.'),
  fieldsHint: z.array(z.string()).optional().describe(
    'For tables/views: planned field names (e.g. ["CustAccount", "ImportDate", "Qty"]). ' +
    'Each gets EDT suggestions from the index.',
  ),
});

// ── Lookups (all index-only, run in parallel) ────────────────────────────────

/** Exact + prefixed collision check. */
function checkCollisions(
  finalName: string,
  baseName: string,
  context: XppServerContext,
): string {
  try {
    const db = context.symbolIndex.getReadDb();
    const rows = db.prepare(
      `SELECT DISTINCT name, type, model FROM symbols
       WHERE name IN (?, ?) COLLATE NOCASE
          AND parent_name IS NULL
       LIMIT 10`,
    ).all(finalName, baseName) as Array<{ name: string; type: string; model: string }>;
    if (rows.length > 0) {
      return rows
        .map(r => `⚠️  "${r.name}" already exists as ${r.type} in model "${r.model}" — pick a different name or extend it instead.`)
        .join('\n');
    }
    return `✅ No collision — neither "${finalName}" nor "${baseName}" exists in the index.`;
  } catch {
    return '(collision check unavailable — index not ready)';
  }
}

/** Naming validation incl. the prefix create_d365fo_file will apply. */
function validateNaming(baseName: string, finalName: string, modelName: string | undefined): string {
  const issues: string[] = [];
  if (finalName.length > 81) {
    issues.push(`❌ Final name "${finalName}" exceeds the 81-char AOT limit (${finalName.length}).`);
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(baseName)) {
    issues.push('❌ Name may contain only letters, digits and underscores, and must not start with a digit.');
  }
  if (!/^[A-Z]/.test(baseName)) {
    issues.push('❌ Name must start with an uppercase letter (PascalCase).');
  }
  const lines = [
    `Base name   : ${baseName}`,
    `Final name  : ${finalName}${finalName !== baseName ? ' _(prefix auto-applied by d365fo_file(action="create"))_' : ''}`,
    `Model       : ${modelName ?? '(not configured — set modelName or .mcp.json)'}`,
  ];
  if (issues.length > 0) lines.push(...issues);
  else lines.push('✅ Naming looks valid.');
  return lines.join('\n');
}

/** Similar existing objects worth copying patterns from. */
function findSimilarObjects(
  baseName: string,
  objectType: string,
  context: XppServerContext,
): string {
  try {
    const db = context.symbolIndex.getReadDb();
    // Split CamelCase into tokens and search for the most specific ones
    const tokens = baseName.split(/(?=[A-Z])/).filter(t => t.length >= 4);
    const needle = tokens.length > 0 ? tokens[tokens.length - 1] : baseName;
    const rows = db.prepare(
      `SELECT name, model FROM symbols
       WHERE type = ? AND name LIKE ? AND parent_name IS NULL
       ORDER BY LENGTH(name) LIMIT 5`,
    ).all(objectType, `%${needle}%`) as Array<{ name: string; model: string }>;
    if (rows.length > 0) {
      return rows.map(r => `  ${r.name} (${r.model})`).join('\n') +
        `\n_Use get_${objectType === 'table' ? 'table' : 'class'}_info or copyFrom in generate_object(mode="scaffold") to reuse their structure._`;
    }
  } catch {
    // ignore
  }
  return '(no similar objects found — greenfield)';
}

/** EDT suggestions for planned table fields. */
function suggestEdtsForFields(
  fieldsHint: string[],
  context: XppServerContext,
): string {
  const lines: string[] = [];
  try {
    const db = context.symbolIndex.getReadDb();
    const stmt = db.prepare(
      `SELECT name, signature FROM symbols
       WHERE type = 'edt' AND name LIKE ? ORDER BY LENGTH(name) LIMIT 3`,
    );
    for (const field of fieldsHint.slice(0, 10)) {
      const tokens = field.split(/(?=[A-Z])/).filter(t => t.length >= 3);
      const needle = tokens.length > 0 ? tokens[tokens.length - 1] : field;
      const rows = stmt.all(`%${needle}%`) as Array<{ name: string; signature: string | null }>;
      lines.push(
        rows.length > 0
          ? `  ${field} → ${rows.map(r => r.name + (r.signature ? ` (extends ${r.signature})` : '')).join(', ')}`
          : `  ${field} → (no EDT match — use suggest_edt("${field}") or base it on a primitive + label)`,
      );
    }
  } catch {
    return '(EDT lookup unavailable)';
  }
  return lines.join('\n');
}

/** Existing labels that could be reused for the new object. */
function findReusableLabels(baseName: string, context: XppServerContext): string {
  try {
    const words = baseName.replace(/([A-Z])/g, ' $1').trim();
    const rows = context.symbolIndex.searchLabels(words, { language: 'en-us', limit: 5 });
    if (rows.length > 0) {
      return rows
        .map(r => `  @${r.labelFileId}:${r.labelId} = "${r.text}" (${r.model})`)
        .join('\n') + '\n_Reuse instead of creating duplicates (rule: labels before labels)._';
    }
  } catch {
    // ignore
  }
  return '(no matching labels — create new ones via labels)';
}

/** Mined property defaults for the object type (tables only for now). */
function minedPropertyDefaults(objectType: string, context: XppServerContext): string {
  if (objectType !== 'table') return '';
  try {
    const idx = context.symbolIndex as unknown as {
      getPropertyPresenceRatio(n: string, p: string): { present: number; total: number; ratio: number };
      getPropertyValueDistribution(n: string, p: string, l?: number): Array<{ value: string; count: number }>;
    };
    if (typeof idx.getPropertyPresenceRatio !== 'function') return '';
    const lines: string[] = [];
    for (const prop of ['Label', 'TableGroup', 'PrimaryIndex', 'ClusteredIndex', 'AlternateKeyIndex']) {
      const r = idx.getPropertyPresenceRatio('AxTable', prop);
      if (r.total === 0) continue;
      lines.push(`  ${prop}: set by ${Math.round(r.ratio * 100)}% of standard tables${r.ratio >= 0.8 ? ' → REQUIRED' : ''}`);
    }
    const dist = idx.getPropertyValueDistribution('AxTable', 'TableGroup', 4);
    if (dist.length > 0) {
      const total = dist.reduce((s, d) => s + d.count, 0);
      lines.push(`  TableGroup values: ${dist.map(d => `${d.value} (${Math.round((d.count / total) * 100)}%)`).join(', ')}`);
    }
    if (lines.length > 0) {
      return lines.join('\n');
    }
  } catch {
    // ignore
  }
  return '(no mined statistics — run build-database to mine standard models)';
}

// ── Tool handler ──────────────────────────────────────────────────────────────

export async function prepareCreateTool(request: any, context: XppServerContext): Promise<any> {
  const raw = request?.params?.arguments ?? request;
  const parsed = prepareCreateArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      isError: true,
      content: [{ type: 'text', text: `❌ Invalid parameters: ${parsed.error.message}` }],
    };
  }

  const { goal, objectName, objectType, fieldsHint } = parsed.data;
  const modelName = getConfigManager().getModelName() ?? undefined;
  const prefix = resolveObjectPrefix(modelName ?? '');
  const finalName = prefix ? applyObjectPrefix(objectName, prefix) : objectName;

  // All lookups are synchronous index queries — run them in one tick.
  const [collisions, naming, similar, edts, labels, propertyDefaults] = [
    checkCollisions(finalName, objectName, context),
    validateNaming(objectName, finalName, modelName),
    findSimilarObjects(objectName, objectType, context),
    fieldsHint && fieldsHint.length > 0 ? suggestEdtsForFields(fieldsHint, context) : '',
    findReusableLabels(objectName, context),
    minedPropertyDefaults(objectType, context),
  ];

  const token = createProvenanceToken({
    goal,
    objectName,
    objectType,
    proposedName: finalName,
  });

  const lines: string[] = [
    `# prepare(mode="create") — ${objectType} \`${finalName}\``,
    '',
    `**Goal:** ${goal}`,
    '',
    '### Collision check _(symbol index)_',
    collisions,
    '',
    '### Naming',
    naming,
    '',
    '### Similar existing objects _(copy patterns from these)_',
    similar,
    '',
  ];
  if (edts) {
    lines.push('### EDT suggestions for planned fields _(edt index)_', edts, '');
  }
  lines.push('### Reusable labels _(labels index)_', labels, '');
  if (propertyDefaults) {
    lines.push('### Property defaults _(mined from standard models)_', propertyDefaults, '');
  }

  // Ranked neighborhood: surface existing code relevant to the goal so the new
  // object reuses real types/patterns instead of invented ones. Best-effort.
  try {
    const ranked = rankContext(context, {
      intent: `${goal} ${objectName} ${(fieldsHint ?? []).join(' ')}`,
      activeObject: { name: objectName, type: objectType },
    });
    lines.push(...renderRankedContext(ranked), '');
  } catch {
    // Additive — omit on failure.
  }

  lines.push('---');
  lines.push(`**Grounding token:** \`${token}\``);
  lines.push('');
  lines.push(
    'Next: generate the object, run `validate_code(mode="references")` + `validate_code(mode="syntax")` on the result, ' +
    `then call \`d365fo_file(action="create", objectType="${objectType}", objectName="${objectName}", groundingToken=...)\`. ` +
    'The token is bound to this object and expires in 30 minutes.',
  );

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.
