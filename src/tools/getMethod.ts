/**
 * get_method Tool — unified method-reader entry point.
 *
 * Replaces the two per-aspect method tools (get_method_signature,
 * get_method_source) with one tool discriminated by `include`:
 *   • signature → modifiers/return type/params/attributes (cheap, for CoC)
 *   • source    → full X++ body
 *   • both      → signature followed by source (default)
 *
 * Both underlying handlers are bridge-backed readers that work in write-only
 * mode via IMetadataProvider; handler files stay where they are — only the MCP
 * surface is consolidated.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { getMethodSignatureTool } from './methodSignature.js';
import { getMethodSourceTool } from './getMethodSource.js';

export const METHOD_INCLUDES = ['signature', 'source', 'both'] as const;
export type MethodInclude = (typeof METHOD_INCLUDES)[number];

const GetMethodArgsSchema = z
  .object({
    include: z.enum(METHOD_INCLUDES).optional().default('both'),
  })
  .passthrough();

function subRequest(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } };
}

export async function getMethodTool(request: CallToolRequest, context: XppServerContext) {
  const parsed = GetMethodArgsSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: `❌ get_method: invalid arguments — ${parsed.error.message}` }],
      isError: true,
    };
  }

  const { include, ...rest } = parsed.data;

  if (!rest.className) {
    return {
      content: [{
        type: 'text',
        text:
          `❌ get_method: missing required parameter "className".\n\n` +
          `Usage: get_method(className="MyClass", methodName="myMethod")\n\n` +
          `If you only know the method name, use search(query="myMethod", type="method") first ` +
          `to find which class it belongs to.`,
      }],
      isError: true,
    };
  }

  if (include === 'signature') {
    return getMethodSignatureTool(subRequest('get_method_signature', rest), context);
  }
  if (include === 'source') {
    return getMethodSourceTool(subRequest('get_method_source', rest), context);
  }

  // both: signature first (cheap context), then full source.
  const sig = await getMethodSignatureTool(subRequest('get_method_signature', rest), context);
  const src = await getMethodSourceTool(subRequest('get_method_source', rest), context);
  const sigOk = Boolean(sig && !sig.isError);
  const srcOk = Boolean(src && !src.isError);

  // Source is the authoritative payload. Some members (e.g. classDeclaration)
  // have a valid source but no parseable signature, so the signature path emits
  // a misleading "method not found" error. When the source succeeded, only keep
  // the parts that actually succeeded — never surface a signature-only failure.
  const parts = [
    ...(sigOk ? sig!.content : []),
    ...(srcOk ? src!.content : []),
  ];
  if (parts.length > 0) {
    return { content: parts, isError: false };
  }

  // Both failed — return the source error (its "not found" hint is more useful).
  return {
    content: [...(src?.content ?? sig?.content ?? [])],
    isError: true,
  };
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/getMethod.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.
