/**
 * Security Coverage Info Tool
 * Show what security objects (privileges/duties/roles) cover a given D365FO object
 * by tracing the reverse chain: object → menu items → privileges → duties → roles
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { canonicalSymbolName } from '../utils/symbolLookup.js';

const SecurityCoverageInfoArgsSchema = z.object({
  objectName: z.string().describe('Name of the form, table, class, or menu item to check security coverage for'),
  objectType: z.enum(['form', 'table', 'class', 'menu-item', 'auto']).optional().default('auto')
    .describe('Type of the object (auto=detect from symbol index)'),
});

const MENU_ITEM_TYPES = ['menu-item-display', 'menu-item-action', 'menu-item-output'];

/** Symbol types a given objectType arg could resolve to. */
function candidateTypes(objectType: string): string[] {
  if (objectType === 'menu-item') return MENU_ITEM_TYPES;
  if (objectType === 'auto') return ['form', 'table', 'class', ...MENU_ITEM_TYPES];
  return [objectType];
}

export async function securityCoverageInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = SecurityCoverageInfoArgsSchema.parse(request.params.arguments);
    const db = context.symbolIndex.getReadDb();
    // Resolve the caller's casing to the canonical AOT name once (#686) — every
    // probe and side-table join below keys off this name.
    const objName = canonicalSymbolName(db, args.objectName, candidateTypes(args.objectType))
      ?? args.objectName;

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

    // AxSecurityPolicy (row-level security / OLS) applies to a primary table; surface any that name this object.
    let olsSection = '';
    if (resolvedType === 'table' || resolvedType === 'auto') {
      try {
        const policies = db.prepare(
          `SELECT policy_name, query_name, operation, constrained_table, label
           FROM security_policies WHERE primary_table = ? ORDER BY policy_name`
        ).all(objName) as any[];
        if (policies.length > 0) {
          olsSection += `Row-level security (OLS) — ${policies.length} policy(ies) constrain table ${objName}:\n`;
          for (const p of policies) {
            olsSection += `  🔒 ${p.policy_name}`;
            olsSection += ` [${p.operation || 'AllOperations'}]`;
            if (p.query_name) olsSection += ` via query ${p.query_name}`;
            if (p.constrained_table) olsSection += ` (constrained)`;
            olsSection += '\n';
          }
          olsSection += '\n';
        }
      } catch (e) {
        // security_policies table may not exist in older databases — non-fatal
        if (process.env.DEBUG_LOGGING === 'true') console.warn('[securityCoverageInfo] security_policies query failed:', e);
      }
    }

    // Find menu items targeting this object
    let menuItems: any[] = [];
    try {
      menuItems = db.prepare(
        `SELECT menu_item_name, menu_item_type, target_object, target_type FROM menu_item_targets
         WHERE target_object = ?
         ORDER BY menu_item_type, menu_item_name`
      ).all(objName) as any[];
    } catch (e) {
      // menu_item_targets table may not exist in older databases — non-fatal
      if (process.env.DEBUG_LOGGING === 'true') console.warn('[securityCoverageInfo] menu_item_targets query failed:', e);
    }

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
      if (olsSection) output += olsSection;
      output += `No menu items found targeting: ${objName}\n`;
      output += `This object may not be directly exposed via a menu item, or menu item indexing has not been run.\n`;
      output += `\nTip: Security coverage requires both menu item indexing (Phase 1D) and security privilege indexing.\n`;
      return { content: [{ type: 'text', text: output }] };
    }

    if (olsSection) output += olsSection;

    output += `Exposed via ${menuItems.length} menu item(s):\n\n`;

    const allPrivileges = new Set<string>();
    const allDuties = new Set<string>();
    const allRoles = new Set<string>();

    // Batch-fetch entire privilege→duty→role chain in 3 queries (avoids per-privilege/per-duty round-trips).

    // All privileges for all menu items at once
    const miNames = menuItems.map(mi => mi.menu_item_name);
    const miPH = miNames.map(() => '?').join(',');
    const allPrivEntries = db.prepare(
      `SELECT DISTINCT entry_point_name, privilege_name, object_type, access_level
       FROM security_privilege_entries
       WHERE entry_point_name IN (${miPH})
       ORDER BY entry_point_name, privilege_name`
    ).all(...miNames) as any[];

    const privilegesByMi = new Map<string, any[]>();
    for (const pe of allPrivEntries) {
      if (!privilegesByMi.has(pe.entry_point_name)) privilegesByMi.set(pe.entry_point_name, []);
      privilegesByMi.get(pe.entry_point_name)!.push(pe);
    }

    // All duties for all privilege names at once
    const allPrivNames = [...new Set(allPrivEntries.map(pe => pe.privilege_name))];
    const dutiesByPrivilege = new Map<string, string[]>();
    const dutiesCounts = new Map<string, number>();
    const rolesByDuty = new Map<string, string[]>();
    const rolesCounts = new Map<string, number>();

    if (allPrivNames.length > 0) {
      const privPH = allPrivNames.map(() => '?').join(',');
      const allDutyRows = db.prepare(
        `SELECT privilege_name, duty_name FROM security_duty_privileges
         WHERE privilege_name IN (${privPH})
         ORDER BY duty_name`
      ).all(...allPrivNames) as any[];

      for (const d of allDutyRows) {
        if (!dutiesByPrivilege.has(d.privilege_name)) dutiesByPrivilege.set(d.privilege_name, []);
        dutiesByPrivilege.get(d.privilege_name)!.push(d.duty_name);
      }
      for (const [k, v] of dutiesByPrivilege) {
        dutiesCounts.set(k, v.length);
        dutiesByPrivilege.set(k, v.slice(0, 5));
      }

      // All roles for all duty names at once
      const allDutyNames = [...new Set(allDutyRows.map(d => d.duty_name))];
      if (allDutyNames.length > 0) {
        const dutyPH = allDutyNames.map(() => '?').join(',');
        const allRoleRows = db.prepare(
          `SELECT duty_name, role_name FROM security_role_duties
           WHERE duty_name IN (${dutyPH})
           ORDER BY role_name`
        ).all(...allDutyNames) as any[];

        for (const r of allRoleRows) {
          if (!rolesByDuty.has(r.duty_name)) rolesByDuty.set(r.duty_name, []);
          rolesByDuty.get(r.duty_name)!.push(r.role_name);
        }
        for (const [k, v] of rolesByDuty) {
          rolesCounts.set(k, v.length);
          rolesByDuty.set(k, v.slice(0, 3));
        }
      }
    }

    // Build output from pre-fetched data — no DB queries inside these loops
    for (const mi of menuItems) {
      const typeLabel = mi.menu_item_type === 'menu-item-display' ? 'MenuItemDisplay'
        : mi.menu_item_type === 'menu-item-action' ? 'MenuItemAction'
        : mi.menu_item_type === 'MenuItemAction' ? 'MenuItemAction'
        : mi.menu_item_type === 'MenuItemDisplay' ? 'MenuItemDisplay'
        : mi.menu_item_type || 'MenuItem';

      output += `  ${mi.menu_item_name} (${typeLabel}):\n`;

      const privileges = privilegesByMi.get(mi.menu_item_name) || [];

      if (privileges.length === 0) {
        output += `    No privileges found granting this menu item\n`;
      } else {
        output += `    Privileges (${privileges.length}):\n`;

        for (const priv of privileges) {
          allPrivileges.add(priv.privilege_name);
          output += `      ${priv.privilege_name} [${priv.access_level}]`;

          const duties = dutiesByPrivilege.get(priv.privilege_name) || [];
          const totalDuties = dutiesCounts.get(priv.privilege_name) ?? 0;

          if (duties.length > 0) {
            output += ` → Duty: ${duties.join(', ')}`;
            if (totalDuties > 5) output += ` (+${totalDuties - 5} more)`;

            for (const dutyName of duties) {
              allDuties.add(dutyName);
              const roleNames = rolesByDuty.get(dutyName) || [];
              const totalRoles = rolesCounts.get(dutyName) ?? 0;
              for (const roleName of roleNames) allRoles.add(roleName);
              if (roleNames.length > 0) {
                output += ` → Role: ${roleNames.join(', ')}`;
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
