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
import { detectEol } from '../utils/eolUtils.js';
import { isExtensionLabelFile } from '../metadata/labelParser.js';
import { ProjectFileManager, ProjectFileFinder } from './createD365File.js';

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
  languages: z
    .array(z.string())
    .optional()
    .describe(
      'Restrict which language .label.txt files are written/created. ' +
        'When provided, the label is created ONLY for these locales (e.g. ["en-US"] for an ' +
        'English-only customization), creating the folders if needed. This avoids leaking the ' +
        'label into locales that exist only because OTHER label files in the same model ship ' +
        'them (LabelResources is shared across the whole model). ' +
        'When omitted or empty, the label is written to every language folder already present ' +
        'in the model (default behavior).',
    ),
  description: z
    .string()
    .optional()
    .describe(
      'Label description written as the comment line in .label.txt. ' +
      'Defaults to the VS project name (from .rnrproj) when omitted, ' +
      'then falls back to labelFileId. Per-translation comment and defaultComment take priority over this.',
    ),
  defaultComment: z
    .string()
    .optional()
    .describe('Developer comment used for languages that have no explicit comment'),
  packagePath: z
    .string()
    .optional()
    .describe('Root packages path. Auto-detected from environment config if omitted.'),
  projectPath: z
    .string()
    .optional()
    .describe('Path to the .rnrproj project file. Auto-detected from .mcp.json if omitted.'),
  solutionPath: z
    .string()
    .optional()
    .describe('Path to the .sln solution directory. Used as fallback to find .rnrproj if projectPath is not set.'),
  addToProject: z
    .boolean()
    .optional()
    .default(true)
    .describe('Add label file XML descriptors to the VS project (.rnrproj) so builds detect them (default: true)'),
  createLabelFileIfMissing: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'If true (default) and the AxLabelFile does not exist yet, create it with the provided ' +
        'translations. A wrong-path guard still fails loudly when the model directory is not found, ' +
        'so this never produces a phantom label file. Set to false to fail fast instead of creating.',
    ),
  allowExtensionLabelFile: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Escape hatch to allow writing into a label file EXTENSION (a labelFileId ' +
        'carrying the "_Extension" marker). Off by default: new labels belong in the ' +
        "model's own ORIGINAL label file, not in an extension. Only set true if you " +
        'genuinely intend to add labels to an extension label file.',
    ),
  updateIndex: z
    .boolean()
    .optional()
    .default(true)
    .describe('Update the MCP label index after writing files (default: true)'),
  sortLabels: z
    .boolean()
    .optional()
    .describe(
      'Sort labels alphabetically when writing .label.txt files. ' +
        'When false, new labels are appended at the end preserving existing file order. ' +
        'Defaults to the LABEL_SORT_ORDER env var ("alphabetical" = true, "append" = false), or true if not set.',
    ),
  overwriteExisting: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Update mode (set automatically by labels(action="update")): overwrite the text of an ' +
        'existing label instead of skipping it. When the label is absent in a target language it ' +
        'is created (upsert). Off by default so create never clobbers existing text.',
    ),
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

/** Case-insensitive ordinal comparison of two label IDs.
 *  Matches Visual Studio's ordering of .label.txt entries, where `_` (0x5F) sorts
 *  AFTER all letters. A locale-aware comparer (e.g. localeCompare) instead sorts `_`
 *  BEFORE letters, which shuffles `word_`-prefixed IDs on every write and produces
 *  spurious git diffs. Equivalent to .NET's StringComparer.OrdinalIgnoreCase. */
function compareLabelIdsOrdinalCI(a: string, b: string): number {
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  return ua < ub ? -1 : ua > ub ? 1 : 0;
}

/** Render a label map back to .label.txt content with UTF-8 BOM.
 *  When `sort` is true (default), entries are sorted alphabetically by label ID.
 *  When `sort` is false, entries are written in insertion order (existing + appended).
 *  `eol` should be the line ending detected from the existing file (defaults to CRLF for new files). */
