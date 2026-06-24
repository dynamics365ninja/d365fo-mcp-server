/**
 * security_info Tool — unified security-lookup entry point.
 *
 * Replaces two security tools with one discriminated by `mode`:
 *   • artifact → details + full hierarchy of a privilege/duty/role
 *                (Role → Duties → Privileges → Entry Points)
 *   • coverage → reverse chain: which roles/duties/privileges cover an object
 *
 * Handler files stay where they are — only the MCP surface is consolidated.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../types/context.js';
import { securityArtifactInfoTool } from './securityArtifactInfo.js';
import { securityCoverageInfoTool } from './securityCoverageInfo.js';

export const SECURITY_MODES = ['artifact', 'coverage'] as const;
export type SecurityMode = (typeof SECURITY_MODES)[number];

function subRequest(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export async function securityInfoTool(request: CallToolRequest, context: XppServerContext) {
  const a = (request.params.arguments ?? {}) as Record<string, any>;
  const mode = a.mode as string | undefined;
  const { mode: _mode, ...rest } = a;

  switch (mode) {
    case 'artifact':
      // Validate per-mode required params here so the agent gets a guided
      // message instead of the underlying handler's raw ZodError.
      if (!a.name) return err('security_info(mode="artifact") requires `name` (the privilege/duty/role name).');
      if (!a.artifactType) return err('security_info(mode="artifact") requires `artifactType` (privilege, duty, or role).');
      return securityArtifactInfoTool(subRequest('get_security_artifact_info', rest), context);

    case 'coverage':
      if (!a.objectName) return err('security_info(mode="coverage") requires `objectName` (the form/table/class/menu-item name).');
      return securityCoverageInfoTool(subRequest('get_security_coverage_for_object', rest), context);

    default:
      return err(`security_info: unknown mode "${mode ?? '(missing)'}". Use one of: ${SECURITY_MODES.join(', ')}.`);
  }
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
