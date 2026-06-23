import fs from 'fs';
import path from 'path';
import { XppMetadataParser } from '../metadata/xmlParser.js';
import { parseLabelFile } from '../metadata/labelParser.js';
import type { XppServerContext } from '../types/context.js';
import type { XppSymbol } from '../metadata/types.js';
import { bridgeRefreshProvider } from '../bridge/index.js';

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.

/** Map AOT folder names to symbol types */
const AOT_FOLDER_TYPE_MAP: Record<string, XppSymbol['type']> = {
  'axclass': 'class',
  'axtable': 'table',
  'axtableextension': 'table-extension',
  'axform': 'form',
  'axformextension': 'form-extension',
  'axenum': 'enum',
  'axenumsextension': 'enum-extension',
  'axedt': 'edt',
  'axedtsextension': 'edt-extension',
  'axquery': 'query',
  'axview': 'view',
  'axreport': 'report',
  'axsecurityprivilege': 'security-privilege',
  'axsecurityduty': 'security-duty',
  'axsecurityrole': 'security-role',
  'axmenuitemaction': 'menu-item-action',
  'axmenuitemdisplay': 'menu-item-display',
  'axmenuitemoutput': 'menu-item-output',
};

/**
 * Extract model name from AOT file path.
 * Pattern: {packagesRoot}\{package}\{model}\Ax{Type}\{Name}.xml
 * or:      {packagesRoot}\{model}\{model}\Ax{Type}\{Name}.xml
 */
function extractModelFromPath(filePath: string): string | null {
  const parts = filePath.replace(/\//g, '\\').split('\\');
  // Find the AOT folder index (e.g. AxClass, AxTable)
  const aotIdx = parts.findIndex(p => p.toLowerCase() in AOT_FOLDER_TYPE_MAP);
  if (aotIdx >= 2) {
    return parts[aotIdx - 1]; // folder immediately before the AOT folder = model name
  }

  // Label file path pattern: ...\{model}\AxLabelFile\LabelResources\{locale}\{LabelFileId}.{locale}.label.txt
  const labelIdx = parts.findIndex(p => p.toLowerCase() === 'axlabelfile');
  if (labelIdx >= 1) {
    return parts[labelIdx - 1];
  }

  return null;
}

function isLabelTextFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.label.txt');
}

function normalizeLocale(locale: string): string {
  return locale
    .split('-')
    .map((part, idx) => (idx === 0 ? part.toLowerCase() : part.toUpperCase()))
    .join('-');
}

function parseLabelFileName(filePath: string): { labelFileId: string; language: string } | null {
  const parts = filePath.split(/[\\/]/);
  const baseName = parts[parts.length - 1] ?? '';
  const withoutSuffix = baseName.replace(/\.label\.txt$/i, '');
  const dotIdx = withoutSuffix.lastIndexOf('.');
  if (dotIdx < 0) return null;

  const labelFileId = withoutSuffix.substring(0, dotIdx);
  const language = withoutSuffix.substring(dotIdx + 1);
  if (!labelFileId || !language) return null;

  return {
    labelFileId,
    language: normalizeLocale(language),
  };
}

