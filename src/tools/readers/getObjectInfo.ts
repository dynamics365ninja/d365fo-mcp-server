/**
 * Get Object Info Tool — unified object metadata reader, single or plural.
 *
 * Replaces the per-type get_*_info tools (get_class_info, get_table_info, …,
 * get_service_info, get_macro_info) with one tool discriminated by `objectType`,
 * and absorbs the former `batch_get_info` as its plural `objects[]` form so the
 * batched path is the DEFAULT path instead of a separate tool the model has to
 * discover (issue #831 — 13 sequential lookups in one session, zero batch calls).
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
import type { XppServerContext } from '../../types/context.js';
import { READER_DISPATCH, OBJECT_INFO_TYPES, withNotFoundGuidance } from './objectInfoRegistry.js';
import { detectObjectTypeInDb, isNotFoundResultText } from '../../utils/metadataResolver.js';
import { completionTool } from './completion.js';
import { getMethodTool } from './getMethod.js';
import { readObjectXml } from './objectXml.js';
import { COMPACT_METHODS_HINT } from '../../utils/methodBodyHint.js';

/** Ceiling on one plural call — inherited from the retired batch_get_info. */
const MAX_OBJECTS = 10;

const OBJECT_TYPE_DESCRIPTION =
  'Kind of object to read: class, table, form, query, view, enum, edt, report, ' +
  'data-entity, menu-item, service, map, config-key, security-policy, macro. ' +
  'Extension types list every extension of a base object: table-extension, ' +
  'form-extension, enum-extension, edt-extension, data-entity-extension, class-extension. ' +
  'For any *-extension the name may be either the full extension name ' +
  '(e.g. "CustInvoiceJour.Extension") or just the base object name — ' +
  'both are accepted; the base object name is extracted automatically.';

const OPTIONS_DESCRIPTION =
  'Optional type-specific flags forwarded to the reader. ' +
  'Class: { "compact": false } for full source, { "methodOffset": 15 } for next method page, ' +
  '{ "members": "names" } for fast member-name list (add "prefix" to filter), ' +
  '{ "method": "validateWrite", "include": "signature" } for ONE method (include: signature | source | both). ' +
  'Table: { "fieldsOffset": 50 } for the next field page, { "fieldFilter": "Invoice" } to list only matching fields, ' +
  '{ "relations": true } for the relation list, { "compact": false } for method bodies + relations. ' +
  'Report: { "includeRdl": true }. Form: { "searchControl": "AccountNum" }, { "maxControls": 300 }. Macro: { "filter": "Path" }. ' +
  'Any type: { "include": "xml" } returns the raw AOT XML and its path — use it instead of shelling out to ' +
  'Get-ChildItem/Get-Content; page it with { "startLine": 1, "endLine": 200 }.';

/**
 * One entry of the plural `objects[]` form. The name lives in `objectName` —
 * the key `verify_d365fo_project` and `run_bp_check` already use for their own
 * `objects[]` entries, so every plural object list on the server reads the same.
 */
const ObjectRefSchema = z.object({
  objectType: z.enum(OBJECT_INFO_TYPES).describe(OBJECT_TYPE_DESCRIPTION),
  objectName: z.string().min(1).describe('Exact object name (use search/search(queries=[...]) first if unsure).'),
  options: z.record(z.string(), z.any()).optional().describe(OPTIONS_DESCRIPTION),
});

const GetObjectInfoArgsSchema = z.object({
  objects: z.array(ObjectRefSchema).min(1).max(MAX_OBJECTS).optional().describe(
    `Read 2+ objects in ONE call (max ${MAX_OBJECTS}) — all lookups run in parallel and come back as ` +
    'per-object sections. Preferred over N sequential single-object calls.',
  ),
  objectType: z.enum(OBJECT_INFO_TYPES).optional().describe(OBJECT_TYPE_DESCRIPTION),
  name: z.string().min(1).optional().describe('Exact object name (use search/search(queries=[...]) first if unsure).'),
  // Top-level class shortcuts — accepted directly so callers don't need to nest them in options.
  methodOffset: z.number().optional().describe('[class] Pagination offset for methods. Classes with >15 methods are paged; pass multiples of 15 to get the next page.'),
  compact: z.boolean().optional().describe('[class] true = signatures only (default), false = include full method source bodies.'),
  options: z.record(z.string(), z.any()).optional().describe(OPTIONS_DESCRIPTION),
});

