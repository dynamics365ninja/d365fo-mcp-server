/**
 * d365fo_file Tool — unified file/metadata-operation entry point.
 *
 * One tool discriminated by `action`:
 *   • generate → produce AOT XML as TEXT only (Azure/Linux fallback, no write)
 *   • create   → write a NEW AOT object file into PackagesLocalDirectory (write)
 *   • modify   → edit an EXISTING object via IMetadataProvider (write)
 *   • delete   → remove an object's XML and its .rnrproj registration (write)
 *   • undo     → roll a file back to HEAD, or delete it when untracked (write)
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
import { handleCreateD365File, type CreateOutcome } from './write/createD365File.js';
import { handleDeleteD365File } from './write/deleteD365File.js';
import { modifyD365FileTool, type ModifyOutcome } from './write/modifyD365File.js';
import { undoLastModificationTool } from './sdlc/undoLastModification.js';
import { upsertWrittenFileIntoIndex } from './write/inlineIndexUpsert.js';
import {
  verifyWrittenFile, renderWriteVerification, membershipOf,
} from './write/inlineWriteVerification.js';
import { getConfigManager } from '../utils/configManager.js';
import { resetRecentPrepares } from './prepare/prepare.js';
import { testCoverageNote } from './prepare/testFirst.js';
import * as debouncedRefresh from '../bridge/debouncedRefresh.js';
import { truncateOnBlockBoundary } from '../utils/payloadBudget.js';

export const D365_FILE_ACTIONS = ['generate', 'create', 'modify', 'delete', 'undo'] as const;
export type D365FileAction = (typeof D365_FILE_ACTIONS)[number];

const D365FileArgsSchema = z
  .object({
    action: z.enum(D365_FILE_ACTIONS).describe(
      'generate → XML text only (no file written, Azure/Linux fallback); ' +
      'create → write a NEW object file (Windows); modify → edit an EXISTING object (Windows); ' +
      'delete → remove an object file and its project registration (Windows); ' +
      'undo → roll a file back to HEAD, or delete it when untracked (Windows).',
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

/**
 * Per-operation output budget inside a batch.
 *
 * Each section is bounded because the WHOLE response is not: d365fo_file is
 * 'uncapped' in TOOL_CAP_SIZES (a truncated create loses the file path), so
 * nothing downstream trims a batch report. Twenty operations whose per-op text
 * runs long — replace-code echoes the changed region, an inline bpCheck report is
 * itself uncapped — measured at 1,000,573 chars from a SINGLE call, roughly 278k
 * tokens.
 *
 * Capping per SECTION rather than the whole response is deliberate: a tail cut
 * would delete the verdicts of the last operations outright, and which operations
 * applied is the one thing a half-finished batch has to be able to say. Generous
 * enough that an ordinary operation is never touched.
 */
const MAX_OPERATION_CHARS = 4_000;

/**
 * Add a line to a result without disturbing its verdict.
 *
 * Used for the cases where operations[] on a create is deliberately NOT run:
 * the create's own answer has to survive intact, isError included, with the
 * reason the edits were skipped appended to it.
 */
function appendToResult(result: any, note: string): any {
  const content = result?.content;
  const first = Array.isArray(content) ? content[0] : undefined;
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return result;
  return { ...result, content: [{ ...first, text: first.text + note }, ...content.slice(1)] };
}

/**
 * Append the "nothing tests this" line to a write that carried X++.
 *
 * The TDD loop was used zero times in 1,603 measured MCP calls, so it has to be
 * reachable from where people already are — and the moment a rule lands on disk
 * with no test is the moment the observation is worth making. Silent by default:
 * only a successful write, only one that carried X++ (not `add-field`), only when
 * the index can name the target AND says nothing covers it.
 *
 * Never allowed to fail the write it is annotating: a note is not worth an error.
 */
function withTestCoverageNote(result: any, args: Record<string, unknown>, context: XppServerContext): any {
  if (result?.isError) return result;
  try {
    const note = testCoverageNote(context, {
      objectType: typeof args.objectType === 'string' ? args.objectType : undefined,
      objectName: typeof args.objectName === 'string' ? args.objectName : undefined,
      methodName: typeof args.methodName === 'string' ? args.methodName : undefined,
      operation: Array.isArray(args.operations)
        ? (args.operations as Array<{ operation?: unknown }>)
          .map(o => (typeof o?.operation === 'string' ? o.operation : ''))
          .filter(Boolean)
        : (typeof args.operation === 'string' ? args.operation : undefined),
    });
    return note ? appendToResult(result, note) : result;
  } catch {
    return result;
  }
}

