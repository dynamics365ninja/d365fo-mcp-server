/**
 * Labels Tool — unified label-operations entry point.
 *
 * Replaces the four per-action label tools (search_labels, get_label_info,
 * create_label, rename_label) with one tool discriminated by `action`.
 * Dispatches to the existing handler for that action via a local registry;
 * handler files stay where they are — only the MCP surface is consolidated.
 *
 * Read actions (search, info) work in every server mode. Write actions
 * (create, rename) require Windows-VM filesystem access and fail with the
 * underlying handler's clear error message when called from Azure read-only.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { searchLabelsTool, REUSABLE_MARKER, NO_REUSE_ADVICE } from './analysis/searchLabels.js';
import { getLabelInfoTool } from './readers/getLabelInfo.js';
import { createLabelTool } from './write/createLabel.js';
import { renameLabelTool } from './write/renameLabel.js';

export type LabelsTool = (request: CallToolRequest, context: XppServerContext) => Promise<any>;

export const LABEL_ACTIONS = ['search', 'info', 'create', 'update', 'rename'] as const;
export type LabelAction = (typeof LABEL_ACTIONS)[number];

interface LabelDispatch {
  tool: LabelsTool;
  toolName: string;
}

export const LABEL_DISPATCH: Record<LabelAction, LabelDispatch> = {
  search: { tool: searchLabelsTool, toolName: 'search_labels' },
  info:   { tool: getLabelInfoTool, toolName: 'get_label_info' },
  create: { tool: createLabelTool,  toolName: 'create_label' },
  // update reuses create with overwriteExisting forced true (see below); same args as create.
  update: { tool: createLabelTool,  toolName: 'create_label' },
  rename: { tool: renameLabelTool,  toolName: 'rename_label' },
};

const LabelsArgsSchema = z
  .object({
    action: z.enum(LABEL_ACTIONS).describe(
      'Which label operation to run: ' +
      'search (full-text query, read), info (translations for a label ID or list of label files, read), ' +
      'create (add a NEW label to an AxLabelFile, write), update (overwrite the text of an EXISTING label, ' +
      'e.g. fix a wrong translation, write), rename (rename a label ID across .label.txt + X++ + XML, write).',
    ),
  })
  .passthrough();

/** Synonym-to-canonical-action map, for clients that don't enforce the JSON-schema enum before dispatch. */
const ACTION_ALIASES: Record<string, LabelAction> = {
  list: 'info', 'list-files': 'info', 'list-label-files': 'info', get: 'info', 'get-info': 'info',
  find: 'search', query: 'search', lookup: 'search',
  add: 'create', 'create-label': 'create', 'new': 'create',
  edit: 'update', 'update-label': 'update', 'set': 'update', 'overwrite': 'update',
  'rename-label': 'rename',
};

/** There is no dedicated "create label file" action — action=create auto-creates a missing AxLabelFile as a side effect. */
const LABEL_FILE_ACTIONS = new Set(['create-label-file', 'create-file', 'create-labelfile', 'new-label-file']);

