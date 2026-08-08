/**
 * X++ Table Information Tool
 * Get detailed information about an X++ table including fields, indexes, and relations.
 *
 * PRIMARY: C# bridge (IMetadataProvider) — 100% reliable, always available on VM.
 * FALLBACK: Only for newly created tables not yet indexed, uses disk scan.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { findD365FileOnDisk } from './modifyD365File.js';
import { tryBridgeTable } from '../bridge/bridgeAdapter.js';
import { bridgeUnavailableNote } from '../utils/indexedXmlLookup.js';
import { pageFields, fieldsHeading, fieldsFooter, TABLE_FIELD_PAGE_SIZE } from '../utils/payloadBudget.js';

const TableInfoArgsSchema = z.object({
  tableName: z.string().describe('Name of the X++ table'),
  methodOffset: z.number().optional().default(0).describe('Offset for paginating methods (use multiples of 25)'),
  fieldsOffset: z.number().optional().default(0).describe(`Offset for paginating fields (use multiples of ${TABLE_FIELD_PAGE_SIZE})`),
  fieldFilter: z.string().optional().describe('Case-insensitive substring on the field name — cheaper than paging when you already know what you are looking for'),
});

export async function tableInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = TableInfoArgsSchema.parse(request.params.arguments);
    // Read-path priority: Bridge → DB (symbol index) → Disk (last resort).
    // 1. Bridge — live D365FO metadata, always up-to-date when available.
    const bridgeResult = await tryBridgeTable(
      context.bridge, args.tableName, args.methodOffset, args.fieldsOffset, args.fieldFilter,
    );
    if (bridgeResult) {
      return bridgeResult;
    }

    // 2. DB index fallback — serves offline / write-only / build-agent scenarios.
    const { symbolIndex } = context;
    const dbResponse = buildTableResponseFromDb(
      symbolIndex, args.tableName, args.methodOffset, args.fieldsOffset, args.fieldFilter,
    );
    if (dbResponse) {
      return dbResponse;
    }

    // 3. Disk fallback — slowest, only when bridge AND DB have no record
    //    (e.g. a brand-new table not yet indexed).
    const diskPath = await findD365FileOnDisk('table', args.tableName);
    if (diskPath) {
      const model = path.basename(path.dirname(path.dirname(diskPath)));
      const diskInfo = await context.parser.parseTableFile(diskPath, model);
      if (diskInfo.success && diskInfo.data) {
        const table = diskInfo.data;
        let out = `# Table: ${table.name}\n\n`;
        out += `**Label:** ${table.label}\n`;
        out += `**Table Group:** ${table.tableGroup}\n`;
        out += `**Model:** ${model}\n`;
        out += `> ⚠️ _Not yet in bridge metadata — reading live file: ${diskPath}_\n\n`;
        const diskPage = pageFields(table.fields, args.fieldsOffset, args.fieldFilter);
        out += `## ${fieldsHeading(diskPage)}\n\n`;
        for (const field of diskPage.visible) {
          const required = field.mandatory ? ' **(required)**' : '';
          const label = field.label ? ` - ${field.label}` : '';
          const typeInfo = field.extendedDataType
            ? `EDT: ${field.extendedDataType} (base: ${field.type})`
            : `Type: ${field.type}`;
          out += `- **${field.name}**: ${typeInfo}${required}${label}\n`;
        }
        out += fieldsFooter(diskPage);
        return { content: [{ type: 'text', text: out }] };
      }
    }

    // 4. Nothing anywhere. Say WHY before saying "not found": a bridge that is
    //    still starting (cold-start race) or absent means the object may exist
    //    and simply wasn't reachable — telling the agent to go fix .mcp.json is
    //    a diagnostic dead end in both cases (issue #826).
    return {
      content: [{
        type: 'text',
        text: `Table "${args.tableName}" not found via bridge, symbol index, or on disk.` +
          bridgeUnavailableNote(context) +
          `\nIf this is a newly created table, ensure .mcp.json has the correct modelName/projectPath so the server can locate it.`,
      }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error getting table info: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

/**
 * Serve table info entirely from the pre-indexed symbol database.
 * Returns null when the table is not present in the index; caller then falls through
 * to disk parsing.
 *
 * Regression (eval/corpus/runs/2026-07-06T17__L1-form-dialog__cb1b73d.json): the DB
 * index is a cache — it is not invalidated when an object is deleted/rolled back on
 * the VM outside a symbol-index rebuild. A prior run's rolled-back table kept
 * resolving here as if it still existed ("Served from symbol index"), and
 * generate_object(scaffold) trusted that phantom hit to bind a new form's
 * datasource, producing a form that references a table with no file on disk —
 * 4 build errors ("Table '<Name>' does not exist"). Guard against a stale row by
 * checking the indexed filePath actually still exists before trusting the hit;
 * a stale entry is treated the same as "not found" so the caller's disk-scan
 * fallback (or the final not-found error, which now hints at re-indexing) applies.
 */
function buildTableResponseFromDb(
  symbolIndex: any,
  tableName: string,
  methodOffset: number,
  fieldsOffset = 0,
  fieldFilter?: string,
): { content: { type: 'text'; text: string }[] } | null {
  const tableSym = symbolIndex.getSymbolByName?.(tableName, 'table');
  if (!tableSym) return null;
  if (tableSym.filePath && !fs.existsSync(tableSym.filePath)) {
    console.error(
      `[tableInfo] Stale symbol-index entry for table '${tableName}' — indexed file ` +
      `'${tableSym.filePath}' no longer exists on disk (likely rolled back/deleted since ` +
      `the index was built). Treating as not-found; run update_symbol_index to refresh.`,
    );
    return null;
  }

  const rdb = symbolIndex.getReadDb();
  const fields = rdb.prepare(
    `SELECT name, signature FROM symbols WHERE parent_name = ? AND type = 'field' ORDER BY name`
  ).all(tableName) as Array<{ name: string; signature: string | null }>;
  const methods = rdb.prepare(
    `SELECT name, signature FROM symbols WHERE parent_name = ? AND type = 'method' ORDER BY name`
  ).all(tableName) as Array<{ name: string; signature: string | null }>;

  const METHOD_PAGE = 25;
  const totalMethods = methods.length;
  const paged = methods.slice(methodOffset, methodOffset + METHOD_PAGE);
  const hasMore = methodOffset + METHOD_PAGE < totalMethods;

  let out = `# Table: ${tableSym.name}\n`;
  if (tableSym.model) out += `**Model:** ${tableSym.model}\n`;
  const fieldPage = pageFields(fields, fieldsOffset, fieldFilter);
  out += `\n## ${fieldsHeading(fieldPage)}\n\n`;
  for (const f of fieldPage.visible) {
    out += `- **${f.name}**${f.signature ? `: ${f.signature}` : ''}\n`;
  }
  out += fieldsFooter(fieldPage);
  out += `\n## Methods (${totalMethods} total${totalMethods > METHOD_PAGE ? `, showing ${methodOffset + 1}–${Math.min(methodOffset + METHOD_PAGE, totalMethods)}` : ''})\n\n`;
  for (const m of paged) {
    out += `- \`${m.signature || m.name}\`\n`;
  }
  if (hasMore) {
    out += `\n> ⚠️ ${totalMethods - methodOffset - METHOD_PAGE} more methods. Call again with methodOffset=${methodOffset + METHOD_PAGE}.`;
  }
  out += `\n\n> ℹ️ Served from symbol index (bridge unavailable).`;
  return { content: [{ type: 'text', text: out }] };
}
