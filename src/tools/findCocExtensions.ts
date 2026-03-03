/**
 * Find CoC Extensions Tool
 * Locate Chain of Command (CoC) extensions and event handler subscriptions for a class or table
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

const FindCocExtensionsArgsSchema = z.object({
  className: z.string().describe('Base class or table name being extended'),
  methodName: z.string().optional().describe('Filter to a specific method name'),
  includeEventHandlers: z.boolean().optional().default(true)
    .describe('Also find static event subscriptions (SubscribesTo) for this class/table'),
});

export async function findCocExtensionsTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = FindCocExtensionsArgsSchema.parse(request.params.arguments);
    const db = context.symbolIndex.db;
    const className = args.className;
    const methodName = args.methodName;

    let output = `CoC Extensions of: ${className}\n`;
    if (methodName) output += `Filtering by method: ${methodName}\n`;
    output += '\n';

    // 1. Query extension_metadata table for class-extension records
    let extensionRows: any[] = [];
    try {
      extensionRows = db.prepare(
        `SELECT extension_name, model, base_object_name, coc_methods, added_methods, event_subscriptions
         FROM extension_metadata
         WHERE base_object_name = ? AND extension_type = 'class-extension'
         ORDER BY model, extension_name`
      ).all(className) as any[];
    } catch {
      // extension_metadata table may not exist yet
    }

    // 2. Fallback: query symbols by extends_class column
    const symbolExtensions = db.prepare(
      `SELECT name, model, file_path FROM symbols
       WHERE type = 'class-extension' AND (extends_class = ? OR name LIKE ?)
       ORDER BY model, name`
    ).all(className, `${className}%_Extension`) as any[];

    // Merge: deduplicate by extension_name
    const seen = new Set<string>();
    const allExtensions: Array<{
      name: string; model: string; cocMethods: string[]; addedMethods: string[]; eventSubs: string[];
    }> = [];

    for (const row of extensionRows) {
      if (!seen.has(row.extension_name)) {
        seen.add(row.extension_name);
        let cocMethods: string[] = [];
        let addedMethods: string[] = [];
        let eventSubs: string[] = [];
        try { cocMethods = JSON.parse(row.coc_methods || '[]'); } catch { /**/ }
        try { addedMethods = JSON.parse(row.added_methods || '[]'); } catch { /**/ }
        try { eventSubs = JSON.parse(row.event_subscriptions || '[]'); } catch { /**/ }
        allExtensions.push({ name: row.extension_name, model: row.model, cocMethods, addedMethods, eventSubs });
      }
    }

    for (const row of symbolExtensions) {
      if (!seen.has(row.name)) {
        seen.add(row.name);
        allExtensions.push({ name: row.name, model: row.model, cocMethods: [], addedMethods: [], eventSubs: [] });
      }
    }

    // Filter by methodName if provided
    const filtered = methodName
      ? allExtensions.filter(e =>
          e.cocMethods.some(m => m.toLowerCase() === methodName.toLowerCase()) ||
          e.addedMethods.some(m => m.toLowerCase() === methodName.toLowerCase()) ||
          e.cocMethods.length === 0 // include unknown ones too
        )
      : allExtensions;

    if (filtered.length === 0) {
      output += `No class extensions found for: ${className}\n`;
    } else {
      output += `Found ${filtered.length} extension class(es):\n\n`;
      for (let i = 0; i < filtered.length; i++) {
        const ext = filtered[i];
        output += `[${i + 1}] ${ext.name} (${ext.model})\n`;

        if (ext.cocMethods.length > 0) {
          const displayMethods = methodName
            ? ext.cocMethods.filter(m => m.toLowerCase() === methodName.toLowerCase())
            : ext.cocMethods;
          if (displayMethods.length > 0) {
            output += `    Wraps methods: ${displayMethods.join(', ')}\n`;
            output += `    Uses 'next' keyword: ✓\n`;
          }
        }

        if (ext.addedMethods.length > 0) {
          const newMethods = ext.addedMethods.filter(m =>
            !ext.cocMethods.some(c => c.toLowerCase() === m.toLowerCase())
          );
          if (newMethods.length > 0) {
            output += `    Added methods: ${newMethods.slice(0, 5).join(', ')}${newMethods.length > 5 ? ` (+${newMethods.length - 5} more)` : ''}\n`;
          }
        }

        if (ext.eventSubs.length > 0) {
          output += `    Event subscriptions: ${ext.eventSubs.slice(0, 3).join(', ')}${ext.eventSubs.length > 3 ? '...' : ''}\n`;
        }
      }
    }

    // 3. Event handlers via extension_metadata.event_subscriptions
    if (args.includeEventHandlers) {
      output += '\n';

      // Look for SubscribesTo references in extension_metadata
      let eventHandlerRows: any[] = [];
      try {
        eventHandlerRows = db.prepare(
          `SELECT extension_name, model, event_subscriptions FROM extension_metadata
           WHERE (event_subscriptions LIKE ? OR event_subscriptions LIKE ?)
           ORDER BY model, extension_name`
        ).all(`%classStr(${className}%`, `%tableStr(${className}%`) as any[];
      } catch { /**/ }

      // Also search symbols source_snippet for SubscribesTo patterns
      const ftsHandlers = db.prepare(
        `SELECT s.name, s.parent_name, s.model, s.source_snippet FROM symbols s
         WHERE s.type = 'method'
         AND s.source_snippet LIKE '%SubscribesTo%'
         AND (s.source_snippet LIKE ? OR s.source_snippet LIKE ?)
         ORDER BY s.model, s.parent_name, s.name
         LIMIT 20`
      ).all(`%${className}%`, `%${className}%`) as any[];

      const handlerSeen = new Set<string>();
      const allHandlers: Array<{ className: string; method: string; model: string; event?: string }> = [];

      for (const row of ftsHandlers) {
        const key = `${row.parent_name}.${row.name}`;
        if (!handlerSeen.has(key)) {
          handlerSeen.add(key);
          // Try to extract event name from SubscribesTo attribute
          let event: string | undefined;
          const match = (row.source_snippet || '').match(/delegateStr\([^,]+,\s*(\w+)\)/);
          if (match) event = match[1];
          allHandlers.push({ className: row.parent_name, method: row.name, model: row.model, event });
        }
      }

      for (const row of eventHandlerRows) {
        let subs: string[] = [];
        try { subs = JSON.parse(row.event_subscriptions || '[]'); } catch { /**/ }
        for (const sub of subs) {
          if (sub.includes(className)) {
            const key = `${row.extension_name}:${sub}`;
            if (!handlerSeen.has(key)) {
              handlerSeen.add(key);
              allHandlers.push({ className: row.extension_name, method: sub, model: row.model });
            }
          }
        }
      }

      if (allHandlers.length > 0) {
        output += `Event Handlers subscribing to ${className} events (${allHandlers.length}):\n`;
        for (const h of allHandlers) {
          output += `  ${h.className}.${h.method} [${h.model}]`;
          if (h.event) output += ` — event: ${className}.${h.event}`;
          output += '\n';
        }
      } else {
        output += `Event Handlers subscribing to ${className} events: none found\n`;
      }
    }

    return { content: [{ type: 'text', text: output }] };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error finding CoC extensions: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
