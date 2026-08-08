/**
 * Generate Smart Tool — unified pattern-aware code generation entry point.
 *
 * Replaces the per-objectType generate_smart_* tools (generate_smart_table,
 * generate_smart_form, generate_smart_report) with one tool discriminated by
 * `objectType`. Dispatches to the existing generator via a local registry;
 * the underlying handlers stay where they are — only the MCP surface is
 * consolidated.
 *
 * The downstream handlers take a plain args object + symbolIndex (+ bridge for
 * table) and return `{ content }`. The dispatcher unwraps the request, forwards
 * the rest of the arguments, and re-wraps the response in the standard tool
 * result shape.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { handleGenerateSmartTable } from './generateSmartTable.js';
import { handleGenerateSmartForm } from './generateSmartForm.js';
import { handleGenerateSmartReport } from './generateSmartReport.js';

export const GENERATE_SMART_TYPES = ['table', 'form', 'report'] as const;
export type GenerateSmartType = (typeof GENERATE_SMART_TYPES)[number];

type SmartHandler = (args: any, context: XppServerContext) => Promise<any>;

export const GENERATE_SMART_DISPATCH: Record<GenerateSmartType, SmartHandler> = {
  table:  (args, ctx) => handleGenerateSmartTable(args, ctx.symbolIndex, ctx.bridge),
  form:   (args, ctx) => handleGenerateSmartForm(args, ctx.symbolIndex),
  report: (args, ctx) => handleGenerateSmartReport(args, ctx.symbolIndex, ctx.bridge),
};

const GenerateSmartArgsSchema = z
  .object({
    objectType: z.enum(GENERATE_SMART_TYPES).describe(
      'Kind of object to generate: table (AxTable + indexes + relations + methods), ' +
      'form (controls + datasources + pattern), report (TmpTable + Contract + DP + Controller + AxReport).',
    ),
  })
  .passthrough();

export async function generateSmartTool(request: CallToolRequest, context: XppServerContext) {
  const parsed = GenerateSmartArgsSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: `❌ generate_object(scaffold): invalid arguments — ${parsed.error.message}` }],
      isError: true,
    };
  }

  const { objectType, ...rest } = parsed.data;
  const handler = GENERATE_SMART_DISPATCH[objectType as GenerateSmartType];
  if (!handler) {
    return {
      content: [{ type: 'text', text: `❌ generate_object(scaffold): unsupported objectType "${objectType}".` }],
      isError: true,
    };
  }

  const result = await handler(rest, context);
  // Preserve isError — dropping it reported a rejected generation as a success.
  return {
    content: result?.content ?? [{ type: 'text', text: 'No results returned' }],
    ...(result?.isError ? { isError: true } : {}),
  };
}

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.
