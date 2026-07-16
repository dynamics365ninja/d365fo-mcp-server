/**
 * Get Map Info Tool
 * Reads an AxMap from the SQLite index: the X++ map class, its methods, and the
 * tables it maps onto (with field-connection counts). Azure-safe READ tool.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { lookupSymbolNocase } from '../utils/symbolLookup.js';

const GetMapInfoArgsSchema = z.object({
  mapName: z.string().describe('Name of the AxMap object (e.g. "LogMap")'),
});

export async function getMapInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const { mapName } = GetMapInfoArgsSchema.parse(request.params.arguments);
    const db = context.symbolIndex.getReadDb();

    // Case-insensitive by AOT semantics, index-safe by construction (#686).
    const symbol = lookupSymbolNocase(db, mapName, ['map']);

    if (!symbol) {
      return {
        content: [{ type: 'text', text: `Map "${mapName}" not found.\n\nTip: run extract-metadata + build-database to index AxMap objects, or check the name with search(type="map").` }],
        isError: true,
      };
    }

    // Side table is keyed by the canonical name — pass symbol.name.
    const mappings = db.prepare(
      `SELECT mapping_table, field_connections FROM map_mappings WHERE map_name = ? ORDER BY mapping_table`
    ).all(symbol.name) as { mapping_table: string; field_connections: number }[];

    const lines: string[] = [];
    lines.push(`# AxMap: \`${symbol.name}\``);
    lines.push('');
    lines.push(`**Model:** ${symbol.model}`);
    if (symbol.extends_class) lines.push(`**Extends:** \`${symbol.extends_class}\``);
    lines.push(`**File:** \`${symbol.file_path}\``);
    lines.push('');

    lines.push(`## Mapped tables (${mappings.length})`);
    lines.push('');
    if (mappings.length === 0) {
      lines.push('*(no table mappings indexed)*');
    } else {
      lines.push('| Table | Field connections |');
      lines.push('|-------|-------------------|');
      for (const m of mappings) {
        lines.push(`| \`${m.mapping_table}\` | ${m.field_connections} |`);
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error getting map info: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true,
    };
  }
}
