/**
 * Get Form Patterns Tool
 * Analyzes common datasource configurations, control hierarchies, and form patterns
 * Used for smart form generation
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { resolvePattern, type FormPatternSpec } from '../knowledge/formPatterns/index.js';
import { hasMinedPatternData } from '../knowledge/formPatterns/crossCheck.js';

const RecommendSchema = z.object({
  entityKind: z
    .enum(['master', 'transaction', 'setup', 'parameters', 'inquiry', 'lookup', 'workspace', 'dialogTask'])
    .optional()
    .describe('Kind of entity the form maintains: master (customers/products), transaction (orders+lines), setup (group/setup tables), parameters (module parameters), inquiry (read-only browsing), lookup, workspace (activity dashboard), dialogTask (gather inputs for an action)'),
  hasHeaderLines: z.boolean().optional().describe('True when the data is a header with line items (order + lines)'),
  fieldCount: z.number().optional().describe('Approximate number of fields users need to see/edit per record'),
  usageIntent: z
    .enum(['maintain', 'viewOnly', 'pickValue', 'quickCreate', 'dashboard', 'wizard'])
    .optional()
    .describe('Primary user activity on the form'),
  tableName: z.string().optional().describe('Main table — used to pull field count and existing-form evidence from the index'),
});

const GetFormPatternsArgsSchema = z.object({
  formPattern: z.enum(['DetailsTransaction', 'ListPage', 'SimpleList', 'SimpleListDetails', 'Dialog', 'DropDialog', 'FormPart', 'Lookup'])
    .optional()
    .describe('D365FO form pattern to analyze'),
  similarTo: z.string().optional().describe('Form name to find similar patterns'),
  dataSource: z.string().optional().describe('Table name - find forms using this table'),
  recommend: RecommendSchema.optional().describe(
    'Pattern advisor mode: describe the requirements and get a recommended pattern + reference forms to clone. ' +
    'Implements the Microsoft form-pattern decision tree backed by mined usage statistics.'
  ),
  limit: z.number().optional().default(10).describe('Maximum number of examples to return'),
});

export type RecommendInput = z.infer<typeof RecommendSchema>;

export interface PatternRecommendation {
  spec: FormPatternSpec;
  reasons: string[];
  /** Lower-ranked alternatives worth considering */
  alternatives: Array<{ spec: FormPatternSpec; why: string }>;
}

/**
 * Microsoft form-pattern decision tree (select-form-pattern guidance) over the
 * curated catalog. Pure function — index evidence is attached by the caller.
 */
