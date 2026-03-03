/**
 * Analyze Extension Points Tool
 * Show available CoC/event extension points for a D365FO class or table,
 * distinguishing eligible methods from blocked ones, and showing existing extensions
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

// Standard D365FO table events available for subscription
const TABLE_STANDARD_EVENTS = [
  'onInserted', 'onUpdated', 'onDeleted',
  'onValidatedWrite', 'onValidatedInsert', 'onValidatedDelete',
  'onInitialized', 'onInitValue',
];

const AnalyzeExtensionPointsArgsSchema = z.object({
  objectName: z.string().describe('Class or table name to analyze extension points for'),
  objectType: z.enum(['class', 'table', 'form', 'auto']).optional().default('auto')
    .describe('Object type (auto=detect from symbol index)'),
  showExistingExtensions: z.boolean().optional().default(true)
    .describe('Show which extension points are already wrapped/subscribed by existing extensions'),
});

export async function analyzeExtensionPointsTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = AnalyzeExtensionPointsArgsSchema.parse(request.params.arguments);
    const db = context.symbolIndex.db;
    const objName = args.objectName;

    // ── Step 1: Resolve object type ──
    let resolvedType = args.objectType;
    if (resolvedType === 'auto') {
      const sym = db.prepare(
        `SELECT type FROM symbols WHERE name = ? AND type IN ('class','table','form')
         ORDER BY CASE type WHEN 'class' THEN 0 WHEN 'table' THEN 1 WHEN 'form' THEN 2 END LIMIT 1`
      ).get(objName) as any;
      if (sym) resolvedType = sym.type as any;
    }

    const baseSymbol = db.prepare(
      `SELECT name, type, model, file_path FROM symbols WHERE name = ? AND type = ? LIMIT 1`
    ).get(objName, resolvedType === 'auto' ? 'class' : resolvedType) as any;

    let output = `Extension Points for: ${objName}`;
    if (resolvedType !== 'auto') output += ` (${resolvedType})`;
    if (baseSymbol) output += ` — ${baseSymbol.model}`;
    output += '\n\n';

    // ── Step 2: Load existing extension data ──
    let existingExtensions: any[] = [];
    if (args.showExistingExtensions) {
      try {
        const extType = resolvedType === 'auto' ? '%' : `${resolvedType}-extension`;
        existingExtensions = db.prepare(
          `SELECT extension_name, model, coc_methods, event_subscriptions, added_methods
           FROM extension_metadata
           WHERE base_object_name = ? AND extension_type LIKE ?
           ORDER BY model, extension_name`
        ).all(objName, extType) as any[];
      } catch { /**/ }
    }

    // Build maps of already-extended methods and subscribed events
    const alreadyWrapped = new Map<string, string[]>(); // methodName → [extName, ...]
    const alreadySubscribed = new Map<string, string[]>(); // eventName → [handlerClass, ...]

    for (const ext of existingExtensions) {
      let cocMethods: string[] = [];
      let eventSubs: string[] = [];
      try { cocMethods = JSON.parse(ext.coc_methods || '[]'); } catch { /**/ }
      try { eventSubs = JSON.parse(ext.event_subscriptions || '[]'); } catch { /**/ }

      for (const m of cocMethods) {
        const key = m.toLowerCase();
        if (!alreadyWrapped.has(key)) alreadyWrapped.set(key, []);
        alreadyWrapped.get(key)!.push(ext.extension_name);
      }
      for (const ev of eventSubs) {
        const delegateMatch = ev.match(/delegateStr\([^,]+,\s*(\w+)\)/);
        if (delegateMatch) {
          const evName = delegateMatch[1];
          if (!alreadySubscribed.has(evName)) alreadySubscribed.set(evName, []);
          alreadySubscribed.get(evName)!.push(ext.extension_name);
        }
      }
    }

    // Also scan symbols for SubscribesTo for this object
    try {
      const subHandlers = db.prepare(
        `SELECT name, parent_name, source_snippet FROM symbols
         WHERE type='method' AND source_snippet LIKE '%SubscribesTo%' AND source_snippet LIKE ?
         LIMIT 30`
      ).all(`%${objName}%`) as any[];

      for (const h of subHandlers) {
        const delegateMatch = (h.source_snippet || '').match(/delegateStr\([^,]+,\s*(\w+)\)/);
        if (delegateMatch) {
          const evName = delegateMatch[1];
          if (!alreadySubscribed.has(evName)) alreadySubscribed.set(evName, []);
          const label = `${h.parent_name}.${h.name}`;
          if (!alreadySubscribed.get(evName)!.includes(label)) {
            alreadySubscribed.get(evName)!.push(label);
          }
        }
      }
    } catch { /**/ }

    // ── Step 3: For classes — analyze methods ──
    if (resolvedType === 'class' || resolvedType === 'auto') {
      const methods = db.prepare(
        `SELECT name, signature, source_snippet FROM symbols
         WHERE parent_name = ? AND type = 'method'
         ORDER BY name`
      ).all(objName) as any[];

      if (methods.length > 0) {
        const cocEligible: any[] = [];
        const blocked: any[] = [];
        const delegates: any[] = [];
        const replaceables: any[] = [];

        for (const m of methods) {
          const sig = (m.signature || '').toLowerCase();
          const src = (m.source_snippet || '').toLowerCase();

          if (src.includes('delegate ') || sig.includes('delegate ')) {
            delegates.push(m);
          } else if (src.includes('[hookable(false)]') || src.includes('hookable(false)')) {
            blocked.push({ ...m, reason: 'Hookable(false)' });
          } else if (sig.includes('final ') || src.includes('\nfinal ')) {
            blocked.push({ ...m, reason: 'final' });
          } else if (src.includes('[replaceable]') || src.includes('replaceable]')) {
            replaceables.push(m);
          } else if (sig.includes('public ') || sig.includes('protected ')) {
            // CoC eligible: public or protected, non-final
            cocEligible.push(m);
          }
        }

        if (cocEligible.length > 0) {
          output += `CoC-eligible methods (${cocEligible.length}):\n`;
          for (const m of cocEligible.slice(0, 20)) {
            const wrappedBy = alreadyWrapped.get(m.name.toLowerCase());
            const status = wrappedBy
              ? `EXTENDED by ${wrappedBy.slice(0, 2).join(', ')}${wrappedBy.length > 2 ? '...' : ''}`
              : 'not yet extended';
            output += `  ✓ ${m.name}()\t[${status}]\n`;
          }
          if (cocEligible.length > 20) {
            output += `  ... and ${cocEligible.length - 20} more methods\n`;
          }
          output += '\n';
        }

        if (replaceables.length > 0) {
          output += `Replaceable methods (${replaceables.length}):\n`;
          for (const m of replaceables) {
            output += `  ↔ ${m.name}() [Replaceable — can be completely replaced]\n`;
          }
          output += '\n';
        }

        if (delegates.length > 0) {
          output += `Delegate hooks (${delegates.length}):\n`;
          for (const m of delegates) {
            const subscribedBy = alreadySubscribed.get(m.name);
            output += `  ⚡ ${m.name}`;
            if (subscribedBy && subscribedBy.length > 0) {
              output += ` → ${subscribedBy.length} subscriber(s): ${subscribedBy.slice(0, 2).join(', ')}`;
            } else {
              output += ` → 0 subscribers`;
            }
            output += '\n';
          }
          output += '\n';
        }

        if (blocked.length > 0) {
          output += `Blocked methods (${blocked.length}):\n`;
          for (const m of blocked.slice(0, 10)) {
            output += `  ✗ ${m.name}() [${m.reason} — cannot wrap]\n`;
          }
          if (blocked.length > 10) output += `  ... and ${blocked.length - 10} more\n`;
          output += '\n';
        }
      }
    }

    // ── Step 4: For tables — show standard events ──
    if (resolvedType === 'table' || resolvedType === 'auto') {
      output += `Table Events (${TABLE_STANDARD_EVENTS.length} standard hooks):\n`;
      for (const ev of TABLE_STANDARD_EVENTS) {
        const subscribers = alreadySubscribed.get(ev) || [];
        // Also check FTS
        if (subscribers.length === 0) {
          try {
            const ftsCheck = db.prepare(
              `SELECT COUNT(*) as cnt FROM symbols WHERE type='method'
               AND source_snippet LIKE ? AND source_snippet LIKE ?`
            ).get(`%SubscribesTo%`, `%${ev}%`) as any;
            output += `  ${ev.padEnd(22)} [${ftsCheck?.cnt > 0 ? `~${ftsCheck.cnt} handler(s)` : '0 handlers'}]\n`;
          } catch {
            output += `  ${ev.padEnd(22)} [${subscribers.length} handler(s)]\n`;
          }
        } else {
          output += `  ${ev.padEnd(22)} [${subscribers.length} handler(s): ${subscribers.slice(0, 2).join(', ')}]\n`;
        }
      }

      // Also check custom delegates on the table class
      const tableMethods = db.prepare(
        `SELECT name, source_snippet FROM symbols
         WHERE parent_name = ? AND type = 'method'
         AND (source_snippet LIKE '%delegate %' OR signature LIKE '%delegate %')
         LIMIT 10`
      ).all(objName) as any[];

      if (tableMethods.length > 0) {
        output += `\nCustom delegates (${tableMethods.length}):\n`;
        for (const m of tableMethods) {
          const subCount = alreadySubscribed.get(m.name)?.length ?? 0;
          output += `  ⚡ ${m.name} → ${subCount} subscriber(s)\n`;
        }
      }
    }

    // ── Step 5: For forms — show data sources and methods ──
    if (resolvedType === 'form') {
      const formDataSources = db.prepare(
        `SELECT name FROM symbols WHERE parent_name = ? AND type = 'datasource' ORDER BY name`
      ).all(objName) as any[];

      if (formDataSources.length > 0) {
        output += `Form Data Sources (${formDataSources.length}):\n`;
        for (const ds of formDataSources) {
          output += `  ${ds.name} — table events apply + datasource methods extensible\n`;
        }
        output += '\n';
      }

      const formMethods = db.prepare(
        `SELECT name FROM symbols WHERE parent_name = ? AND type = 'method' ORDER BY name LIMIT 20`
      ).all(objName) as any[];

      if (formMethods.length > 0) {
        output += `Form methods (${formMethods.length} shown, CoC-eligible via form extension):\n`;
        output += `  ${formMethods.slice(0, 10).map((m: any) => m.name + '()').join(', ')}`;
        if (formMethods.length > 10) output += ` (+${formMethods.length - 10} more)`;
        output += '\n';
      }
    }

    // ── Summary of existing extensions ──
    if (args.showExistingExtensions && existingExtensions.length > 0) {
      output += `\nExisting extensions (${existingExtensions.length}):\n`;
      for (const ext of existingExtensions) {
        output += `  ${ext.extension_name} [${ext.model}]\n`;
      }
    }

    return { content: [{ type: 'text', text: output }] };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error analyzing extension points: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