export async function labelsTool(request: CallToolRequest, context: XppServerContext) {
  // Write plumbing (packagePath, languages, sortLabels, …) left the wire schema —
  // it is auto-resolved on the normal path, so publishing all thirteen knobs cost
  // ~1.7 KB on every request to serve the rare call that overrides one. They are
  // still accepted, flat or nested in `params`, exactly like d365fo_file's
  // resolution overrides; contract via get_knowledge(kind="op-spec", topic="labels").
  const incoming = { ...(request.params.arguments ?? {}) } as Record<string, any>;
  const nested = (incoming.params && typeof incoming.params === 'object' && !Array.isArray(incoming.params))
    ? incoming.params as Record<string, any>
    : {};
  delete incoming.params;
  // Flat keys win: an explicit top-level value is the more specific statement.
  const rawArgs = { ...nested, ...incoming };
  const rawAction = typeof rawArgs.action === 'string' ? rawArgs.action.trim().toLowerCase() : rawArgs.action;

  if (typeof rawAction === 'string') {
    if (LABEL_FILE_ACTIONS.has(rawAction)) {
      return {
        content: [{
          type: 'text',
          text:
            `❌ labels: "${rawArgs.action}" is not a labels action — d365fo_file has no "label-file" object type. ` +
            `A new AxLabelFile is created automatically by labels(action="create", createLabelFileIfMissing=true ` +
            `[default]) as a side effect of adding its first label. The label file's ID (labelFileId) is the ` +
            `model name (e.g. "ContosoExt") — NEVER the bare EXTENSION_PREFIX. Example:\n` +
            `  labels(action="create", labelId="EquipmentName", labelFileId="ContosoExt", model="ContosoExt", ` +
            `translations=[{language:"en-US", text:"Equipment name"}])`,
        }],
        isError: true,
      };
    }
    if (!LABEL_ACTIONS.includes(rawAction as LabelAction) && ACTION_ALIASES[rawAction]) {
      rawArgs.action = ACTION_ALIASES[rawAction];
    }
  }

  const parsed = LabelsArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      content: [{
        type: 'text',
        text:
          `❌ labels: invalid arguments — action must be one of: ${LABEL_ACTIONS.join(', ')} ` +
          `(got "${rawArgs.action ?? ''}"). search=find labels, info=translations / list label files, ` +
          `create=add a new label, update=fix an existing label's text, rename=rename a label ID.`,
      }],
      isError: true,
    };
  }

  const { action, ...rest } = parsed.data;
  const dispatch = LABEL_DISPATCH[action as LabelAction];
  if (!dispatch) {
    return {
      content: [{ type: 'text', text: `❌ labels: unsupported action "${action}". Valid actions: ${LABEL_ACTIONS.join(', ')}.` }],
      isError: true,
    };
  }

  // Force overwrite for update so it can't be triggered accidentally via action="create".
  if (action === 'update') (rest as Record<string, unknown>).overwriteExisting = true;

  // Map common param synonyms (searchText/text/q) to the `query` the handler expects.
  if (action === 'search') {
    const r = rest as Record<string, unknown>;
    if (r.query === undefined) {
      const alt = r.searchText ?? r.text ?? r.q;
      if (typeof alt === 'string' || Array.isArray(alt)) {
        r.query = alt;
        delete r.searchText; delete r.text; delete r.q;
      }
    }
    if (Array.isArray(r.query)) {
      return batchSearch(r, dispatch.tool, context);
    }
  }

  const subRequest: CallToolRequest = {
    method: 'tools/call',
    params: { name: dispatch.toolName, arguments: rest },
  };
  return dispatch.tool(subRequest, context);
}

/** Most phrasings one call will try — beyond this the answer is "create your own". */
const MAX_BATCH_QUERIES = 12;

/**
 * How many of the batch's searches are in flight at once.
 *
 * They are independent reads, so running them one after another made the batch
 * cost the SUM of its queries when it only needs to cost the slowest — the very
 * latency batching exists to remove. Bounded rather than unbounded because they
 * all land on the same SQLite connection: twelve concurrent FTS queries buy
 * nothing over a handful and only lengthen the queue behind them.
 */
const BATCH_CONCURRENCY = 4;

/** Run `fn` over `items` with at most `limit` in flight, preserving input order. Exported for tests. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Run several label searches in one call.
 *
 * Looking for a reusable label is inherently a guessing game — the caller does not
 * know the wording Microsoft used — and one query per call turned that into a
 * round trip per guess: 19 of them in a single benchmark run, ~150 s of wall clock,
 * for an answer ("no reusable label exists, create your own") that was already
 * determined by the first. Batching collapses the guesses into one call and, when
 * none of them hits, says so once instead of leaving the caller to conclude it.
 */
