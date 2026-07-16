/**
 * Get Configuration Key Info Tool
 * Reads an AxConfigurationKey (or AxLicenseCode) from the SQLite index and shows
 * the feature-gating tree: the key's label, its parent chain, and direct children.
 * Azure-safe READ tool.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { canonicalSymbolName } from '../utils/symbolLookup.js';

const GetConfigKeyInfoArgsSchema = z.object({
  name: z.string().describe('Name of the AxConfigurationKey or AxLicenseCode (e.g. "AdvancedLedgerEntry")'),
});

export async function getConfigKeyInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetConfigKeyInfoArgsSchema.parse(request.params.arguments);
    const db = context.symbolIndex.getReadDb();

    // Resolve the caller's casing to the canonical AOT name once, against both
    // types this tool accepts (#686). The parent-chain / children probes below
    // walk DB-sourced names, which are already canonical.
    const name = canonicalSymbolName(db, args.name, ['configuration-key', 'license-code']) ?? args.name;

    // Configuration key: signature holds the parent key name.
    const key = db.prepare(
      `SELECT name, description, signature, model, file_path FROM symbols WHERE name = ? AND type = 'configuration-key' LIMIT 1`
    ).get(name) as { name: string; description?: string; signature?: string; model: string; file_path: string } | undefined;

    if (key) {
      const lines: string[] = [];
      lines.push(`# AxConfigurationKey: \`${key.name}\``);
      lines.push('');
      lines.push(`**Model:** ${key.model}`);
      if (key.description) lines.push(`**Label:** ${key.description}`);
      lines.push(`**File:** \`${key.file_path}\``);

      // Walk up the parent chain (bounded to avoid cycles).
      const chain: string[] = [];
      let cursor: string | undefined = key.signature || undefined;
      const seen = new Set<string>([key.name]);
      while (cursor && !seen.has(cursor) && chain.length < 20) {
        chain.push(cursor);
        seen.add(cursor);
        const parent = db.prepare(
          `SELECT signature FROM symbols WHERE name = ? AND type = 'configuration-key' LIMIT 1`
        ).get(cursor) as { signature?: string } | undefined;
        cursor = parent?.signature || undefined;
      }
      lines.push(`**Parent chain:** ${chain.length > 0 ? chain.map(c => `\`${c}\``).join(' → ') : '— (root key)'}`);

      const children = db.prepare(
        `SELECT name FROM symbols WHERE type = 'configuration-key' AND signature = ? ORDER BY name`
      ).all(key.name) as { name: string }[];
      lines.push('');
      lines.push(`## Direct child keys (${children.length})`);
      lines.push('');
      lines.push(children.length === 0 ? '*(none)*' : children.map(c => `- \`${c.name}\``).join('\n'));

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // Fall back to license code.
    const lic = db.prepare(
      `SELECT name, description, signature, model, file_path FROM symbols WHERE name = ? AND type = 'license-code' LIMIT 1`
    ).get(name) as { name: string; description?: string; signature?: string; model: string; file_path: string } | undefined;

    if (lic) {
      const lines: string[] = [];
      lines.push(`# AxLicenseCode: \`${lic.name}\``);
      lines.push('');
      lines.push(`**Model:** ${lic.model}`);
      if (lic.description) lines.push(`**Label:** ${lic.description}`);
      if (lic.signature) lines.push(`**Group / Type:** ${lic.signature}`);
      lines.push(`**File:** \`${lic.file_path}\``);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    return {
      content: [{ type: 'text', text: `Configuration key / license code "${name}" not found.\n\nTip: run extract-metadata + build-database, or search(type="configuration-key").` }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error getting configuration key info: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true,
    };
  }
}