export function recommendPattern(input: RecommendInput): PatternRecommendation {
  const reasons: string[] = [];
  const alternatives: Array<{ spec: FormPatternSpec; why: string }> = [];
  const pick = (id: string): FormPatternSpec => {
    const spec = resolvePattern(id);
    if (!spec) throw new Error(`Catalog inconsistency: pattern "${id}" not found`);
    return spec;
  };
  const alt = (id: string, why: string): void => {
    const spec = resolvePattern(id);
    if (spec) alternatives.push({ spec, why });
  };

  // Intent-driven picks first (strongest signals)
  if (input.usageIntent === 'pickValue' || input.entityKind === 'lookup') {
    reasons.push('Users pick a value → Lookup pattern (grid optimized for selection).');
    alt('SimpleList', 'if the form should also maintain the records, not just pick them');
    return { spec: pick('Lookup'), reasons, alternatives };
  }
  if (input.usageIntent === 'quickCreate' || input.entityKind === 'dialogTask') {
    if ((input.fieldCount ?? 99) < 5) {
      reasons.push('Few inputs (<5) anchored to an action → Drop Dialog.');
      alt('Dialog', 'if the dialog needs more fields or opens modally rather than from a button');
      return { spec: pick('DropDialog'), reasons, alternatives };
    }
    reasons.push('Gathering a set of inputs before an action → Dialog.');
    alt('DropDialog', 'if fewer than ~5 fields and anchored to a button');
    return { spec: pick('Dialog'), reasons, alternatives };
  }
  if (input.usageIntent === 'dashboard' || input.entityKind === 'workspace') {
    reasons.push('Activity overview/dashboard → Operational Workspace (tiles + lists + links).');
    alt('Workspace', 'legacy panorama workspace — only when matching existing forms');
    return { spec: pick('WorkspaceOperational'), reasons, alternatives };
  }
  if (input.usageIntent === 'wizard') {
    const wizard = resolvePattern('Wizard');
    if (wizard) {
      reasons.push('Step-by-step guided input → Wizard pattern.');
      return { spec: wizard, reasons, alternatives };
    }
  }

  // Entity-kind driven picks
  if (input.entityKind === 'parameters') {
    reasons.push('Module parameters / loosely related setup sections → Table of Contents.');
    return { spec: pick('TableOfContents'), reasons, alternatives };
  }
  if (input.entityKind === 'transaction' || input.hasHeaderLines) {
    reasons.push('Header + lines transaction entity → Details Transaction.');
    alt('DetailsMaster', 'if there are no line items after all');
    return { spec: pick('DetailsTransaction'), reasons, alternatives };
  }
  if (input.entityKind === 'inquiry' || input.usageIntent === 'viewOnly') {
    reasons.push('Read-only browsing entry point → List Page.');
    alt('SimpleList', 'if light in-grid editing is needed');
    return { spec: pick('ListPage'), reasons, alternatives };
  }
  if (input.entityKind === 'master') {
    reasons.push('Complex master entity → Details Master (FastTabs + grid view).');
    alt('SimpleListDetails', 'if the entity is only of medium complexity (~10-25 fields)');
    return { spec: pick('DetailsMaster'), reasons, alternatives };
  }

  // Setup/simple entities decided by field count (MS guidance: <10 → Simple List)
  const fieldCount = input.fieldCount;
  if (fieldCount !== undefined && fieldCount >= 10) {
    reasons.push(`~${fieldCount} fields per record (≥10) → Simple List & Details (list + details panel).`);
    alt('DetailsMaster', 'if the entity grows complex enough to need FastTabs');
    return { spec: pick('SimpleListDetails'), reasons, alternatives };
  }
  reasons.push(
    fieldCount !== undefined
      ? `~${fieldCount} fields per record (<10) → Simple List (single editable grid).`
      : 'Default for setup/simple entities → Simple List (single editable grid, <10 fields).',
  );
  alt('SimpleListDetails', 'if users need a details panel for more fields');
  return { spec: pick('SimpleList'), reasons, alternatives };
}

export async function handleGetFormPatterns(
  args: { formPattern?: string; dataSource?: string; tableName?: string; limit?: number },
  symbolIndex: any
): Promise<any> {
  const { formPattern, limit = 10 } = args;
  const tableName = args.dataSource || args.tableName;
  let output = `# Form Patterns Analysis\n\n`;

  if (tableName) {
    output += `## 📋 Forms Using Table: \`${tableName}\`\n\n`;
    output += await analyzeFormsUsingTable(symbolIndex, tableName, limit);
  } else if (formPattern) {
    output += `## 📋 Forms with Pattern: \`${formPattern}\`\n\n`;
    output += await analyzeFormPattern(symbolIndex, formPattern, limit);
  } else {
    throw new Error('Must provide either formPattern or tableName');
  }

  return {
    content: [
      {
        type: 'text',
        text: output,
      },
    ],
  };
}

