/**
 * Get Label Info Tool
 * Returns all language translations for a specific label ID.
 * Also lists all available label files (AxLabelFile IDs) for a model.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

const GetLabelInfoArgsSchema = z.object({
  labelId: z
    .string()
    .optional()
    .describe(
      'Exact label ID to look up (e.g. MyFeature, BatchGroup). ' +
        'Omit to list available label files for the model instead.',
    ),
  labelFileId: z
    .string()
    .optional()
    .describe('Label file ID (e.g. ContosoExt, SYS, ApplicationPlatform)'),
  model: z.string().optional().describe('Model to filter by (e.g. ContosoExt)'),
});

export async function getLabelInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetLabelInfoArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    const { labelId, labelFileId, model } = args;

    // ── Mode A: no labelId → list available AxLabelFile IDs ─────────────────
    if (!labelId) {
      const files = symbolIndex.getLabelFileIds(model);
      if (files.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                `No label files found${model ? ` for model "${model}"` : ''}.\n` +
                `Make sure labels are indexed (run build-database with INCLUDE_LABELS=true).`,
            },
          ],
        };
      }

      const lines: string[] = [
        `Available AxLabelFile IDs${model ? ` in model "${model}"` : ''}:`,
        '',
      ];
      for (const f of files) {
        lines.push(`  LabelFileId : ${f.labelFileId}`);
        lines.push(`  Model       : ${f.model}`);
        lines.push(`  Languages   : ${f.languages}`);
        lines.push('');
      }
      lines.push(
        `💡 Use search_labels to find a label by text, or get_label_info with labelId to see all translations.`,
      );
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // ── Mode B: look up a specific label ID ─────────────────────────────────
    const rows = symbolIndex.getLabelById(labelId, labelFileId, model);

    if (rows.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              `Label "${labelId}" not found` +
              (labelFileId ? ` in label file "${labelFileId}"` : '') +
              (model ? ` in model "${model}"` : '') +
              '.\n\n' +
              `💡 Try search_labels to find labels by text, or omit labelId to list available label files.`,
          },
        ],
        isError: true,
      };
    }

    const first = rows[0];
    const ref = `@${first.labelFileId}:${labelId}`;

    const lines: string[] = [
      `Label: ${ref}`,
      `Model: ${first.model}  |  LabelFile: ${first.labelFileId}`,
      '',
      'Translations:',
    ];

    // Group by language, sorted
    const sorted = [...rows].sort((a, b) => {
      // en-US first, then alphabetical
      if (a.language === 'en-US') return -1;
      if (b.language === 'en-US') return 1;
      return a.language.localeCompare(b.language);
    });

    for (const r of sorted) {
      lines.push(`  [${r.language.padEnd(6)}]  ${r.text}`);
    }

    // Comment from en-US (or first available)
    const enUS = rows.find(r => r.language === 'en-US') ?? rows[0];
    if (enUS.comment) {
      lines.push('');
      lines.push(`Comment: ${enUS.comment}`);
    }

    lines.push('');
    lines.push('Usage in X++:');
    lines.push(`  literalStr("${ref}")`);
    lines.push('');
    lines.push('Usage in metadata XML:');
    lines.push(`  <Label>${ref}</Label>`);
    lines.push(`  <HelpText>${ref}</HelpText>`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: `Error getting label info: ${err.message}` }],
      isError: true,
    };
  }
}

export const getLabelInfoToolDefinition = {
  name: 'get_label_info',
  description:
    'Get all language translations for a specific D365FO label ID, or list available AxLabelFile IDs for a model. ' +
    'Returns the X++ reference syntax (@LabelFileId:LabelId) and usage examples.',
  inputSchema: {
    type: 'object',
    properties: {
      labelId: {
        type: 'string',
        description:
          'Exact label ID (e.g. MyFeature). Omit to list available label files.',
      },
      labelFileId: {
        type: 'string',
        description: 'Label file ID (e.g. ContosoExt, SYS)',
      },
      model: {
        type: 'string',
        description: 'Model to filter by (e.g. ContosoExt)',
      },
    },
    required: [],
  },
};