/** A single resolved lookup: type + name + the options the reader should see. */
interface ObjectRef {
  objectType: string;
  name: string;
  options: Record<string, any>;
}

function invalidArgs(detail: string) {
  return {
    content: [{ type: 'text', text: `❌ get_object_info: invalid arguments — ${detail}` }],
    isError: true,
  };
}

/**
 * Normalise both call forms into a flat list of lookups.
 *
 * The single `{objectType, name}` form is exactly the one-element plural form
 * `{objects:[{objectType, objectName}]}` — that equivalence is the compatibility
 * guarantee, and the only difference is the key the name arrives under (the
 * top-level parameter has always been `name`; `objects[]` entries follow the
 * server-wide `objectName` convention). Top-level options (incl. the
 * `compact`/`methodOffset` shortcuts) act as defaults for every entry so
 * `{objects:[…], compact:false}` reads full source for the whole batch; a
 * per-entry `options` wins over them.
 */
function toObjectRefs(args: z.infer<typeof GetObjectInfoArgsSchema>): ObjectRef[] | null {
  const shared: Record<string, any> = { ...args.options };
  if (args.methodOffset !== undefined) shared.methodOffset = args.methodOffset;
  if (args.compact !== undefined) shared.compact = args.compact;

  if (args.objects?.length) {
    return args.objects.map(o => ({
      objectType: o.objectType,
      name: o.objectName,
      options: { ...shared, ...o.options },
    }));
  }
  if (args.objectType && args.name) {
    return [{ objectType: args.objectType, name: args.name, options: shared }];
  }
  return null;
}

/**
 * `compact` is a promise about SIZE, not about classes.
 *
 * VERIFIED LIVE (2026-08-25): `get_object_info(objectType="table",
 * name="CustTable", options:{compact:true})` returned a response byte-identical
 * to the default — 20,199 chars — because only the class reader had ever read
 * the flag. A knob that is advertised and does nothing is worse than an absent
 * one: the caller believes it has already asked for less.
 *
 * class and table read `compact` natively (see classInfo.ts / tableInfo.ts).
 * The other verbose readers each already have a knob that trims them, so
 * `compact` is TRANSLATED into that knob rather than duplicated into their
 * schemas — those files are owned elsewhere, and one meaning per knob is what
 * keeps the two paths from drifting:
 *
 *   • form   → `maxControls`. The control tree is the form's large block; a
 *              compact read caps it well below the 150 default and the existing
 *              controls footer still says how many were skipped and how to get them.
 *   • report → `includeRdl`. The embedded RDL reaches 2 MB; it is already
 *              opt-in, so compact:false is the one that has to mean something.
 *
 * Only ever applied when the CALLER passed `compact` explicitly — these readers'
 * own defaults are not this function's to change.
 */
const COMPACT_FORM_CONTROLS = 60;

function applyCompactTranslation(objectType: string, options: Record<string, any>): Record<string, any> {
  if (options?.compact === undefined) return options;
  const compact = options.compact === true;
  const out = { ...options };
  if (objectType === 'form' && compact && out.maxControls === undefined) {
    out.maxControls = COMPACT_FORM_CONTROLS;
  }
  // Only the SUPPRESSING direction. `compact:false` used to set includeRdl=true
  // and pull in the whole report definition — get_object_info is uncapped, so
  // that is up to 60,000 chars a caller did not ask for. Wanting the RDL is what
  // `includeRdl:true` is for.
  if (objectType === 'report' && compact && out.includeRdl === undefined) {
    out.includeRdl = false;
  }
  return out;
}

/**
 * Object types whose methods `options.method` can read.
 *
 * Kept in step with `OBJECT_TYPES` in tools/knowledge/methodSignature.ts — that
 * is the tool this option delegates to, and the two disagreeing is what made a
 * table's `validateWrite` unreadable through the folded call.
 */
const METHOD_OWNER_TYPES = new Set(['class', 'table', 'view', 'data-entity']);

/**
 * The get_object_info `objectType` that reads an index row of this type, or null
 * when nothing here can read it.
 *
 * The index stores the three menu-item flavours separately; get_object_info has
 * one `menu-item` reader that covers all of them.
 */
function readerTypeForIndexType(indexType: string): string | null {
  if (READER_DISPATCH[indexType]) return indexType;
  if (indexType.startsWith('menu-item-')) return 'menu-item';
  return null;
}

