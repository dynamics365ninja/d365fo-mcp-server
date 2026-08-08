/**
 * Get Label Info Tool
 * Returns all language translations for a specific label ID.
 * Also lists all available label files (AxLabelFile IDs) for a model.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { formatLabelReference } from '../../utils/labelReference.js';
import { labelMissingOnDisk } from '../../utils/labelDiskCheck.js';

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

    // Mode A: no labelId → list available AxLabelFile IDs
    if (!labelId) {
      let files = symbolIndex.getLabelFileIds(model);

      // When a specific labelFileId is requested, narrow the listing to it and
      // additionally surface the physical .label.txt path for each language so
      // the caller never has to shell out to locate the file on disk.
      if (labelFileId) {
        files = files.filter(f => f.labelFileId.toLowerCase() === labelFileId.toLowerCase());
      }

      if (files.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                `No label files found` +
                (labelFileId ? ` matching labelFileId "${labelFileId}"` : '') +
                (model ? ` for model "${model}"` : '') +
                `.\n` +
                `Make sure labels are indexed (run build-database with INCLUDE_LABELS=true).`,
            },
          ],
        };
      }

      const lines: string[] = [
        labelFileId
          ? `Label file "${labelFileId}"${model ? ` in model "${model}"` : ''}:`
          : `Available AxLabelFile IDs${model ? ` in model "${model}"` : ''}:`,
        '',
      ];
      for (const f of files) {
        lines.push(`  LabelFileId : ${f.labelFileId}`);
        lines.push(`  Model       : ${f.model}`);
        lines.push(`  Languages   : ${f.languages}`);

        // Physical file paths per language (only when a specific file was asked for,
        // so the generic "list everything" view stays compact).
        if (labelFileId) {
          const paths = symbolIndex.getLabelFilePaths(f.labelFileId, model);
          if (paths.length > 0) {
            lines.push(`  Files       :`);
            for (const p of paths) {
              lines.push(`    [${p.language.padEnd(6)}] ${p.filePath}`);
            }
          } else {
            lines.push(
              `  Files       : (no physical path indexed — label rows may predate path tracking; ` +
              `re-run build-database with INCLUDE_LABELS=true to populate file paths)`,
            );
          }
        }
        lines.push('');
      }
      lines.push(
        `💡 Use labels(action="search") to find a label by text, or labels(action="info") with labelId to see all translations.`,
      );
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // Mode B: look up a specific label ID
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
              `💡 Try labels(action="search") to find labels by text, or omit labelId to list available label files.`,
          },
        ],
        isError: true,
      };
    }

    const first = rows[0];
    // #33/#41: never emit `@SYS:@SYS67433` — an id that already carries its label
    // file id is a complete reference, and xppbp rejects the doubled form.
    const ref = formatLabelReference(first.labelFileId, labelId);

    // An index row is not proof the label exists. Confirm against the .label.txt
    // before handing back a reference the caller will paste into XML — a stale row
    // otherwise surfaces as `Unknown label` at build time, several steps later.
    //
    // Every model, including Microsoft's: gating this on isCustomModel() looks
    // right and is not, because isStandardModel() is defined as "not custom" and
    // an unrecognised model therefore reads as Microsoft's. The shared core model
    // whose phantom label started all this is exactly such a model, so the gate
    // would have switched the check off in the one place it had to fire. What
    // makes the big files affordable is the read budget in labelMissingOnDisk:
    // the @SYS sweep that measured 17 s now gives up at 218 ms with no verdict.
    const indexedPaths = symbolIndex
      .getLabelFilePaths(first.labelFileId, first.model)
      .map(p => p.filePath);
    if (await labelMissingOnDisk(labelId, indexedPaths)) {
      return {
        content: [{
          type: 'text',
          text:
            `⚠️ Label "${ref}" is in the symbol index but NOT in its label file on disk — ` +
            `treat it as NOT existing.\n` +
            `Checked: ${indexedPaths.join(', ')}\n\n` +
            `The index is ahead of the file system (a rolled-back run, a rebuild outside this ` +
            `server, or a checkout). Using this reference compiles to a best-practice error ` +
            `"Unknown label '${ref}'".\n\n` +
            `Create it: labels(action="create", labelId="${labelId}", labelFileId="${first.labelFileId}", ` +
            `model="${first.model}", translations=[{language:"en-US", text:"…"}])`,
        }],
        isError: true,
      };
    }

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

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.