export async function getFormPatternsTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetFormPatternsArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    const { formPattern, similarTo, dataSource, recommend, limit } = args;

    let output = `# Form Patterns Analysis\n\n`;

    if (recommend) {
      output = await renderRecommendation(symbolIndex, recommend);
      return { content: [{ type: 'text', text: output }] };
    }

    if (similarTo) {
      // Find similar form and analyze it
      output += `## 📋 Patterns Similar to Form \`${similarTo}\`\n\n`;
      output += await analyzeSimilarForm(symbolIndex, similarTo, limit);
    } else if (dataSource) {
      // Find forms using this table
      output += `## 📋 Forms Using Table \`${dataSource}\`\n\n`;
      output += await analyzeFormsUsingTable(symbolIndex, dataSource, limit);
    } else if (formPattern) {
      // Analyze patterns for form pattern type
      output += `## 📋 Common Patterns for ${formPattern} Forms\n\n`;
      output += await analyzeFormPattern(symbolIndex, formPattern, limit);
    } else {
      throw new Error('Either formPattern, similarTo, dataSource, or recommend must be provided');
    }

    return {
      content: [{ type: 'text', text: output }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error analyzing form patterns: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

async function renderRecommendation(symbolIndex: any, input: RecommendInput): Promise<string> {
  // Enrich fieldCount from the index when only a table name was given
  const enriched: RecommendInput = { ...input };
  const rdb = symbolIndex.getReadDb();
  if (enriched.tableName && enriched.fieldCount === undefined) {
    try {
      const row = rdb.prepare(`
        SELECT COUNT(*) AS c FROM symbols
        WHERE type = 'field' AND parent_name = ? COLLATE NOCASE
          AND name NOT IN ('RecId', 'RecVersion', 'DataAreaId', 'Partition')
      `).get(enriched.tableName) as { c: number } | undefined;
      if (row && row.c > 0) enriched.fieldCount = row.c;
    } catch { /* index without fields — keep undefined */ }
  }

  const rec = recommendPattern(enriched);
  const lines: string[] = [];
  lines.push(`# 🧭 Form Pattern Recommendation`);
  lines.push('');
  lines.push(`**Recommended pattern:** \`${rec.spec.xmlName}\` v${rec.spec.versions[0]} — ${rec.spec.displayName}`);
  lines.push('');
  for (const reason of rec.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push(`**Purpose:** ${rec.spec.purpose}`);

  if (rec.alternatives.length > 0) {
    lines.push('');
    lines.push('**Consider instead:**');
    for (const a of rec.alternatives) {
      lines.push(`- \`${a.spec.xmlName}\` — ${a.why}`);
    }
  }

  // Reference forms: curated + mined evidence (graceful when index lacks mined data)
  const referenceForms = [...rec.spec.referenceForms];
  let minedNote = '';
  try {
    if (hasMinedPatternData(rdb)) {
      const mined = rdb.prepare(`
        SELECT form_name, pattern_version, COUNT(*) AS n FROM form_patterns
        WHERE node_path = 'Design' AND pattern = ?
        GROUP BY form_name ORDER BY form_name LIMIT 8
      `).all(rec.spec.xmlName) as Array<{ form_name: string; pattern_version: string | null }>;
      if (mined.length > 0) {
        minedNote = `\n**Real forms using ${rec.spec.xmlName} in this environment:** ` +
          mined.map((m) => `\`${m.form_name}\`${m.pattern_version ? ` (v${m.pattern_version})` : ''}`).join(', ');
        for (const m of mined) {
          if (!referenceForms.includes(m.form_name)) referenceForms.push(m.form_name);
        }
      } else {
        minedNote = `\nℹ️ No mined usage of ${rec.spec.xmlName} found in this environment's index.`;
      }
    } else {
      minedNote = '\nℹ️ Pattern mining data not available — rebuild the index (extract-metadata + build-database) for environment-grounded examples.';
    }
  } catch { /* older index without form_patterns table */ }

  lines.push('');
  lines.push(`**Reference forms to clone:** ${rec.spec.referenceForms.map((f) => `\`${f}\``).join(', ')}`);
  if (minedNote) lines.push(minedNote);

  // Existing forms on the same table — strong cloning candidates
  if (enriched.tableName) {
    try {
      const sameTable = rdb.prepare(`
        SELECT DISTINCT form_name FROM form_datasources WHERE table_name = ? COLLATE NOCASE LIMIT 5
      `).all(enriched.tableName) as Array<{ form_name: string }>;
      if (sameTable.length > 0) {
        lines.push('');
        lines.push(`**Forms already using \`${enriched.tableName}\`:** ${sameTable.map((f) => `\`${f.form_name}\``).join(', ')}`);
      }
    } catch { /* ignore */ }
  }

  const cloneSource = rec.spec.referenceForms[0];
  lines.push('');
  lines.push('## ✅ Next step (cloning is the preferred workflow)');
  lines.push('```');
  lines.push(`generate_object(mode="scaffold", objectType="form", `);
  lines.push(`  name="MyNewForm",`);
  lines.push(`  cloneFrom="${cloneSource}",`);
  lines.push(`  tableMapping={${enriched.tableName ? `"<sourceTable>": "${enriched.tableName}"` : `"<sourceTable>": "<yourTable>"`}},`);
  lines.push(`  includeMethodStubs=true`);
  lines.push(`)`);
  lines.push('```');
  lines.push(`Then: \`object_patterns(domain="form", action="validate", xml=...)\` → \`d365fo_file(action="create", objectType="form", ...)\`.`);
  lines.push('');
  lines.push(`Use \`object_patterns(domain="form", action="spec", pattern="${rec.spec.xmlName}")\` for the full structure spec (required containers, ordering, sub-patterns).`);

  return lines.join('\n');
}