/** Concatenated text of a tool result, for folding into the batch report. */
function resultText(result: any): string {
  return (result?.content ?? [])
    .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text)
    .join('\n')
    .trim();
}

/**
 * One modify, creating the extension it names when that is the only thing in the
 * way.
 *
 * The old answer to "File not found for table-extension X" was four retry
 * options, none of which was "create it" — even though the name had already been
 * normalised and the path computed. The logs show the result: the same modify
 * re-sent against the same *_Extension object, failing identically every time.
 *
 * modifyD365FileTool decides WHETHER (base object present, grounding satisfied,
 * autoCorrect on) and reports it through `outcome`; the create is composed here
 * because this is the module that already composes create -> operations[], and
 * because the two write tools are not allowed to import each other
 * (tests/utils/layering.test.ts). Going through handleCreateD365File is the
 * point: path containment, prefixing, .rnrproj registration, the model guards
 * and the direct-XML fallbacks all still apply.
 */
async function modifyWithExtensionAutoCreate(
  args: Record<string, unknown>,
  context: XppServerContext,
  outcome: ModifyOutcome,
): Promise<any> {
  const first = await modifyD365FileTool(subRequest('modify_d365fo_file', args), context, outcome);
  const pending = outcome.createExtensionFirst;
  if (!pending) return first;
  outcome.createExtensionFirst = undefined;

  const createOutcome: CreateOutcome = {};
  const created = await handleCreateD365File(
    subRequest('create_d365fo_file', {
      objectType: pending.objectType,
      objectName: pending.objectName,
      modelName: args.modelName,
      packageName: args.packageName,
      packagePath: args.packagePath,
      addToProject: args.addToProject,
      projectPath: args.projectPath,
      solutionPath: args.solutionPath,
      groundingToken: args.groundingToken,
    }),
    context,
    createOutcome,
  );
  if (created?.isError || !createOutcome.filePath) {
    return appendToResult(created, `\n\n> The ${args.operation} was NOT attempted: creating the extension failed.`);
  }

  // Make the bridge SEE the new file before the edit runs — the same flush the
  // create -> operations[] path needs, for the same reason: without it the
  // provider has not rescanned and the edit fails with "could not resolve", on
  // an object this very call just wrote.
  if (context.bridge) {
    void debouncedRefresh.refresh(context.bridge);
    await debouncedRefresh.flush();
  }

  const finalName = createOutcome.finalObjectName ?? pending.objectName;
  const retry = await modifyD365FileTool(
    subRequest('modify_d365fo_file', {
      ...args,
      objectName: finalName,
      // The path create just wrote, so the retry cannot miss it the same way.
      filePath: createOutcome.filePath,
    }),
    context,
    outcome,
  );
  // The create and the retried operation succeed or fail independently, so the
  // headline has to say which happened. It used to read "created it … and then
  // applied the <operation>" even when the operation had FAILED, describing a
  // write that did not happen and saying nothing about the empty object now on
  // disk and registered in the project.
  const retryFailed = (retry as { isError?: boolean }).isError === true;
  const headline = retryFailed
    ? `⚠️ ${pending.objectType} "${finalName}" did not exist, so it was created (empty, via ` +
      `the ordinary create path) — but the ${args.operation} below then FAILED. The empty ` +
      `${pending.objectType} IS on disk and registered in the project: fix the operation and ` +
      `re-send it against "${finalName}", or remove it with ` +
      `d365fo_file(action="delete", objectType="${pending.objectType}", objectName="${finalName}").`
    : `ℹ️ ${pending.objectType} "${finalName}" did not exist — created it (empty, via the ` +
      `ordinary create path) and then applied the ${args.operation}. Use "${finalName}" in later calls.`;
  return {
    content: [{
      type: 'text',
      text: `${headline}\n📁 ${createOutcome.filePath}\n\n---\n\n${resultText(retry)}`,
    }],
    ...(retryFailed ? { isError: true } : {}),
  };
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

  // A parameter of an entry, wherever the caller put it (flat, or nested in the
  // `params` wrapper the published schema advertises).
  const entryParam = (entry: unknown, name: string): string | undefined => {
    if (!entry || typeof entry !== 'object') return undefined;
    const e = entry as Record<string, any>;
    const value = e[name] ?? (e.params && typeof e.params === 'object' ? e.params[name] : undefined);
    return typeof value === 'string' ? value : undefined;
  };

  // ── Who prints the shared best-practice advisory ─────────────────────────
    // Measured: a batch adding three fields printed the identical 350-char
    // "BPErrorTableFieldNotInFieldGroup … send the group entry in the SAME call"
    // paragraph three times. It is one piece of advice about the whole call, so
    // exactly one entry prints it, naming every field it applies to — and a field
    // whose group entry is already elsewhere in this batch is not one of them.
  const groupedFields = new Set(
    operations
      .filter(e => entryParam(e, 'operation') === 'add-field-to-field-group')
      .map(e => entryParam(e, 'fieldName'))
      .filter(Boolean) as string[],
  );
  const fieldsNeedingGroup = operations
    .filter(e => entryParam(e, 'operation') === 'add-field')
    .map(e => entryParam(e, 'fieldName'))
    .filter((f): f is string => !!f && !groupedFields.has(f));
  const adviceIndex = operations.findIndex(
    e => entryParam(e, 'operation') === 'add-field' &&
      !!entryParam(e, 'fieldName') &&
      fieldsNeedingGroup.includes(entryParam(e, 'fieldName')!),
  );

  // Files this batch wrote, one entry per distinct path. The inline verification
  // and the symbol-index upsert answer a question about the FILE, not about the
  // operation, so running them per operation stat()ed and re-parsed the same file
  // once per entry and repeated its answer in the reply just as often.
  const written = new Map<string, ModifyOutcome>();

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
    // Each entry gets the same `params` unwrap as the single-operation form.
    // Without it the wrapper stayed in the args and the operation ran with no
    // parameters — while op-spec instructs callers to nest them there.
    const { params: entryParams, ...entryFlat } = entry as Record<string, unknown>;
    const entryArgs = {
      ...shared,
      ...entryFlat,
      ...(entryParams && typeof entryParams === 'object' && !Array.isArray(entryParams)
        ? (entryParams as Record<string, unknown>)
        : {}),
      peerOperations,
      batchAdvice: {
        suppressFieldGroupNote: i !== adviceIndex,
        ...(i === adviceIndex ? { fieldGroupNoteFields: fieldsNeedingGroup } : {}),
      },
    };
    const opName = String((entry as any).operation ?? '(missing operation)');

    if (!(entry as any).operation) {
      results.push({ label: `#${i + 1}`, ok: false, text: 'entry has no `operation` key' });
      stoppedAt = i;
      break;
    }

    const outcome: ModifyOutcome = {};
    const result = await modifyWithExtensionAutoCreate(entryArgs, context, outcome);
    const ok = !result?.isError;
    results.push({ label: `#${i + 1} ${opName}`, ok, text: resultText(result) });
    if (ok && outcome.filePath) written.set(outcome.filePath, outcome);

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
    .map(r => {
      const text = r.text || '(no output)';
      const kept = text.length > MAX_OPERATION_CHARS
        ? truncateOnBlockBoundary(text, MAX_OPERATION_CHARS) +
          `\n\n> ✂️ This operation's output was truncated at ${MAX_OPERATION_CHARS} chars ` +
          `(${text.length - MAX_OPERATION_CHARS} omitted). The operation itself is unaffected.`
        : text;
      return `\n\n### ${r.ok ? '✅' : '❌'} ${r.label}\n${kept}`;
    })
    .join('');

  const tail = failed
    ? `\n\n> Operations run in order and stop at the first failure, because a later one usually ` +
      `depends on an earlier one. The ${succeeded} operation(s) above it ARE applied — fix the failing ` +
      `entry and re-send only the remaining ones.`
    : '';

  // The per-file work, once, for the whole call — the per-operation copies are
  // suppressed inside modifyD365FileTool (see the `inBatch` block there).
  const trailerLines: string[] = [];
  const configManager = getConfigManager();
  // Resolved only when there is something to verify — a batch that wrote nothing
  // must not pay for a project lookup to say so.
  const batchProjectPath = written.size
    ? (shared.projectPath as string | undefined) || (await configManager.getProjectPath()) || undefined
    : undefined;
  for (const target of written.values()) {
    const indexNote = await upsertWrittenFileIntoIndex(target.filePath, context);
    const verifyNote = renderWriteVerification(
      await verifyWrittenFile(
        target.filePath,
        batchProjectPath,
        membershipOf(
          target.objectType ?? '',
          target.objectName ?? '',
          target.modelName ?? configManager.getModelName(),
        ),
      ),
    );
    trailerLines.push(
      (written.size > 1 ? `\n${target.objectName ?? target.filePath}:` : '') + verifyNote + indexNote,
    );
  }
  // No batch-edit hint here: this call already IS the batch, and telling a caller
  // that just sent operations[] to send operations[] is the same defect the
  // per-operation suppression exists to avoid.
  const trailer = trailerLines.length
    ? `\n${trailerLines.join('')}` +
      `\n\nNext: build_d365fo_project(bpCheck:true) — builds and runs the best-practice check in one call.`
    : '';

  return {
    content: [{ type: 'text', text: head + body + tail + trailer }],
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
  if (action === 'create' || action === 'modify' || action === 'delete' || action === 'undo') {
    resetRecentPrepares();
  }

  // undo: folded in from the retired `undo_last_modification` tool. Routed
  // before the write actions because it takes only `filePath` — none of the
  // objectType/objectName plumbing below applies to it.
  if (action === 'undo') {
    return undoLastModificationTool(rest, context);
  }

  if (action === 'create') {
    // 16 of the create -> modify sequences in the sampled sessions targeted the
    // object that create had just made: a table is created, then its field group,
    // index or extra fields arrive one MCP call at a time. operations[] on create
    // applies them in the same call.
    const { operations, ...createArgs } = rest as { operations?: unknown } & Record<string, unknown>;
    const outcome: CreateOutcome = {};
    // Stamped BEFORE the create so the refresh check below can tell "the bridge
    // rebuilt the provider as part of this create" from "the last rebuild was
    // some earlier call's".
    const createStartedAt = Date.now();
    const created = await handleCreateD365File(subRequest('create_d365fo_file', createArgs), context, outcome);

    if (!Array.isArray(operations) || operations.length === 0) return created;
    // Never run edits against an object that was not created.
    if (created?.isError) {
      return appendToResult(created,
        `\n\n> ${operations.length} operation(s) were NOT attempted: the create above failed.`);
    }
    // The one thing this must not do is guess. create publishes the name it
    // actually wrote (prefix normalization included); without it, a chained edit
    // could land on a different object — or on nothing — while reporting success.
    if (!outcome.finalObjectName) {
      return appendToResult(created,
        `\n\n> ${operations.length} operation(s) were NOT attempted: this create did not report the ` +
        `final object name, so the target cannot be established without guessing. Send them as a ` +
        `separate d365fo_file(action="modify", operations:[…]) call.`);
    }

    // Make the bridge SEE the new object before the edits run.
    //
    // Between two MCP calls toolHandler settles this via flush(); inside one call
    // nothing did, so the DiskProvider had not seen the new file and the first
    // operation failed with "could not resolve table 'Fm-mcpFmChainProbeTbl'" — on
    // a table that was on disk, 1177 bytes, named in the create's own reply.
    // Found only by running it live against the sandbox; no mock could show it.
    //
    // Scheduled AND flushed: flush() alone is a no-op when nothing is pending, and
    // the create path that writes XML directly schedules no rebuild of its own.
    // refresh() queues one, flush() runs it now instead of after the 400 ms settle.
    if (context.bridge) {
      // ...unless the create ALREADY caused one. The C# dispatcher runs
      // RefreshProvider() itself after a successful createObject /
      // createSmartTable, and the adapter records that via markRefreshStarted().
      // Refreshing again here rebuilt the whole DiskProvider a second time for
      // the same tree - the create path that writes XML directly is the one that
      // genuinely needs this, because nothing else schedules a rebuild for it.
      if (debouncedRefresh.getLastRefreshStartedAt() < createStartedAt) {
        void debouncedRefresh.refresh(context.bridge);
        await debouncedRefresh.flush();
      }
    }

    const batch = await runModifyBatch({
      objectType: createArgs.objectType,
      modelName: createArgs.modelName,
      // The written name, not the requested one.
      objectName: outcome.finalObjectName,
      operations,
    }, context);
    return {
      content: [{
        type: 'text',
        text: `${resultText(created)}\n\n---\n\n${resultText(batch)}`,
      }],
      ...((batch as { isError?: boolean }).isError ? { isError: true } : {}),
    };
  }
  if (action === 'modify') {
    const modified = Array.isArray(rest.operations)
      ? await runModifyBatch(rest, context)
      : await modifyWithExtensionAutoCreate(rest, context, {});
    return withTestCoverageNote(modified, rest, context);
  }
  if (action === 'delete') {
    return handleDeleteD365File(subRequest('delete_d365fo_file', rest), context);
  }
  // generate: handler takes the request only (no context).
  return handleGenerateD365Xml(subRequest('generate_d365fo_xml', rest));
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/d365foFile.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.