async function batchSearch(
  args: Record<string, unknown>,
  search: LabelsTool,
  context: XppServerContext,
): Promise<any> {
  const all = (args.query as unknown[]).map(q => String(q).trim()).filter(q => q !== '');
  // Fold phrasings that differ only in case or surrounding space: the index is
  // case-insensitive, so ["customer","customer","Customer"] is one query printed
  // three times — and passing near-duplicates is exactly the guessing behaviour
  // this feature exists to absorb. First spelling wins, so the sections still read
  // back in the caller's own words.
  const seen = new Set<string>();
  const unique = all.filter(q => {
    const key = q.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const duplicates = all.length - unique.length;
  const queries = unique.slice(0, MAX_BATCH_QUERIES);
  if (queries.length === 0) {
    return {
      content: [{ type: 'text', text: `❌ labels(action="search"): query[] is empty — pass at least one search text.` }],
      isError: true,
    };
  }

  const runs = await mapWithConcurrency(queries, BATCH_CONCURRENCY, async (query) => {
    let result: any;
    try {
      result = await search(
        { method: 'tools/call', params: { name: 'search_labels', arguments: { ...args, query } } },
        context,
      );
    } catch (error) {
      // A handler that throws is a failure like any other — it must not read back
      // as "this phrasing found nothing".
      return { query, text: `❌ ${error instanceof Error ? error.message : String(error)}`, failed: true };
    }
    const text = (result?.content ?? [])
      .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
      .join('\n');
    return { query, text, failed: result?.isError === true };
  });

  const failed = runs.filter(r => r.failed);
  const searched = runs.length - failed.length;
  const foundReusable = runs.some(r => !r.failed && r.text.includes(REUSABLE_MARKER));
  const sections = runs.map(r => `## "${r.query}"${r.failed ? ' — ❌ SEARCH FAILED' : ''}\n\n${r.text}`);

  const notes = [
    duplicates > 0 ? `${duplicates} duplicate phrasing(s) folded` : '',
    unique.length > queries.length ? `${unique.length - queries.length} beyond the ${MAX_BATCH_QUERIES}-query cap were not run` : '',
  ].filter(Boolean);
  const header = `# Label search — ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}` +
    (notes.length > 0 ? ` (${notes.join('; ')})` : '') + '\n';

  // The per-query sections each carry their own advice; the verdict is what the
  // caller actually needs, so state it once, up front, rather than making them
  // read every section to work out that no phrasing hit.
  //
  // A failed sub-search is NOT a miss, and the two used to be indistinguishable:
  // isError was dropped on the floor, so a batch in which every query blew up
  // returned a clean report whose verdict said "no label exists — create your own".
  // That is the one thing this line exists to state unambiguously, so failures
  // either replace the verdict or are named alongside it.
  const verdict = searched === 0
    ? `**Verdict:** NONE of these ${runs.length} searches ran — every one failed (see the sections below). ` +
      `This says nothing about whether a reusable label exists; fix the error and search again ` +
      `rather than creating a label on the strength of this answer.\n`
    : foundReusable
      // "Reusable" here means only "this model can resolve it" — the index matches
      // words, not meaning, so a hit is a candidate and not an answer. Run a5677c99
      // read the old wording ("at least one reusable label was found") on a batch
      // whose best hit was @SYS321832 "The decreased margin cannot be greater than
      // the current margin amount of letter of guarantee", concluded the right label
      // was in there somewhere, and spent two more searches and ~7 AIU looking for
      // it. The verdict now says what was actually established, and carries the
      // create call so that deciding "none of these fit" costs no further round trip.
      ? `**Verdict:** ${searched} search(es) ran and at least one label this model can resolve came back — ` +
        `see the section(s) marked "${REUSABLE_MARKER}". Read the TEXT of those hits before adopting one: ` +
        `the index matches wording, not meaning, so a hit is a candidate, not a verdict. ` +
        `If none of them says what you need, do NOT rephrase and search again — nothing new will surface.\n` +
        `\n${NO_REUSE_ADVICE}`
      : `**Verdict:** none of these ${searched} phrasings found a label this model can resolve. ` +
        `Stop searching and create your own.\n` +
        (failed.length > 0
          ? `\n⚠️ ${failed.length} of ${runs.length} searches FAILED and were not part of that verdict: ` +
            `${failed.map(f => `"${f.query}"`).join(', ')}.\n`
          : '') +
        `\n${NO_REUSE_ADVICE}`;

  return {
    content: [{ type: 'text', text: `${header}\n${verdict}\n---\n\n${sections.join('\n\n---\n\n')}` }],
    ...(searched === 0 ? { isError: true } : {}),
  };
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/labels.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.
