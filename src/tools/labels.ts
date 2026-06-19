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

export const LABEL_ACTIONS = ['search', 'info', 'create', 'rename'] as const;
export type LabelAction = (typeof LABEL_ACTIONS)[number];

interface LabelDispatch {
  tool: LabelsTool;
  toolName: string;
}

export const LABEL_DISPATCH: Record<LabelAction, LabelDispatch> = {
  search: { tool: searchLabelsTool, toolName: 'search_labels' },
  info:   { tool: getLabelInfoTool, toolName: 'get_label_info' },
  create: { tool: createLabelTool,  toolName: 'create_label' },
  rename: { tool: renameLabelTool,  toolName: 'rename_label' },
};

const LabelsArgsSchema = z
  .object({
    action: z.enum(LABEL_ACTIONS).describe(
      'Which label operation to run: ' +
      'search (full-text query, read), info (translations for a label ID or list of label files, read), ' +
      'create (add a new label to an AxLabelFile, write), rename (rename a label ID across .label.txt + X++ + XML, write).',
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
  'rename-label': 'rename',
};

/** Action values that mean "create the label *file*", which is d365fo_file's job. */
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
            `❌ labels: "${rawArgs.action}" is not a labels action — creating a label *file* is done with ` +
            `d365fo_file(action="create", objectType="label-file", ...). The labels tool only manages individual ` +
            `labels: ${LABEL_ACTIONS.join(', ')}.`,
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
          `(got "${rawArgs.action ?? ''}"). search=find labels, info=translations/list files, ` +
          `create=add a label, rename=rename a label ID.`,
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

  const subRequest: CallToolRequest = {
    method: 'tools/call',
    params: { name: dispatch.toolName, arguments: rest },
  };
  return dispatch.tool(subRequest, context);
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
