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
import type { XppServerContext } from '../../types/context.js';
import { createProvenanceToken } from '../../utils/provenanceStore.js';
import { getConfigManager } from '../../utils/configManager.js';
import { checkObjectNaming } from '../../utils/objectNamingRules.js';
import { normalizeObjectName } from '../../utils/objectNaming.js';
import { renderPrepareOpSpec } from '../specs/opSpecs.js';
import { rankContext, renderRankedContext } from '../../workspace/contextRanker.js';
import { budgetRankedContext } from './prepareChange.js';
import { lookupSymbolsNocase, type SymbolHit } from '../../utils/symbolLookup.js';
import { formatLabelReference } from '../../utils/labelReference.js';
import { RESERVED_SYSTEM_FIELD_NAMES } from '../smart/generateSmartTable.js';

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
    'menu-item-output', 'menu', 'security-privilege', 'security-duty', 'security-role',
    'business-event', 'tile', 'kpi', 'map', 'service', 'service-group',
    'macro', 'configuration-key', 'security-policy', 'aggregate-measurement', 'license-code',
    // Extension artefacts. prepare(mode="change") is still the richer route for
    // extending an object — it reads the base and plans the change — but it is
    // not the ONLY thing an agent does with an extension, and the artefact is
    // created by d365fo_file(action="create"), which has published these types
    // all along. Omitting them here forced a caller who wanted an enum extension
    // to pick "enum", whose name rules then refused the only name an enum
    // extension can have (#983): two tools disagreeing about what exists.
    'table-extension', 'class-extension', 'form-extension', 'enum-extension', 'edt-extension',
  ]).describe(
    'Type of the new D365FO object. For a NEW artefact, including an extension of an ' +
    'existing object (Base.Suffix). To PLAN a change to an existing object — read its ' +
    'members, pick CoC vs event handler — prepare(mode="change") is richer: it auto-detects ' +
    'the base object\'s type and bundles its methods and existing extensions.'
  ),
  fieldsHint: z.array(z.string()).optional().describe(
    'For tables/views: planned field names (e.g. ["CustAccount", "ImportDate", "Qty"]). ' +
    'Each gets EDT suggestions from the index.',
  ),
});

// Lookups below are all index-only, run in parallel.

