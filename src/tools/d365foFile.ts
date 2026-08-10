/**
 * d365fo_file Tool — unified file/metadata-operation entry point.
 *
 * Replaces three tools with one discriminated by `action`:
 *   • generate → produce AOT XML as TEXT only (Azure/Linux fallback, no write)
 *   • create   → write a NEW AOT object file into PackagesLocalDirectory (write)
 *   • modify   → edit an EXISTING object via IMetadataProvider (write)
 *
 * Like `labels`, this mixes a read-capable action (generate works on Azure
 * read-only) with write actions that need local Windows-VM filesystem access;
 * it therefore lives in ALWAYS_TOOLS and the underlying create/modify handlers
 * return a clear error when the local filesystem is not reachable. Handler
 * files stay where they are — only the MCP surface is consolidated.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { handleGenerateD365Xml } from './xml/generateD365Xml.js';
import { handleCreateD365File } from './write/createD365File.js';
import { modifyD365FileTool } from './write/modifyD365File.js';
import { resetRecentPrepares } from './prepare/prepare.js';

export const D365_FILE_ACTIONS = ['generate', 'create', 'modify'] as const;
export type D365FileAction = (typeof D365_FILE_ACTIONS)[number];

const D365FileArgsSchema = z
  .object({
    action: z.enum(D365_FILE_ACTIONS).describe(
      'generate → XML text only (no file written, Azure/Linux fallback); ' +
      'create → write a NEW object file (Windows); modify → edit an EXISTING object (Windows).',
    ),
    // Operation-specific parameters may arrive nested in `params` (the published
    // schema advertises only this object) — they are flattened before dispatch.
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

function subRequest(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } };
}

/** Ceiling on one batch — matches get_object_info's objects[] cap. */
const MAX_BATCH_OPERATIONS = 20;

/** Concatenated text of a tool result, for folding into the batch report. */
function resultText(result: any): string {
  return (result?.content ?? [])
    .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text)
    .join('\n')
    .trim();
}

/**
 * Run several modify operations against one object in a SINGLE tool call.
 *
 * This is the largest round-trip saving available: a table change is never one
 * operation. "add three fields" is 3 calls, each field then wants a field-group
 * entry (the add-field response says so in as many words), and an index or a
 * relation adds more — 8 to 14 round trips for one ordinary task, every one of
 * them re-billing the whole cached context.
 *
 * Each operation goes through the ORDINARY single-op path rather than through
 * the bridge's own batchModify. That is deliberate: the round trip being paid
 * for is the MCP one, not the bridge IPC (which is local and costs
 * milliseconds), and modifyD365FileTool is where path containment, backups,
 * prefix application, .rnrproj registration, the direct-XML fallbacks and the
 * per-operation validation live. Routing operations[] straight at the bridge
 * would buy nothing measurable and would silently drop every one of those
 * guards — including the ones that exist because a bridge write failed.
 *
 * Sequential, never parallel: the operations mutate one file, and direct-XML
 * writes are read-modify-write with no locking, so concurrent ones interleave
 * and lose edits.
 */
