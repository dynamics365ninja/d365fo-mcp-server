/**
 * Get Security Policy Info Tool
 * Reads an AxSecurityPolicy (row-level / OLS) from the SQLite index: the primary
 * (constrained) table, the policy query, the operation it covers, and whether
 * the primary table itself is constrained. Azure-safe READ tool.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

const GetSecurityPolicyInfoArgsSchema = z.object({
  policyName: z.string().describe('Name of the AxSecurityPolicy (e.g. "DMFMyDefinitionGroups")'),
});

export async function getSecurityPolicyInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const { policyName } = GetSecurityPolicyInfoArgsSchema.parse(request.params.arguments);
    const db = context.symbolIndex.getReadDb();

    // COLLATE NOCASE is safe on this side table (#686): security_policies holds
    // one row per policy (thousands at most), so a mismatch costs a small scan —
    // unlike `symbols`, where the same shape scans 1.17M rows.
    const policy = db.prepare(
      `SELECT policy_name, primary_table, query_name, operation, constrained_table, label, model
       FROM security_policies WHERE policy_name = ? COLLATE NOCASE LIMIT 1`
    ).get(policyName) as {
      policy_name: string; primary_table?: string; query_name?: string;
      operation?: string; constrained_table: number; label?: string; model: string;
    } | undefined;

    if (!policy) {
      return {
        content: [{ type: 'text', text: `Security policy "${policyName}" not found.\n\nTip: run extract-metadata + build-database to index AxSecurityPolicy objects, or search(type="security-policy").` }],
        isError: true,
      };
    }

    // policy.policy_name is canonical — keeps this symbols probe BINARY.
    const file = db.prepare(
      `SELECT file_path FROM symbols WHERE name = ? AND type = 'security-policy' LIMIT 1`
    ).get(policy.policy_name) as { file_path?: string } | undefined;

    const lines: string[] = [];
    lines.push(`# AxSecurityPolicy: \`${policy.policy_name}\``);
    lines.push('');
    lines.push(`**Model:** ${policy.model}`);
    if (policy.label) lines.push(`**Label:** ${policy.label}`);
    lines.push(`**Primary (constrained) table:** ${policy.primary_table ? `\`${policy.primary_table}\`` : '— none'}`);
    lines.push(`**Policy query:** ${policy.query_name ? `\`${policy.query_name}\`` : '— none'}`);
    lines.push(`**Operation:** ${policy.operation || '— (default)'}`);
    lines.push(`**Primary table constrained:** ${policy.constrained_table ? 'Yes' : 'No'}`);
    if (file?.file_path) lines.push(`**File:** \`${file.file_path}\``);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error getting security policy info: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true,
    };
  }
}
