/**
 * AxLabelFile Parser
 * Parses D365FO .label.txt files from PackagesLocalDirectory
 * and indexes them into the SQLite labels table.
 *
 * Label file format (one per line):
 *   LabelId=Label text
 *    ;Optional comment line (leading space + semicolon)
 *
 * File locations on K: drive:
 *   {pkg}\{Model}\{Model}\AxLabelFile\LabelResources\{locale}\{LabelFileId}.{locale}.label.txt
 *   {pkg}\{Model}\{Model}\AxLabelFile\{LabelFileId}_{locale}.xml  (metadata descriptor)
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import type { XppSymbolIndex } from './symbolIndex.js';

export interface ParsedLabel {
  labelId: string;
  text: string;
  comment?: string;
  labelFileId: string;
  model: string;
  language: string;
  filePath: string;
}

/**
 * True when a label file ID refers to a label file EXTENSION rather than an
 * original (base) label file owned by the model.
 *
 * D365FO names label file extensions with an `_Extension` marker, optionally
 * followed by a model prefix — e.g. `Base_Extension` or `Base_ExtensionContoso`.
 * On disk the content file is `${labelFileId}.${locale}.label.txt`, so the
 * `_Extension` marker is carried in the label file ID itself.
 *
 * New labels must always be created in the model's own ORIGINAL label file.
 * An extension only extends a base label file owned by another model; adding
 * brand-new labels there is almost always a mistake (and is what leads clients
 * to wrongly prefix the label IDs).
 */
export function isExtensionLabelFile(labelFileId: string): boolean {
  return /_Extension/i.test(labelFileId);
}

/**
 * Parse a single .label.txt file into ParsedLabel records.
 */
export function parseLabelFile(
  content: string,
  labelFileId: string,
  model: string,
  language: string,
  filePath: string,
): ParsedLabel[] {
  const labels: ParsedLabel[] = [];
  // Normalise line endings
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  let current: ParsedLabel | null = null;

  for (const line of lines) {
    if (line === '') continue;

    if (line.startsWith(' ;') || line.startsWith('\t;')) {
      // Comment line for the previous label
      if (current) {
        const commentText = line.replace(/^[ \t];/, '').trim();
        current.comment = current.comment ? `${current.comment} ${commentText}` : commentText;
      }
      continue;
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
      // Flush previous label
      if (current) labels.push(current);

      const labelId = line.substring(0, eqIdx).trim();
      const text = line.substring(eqIdx + 1);

      // Skip empty or obviously malformed ids
      if (!labelId || /\s/.test(labelId)) {
        current = null;
        continue;
      }

      current = { labelId, text, comment: undefined, labelFileId, model, language, filePath };
    }
    // Any other line (continuation) — ignore; D365FO labels are single-line
  }

  if (current) labels.push(current);
  return labels;
}

/**
 * Discover all AxLabelFile resources for a model.
 * Returns an array of { labelFileId, language, filePath }.
 */
