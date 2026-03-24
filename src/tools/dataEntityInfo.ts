/**
 * Data Entity Info Tool
 * Retrieve rich D365FO-specific metadata for data entities (OData, DMF, staging, sources).
 *
 * PRIMARY: C# bridge (IMetadataProvider) — 100% reliable, always available on VM.
 * SQLite "did you mean?" kept only on error path.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { tryBridgeDataEntity } from '../bridge/bridgeAdapter.js';

const DataEntityInfoArgsSchema = z.object({
  entityName: z.string().describe('Name of the data entity (AxDataEntityView)'),
});

export async function dataEntityInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = DataEntityInfoArgsSchema.parse(request.params.arguments);

    // C# bridge (IMetadataProvider — live D365FO metadata, always available)
    const bridgeResult = await tryBridgeDataEntity(context.bridge, args.entityName);
    if (bridgeResult) return bridgeResult;

    // Bridge returned nothing — try fuzzy name suggestions from DB
    let text = `Data entity not found: ${args.entityName}\n`;
    try {
      const db = context.symbolIndex.db;
      const suggestions = db.prepare(
        `SELECT name, model FROM symbols WHERE type = 'view' AND name LIKE ? ORDER BY name LIMIT 10`
      ).all(`%${args.entityName}%`) as any[];
      if (suggestions.length > 0) {
        text += '\nSimilar views/entities:\n';
        for (const s of suggestions) text += `  ${s.name} (${s.model})\n`;
      }
    } catch { /* DB not available */ }
    text += '\nTip: Data entities are views — try searching with type="view".';
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error getting data entity info: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