async function analyzeSimilarForm(symbolIndex: any, formName: string, limit: number): Promise<string> {
  const rdb = symbolIndex.getReadDb();
  // Get form info
  const formRow = rdb.prepare(`
    SELECT * FROM symbols WHERE type = 'form' AND name = ? LIMIT 1
  `).get(formName);

  if (!formRow) {
    throw new Error(`Form "${formName}" not found`);
  }

  // Get datasources
  const datasources = rdb.prepare(`
    SELECT datasource_name, table_name, allow_edit, allow_create, allow_delete
    FROM form_datasources
    WHERE form_name = ?
    LIMIT ${limit}
  `).all(formName) as Array<{
    datasource_name: string;
    table_name: string;
    allow_edit: number;
    allow_create: number;
    allow_delete: number;
  }>;

  let output = `**Form:** \`${formName}\`\n`;
  output += `**Model:** ${formRow.model}\n\n`;

  if (datasources.length > 0) {
    output += `### DataSources (${datasources.length})\n\n`;
    output += `| DataSource Name | Table | Edit | Create | Delete |\n`;
    output += `|-----------------|-------|------|--------|--------|\n`;
    for (const ds of datasources) {
      const edit = ds.allow_edit ? '✅' : '❌';
      const create = ds.allow_create ? '✅' : '❌';
      const del = ds.allow_delete ? '✅' : '❌';
      output += `| ${ds.datasource_name} | ${ds.table_name} | ${edit} | ${create} | ${del} |\n`;
    }
  } else {
    output += `**No datasources indexed** (form may need re-extraction with enhanced parser)\n\n`;
  }

  // Find similar forms based on datasource tables
  if (datasources.length > 0) {
    output += `\n### Similar Forms (Using Same Tables)\n\n`;
    const tables = datasources.map(ds => ds.table_name);
    const similarForms = rdb.prepare(`
      SELECT DISTINCT form_name, COUNT(DISTINCT table_name) as match_count
      FROM form_datasources
      WHERE table_name IN (${tables.map(() => '?').join(',')})
        AND form_name != ?
      GROUP BY form_name
      ORDER BY match_count DESC
      LIMIT 5
    `).all(...tables, formName) as Array<{ form_name: string; match_count: number }>;

    for (const similar of similarForms) {
      output += `- **${similar.form_name}** (${similar.match_count} matching datasources)\n`;
    }
  }

  return output;
}

async function analyzeFormsUsingTable(symbolIndex: any, tableName: string, limit: number): Promise<string> {
  const rdb = symbolIndex.getReadDb();
  // Find forms using this table
  const forms = rdb.prepare(`
    SELECT DISTINCT form_name, datasource_name, allow_edit, allow_create, allow_delete
    FROM form_datasources
    WHERE table_name = ?
    LIMIT ${limit}
  `).all(tableName) as Array<{
    form_name: string;
    datasource_name: string;
    allow_edit: number;
    allow_create: number;
    allow_delete: number;
  }>;

  let output = `**Table:** \`${tableName}\`\n\n`;

  if (forms.length === 0) {
    output += `No forms found using this table. This could mean:\n`;
    output += `- Table is new and not yet used in forms\n`;
    output += `- Forms need re-extraction with enhanced parser\n`;
    output += `- Table is used only in code, not in form datasources\n\n`;
    return output;
  }

  output += `**Forms Found:** ${forms.length}\n\n`;
  output += `| Form Name | DataSource Name | Edit | Create | Delete |\n`;
  output += `|-----------|-----------------|------|--------|--------|\n`;

  for (const form of forms) {
    const edit = form.allow_edit ? '✅' : '❌';
    const create = form.allow_create ? '✅' : '❌';
    const del = form.allow_delete ? '✅' : '❌';
    output += `| ${form.form_name} | ${form.datasource_name} | ${edit} | ${create} | ${del} |\n`;
  }

  // Analyze common permission patterns
  const editableCount = forms.filter(f => f.allow_edit).length;
  const creatableCount = forms.filter(f => f.allow_create).length;
  const deletableCount = forms.filter(f => f.allow_delete).length;

  output += `\n### 💡 Common Patterns\n\n`;
  output += `- **Allow Edit:** ${editableCount}/${forms.length} forms\n`;
  output += `- **Allow Create:** ${creatableCount}/${forms.length} forms\n`;
  output += `- **Allow Delete:** ${deletableCount}/${forms.length} forms\n`;

  return output;
}

