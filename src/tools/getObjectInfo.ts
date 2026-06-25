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
import { READER_DISPATCH, OBJECT_INFO_TYPES, withNotFoundGuidance } from './objectInfoRegistry.js';
import { completionTool } from './completion.js';

const GetObjectInfoArgsSchema = z.object({
  objectType: z.enum(OBJECT_INFO_TYPES).describe(
    'Kind of object to read: class, table, form, query, view, enum, edt, report, ' +
    'data-entity, menu-item, service, map, config-key, security-policy, macro. ' +
    'Extension types list every extension of a base object: table-extension, ' +
    'form-extension, enum-extension, edt-extension, data-entity-extension, class-extension. ' +
    'For any *-extension the name may be either the full extension name ' +
    '(e.g. "CustInvoiceJour.Extension") or just the base object name — ' +
    'both are accepted; the base object name is extracted automatically.',
  ),
  name: z.string().min(1).describe('Exact object name (use search/search(queries=[...]) first if unsure).'),
  // Top-level class shortcuts — accepted directly so callers don't need to nest them in options.
  methodOffset: z.number().optional().describe('[class] Pagination offset for methods. Classes with >15 methods are paged; pass multiples of 15 to get the next page.'),
  compact: z.boolean().optional().describe('[class] true = signatures only (default), false = include full method source bodies.'),
  options: z.record(z.string(), z.any()).optional().describe(
    'Optional type-specific flags forwarded to the reader. ' +
    'Class: { "compact": false } for full source, { "methodOffset": 15 } for next method page, ' +
    '{ "members": "names" } for fast member-name list (add "prefix" to filter). ' +
    'Report: { "includeRdl": true }. Form: { "searchControl": "AccountNum" }. Macro: { "filter": "Path" }.',
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

  const { objectType, name, methodOffset, compact, options: rawOptions } = parsed.data;
  // Merge top-level class shortcuts into options so dispatch.buildArgs sees them.
  const options: Record<string, any> = { ...rawOptions };
  if (methodOffset !== undefined) options.methodOffset = methodOffset;
  if (compact !== undefined) options.compact = compact;

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
  const result = await dispatch.tool(subRequest, context);
  return withNotFoundGuidance(result, name, objectType);
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
