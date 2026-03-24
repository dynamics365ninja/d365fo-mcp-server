/**
 * Get Enum Info Tool
 * Extract enum values and enum properties.
 *
 * PRIMARY: C# bridge (IMetadataProvider) — 100% reliable, always available on VM.
 * No SQLite / XML fallback needed — bridge returns complete enum metadata.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { tryBridgeEnum } from '../bridge/bridgeAdapter.js';

const GetEnumInfoArgsSchema = z.object({
  enumName: z.string().describe('Name of the enum'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided)'),
  includeLabels: z.boolean().optional().default(true).describe('Include enum value labels'),
  includeWorkspace: z.boolean().optional().default(false).describe('Include workspace files'),
  workspacePath: z.string().optional().describe('Path to workspace'),
});

export async function getEnumInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetEnumInfoArgsSchema.parse(request.params.arguments);

    // C# bridge (IMetadataProvider — live D365FO metadata, always available)
    const bridgeResult = await tryBridgeEnum(context.bridge, args.enumName);
    if (bridgeResult) return bridgeResult;

    return {
      content: [{
        type: 'text',
        text: `Enum "${args.enumName}" not found. Bridge returned no data — ensure the enum exists in D365FO metadata.`,
      }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error getting enum info: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

export const getEnumInfoToolDefinition = {
  name: 'get_enum_info',
  description: '🏷️ Extract enum values with labels and numeric values. Essential for understanding available enum options.',
  inputSchema: GetEnumInfoArgsSchema,
};
