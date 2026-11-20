/**
 * Delete Label Tool
 *
 * Removes a label from an AxLabelFile:
 *  1. The label line and its comment line(s) (` ;comment` lines directly under it)
 *     in the .label.txt of EVERY language of the label file
 *  2. The label's rows in the MCP SQLite label index
 *
 * Safety: X++ sources and AOT XML of the model (plus optional `searchPaths`) are scanned
 * for `@LabelFileId:LabelId` first (covers `literalStr`, `labelStr` and XML properties).
 * Any reference refuses the delete unless `force=true`. `dryRun=true` writes nothing.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { XppServerContext } from '../../types/context.js';
import { writeFileAtomic } from '../../utils/atomicFileWrite.js';
import { getConfigManager } from '../../utils/configManager.js';
import { defaultPackagesRoot } from '../../utils/packagesRoot.js';
import { PackageResolver } from '../../utils/packageResolver.js';
import { detectEol } from '../../utils/eolUtils.js';
import { isExtensionLabelFile } from '../../metadata/labelParser.js';
import { parseLabelReference } from '../../utils/labelReference.js';
import { crossModelWriteRefusal, standDownNotice } from '../../utils/crossModelWriteGuard.js';
import { resolveAnchorModel } from './writeAnchorGuard.js';

const UTF8_BOM = '﻿';
const MAX_LISTED_REFERENCES = 20;

const DeleteLabelArgsSchema = z.object({
  labelId: z.string().min(1).describe('Label ID to delete, plain or as @File:Id (full-width ＠ also accepted).'),
  labelFileId: z.string().optional().describe('Label file ID that owns the label. Taken from an @File:Id labelId when omitted.'),
  model: z.string().describe('Model name that owns the label file.'),
  packageName: z.string().optional(),
  packagePath: z.string().optional(),
  searchPaths: z.array(z.string()).optional(),
  allowExtensionLabelFile: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
  updateIndex: z.boolean().optional().default(true),
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isCommentLine(line: string): boolean {
  return line.startsWith(' ;') || line.startsWith('\t;');
}

/** The label ID a .label.txt line declares, or null for a comment/blank/malformed line. */
function labelIdOfLine(line: string): string | null {
  if (isCommentLine(line)) return null;
  const eq = line.indexOf('=');
  if (eq <= 0) return null;
  const id = line.substring(0, eq).trim();
  return id && !/\s/.test(id) ? id : null;
}

/**
 * Remove a label and its comment lines from .label.txt content. Keeps BOM, line
 * endings and the order of every other line. Returns null when the label is absent.
 */
export function deleteLabelInTxt(
  content: string,
  labelId: string,
): { content: string; removedLines: string[] } | null {
  const eol = detectEol(content);
  const bom = content.startsWith(UTF8_BOM);
  const lines = (bom ? content.slice(1) : content).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  const removed: string[] = [];
  let found = false;
  let skippingComments = false;
  for (const line of lines) {
    if (labelIdOfLine(line) === labelId) {
      found = true;
      skippingComments = true;
      removed.push(line);
      continue;
    }
    if (skippingComments && isCommentLine(line)) {
      removed.push(line);
      continue;
    }
    skippingComments = false;
    out.push(line);
  }
  if (!found) return null;
  return { content: (bom ? UTF8_BOM : '') + out.join(eol), removedLines: removed };
}

async function collectFiles(dir: string, extensions: string[]): Promise<string[]> {
  const results: string[] = [];
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...(await collectFiles(full, extensions)));
    else if (extensions.some(ext => entry.name.endsWith(ext))) results.push(full);
  }
  return results;
}

