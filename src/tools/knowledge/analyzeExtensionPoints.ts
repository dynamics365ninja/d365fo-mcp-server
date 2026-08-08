/**
 * Analyze Extension Points Tool
 * Show available CoC/event extension points for a D365FO class or table,
 * distinguishing eligible methods from blocked ones, and showing existing extensions
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { getConfigManager } from '../../utils/configManager.js';
import { scanFsExtensions, EXTENSION_FOLDER_CONFIG } from '../../utils/fsExtensionScanner.js';
import { canonicalSymbolName } from '../../utils/symbolLookup.js';
import { inheritanceAncestors } from '../../utils/inheritanceChain.js';
import type { BridgeClient } from '../../bridge/bridgeClient.js';

/**
 * Access modifiers straight from IMetadataProvider, keyed by lowercase method
 * name, with the nearest declaration winning.
 *
 * Why this exists rather than trusting the snippet heuristic below: the indexed
 * `source_snippet` is truncated, and measured over 40k indexed methods it stops
 * *before* the declaration line for 11.9% of them — the heuristic is simply
 * blind there and defaults them to public. `SalesFormLetter_Invoice.description()`
 * is one: `private static`, but its snippet is 88 characters of doc comment. The
 * bridge carries the real visibility, so it is the authority whenever it is up.
 *
 * One unreadable class is skipped rather than aborting: a partial map still
 * beats falling back to the heuristic for every method.
 */
async function readVisibility(
  bridge: BridgeClient | undefined,
  classNames: string[],
): Promise<Map<string, string>> {
  const byMethod = new Map<string, string>();
  if (!bridge?.isReady || !bridge.metadataAvailable) return byMethod;
  for (const name of classNames) {
    let info;
    try {
      // getCompletionMembers, NOT readClass: the C# MethodInfoModel behind
      // readClass carries only name/source/isStatic, so BridgeMethodInfo's
      // `visibility` is never populated and reading it yields nothing.
      // GetCompletionMembers builds each signature from the declaration line,
      // so the modifier is right there in the string.
      info = await bridge.getCompletionMembers(name);
    } catch (e) {
      console.error(`[analyzeExtensionPoints] getCompletionMembers(${name}) failed: ${e}`);
      continue;
    }
    for (const m of info?.members ?? []) {
      if (m.kind !== 'method') continue;
      const key = m.name?.toLowerCase();
      if (!key || byMethod.has(key)) continue;
      const visibility = parseVisibility(m.signature);
      if (visibility) byMethod.set(key, visibility);
    }
  }
  return byMethod;
}

/**
 * Access modifier out of a declaration-line signature such as
 * `private static ClassDescription description()`.
 *
 * Only the part before the parameter list is considered — a default parameter
 * value is arbitrary X++ and could contain any of these words.
 */
function parseVisibility(signature?: string | null): string | undefined {
  if (!signature) return undefined;
  const head = signature.split('(')[0];
  const m = /\b(public|protected|private|internal)\b/i.exec(head);
  return m ? m[1].toLowerCase() : undefined;
}

/** Bridge visibility when known, else the snippet heuristic. */
function isPrivateMethod(
  name: string,
  signature: string,
  sourceSnippet: string,
  visibility: Map<string, string>,
): boolean {
  const known = visibility.get(name.toLowerCase());
  if (known) return known === 'private';
  return isPrivate(signature, sourceSnippet, name);
}

/**
 * Whether a method is declared private, and therefore not CoC-wrappable.
 * Fallback for when the bridge is down — see readVisibility for the accurate path.
 *
 * The indexed `signature` carries no access modifier (it is built as
 * `returnType name(params)`), so the only place a modifier survives is the
 * stored source snippet. That snippet opens with the doc comment, so scan for
 * the declaration line — the one naming the method before its parenthesis —
 * rather than searching the whole blob, where the word "private" could easily
 * come from prose in a `/// <remarks>`.
 *
 * Unknown means not private: X++ methods default to public, and hiding a
 * genuine extension point is worse than listing one the compiler later rejects.
 */
