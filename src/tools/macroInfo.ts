/**
 * Get Macro Info Tool
 * Reads an AxMacroDictionary (shared macro library) from the SQLite index and
 * lists its #define entries. Resolves the #define values that X++ code references
 * via #<Library>.<Name>, so the model does not have to open the macro XML.
 * Azure-safe READ tool.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { lookupSymbolNocase } from '../utils/symbolLookup.js';

const GetMacroInfoArgsSchema = z.object({
  macroName: z.string().describe('Name of the AxMacroDictionary (macro library, e.g. "AOT", "SysQuery")'),
  filter: z.string().optional().describe('Optional case-insensitive substring filter on define names'),
});

export async function getMacroInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const { macroName, filter } = GetMacroInfoArgsSchema.parse(request.params.arguments);
    const db = context.symbolIndex.getReadDb();

    // Case-insensitive by AOT semantics, index-safe by construction (#686):
    // exact-case probe first, FTS fallback only for a casing mismatch.
    const symbol = lookupSymbolNocase(db, macroName, ['macro']);

    if (!symbol) {
      return {
        content: [{ type: 'text', text: `Macro library "${macroName}" not found.\n\nTip: run extract-metadata + build-database to index AxMacroDictionary objects, or search(type="macro").` }],
        isError: true,
      };
    }

    // Side tables are keyed by the canonical name — pass symbol.name, not the
    // caller's casing, so this stays a BINARY hit.
    let defines = db.prepare(
      `SELECT define_name, define_value FROM macro_defines WHERE macro_name = ? ORDER BY define_name`
    ).all(symbol.name) as { define_name: string; define_value: string }[];

    if (filter) {
      const f = filter.toLowerCase();
      defines = defines.filter(d => d.define_name.toLowerCase().includes(f));
    }

    const lines: string[] = [];
    lines.push(`# AxMacroDictionary: \`${symbol.name}\``);
    lines.push('');
    lines.push(`**Model:** ${symbol.model}`);
    lines.push(`**File:** \`${symbol.file_path}\``);
    lines.push(`**Reference syntax:** \`#${symbol.name}.<DefineName>\``);
    lines.push('');
    lines.push(`## #define entries (${defines.length}${filter ? `, filtered by "${filter}"` : ''})`);
    lines.push('');
    if (defines.length === 0) {
      lines.push(filter ? '*(no defines match the filter)*' : '*(no #define entries indexed)*');
    } else {
      lines.push('| Define | Value |');
      lines.push('|--------|-------|');
      for (const d of defines) {
        lines.push(`| \`#${symbol.name}.${d.define_name}\` | ${d.define_value ? `\`${d.define_value}\`` : '—'} |`);
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error getting macro info: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true,
    };
  }
}
