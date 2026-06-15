/**
 * Get Object Info Tool — unified single-object metadata reader.
 *
 * Replaces the per-type get_*_info tools (get_class_info, get_table_info, …,
 * get_service_info, get_macro_info) with one tool discriminated by `objectType`.
 * Dispatches to the existing handler for that type via the shared READER_DISPATCH
 * registry; type-specific knobs go in `options` and are passed through.
 *
 * Always available across server modes: bridge-backed types (class/table/…)
 * work on the local VM, SQLite-backed types (service/map/config-key/…) work on
 * Azure read-only. When the backing source is absent the underlying handler
 * returns a clear "not found / needs index / needs VM" message.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { READER_DISPATCH, OBJECT_INFO_TYPES } from './objectInfoRegistry.js';
import { completionTool } from './completion.js';

const GetObjectInfoArgsSchema = z.object({
  objectType: z.enum(OBJECT_INFO_TYPES).describe(
    'Kind of object to read: class, table, form, query, view, enum, edt, report, ' +
    'data-entity, menu-item, service, map, config-key, security-policy, macro.',
  ),
  name: z.string().min(1).describe('Exact object name (use search/search(queries=[...]) first if unsure).'),
  options: z.record(z.string(), z.any()).optional().describe(
    'Optional type-specific flags forwarded to the reader, e.g. ' +
    '{ "compact": false } for class, { "includeRdl": true } for report, ' +
    '{ "searchControl": "AccountNum" } for form, { "filter": "Path" } for macro. ' +
    'For classes: { "members": "names" } returns a fast IntelliSense-style member ' +
    'name list (optional "prefix" to filter) instead of full metadata.',
  ),
});

export async function getObjectInfoTool(request: CallToolRequest, context: XppServerContext) {
  const parsed = GetObjectInfoArgsSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: `❌ get_object_info: invalid arguments — ${parsed.error.message}` }],
      isError: true,
    };
  }

  const { objectType, name, options } = parsed.data;

  // Folded code_completion: a fast member-name list for classes.
  // get_object_info(objectType="class", name, options:{ members:"names", prefix? })
  if (options?.members === 'names') {
    if (objectType !== 'class') {
      return {
        content: [{ type: 'text', text: `❌ get_object_info: options.members="names" is only supported for objectType="class". For "${objectType}" omit it to get full metadata.` }],
        isError: true,
      };
    }
    const completionRequest: CallToolRequest = {
      method: 'tools/call',
      params: {
        name: 'code_completion',
        arguments: {
          className: name,
          prefix: options.prefix,
          includeWorkspace: options.includeWorkspace,
          workspacePath: options.workspacePath,
        },
      },
    };
    return completionTool(completionRequest, context);
  }

  const dispatch = READER_DISPATCH[objectType];
  if (!dispatch) {
    return {
      content: [{ type: 'text', text: `❌ get_object_info: unsupported objectType "${objectType}".` }],
      isError: true,
    };
  }

  const subRequest: CallToolRequest = {
    method: 'tools/call',
    params: { name: dispatch.toolName, arguments: dispatch.buildArgs(name, options) },
  };
  return dispatch.tool(subRequest, context);
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
