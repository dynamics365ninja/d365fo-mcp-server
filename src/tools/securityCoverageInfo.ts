/**
 * Security Coverage Info Tool
 * Show what security objects (privileges/duties/roles) cover a given D365FO object
 * by tracing the reverse chain: object → menu items → privileges → duties → roles
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

const SecurityCoverageInfoArgsSchema = z.object({
  objectName: z.string().describe('Name of the form, table, class, or menu item to check security coverage for'),
  objectType: z.enum(['form', 'table', 'class', 'menu-item', 'auto']).optional().default('auto')
    .describe('Type of the object (auto=detect from symbol index)'),
});

export async function securityCoverageInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = SecurityCoverageInfoArgsSchema.parse(request.params.arguments);
    const db = context.symbolIndex.db;
    const objName = args.objectName;

    // ── Step 1: Detect object type ──
    let resolvedType = args.objectType;
    if (resolvedType === 'auto') {
      const sym = db.prepare(
        `SELECT type FROM symbols WHERE name = ? AND type IN ('form','table','class','menu-item-display','menu-item-action','menu-item-output')
         ORDER BY CASE type WHEN 'form' THEN 0 WHEN 'table' THEN 1 WHEN 'class' THEN 2 ELSE 3 END LIMIT 1`
      ).get(objName) as any;
      if (sym) {
        resolvedType = sym.type.startsWith('menu-item') ? 'menu-item' : sym.type as any;
      }
    }

    let output = `Security coverage for: ${objName}`;
    if (resolvedType !== 'auto') output += ` (${resolvedType})`;
    output += '\n\n';

    // ── Step 2: Find menu items targeting this object ──
    // From menu_item_targets table
    let menuItems: any[] = [];
    try {
      menuItems = db.prepare(
        `SELECT menu_item_name, menu_item_type, target_object, target_type FROM menu_item_targets
         WHERE target_object = ?
         ORDER BY menu_item_type, menu_item_name`
      ).all(objName) as any[];
    } catch { /**/ }

    // Fallback: if the object IS a menu item, use it directly
    if (menuItems.length === 0 && (resolvedType === 'menu-item' || resolvedType === 'auto')) {
      const directMenuItem = db.prepare(
        `SELECT name as menu_item_name, type as menu_item_type FROM symbols
         WHERE name = ? AND type IN ('menu-item-display','menu-item-action','menu-item-output') LIMIT 1`
      ).get(objName) as any;
      if (directMenuItem) {
        menuItems = [{ ...directMenuItem, target_object: objName, target_type: resolvedType }];
      }
    }

    // Also search by name match (a form named CustTable might have a menu item also named CustTable)
    if (menuItems.length === 0) {
      const sameNameMenuItems = db.prepare(
        `SELECT name as menu_item_name, type as menu_item_type FROM symbols
         WHERE name = ? AND type IN ('menu-item-display','menu-item-action','menu-item-output')`
      ).all(objName) as any[];
      menuItems.push(...sameNameMenuItems);
    }

    if (menuItems.length === 0) {
      output += `No menu items found targeting: ${objName}\n`;
      output += `This object may not be directly exposed via a menu item, or menu item indexing has not been run.\n`;
      output += `\nTip: Security coverage requires both menu item indexing (Phase 1D) and security privilege indexing.\n`;
      return { content: [{ type: 'text', text: output }] };
    }

    output += `Exposed via ${menuItems.length} menu item(s):\n\n`;

    const allPrivileges = new Set<string>();
    const allDuties = new Set<string>();
    const allRoles = new Set<string>();

    for (const mi of menuItems) {
      const typeLabel = mi.menu_item_type === 'menu-item-display' ? 'MenuItemDisplay'
        : mi.menu_item_type === 'menu-item-action' ? 'MenuItemAction'
        : mi.menu_item_type === 'MenuItemAction' ? 'MenuItemAction'
        : mi.menu_item_type === 'MenuItemDisplay' ? 'MenuItemDisplay'
        : mi.menu_item_type || 'MenuItem';

      output += `  ${mi.menu_item_name} (${typeLabel}):\n`;

      // ── Step 3: Find privileges granting this menu item ──
      const privileges = db.prepare(
        `SELECT DISTINCT privilege_name, object_type, access_level FROM security_privilege_entries
         WHERE entry_point_name = ?
         ORDER BY privilege_name`
      ).all(mi.menu_item_name) as any[];

      if (privileges.length === 0) {
        output += `    No privileges found granting this menu item\n`;
      } else {
        output += `    Privileges (${privileges.length}):\n`;

        for (const priv of privileges) {
          allPrivileges.add(priv.privilege_name);
          output += `      ${priv.privilege_name} [${priv.access_level}]`;

          // ── Step 4: Duties for this privilege ──
          const duties = db.prepare(
            `SELECT DISTINCT duty_name FROM security_duty_privileges
             WHERE privilege_name = ?
             ORDER BY duty_name LIMIT 5`
          ).all(priv.privilege_name) as any[];

          const totalDuties = (db.prepare(
            `SELECT COUNT(*) as cnt FROM security_duty_privileges WHERE privilege_name = ?`
          ).get(priv.privilege_name) as any)?.cnt ?? 0;

          if (duties.length > 0) {
            output += ` → Duty: ${duties.map((d: any) => d.duty_name).join(', ')}`;
            if (totalDuties > 5) output += ` (+${totalDuties - 5} more)`;

            for (const duty of duties) {
              allDuties.add(duty.duty_name);

              // ── Step 5: Roles for this duty ──
              const roles = db.prepare(
                `SELECT DISTINCT role_name FROM security_role_duties
                 WHERE duty_name = ?
                 ORDER BY role_name LIMIT 3`
              ).all(duty.duty_name) as any[];

              const totalRoles = (db.prepare(
                `SELECT COUNT(*) as cnt FROM security_role_duties WHERE duty_name = ?`
              ).get(duty.duty_name) as any)?.cnt ?? 0;

              for (const role of roles) {
                allRoles.add(role.role_name);
              }

              if (roles.length > 0) {
                output += ` → Role: ${roles.map((r: any) => r.role_name).join(', ')}`;
                if (totalRoles > 3) output += ` (+${totalRoles - 3} more)`;
              }
            }
          }

          output += '\n';
        }
      }
      output += '\n';
    }

    // Summary
    output += `Summary:\n`;
    output += `  Total privileges with any access: ${allPrivileges.size}\n`;
    output += `  Total duties: ${allDuties.size}\n`;
    output += `  Total roles with any access: ${allRoles.size}\n`;

    if (allRoles.size > 0) {
      const roleList = [...allRoles].slice(0, 5).join(', ');
      output += `  Roles: ${roleList}${allRoles.size > 5 ? ` (+${allRoles.size - 5} more)` : ''}\n`;
    }

    return { content: [{ type: 'text', text: output }] };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting security coverage: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
