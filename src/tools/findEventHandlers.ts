/**
 * Find Event Handlers Tool
 * Locate static event handler subscriptions (SubscribesTo) and delegate subscriptions
 * for a given D365FO class or table
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { tryBridgeEventHandlers } from '../bridge/index.js';

const FindEventHandlersArgsSchema = z.object({
  targetClass: z.string().optional().describe('Class whose events to find handlers for'),
  targetTable: z.string().optional().describe('Table whose events to find handlers for'),
  eventName: z.string().optional()
    .describe('Filter to a specific event name (e.g. onInserted, onValidatedWrite, onPostRun)'),
  handlerType: z.enum(['static', 'delegate', 'all']).optional().default('all')
    .describe('Filter by handler type (static=SubscribesTo delegates, delegate=delegate += syntax, all=both)'),
});

export async function findEventHandlersTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = FindEventHandlersArgsSchema.parse(request.params.arguments);

    if (!args.targetClass && !args.targetTable) {
      return {
        content: [{ type: 'text', text: 'Provide at least one of: targetClass, targetTable' }],
        isError: true,
      };
    }

    const targetName = args.targetClass || args.targetTable!;

    // ── Bridge fast-path (DYNAMICSXREFDB) ──
    // When no specific eventName or handlerType filter is used, xref is a good source
    if (!args.eventName && args.handlerType === 'all') {
      const bridgeResult = await tryBridgeEventHandlers(context.bridge, targetName);
      if (bridgeResult) return bridgeResult;
    }

    // ── Fallback: SQLite index ──
    const db = context.symbolIndex.db;
    const isTable = !!args.targetTable;

    let output = `Event Handlers for: ${targetName} (${isTable ? 'table' : 'class'} events)\n`;
    if (args.eventName) output += `Filtering by event: ${args.eventName}\n`;
    output += '\n';

    // ── 1. Static event handlers via extension_metadata.event_subscriptions ──
    let metaHandlers: any[] = [];
    if (args.handlerType !== 'delegate') {
      try {
        metaHandlers = db.prepare(
          `SELECT extension_name, model, event_subscriptions
           FROM extension_metadata
           WHERE (event_subscriptions LIKE ? OR event_subscriptions LIKE ?)
           ORDER BY model, extension_name`
        ).all(`%classStr(${targetName}%`, `%tableStr(${targetName}%`) as any[];
      } catch (e) {
        // extension_metadata table may not exist in older databases — non-fatal
        if (process.env.DEBUG_LOGGING === 'true') console.warn('[findEventHandlers] extension_metadata query failed:', e);
      }
    }

    // ── 2. FTS search on source_snippet for SubscribesTo ──
    const subLike1 = `%SubscribesTo(classStr(${targetName}%`;
    const subLike2 = `%SubscribesTo(tableStr(${targetName}%`;
    const subLike3 = `%SubscribesTo(formStr(${targetName}%`;

    let ftsHandlers: any[] = [];
    if (args.handlerType !== 'delegate') {
      ftsHandlers = db.prepare(
        `SELECT name, parent_name, model, source_snippet FROM symbols
         WHERE type = 'method'
         AND source_snippet LIKE '%SubscribesTo%'
         AND (source_snippet LIKE ? OR source_snippet LIKE ? OR source_snippet LIKE ?)
         ORDER BY model, parent_name, name
         LIMIT 50`
      ).all(subLike1, subLike2, subLike3) as any[];
    }

    // ── 3. Delegate subscription search (+= syntax) ──
    let delegateHandlers: any[] = [];
    if (args.handlerType !== 'static') {
      delegateHandlers = db.prepare(
        `SELECT name, parent_name, model, source_snippet FROM symbols
         WHERE type = 'method'
         AND source_snippet LIKE ?
         ORDER BY model, parent_name, name
         LIMIT 20`
      ).all(`%${targetName}.on%+=% `) as any[];

      // Also: find methods with body referencing delegate attach
      const delegateHandlers2 = db.prepare(
        `SELECT name, parent_name, model, source_snippet FROM symbols
         WHERE type = 'method'
         AND source_snippet LIKE ?
         ORDER BY model, parent_name, name
         LIMIT 20`
      ).all(`%${targetName}%.on%`) as any[];

      for (const h of delegateHandlers2) {
        if (!(delegateHandlers.some(d => d.name === h.name && d.parent_name === h.parent_name))) {
          delegateHandlers.push(h);
        }
      }
    }

    // ── Build grouped output by event name ──
    interface HandlerEntry {
      handlerClass: string;
      handlerMethod: string;
      model: string;
      event?: string;
      type: 'static' | 'delegate';
    }

    const byEvent = new Map<string, HandlerEntry[]>();

    const addHandler = (entry: HandlerEntry) => {
      const key = entry.event || '(unknown event)';
      if (!byEvent.has(key)) byEvent.set(key, []);
      // Deduplicate
      const list = byEvent.get(key)!;
      if (!list.some(e => e.handlerClass === entry.handlerClass && e.handlerMethod === entry.handlerMethod)) {
        list.push(entry);
      }
    };

    // Parse FTS handlers
    for (const h of ftsHandlers) {
      // Extract event name from SubscribesTo attribute:
      // [SubscribesTo(tableStr(CustTable), delegateStr(CustTable, onInserted))]
      const delegateMatch = (h.source_snippet || '').match(/delegateStr\([^,]+,\s*(\w+)\)/);
      const eventN = delegateMatch ? delegateMatch[1] : undefined;

      if (args.eventName && eventN && eventN.toLowerCase() !== args.eventName.toLowerCase()) continue;

      addHandler({
        handlerClass: h.parent_name || '(unknown)',
        handlerMethod: h.name,
        model: h.model,
        event: eventN,
        type: 'static',
      });
    }

    // Parse metadata handlers
    for (const row of metaHandlers) {
      let subs: string[] = [];
      try { subs = JSON.parse(row.event_subscriptions || '[]'); } catch { /**/ }
      for (const sub of subs) {
        if (sub.includes(targetName)) {
          const evMatch = sub.match(/delegateStr\([^,]+,\s*(\w+)\)/);
          const eventN = evMatch ? evMatch[1] : undefined;
          if (args.eventName && eventN && eventN.toLowerCase() !== args.eventName.toLowerCase()) continue;
          addHandler({ handlerClass: row.extension_name, handlerMethod: sub, model: row.model, event: eventN, type: 'static' });
        }
      }
    }

    // Parse delegate handlers
    for (const h of delegateHandlers) {
      const delegateMatch = (h.source_snippet || '').match(new RegExp(`${targetName}\\.(\\w+)\\s*\\+\\s*=`));
      const eventN = delegateMatch ? delegateMatch[1] : undefined;
      if (args.eventName && eventN && eventN.toLowerCase() !== args.eventName.toLowerCase()) continue;
      addHandler({ handlerClass: h.parent_name || h.name, handlerMethod: h.name, model: h.model, event: eventN, type: 'delegate' });
    }

    if (byEvent.size === 0) {
      output += `No event handlers found for ${targetName}.\n`;
      output += `\nNote: Handler detection requires source_snippet indexing.`;
      output += `\nFor tables, standard events are: onInserted, onUpdated, onDeleted, onValidatedWrite, onValidatedInsert, onValidatedDelete, onInitialized, onInitValue\n`;
    } else {
      // Separate static vs delegate for output
      const staticByEvent: typeof byEvent = new Map();
      const delegateByEvent: typeof byEvent = new Map();

      for (const [event, handlers] of byEvent) {
        const statics = handlers.filter(h => h.type === 'static');
        const delegates = handlers.filter(h => h.type === 'delegate');
        if (statics.length > 0) staticByEvent.set(event, statics);
        if (delegates.length > 0) delegateByEvent.set(event, delegates);
      }

      if (staticByEvent.size > 0) {
        output += `Static Event Handlers (SubscribesTo):\n`;
        for (const [event, handlers] of staticByEvent) {
          output += `  [${event}]\n`;
          for (const h of handlers) {
            output += `    ${h.handlerClass}.${h.handlerMethod} [${h.model}]\n`;
          }
        }
      }

      if (delegateByEvent.size > 0) {
        output += `\nDelegate Subscriptions:\n`;
        for (const [event, handlers] of delegateByEvent) {
          output += `  ${targetName}.${event} →\n`;
          for (const h of handlers) {
            output += `    ${h.handlerClass}.${h.handlerMethod} [${h.model}]\n`;
          }
        }
      }
    }

    return { content: [{ type: 'text', text: output }] };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error finding event handlers: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
