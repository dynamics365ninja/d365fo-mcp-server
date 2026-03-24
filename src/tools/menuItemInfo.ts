/**
 * Menu Item Info Tool
 * Retrieve details for D365FO menu items including target objects and security chain
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { tryBridgeMenuItem } from '../bridge/index.js';

const MenuItemInfoArgsSchema = z.object({
  name: z.string().describe('Name of the menu item'),
  itemType: z.enum(['display', 'action', 'output', 'any']).optional().default('any')
    .describe('Menu item type filter (display=AxMenuItemDisplay, action=AxMenuItemAction, output=AxMenuItemOutput, any=all types)'),
});

export async function menuItemInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = MenuItemInfoArgsSchema.parse(request.params.arguments);

    // ── Bridge fast-path (C# IMetadataProvider) ──
    const bridgeResult = await tryBridgeMenuItem(context.bridge, args.name, args.itemType);
    if (bridgeResult) return bridgeResult;

    // ── Fallback: SQLite index ──
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

    // ── Batch-fetch security chain for all symbols at once (3 queries total) ──
    // Replaces the previous O(N·M·K) nested per-privilege / per-duty query pattern.
    const symNames = symbols.map(s => s.name);
    const symPH = symNames.map(() => '?').join(',');

    const allPrivEntries = db.prepare(
      `SELECT DISTINCT entry_point_name, privilege_name, object_type, access_level
       FROM security_privilege_entries
       WHERE entry_point_name IN (${symPH})
       ORDER BY entry_point_name, privilege_name`
    ).all(...symNames) as any[];

    const privilegesBySymbol = new Map<string, any[]>();
    for (const pe of allPrivEntries) {
      if (!privilegesBySymbol.has(pe.entry_point_name)) privilegesBySymbol.set(pe.entry_point_name, []);
      privilegesBySymbol.get(pe.entry_point_name)!.push(pe);
    }

    const allPrivNames = [...new Set(allPrivEntries.map(pe => pe.privilege_name))];
    const dutiesByPriv = new Map<string, string[]>();
    const dutiesCountByPriv = new Map<string, number>();
    const rolesByDutyName = new Map<string, string[]>();
    const rolesCountByDuty = new Map<string, number>();

    if (allPrivNames.length > 0) {
      const privPH = allPrivNames.map(() => '?').join(',');
      const allDutyRows = db.prepare(
        `SELECT privilege_name, duty_name FROM security_duty_privileges
         WHERE privilege_name IN (${privPH}) ORDER BY duty_name`
      ).all(...allPrivNames) as any[];

      for (const d of allDutyRows) {
        if (!dutiesByPriv.has(d.privilege_name)) dutiesByPriv.set(d.privilege_name, []);
        dutiesByPriv.get(d.privilege_name)!.push(d.duty_name);
      }
      for (const [k, v] of dutiesByPriv) {
        dutiesCountByPriv.set(k, v.length);
        dutiesByPriv.set(k, v.slice(0, 5));
      }

      const allDutyNames = [...new Set(allDutyRows.map(d => d.duty_name))];
      if (allDutyNames.length > 0) {
        const dutyPH = allDutyNames.map(() => '?').join(',');
        const allRoleRows = db.prepare(
          `SELECT duty_name, role_name FROM security_role_duties
           WHERE duty_name IN (${dutyPH}) ORDER BY role_name`
        ).all(...allDutyNames) as any[];

        for (const r of allRoleRows) {
          if (!rolesByDutyName.has(r.duty_name)) rolesByDutyName.set(r.duty_name, []);
          rolesByDutyName.get(r.duty_name)!.push(r.role_name);
        }
        for (const [k, v] of rolesByDutyName) {
          rolesCountByDuty.set(k, v.length);
          rolesByDutyName.set(k, v.slice(0, 5));
        }
      }
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

      // Security chain — use pre-fetched data (no DB queries inside this loop)
      const privileges = privilegesBySymbol.get(symbol.name) || [];

      if (privileges.length > 0) {
        output += `\nSecurity Chain:\n`;
        for (const priv of privileges) {
          output += `  Privilege: ${priv.privilege_name} [${priv.access_level}]\n`;

          const duties = dutiesByPriv.get(priv.privilege_name) || [];
          const totalDuties = dutiesCountByPriv.get(priv.privilege_name) ?? 0;

          for (const dutyName of duties) {
            output += `    → Duty: ${dutyName}\n`;

            const roles = rolesByDutyName.get(dutyName) || [];
            const totalRoles = rolesCountByDuty.get(dutyName) ?? 0;

            for (const roleName of roles) {
              output += `      → Role: ${roleName}\n`;
            }
            if (totalRoles > 5) {
              output += `      → ... and ${totalRoles - 5} more roles\n`;
            }
          }
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
