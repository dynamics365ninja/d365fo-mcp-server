/**
 * Get Service Info Tool
 * Reads an AxService from the SQLite index: backing class, external name,
 * exposed operations, owning service group(s), and the computed REST endpoint
 * (/api/services/<ServiceGroup>/<Service>/<Operation>).
 *
 * Backed by the static symbol index (Azure-safe READ tool) — services are not
 * served by the C# bridge, so there is no bridge fast-path here.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { canonicalSymbolName } from '../utils/symbolLookup.js';

const GetServiceInfoArgsSchema = z.object({
  serviceName: z.string().describe('Name of the AxService object (e.g. "AifUserSessionService")'),
  includeOperations: z.boolean().optional().default(true).describe('Include the list of service operations and computed endpoints'),
});

export async function getServiceInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetServiceInfoArgsSchema.parse(request.params.arguments);
    const { includeOperations } = args;
    const db = context.symbolIndex.getReadDb();

    // Resolve the caller's casing to the canonical AOT name once (#686), then
    // keep every probe below BINARY and on-index.
    const serviceName = canonicalSymbolName(db, args.serviceName, ['service']) ?? args.serviceName;

    const symbol = db.prepare(
      `SELECT name, signature, description, model, file_path FROM symbols WHERE name = ? AND type = 'service' LIMIT 1`
    ).get(serviceName) as { name: string; signature?: string; description?: string; model: string; file_path: string } | undefined;

    if (!symbol) {
      return {
        content: [{
          type: 'text',
          text: `Service "${serviceName}" not found.\n\nTip: run extract-metadata + build-database to index AxService objects, or check the name with search(type="service").`,
        }],
        isError: true,
      };
    }

    const operations = db.prepare(
      `SELECT operation_name, method_name, idempotent FROM service_operations WHERE service_name = ? ORDER BY operation_name`
    ).all(serviceName) as { operation_name: string; method_name: string; idempotent: number }[];

    const groups = db.prepare(
      `SELECT DISTINCT group_name FROM service_group_members WHERE service_name = ? ORDER BY group_name`
    ).all(serviceName) as { group_name: string }[];

    const serviceClass = symbol.signature || undefined;
    const externalName = symbol.description || undefined;

    const lines: string[] = [];
    lines.push(`# AxService: \`${symbol.name}\``);
    lines.push('');
    lines.push(`**Model:** ${symbol.model}`);
    lines.push(`**Backing class:** ${serviceClass ? `\`${serviceClass}\`` : '— (none set)'}`);
    if (externalName) lines.push(`**External name:** ${externalName}`);
    lines.push(`**File:** \`${symbol.file_path}\``);

    if (groups.length > 0) {
      lines.push(`**Service group(s):** ${groups.map(g => `\`${g.group_name}\``).join(', ')}`);
    } else {
      lines.push(`**Service group(s):** — not a member of any indexed AxServiceGroup`);
    }
    lines.push('');

    if (includeOperations) {
      lines.push(`## Operations (${operations.length})`);
      lines.push('');
      if (operations.length === 0) {
        lines.push('*(no operations indexed)*');
      } else {
        lines.push('| Operation | Method | Idempotent |');
        lines.push('|-----------|--------|------------|');
        for (const op of operations) {
          lines.push(`| \`${op.operation_name}\` | \`${op.method_name}\` | ${op.idempotent ? 'Yes' : 'No'} |`);
        }
        lines.push('');

        // REST endpoint: /api/services/<ServiceGroup>/<Service>/<Operation>
        // The route segment is the AxService Name, not the external name.
        lines.push('## REST endpoint(s)');
        lines.push('');
        const groupNames = groups.length > 0 ? groups.map(g => g.group_name) : ['<ServiceGroup>'];
        const sampleOp = operations[0].operation_name;
        for (const g of groupNames) {
          lines.push(`- \`/api/services/${g}/${symbol.name}/${sampleOp}\``);
        }
        if (groups.length === 0) {
          lines.push('');
          lines.push('> Service is not in an indexed group — add it to an AxServiceGroup to expose it.');
        }
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error getting service info: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
