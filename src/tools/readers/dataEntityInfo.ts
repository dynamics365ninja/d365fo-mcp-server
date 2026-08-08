/**
 * Data Entity Info Tool
 * Retrieve rich D365FO-specific metadata for data entities (OData, DMF, staging, sources).
 *
 * Read-path priority:
 *   1. C# bridge readDataEntity (IMetadataProvider) — live metadata.
 *   2. get_object_info(view) reader — data entities are indexed as type 'view', so its
 *      extracted-metadata / XML / disk chain answers when the bridge is silent.
 *   3. Fuzzy "did you mean?" suggestions from the index.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { tryBridgeDataEntity } from '../../bridge/bridgeAdapter.js';
import { getViewInfoTool } from './viewInfo.js';

const DataEntityInfoArgsSchema = z.object({
  entityName: z.string().describe('Name of the data entity (AxDataEntityView)'),
});

export async function dataEntityInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = DataEntityInfoArgsSchema.parse(request.params.arguments);

    // C# bridge (IMetadataProvider — live D365FO metadata, always available)
    const bridgeResult = await tryBridgeDataEntity(context.bridge, args.entityName);
    if (bridgeResult) return bridgeResult;

    // Bridge silent — reuse the view reader's symbol-index/XML/disk chain.
    // Data entities are AxDataEntityView files and are indexed as type 'view'.
    const viaView = await getViewInfoTool(
      { method: 'tools/call', params: { name: 'get_view_info', arguments: { viewName: args.entityName } } },
      context,
    ) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    if (!viaView?.isError) return viaView;

    // Nothing resolved — fuzzy name suggestions from DB
    let text = `Data entity not found: ${args.entityName}\n`;
    try {
      const db = context.symbolIndex.getReadDb();
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