export async function discoverLabelFiles(
  modelDir: string,  // e.g. K:\AosService\PackagesLocalDirectory\MyPackage\MyModel
): Promise<Array<{ labelFileId: string; language: string; filePath: string }>> {
  const results: Array<{ labelFileId: string; language: string; filePath: string }> = [];

  // Directory casing varies: Windows uses AxLabelFile/LabelResources, Linux unzip may lowercase either segment.
  let axLabelDir = path.join(modelDir, 'AxLabelFile', 'LabelResources');
  if (!fsSync.existsSync(axLabelDir)) {
    axLabelDir = path.join(modelDir, 'axlabelfile', 'LabelResources');
    if (!fsSync.existsSync(axLabelDir)) {
      axLabelDir = path.join(modelDir, 'axlabelfile', 'labelresources');
    }
  }

  // Restrict indexing to configured languages to keep the label table small; LABEL_LANGUAGES=all indexes everything.
  const langConfig = process.env.LABEL_LANGUAGES || 'en-US,cs,sk,de';
  const SUPPORTED_LANGUAGES = langConfig.toLowerCase() === 'all'
    ? null  // null = index all languages
    : new Set(langConfig.split(',').map(l => l.trim()));

  let locales: string[];
  try {
    locales = await fs.readdir(axLabelDir);
  } catch {
    return results; // No AxLabelFile folder
  }

  for (const locale of locales) {
    // Locale directory names may be lowercased on Linux, so compare case-insensitively.
    if (SUPPORTED_LANGUAGES) {
      const normalizedLocale = locale.toLowerCase();
      const isSupported = Array.from(SUPPORTED_LANGUAGES).some(
        supported => supported.toLowerCase() === normalizedLocale
      );
      if (!isSupported) {
        continue;
      }
    }
    
    const localeDir = path.join(axLabelDir, locale);
    let files: string[];
    try {
      files = await fs.readdir(localeDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.label.txt')) continue;
      // Filename pattern: {LabelFileId}.{locale}.label.txt
      const withoutSuffix = file.replace(/\.label\.txt$/, '');
      const dotIdx = withoutSuffix.lastIndexOf('.');
      if (dotIdx < 0) continue;
      const labelFileId = withoutSuffix.substring(0, dotIdx);
      const fileLang = withoutSuffix.substring(dotIdx + 1);

      if (fileLang.toLowerCase() !== locale.toLowerCase()) continue;

      results.push({
        labelFileId,
        // Normalize to BCP-47 canonical casing (e.g. 'en-us' -> 'en-US').
        language: locale.split('-').map((part, i) => i === 0 ? part.toLowerCase() : part.toUpperCase()).join('-'),
        filePath: path.join(localeDir, file),
      });
    }
  }

  return results;
}

/**
 * Index all label files for a single model into the symbol index.
 * Returns the number of label entries inserted.
 *
 * Pass `{ skipFtsRebuild: true }` when calling in a loop over many models;
 * the caller is responsible for calling `symbolIndex.rebuildLabelsFts()` once
 * after all models have been indexed.
 */
export async function indexModelLabels(
  symbolIndex: XppSymbolIndex,
  modelDir: string,
  model: string,
  opts?: { skipFtsRebuild?: boolean; keepTriggers?: boolean },
): Promise<number> {
  const labelFiles = await discoverLabelFiles(modelDir);
  if (labelFiles.length === 0) return 0;

  const allEntries: Parameters<XppSymbolIndex['bulkAddLabels']>[0] = [];

  for (const { labelFileId, language, filePath } of labelFiles) {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    const labels = parseLabelFile(content, labelFileId, model, language, filePath);
    for (const lbl of labels) {
      allEntries.push({
        labelId: lbl.labelId,
        labelFileId: lbl.labelFileId,
        model: lbl.model,
        language: lbl.language,
        text: lbl.text,
        comment: lbl.comment,
        filePath: lbl.filePath,
      });
    }
  }

  if (allEntries.length > 0) {
    symbolIndex.bulkAddLabels(allEntries, opts);
  }

  return allEntries.length;
}

/**
 * Index ALL labels from PackagesLocalDirectory into the symbol index.
 * Scans all model folders.
 */
export async function indexAllLabels(
  symbolIndex: XppSymbolIndex,
  packagesPath: string,
  modelFilter?: (modelName: string) => boolean,
  opts?: { ftsStrategy?: 'rebuild' | 'incremental' },
): Promise<{ totalLabels: number; modelsIndexed: number }> {
  // 'incremental' keeps the labels_fts triggers live so only the scanned models' labels are
  // tokenised, instead of re-inserting every en-US label in the database afterwards. Only
  // worth it when modelFilter narrows the scan to a small set (a custom-model build).
  const incrementalFts = opts?.ftsStrategy === 'incremental';
  let totalLabels = 0;
  let modelsIndexed = 0;

  let models: string[];
  try {
    const entries = fsSync.readdirSync(packagesPath, { withFileTypes: true });
    // Model folders are often NTFS junction points, reported as isSymbolicLink() not isDirectory().
    models = entries.filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name);
  } catch {
    console.error(`[LabelParser] Cannot read packages path: ${packagesPath}`);
    return { totalLabels, modelsIndexed };
  }

  let skippedByFilter = 0;
  let skippedMissingDir = 0;
  let skippedNoLabels = 0;

  for (const packageOrModel of models) {
    const packageDir = path.join(packagesPath, packageOrModel);

    // A package dir can contain multiple model subdirectories, each with its own AxLabelFile.
    const modelDirs: { modelDir: string; modelName: string }[] = [];

    try {
      const subDirs = fsSync.readdirSync(packageDir, { withFileTypes: true })
        .filter(e => e.isDirectory() || e.isSymbolicLink())
        .map(e => e.name)
        .filter(n => n !== 'Descriptor' && n !== 'bin' && !n.startsWith('.'));

      for (const subDir of subDirs) {
        const candidateDir = path.join(packageDir, subDir);
        const axLabelDirOriginal = path.join(candidateDir, 'AxLabelFile');
        const axLabelDirLower = path.join(candidateDir, 'axlabelfile');
        if (fsSync.existsSync(axLabelDirOriginal) || fsSync.existsSync(axLabelDirLower)) {
          modelDirs.push({ modelDir: candidateDir, modelName: subDir });
        }
      }
    } catch {
      // Directory not readable
    }

    // Fallback: flat structure where AxLabelFile sits directly under the package dir.
    if (modelDirs.length === 0) {
      const flatAxLabel = path.join(packageDir, 'AxLabelFile');
      const flatAxLabelLower = path.join(packageDir, 'axlabelfile');
      if (fsSync.existsSync(flatAxLabel) || fsSync.existsSync(flatAxLabelLower)) {
        modelDirs.push({ modelDir: packageDir, modelName: packageOrModel });
      }
    }

    if (modelDirs.length === 0) {
      skippedMissingDir++;
      continue;
    }

    for (const { modelDir, modelName } of modelDirs) {
      // Keyed on the resolved MODEL name (e.g. "Docentric AX"), not the top-level PACKAGE
      // folder name (e.g. "DocentricAX") — the two can differ, and clearLabelsForModels()
      // deletes by the same model name, so filtering here on anything else silently drops
      // that model's labels on every subsequent incremental build (#802).
      if (modelFilter && !modelFilter(modelName)) {
        skippedByFilter++;
        continue;
      }

      const count = await indexModelLabels(symbolIndex, modelDir, modelName, {
        skipFtsRebuild: true,
        keepTriggers: incrementalFts,
      });
      if (count > 0) {
        totalLabels += count;
        modelsIndexed++;
      } else {
        skippedNoLabels++;
      }
    }
  }

  // Rebuild FTS once for all models rather than per-model (avoids O(n^2) rebuild cost).
  // Skipped under 'incremental': the triggers already kept labels_fts in sync per row.
  if (totalLabels > 0 && !incrementalFts) {
    symbolIndex.rebuildLabelsFts();
  }

  if (modelsIndexed === 0) {
    console.log(`   ℹ️  No labels indexed:`);
    console.log(`      - Models skipped by filter: ${skippedByFilter}`);
    console.log(`      - Models with missing directory: ${skippedMissingDir}`);
    console.log(`      - Models with no labels: ${skippedNoLabels}`);
    console.log(`      - Total models found: ${models.length}`);
  }

  return { totalLabels, modelsIndexed };
}
