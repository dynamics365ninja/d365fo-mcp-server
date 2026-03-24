/**
 * X++ Table Information Tool
 * Get detailed information about an X++ table including fields, indexes, and relations.
 *
 * PRIMARY: C# bridge (IMetadataProvider) — 100% reliable, always available on VM.
 * FALLBACK: Only for newly created tables not yet indexed, uses disk scan.
 */

import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { findD365FileOnDisk } from './modifyD365File.js';
import { tryBridgeTable } from '../bridge/bridgeAdapter.js';

const TableInfoArgsSchema = z.object({
  tableName: z.string().describe('Name of the X++ table'),
  methodOffset: z.number().optional().default(0).describe('Offset for paginating methods (use multiples of 25)'),
});

export async function tableInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = TableInfoArgsSchema.parse(request.params.arguments);
    const { cache } = context;

    // Check cache first
    const cacheKey = cache.generateTableKey(args.tableName);
    const cachedTable = await cache.get<any>(cacheKey);

    if (cachedTable) {
      const fields = cachedTable.fields
        .map((f: any) => {
          const typeInfo = f.extendedDataType
            ? `EDT: ${f.extendedDataType}${f.type ? ` (base: ${f.type})` : ''}`
            : f.type;
          return `  ${f.name}: ${typeInfo}${f.isMandatory ? ' (mandatory)' : ''}${f.label ? ` - ${f.label}` : ''}`;
        })
        .join('\n');

      const extendsInfo = cachedTable.extendsTable ? `\nExtends: ${cachedTable.extendsTable}` : '';
      const labelInfo = cachedTable.label ? `\nLabel: ${cachedTable.label}` : '';

      return {
        content: [{
          type: 'text',
          text: `Table: ${cachedTable.name}${labelInfo}${extendsInfo}\n\nFields:\n${fields} (cached)`,
        }],
      };
    }

    // C# bridge (IMetadataProvider — live D365FO metadata, always available)
    const bridgeResult = await tryBridgeTable(context.bridge, args.tableName, args.methodOffset);
    if (bridgeResult) {
      await cache.setClassInfo(cacheKey, bridgeResult).catch(() => {});
      return bridgeResult;
    }

    // Fallback: table may have just been created and bridge hasn't refreshed yet
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
        out += `## Fields (${table.fields.length})\n\n`;
        for (const field of table.fields) {
          const required = field.mandatory ? ' **(required)**' : '';
          const label = field.label ? ` - ${field.label}` : '';
          const typeInfo = field.extendedDataType
            ? `EDT: ${field.extendedDataType} (base: ${field.type})`
            : `Type: ${field.type}`;
          out += `- **${field.name}**: ${typeInfo}${required}${label}\n`;
        }
        return { content: [{ type: 'text', text: out }] };
      }
    }

    return {
      content: [{
        type: 'text',
        text: `Table "${args.tableName}" not found via bridge or on disk.\n\nIf this is a newly created table, ensure .mcp.json has the correct modelName/projectPath so the server can locate it.`,
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
