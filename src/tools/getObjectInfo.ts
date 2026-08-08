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
import type { XppServerContext } from '../types/context.js';
import { READER_DISPATCH, OBJECT_INFO_TYPES, withNotFoundGuidance } from './objectInfoRegistry.js';
import { completionTool } from './completion.js';

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
  '{ "members": "names" } for fast member-name list (add "prefix" to filter). ' +
  'Table: { "fieldsOffset": 50 } for the next field page, { "fieldFilter": "Invoice" } to list only matching fields. ' +
  'Report: { "includeRdl": true }. Form: { "searchControl": "AccountNum" }, { "maxControls": 300 }. Macro: { "filter": "Path" }.';

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

/** Resolve one object through its registered reader, with the shared not-found guidance. */
async function readObject(ref: ObjectRef, context: XppServerContext) {
  const { objectType, name, options } = ref;

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
  const sections = results.map((r, i) =>
    `## ${i + 1}. ${r.name} [${r.objectType.toUpperCase()}] ${r.success ? '' : '❌'}\n\n${r.text}`,
  );

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

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts — the single source of truth for tool instructions.
