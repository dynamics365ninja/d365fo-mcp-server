/**
 * X++ Table Information Tool
 * Get detailed information about an X++ table including fields, indexes, and relations
 */

import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { findD365FileOnDisk } from './modifyD365File.js';
import { tryBridgeTable } from '../bridge/bridgeAdapter.js';

const METHOD_PAGE_SIZE = 25;

const TableInfoArgsSchema = z.object({
  tableName: z.string().describe('Name of the X++ table'),
  methodOffset: z.number().optional().default(0).describe('Offset for paginating methods (use multiples of 25)'),
});

export async function tableInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = TableInfoArgsSchema.parse(request.params.arguments);
    const { symbolIndex, parser, cache } = context;
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
        content: [
          {
            type: 'text',
            text: `Table: ${cachedTable.name}${labelInfo}${extendsInfo}\n\nFields:\n${fields} (cached)`,
          },
        ],
      };
    }

    // Try C# bridge first (IMetadataProvider — live D365FO metadata)
    const bridgeResult = await tryBridgeTable(context.bridge, args.tableName, args.methodOffset);
    if (bridgeResult) return bridgeResult;

    // Query database and parse
    const tableSymbol = symbolIndex.getSymbolByName(args.tableName, 'table');

    if (!tableSymbol) {
      // Table not yet indexed (e.g. just created by generate_smart_table / create_d365fo_file).
      // Try to locate the live XML file on disk via the package path.
      const diskPath = await findD365FileOnDisk('table', args.tableName);
      if (diskPath) {
        const model = path.basename(path.dirname(path.dirname(diskPath)));
        const diskInfo = await parser.parseTableFile(diskPath, model);
        if (diskInfo.success && diskInfo.data) {
          const table = diskInfo.data;
          let out = `# Table: ${table.name}\n\n`;
          out += `**Label:** ${table.label}\n`;
          out += `**Table Group:** ${table.tableGroup}\n`;
          out += `**Model:** ${model}\n`;
          out += `> ⚠️ _Not yet in symbol index — reading live file: ${diskPath}_\n\n`;
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
        content: [
          {
            type: 'text',
            text: `Table "${args.tableName}" not found in symbol index and could not be located on disk.\n\nIf this is a newly created table, ensure .mcp.json has the correct modelName/projectPath so the server can locate it.`,
          },
        ],
        isError: true,
      };
    }

    // Try to parse XML file if available, otherwise use database info
    const tableInfo = await parser.parseTableFile(tableSymbol.filePath, tableSymbol.model);

    if (!tableInfo.success || !tableInfo.data) {
      // Fallback to database information
      const fields = symbolIndex.getTableFields(args.tableName);
      
      let output = `# Table: ${args.tableName}\n\n`;
      output += `**Model:** ${tableSymbol.model}\n`;
      if (tableSymbol.signature) {
        output += `**Label:** ${tableSymbol.signature}\n`;
      }
      output += `**File:** ${tableSymbol.filePath}\n\n`;
      output += `_Note: Detailed XML metadata not available. Showing symbol index data._\n\n`;
      
      if (fields.length > 0) {
        output += `## Fields (${fields.length})\n\n`;
        for (const field of fields) {
          output += `- **${field.name}**`;
          if (field.signature) {
            output += `: ${field.signature}`;
          }
          output += `\n`;
        }
      } else {
        output += `No fields found in symbol index.\n`;
      }

      return {
        content: [
          {
            type: 'text',
            text: output,
          },
        ],
      };
    }

    const table = tableInfo.data;

    let output = `# Table: ${table.name}\n\n`;
    output += `**Label:** ${table.label}\n`;
    output += `**Table Group:** ${table.tableGroup}\n`;
    output += `**Model:** ${table.model}\n\n`;

    output += `## Fields (${table.fields.length})\n\n`;
    output += `_Field type is shown as explicit EDT when available._\n\n`;
    for (const field of table.fields) {
      const required = field.mandatory ? ' **(required)**' : '';
      const label = field.label ? ` - ${field.label}` : '';
      const typeInfo = field.extendedDataType
        ? `EDT: ${field.extendedDataType} (base: ${field.type})`
        : `Type: ${field.type}`;
      output += `- **${field.name}**: ${typeInfo}${required}${label}\n`;
    }

    output += `\n## Indexes (${table.indexes.length})\n\n`;
    for (const idx of table.indexes) {
      const unique = idx.unique ? ' **(unique)**' : '';
      output += `- **${idx.name}**: [${idx.fields.join(', ')}]${unique}\n`;
    }

    output += `\n## Relations (${table.relations.length})\n\n`;
    for (const rel of table.relations) {
      output += `- **${rel.name}** → ${rel.relatedTable}\n`;
      for (const constraint of rel.constraints) {
        output += `  - ${constraint.field} = ${constraint.relatedField}\n`;
      }
    }

    if (table.methods.length > 0) {
      const methodOffset = args.methodOffset ?? 0;
      const visibleMethods = table.methods.slice(methodOffset, methodOffset + METHOD_PAGE_SIZE);
      const totalMethods = table.methods.length;
      const hasMoreMethods = methodOffset + METHOD_PAGE_SIZE < totalMethods;

      output += `\n## Methods (${totalMethods} total`;
      if (totalMethods > METHOD_PAGE_SIZE) {
        output += `, showing ${methodOffset + 1}–${Math.min(methodOffset + METHOD_PAGE_SIZE, totalMethods)}`;
      }
      output += `)\n\n`;
      for (const method of visibleMethods) {
        const params = method.parameters.map((p: { type: string; name: string }) => `${p.type} ${p.name}`).join(', ');
        output += `### ${method.name}\n\n`;
        output += `- **Visibility:** ${method.visibility}\n`;
        output += `- **Returns:** ${method.returnType}\n`;
        output += `- **Static:** ${method.isStatic ? 'Yes' : 'No'}\n`;
        output += `- **Signature:** \`${method.returnType} ${method.name}(${params})\`\n\n`;

        if (method.documentation) {
          output += `**Documentation:**\n${method.documentation}\n\n`;
        }

        output += `\`\`\`xpp\n${method.source.substring(0, 500)}${method.source.length > 500 ? '...' : ''}\n\`\`\`\n\n`;
      }

      if (hasMoreMethods) {
        output += `> ⚠️ **${totalMethods - methodOffset - METHOD_PAGE_SIZE} more methods not shown.** Call again with \`methodOffset: ${methodOffset + METHOD_PAGE_SIZE}\` to see the next page.\n\n`;
      }
    }

    // Write to cache for 24 hours (normalize to shape expected by cache-hit path)
    await cache.setClassInfo(cacheKey, {
      name: table.name,
      label: table.label,
      extendsTable: null, // XppTableInfo does not carry inheritance info
      fields: table.fields.map((f: any) => ({
        name: f.name,
        type: f.type,
        extendedDataType: f.extendedDataType,
        isMandatory: f.mandatory,
        label: f.label,
      })),
    });

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting table info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
