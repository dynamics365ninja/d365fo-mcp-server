/**
 * Create Label Tool
 * Adds a new label to an existing AxLabelFile in a custom model.
 *
 * For each language that has a .label.txt file in the model, the tool:
 *  1. Checks that the label ID does not already exist
 *  2. Inserts the label in alphabetical order
 *  3. Writes the updated file back to disk
 *  4. Updates the SQLite label index
 *
 * If the AxLabelFile does not exist yet (new label file), the tool also
 * creates the XML descriptor files and directory structure.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import type { XppSymbolIndex } from '../metadata/symbolIndex.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import { getConfigManager } from '../utils/configManager.js';
import { PackageResolver } from '../utils/packageResolver.js';

// UTF-8 BOM (Byte Order Mark)
const UTF8_BOM = '\uFEFF';

// ── Input schema ─────────────────────────────────────────────────────────────

const TranslationSchema = z.object({
  language: z.string().describe('Locale code (e.g. en-US, cs, de, sk)'),
  text: z.string().describe('Translated label text for this language'),
  comment: z.string().optional().describe('Optional developer comment for this language'),
});

const CreateLabelArgsSchema = z.object({
  labelId: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Label ID must be alphanumeric (no spaces)')
    .describe(
      'Label identifier — must be unique within the label file. ' +
      '⛔ NEVER add a model/object prefix to label IDs. ' +
      'Label IDs describe the meaning of the text, NOT the owning object. ' +
      'Good examples: "CustomerName", "InvoiceDate", "ErrorAmountNegative". ' +
      'Bad examples (with prefix): "MyModelCustomerName", "ContosoExtInvoiceDate".',
    ),
  labelFileId: z
    .string()
    .describe('Label file ID to add the label to (e.g. ContosoExt). Must exist in the model.'),
  model: z
    .string()
    .describe('Model name that owns the label file (e.g. ContosoExt, ApplicationSuite)'),
  packageName: z
    .string()
    .optional()
    .describe('Package name for the model. Auto-resolved if omitted.'),
  translations: z
    .array(TranslationSchema)
    .min(1)
    .describe(
      'Label text for each language. At minimum provide en-US. ' +
        'For languages without a translation the en-US text is used as fallback.',
    ),
  description: z
    .string()
    .optional()
    .describe(
      'Label description written as the comment line in .label.txt. ' +
      'Defaults to the model/project name when omitted. ' +
      'Per-translation comment and defaultComment take priority over this.',
    ),
  defaultComment: z
    .string()
    .optional()
    .describe('Developer comment used for languages that have no explicit comment'),
  packagePath: z
    .string()
    .optional()
    .describe('Root packages path. Auto-detected from environment config if omitted.'),
  createLabelFileIfMissing: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'If true and the AxLabelFile does not exist yet, create it with the provided translations. ' +
        'Set to false (default) to fail fast when the label file is missing.',
    ),
  updateIndex: z
    .boolean()
    .optional()
    .default(true)
    .describe('Update the MCP label index after writing files (default: true)'),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse a .label.txt file into an ordered map: labelId → { text, comment } */
function parseLabelMap(content: string): Map<string, { text: string; comment?: string }> {
  const map = new Map<string, { text: string; comment?: string }>();
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let lastId: string | null = null;

  for (const line of lines) {
    if (line === '') continue;
    if (line.startsWith(' ;') || line.startsWith('\t;')) {
      if (lastId) {
        const existing = map.get(lastId)!;
        const commentText = line.replace(/^[ \t];/, '').trim();
        existing.comment = existing.comment
          ? `${existing.comment} ${commentText}`
          : commentText;
      }
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
      const labelId = line.substring(0, eqIdx).trim();
      const text = line.substring(eqIdx + 1);
      if (labelId && !/\s/.test(labelId)) {
        map.set(labelId, { text });
        lastId = labelId;
      }
    }
  }
  return map;
}

