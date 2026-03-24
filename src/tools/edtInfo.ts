/**
 * Get EDT Info Tool
 * Extract Extended Data Type (EDT) properties from AxEdt metadata
 *
 * Standard mode: C# bridge (IMetadataProvider) — 100% reliable, always available on VM.
 * Hierarchy mode: SQLite (edt_metadata table) — ancestor chain walk + children + field usages.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { tryBridgeEdt } from '../bridge/bridgeAdapter.js';

const GetEdtInfoArgsSchema = z.object({
  edtName: z.string().describe('Name of the Extended Data Type (EDT)'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided)'),
  includeWorkspace: z.boolean().optional().default(false).describe('Include workspace files'),
  workspacePath: z.string().optional().describe('Path to workspace'),
  mode: z.enum(['standard', 'hierarchy']).optional().default('standard')
    .describe('standard=normal EDT details, hierarchy=show ancestor chain + children + field usages'),
});

export async function getEdtInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetEdtInfoArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    const { edtName, modelName } = args;

    // ── Hierarchy mode: ancestor chain + children + field usages (SQLite only) ──
    if (args.mode === 'hierarchy') {
      return getEdtHierarchy(symbolIndex.db, edtName, modelName);
    }

    // ── Standard mode: C# bridge (IMetadataProvider — live D365FO metadata) ──
    const bridgeResult = await tryBridgeEdt(context.bridge, edtName);
    if (bridgeResult) return bridgeResult;

    return {
      content: [{
        type: 'text',
        text: `EDT "${edtName}" not found. Bridge returned no data — ensure the EDT exists in D365FO metadata.`,
      }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error getting EDT info: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

/**
 * Hierarchy mode: walk ancestor chain, find children, and show field usages
 */
function getEdtHierarchy(db: any, edtName: string, modelName?: string) {
  // Ancestor chain walk
  const chain: Array<{ name: string; model: string; extends?: string; label?: string; stringSize?: string }> = [];
  let current = edtName;
  const visited = new Set<string>();

  while (current && !visited.has(current)) {
    visited.add(current);
    const row = db.prepare(`
      SELECT edt_name, model, extends, label, string_size
      FROM edt_metadata WHERE edt_name = ?
      ${modelName ? 'AND model = ?' : ''}
      LIMIT 1
    `).get(...(modelName ? [current, modelName] : [current])) as any;

    if (!row) break;
    chain.push({ name: row.edt_name, model: row.model, extends: row.extends, label: row.label, stringSize: row.string_size });
    current = row.extends;
  }

  if (chain.length === 0) {
    return { content: [{ type: 'text', text: `EDT not found in edt_metadata: ${edtName}\n\nRun extract-metadata to index EDT metadata.` }] };
  }

  // Direct children (EDTs that extend this one)
  const children = db.prepare(
    `SELECT edt_name, model, label FROM edt_metadata WHERE extends = ? ORDER BY model, edt_name`
  ).all(edtName) as any[];

  // Field usages (fields using this EDT by name)
  const fieldUsages = db.prepare(
    `SELECT parent_name, name, model FROM symbols WHERE type = 'field' AND signature LIKE ? ORDER BY model, parent_name LIMIT 50`
  ).all(`%${edtName}%`) as any[];

  let output = `EDT Hierarchy: ${edtName}\n\n`;

  // Ancestor chain
  output += `Ancestor Chain (${chain.length} level(s)):\n`;
  output += `  ${chain.map(e => e.name).join(' → ')}\n\n`;

  for (const e of chain) {
    output += `  ${e.name.padEnd(35)} Model: ${e.model}`;
    if (e.label) output += `, Label: ${e.label}`;
    if (e.stringSize) output += `, StringSize: ${e.stringSize}`;
    if (e.extends) output += ` [extends ${e.extends}]`;
    output += '\n';
  }

  // Children
  output += `\nDirect Children (${children.length} EDT(s) extending ${edtName}):\n`;
  if (children.length === 0) {
    output += `  (none)\n`;
  } else {
    for (const c of children.slice(0, 20)) {
      output += `  ${c.edt_name} [${c.model}]`;
      if (c.label) output += ` — ${c.label}`;
      output += '\n';
    }
    if (children.length > 20) output += `  ... and ${children.length - 20} more\n`;
  }

  // Field usages
  output += `\nField Usages (top ${Math.min(fieldUsages.length, 50)}):\n`;
  if (fieldUsages.length === 0) {
    output += `  No fields indexed with this EDT name in signature\n`;
  } else {
    for (const f of fieldUsages.slice(0, 10)) {
      output += `  ${f.parent_name}.${f.name} [${f.model}]\n`;
    }
    if (fieldUsages.length > 10) output += `  ... and ${fieldUsages.length - 10} more (${fieldUsages.length} total)\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}

export const getEdtInfoToolDefinition = {
  name: 'get_edt_info',
  description: '📊 Get complete Extended Data Type (EDT) definition including base type, labels, reference table, string/number settings, and EDT properties from AxEdt metadata.',
  inputSchema: GetEdtInfoArgsSchema,
};