function serializeLabelMap(
  map: Map<string, { text: string; comment?: string }>,
  sort = true,
  eol: '\r\n' | '\n' = '\r\n',
): string {
  const entries = sort
    ? [...map.entries()].sort(([a], [b]) => compareLabelIdsOrdinalCI(a, b))
    : [...map.entries()];
  const lines: string[] = [];
  for (const [id, { text, comment }] of entries) {
    lines.push(`${id}=${text}`);
    if (comment) lines.push(` ;${comment}`);
  }
  // End with a newline, prepend UTF-8 BOM for D365FO compatibility
  return UTF8_BOM + lines.join(eol) + eol;
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

/**
 * Normalize common parameter-name variants before validation.
 * Some MCP clients guess the schema and send `labelFile` instead of `labelFileId`,
 * or a scalar `value`/`text`/`label` instead of the `translations` array.
 * This keeps those calls working while the canonical names stay the source of truth.
 */
function normalizeCreateLabelArgs(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object') return {};
  const args: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  // labelFile / labelfile → labelFileId
  if (args.labelFileId === undefined) {
    const alias = args.labelFile ?? (args as any).labelfile ?? args.labelFileID;
    if (typeof alias === 'string') args.labelFileId = alias;
  }
  delete args.labelFile;
  delete (args as any).labelfile;
  delete args.labelFileID;

  // model defaults to labelFileId (they are typically identical)
  if (args.model === undefined && typeof args.labelFileId === 'string') {
    args.model = args.labelFileId;
  }

  // scalar value / text / label → translations: [{ language: 'en-US', text }]
  if (args.translations === undefined) {
    const scalar = args.value ?? args.text ?? args.label;
    if (typeof scalar === 'string') {
      const language = typeof args.language === 'string' ? args.language : 'en-US';
      args.translations = [{ language, text: scalar }];
    }
  }
  delete args.value;
  delete args.text;
  delete args.label;

  return args;
}

// ── Bulk fan-out ──────────────────────────────────────────────────────────────

/**
 * Pull a `labels: [...]` array off the raw args, if present and non-empty.
 * Bulk callers pass shared fields (labelFileId, model, paths…) at the top level
 * and one entry per label ({ labelId, translations, … }). Returns null for the
 * ordinary single-label shape so the normal path runs unchanged.
 */
export function extractBulkLabels(raw: unknown): Array<Record<string, unknown>> | null {
  if (raw === null || typeof raw !== 'object') return null;
  const arr = (raw as Record<string, unknown>).labels;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object');
}

/** The single-label create signature, injectable so the fan-out is testable. */
export type SingleLabelRunner = (
  request: CallToolRequest,
  context: XppServerContext,
) => Promise<any>;

/**
 * Create many labels in one call. Each entry is merged over the shared top-level
 * fields and routed through the single-label path (which keeps validation, file
 * creation and indexing identical), then results are aggregated into one report.
 * Continues past per-label failures so one bad entry doesn't abort the batch.
 */
export async function createLabelsBulk(
  entries: Array<Record<string, unknown>>,
  raw: Record<string, unknown>,
  context: XppServerContext,
  runSingle: SingleLabelRunner = createLabelTool,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean }> {
  // Shared fields = everything except the per-entry array and any top-level
  // labelId/translations (each entry owns those).
  const shared: Record<string, unknown> = { ...raw };
  delete shared.labels;
  delete shared.labelId;
  delete shared.translations;

  const lines: string[] = [];
  let created = 0;
  let failed = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const mergedArgs = { ...shared, ...entry };
    const labelId = typeof entry.labelId === 'string' ? entry.labelId : `(entry ${i + 1})`;
    const subRequest: CallToolRequest = {
      method: 'tools/call',
      params: { name: 'create_label', arguments: mergedArgs },
    };
    // Recurses into the single-label path: mergedArgs carries no `labels` array,
    // so extractBulkLabels returns null and the normal handler runs.
    const res = await runSingle(subRequest, context);
    const text = res?.content?.[0]?.text ?? '(no output)';
    if (res?.isError) {
      failed++;
      lines.push(`🔴 ${labelId}: ${text.split('\n')[0]}`);
    } else {
      created++;
      lines.push(`🟢 ${labelId}: ${text.split('\n')[0]}`);
    }
  }

  const header =
    `${failed === 0 ? '✅' : '⚠️'} labels(action="create", labels=[…]): ` +
    `${created} created, ${failed} failed (of ${entries.length}).`;
  return {
    content: [{ type: 'text', text: [header, '', ...lines].join('\n') }],
    isError: failed > 0,
  };
}

// ── Tool implementation ───────────────────────────────────────────────────────

