/**
 * Table Extension Info Tool
 * Retrieve all extensions for a D365FO table, with effective schema merging.
 *
 * Data sources (in priority order):
 *  1. extension_metadata table in SQLite — rich data (fields, methods, CoC, events)
 *  2. symbols table — lightweight fallback when extension_metadata is empty
 *  3. Filesystem scan of AxTableExtension XML files — final fallback for custom models
 *     that haven't been re-indexed yet. Eliminates the need for the AI to run PowerShell.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { getConfigManager } from '../utils/configManager.js';
import { scanFsExtensions } from '../utils/fsExtensionScanner.js';
import { tryBridgeTableExtensions } from '../bridge/index.js';

const TableExtensionInfoArgsSchema = z.object({
  tableName: z.string().describe('Base table name whose extensions to find'),
  includeEffectiveSchema: z.boolean().optional().default(true)
    .describe('Merge base table fields with all extension fields to show the effective full schema'),
});

export async function tableExtensionInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = TableExtensionInfoArgsSchema.parse(request.params.arguments);

    // ── Bridge fast-path (C# IMetadataProvider) ──
    const bridgeResult = await tryBridgeTableExtensions(context.bridge, args.tableName);
    if (bridgeResult) return bridgeResult;

    // ── Fallback: SQLite index + filesystem ──
    const db = context.symbolIndex.db;
    const tableName = args.tableName;

    // Verify the base table exists
    const baseTable = db.prepare(
      `SELECT name, model, file_path FROM symbols WHERE name = ? AND type = 'table' LIMIT 1`
    ).get(tableName) as any;

    let output = `Table Extensions of: ${tableName}\n`;
    if (baseTable) {
      output += `Base Model: ${baseTable.model}\n`;
    }
    output += '\n';

    // Query extension_metadata for table extensions
    let extensionRows: any[] = [];
    try {
      extensionRows = db.prepare(
        `SELECT extension_name, model, added_fields, added_indexes, added_methods, coc_methods, event_subscriptions
         FROM extension_metadata
         WHERE base_object_name = ? AND extension_type = 'table-extension'
         ORDER BY model, extension_name`
      ).all(tableName) as any[];
    } catch (e) {
      // extension_metadata table may not exist in older databases — non-fatal
      if (process.env.DEBUG_LOGGING === 'true') console.warn('[tableExtensionInfo] extension_metadata query failed:', e);
    }

    // Fallback: symbols with extends_class pointing to the table
    const symbolExts = db.prepare(
      `SELECT name, model FROM symbols
       WHERE type = 'table-extension' AND (extends_class = ? OR name LIKE ?)
       ORDER BY model, name`
    ).all(tableName, `${tableName}.%`) as any[];

    const seen = new Set<string>();
    const allExtensions: Array<{
      name: string; model: string;
      addedFields: string[]; addedIndexes: string[]; addedMethods: string[]; cocMethods: string[]; eventSubs: string[];
    }> = [];

    for (const row of extensionRows) {
      if (!seen.has(row.extension_name)) {
        seen.add(row.extension_name);
        let addedFields: string[] = [];
        let addedIndexes: string[] = [];
        let addedMethods: string[] = [];
        let cocMethods: string[] = [];
        let eventSubs: string[] = [];
        try { addedFields = JSON.parse(row.added_fields || '[]'); } catch { /**/ }
        try { addedIndexes = JSON.parse(row.added_indexes || '[]'); } catch { /**/ }
        try { addedMethods = JSON.parse(row.added_methods || '[]'); } catch { /**/ }
        try { cocMethods = JSON.parse(row.coc_methods || '[]'); } catch { /**/ }
        try { eventSubs = JSON.parse(row.event_subscriptions || '[]'); } catch { /**/ }
        allExtensions.push({ name: row.extension_name, model: row.model, addedFields, addedIndexes, addedMethods, cocMethods, eventSubs });
      }
    }

    for (const row of symbolExts) {
      if (!seen.has(row.name)) {
        seen.add(row.name);
        allExtensions.push({ name: row.name, model: row.model, addedFields: [], addedIndexes: [], addedMethods: [], cocMethods: [], eventSubs: [] });
      }
    }

    if (allExtensions.length === 0) {
      output += `No table extensions found in index.\n`;

      // ── Filesystem fallback ─────────────────────────────────────────────
      // When the DB has no data (custom model not yet re-indexed), scan the
      // AxTableExtension folders directly — avoids the AI running PowerShell.
      if (process.platform === 'win32') {
        const configManager = getConfigManager();
        const packagePath = configManager.getPackagePath();
        if (packagePath) {
          output += `Scanning filesystem for unindexed extensions (${packagePath})…\n`;
          const fsExts = await scanFsExtensions(tableName, 'table-extension', packagePath);
          if (fsExts.length > 0) {
            output += `\nFound ${fsExts.length} extension(s) on disk (not yet in index):\n\n`;
            for (let i = 0; i < fsExts.length; i++) {
              const ext = fsExts[i];
              output += `[${i + 1}] ${ext.name} (${ext.model})\n`;
              output += `    File: ${ext.filePath}\n`;
              if (ext.addedFields.length > 0) {
                output += `    Added Fields (${ext.addedFields.length}): ${ext.addedFields.join(', ')}\n`;
              }
              if (ext.addedIndexes.length > 0) {
                output += `    Added Indexes (${ext.addedIndexes.length}): ${ext.addedIndexes.join(', ')}\n`;
              }
              if (ext.cocMethods.length > 0) {
                output += `    Wraps Methods (CoC) (${ext.cocMethods.length}): ${ext.cocMethods.join(', ')}\n`;
              }
              const newMethods = ext.addedMethods.filter(m => !ext.cocMethods.some(c => c.toLowerCase() === m.toLowerCase()));
              if (newMethods.length > 0) {
                output += `    Added Methods (${newMethods.length}): ${newMethods.join(', ')}\n`;
              }
            }
            output += `\n⚠️ Data sourced from disk — run extract-metadata + build-database to persist to index.\n`;
          } else {
            output += `No AxTableExtension files found on disk for "${tableName}" either.\n`;
          }
        }
      } else {
        output += `Tip: Run extract-metadata and build-database to index table extensions.\n`;
      }
    } else {
      for (let i = 0; i < allExtensions.length; i++) {
        const ext = allExtensions[i];
        output += `[${i + 1}] ${ext.name} (${ext.model})\n`;

        if (ext.addedFields.length > 0) {
          output += `    Added Fields (${ext.addedFields.length}): ${ext.addedFields.join(', ')}\n`;
        }
        if (ext.addedIndexes.length > 0) {
          output += `    Added Indexes (${ext.addedIndexes.length}): ${ext.addedIndexes.join(', ')}\n`;
        }
        if (ext.cocMethods.length > 0) {
          output += `    Wraps Methods (CoC) (${ext.cocMethods.length}): ${ext.cocMethods.join(', ')}\n`;
        }
        const newMethods = ext.addedMethods.filter(m => !ext.cocMethods.some(c => c.toLowerCase() === m.toLowerCase()));
        if (newMethods.length > 0) {
          output += `    Added Methods (${newMethods.length}): ${newMethods.slice(0, 5).join(', ')}${newMethods.length > 5 ? ` (+${newMethods.length - 5} more)` : ''}\n`;
        }
        if (ext.eventSubs.length > 0) {
          output += `    Event Subscriptions (${ext.eventSubs.length}): ${ext.eventSubs.slice(0, 3).join(', ')}${ext.eventSubs.length > 3 ? '...' : ''}\n`;
        }
      }
    }

    // Effective schema summary
    if (args.includeEffectiveSchema) {
      output += '\nEffective Schema:\n';

      // Base fields
      const baseFields = db.prepare(
        `SELECT name FROM symbols WHERE parent_name = ? AND type = 'field' ORDER BY name`
      ).all(tableName) as any[];

      const totalExtFields = allExtensions.reduce((sum, e) => sum + e.addedFields.length, 0);
      const totalExtIndexes = allExtensions.reduce((sum, e) => sum + e.addedIndexes.length, 0);

      output += `  Total fields: ${baseFields.length + totalExtFields}`;
      if (totalExtFields > 0) output += ` (base: ${baseFields.length}, extensions: ${totalExtFields})`;
      output += '\n';

      // Base indexes
      const baseIndexes = db.prepare(
        `SELECT COUNT(*) as cnt FROM symbols WHERE parent_name = ? AND type = 'index'`
      ).get(tableName) as any;
      const baseIndexCount = baseIndexes?.cnt ?? 0;

      output += `  Total indexes: ${baseIndexCount + totalExtIndexes}`;
      if (totalExtIndexes > 0) output += ` (base: ${baseIndexCount}, extensions: ${totalExtIndexes})`;
      output += '\n';

      if (allExtensions.length > 0) {
        output += `  Extensions from models: ${[...new Set(allExtensions.map(e => e.model))].join(', ')}\n`;
      }
    }

    return { content: [{ type: 'text', text: output }] };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting table extension info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
