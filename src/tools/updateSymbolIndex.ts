import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { XppMetadataParser } from '../metadata/xmlParser.js';
import type { XppServerContext } from '../types/context.js';
import type { XppSymbol } from '../metadata/types.js';
import { bridgeRefreshProvider } from '../bridge/index.js';

export const updateSymbolIndexToolDefinition = {
  name: 'update_symbol_index',
  description:
    'Index a newly generated or modified D365FO XML file immediately so references to it work without restarting the server. ' +
    'Also handles file DELETIONS: if the file no longer exists on disk, stale symbols + labels + Redis cache entries are cleaned up.',
  parameters: z.object({
    filePath: z.string().describe('The absolute path to the modified, created, or DELETED XML file')
  })
};

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
  return null;
}

export const updateSymbolIndexTool = async (params: any, context: XppServerContext) => {
  const { filePath } = params;
  try {
    const { symbolIndex, cache } = context;
    const objectName = path.parse(filePath).name;
    const parts = filePath.replace(/\//g, '\\').split('\\');
    const aotFolder = parts.find((p: string) => p.toLowerCase() in AOT_FOLDER_TYPE_MAP) ?? '';
    const objectType: XppSymbol['type'] = AOT_FOLDER_TYPE_MAP[aotFolder.toLowerCase()] ?? 'class';

    // ── FILE DELETED: clean up stale index entries ──────────────────────────
    if (!fs.existsSync(filePath)) {
      console.error(`[update_symbol_index] File deleted — cleaning up stale entries for "${objectName}"`);

      // 1. Remove symbols from SQLite (returns names for cache invalidation)
      const { deletedCount, objectNames } = symbolIndex.removeSymbolsByFile(filePath);

      // 2. Remove labels from labels DB (label files live alongside XML)
      const labelCount = symbolIndex.removeLabelsByFile(filePath);

      // 3. Invalidate Redis cache for affected objects
      await invalidateCache(cache, objectName, objectType, objectNames);

      // 4. Refresh bridge so it no longer sees the deleted file
      try {
        await bridgeRefreshProvider(context.bridge);
      } catch { /* bridge not available */ }

      const parts_cleaned: string[] = [];
      if (deletedCount > 0) parts_cleaned.push(`${deletedCount} symbol(s)`);
      if (labelCount > 0) parts_cleaned.push(`${labelCount} label(s)`);
      const summary = parts_cleaned.length > 0 ? parts_cleaned.join(' + ') : 'no stale entries found';

      return {
        content: [{
          type: 'text',
          text: `🗑️ File deleted — cleaned up ${summary} for **${objectName}** (${objectType}).\n` +
            `Redis cache invalidated. Bridge refreshed.`
        }]
      };
    }

    // ── FILE EXISTS: re-index ───────────────────────────────────────────────
    const parser = new XppMetadataParser();
    const model = extractModelFromPath(filePath) ?? 'Unknown';

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

    // ── Invalidate Redis cache for the re-indexed object ────────────────────
    await invalidateCache(cache, objectName, objectType, [objectName]);

    return {
      content: [{
        type: 'text',
        text: `✅ Symbol index updated for **${objectName}** (${objectType}, model: ${model}).\n\n` +
          `Removed: ${deletedCount} stale entr${deletedCount === 1 ? 'y' : 'ies'}\n` +
          `Inserted: ${insertedCount} symbol${insertedCount !== 1 ? 's' : ''}\n` +
          `Redis cache invalidated.`
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

// ── Shared cache invalidation helper ───────────────────────────────────────

/**
 * Invalidate Redis cache entries that might reference the given object.
 * Clears:
 * - Direct class/table key (xpp:class:Name, xpp:table:Name)
 * - Method signature keys (xpp:method-sig:Name:*)
 * - Search results that might include the object (xpp:search:*)
 * - Code completion cache (xpp:complete:Name:*)
 */
async function invalidateCache(
  cache: XppServerContext['cache'],
  primaryName: string,
  _objectType: string,
  allObjectNames: string[],
): Promise<void> {
  try {
    // Direct object keys
    for (const name of allObjectNames) {
      await cache.delete(cache.generateClassKey(name));
      await cache.delete(cache.generateTableKey(name));
    }
    // Method signature cache (pattern: xpp:method-sig:ClassName:*)
    await cache.deletePattern(`xpp:method-sig:${primaryName}:*`);
    // Code completion cache
    await cache.deletePattern(`xpp:complete:${primaryName}:*`);
    // Search results are impossible to selectively invalidate (query-based keys),
    // so we clear all search cache. This is fast and search TTL is only 30 min anyway.
    await cache.deletePattern('xpp:search:*');
  } catch (e) {
    // Redis not available — silently ignore
    console.error(`[update_symbol_index] Redis cache invalidation failed (non-fatal): ${e}`);
  }
}
