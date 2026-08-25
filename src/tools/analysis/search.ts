/**
 * X++ Symbol Search Tool
 * Search for classes, tables, methods, and fields by name or keyword
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { validateWorkspacePath } from '../../workspace/workspaceUtils.js';
import {
  generateRelatedSearches,
  detectCommonPatterns,
  generateContextualTips,
  formatRichContext
} from '../../utils/richContext.js';
import {
  generateSearchSuggestions,
  formatSuggestions
} from '../../utils/suggestionEngine.js';
import { tryBridgeSearch } from '../../bridge/bridgeAdapter.js';
import { indexedPathIsMissing, renderStaleSearchRowsNote } from '../../utils/indexedXmlLookup.js';
import { lookupSymbolsNocase } from '../../utils/symbolLookup.js';
import { rankCustomFirst, isExactNameMatch } from '../../utils/exactMatchRanking.js';
import { isCustomModel } from '../../utils/modelClassifier.js';

/**
 * Index-safe probe for symbols whose name EQUALS the query (#15).
 *
 * Runs `lookupSymbolsNocase`, i.e. an exact-case equality probe on
 * idx_name_type followed by a bounded FTS5 phrase match for differently-cased
 * input. Deliberately NOT `LIKE` and NOT `name = ? COLLATE NOCASE` as the
 * primary predicate: on the 1.17M-row production symbol DB either shape
 * degrades to a full scan (80–278 s measured) and blocks the event loop until
 * MCP clients kill the server.
 *
 * Returns [] on any failure — the exact-first repair must never break search.
 */
