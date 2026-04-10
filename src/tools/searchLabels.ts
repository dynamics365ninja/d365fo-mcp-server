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
              `💡 Tip: Use create_label to add a new label to your custom model.\n` +
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

    for (const raw of results) {
      const r = normalise(raw);
      // X++ label reference syntax
      const ref = `@${r.labelFileId}:${r.labelId}`;
      lines.push(`  ${ref}`);
      lines.push(`  Text    : ${r.text}`);
      if (r.comment) lines.push(`  Comment : ${r.comment}`);
      lines.push(`  Model   : ${r.model}  |  LabelFile: ${r.labelFileId}`);
      lines.push('');
    }

    lines.push(`💡 Use the label reference syntax in X++:  literalStr("@${(normalise(results[0])).labelFileId}:${(normalise(results[0])).labelId}")`);
    lines.push(`💡 Or in metadata XML:  <Label>@${(normalise(results[0])).labelFileId}:${(normalise(results[0])).labelId}</Label>`);

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

export const searchLabelsToolDefinition = {
  name: 'search_labels',
  description:
    'Full-text search across indexed D365FO AxLabelFile labels. ' +
    'Use this BEFORE creating new labels to check if a suitable label already exists. ' +
    'Returns label ID, text, comment and the X++ reference syntax (@LabelFileId:LabelId).',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search text — searches label ID, text and comments',
      },
      language: {
        type: 'string',
        description: 'Language/locale (default: en-US). Examples: cs, de, sk',
      },
      model: {
        type: 'string',
        description: 'Restrict to a specific model (e.g. ContosoExt)',
      },
      labelFileId: {
        type: 'string',
        description: 'Restrict to a specific label file ID (e.g. ContosoExt, SYS)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default 30)',
      },
    },
    required: ['query'],
  },
};