/** Render a label map back to .label.txt content (alphabetically sorted) with UTF-8 BOM */
function serializeLabelMap(map: Map<string, { text: string; comment?: string }>): string {
  const sorted = [...map.entries()].sort(([a], [b]) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  const lines: string[] = [];
  for (const [id, { text, comment }] of sorted) {
    lines.push(`${id}=${text}`);
    if (comment) lines.push(` ;${comment}`);
  }
  // End with a newline, prepend UTF-8 BOM for D365FO compatibility
  return UTF8_BOM + lines.join('\n') + '\n';
}

/** Write file with UTF-8 BOM signature */
async function writeFileWithBom(filePath: string, content: string): Promise<void> {
  // Ensure content starts with BOM
  const contentWithBom = content.startsWith(UTF8_BOM) ? content : UTF8_BOM + content;
  await fs.writeFile(filePath, contentWithBom, 'utf-8');
}

/** XML descriptor content for a new AxLabelFile locale */
function buildAxLabelFileXml(
  labelFileId: string,
  language: string,
  packageName: string,
  model: string,
): string {
  // D365FO requires <Language> for every locale except en-US (which is the implicit default).
  const languageElement = language !== 'en-US' ? `\t<Language>${language}</Language>\n` : '';
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<AxLabelFile xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n` +
    `\t<Name>${labelFileId}_${language}</Name>\n` +
    `\t<LabelContentFileName>${labelFileId}.${language}.label.txt</LabelContentFileName>\n` +
    `\t<LabelFileId>${labelFileId}</LabelFileId>\n` +
    languageElement +
    `\t<RelativeUriInModelStore>${packageName}\\${model}\\AxLabelFile\\LabelResources\\${language}\\${labelFileId}.${language}.label.txt</RelativeUriInModelStore>\n` +
    `</AxLabelFile>\n`
  );
}

// ── Tool implementation ───────────────────────────────────────────────────────

export async function createLabelTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = CreateLabelArgsSchema.parse(request.params.arguments);
    const {
      labelId,
      labelFileId,
      model,
      translations,
      description,
      defaultComment,
      packagePath,
      createLabelFileIfMissing,
      updateIndex,
    } = args;

    // Description fallback: explicit description → model name
    const effectiveDescription = description ?? model;
    const { symbolIndex } = context;

    // 0. Cross-label-file collision check — warn when the same labelId exists in
    //    another label file (especially Microsoft's standard label files).
    const MICROSOFT_LABEL_FILES = new Set([
      'SYS', 'SYP', 'CAM', 'ACC', 'GLS', 'PRJ', 'PDS', 'PUR', 'BANK', 'TAX',
      'FMT', 'WHSMobile', 'RET', 'RETAIL', 'MCR', 'WMS', 'TMS', 'HRM', 'PSA',
      'PROD', 'KAN', 'PCL', 'PROD', 'PLMT', 'EWH',
    ]);
    let collisionWarning = '';
    try {
      const existing = symbolIndex.labelsDb
        .prepare(
          `SELECT label_id, label_file_id, model, text FROM labels
           WHERE label_id = ? AND language = 'en-US' AND label_file_id != ?
           LIMIT 10`,
        )
        .all(labelId, labelFileId) as Array<{ label_id: string; label_file_id: string; model: string; text: string }>;

      if (existing.length > 0) {
        const msCollisions = existing.filter(r => MICROSOFT_LABEL_FILES.has(r.label_file_id.toUpperCase()));
        const lines: string[] = [
          `⚠️ Label ID "${labelId}" already exists in ${existing.length} other label file(s):`,
        ];
        for (const r of existing) {
          const flag = MICROSOFT_LABEL_FILES.has(r.label_file_id.toUpperCase()) ? ' ← Microsoft standard' : '';
          lines.push(`  @${r.label_file_id}:${labelId}  [${r.model}]  "${r.text}"${flag}`);
        }
        if (msCollisions.length > 0) {
          lines.push('');
          lines.push(
            '  ⛔ Collision with Microsoft standard label file detected! ' +
            'Consider reusing the existing label instead of creating a new one, ' +
            'or use a more specific ID to avoid naming conflicts.',
          );
        }
        collisionWarning = lines.join('\n') + '\n\n';
      }
    } catch { /* labelsDb may not have the label yet — not fatal */ }

    // 1. Resolve model directory
    // Package name can differ from model name in any environment (not just UDE).
    const configManager = getConfigManager();
    const envType = await configManager.getDevEnvironmentType();

    let resolvedPackagePath: string;
    let resolvedPackageName: string;

    if (args.packageName) {
      // Explicit packageName always wins, regardless of environment type
      resolvedPackageName = args.packageName;
      if (envType === 'ude') {
        const customPath = await configManager.getCustomPackagesPath();
        resolvedPackagePath = packagePath || customPath || configManager.getPackagePath() || 'K:\\AosService\\PackagesLocalDirectory';
      } else {
        resolvedPackagePath = packagePath || configManager.getPackagePath() || 'K:\\AosService\\PackagesLocalDirectory';
      }
    } else if (envType === 'ude') {
      // UDE mode: auto-resolve package name via descriptor scan
      const customPath = await configManager.getCustomPackagesPath();
      const msPath = await configManager.getMicrosoftPackagesPath();
      const roots = [customPath, msPath].filter(Boolean) as string[];

      resolvedPackagePath = packagePath || customPath || 'K:\\AosService\\PackagesLocalDirectory';

      const resolver = new PackageResolver(roots);
      const resolved = await resolver.resolve(model);
      resolvedPackageName = resolved?.packageName || model;
      if (resolved?.rootPath) resolvedPackagePath = resolved.rootPath;
    } else {
      // Traditional mode without explicit packageName: assume package == model
      resolvedPackagePath = packagePath || configManager.getPackagePath() || 'K:\\AosService\\PackagesLocalDirectory';
      resolvedPackageName = model;
    }

    const modelDir = path.join(resolvedPackagePath, resolvedPackageName, model);
    const axLabelDir = path.join(modelDir, 'AxLabelFile');
    const labelResourcesDir = path.join(axLabelDir, 'LabelResources');

    // Build a quick lookup: language → translation entry
    const translationMap = new Map<string, { text: string; comment?: string }>();
    for (const tr of translations) {
      translationMap.set(tr.language, { text: tr.text, comment: tr.comment ?? defaultComment ?? effectiveDescription });
    }
    const enUsText = translationMap.get('en-US')?.text ?? translations[0].text;

    // 2. Discover existing language folders
    let existingLanguages: string[] = [];
    try {
      existingLanguages = await fs.readdir(labelResourcesDir);
    } catch {
      // LabelResources dir does not exist yet
    }

    // Helper: create directory structure + XML descriptor for a single new language
    const createLangDirectory = async (lang: string): Promise<void> => {
      const langDir = path.join(labelResourcesDir, lang);
      await fs.mkdir(langDir, { recursive: true });

      // Create the empty .label.txt with UTF-8 BOM (will be populated in step 4)
      const txtPath = path.join(langDir, `${labelFileId}.${lang}.label.txt`);
      try { await fs.access(txtPath); } catch { await writeFileWithBom(txtPath, ''); }

      // Create XML descriptor
      const xmlPath = path.join(axLabelDir, `${labelFileId}_${lang}.xml`);
      try { await fs.access(xmlPath); } catch {
        await fs.writeFile(xmlPath, buildAxLabelFileXml(labelFileId, lang, resolvedPackageName, model), 'utf-8');
      }
    };

    // 3. If no existing languages, decide whether to create
    if (existingLanguages.length === 0) {
      if (!createLabelFileIfMissing) {
        return {
          content: [
            {
              type: 'text',
              text:
                `AxLabelFile "${labelFileId}" not found in model "${model}" ` +
                `(expected path: ${labelResourcesDir}).\n\n` +
                `Set createLabelFileIfMissing=true to create the label file from scratch, ` +
                `or use create_d365fo_file to scaffold the label file first.`,
            },
          ],
          isError: true,
        };
      }

      // Create the LabelResources directory structure
      for (const [lang] of translationMap) {
        await createLangDirectory(lang);
        existingLanguages.push(lang);
      }
    } else {
      // Label file already has some languages.
      // Always create directories for languages in translationMap that don't exist yet.
      // createLabelFileIfMissing only guards the "no languages at all" case above.
      const existingSet = new Set(existingLanguages.map(l => l.toLowerCase()));
      for (const [lang] of translationMap) {
        if (!existingSet.has(lang.toLowerCase())) {
          await createLangDirectory(lang);
          existingLanguages.push(lang);
        }
      }
    }

    // 4. Process each existing language
    const written: string[] = [];
    const skipped: string[] = [];
    type LabelEntry = Parameters<XppSymbolIndex['bulkAddLabels']>[0][number];
    const indexEntries: LabelEntry[] = [];

    for (const lang of existingLanguages) {
      const langDir = path.join(labelResourcesDir, lang);
      const txtPath = path.join(langDir, `${labelFileId}.${lang}.label.txt`);

      // Read existing content (may not exist for newly-created langs)
      let content = '';
      try {
        content = await fs.readFile(txtPath, 'utf-8');
      } catch {
        // File doesn't exist yet — start empty
      }

      const labelMap = parseLabelMap(content);

      // Duplicate check
      if (labelMap.has(labelId)) {
        skipped.push(`${lang} (already exists: "${labelMap.get(labelId)!.text}")`);
        continue;
      }

      // Determine text for this language
      const entry = translationMap.get(lang) ?? { text: enUsText, comment: defaultComment ?? effectiveDescription };
      labelMap.set(labelId, entry);

      // Ensure the directory exists
      await fs.mkdir(langDir, { recursive: true });

      // Write updated file with UTF-8 BOM
      const newContent = serializeLabelMap(labelMap);
      await writeFileWithBom(txtPath, newContent);
      written.push(lang);

      // Prepare index update
      if (updateIndex) {
        indexEntries.push({
          labelId,
          labelFileId,
          model,
          language: lang,
          text: entry.text,
          comment: entry.comment,
          filePath: txtPath,
        });
      }

      // Ensure XML descriptor exists for this language
      const xmlPath = path.join(axLabelDir, `${labelFileId}_${lang}.xml`);
      try {
        await fs.access(xmlPath);
      } catch {
        await fs.writeFile(xmlPath, buildAxLabelFileXml(labelFileId, lang, resolvedPackageName, model), 'utf-8');
      }
    }

    // 5. Update SQLite index
    if (updateIndex && indexEntries.length > 0) {
      symbolIndex.bulkAddLabels(indexEntries);
    }

    // 6. Build result summary
    if (written.length === 0 && skipped.length > 0) {
      return {
        content: [
          {
            type: 'text',
            text:
              `⚠️ Label "${labelId}" already exists in all languages:\n` +
              skipped.map(s => `  - ${s}`).join('\n') +
              '\n\nNo changes were made.',
          },
        ],
      };
    }

    const ref = `@${labelFileId}:${labelId}`;
    const lines: string[] = [
      ...(collisionWarning ? [collisionWarning] : []),
      `✅ Label "${ref}" created successfully!`,
      '',
      `Label ID   : ${labelId}`,
      `Label File : ${labelFileId}  (model: ${model})`,
      '',
      'Written to languages:',
      ...written.map(l => `  ✔ ${l}  → ${translationMap.get(l)?.text ?? enUsText}`),
    ];
    if (skipped.length > 0) {
      lines.push('');
      lines.push('Skipped (already existed):');
      lines.push(...skipped.map(s => `  ⚠ ${s}`));
    }
    lines.push('');
    lines.push('Use in X++:');
    lines.push(`  literalStr("${ref}")`);
    lines.push('');
    lines.push('Use in metadata XML:');
    lines.push(`  <Label>${ref}</Label>`);
    lines.push(`  <HelpText>${ref}</HelpText>`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: `Error creating label: ${err.message}` }],
      isError: true,
    };
  }
}

export const createLabelToolDefinition = {
  name: 'create_label',
  description:
    'Add a new label to an existing AxLabelFile in a custom D365FO model. ' +
    'Writes the label into every language .label.txt file that exists in the model, ' +
    'inserts in alphabetical order, and updates the MCP index. ' +
    'Always call search_labels first to check if a suitable label already exists.',
  inputSchema: {
    type: 'object',
    properties: {
      labelId: {
        type: 'string',
        description: 'Unique label identifier (alphanumeric, no spaces), e.g. MyNewField',
      },
      labelFileId: {
        type: 'string',
        description: 'Label file ID that the label belongs to (e.g. ContosoExt)',
      },
      model: {
        type: 'string',
        description: 'Model name (e.g. ContosoExt, ApplicationSuite)',
      },
      translations: {
        type: 'array',
        description: 'Translations for each language. Provide at least en-US.',
        items: {
          type: 'object',
          properties: {
            language: { type: 'string', description: 'Locale code, e.g. en-US, cs, de, sk' },
            text: { type: 'string', description: 'Label text in this language' },
            comment: { type: 'string', description: 'Optional developer comment' },
          },
          required: ['language', 'text'],
        },
      },
      defaultComment: {
        type: 'string',
        description: 'Developer comment for languages without an explicit comment',
      },
      description: {
        type: 'string',
        description: 'Label description (comment line in .label.txt). Defaults to the model/project name when omitted. Per-translation comment and defaultComment take priority.',
      },
      packagePath: {
        type: 'string',
        description: 'Root PackagesLocalDirectory path (default: K:\\AosService\\PackagesLocalDirectory)',
      },
      createLabelFileIfMissing: {
        type: 'boolean',
        description: 'Create AxLabelFile structure if it does not exist yet (default: false)',
      },
      updateIndex: {
        type: 'boolean',
        description: 'Update the MCP label index after writing (default: true)',
      },
    },
    required: ['labelId', 'labelFileId', 'model', 'translations'],
  },
};