async function runModifyBatch(
  rest: Record<string, unknown>,
  context: XppServerContext,
): Promise<any> {
  const { operations, ...shared } = rest as { operations: unknown[] } & Record<string, unknown>;

  if (operations.length === 0) {
    return {
      content: [{ type: 'text', text: '❌ d365fo_file(action="modify"): operations[] is empty — pass at least one { operation, … } entry.' }],
      isError: true,
    };
  }
  if (operations.length > MAX_BATCH_OPERATIONS) {
    return {
      content: [{ type: 'text', text: `❌ d365fo_file(action="modify"): operations[] has ${operations.length} entries, max ${MAX_BATCH_OPERATIONS}. Split it across calls.` }],
      isError: true,
    };
  }

  const results: Array<{ label: string; ok: boolean; text: string }> = [];
  let stoppedAt = -1;

  // What each operation is travelling with. An entry runs as its own modify
  // call and cannot otherwise see the batch, which is right for the writes and
  // wrong for the advice: add-field told the caller to "send the group entry in
  // the SAME call next time" while the group entry sat two lines below it in
  // that very call. Internal — not part of the published schema.
  const peerOperations = operations
    .map(e => (e && typeof e === 'object' ? String((e as any).operation ?? '') : ''))
    .filter(Boolean);

  for (let i = 0; i < operations.length; i++) {
    const entry = operations[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      results.push({ label: `#${i + 1}`, ok: false, text: 'entry is not an object — expected { operation, … }' });
      stoppedAt = i;
      break;
    }
    // Per-entry keys win over the shared ones, so objectType/objectName/modelName
    // are stated once at the top level and an entry can still override them.
    //
    // Each entry gets the same `params` unwrap the single-operation form gets
    // above. It did not, and the two disagreed in the worst possible direction:
    // get_knowledge(kind="op-spec") tells the caller in bold to "pass these
    // NESTED inside `params`", and doing exactly that inside operations[] left
    // the wrapper object sitting in the args untouched, so the operation ran
    // with none of its parameters and answered "called with no parameter that
    // changes anything — nothing would be written". Run 9180a464 obeyed the
    // spec, was refused, and only got through by ignoring it and passing the
    // keys flat.
    const { params: entryParams, ...entryFlat } = entry as Record<string, unknown>;
    const entryArgs = {
      ...shared,
      ...entryFlat,
      ...(entryParams && typeof entryParams === 'object' && !Array.isArray(entryParams)
        ? (entryParams as Record<string, unknown>)
        : {}),
      peerOperations,
    };
    const opName = String((entry as any).operation ?? '(missing operation)');

    if (!(entry as any).operation) {
      results.push({ label: `#${i + 1}`, ok: false, text: 'entry has no `operation` key' });
      stoppedAt = i;
      break;
    }

    const result = await modifyD365FileTool(subRequest('modify_d365fo_file', entryArgs), context);
    const ok = !result?.isError;
    results.push({ label: `#${i + 1} ${opName}`, ok, text: resultText(result) });

    // Stop on the first failure. These operations are ordered on purpose — a
    // field group references a field added two operations earlier — so carrying
    // on past a failure produces a cascade of confusing secondary errors on top
    // of a half-applied change.
    if (!ok) { stoppedAt = i; break; }
  }

  const succeeded = results.filter(r => r.ok).length;
  const failed = results.length - succeeded;
  const skipped = operations.length - results.length;

  const head =
    `${failed === 0 ? '✅' : '⚠️'} d365fo_file(action="modify") — ${succeeded}/${operations.length} operation(s) applied` +
    (failed ? `, failed at #${stoppedAt + 1}` : '') +
    (skipped ? `, ${skipped} not attempted` : '');

  const body = results
    .map(r => `\n\n### ${r.ok ? '✅' : '❌'} ${r.label}\n${r.text || '(no output)'}`)
    .join('');

  const tail = failed
    ? `\n\n> Operations run in order and stop at the first failure, because a later one usually ` +
      `depends on an earlier one. The ${succeeded} operation(s) above it ARE applied — fix the failing ` +
      `entry and re-send only the remaining ones.`
    : '';

  return {
    content: [{ type: 'text', text: head + body + tail }],
    isError: failed > 0,
  };
}

export async function d365foFileTool(request: CallToolRequest, context: XppServerContext) {
  const parsed = D365FileArgsSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: `❌ d365fo_file: invalid arguments — ${parsed.error.message}` }],
      isError: true,
    };
  }

  const { action, params, ...flat } = parsed.data;

  // Back-compat merge: op-specific values may come nested in `params` (the
  // published schema shape) or flat at top level (legacy callers). Nested
  // values win on key collision; the `params` wrapper itself is not forwarded.
  const rest: Record<string, unknown> =
    params && typeof params === 'object' && !Array.isArray(params)
      ? { ...flat, ...params }
      : flat;

  // A write changes the AOT out from under anything prepare aggregated earlier, so
  // the remembered answers stop being answers. Cleared before the write rather than
  // after: a handler that throws half-way has still touched disk.
  if (action === 'create' || action === 'modify') {
    resetRecentPrepares();
  }

  if (action === 'create') {
    return handleCreateD365File(subRequest('create_d365fo_file', rest), context);
  }
  if (action === 'modify') {
    if (Array.isArray(rest.operations)) {
      return runModifyBatch(rest, context);
    }
    return modifyD365FileTool(subRequest('modify_d365fo_file', rest), context);
  }
  // generate: handler takes the request only (no context).
  return handleGenerateD365Xml(subRequest('generate_d365fo_xml', rest));
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/d365foFile.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.