/** Exact + prefixed collision check. */
function checkCollisions(
  finalName: string,
  baseName: string,
  context: XppServerContext,
): string {
  try {
    const db = context.symbolIndex.getReadDb();
    // `name IN (?, ?) COLLATE NOCASE` silently compared case-SENSITIVELY (the
    // COLLATE binds to the IN expression, not the column), so differently-cased
    // collisions were missed. The nocase helper also stays on the indexes.
    const rows: SymbolHit[] = [];
    const seen = new Set<string>();
    for (const n of new Set([finalName, baseName])) {
      for (const r of lookupSymbolsNocase(db, n, { limit: 5 })) {
        const key = `${r.name} ${r.type} ${r.model ?? ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          rows.push(r);
        }
      }
    }
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

/**
 * Naming validation incl. the prefix create_d365fo_file will apply.
 *
 * The CONVENTION rules come from utils/objectNamingRules.ts — the same ones
 * validate_object_naming runs. They used to be reimplemented here, weaker: this
 * function answered "✅ Naming looks valid" for a name that checker warns is
 * missing the model prefix, because it had no prefix rule, no underscore rule and
 * no type-specific conventions at all.
 *
 * The checks BELOW stay local on purpose. They guard the name the prefix step
 * COMPOSED (finalName), where an unrepresentable character can enter a name the
 * caller never typed (#892/#901); the shared rules see the name the caller wrote.
 */
async function validateNaming(
  baseName: string,
  finalName: string,
  objectType: string,
  modelName: string | undefined,
  context: XppServerContext,
  /**
   * Whether the object an extension EXTENDS exists, as answered by the metadata
   * provider. `undefined` leaves the shared rules to probe the symbol index, which
   * is the only option without a bridge — and is wrong on an index scoped to
   * custom models, where a Microsoft base reads as "not found — ensure it's
   * indexed" and no amount of re-indexing will change that.
   */
  baseObjectExists?: boolean,
): Promise<string> {
  const issues: string[] = [];
  if (finalName.length > 81) {
    issues.push(`❌ Final name "${finalName}" exceeds the 81-char AOT limit (${finalName.length}).`);
  }
  // An extension ELEMENT is named `Base.Suffix`, and the dot is mandatory, not a
  // typo. This check used to see only the undotted form, so every extension name
  // was refused with "Name may contain only letters, digits and underscores" on
  // the way to an operation d365fo_file supports perfectly well (#983). Only the
  // SUFFIX is the caller's to choose — the base names an object that already
  // exists — so both halves must be legal identifiers and nothing more is asked.
  const dotCount = (baseName.match(/\./g) ?? []).length;
  const identifier = /^[A-Za-z][A-Za-z0-9_]*$/;
  if (dotCount > 1 || !baseName.split('.').every((part) => identifier.test(part))) {
    issues.push(
      dotCount > 0
        ? '❌ An extension name is "Base.Suffix": one dot, and each half letters, digits and ' +
          'underscores only, not starting with a digit.'
        : '❌ Name may contain only letters, digits and underscores, and must not start with a digit.',
    );
  }
  // An extension name is derived from a base name the caller did not choose —
  // `{Base}{Prefix}_Extension` for a class, `Base.Suffix` for an element — and
  // the product ships camelCase classes, so the derived name legitimately starts
  // lowercase. Requiring PascalCase for those contradicts the extension rule
  // checkObjectNaming enforces below, leaving no name that satisfies both.
  const isExtensionForm = /_Extension$/.test(baseName) || baseName.includes('.');
  if (!/^[A-Z]/.test(baseName) && !isExtensionForm) {
    issues.push('❌ Name must start with an uppercase letter (PascalCase).');
  }
  // The charset check above sees the name the CALLER typed. The name that actually
  // gets written is finalName, which the prefix/model-name step composed — and that
  // step is where an unrepresentable character can enter a name the caller never
  // typed (#892). Extension forms legitimately carry one dot.
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)?$/.test(finalName)) {
    issues.push(
      `❌ Final name "${finalName}" is not a valid AOT name — letters, digits and underscores only ` +
        '(plus one dot for extension elements). Check the model name and prefix configuration.'
    );
  }
  // Convention rules, from the one place that has them. A failure here must not
  // fail the prepare: the checks above still stand without an index.
  let shared: Awaited<ReturnType<typeof checkObjectNaming>> | undefined;
  try {
    shared = await checkObjectNaming(context.symbolIndex.getReadDb(), {
      proposedName: baseName,
      objectType,
      modelName,
      baseObjectExists,
    });
  } catch {
    // index unavailable
  }
  for (const e of shared?.errors ?? []) issues.push(`❌ ${e}`);
  for (const w of shared?.warnings ?? []) issues.push(`⚠️  ${w}`);

  const lines = [
    `Base name   : ${baseName}`,
    `Final name  : ${finalName}${finalName !== baseName ? ' _(prefix auto-applied by d365fo_file(action="create"))_' : ''}`,
    `Model       : ${modelName ?? '(not configured — set modelName or .mcp.json)'}`,
  ];
  if (issues.length > 0) {
    lines.push(...issues);
    // One suggestion, not the validator's full list: prepare is already at its
    // response cap and the first is the corrected name.
    const fix = shared?.suggestions?.[0];
    if (fix) lines.push(`→ ${fix}`);
  } else {
    lines.push('✅ Naming looks valid.');
  }
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
    // INDEXED BY: without it the planner picks idx_symbols_parent_name for
    // `parent_name IS NULL` and fetches every top-level row (4.6 min cold on a
    // production DB, blocking the event loop until the MCP client kills the
    // server). idx_type_name evaluates the LIKE against the index, so only
    // name matches ever touch the table (~10 ms).
    const rows = db.prepare(
      `SELECT name, model FROM symbols INDEXED BY idx_type_name
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

  // Custom fields using reserved system field names fail compilation
  const reservedHits = fieldsHint.filter(f => RESERVED_SYSTEM_FIELD_NAMES.has(f.toLowerCase()));
  if (reservedHits.length > 0) {
    lines.push(
      `⛔ **Reserved system field names — do NOT use as custom fields:**`,
      ...reservedHits.map(f =>
        `  • \`${f}\` — reserved by the platform (auto-tracked). Rename to a non-reserved name (e.g. "NoteDateTime" instead of "CreatedDateTime").`
      ),
      `  The platform auto-provides: CreatedDateTime, ModifiedDateTime, CreatedBy, ModifiedBy, RecId, RecVersion, DataAreaId, Partition.`,
      ``,
    );
  }

  try {
    const db = context.symbolIndex.getReadDb();
    // INDEXED BY keeps the LIKE on the index (runs once per hinted field).
    const stmt = db.prepare(
      `SELECT name, signature FROM symbols INDEXED BY idx_type_name
       WHERE type = 'edt' AND name LIKE ? ORDER BY LENGTH(name) LIMIT 3`,
    );
    for (const field of fieldsHint.slice(0, 10)) {
      if (RESERVED_SYSTEM_FIELD_NAMES.has(field.toLowerCase())) continue;
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
    const rows = context.symbolIndex.searchLabels(words, { language: 'en-US', limit: 5 });
    if (rows.length > 0) {
      return rows
        // Not `@${labelFileId}:${labelId}` (#888): a legacy row's id already
        // carries its file id, so hand-building the reference re-created the
        // doubled `@GLS:@GLS4170035` that #33/#41 removed everywhere else —
        // xppbp answers BPErrorLabelIsText — and prepare offers these for reuse
        // immediately before a write.
        .map(r => `  ${formatLabelReference(r.labelFileId, r.labelId)} = "${r.text}" (${r.model})`)
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

/** Extension objectType → the type of the object it extends. */
const EXTENSION_BASE_TYPE: Record<string, string> = {
  'table-extension': 'table',
  'class-extension': 'class',
  'form-extension': 'form',
  'enum-extension': 'enum',
  'edt-extension': 'edt',
};

/**
 * What the caller needs to know about the object an extension EXTENDS.
 *
 * Publishing the extension objectTypes (#983) made the write reachable; it did
 * not make it grounded. Everything that decides whether an enum extension can
 * work at all lives on the BASE: it has to exist, it has to be extensible (a
 * sealed enum cannot be extended at all), and a member name already on it is a
 * build error, not a merge. `prepare(mode="change")` is built around reading the
 * base object; `prepare(mode="create")` was not, so the one call an agent makes
 * before writing an extension said nothing about the thing being extended.
 *
 * Asked of the BRIDGE first, and that is the point. The existence check in
 * `checkObjectNaming` reads the symbol index, while `search`, `get_object_info`
 * and the write path all prefer the metadata provider. On an instance indexed
 * with `extractMode: "custom"` the index deliberately holds only custom models,
 * so the index answer for a Microsoft base enum is "not found — ensure it's
 * indexed": false, and advice that re-indexing can never satisfy.
 */
async function describeExtensionBase(
  baseName: string,
  objectType: string,
  context: XppServerContext,
): Promise<{ exists: boolean | undefined; text: string }> {
  const baseType = EXTENSION_BASE_TYPE[objectType];
  if (!baseType || !baseName) return { exists: undefined, text: '' };

  const bridge = context.bridge;
  const bridgeUsable = Boolean(bridge?.isReady && bridge?.metadataAvailable);

  if (bridgeUsable && baseType === 'enum') {
    try {
      const info = await bridge!.readEnum(baseName);
      if (info) {
        const taken = info.values.map(v => v.name);
        const lines = [
          `\`${info.name}\`${info.model ? ` (${info.model})` : ''} — **Extensible: ${info.isExtensible ? 'Yes' : 'NO'}**`,
        ];
        if (!info.isExtensible) {
          lines.push(
            '🔴 A non-extensible enum CANNOT be extended — the write will not build. ' +
            'Add the member to the enum itself, or ask the owner to mark it extensible.',
          );
        }
        if (taken.length > 0) {
          lines.push(
            `Member names already taken (${taken.length}): ${taken.join(', ')} — ` +
            'reusing one is a build error, not a merge.',
          );
        }
        return { exists: true, text: lines.join(String.fromCharCode(10)) };
      }
      return {
        exists: false,
        text: `🔴 \`${baseName}\` does not exist as an enum (checked via the metadata provider) — ` +
          'an extension of a missing object cannot build.',
      };
    } catch {
      /* fall through to the generic probe */
    }
  }

  if (bridgeUsable) {
    try {
      const resolved = await bridge!.resolveObjectInfo(baseType, baseName);
      if (resolved) {
        return resolved.exists
          ? { exists: true, text: `\`${baseName}\`${resolved.model ? ` (${resolved.model})` : ''} — exists.` }
          : {
              exists: false,
              text: `🔴 \`${baseName}\` does not exist as a ${baseType} (checked via the metadata provider).`,
            };
      }
    } catch {
      /* fall through */
    }
  }

  // No bridge: the index is all there is, and it may be scoped to custom models.
  try {
    const hit = lookupSymbolsNocase(context.symbolIndex.getReadDb(), baseName, { types: [baseType], limit: 1 })[0];
    if (hit) return { exists: true, text: `\`${baseName}\` (${hit.model ?? '?'}) — found in the symbol index.` };
  } catch {
    /* index unavailable */
  }
  return {
    exists: undefined,
    text: `\`${baseName}\` — could not be verified (the C# bridge is not available and the symbol ` +
      'index has no matching ' + baseType + '; an index built with extractMode "custom" holds only custom models).',
  };
}

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
  // Predict the name through the SAME helper d365fo_file(action="create") writes with.
  // Re-deriving it here from applyObjectPrefix(name, prefix) — without modelName — dropped
  // the separator for models whose inferred prefix carries one: prepare promised
  // "ConSKQualityTier" and create wrote "ConSK_QualityTier". The caller then took
  // prepare at its word, hand-fed a leading "_" to compensate, and got "ConSK__QualityTier"
  // on disk, which cost a create + undo + re-create. It also made the collision check probe
  // a name that never gets written, so a real collision read as "No collision".
  const finalName = normalizeObjectName(objectName, objectType, modelName);

  // For an extension type, the BASE object decides whether the write can work at
  // all — so it is resolved FIRST and its verdict feeds the naming check, which
  // would otherwise answer from the symbol index alone (#983 follow-up).
  const baseObjectName = objectName.includes('.') ? objectName.slice(0, objectName.indexOf('.')) : '';
  const base = await describeExtensionBase(baseObjectName, objectType, context);

  // Naming is the one asynchronous check (the shared rules await model detection),
  // so it is started first and collected below — the rest still run in one tick.
  const namingPromise = validateNaming(objectName, finalName, objectType, modelName, context, base.exists);

  // All lookups are synchronous index queries — run them in one tick.
  const [collisions, naming, similar, edts, labels, propertyDefaults] = [
    checkCollisions(finalName, objectName, context),
    await namingPromise,
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

  // SECTION ORDER IS LOAD-BEARING — same measurement as prepare(change): with a
  // p90 response of 5,011 chars against a 5,000-char cap, whatever sits last is
  // what gets cut. The write contract and the grounding token are the deliverable,
  // so they lead; discovery follows; the ranked-context block is last and budgeted.
  const lines: string[] = [
    `# prepare(mode="create") — ${objectType} \`${finalName}\``,
    '',
    `**Goal:** ${goal}`,
    '',
  ];

  // The write contract for this objectType, so the flow does not spend a round
  // trip on get_knowledge(kind="op-spec") right after this call.
  lines.push(...renderPrepareOpSpec({ mode: 'create', objectType }));

  lines.push(`**Grounding token:** \`${token}\``);
  lines.push('');
  // Was: "generate the object, run validate_code(mode='references') +
  // validate_code(mode='syntax') on the result, then d365fo_file(action='create')"
  // — three round trips where one does. The write path already runs the
  // syntax/BP lint inline (src/tools/write/inlineXppValidation.ts) and resolves
  // references inline when GROUNDING_ENFORCE=true, so both validate_code calls
  // re-ran checks the write was going to run anyway, and each re-bills the whole
  // cached context.
  lines.push(
    `Next: call \`d365fo_file(action="create", objectType="${objectType}", objectName="${objectName}", groundingToken=...)\` ` +
    (objectName.includes('.')
      ? '— the name is written as given; only the suffix after the dot is yours to choose. '
      : '— pass the BASE name, the prefix is applied for you. ') +
    'Syntax/BP linting and (under GROUNDING_ENFORCE=true) ' +
    'reference resolution run INSIDE that call, so no separate validate_code round trip is needed; ' +
    'use `validate_code(mode="both")` only as an optional pre-check on hand-written X++. ' +
    'The token is bound to this object and expires in 30 minutes.',
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('### Collision check _(symbol index)_', collisions, '');
  lines.push('### Naming', naming, '');
  if (base.text) {
    lines.push('### Base object _(the thing this extends)_', base.text, '');
  }
  lines.push('### Similar existing objects _(copy patterns from these)_', similar, '');
  if (edts) {
    lines.push('### EDT suggestions for planned fields _(edt index)_', edts, '');
  }
  lines.push('### Reusable labels _(labels index)_', labels, '');
  if (propertyDefaults) {
    lines.push('### Property defaults _(mined from standard models)_', propertyDefaults, '');
  }

  // Surface existing code relevant to the goal; best-effort, omit on failure,
  // and deliberately last — see the section-order note above.
  try {
    const ranked = rankContext(context, {
      intent: `${goal} ${objectName} ${(fieldsHint ?? []).join(' ')}`,
      activeObject: { name: objectName, type: objectType },
    });
    lines.push(...budgetRankedContext(renderRankedContext(ranked)), '');
  } catch {
    // Additive — omit on failure.
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
