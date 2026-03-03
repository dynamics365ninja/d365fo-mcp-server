/**
 * Security Artifact Info Tool
 * Retrieve full details for security privileges, duties, and roles including hierarchy chains
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

const SecurityArtifactInfoArgsSchema = z.object({
  name: z.string().describe('Name of the security privilege, duty, or role'),
  artifactType: z.enum(['privilege', 'duty', 'role']).describe('Type of security artifact'),
  includeChain: z.boolean().optional().default(true).describe('Walk the full hierarchy (role→duties→privileges→entry points)'),
});

export async function securityArtifactInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = SecurityArtifactInfoArgsSchema.parse(request.params.arguments);
    const db = context.symbolIndex.db;

    if (args.artifactType === 'privilege') {
      return getPrivilegeInfo(db, args.name, args.includeChain ?? true);
    } else if (args.artifactType === 'duty') {
      return getDutyInfo(db, args.name, args.includeChain ?? true);
    } else {
      return getRoleInfo(db, args.name, args.includeChain ?? true);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting security artifact info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

function getPrivilegeInfo(db: any, name: string, _includeChain: boolean) {
  // Get the privilege symbol
  const symbol = db.prepare(
    `SELECT name, description, signature, model, file_path FROM symbols WHERE name = ? AND type = 'security-privilege' LIMIT 1`
  ).get(name) as any;

  if (!symbol) {
    return {
      content: [{ type: 'text', text: `Security privilege not found: ${name}\n\nTip: Run extract-metadata and build-database to index security objects.` }],
    };
  }

  // Get entry points
  const entryPoints = db.prepare(
    `SELECT entry_point_name, object_type, access_level FROM security_privilege_entries WHERE privilege_name = ? ORDER BY entry_point_name`
  ).all(name) as any[];

  // Find which duties use this privilege
  const duties = db.prepare(
    `SELECT DISTINCT duty_name FROM security_duty_privileges WHERE privilege_name = ? ORDER BY duty_name`
  ).all(name) as any[];

  let output = `SecurityPrivilege: ${symbol.name}\n`;
  if (symbol.description) output += `Label: ${symbol.description}\n`;
  output += `Model: ${symbol.model}\n`;

  if (entryPoints.length > 0) {
    output += `\nEntry Points (${entryPoints.length}):\n`;
    for (const ep of entryPoints) {
      output += `  ✓ ${ep.entry_point_name} [${ep.object_type}]  → ${ep.access_level} access\n`;
    }
  } else {
    output += `\nEntry Points: none indexed\n`;
  }

  if (duties.length > 0) {
    output += `\nUsed in Duties (${duties.length}):\n`;
    output += `  ${duties.map((d: any) => d.duty_name).join(', ')}\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}

function getDutyInfo(db: any, name: string, includeChain: boolean) {
  const symbol = db.prepare(
    `SELECT name, description, signature, model FROM symbols WHERE name = ? AND type = 'security-duty' LIMIT 1`
  ).get(name) as any;

  if (!symbol) {
    return {
      content: [{ type: 'text', text: `Security duty not found: ${name}` }],
    };
  }

  const privileges = db.prepare(
    `SELECT privilege_name FROM security_duty_privileges WHERE duty_name = ? ORDER BY privilege_name`
  ).all(name) as any[];

  const roles = db.prepare(
    `SELECT DISTINCT role_name FROM security_role_duties WHERE duty_name = ? ORDER BY role_name`
  ).all(name) as any[];

  let output = `SecurityDuty: ${symbol.name}\n`;
  if (symbol.description) output += `Label: ${symbol.description}\n`;
  output += `Model: ${symbol.model}\n`;

  if (privileges.length > 0) {
    output += `\nPrivileges (${privileges.length}):\n`;
    for (const priv of privileges) {
      if (includeChain) {
        // Show entry points for each privilege
        const eps = db.prepare(
          `SELECT entry_point_name, object_type, access_level FROM security_privilege_entries WHERE privilege_name = ? ORDER BY entry_point_name`
        ).all(priv.privilege_name) as any[];
        output += `  • ${priv.privilege_name}`;
        if (eps.length > 0) {
          output += ` (${eps.length} entry points: ${eps.slice(0, 3).map((ep: any) => `${ep.entry_point_name}[${ep.access_level}]`).join(', ')}${eps.length > 3 ? '...' : ''})`;
        }
        output += '\n';
      } else {
        output += `  • ${priv.privilege_name}\n`;
      }
    }
  }

  if (roles.length > 0) {
    output += `\nAssigned to Roles (${roles.length}):\n`;
    output += `  ${roles.map((r: any) => r.role_name).join(', ')}\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}

function getRoleInfo(db: any, name: string, includeChain: boolean) {
  const symbol = db.prepare(
    `SELECT name, description, signature, model FROM symbols WHERE name = ? AND type = 'security-role' LIMIT 1`
  ).get(name) as any;

  if (!symbol) {
    return {
      content: [{ type: 'text', text: `Security role not found: ${name}` }],
    };
  }

  const duties = db.prepare(
    `SELECT duty_name FROM security_role_duties WHERE role_name = ? ORDER BY duty_name`
  ).all(name) as any[];

  let output = `SecurityRole: ${symbol.name}\n`;
  if (symbol.description) output += `Description: ${symbol.description}\n`;
  output += `Model: ${symbol.model}\n`;

  if (duties.length > 0) {
    output += `\nDuties (${duties.length}):\n`;
    for (const duty of duties) {
      output += `  • ${duty.duty_name}`;

      if (includeChain) {
        const privileges = db.prepare(
          `SELECT privilege_name FROM security_duty_privileges WHERE duty_name = ? ORDER BY privilege_name`
        ).all(duty.duty_name) as any[];

        if (privileges.length > 0) {
          output += ` → ${privileges.length} privilege(s): ${privileges.slice(0, 3).map((p: any) => p.privilege_name).join(', ')}${privileges.length > 3 ? '...' : ''}`;
        }
      }
      output += '\n';
    }

    if (includeChain) {
      // Count total entry points across all duties
      const totalEntryPoints = (db.prepare(`
        SELECT COUNT(*) as cnt FROM security_privilege_entries spe
        WHERE spe.privilege_name IN (
          SELECT privilege_name FROM security_duty_privileges WHERE duty_name IN (
            SELECT duty_name FROM security_role_duties WHERE role_name = ?
          )
        )
      `).get(name) as any)?.cnt ?? 0;

      output += `\nTotal entry points covered: ${totalEntryPoints}\n`;
    }
  } else {
    output += `\nDuties: none indexed\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}
