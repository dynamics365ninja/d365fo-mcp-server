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
  const all = (args.query as unknown[]).map(q => String(q)).filter(q => q.trim() !== '');
  const queries = all.slice(0, MAX_BATCH_QUERIES);
  if (queries.length === 0) {
    return {
      content: [{ type: 'text', text: `❌ labels(action="search"): query[] is empty — pass at least one search text.` }],
      isError: true,
    };
  }

  const sections: string[] = [];
  let foundReusable = false;

  for (const query of queries) {
    const result = await search(
      { method: 'tools/call', params: { name: 'search_labels', arguments: { ...args, query } } },
      context,
    );
    const text = (result?.content ?? [])
      .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
      .join('\n');
    if (text.includes(REUSABLE_MARKER)) foundReusable = true;
    sections.push(`## "${query}"\n\n${text}`);
  }

  const header = `# Label search — ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}` +
    (all.length > queries.length ? ` (${all.length - queries.length} beyond the ${MAX_BATCH_QUERIES}-query cap were not run)` : '') +
    '\n';
  // The per-query sections each carry their own advice; the verdict is what the
  // caller actually needs, so state it once, up front, rather than making them
  // read every section to work out that no phrasing hit.
  const verdict = foundReusable
    ? `**Verdict:** at least one reusable label was found — see the section(s) marked "${REUSABLE_MARKER}".\n`
    : `**Verdict:** none of these ${queries.length} phrasings found a label this model can resolve. ` +
      `Stop searching and create your own.\n\n${NO_REUSE_ADVICE}`;

  return { content: [{ type: 'text', text: `${header}\n${verdict}\n---\n\n${sections.join('\n\n---\n\n')}` }] };
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/labels.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.