export async function createLabelTool(request: CallToolRequest, context: XppServerContext) {
  // Bulk shape: a `labels` array fans out to one single-label create per entry.
  const bulk = extractBulkLabels(request.params.arguments);
  if (bulk) {
    return createLabelsBulk(bulk, request.params.arguments as Record<string, unknown>, context);
  }
  try {
    const parsed = CreateLabelArgsSchema.safeParse(
      normalizeCreateLabelArgs(request.params.arguments),
    );
    if (!parsed.success) {
      // Name the offending field(s) instead of leaking a bare zod
      // "expected string, received undefined" with no field reference.
      const issues = parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return {
        content: [{
          type: 'text',
          text:
            `❌ labels(action="create"/"update"): invalid arguments — ${issues}.\n` +
            `Required: labelId, labelFileId, model, translations:[{language, text}]. Example:\n` +
            `  labels(action="create", labelId="EquipmentName", labelFileId="ContosoExt", model="ContosoExt", ` +
            `translations=[{language:"en-US", text:"Equipment name"}])`,
        }],
        isError: true,
      };
    }
    const args = parsed.data;
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

    // Guard: never create new labels in a label file EXTENSION (e.g. "Base_Extension").
    // Extensions only extend a base label file owned by another model — new labels
    // belong in the model's own ORIGINAL label file. Writing here is what makes clients
    // wrongly prefix the label IDs. Opt out explicitly with allowExtensionLabelFile=true.
    if (isExtensionLabelFile(labelFileId) && !args.allowExtensionLabelFile) {
      return {
        content: [
          {
            type: 'text',
            text:
              `❌ "${labelFileId}" is a label file EXTENSION, not an original label file.\n\n` +
              `New labels must be created in the model's own (original) label file — ` +
              `extensions (…_Extension…) only extend a base label file owned by another model, ` +
              `and adding new labels there leads to wrongly prefixed label IDs.\n\n` +
              `➡️  Use the model's original label file instead. List the candidates with:\n` +
              `      labels(action="info", model="${model}")\n` +
              `   then re-run with that original labelFileId, e.g.:\n` +
              `      labels(action="create", labelId="${labelId}", labelFileId="<OriginalLabelFileId>", model="${model}", ...)\n\n` +
              `If you really must add labels to this extension, pass allowExtensionLabelFile=true.\n` +
              `Nothing was written.`,
          },
        ],
        isError: true,
      };
    }

    // Resolve sortLabels: explicit param → LABEL_SORT_ORDER env → true (alphabetical)
    const envSortOrder = process.env.LABEL_SORT_ORDER?.toLowerCase();
    const shouldSort = args.sortLabels ?? (envSortOrder === 'append' ? false : true);

    // Description fallback: explicit description → VS project name → labelFileId
    // Model name is not useful here — it's typically identical to labelFileId.
    const configManager = getConfigManager();
    await configManager.ensureLoaded();
    let projectName: string | null = null;
    try {
      const projPath = args.projectPath || await configManager.getProjectPath() || null;
      if (projPath) {
        // Use split on both separators for cross-platform safety (path.basename
        // treats backslash as literal on POSIX, breaking Windows-style paths)
        const segments = projPath.split(/[\\/]/);
        const baseName = segments[segments.length - 1] || segments[segments.length - 2] || '';
        projectName = baseName.replace(/\.rnrproj$/i, '') || null;
      }
    } catch { /* non-fatal */ }
    const effectiveDescription = description ?? projectName ?? labelFileId;
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

    // 2. Discover the language folders that already exist in the model.
    //    NOTE: LabelResources/ is shared by EVERY label file in the model, so this lists
    //    locales owned by sibling label files too. The `languages` arg scopes the writes.
    const requestedLanguages = (args.languages ?? [])
      .map(l => l.trim())
      .filter(Boolean);

    let discoveredLanguages: string[] = [];
    try {
      discoveredLanguages = await fs.readdir(labelResourcesDir);
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

    // 3. Determine the target language set and create any missing folders.
    //    A brand-new label file (no locales at all anywhere in the model) is still guarded
    //    by createLabelFileIfMissing regardless of which mode we're in.
    const labelFileMissing = discoveredLanguages.length === 0;
    if (labelFileMissing && !createLabelFileIfMissing) {
      return {
        content: [
          {
            type: 'text',
            text:
              `AxLabelFile "${labelFileId}" not found in model "${model}" ` +
              `(expected path: ${labelResourcesDir}).\n\n` +
              `Set createLabelFileIfMissing=true to create the label file from scratch, ` +
              `or use d365fo_file(action="create") to scaffold the label file first.`,
          },
        ],
        isError: true,
      };
    }

    // Guard against silently scaffolding a brand-new label file at the WRONG path.
    // When the label file is missing AND we're about to create it, verify the model
    // directory actually exists at the resolved location. If it doesn't, the package
    // path/name almost certainly points to the default PackagesLocalDirectory while the
    // model's metadata lives somewhere else (e.g. a repo checkout) — creating the file
    // here would "succeed" but write to a location D365FO never reads. Fail loudly with
    // guidance instead of producing a phantom label file.
    if (labelFileMissing && createLabelFileIfMissing) {
      let modelDirExists = false;
      try {
        await fs.access(modelDir);
        modelDirExists = true;
      } catch { /* missing */ }
      if (!modelDirExists) {
        return {
          content: [
            {
              type: 'text',
              text:
                `❌ Cannot create label file "${labelFileId}" — the model directory does not exist at the resolved path:\n` +
                `    ${modelDir}\n\n` +
                `Resolved package: "${resolvedPackageName}"  |  packages root: "${resolvedPackagePath}"\n\n` +
                `This usually means the model's metadata lives somewhere other than the default ` +
                `PackagesLocalDirectory (e.g. a repo checkout). Re-run with the correct location, for example:\n` +
                `  labels(action="create", labelId="${labelId}", labelFileId="${labelFileId}", model="${model}",\n` +
                `         packageName="<ActualPackageFolder>", packagePath="<root that contains it>", createLabelFileIfMissing=true)\n\n` +
                `Nothing was written.`,
            },
          ],
          isError: true,
        };
      }
    }

    let existingLanguages: string[];

    if (requestedLanguages.length > 0) {
      // Explicit scope: write ONLY to the requested locales, creating folders as needed.
      // Prevents the label from leaking into locales owned by sibling label files.
      //
      // Use a case-insensitive map from lowercase → actual on-disk name so that
      // callers passing BCP-47 standard casing (en-US) match Linux-unzipped
      // directories stored in lowercase (en-us). Without this, the write path
      // would build LabelResources/en-US/... next to an existing en-us/ folder,
      // creating a duplicate locale tree on case-sensitive filesystems.
      const discoveredMap = new Map(discoveredLanguages.map(l => [l.toLowerCase(), l]));
      for (const lang of requestedLanguages) {
        if (!discoveredMap.has(lang.toLowerCase())) {
          await createLangDirectory(lang);
          discoveredMap.set(lang.toLowerCase(), lang);
        }
      }
      // Resolve each requested locale to its actual on-disk name; fall back to the
      // caller-provided value for newly-created folders (not yet on disk).
      existingLanguages = requestedLanguages.map(l => discoveredMap.get(l.toLowerCase()) ?? l);
    } else if (labelFileMissing) {
      // No explicit scope and nothing exists yet — seed the folders from the translations.
      existingLanguages = [];
      for (const [lang] of translationMap) {
        await createLangDirectory(lang);
        existingLanguages.push(lang);
      }
    } else {
      // No explicit scope — default behavior: write to every language folder that already
      // exists in the model, plus any new languages supplied via translations.
      existingLanguages = [...discoveredLanguages];
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

      // Preserve the existing file's line endings so VCS diffs only show the new label.
      const eol = detectEol(content);
      const labelMap = parseLabelMap(content);

      // Duplicate check — create skips an existing label, update overwrites it.
      if (labelMap.has(labelId) && !args.overwriteExisting) {
        skipped.push(`${lang} (already exists: "${labelMap.get(labelId)!.text}")`);
        continue;
      }

      // Determine text for this language
      const entry = translationMap.get(lang) ?? { text: enUsText, comment: defaultComment ?? effectiveDescription };
      labelMap.set(labelId, entry);

      // Ensure the directory exists
      await fs.mkdir(langDir, { recursive: true });

      // Write updated file with UTF-8 BOM, preserving the original EOL style
      const newContent = serializeLabelMap(labelMap, shouldSort, eol);
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

    // 5. Update SQLite index (skip immediate FTS rebuild — schedule debounced)
    if (updateIndex && indexEntries.length > 0) {
      symbolIndex.bulkAddLabels(indexEntries, { skipFtsRebuild: true });
      symbolIndex.scheduleLabelsFtsRebuild();
    }

    // 5b. Add label file descriptors to VS project (.rnrproj) so builds detect them
    const addedToProject: string[] = [];
    let projectWarning = '';
    let projectAlreadyOk = false;
    if (args.addToProject && (written.length > 0 || existingLanguages.length > 0)) {
      // Resolve projectPath with the same fallback chain as create_d365fo_file:
      // 1. Explicit arg  2. configManager  3. solutionPath + ProjectFileFinder scan
      let projectPath = args.projectPath || await configManager.getProjectPath() || null;

      if (!projectPath) {
        const solutionPath = args.solutionPath || await configManager.getSolutionPath() || null;
        if (solutionPath) {
          console.error(`[create_label] projectPath not found, scanning solution: ${solutionPath}`);
          projectPath = await ProjectFileFinder.findProjectInSolution(solutionPath, model);
        }
      }

      if (projectPath) {
        const pfm = new ProjectFileManager();
        // Collect all languages that have an XML descriptor
        const allLangs = [...new Set([...written, ...existingLanguages])];
        console.error(`[create_label] Adding label to project: ${projectPath} | labelFileId=${labelFileId} | langs=${allLangs.join(',')}`);
        try {
          const added = await pfm.addLabelToProject(projectPath, labelFileId, allLangs);
          addedToProject.push(...added);
          if (added.length === 0) {
            projectAlreadyOk = true;
            console.error(`[create_label] All label entries already in project — no write needed`);
          } else {
            console.error(`[create_label] Added ${added.length} descriptor(s) to project`);
          }
        } catch (projErr: any) {
          const errMsg = projErr instanceof Error ? projErr.message : String(projErr);
          const isLocked = errMsg.includes('EBUSY') || errMsg.includes('EPERM') || errMsg.includes('EACCES');
          console.error(`[create_label] Failed to add label entries to project: ${errMsg}`);
          projectWarning =
            `\n⚠️ Label created but failed to add to VS project:\n${errMsg}\n` +
            (isLocked
              ? 'This usually means Visual Studio has the .rnrproj file locked.\n' +
                'Close Visual Studio (or unload the project), re-run the tool, then reopen.\n'
              : `Verify that projectPath exists: ${projectPath}\n`);
        }
      } else {
        console.error('[create_label] projectPath is null — label descriptors will NOT be added to .rnrproj.');
        projectWarning =
          '\n⚠️ Could not add label descriptors to VS project — projectPath not resolved.\n' +
          'Add projectPath to .mcp.json, pass it as a tool argument, or set solutionPath.\n' +
          'Example: { "servers": { "context": { "projectPath": "K:\\\\VSProjects\\\\MyModel\\\\MyModel.rnrproj" } } }\n';
      }
    }

    // 6. Build result summary
    if (written.length === 0 && skipped.length > 0) {
      const skipLines = [
        `⚠️ Label "${labelId}" already exists in all languages:\n` +
        skipped.map(s => `  - ${s}`).join('\n') +
        `\n\nLocation: ${labelResourcesDir}` +
        `\nPackage : ${resolvedPackageName} @ ${resolvedPackagePath}` +
        '\n\nNo label text changes were made.',
      ];
      if (addedToProject.length > 0) {
        skipLines.push('\nAdded to VS project:');
        skipLines.push(...addedToProject.map(n => `  ✔ ${n}`));
      } else if (projectAlreadyOk) {
        skipLines.push('\n✅ Label file entries already in VS project.');
      }
      if (projectWarning) skipLines.push(projectWarning);
      return {
        content: [{ type: 'text', text: skipLines.join('\n') }],
      };
    }

    const ref = `@${labelFileId}:${labelId}`;
    const lines: string[] = [
      ...(collisionWarning ? [collisionWarning] : []),
      `✅ Label "${ref}" ${args.overwriteExisting ? 'updated' : 'created'} successfully!`,
      '',
      `Label ID   : ${labelId}`,
      `Label File : ${labelFileId}  (model: ${model})`,
      `Package    : ${resolvedPackageName} @ ${resolvedPackagePath}`,
      `Location   : ${labelResourcesDir}`,
      '',
      'Written to languages:',
      ...written.map(l => `  ✔ ${l}  → ${translationMap.get(l)?.text ?? enUsText}`),
    ];
    if (skipped.length > 0) {
      lines.push('');
      lines.push('Skipped (already existed):');
      lines.push(...skipped.map(s => `  ⚠ ${s}`));
    }
    if (addedToProject.length > 0) {
      lines.push('');
      lines.push('Added to VS project:');
      lines.push(...addedToProject.map(n => `  ✔ ${n}`));
    } else if (projectAlreadyOk) {
      lines.push('');
      lines.push('✅ Label file entries already in VS project.');
    }
    if (projectWarning) {
      lines.push(projectWarning);
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

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.