function isPrivate(signature: string, sourceSnippet: string, methodName: string): boolean {
  if (!sourceSnippet) return false;
  const needle = methodName.toLowerCase();
  for (const rawLine of sourceSnippet.split('\n')) {
    const line = rawLine.toLowerCase();
    const at = line.indexOf(needle);
    if (at === -1) continue;
    if (!/^\s*\(/.test(line.slice(at + needle.length))) continue; // not the declaration
    if (line.trimStart().startsWith('///')) continue;             // doc comment
    return /\bprivate\b/.test(line.slice(0, at));
  }
  // No declaration line inside the snippet — fall back to the signature, which
  // only carries a modifier for the rare rows that stored one.
  return /\bprivate\b/.test(signature);
}

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
  // Default OFF: enumerating existing extensions can roughly double the response size.
  // Opt in only when you want to see who already wraps/subscribes.
  showExistingExtensions: z.boolean().optional().default(false)
    .describe('Show which extension points are already wrapped/subscribed by existing extensions (opt-in)'),
});

export async function analyzeExtensionPointsTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = AnalyzeExtensionPointsArgsSchema.parse(request.params.arguments);
    const rdb = context.symbolIndex.getReadDb();
    // Resolve the caller's casing to the canonical AOT name once (#686) — the
    // method/datasource probes below are parent-scoped on this name.
    const objName = canonicalSymbolName(
      rdb,
      args.objectName,
      args.objectType === 'auto' ? ['class', 'table', 'form'] : [args.objectType],
    ) ?? args.objectName;

    // Resolve object type
    let resolvedType = args.objectType;
    if (resolvedType === 'auto') {
      const sym = rdb.prepare(
        `SELECT type FROM symbols WHERE name = ? AND type IN ('class','table','form')
         ORDER BY CASE type WHEN 'class' THEN 0 WHEN 'table' THEN 1 WHEN 'form' THEN 2 END LIMIT 1`
      ).get(objName) as any;
      if (sym) resolvedType = sym.type as any;
    }

    const baseSymbol = rdb.prepare(
      `SELECT name, type, model, file_path FROM symbols WHERE name = ? AND type = ? LIMIT 1`
    ).get(objName, resolvedType === 'auto' ? 'class' : resolvedType) as any;

    let output = `Extension Points for: ${objName}`;
    if (resolvedType !== 'auto') output += ` (${resolvedType})`;
    if (baseSymbol) output += ` — ${baseSymbol.model}`;
    output += '\n\n';

    // Load existing extension data
    let existingExtensions: any[] = [];
    if (args.showExistingExtensions) {
      try {
        const extType = resolvedType === 'auto' ? '%' : `${resolvedType}-extension`;
        existingExtensions = rdb.prepare(
          `SELECT extension_name, model, coc_methods, event_subscriptions, added_methods
           FROM extension_metadata
           WHERE base_object_name = ? AND extension_type LIKE ?
           ORDER BY model, extension_name`
        ).all(objName, extType) as any[];
      } catch (e) {
        // extension_metadata table may not exist in older databases — non-fatal
        if (process.env.DEBUG_LOGGING === 'true') console.warn('[analyzeExtensionPoints] extension_metadata query failed:', e);
      }

      // Bridge enrichment: when the DB index has no extension_metadata, try the C# bridge
      // (DYNAMICSXREFDB), which provides compiler-resolved extension data with method-level CoC detail.
      if (existingExtensions.length === 0 && context.bridge?.isReady && context.bridge.xrefAvailable) {
        try {
          const bridgeExts = await context.bridge.findExtensionClasses(objName);
          if (bridgeExts && bridgeExts.count > 0) {
            existingExtensions = bridgeExts.extensions.map((ext: any) => ({
              extension_name: ext.className,
              model: ext.module || '(xref)',
              coc_methods: JSON.stringify(ext.wrappedMethods || []),
              event_subscriptions: '[]',
              added_methods: '[]',
              _fromBridge: true,
            }));
          }
        } catch { /* non-fatal */ }
      }

      // Filesystem fallback: when the DB index has no extension_metadata for this object
      // (e.g. an unindexed custom model), scan Ax*Extension XML files directly.
      if (existingExtensions.length === 0 && resolvedType !== 'auto' && process.platform === 'win32') {
        const extTypeName = `${resolvedType}-extension`;
        if (EXTENSION_FOLDER_CONFIG[extTypeName]) {
          try {
            const configManager = getConfigManager();
            const packagePath = configManager.getPackagePath();
            if (packagePath) {
              const fsExts = await scanFsExtensions(objName, extTypeName, packagePath);
              if (fsExts.length > 0) {
                existingExtensions = fsExts.map(e => ({
                  extension_name: e.name,
                  model: e.model,
                  coc_methods: JSON.stringify(e.cocMethods),
                  event_subscriptions: '[]',
                  added_methods: JSON.stringify(e.addedMethods),
                  _fromFs: true,
                }));
              }
            }
          } catch { /* non-fatal */ }
        }
      }
    }

    const extensionsFromFs = existingExtensions.some((e: any) => e._fromFs);
    const extensionsFromBridge = existingExtensions.some((e: any) => e._fromBridge);

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
      const subHandlers = rdb.prepare(
        `SELECT s.name, s.parent_name, s.source_snippet FROM symbols_fts fts
         JOIN symbols s ON s.id = fts.rowid
         WHERE symbols_fts MATCH 'source_snippet:SubscribesTo' AND s.type = 'method'
         AND s.source_snippet LIKE ?
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
    } catch (e) {
      // symbols scan is supplemental — non-fatal if it fails
      if (process.env.DEBUG_LOGGING === 'true') console.warn('[analyzeExtensionPoints] symbols SubscribesTo scan failed:', e);
    }

    // For classes — analyze methods
    if (resolvedType === 'class' || resolvedType === 'auto') {
      const methodStmt = rdb.prepare(
        `SELECT name, signature, source_snippet FROM symbols
         WHERE parent_name = ? AND type = 'method'
         ORDER BY name`
      );
      const methods = methodStmt.all(objName) as any[];

      // Inherited methods are extension points too — CoC can wrap a method the
      // augmented class only inherits (verified against xppc; see the
      // class-inheritance knowledge topic). Listing declared members only made
      // this tool report almost nothing for leaf classes, which are exactly the
      // ones people extend. Nearest ancestor wins on a name clash (an override).
      const ancestorNames = inheritanceAncestors(rdb, objName);
      const seenMethods = new Set(methods.map(m => String(m.name).toLowerCase()));
      for (const ancestor of ancestorNames) {
        for (const m of methodStmt.all(ancestor) as any[]) {
          const key = String(m.name).toLowerCase();
          if (seenMethods.has(key)) continue;
          seenMethods.add(key);
          methods.push({ ...m, inheritedFrom: ancestor });
        }
      }
      methods.sort((a, b) => String(a.name).localeCompare(String(b.name)));

      // Real access modifiers, when the bridge is up. The snippet heuristic
      // below is blind for ~12% of methods (see readVisibility), so this is
      // what makes the private filter exact rather than approximate.
      const visibility = await readVisibility(context.bridge, [objName, ...ancestorNames]);

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
          } else if (!isPrivateMethod(String(m.name), sig, src, visibility)) {
            // CoC eligible: anything not private, not final, not blocked.
            //
            // This used to test `sig.includes('public ')`, but the indexed
            // signature is built as `returnType name(params)` with NO access
            // modifier (see symbolIndex.indexClasses), so that test could never
            // be true and the tool reported ZERO eligible methods for every
            // class in the AOT. X++ methods default to public, so "not private"
            // is both correct and the only thing the index can actually answer.
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
            const origin = m.inheritedFrom ? `\tinherited from ${m.inheritedFrom}` : '';
            output += `  ✓ ${m.name}()\t[${status}]${origin}\n`;
          }
          if (cocEligible.length > 20) {
            output += `  ... and ${cocEligible.length - 20} more methods\n`;
          }
          if (cocEligible.some(m => m.inheritedFrom)) {
            output += `  ℹ️ Inherited entries can be wrapped either on ${objName} (affects only it) ` +
              `or on the class that declares them (affects every subclass). Either way the wrapper ` +
              `signature must match the DECLARING class.\n`;
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

    // For tables — show standard events
    if (resolvedType === 'table' || resolvedType === 'auto') {
      // Single FTS5 query for all standard events instead of one LIKE scan per event.
      const eventHandlerCounts = new Map<string, number>();
      try {
        const allEvHandlers = rdb.prepare(
          `SELECT s.source_snippet FROM symbols_fts fts
           JOIN symbols s ON s.id = fts.rowid
           WHERE symbols_fts MATCH 'source_snippet:SubscribesTo'
           AND s.type = 'method'
           AND s.source_snippet LIKE ?
           LIMIT 200`
        ).all(`%${objName}%`) as any[];

        for (const row of allEvHandlers) {
          const src = row.source_snippet || '';
          for (const ev of TABLE_STANDARD_EVENTS) {
            if (src.includes(ev)) {
              eventHandlerCounts.set(ev, (eventHandlerCounts.get(ev) || 0) + 1);
            }
          }
        }
      } catch { /* FTS5 query failed — non-fatal, counts stay 0 */ }

      output += `Table Events (${TABLE_STANDARD_EVENTS.length} standard hooks):\n`;
      for (const ev of TABLE_STANDARD_EVENTS) {
        const subscribers = alreadySubscribed.get(ev) || [];
        const ftsCount = eventHandlerCounts.get(ev) || 0;
        const totalCount = Math.max(subscribers.length, ftsCount);
        if (subscribers.length > 0) {
          output += `  ${ev.padEnd(22)} [${subscribers.length} handler(s): ${subscribers.slice(0, 2).join(', ')}]\n`;
        } else {
          output += `  ${ev.padEnd(22)} [${totalCount > 0 ? `~${totalCount} handler(s)` : '0 handlers'}]\n`;
        }
      }

      // Also check custom delegates on the table class
      const tableMethods = rdb.prepare(
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

    // For forms — show data sources and methods
    if (resolvedType === 'form') {
      const formDataSources = rdb.prepare(
        `SELECT name FROM symbols WHERE parent_name = ? AND type = 'datasource' ORDER BY name`
      ).all(objName) as any[];

      if (formDataSources.length > 0) {
        output += `Form Data Sources (${formDataSources.length}):\n`;
        for (const ds of formDataSources) {
          output += `  ${ds.name} — table events apply + datasource methods extensible\n`;
        }
        output += '\n';
      }

      const formMethods = rdb.prepare(
        `SELECT name FROM symbols WHERE parent_name = ? AND type = 'method' ORDER BY name LIMIT 20`
      ).all(objName) as any[];

      if (formMethods.length > 0) {
        output += `Form methods (${formMethods.length} shown, CoC-eligible via form extension):\n`;
        output += `  ${formMethods.slice(0, 10).map((m: any) => m.name + '()').join(', ')}`;
        if (formMethods.length > 10) output += ` (+${formMethods.length - 10} more)`;
        output += '\n';
      }
    }

    // Summary of existing extensions
    if (args.showExistingExtensions && existingExtensions.length > 0) {
      const sourceLabel = extensionsFromFs
        ? ' (sourced from disk — not yet in index)'
        : extensionsFromBridge
        ? ' (sourced from DYNAMICSXREFDB)'
        : '';
      output += `\nExisting extensions (${existingExtensions.length})${sourceLabel}:\n`;
      for (const ext of existingExtensions) {
        output += `  ${ext.extension_name} [${ext.model}]`;
        // Show wrapped methods if available from bridge
        let cocMethods: string[] = [];
        try { cocMethods = JSON.parse(ext.coc_methods || '[]'); } catch { /**/ }
        if (cocMethods.length > 0) {
          output += ` — wraps: ${cocMethods.join(', ')}`;
        }
        output += `\n`;
      }
      if (extensionsFromFs) {
        output += `\n⚠️ Data sourced from disk — run extract-metadata + build-database to persist to index.\n`;
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
