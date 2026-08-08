/**
 * Find Event Handlers Tool
 * Locate static event handler subscriptions (SubscribesTo) and delegate subscriptions
 * for a given D365FO class or table
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { tryBridgeEventHandlers } from '../../bridge/index.js';

const FindEventHandlersArgsSchema = z.object({
  targetClass: z.string().optional().describe('Class whose events to find handlers for'),
  targetTable: z.string().optional().describe('Table whose events to find handlers for'),
  eventName: z.string().optional()
    .describe('Filter to a specific event name (e.g. onInserted, onValidatedWrite, onPostRun)'),
  handlerType: z.enum(['static', 'delegate', 'all']).optional().default('all')
    .describe('Filter by handler type (static=SubscribesTo delegates, delegate=delegate += syntax, all=both)'),
});

/**
 * Methods whose body matches `pattern`, narrowed to those that mention
 * `targetName` at all.
 *
 * The static-handler search above already goes through symbols_fts; the delegate
 * search did not, and it carried both halves of the same defect the EDT and
 * api-usage queries had. `source_snippet LIKE '%X%.on%'` cannot use an index, and
 * ORDER BY forces every match to be read and sorted before LIMIT 20 applies —
 * so the cost is paid over all 627 K method rows, each carrying source_snippet
 * in overflow pages. Measured on the 2 GB index (warm): 3.2 s and 2.3 s for the
 * two patterns, i.e. ~5.5 s of blocked event loop per call, since node:sqlite is
 * synchronous.
 *
 * The FTS pre-filter is also more accurate here, not just faster. LIKE matches
 * substrings, so `%SalesTable%.on%` reported SalesLine.setAddressFromSalesTable_BR
 * — a method that merely has the name inside a longer identifier and subscribes
 * to nothing. FTS matches tokens, so it drops exactly that row. Measured: 0–51 ms,
 * and every row it excluded for SalesTable/InventTable was such a false positive.
 *
 * Falls back to the unfiltered query when the index predates symbols_fts, which
 * is what the static branch does too.
 */
function delegateSearch(rdb: any, targetName: string, pattern: string): any[] {
  const SELECT = `SELECT name, parent_name, model, source_snippet FROM symbols
                   WHERE type = 'method'`;
  const TAIL = ` ORDER BY model, parent_name, name LIMIT 20`;

  const safe = targetName.replace(/["\(\)\\]/g, '').trim();
  if (safe) {
    try {
      return rdb.prepare(
        `${SELECT}
           AND id IN (SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ?)
           AND source_snippet LIKE ?${TAIL}`
      ).all(`{source_snippet} : "${safe}"`, pattern) as any[];
    } catch {
      // No FTS table (older index) — fall through.
    }
  }
  try {
    return rdb.prepare(`${SELECT} AND source_snippet LIKE ?${TAIL}`).all(pattern) as any[];
  } catch {
    return [];
  }
}

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

    // Bridge fast-path (DYNAMICSXREFDB): supports eventName and handlerType filtering directly in C#
    const bridgeResult = await tryBridgeEventHandlers(
      context.bridge,
      targetName,
      args.eventName,
      args.handlerType,
    );
    if (bridgeResult) return bridgeResult;

    // Fallback: SQLite index
    const rdb = context.symbolIndex.getReadDb();
    const isTable = !!args.targetTable;

    let output = `Event Handlers for: ${targetName} (${isTable ? 'table' : 'class'} events)\n`;
    if (args.eventName) output += `Filtering by event: ${args.eventName}\n`;
    output += '\n';

    // Static event handlers via extension_metadata.event_subscriptions
    let metaHandlers: any[] = [];
    if (args.handlerType !== 'delegate') {
      try {
        metaHandlers = rdb.prepare(
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

    // FTS5 search for SubscribesTo (replaces LIKE full-table scan)
    let ftsHandlers: any[] = [];
    if (args.handlerType !== 'delegate') {
      try {
        ftsHandlers = rdb.prepare(
          `SELECT s.name, s.parent_name, s.model, s.source_snippet
           FROM symbols_fts fts JOIN symbols s ON s.id = fts.rowid
           WHERE symbols_fts MATCH 'source_snippet:SubscribesTo'
           AND s.type = 'method'
           AND (s.source_snippet LIKE ? OR s.source_snippet LIKE ? OR s.source_snippet LIKE ?)
           ORDER BY s.model, s.parent_name, s.name
           LIMIT 50`
        ).all(
          `%SubscribesTo(classStr(${targetName}%`,
          `%SubscribesTo(tableStr(${targetName}%`,
          `%SubscribesTo(formStr(${targetName}%`
        ) as any[];
      } catch {
        // FTS5 query failed — fallback to LIKE
        ftsHandlers = rdb.prepare(
          `SELECT name, parent_name, model, source_snippet FROM symbols
           WHERE type = 'method'
           AND source_snippet LIKE '%SubscribesTo%'
           AND (source_snippet LIKE ? OR source_snippet LIKE ? OR source_snippet LIKE ?)
           ORDER BY model, parent_name, name
           LIMIT 50`
        ).all(
          `%SubscribesTo(classStr(${targetName}%`,
          `%SubscribesTo(tableStr(${targetName}%`,
          `%SubscribesTo(formStr(${targetName}%`
        ) as any[];
      }
    }

    // Delegate subscription search (+= syntax)
    let delegateHandlers: any[] = [];
    if (args.handlerType !== 'static') {
      delegateHandlers = delegateSearch(rdb, targetName, `%${targetName}.on%+=% `);

      // Also: find methods with body referencing delegate attach
      const delegateHandlers2 = delegateSearch(rdb, targetName, `%${targetName}%.on%`);

      for (const h of delegateHandlers2) {
        if (!(delegateHandlers.some(d => d.name === h.name && d.parent_name === h.parent_name))) {
          delegateHandlers.push(h);
        }
      }
    }

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