export async function deleteLabelTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const raw = { ...(request.params.arguments ?? {}) } as Record<string, unknown>;
    // The full-width ＠ (U+FF20) is what search output and some clients paste.
    if (typeof raw.labelId === 'string') raw.labelId = raw.labelId.trim().replace(/^＠/, '@');
    const args = DeleteLabelArgsSchema.parse(raw);
    const { model, dryRun, force, updateIndex } = args;

    const ref = parseLabelReference(args.labelId);
    const labelId = ref.labelId;
    const labelFileId = args.labelFileId ?? ref.labelFileId;
    if (!labelFileId) {
      return {
        content: [{ type: 'text', text: '❌ labelFileId is required (or pass labelId as @LabelFile:LabelId).' }],
        isError: true,
      };
    }
    if (ref.labelFileId && args.labelFileId && ref.labelFileId !== args.labelFileId) {
      return {
        content: [{
          type: 'text',
          text: `❌ labelId names label file "${ref.labelFileId}" but labelFileId is "${args.labelFileId}". Pass one consistent label file.`,
        }],
        isError: true,
      };
    }

    if (isExtensionLabelFile(labelFileId) && !args.allowExtensionLabelFile) {
      return {
        content: [{
          type: 'text',
          text:
            `❌ "${labelFileId}" is a label file EXTENSION, not an original label file. ` +
            `Labels belong in the model's own original label file. ` +
            `If you really must delete from this extension, pass allowExtensionLabelFile=true.`,
        }],
        isError: true,
      };
    }

    const configManager = getConfigManager();
    const envType = await configManager.getDevEnvironmentType();
    let resolvedPackagePath: string;
    let resolvedPackageName: string;
    if (args.packageName) {
      resolvedPackageName = args.packageName;
      if (envType === 'ude') {
        const customPath = await configManager.getCustomPackagesPath();
        resolvedPackagePath = args.packagePath || customPath || configManager.getPackagePath() || defaultPackagesRoot();
      } else {
        resolvedPackagePath = args.packagePath || configManager.getPackagePath() || defaultPackagesRoot();
      }
    } else if (envType === 'ude') {
      const customPath = await configManager.getCustomPackagesPath();
      const msPath = await configManager.getMicrosoftPackagesPath();
      const roots = [customPath, msPath].filter(Boolean) as string[];
      resolvedPackagePath = args.packagePath || customPath || defaultPackagesRoot();
      const resolved = await new PackageResolver(roots).resolve(model);
      resolvedPackageName = resolved?.packageName || model;
      if (resolved?.rootPath) resolvedPackagePath = resolved.rootPath;
    } else {
      resolvedPackagePath = args.packagePath || configManager.getPackagePath() || defaultPackagesRoot();
      resolvedPackageName = model;
    }

    const labelRef = `@${labelFileId}:${labelId}`;

    // Same cross-model guard as rename/create; also applied to a dry run.
    const crossModelCheck = {
      objectName: labelRef,
      objectType: 'label',
      owningModel: model,
      owningPackage: resolvedPackageName,
      activeModel: await resolveAnchorModel(configManager),
      toolSwitchedModel: configManager.getToolProjectSwitch()?.forcedModel ?? null,
      action: 'modify' as const,
      dryRun,
    };
    const crossModelRefusal = crossModelWriteRefusal(crossModelCheck);
    if (crossModelRefusal) return { content: [{ type: 'text', text: crossModelRefusal }], isError: true };
    const crossModelNotice = standDownNotice(crossModelCheck);

    const modelDir = path.join(resolvedPackagePath, resolvedPackageName, model);
    const labelResourcesDir = path.join(modelDir, 'AxLabelFile', 'LabelResources');

    let languages: string[];
    try {
      languages = await fs.readdir(labelResourcesDir);
    } catch {
      return {
        content: [{
          type: 'text',
          text: `❌ AxLabelFile LabelResources directory not found:\n  ${labelResourcesDir}\n\nCheck that labelFileId, model and packagePath are correct.`,
        }],
        isError: true,
      };
    }

    // Compute every change before writing anything.
    const pending: Array<{ lang: string; file: string; content: string; removed: string[] }> = [];
    for (const lang of languages) {
      const file = path.join(labelResourcesDir, lang, `${labelFileId}.${lang}.label.txt`);
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch { continue; }
      const res = deleteLabelInTxt(content, labelId);
      if (res) pending.push({ lang, file, content: res.content, removed: res.removedLines });
    }

    if (pending.length === 0) {
      return {
        content: [{
          type: 'text',
          text:
            `ℹ️ Label "${labelRef}" not found in any .label.txt file of label file "${labelFileId}" in model "${model}". ` +
            `Nothing to delete. Use labels(action="search") or labels(action="info") to verify the label ID and label file.`,
        }],
        isError: true,
      };
    }

    // Reference scan: X++ and AOT XML (AxLabelFile descriptors excluded).
    const scanRoots = [modelDir, ...(args.searchPaths ?? [])];
    const unique = (files: string[]) => [...new Map(files.map(f => [path.resolve(f).toLowerCase(), f])).values()];
    const files = unique((await Promise.all(scanRoots.map(d => collectFiles(d, ['.xpp', '.xml'])))).flat())
      .filter(f => !f.includes('AxLabelFile'));
    const pattern = new RegExp(`@${escapeRegex(labelFileId)}:${escapeRegex(labelId)}(?![A-Za-z0-9_])`, 'g');
    const references: Array<{ file: string; count: number }> = [];
    for (const f of files) {
      let text: string;
      try {
        text = await fs.readFile(f, 'utf-8');
      } catch { continue; }
      const count = (text.match(pattern) ?? []).length;
      if (count > 0) references.push({ file: f, count });
    }
    const totalRefs = references.reduce((s, r) => s + r.count, 0);

    const referenceList = () =>
      references.slice(0, MAX_LISTED_REFERENCES).map(r => `  • ${r.file}  (${r.count}×)`).join('\n') +
      (references.length > MAX_LISTED_REFERENCES ? `\n  • … and ${references.length - MAX_LISTED_REFERENCES} more file(s)` : '');

    if (references.length > 0 && !force) {
      return {
        content: [{
          type: 'text',
          text:
            `⛔ Refusing to delete "${labelRef}" — it is still referenced ${totalRefs}× in ${references.length} file(s). ` +
            `Nothing was ${dryRun ? 'previewed' : 'written'}.\n\n${referenceList()}\n\n` +
            `Remove or replace those references first, or pass force=true to delete the label anyway ` +
            `(the references will then no longer resolve). Scanned: the model directory` +
            `${args.searchPaths?.length ? ' and searchPaths' : '; pass searchPaths to include other directories'}.`,
        }],
        isError: true,
      };
    }

    if (!dryRun) {
      for (const p of pending) await writeFileAtomic(p.file, p.content);
      if (updateIndex) context.symbolIndex.removeLabelFromIndex(labelId, labelFileId, model);
    }

    const lines: string[] = [];
    lines.push(dryRun ? `🔍 DRY RUN — no files were modified` : `✅ Label deleted: "${labelRef}"`);
    lines.push('');
    lines.push(`🏷️  .label.txt files (${pending.length}):`);
    for (const p of pending) {
      lines.push(`   ${dryRun ? '○' : '✔'} [${p.lang}] ${path.basename(p.file)} — ${dryRun ? 'would remove' : 'removed'}:`);
      for (const l of p.removed) lines.push(`        ${l}`);
    }
    if (references.length > 0) {
      lines.push('');
      lines.push(`⚠️  force=true: ${totalRefs} reference(s) in ${references.length} file(s) now point to a missing label:`);
      lines.push(referenceList());
    } else {
      lines.push('');
      lines.push(`ℹ️  No X++ or XML references to "${labelRef}" found in scanned directories.`);
    }
    if (!dryRun) lines.push('', '💡 Rebuild your D365FO project to verify no compile errors.');
    if (dryRun) lines.push('', '💡 Remove dryRun=true to apply the delete.');
    if (crossModelNotice) lines.push(crossModelNotice.trim());

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: `Error deleting label: ${err.message}` }],
      isError: true,
    };
  }
}