async function analyzeFormPattern(symbolIndex: any, formPattern: string, limit: number): Promise<string> {
  const rdb = symbolIndex.getReadDb();
  let output = `**Pattern:** ${formPattern}\n\n`;

  // Get sample forms (heuristic based on naming conventions)
  let namePattern = '';
  if (formPattern === 'ListPage') {
    namePattern = '%ListPage';
  } else if (formPattern === 'Dialog') {
    namePattern = '%Dialog';
  } else if (formPattern === 'Lookup') {
    namePattern = '%Lookup';
  }

  const sampleForms = rdb.prepare(`
    SELECT DISTINCT name, model 
    FROM symbols 
    WHERE type = 'form'
      ${namePattern ? `AND name LIKE ?` : ''}
    LIMIT ${limit}
  `).all(...(namePattern ? [namePattern] : [])) as Array<{ name: string; model: string }>;

  if (sampleForms.length === 0) {
    output += `No sample forms found for ${formPattern} pattern.\n\n`;
    output += `**Recommendation:**\n`;
    output += `- Use \`similarTo\` parameter with a known form name\n`;
    output += `- Or use \`dataSource\` parameter to find forms using a specific table\n`;
    return output;
  }

  output += `**Sample Forms Found:** ${sampleForms.length}\n\n`;

  // ── BATCHED datasource query: fetch all datasources for all sample forms in ONE query ──
  const formNames = sampleForms.map(f => f.name);
  const placeholders = formNames.map(() => '?').join(',');
  const allDatasources = rdb.prepare(`
    SELECT form_name, table_name, allow_edit, allow_create, allow_delete
    FROM form_datasources
    WHERE form_name IN (${placeholders})
  `).all(...formNames) as Array<{
    form_name: string;
    table_name: string;
    allow_edit: number;
    allow_create: number;
    allow_delete: number;
  }>;

  // Analyze datasource patterns
  const dsPatternMap = new Map<string, { count: number; permissions: { edit: number; create: number; delete: number } }>();

  for (const ds of allDatasources) {
    const existing = dsPatternMap.get(ds.table_name);
    if (existing) {
      existing.count++;
      existing.permissions.edit += ds.allow_edit;
      existing.permissions.create += ds.allow_create;
      existing.permissions.delete += ds.allow_delete;
    } else {
      dsPatternMap.set(ds.table_name, {
        count: 1,
        permissions: {
          edit: ds.allow_edit,
          create: ds.allow_create,
          delete: ds.allow_delete,
        },
      });
    }
  }

  const commonTables = Array.from(dsPatternMap.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);

  if (commonTables.length > 0) {
    output += `### Common DataSource Tables\n\n`;
    output += `| Table Name | Frequency | Typical Permissions |\n`;
    output += `|------------|-----------|---------------------|\n`;
    for (const [tableName, data] of commonTables) {
      const freq = `${data.count}/${sampleForms.length}`;
      const editPct = Math.round((data.permissions.edit / data.count) * 100);
      const createPct = Math.round((data.permissions.create / data.count) * 100);
      const deletePct = Math.round((data.permissions.delete / data.count) * 100);
      const perms = `E:${editPct}% C:${createPct}% D:${deletePct}%`;
      output += `| ${tableName} | ${freq} | ${perms} |\n`;
    }
  }

  output += `\n### 💡 Recommendations for ${formPattern}\n\n`;
  
  if (formPattern === 'ListPage') {
    output += `- Typically read-only with grid control\n`;
    output += `- Single datasource with filtered fields\n`;
    output += `- Action buttons for navigation to detail forms\n`;
  } else if (formPattern === 'DetailsTransaction') {
    output += `- Editable with header/lines pattern\n`;
    output += `- Multiple datasources (header + line items)\n`;
    output += `- FastTabs for grouping fields\n`;
  } else if (formPattern === 'Dialog') {
    output += `- Simple input form with OK/Cancel buttons\n`;
    output += `- Limited fields, focused on specific task\n`;
    output += `- No datasource or temporary table datasource\n`;
  }

  return output;
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.
