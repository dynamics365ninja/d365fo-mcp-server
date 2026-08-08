/**
 * Generate Tool — unified code generator.
 *
 * Six modes, discriminated by `mode` (the dispatch switch below is the
 * authority — keep this list in step with it):
 *   • pattern        → named X++ skeleton from a pattern enum (text only, no write)
 *   • scaffold       → pattern-aware whole-object generation: table/form/report
 *   • find-methods   → find / findRecId / exists for a table
 *   • relation-xpp   → a table's relations rendered as X++ select/query
 *   • fields         → field list → AxTableField XML, with EDT inference
 *   • table-relation → EDT-referencing fields → AxTableRelation XML
 *
 * The first two absorbed the retired generate_code and generate_smart tools;
 * the other four were added later and were invisible in this header for long
 * enough that a reader could reasonably conclude they did not exist.
 *
 * Param names of the underlying handlers do not collide and none of their
 * schemas is strict, so the merged arguments are passed straight through; each
 * handler reads its own fields and ignores the `mode` discriminator.
 *
 * Mode-specific parameters arrive nested in `params` (the published schema
 * advertises only that free-form object — issue #825) or flat at top level
 * (legacy callers); both are flattened here before dispatch, and a call missing
 * a required parameter is answered with the mode's complete spec.
 *
 * Note: d365fo_file(action="generate") is intentionally NOT merged here — it
 * produces XML for an existing object definition, a different concern.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../types/context.js';
import { codeGenTool } from './smart/codeGen.js';
import { generateSmartTool } from './smart/generateSmart.js';
import { generateFindMethodsTool } from './smart/generateFindMethods.js';
import { generateRelationXppTool } from './smart/generateRelationXpp.js';
import { generateTableFieldsTool } from './xml/generateTableFields.js';
import { generateTableRelationTool } from './xml/generateTableRelation.js';
import {
  GENERATE_OBJECT_MODE_SPECS,
  getGenerateObjectRequiredParams,
  renderGenerateObjectSpec,
} from './specs/generateObjectOpSpecs.js';

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/**
 * Spec key for the call: `scaffold` splits by objectType because the three
 * scaffolds share almost nothing. Falls back to the bare mode.
 */
function specKey(mode: string, args: Record<string, any>): string {
  if (mode === 'scaffold' && typeof args.objectType === 'string') {
    const key = `scaffold:${args.objectType}`;
    if (GENERATE_OBJECT_MODE_SPECS[key]) return key;
  }
  return mode;
}

export async function generateObjectTool(request: CallToolRequest, context: XppServerContext) {
  const raw = (request.params.arguments ?? {}) as Record<string, any>;
  const { params, ...flat } = raw;
  // Nested values win on key collision; the `params` wrapper is not forwarded.
  const a: Record<string, any> =
    params && typeof params === 'object' && !Array.isArray(params) ? { ...flat, ...params } : flat;
  const mode = a.mode as string | undefined;

  if (mode && GENERATE_OBJECT_MODE_SPECS[mode]) {
    // The published schema no longer lists mode params, so a missing one must
    // come back with the whole contract instead of a bare "expected string".
    const key = specKey(mode, a);
    const missing = getGenerateObjectRequiredParams(key).filter(p => a[p] === undefined || a[p] === '');
    if (missing.length > 0) {
      return err(
        `❌ generate_object(mode="${mode}"): missing required parameter(s) ${missing.join(', ')}.\n\n` +
        renderGenerateObjectSpec(key),
      );
    }
  }

  request = { ...request, params: { ...request.params, arguments: a } };

  switch (mode) {
    case 'pattern':
      return codeGenTool(request);
    case 'scaffold':
      return generateSmartTool(request, context);
    case 'find-methods':
      return generateFindMethodsTool(request, context);
    case 'relation-xpp':
      return generateRelationXppTool(request, context);
    case 'fields':
      return generateTableFieldsTool(request, context);
    case 'table-relation':
      return generateTableRelationTool(request, context);
    default:
      return err(`generate_object: unknown mode "${mode}". Use "pattern" (named X++ skeleton, text only), "scaffold" (whole table/form/report), "find-methods" (find/findRecId/exists for a table), "relation-xpp" (table relations → X++ select/query), "fields" (field list → AxTableField XML with auto-EDT), or "table-relation" (EDT-referencing fields → AxTableRelation XML). Per-mode parameters: get_knowledge(kind="op-spec", topic="<mode>").`);
  }
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/generateObject.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.