/**
 * Answer for the type the object ACTUALLY is, when exactly one is plausible.
 *
 * VERIFIED LIVE (2026-08-25): `get_object_info(objectType="class",
 * name="CustTable")` answered "❌ Class not found" plus a "Type Mismatch" block
 * listing form/query/table and telling the caller to call get_object_info again
 * with the right type. The server had already done the lookup that proves which
 * types exist — making the caller spend another round trip to act on it is the
 * expensive half of the answer, and every round trip re-bills the whole cached
 * context.
 *
 * So: ONE plausible type → read it and say plainly that this is what happened,
 * the same "corrected, here is what I did" shape the write tools use (and the
 * wording prepare uses for its own ambiguity disclosure). SEVERAL plausible types
 * → nothing here can pick for the caller, so today's list stands unchanged.
 *
 * Returns null whenever the correction does not apply, so the caller falls
 * through to the existing not-found guidance untouched.
 */
async function answerForActualType(
  result: any,
  ref: ObjectRef,
  context: XppServerContext,
): Promise<any | null> {
  const text: string | undefined = result?.content?.[0]?.text;
  if (!isNotFoundResultText(text)) return null;

  let rows: Array<{ type: string; model: string }> = [];
  try {
    rows = detectObjectTypeInDb(context.symbolIndex.getReadDb(), ref.name);
  } catch {
    return null;
  }

  const indexed = [...new Set(
    rows.map(r => readerTypeForIndexType(r.type)).filter((t): t is string => !!t),
  )];

  // The index says the object DOES exist as the type that was asked for, so the
  // read failed for some other reason — a stale file_path, the bridge down, the
  // file moved. Correcting here would answer for a different object AND assert
  // "does not exist as a <requested>, it exists only as a <other>", both false.
  // This is the guard buildObjectTypeMismatchMessage has always had
  // (metadataResolver.ts: `if (expectedEntries.length > 0 …) return ''`) and it
  // was lost when the correction was folded in here. Note the trigger for this
  // path is usually "the live source of truth is broken" — the worst moment to
  // treat the index as an oracle.
  if (indexed.includes(ref.objectType)) return null;

  const candidates = indexed.filter(t => t !== ref.objectType);
  if (candidates.length !== 1) return null;

  const actualType = candidates[0];
  const model = rows.find(r => readerTypeForIndexType(r.type) === actualType)?.model;
  // No further correction from inside the correction: one hop, or a pair of
  // types that each redirect to the other would recurse.
  const corrected = await readObject(
    { objectType: actualType, name: ref.name, options: ref.options }, context, false,
  );
  // The corrected read failed too — the caller is better served by the original
  // error plus the type list than by a second not-found in a different type.
  if (corrected?.isError) return null;

  const disclosure =
    `> ℹ️  \`${ref.name}\` does not exist as a **${ref.objectType}** — it exists only as a ` +
    `**${actualType}**${model ? ` (model: ${model})` : ''}, so this is the ${actualType}. ` +
    `Pass \`objectType="${actualType}"\` to address it directly.\n\n`;
  const [first, ...rest] = corrected.content ?? [];
  return {
    ...corrected,
    content: [
      { type: 'text', text: disclosure + (first?.type === 'text' ? first.text : '') },
      ...(first?.type === 'text' ? rest : corrected.content ?? []),
    ],
  };
}

