/**
 * Get View Info Tool
 * Extract data entity view structure: computed columns, relations, methods.
 *
 * PRIMARY: C# bridge (IMetadataProvider) — 100% reliable, always available on VM.
 * No SQLite / XML fallback needed — bridge returns complete view metadata.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { tryBridgeView } from '../bridge/bridgeAdapter.js';

const GetViewInfoArgsSchema = z.object({
  viewName: z.string().describe('Name of the view or data entity'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided)'),
  includeFields: z.boolean().optional().default(true).describe('Include field list'),
  includeRelations: z.boolean().optional().default(true).describe('Include relations'),
  includeMethods: z.boolean().optional().default(true).describe('Include methods'),
  includeWorkspace: z.boolean().optional().default(false).describe('Include workspace files'),
  workspacePath: z.string().optional().describe('Path to workspace'),
});

export async function getViewInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetViewInfoArgsSchema.parse(request.params.arguments);

    // C# bridge (IMetadataProvider — live D365FO metadata, always available)
    const bridgeResult = await tryBridgeView(context.bridge, args.viewName);
    if (bridgeResult) return bridgeResult;

    return {
      content: [{
        type: 'text',
        text: `View "${args.viewName}" not found. Bridge returned no data — ensure the view exists in D365FO metadata.`,
      }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error getting view info: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

export const getViewInfoToolDefinition = {
  name: 'get_view_info',
  description: '🗂️ Extract data entity view structure: computed columns, relations, methods. Returns view metadata with field mappings (DataSource.DataField), computed columns (DataMethod), and relations. Essential for understanding view logic and OData entity structure.',
  inputSchema: GetViewInfoArgsSchema,
};