export const updateSymbolIndexTool = async (params: any, context: XppServerContext) => {
  const { filePath } = params;
  try {
    const { symbolIndex } = context;
    // A file just changed on disk — drop the workspace scan cache so the
    // context pipeline (recently-edited / active object) reflects it at once.
    context.workspaceScanner?.invalidate?.();
    const pathParts = filePath.split(/[\\/]/);
    const fileName = pathParts[pathParts.length - 1] ?? filePath;
    const objectName = fileName.replace(/\.[^.]+$/, '');
    const parts = filePath.replace(/\//g, '\\').split('\\');
    const aotFolder = parts.find((p: string) => p.toLowerCase() in AOT_FOLDER_TYPE_MAP) ?? '';
    const objectType: XppSymbol['type'] = AOT_FOLDER_TYPE_MAP[aotFolder.toLowerCase()] ?? 'class';

    // ── FILE DELETED: clean up stale index entries ──────────────────────────
    if (!fs.existsSync(filePath)) {
      console.error(`[update_symbol_index] File deleted — cleaning up stale entries for "${objectName}"`);

      // 1. Remove symbols from SQLite
      const { deletedCount } = symbolIndex.removeSymbolsByFile(filePath);

      // 2. Remove labels from labels DB (label files live alongside XML)
      const labelCount = symbolIndex.removeLabelsByFile(filePath);

      // 3. Refresh bridge so it no longer sees the deleted file
      try {
        await bridgeRefreshProvider(context.bridge);
      } catch { /* bridge not available */ }

      symbolIndex.touchLastIndexed?.();

      const parts_cleaned: string[] = [];
      if (deletedCount > 0) parts_cleaned.push(`${deletedCount} symbol(s)`);
      if (labelCount > 0) parts_cleaned.push(`${labelCount} label(s)`);
      const summary = parts_cleaned.length > 0 ? parts_cleaned.join(' + ') : 'no stale entries found';

      return {
        content: [{
          type: 'text',
          text: `🗑️ File deleted — cleaned up ${summary} for **${objectName}** (${objectType}).\n` +
            `Bridge refreshed.`
        }]
      };
    }

    // ── FILE EXISTS: re-index ───────────────────────────────────────────────
    const model = extractModelFromPath(filePath) ?? 'Unknown';

    // Label files are indexed in labels DB (not symbols DB).
    if (isLabelTextFile(filePath)) {
      const parsedFileName = parseLabelFileName(filePath);
      if (!parsedFileName) {
        return {
          content: [{
            type: 'text',
            text: `❌ Error updating label index: invalid label filename format for ${path.basename(filePath)} (expected {LabelFileId}.{locale}.label.txt).`,
          }],
          isError: true,
        };
      }

      const { labelFileId, language } = parsedFileName;
      const removedCount = symbolIndex.removeLabelsByFile(filePath);

      let insertedCount = 0;
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const labels = parseLabelFile(content, labelFileId, model, language, filePath);
        if (labels.length > 0) {
          symbolIndex.bulkAddLabels(labels.map(lbl => ({
            labelId: lbl.labelId,
            labelFileId: lbl.labelFileId,
            model: lbl.model,
            language: lbl.language,
            text: lbl.text,
            comment: lbl.comment,
            filePath: lbl.filePath,
          })));
          insertedCount = labels.length;
        }
      } catch (e: any) {
        return {
          content: [{ type: 'text', text: `❌ Error updating label index: ${e.message}` }],
          isError: true,
        };
      }

      symbolIndex.touchLastIndexed?.();

      return {
        content: [{
          type: 'text',
          text: `✅ Label index updated for **${path.basename(filePath)}** (model: ${model}, language: ${language}).\n\n` +
            `Removed: ${removedCount} stale entr${removedCount === 1 ? 'y' : 'ies'}\n` +
            `Inserted: ${insertedCount} label${insertedCount !== 1 ? 's' : ''}`,

        }],
      };
    }

    const parser = new XppMetadataParser();

    console.error(`[update_symbol_index] Re-indexing ${objectType} "${objectName}" (model: ${model})`);

    // 1. Remove all existing symbols for this file so stale entries don't linger
    const deleted = symbolIndex.db
      .prepare(`DELETE FROM symbols WHERE file_path = ?`)
      .run(filePath);
    const deletedCount = deleted.changes;

    // 1b. Refresh C# bridge metadata provider so it picks up the updated file
    try {
      const refreshResult = await bridgeRefreshProvider(context.bridge);
      if (refreshResult) {
        console.error(`[update_symbol_index] Bridge provider refreshed in ${refreshResult.elapsedMs}ms`);
      }
    } catch (e) {
      console.error(`[update_symbol_index] Bridge refresh skipped: ${e}`);
    }

    // 2. Re-parse the XML and insert fresh symbols
    let insertedCount = 0;
    const tx = symbolIndex.db.transaction(() => {
      // Minimal fallback for types not handled individually below
      symbolIndex.addSymbol({
        name: objectName,
        type: objectType,
        filePath,
        model,
      });
      insertedCount++;
    });

    // For classes and tables, parse XML to get methods/fields too
    if (objectType === 'class') {
      const result = await parser.parseClassFile(filePath, model);
      if (result.success && result.data) {
        const classData = result.data;
        const insert = symbolIndex.db.transaction(() => {
          symbolIndex.addSymbol({
            name: classData.name,
            type: 'class',
            signature: classData.extends ? `extends ${classData.extends}` : undefined,
            filePath,
            model,
            description: classData.documentation,
            extendsClass: classData.extends,
            implementsInterfaces: classData.implements?.join(', '),
          });
          insertedCount++;
          for (const method of classData.methods ?? []) {
            const params = method.parameters?.map((p: any) => `${p.type} ${p.name}`).join(', ') ?? '';
            symbolIndex.addSymbol({
              name: method.name,
              type: 'method',
              parentName: classData.name,
              signature: `${method.returnType} ${method.name}(${params})`,
              filePath,
              model,
              source: method.source,
            });
            insertedCount++;
          }
        });
        insert();
      } else {
        // Fallback: just index the object name
        tx();
      }
    } else if (objectType === 'table') {
      const result = await parser.parseTableFile(filePath, model);
      if (result.success && result.data) {
        const tableData = result.data;
        const insert = symbolIndex.db.transaction(() => {
          symbolIndex.addSymbol({
            name: tableData.name,
            type: 'table',
            filePath,
            model,
          });
          insertedCount++;
          for (const field of tableData.fields ?? []) {
            symbolIndex.addSymbol({
              name: field.name,
              type: 'field',
              parentName: tableData.name,
              signature: field.type,
              filePath,
              model,
            });
            insertedCount++;
          }
        });
        insert();
      } else {
        tx();
      }
    } else if (objectType === 'edt') {
      const result = await parser.parseEdtFile(filePath, model);
      if (result.success && result.data) {
        const edtData = result.data as any;
        symbolIndex.addSymbol({
          name: edtData.name ?? objectName,
          type: 'edt',
          signature: edtData.extends ?? undefined,
          filePath,
          model,
        });
        insertedCount++;
      } else {
        tx();
      }
    } else if (objectType === 'form' || objectType === 'form-extension') {
      const result = await parser.parseFormFile(filePath, model);
      if (result.success && result.data) {
        const formData = result.data as any;
        symbolIndex.addSymbol({
          name: formData.name ?? objectName,
          type: objectType,
          filePath,
          model,
        });
        insertedCount++;
      } else {
        tx();
      }
    } else {
      tx();
    }

    symbolIndex.touchLastIndexed?.();

    return {
      content: [{
        type: 'text',
        text: `✅ Symbol index updated for **${objectName}** (${objectType}, model: ${model}).\n\n` +
          `Removed: ${deletedCount} stale entr${deletedCount === 1 ? 'y' : 'ies'}\n` +
          `Inserted: ${insertedCount} symbol${insertedCount !== 1 ? 's' : ''}`
      }]
    };
  } catch (error: any) {
    console.error('Error updating symbol index:', error);
    return {
      content: [{ type: 'text', text: `❌ Error updating symbol index: ${error.message}` }],
      isError: true
    };
  }
};
