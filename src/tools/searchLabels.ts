/**
 * Search Labels Tool
 * Full-text search across indexed AxLabelFile entries.
 * Returns matching labels with their ID, text, comment and model/language info.
 *
 * Typical use-cases:
 *  - Find existing labels before creating new ones
 *  - Discover the @ABC:MyLabel reference syntax to use in code or metadata
 *  - List all labels for a specific label file / model
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { getConfigManager } from '../utils/configManager.js';
import {
  formatLabelReference,
  isLabelLikelyResolvable,
  labelProvenanceWarning,
} from '../utils/labelReference.js';

const SearchLabelsArgsSchema = z.object({
  query: z
    .string()
    .describe(
      'Search text — searches label ID, label text and comments (e.g. "customer name", "MyFeature", "batch")',
    ),
  language: z
    .string()
    .optional()
    .default('en-US')
    .describe('Language/locale to search in (default: en-US). Examples: cs, de, sk, en-US'),
  model: z
    .string()
    .optional()
    .describe('Restrict results to a specific model (e.g. ContosoExt, ApplicationPlatform)'),
  labelFileId: z
    .string()
    .optional()
    .describe('Restrict results to a specific label file ID (e.g. ContosoExt, SYS)'),
  limit: z.number().optional().default(30).describe('Maximum number of results (default 30)'),
});

/** Best-effort current model: explicit arg → configured model → env. Never throws. */
function resolveCurrentModel(explicit?: string): string | undefined {
  if (explicit) return explicit;
  try {
    const configured = getConfigManager().getModelName();
    if (configured) return configured;
  } catch { /* config not loaded — fall through */ }
  return process.env.D365FO_MODEL_NAME || undefined;
}

export async function searchLabelsTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = SearchLabelsArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    const { query, language, model, labelFileId, limit } = args;

    let results = symbolIndex.searchLabels(query, { language, model, labelFileId, limit });

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              `No labels found matching "${query}"` +
              (language !== 'en-US' ? ` in language "${language}"` : '') +
              (model ? ` in model "${model}"` : '') +
              '.\n\n' +
              `💡 Tip: Use labels(action="create") to add a new label to your custom model.\n` +
              `💡 To search a different language use the language parameter (e.g. "cs", "de", "sk").`,
          },
        ],
      };
    }

    // Normalise column names (DB returns snake_case)
    const normalise = (r: any) => ({
      labelId: r.label_id ?? r.labelId,
      labelFileId: r.label_file_id ?? r.labelFileId,
      model: r.model,
      language: r.language,
      text: r.text,
      comment: r.comment ?? null,
    });

    const lines: string[] = [
      `Found ${results.length} label(s) matching "${query}" [language: ${language}${model ? `, model: ${model}` : ''}]:`,
      '',
    ];

    const currentModel = resolveCurrentModel(args.model);

    const normalised = results.map(normalise);

    for (const r of normalised) {
      // X++ label reference syntax — never double-prefix an id that already
      // carries its label file id (#33/#41: `@SYS:@SYS67433` is rejected by xppbp).
      const ref = formatLabelReference(r.labelFileId, r.labelId);
      const resolvable = isLabelLikelyResolvable(r.labelFileId, r.model, currentModel);
      lines.push(`  ${ref}${resolvable ? '' : `   ${labelProvenanceWarning(r.model)}`}`);
      lines.push(`  Text    : ${r.text}`);
      if (r.comment) lines.push(`  Comment : ${r.comment}`);
      lines.push(`  Model   : ${r.model}  |  LabelFile: ${r.labelFileId}`);
      lines.push('');
    }

    // Only ever *recommend* a label the model can actually resolve — suggesting an
    // unreferenced one is what produced BPErrorUnknownLabel in the sweep (#33/#41).
    const recommended = normalised.find(r => isLabelLikelyResolvable(r.labelFileId, r.model, currentModel));
    if (recommended) {
      const ref = formatLabelReference(recommended.labelFileId, recommended.labelId);
      lines.push(`💡 Use the label reference syntax in X++:  literalStr("${ref}")`);
      lines.push(`💡 Or in metadata XML:  <Label>${ref}</Label>`);
    } else {
      lines.push(
        `⚠️ None of these labels is in a core label file (SYS/…) or in your own model, so none is ` +
        `recommended as-is: referencing one raises BPErrorUnknownLabel unless your model references ` +
        `its package. Create your own with labels(action="create") instead.`,
      );
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: `Error searching labels: ${err.message}` }],
      isError: true,
    };
  }
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.
