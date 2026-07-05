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
import { searchLabelsTool } from './searchLabels.js';
import { getLabelInfoTool } from './getLabelInfo.js';
import { createLabelTool } from './createLabel.js';
import { renameLabelTool } from './renameLabel.js';

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
  // update reuses the create handler, which overwrites existing label text when
  // overwriteExisting is set (injected below). Same args as create.
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

/**
 * Common near-misses agents reach for, mapped to the canonical action. Keeps the
 * advertised enum tight while still accepting obvious synonyms at runtime (for
 * clients that don't enforce the JSON-schema enum before dispatch).
 */
const ACTION_ALIASES: Record<string, LabelAction> = {
  list: 'info', 'list-files': 'info', 'list-label-files': 'info', get: 'info', 'get-info': 'info',
  find: 'search', query: 'search', lookup: 'search',
  add: 'create', 'create-label': 'create', 'new': 'create',
  edit: 'update', 'update-label': 'update', 'set': 'update', 'overwrite': 'update',
  'rename-label': 'rename',
};

/** Action values that mean "create the label *file* itself" (there is no dedicated action for this —
 *  action=create auto-creates a missing AxLabelFile as a side effect of creating the first label in it). */
const LABEL_FILE_ACTIONS = new Set(['create-label-file', 'create-file', 'create-labelfile', 'new-label-file']);

export async function labelsTool(request: CallToolRequest, context: XppServerContext) {
  const rawArgs = { ...(request.params.arguments ?? {}) } as Record<string, any>;
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

  // update is create with overwrite-on-collision — force the flag so callers
  // can't accidentally clobber text via action="create".
  if (action === 'update') (rest as Record<string, unknown>).overwriteExisting = true;

  // Param near-misses for search: the handler expects `query`, but agents commonly
  // reach for searchText/text/q. Map them so the first call succeeds.
  if (action === 'search') {
    const r = rest as Record<string, unknown>;
    if (r.query === undefined) {
      const alt = r.searchText ?? r.text ?? r.q;
      if (typeof alt === 'string') {
        r.query = alt;
        delete r.searchText; delete r.text; delete r.q;
      }
    }
  }

  const subRequest: CallToolRequest = {
    method: 'tools/call',
    params: { name: dispatch.toolName, arguments: rest },
  };
  return dispatch.tool(subRequest, context);
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
