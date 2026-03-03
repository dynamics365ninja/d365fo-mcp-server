/**
 * Menu Item Info Tool
 * Retrieve details for D365FO menu items including target objects and security chain
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

const MenuItemInfoArgsSchema = z.object({
  name: z.string().describe('Name of the menu item'),
  itemType: z.enum(['display', 'action', 'output', 'any']).optional().default('any')
    .describe('Menu item type filter (display=AxMenuItemDisplay, action=AxMenuItemAction, output=AxMenuItemOutput, any=all types)'),
});

export async function menuItemInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = MenuItemInfoArgsSchema.parse(request.params.arguments);
    const db = context.symbolIndex.db;

    // Build type filter
    const typeMap: Record<string, string> = {
      display: 'menu-item-display',
      action: 'menu-item-action',
      output: 'menu-item-output',
    };

    let symbolQuery: string;
    let symbolParams: any[];

    if (args.itemType === 'any') {
      symbolQuery = `SELECT name, type, description, signature, model, file_path FROM symbols
        WHERE name = ? AND type IN ('menu-item-display', 'menu-item-action', 'menu-item-output')
        ORDER BY type`;
      symbolParams = [args.name];
    } else {
      symbolQuery = `SELECT name, type, description, signature, model, file_path FROM symbols
        WHERE name = ? AND type = ?`;
      symbolParams = [args.name, typeMap[args.itemType]];
    }

    const symbols = db.prepare(symbolQuery).all(...symbolParams) as any[];

    if (symbols.length === 0) {
      // Try FTS fallback
      const ftsResult = db.prepare(
        `SELECT name, type, model FROM symbols
         WHERE name LIKE ? AND type IN ('menu-item-display', 'menu-item-action', 'menu-item-output')
         LIMIT 10`
      ).all(`%${args.name}%`) as any[];

      let notFoundText = `Menu item not found: ${args.name}\n`;
      if (ftsResult.length > 0) {
        notFoundText += `\nSimilar menu items:\n`;
        for (const r of ftsResult) {
          notFoundText += `  ${r.name} [${r.type}] (${r.model})\n`;
        }
      }
      notFoundText += `\nTip: Run extract-metadata and build-database to index menu items.`;
      return { content: [{ type: 'text', text: notFoundText }] };
    }

    let output = '';

    for (const symbol of symbols) {
      const typeLabel = symbol.type === 'menu-item-display' ? 'MenuItemDisplay'
        : symbol.type === 'menu-item-action' ? 'MenuItemAction'
        : 'MenuItemOutput';

      output += `${typeLabel}: ${symbol.name}\n`;
      if (symbol.description) output += `Label: ${symbol.description}\n`;
      output += `Model: ${symbol.model}\n`;

      // Get target info from menu_item_targets
      const target = db.prepare(
        `SELECT target_object, target_type, security_privilege, label FROM menu_item_targets
         WHERE menu_item_name = ? AND menu_item_type = ?`
      ).get(symbol.name, symbol.type.replace('menu-item-', '')) as any;

      if (target) {
        if (target.target_object) {
          output += `Target: ${target.target_object}`;
          if (target.target_type) output += ` (${target.target_type})`;
          output += '\n';
        }
        if (target.security_privilege) {
          output += `Security Privilege: ${target.security_privilege}\n`;
        }
      } else if (symbol.signature) {
        // Fallback: signature may hold target object
        output += `Target: ${symbol.signature}\n`;
      }

      // Security chain: find privileges referencing this menu item as entry point
      const privileges = db.prepare(
        `SELECT DISTINCT privilege_name, object_type, access_level FROM security_privilege_entries
         WHERE entry_point_name = ? ORDER BY privilege_name`
      ).all(symbol.name) as any[];

      if (privileges.length > 0) {
        output += `\nSecurity Chain:\n`;
        for (const priv of privileges) {
          output += `  Privilege: ${priv.privilege_name} [${priv.access_level}]\n`;

          // Duties using this privilege
          const duties = db.prepare(
            `SELECT DISTINCT duty_name FROM security_duty_privileges
             WHERE privilege_name = ? ORDER BY duty_name LIMIT 5`
          ).all(priv.privilege_name) as any[];

          for (const duty of duties) {
            output += `    → Duty: ${duty.duty_name}\n`;

            // Roles using this duty
            const roles = db.prepare(
              `SELECT DISTINCT role_name FROM security_role_duties
               WHERE duty_name = ? ORDER BY role_name LIMIT 5`
            ).all(duty.duty_name) as any[];

            for (const role of roles) {
              output += `      → Role: ${role.role_name}\n`;
            }
            const totalRoles = (db.prepare(
              `SELECT COUNT(*) as cnt FROM security_role_duties WHERE duty_name = ?`
            ).get(duty.duty_name) as any)?.cnt ?? 0;
            if (totalRoles > 5) {
              output += `      → ... and ${totalRoles - 5} more roles\n`;
            }
          }
          const totalDuties = (db.prepare(
            `SELECT COUNT(*) as cnt FROM security_duty_privileges WHERE privilege_name = ?`
          ).get(priv.privilege_name) as any)?.cnt ?? 0;
          if (totalDuties > 5) {
            output += `    → ... and ${totalDuties - 5} more duties\n`;
          }
        }
      }

      // Check if a form/class with the same name exists
      const matchingObject = db.prepare(
        `SELECT name, type, model FROM symbols WHERE name = ? AND type IN ('form', 'class', 'query', 'report') LIMIT 1`
      ).get(symbol.name) as any;

      if (matchingObject) {
        output += `\nMatching ${matchingObject.type}: ${matchingObject.name} (${matchingObject.model})\n`;
      }

      if (symbols.length > 1) output += '\n---\n\n';
    }

    return { content: [{ type: 'text', text: output }] };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting menu item info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
