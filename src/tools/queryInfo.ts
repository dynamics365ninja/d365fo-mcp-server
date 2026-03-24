/**
 * Get Query Info Tool
 * Extract query structure: datasources, ranges, joins.
 *
 * PRIMARY: C# bridge (IMetadataProvider) — 100% reliable, always available on VM.
 * No SQLite path-lookup / XML parsing needed — bridge returns complete query metadata.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { tryBridgeQuery } from '../bridge/bridgeAdapter.js';

const GetQueryInfoArgsSchema = z.object({
  queryName: z.string().describe('Name of the query'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided)'),
  includeRanges: z.boolean().optional().default(true).describe('Include range definitions'),
  includeJoins: z.boolean().optional().default(true).describe('Include join information'),
  includeFields: z.boolean().optional().default(true).describe('Include field list'),
  includeWorkspace: z.boolean().optional().default(false).describe('Include workspace files'),
  workspacePath: z.string().optional().describe('Path to workspace'),
});

export async function getQueryInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetQueryInfoArgsSchema.parse(request.params.arguments);

    // C# bridge (IMetadataProvider — live D365FO metadata, always available)
    const bridgeResult = await tryBridgeQuery(context.bridge, args.queryName);
    if (bridgeResult) return bridgeResult;

    return {
      content: [{
        type: 'text',
        text: `Query "${args.queryName}" not found. Bridge returned no data — ensure the query exists in D365FO metadata.`,
      }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error getting query info: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

export const getQueryInfoToolDefinition = {
  name: 'get_query_info',
  description: '🔍 Extract query structure: datasources, ranges, joins, fields. Returns datasource hierarchy with range definitions and join configuration. Essential for understanding query logic and adding ranges or joins.',
  inputSchema: GetQueryInfoArgsSchema,
};