export function probeExactMatches(
  symbolIndex: any,
  query: string,
  types?: string[],
): Array<{ name: string; type: string; model?: string; filePath?: string }> {
  if (!query || /[\s*"%]/.test(query)) return [];
  try {
    const db = symbolIndex?.getReadDb?.();
    if (!db) return [];
    return lookupSymbolsNocase(db, query, { types, limit: 5 })
      .filter(hit => isExactNameMatch(query, hit.name))
      .map(hit => ({
        name: hit.name,
        type: hit.type,
        model: hit.model ?? undefined,
        filePath: hit.file_path ?? undefined,
      }));
  } catch {
    return [];
  }
}

/**
 * Probe the SQLite index for keyword matches that live in CUSTOM/ISV models.
 *
 * Broad keyword searches routed through the C# bridge fill their fixed result
 * window in provider-enumeration order (Microsoft-dominated) and truncate at
 * `maxResults`, so custom matches enumerated later never reach the client — the
 * search then looks like it "returns only Microsoft objects". These hits are
 * spliced back into the bridge/external results and ranked directly after exact
 * matches so custom code is always visible. Model-scoped and FTS-driven, so it
 * stays index-safe (never a full `%query%` scan of the whole corpus).
 *
 * Returns [] on any failure — the custom-first repair must never break search.
 */
export function probeCustomMatches(
  symbolIndex: any,
  query: string,
  types?: string[],
  limit = 15,
): Array<{ name: string; type: string; model?: string; parentName?: string; filePath?: string }> {
  if (!query) return [];
  try {
    const hits = symbolIndex?.searchCustomModelSymbols?.(query, types, limit) ?? [];
    return hits.map((hit: any) => ({
      name: hit.name,
      type: hit.type,
      model: hit.model ?? undefined,
      // Not restricted to parent_name IS NULL, so a method/field row can be
      // spliced into a bridge answer. Carry the owner: a bare
      // `- **initValue** (method)` costs the caller a second call to learn
      // WHICH object the method sits on.
      parentName: hit.parentName ?? hit.parent_name ?? undefined,
      filePath: hit.filePath ?? hit.file_path ?? undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Drop probe rows whose object is gone from disk.
 *
 * Both probes are index-only reads, and the index is not rebuilt when a file is
 * deleted — so after a workspace reset the splice kept surfacing objects from the
 * previous run and ranking them ABOVE the live ones, which is how a search for a
 * field that did not exist answered "found it". `indexedPathIsMissing` judges only
 * PackagesLocalDirectory paths, so a build-agent path that merely does not remap
 * here is still spliced in as before.
 *
 * Scoped to the PROBES on purpose. They are a splice that outranks everything
 * else, so a ghost among them is actively misleading and dropping one costs
 * nothing — the row is still in the result set the probe was spliced into. The
 * result set itself is MARKED rather than swept; see markStaleRows.
 */
async function dropStaleRows<T extends { filePath?: string }>(rows: T[]): Promise<T[]> {
  const missing = await Promise.all(rows.map(r => indexedPathIsMissing(r.filePath)));
  return rows.filter((_, i) => !missing[i]);
}

/**
 * Flag the rows of an index-only answer whose file is gone from disk.
 *
 * This is the answer the whole of `search` reduces to when the bridge returns
 * nothing — and a stale index outlives a deleted file precisely when the bridge is
 * silent, so the one answer made entirely of index rows was the one still reporting
 * ghosts as fact.
 *
 * Marked, not dropped. `indexedPathIsMissing` fires for any PackagesLocalDirectory
 * path with no file here, the shipped index covers every standard package, and a
 * machine installs a subset — sweeping this set would answer "no X++ symbols found"
 * for most of D365FO on a partial install, in the tool every other workflow starts
 * from. (Measured: with a packages root present, sweeping turned search("CustTable")
 * into a no-match.) So the row stays, says what it is, and ranks below the live ones.
 *
 * Cost is one existsSync + one access per row over a `limit`-bounded set.
 */
async function markStaleRows<T extends { filePath?: string }>(
  rows: T[],
): Promise<Array<T & { staleIndexRow?: boolean }>> {
  const missing = await Promise.all(rows.map(r => indexedPathIsMissing(r.filePath)));
  return rows.map((row, i) => (missing[i] ? { ...row, staleIndexRow: true } : row));
}

const SearchArgsSchema = z.object({
  query: z.string().describe('Search query (class name, method name, etc.)'),
  type: z.enum([
    'class', 'table', 'form', 'field', 'method', 'enum', 'edt', 'query', 'view', 'report',
    'security-privilege', 'security-duty', 'security-role',
    'menu-item-display', 'menu-item-action', 'menu-item-output',
    'table-extension', 'class-extension', 'form-extension',
    'enum-extension', 'edt-extension', 'data-entity-extension',
    'all',
  ]).optional().default('all').describe('Filter by object type (all=no filter, use specific type to narrow results)'),
  // 20, not 50: the PUBLISHED schema has always said `default: 20`, so a caller
  // that omits `limit` budgets its context for 20 rows and was handed 50. The
  // contract the caller can see is the one that has to be true.
  limit: z.number().max(100).optional().default(20).describe('Maximum results to return'),
  workspacePath: z.string().optional().describe('Optional workspace path to search local project files in addition to external metadata'),
  includeWorkspace: z.boolean().optional().default(false).describe('Whether to include workspace files in search results (workspace-aware search)'),
  verbose: z.boolean().optional().default(false).describe('Include related-searches/patterns/tips sections in the output'),
});

/**
 * Which backing search answered this call.
 *
 * MEASURED (1,400 real MCP calls captured from Copilot sessions on this VM, plus
 * a live stdio harness against the real D365FO metadata, 2026-08-25):
 *   • `search(query="CustTable", type="table")`  →   0.33 s via the bridge
 *   • `search(query="SalesLine")`  (untyped)     →  17.9 s via the bridge
 *   • `search(query="ConChain")`   (untyped)     →  35.4 s via the bridge
 *   • the same untyped queries answered off the SQLite FTS index → 0.1–0.2 s
 *
 * The asymmetry is structural, not incidental: MetadataReadService.SearchObjects
 * answers an untyped query by walking `GetPrimaryKeys()` of EVERY collection on
 * BOTH providers with no cache, and can only stop early once the result budget is
 * full — so the NARROWER the query, the longer it runs. The index holds the same
 * object names and answers in milliseconds.
 *
 * Logged to stderr on every call so the next audit can READ the route taken
 * instead of inferring it from a wall time.
 */
type SearchRoute =
  /** Type-scoped: the bridge is both fast and live here. */
  | 'bridge-typed'
  /** Untyped/broad: served from the SQLite FTS index. */
  | 'index'
  /** Untyped, nothing live indexed under that name — ask live metadata before saying "no". */
  | 'bridge-untyped-confirm'
  /** …and live metadata had nothing either, so the index rows (all stale) are the answer. */
  | 'index-after-confirm'
  /** Type-scoped but the bridge is not in play (offline / build agent / cold start). */
  | 'index-bridge-unavailable';

function logSearchRoute(
  route: SearchRoute, query: string, type: string, hits: number | null, startedAt: number,
): void {
  // hits=? on the bridge routes: the bridge renders its own window, so this side
  // never counts the rows — pretending to would be a made-up number in a log
  // written to be trusted.
  console.error(
    `[search] route=${route} query="${query}" type=${type} hits=${hits ?? '?'} ${Date.now() - startedAt} ms`,
  );
}

/** Cap on the names one bridge-row enrichment looks up. */
const BRIDGE_META_NAME_LIMIT = 100;

/**
 * Model for the rows the BRIDGE returns.
 *
 * `search`'s published schema promises "returns name, type, model", but the C#
 * side only ever populates Name and Type (SearchItemModel in Models.cs) — so
 * every bridge-sourced row rendered as `- **Name** (type)` and the caller had to
 * spend a second call to learn which model a hit lives in. The index already
 * knows, so one bounded lookup fills it in on this side of the pipe.
 *
 * Index-safe by construction: equality on `name` (idx_symbols_name /
 * idx_name_type), a bounded IN-list, `parent_name IS NULL` so a name that is
 * also a field on 900 tables cannot explode the row count, and a hard LIMIT.
 * Never LIKE and never COLLATE NOCASE — see symbolLookup.ts for what those two
 * shapes cost on the 1.17M-row production DB.
 */
export function buildBridgeMetaResolver(
  symbolIndex: any,
): (rows: Array<{ name: string; type: string }>) => Map<string, { model?: string }> {
  return (rows) => {
    const map = new Map<string, { model?: string }>();
    try {
      const db = symbolIndex?.getReadDb?.();
      if (!db) return map;
      const names = [...new Set(rows.map(r => r.name))].slice(0, BRIDGE_META_NAME_LIMIT);
      if (names.length === 0) return map;
      const sql =
        `SELECT name, type, model FROM symbols
         WHERE name IN (${names.map(() => '?').join(',')}) AND parent_name IS NULL
         LIMIT ${BRIDGE_META_NAME_LIMIT * 4}`;
      const found = db.prepare(sql).all(...names) as
        Array<{ name: string; type: string; model: string | null }>;
      for (const row of found) {
        const key = metaKey(row.name, row.type);
        if (row.model && !map.has(key)) map.set(key, { model: row.model });
      }
    } catch {
      /* enrichment is additive — a failure here must never break search */
    }
    return map;
  };
}

/** Shared key for the enrichment map — case-folded, since bridge and index casing can differ. */
export function metaKey(name: string, type: string): string {
  return `${String(name).toLowerCase()}::${type}`;
}

export async function searchTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = SearchArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    if (args.includeWorkspace && args.workspacePath) {
      return await performHybridSearch(args, context);
    }

    const startedAt = Date.now();
    // Both probes feed the bridge splice AND the index answer, so they run once
    // per call whichever route is taken.
    // The exact-name probe is passed along so an exact match that fell outside
    // the bridge's truncated result window is still ranked first (#15).
    // The custom-model probe is passed along so custom/ISV matches truncated out
    // of the Microsoft-dominated bridge window are spliced back in and
    // prioritized (never "only Microsoft objects").
    const searchTypes = args.type === 'all' ? undefined : [args.type];
    const [exactMatches, customMatches] = await Promise.all([
      dropStaleRows(probeExactMatches(symbolIndex, args.query, searchTypes)),
      dropStaleRows(probeCustomMatches(symbolIndex, args.query, searchTypes)),
    ]);
    const bridgeOpts = {
      exactMatches,
      customMatches,
      resolveMeta: buildBridgeMetaResolver(symbolIndex),
    };

    // TYPE-SCOPED → bridge first. Measured 0.33 s, and it is live metadata, so an
    // object written seconds ago is in the answer. Unchanged behaviour, splice included.
    if (searchTypes) {
      const bridgeResult = await tryBridgeSearch(
        context.bridge, args.query, args.type, args.limit, bridgeOpts,
      );
      if (bridgeResult) {
        logSearchRoute('bridge-typed', args.query, args.type, null, startedAt);
        return bridgeResult;
      }
      const answer = await collectIndexAnswer(args, symbolIndex);
      logSearchRoute('index-bridge-unavailable', args.query, args.type, answer.results.length, startedAt);
      return renderIndexAnswer(args, symbolIndex, answer);
    }

    // UNTYPED/BROAD → index. This is the 18-second case, and the index holds the
    // same object names. Freshly written objects stay findable here because every
    // path that writes an object indexes it in-process on the way out
    // (tools/write/inlineIndexUpsert.ts) — the create/modify paths always did,
    // and the three generate_object writers were doing a bare fs.writeFileSync
    // until this routing made that omission visible. That premise is what makes
    // answering from the index safe; if a new writer skips the upsert, its object
    // goes missing from search in the session that created it.
    const answer = await collectIndexAnswer(args, symbolIndex);
    // "Live" excludes rows whose file is gone from disk. An answer made ONLY of
    // those is an answer about objects that are not here any more — exactly the
    // case where the provider may hold a recreated object the index still has
    // under its old row, so it is treated the same as no answer at all.
    const liveHits = answer.results.length - answer.staleCount;
    if (liveHits > 0) {
      logSearchRoute('index', args.query, args.type, answer.results.length, startedAt);
      return renderIndexAnswer(args, symbolIndex, answer);
    }

    // Nothing live under that name. THIS is where live metadata earns its
    // seconds: an object the index has never seen (a package indexed elsewhere,
    // a write whose in-process upsert failed) exists only in the provider, and
    // "no such object" is the most expensive wrong answer this tool can give.
    const bridgeResult = await tryBridgeSearch(
      context.bridge, args.query, undefined, args.limit, bridgeOpts,
    );
    if (bridgeResult) {
      logSearchRoute('bridge-untyped-confirm', args.query, args.type, null, startedAt);
      return bridgeResult;
    }
    logSearchRoute('index-after-confirm', args.query, args.type, answer.results.length, startedAt);
    return renderIndexAnswer(args, symbolIndex, answer);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error searching symbols: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Perform hybrid search (external + workspace)
 */
async function performHybridSearch(
  args: z.infer<typeof SearchArgsSchema>,
  context: XppServerContext
) {
  const { hybridSearch } = context;

  if (args.workspacePath) {
    const validation = await validateWorkspacePath(args.workspacePath);
    if (!validation.valid) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Invalid workspace path: ${validation.error}`,
          },
        ],
        isError: true,
      };
    }
  }

  const results = await hybridSearch.search(args.query, {
    types: args.type === 'all' ? undefined : [args.type as any],
    limit: args.limit,
    workspacePath: args.workspacePath,
    includeWorkspace: true,
  });

  if (results.length === 0) {
    let output = `No X++ symbols found matching "${args.query}" in external metadata or workspace`;

    try {
      const { symbolIndex } = context;
      const allSymbolNames = symbolIndex.getAllSymbolNames(args.query);
      const symbolsByTerm = symbolIndex.getSymbolsByTerm();

      const suggestions = generateSearchSuggestions(
        args.query,
        allSymbolNames,
        symbolsByTerm,
        5 // max suggestions
      );

      if (suggestions.length > 0) {
        output += '\n' + formatSuggestions(suggestions);
      } else {
        // Fall back to basic tips if no suggestions
        const tips = generateContextualTips(args.query, [], args.type);
        if (tips.length > 0) {
          output += '\n\n## 💡 Suggestions\n';
          tips.forEach(tip => {
            const toolHint = tip.tool ? ` → Use \`${tip.tool}()\`` : '';
            output += `\n• ${tip.tip}${toolHint}`;
          });
        }
      }
    } catch (error) {
      // Suggestion generation can fail if the relationship graph isn't built yet
      console.warn('⚠️ Could not generate search suggestions:', error);
      const tips = generateContextualTips(args.query, [], args.type);
      if (tips.length > 0) {
        output += '\n\n## 💡 Suggestions\n';
        tips.forEach(tip => {
          const toolHint = tip.tool ? ` → Use \`${tip.tool}()\`` : '';
          output += `\n• ${tip.tip}${toolHint}`;
        });
      }
    }
    
    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  }

  // Convert hybrid results to XppSymbol format for rich context
  const symbols = results.map(r => r.symbol).filter(Boolean) as any[];

  // Rich context sections (related searches / patterns / tips) are opt-in:
  // on a successful search they are mostly generic boilerplate that costs the
  // agent hundreds of tokens per call. Empty-result searches keep suggestions
  // (handled above) because there the guidance is the entire value.
  const relatedSearches = args.verbose ? generateRelatedSearches(args.query, symbols, 5) : [];
  const commonPatterns = args.verbose ? detectCommonPatterns(symbols) : [];
  const tips = args.verbose ? generateContextualTips(args.query, symbols, args.type) : [];

  // Format results with source indicators
  const formatted = results
    .map((r) => {
      const source = r.source === 'workspace' ? '🔹 WORKSPACE' : '📦 EXTERNAL';
      if (r.symbol) {
        const parentPrefix = r.symbol.parentName ? `${r.symbol.parentName}.` : '';
        const signature = r.symbol.signature ? ` - ${r.symbol.signature}` : '';
        return `${source} [${r.symbol.type.toUpperCase()}] ${parentPrefix}${r.symbol.name}${signature}`;
      }
      if (r.file) {
        return `${source} [${r.file.type.toUpperCase()}] ${r.file.name} (${r.file.path})`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');

  const workspaceCount = results.filter((r) => r.source === 'workspace').length;
  const externalCount = results.filter((r) => r.source === 'external').length;

  let output = `Found ${results.length} matches (${workspaceCount} workspace, ${externalCount} external):\n\n${formatted}`;

  if (relatedSearches.length > 0) {
    output += '\n\n## 🔍 Related Searches\n';
    relatedSearches.forEach(rel => {
      output += `\n• **"${rel.query}"** - ${rel.reason}`;
    });
  }

  if (commonPatterns.length > 0) {
    output += '\n\n## 💡 Common Patterns\n';
    commonPatterns.forEach(pattern => {
      const freq = pattern.frequency ? ` (found ${pattern.frequency}×)` : '';
      output += `\n• ${pattern.pattern}${freq}`;
    });
  }

  if (tips.length > 0) {
    output += '\n\n## 📌 Tips\n';
    tips.forEach(tip => {
      const toolHint = tip.tool ? ` → Use \`${tip.tool}()\`` : '';
      output += `\n• ${tip.tip}${toolHint}`;
    });
  }

  // No trailing "this search is workspace-aware" note: the 🔹/📦 marker on every
  // row already says which side a hit came from, and search is the most-called
  // tool — a fixed footer here is paid for on every call for nothing actionable.

  return {
    content: [
      {
        type: 'text',
        text: output,
      },
    ],
  };
}

/**
 * The index answer for a search: the ranked rows plus how many of them are cache
 * rows with no file on this machine.
 *
 * Split out of the former `performExternalSearch` so the untyped route can look
 * at the ROW COUNT before deciding whether the bridge is worth its 18 seconds.
 * The rendering is unchanged and lives in renderIndexAnswer below.
 */
interface IndexAnswer {
  results: any[];
  staleCount: number;
  /**
   * The index read THREW, as opposed to answering with nothing. Kept apart from
   * `results.length` because the two mean different things to the caller: an
   * empty answer is "no such object", an empty answer after a failure is "I
   * could not look".
   */
  indexFailed: boolean;
}

async function collectIndexAnswer(
  args: z.infer<typeof SearchArgsSchema>,
  symbolIndex: any,
): Promise<IndexAnswer> {
  try {
    const types = args.type === 'all' ? undefined : [args.type];
    const raw: any[] = symbolIndex.searchSymbols(args.query, args.limit, types) || [];

    // #15: FTS5 `ORDER BY rank` scores token frequency, not name equality, so an
    // exact-name hit can be missing from (or buried inside) the window. Probe for
    // it on-index and rank it first.
    const seen = new Set(raw.map(r => `${String(r.name).toLowerCase()} ${r.type}`));
    const missingExact = probeExactMatches(symbolIndex, args.query, types)
      .filter(hit => !seen.has(`${hit.name.toLowerCase()} ${hit.type}`));
    for (const hit of missingExact) seen.add(`${hit.name.toLowerCase()} ${hit.type}`);

    // Custom/ISV matches are likewise buried under the Microsoft-dominated FTS
    // window, so splice any the window missed and mark every custom hit so
    // rankCustomFirst can lift them just behind the exact matches.
    const customProbe = probeCustomMatches(symbolIndex, args.query, types);
    const customKeys = new Set(customProbe.map(h => `${h.name.toLowerCase()} ${h.type}`));
    const missingCustom = customProbe
      .filter(hit => !seen.has(`${hit.name.toLowerCase()} ${hit.type}`));
    for (const hit of missingCustom) seen.add(`${hit.name.toLowerCase()} ${hit.type}`);

    // Marked, not swept — see markStaleRows. This is the whole answer rather than a
    // splice, and a symbol index built elsewhere routinely covers packages this
    // machine does not have installed, so dropping those rows would turn "you do not
    // have that package locally" into "no such object" in the one tool everything
    // else starts from.
    const combined = await markStaleRows([...missingExact, ...missingCustom, ...raw]);
    const isCustomHit = (r: any) =>
      (r.model ? isCustomModel(String(r.model)) : false) ||
      customKeys.has(`${String(r.name).toLowerCase()} ${r.type}`);
    const ranked: any[] = rankCustomFirst(args.query, combined, r => String(r.name), isCustomHit);
    // Below the live rows, keeping the ranking within each band: a cache row must
    // never outrank an object that is actually here, least of all as the exact match
    // the renderer calls out at the top.
    const results: any[] = [
      ...ranked.filter(r => !r.staleIndexRow),
      ...ranked.filter(r => r.staleIndexRow),
    ];
    return { results, staleCount: results.filter(r => r.staleIndexRow).length, indexFailed: false };
  } catch (e) {
    // An index read that throws is treated as "no rows" for ROUTING — the untyped
    // route decides on the row count, and going to the bridge is exactly the right
    // next step when the index could not answer. But it is NOT "no matches" for
    // the CALLER: if the bridge cannot confirm either, an empty answer that came
    // from a read pool closed mid-rebuild would otherwise read as "that object
    // does not exist", which is the most expensive wrong answer this tool gives.
    console.error(`[search] index read failed: ${e instanceof Error ? e.message : e}`);
    return { results: [], staleCount: 0, indexFailed: true };
  }
}

/**
 * Render an index answer — including the no-match case, where the suggestions
 * ARE the value.
 */
function renderIndexAnswer(
  args: z.infer<typeof SearchArgsSchema>,
  symbolIndex: any,
  answer: IndexAnswer,
) {
  try {
    const { results, staleCount } = answer;

    // The index could not be read and nothing else answered either. Saying "no
    // matches" here would report a closed read pool, a rebuild in progress or a
    // corrupt page as "that object does not exist".
    if (answer.indexFailed && (!results || results.length === 0)) {
      return {
        content: [{
          type: 'text',
          text:
            `❌ Could not search: the symbol index read failed for "${args.query}", and live ` +
            `metadata could not answer either. This is NOT "no such object" — nothing was ` +
            `searched.

` +
            `The index may be rebuilding (update_symbol_index) or the database may be missing; ` +
            `get_workspace_info(diagnostics: true) reports its state. Retry once it is ready.`,
        }],
        isError: true,
      };
    }

    if (!results || results.length === 0) {
      const allSymbolNames = symbolIndex.getAllSymbolNames(args.query);
      const symbolsByTerm = symbolIndex.getSymbolsByTerm();

      const suggestions = generateSearchSuggestions(
        args.query,
        allSymbolNames,
        symbolsByTerm,
        5 // max suggestions
      );

      let output = `No X++ symbols found matching "${args.query}"`;

      if (suggestions.length > 0) {
        output += '\n' + formatSuggestions(suggestions);
      } else {
        // Fall back to basic tips if no suggestions
        const tips = generateContextualTips(args.query, [], args.type);
        if (tips.length > 0) {
          output += '\n\n## 💡 Suggestions\n';
          tips.forEach(tip => {
            const toolHint = tip.tool ? ` → Use \`${tip.tool}()\`` : '';
            output += `\n• ${tip.tip}${toolHint}`;
          });
        }
      }
      
      return {
        content: [
          {
            type: 'text',
            text: output,
          },
        ],
      };
    }

    // Rich context sections are opt-in via `verbose` — on a successful search
    // they are mostly generic boilerplate costing hundreds of tokens per call.
    const relatedSearches = args.verbose ? generateRelatedSearches(args.query, results, 5) : [];
    const commonPatterns = args.verbose ? detectCommonPatterns(results) : [];
    const tips = args.verbose ? generateContextualTips(args.query, results, args.type) : [];

    let output = `Found ${results.length} matches:\n`;

    // #15: the grouped renderer below hides ordering, so call the exact match out
    // explicitly — that is the whole point of the exact-first repair. A stale exact
    // match is still called out (hiding it is what this used to get wrong) but it
    // says so right here, where the caller is most likely to act on that one line
    // without reading further.
    const exactHits = results.filter(r => isExactNameMatch(args.query, String(r.name)));
    if (exactHits.length > 0) {
      // Owner + model on each hit, and deduplicated on all three: without the
      // owner, three fields called SalesLine on three different tables render as
      // the same row printed three times, which reads as a rendering bug rather
      // than as three distinct objects.
      const seen = new Set<string>();
      const rendered: string[] = [];
      for (const r of exactHits) {
        const owner = r.parentName ? `${r.parentName}.` : '';
        const line =
          `${owner}${r.name} (${r.type})${r.model ? ` in ${r.model}` : ''}` +
          `${r.staleIndexRow ? ' — ⚠️ STALE index row, no file on this machine' : ''}`;
        if (seen.has(line)) continue;
        seen.add(line);
        rendered.push(line);
      }
      output += `\n⭐ **Exact name match:** ${rendered.join(', ')}\n`;
    }

    output += formatRichContext(args.query, results, {
      relatedSearches,
      commonPatterns,
      tips
    });

    if (staleCount > 0) output += `\n${renderStaleSearchRowsNote(staleCount)}`;

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error searching symbols: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
