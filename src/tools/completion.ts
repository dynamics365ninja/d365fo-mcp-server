/**
 * X++ Code Completion Tool
 * Get method and field completions for classes or tables
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

const CompletionArgsSchema = z.object({
  objectName: z.string().describe('Class or table name'),
  prefix: z.string().optional().default('').describe('Method/field name prefix to filter'),
});

export async function completionTool(request: CallToolRequest, context: XppServerContext) {
  const args = CompletionArgsSchema.parse(request.params.arguments);
  const { symbolIndex } = context;

  try {
    const methods = symbolIndex.getClassMethods(args.objectName);
    const fields = symbolIndex.getTableFields(args.objectName);

    const allMembers = [...methods, ...fields].filter((m) =>
      m.name.toLowerCase().startsWith(args.prefix.toLowerCase())
    );

    if (allMembers.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No members found for "${args.objectName}" starting with "${args.prefix}"`,
          },
        ],
      };
    }

    const completions = allMembers.map((m) => ({
      label: m.name,
      kind: m.type === 'method' ? 'Method' : 'Field',
      signature: m.signature || '',
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(completions, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting completions: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