/** Resolve one object through its registered reader, with the shared not-found guidance. */
async function readObject(ref: ObjectRef, context: XppServerContext, allowTypeCorrection = true) {
  const { objectType, name } = ref;
  // `compact` means the same thing for every type that has a verbose form —
  // see applyCompactTranslation.
  const options = applyCompactTranslation(objectType, ref.options);

  // Folded get_method: one method's signature and/or source.
  // get_object_info(objectType="class", name, options:{ method:"validateWrite", include? })
  //
  // get_method was its own tool purely for historical reasons and the mandated
  // chain was search → get_object_info → get_method: three round trips to read
  // one signature, where the middle call already had the class in hand. Folding
  // it here removes that hop and its ~926 chars from every ListTools payload.
  // The file itself, when the rendered metadata is not what is wanted. Checked
  // before options.method so {method, include:"xml"} cannot silently mean two
  // things.
  if (options?.include === 'xml') {
    const xml = await readObjectXml(objectType, name, {
      modelName: options.modelName as string | undefined,
      startLine: options.startLine as number | undefined,
      endLine: options.endLine as number | undefined,
      maxChars: options.maxChars as number | undefined,
    });
    return { content: [{ type: 'text', text: xml.text }], ...(xml.isError ? { isError: true } : {}) };
  }

  if (options?.method) {
    // get_method resolves methods on classes, tables, views and data entities
    // (its own OBJECT_TYPES), so gating this on `class` alone refused calls the
    // underlying tool would have answered. `options.method:"validateWrite"` on a
    // table is the obvious one, and the refusal sent the caller hunting for a
    // separate tool instead of naming the types that do work.
    if (!METHOD_OWNER_TYPES.has(objectType)) {
      return {
        content: [{
          type: 'text',
          text: `❌ get_object_info: options.method works on ${[...METHOD_OWNER_TYPES].join(', ')} — ` +
            `"${objectType}" stores no methods, so omit it to get full metadata.`,
        }],
        isError: true,
      };
    }
    const methodRequest: CallToolRequest = {
      method: 'tools/call',
      params: {
        name: 'get_method',
        arguments: {
          className: name,
          methodName: String(options.method),
          include: options.include,
          // The schema advertises modelName among the flags forwarded to the
          // reader, and get_method takes one — dropping it here made the
          // documented way to disambiguate a name that two models both define
          // do nothing at all.
          modelName: options.modelName,
        },
      },
    };
    return getMethodTool(methodRequest, context);
  }

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
  if (result?.isError && allowTypeCorrection) {
    const corrected = await answerForActualType(result, { ...ref, options }, context);
    if (corrected) return corrected;
  }
  return withNotFoundGuidance(result, name, objectType);
}

/**
 * Flatten a reader result into the single string a plural section holds.
 *
 * This used to read `content[0].text` only, which SILENTLY DROPPED everything a
 * multi-item reader returned after the first block — the plural form then looked
 * like it had answered while withholding part of the metadata, which is worse
 * than failing. The single-object form never had the bug because it passes the
 * whole content array through untouched.
 */
function joinContentText(result: any): string {
  const texts = (result?.content ?? [])
    .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text);
  return texts.length ? texts.join('\n\n') : 'No content';
}

/**
 * Plural form: fan out to every reader in parallel (same pattern as prepare) and
 * assemble one result with per-object sections — N round trips collapse to one.
 */
async function readObjects(refs: ObjectRef[], context: XppServerContext) {
  const startTime = Date.now();

  const results = await Promise.all(refs.map(async (ref) => {
    try {
      const result = await readObject(ref, context);
      return { ...ref, success: !result.isError, text: joinContentText(result) };
    } catch (err) {
      return { ...ref, success: false, text: `Error: ${err instanceof Error ? err.message : err}` };
    }
  }));

  const okCount = results.filter(r => r.success).length;
  // The compact-methods hint is advice about how to call this tool, not a fact
  // about one object, but it is emitted per class because that is the only
  // place that knows whether bodies were withheld. Ten classes in one call
  // would otherwise repeat the same two lines of call syntax ten times, in a
  // response format that exists to save round trips. Keep the first, drop the
  // rest.
  let hintShown = false;
  const sections = results.map((r, i) => {
    let text = r.text;
    if (text.includes(COMPACT_METHODS_HINT)) {
      if (hintShown) text = text.split(`${COMPACT_METHODS_HINT}\n\n`).join('').split(COMPACT_METHODS_HINT).join('');
      hintShown = true;
    }
    return `## ${i + 1}. ${r.name} [${r.objectType.toUpperCase()}] ${r.success ? '' : '❌'}\n\n${text}`;
  });

  const header =
    `# Object Info\n\n` +
    `Fetched: ${results.length} object(s) in parallel | Success: ${okCount}/${results.length} | ` +
    `Time: ${Date.now() - startTime}ms\n\n---\n\n`;

  return {
    content: [{ type: 'text', text: header + sections.join('\n\n---\n\n') }],
    isError: okCount === 0,
  };
}

export async function getObjectInfoTool(request: CallToolRequest, context: XppServerContext) {
  const parsed = GetObjectInfoArgsSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) return invalidArgs(parsed.error.message);

  const refs = toObjectRefs(parsed.data);
  if (!refs) {
    return invalidArgs('pass either {objectType, name} for one object or {objects:[{objectType, objectName}, …]} for several.');
  }

  // One object stays a plain single-object result — no batch header, no sections.
  return refs.length === 1 ? readObject(refs[0], context) : readObjects(refs, context);
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/getObjectInfo.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.
