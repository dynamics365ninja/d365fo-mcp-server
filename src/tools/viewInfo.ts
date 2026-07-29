/**
 * Get View Info Tool
 * Extract view / data entity view structure: fields, computed columns, relations, methods.
 *
 * Read-path priority (mirrors tableInfo):
 *   1. C# bridge readView       — live AxView metadata (IMetadataProvider).
 *   2. C# bridge readDataEntity — AxDataEntityView; the symbol index stores data
 *      entities as type 'view', so `objectType="view"` legitimately resolves them.
 *   3. Symbol index → extracted metadata JSON / XML on disk — serves offline,
 *      Azure-hosted and "package not on this box" (UDE) scenarios, where `search`
 *      finds the view but the bridge's DiskProvider does not.
 *   4. Disk scan — a view created this session and not yet indexed.
 */

import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { tryBridgeView, tryBridgeDataEntity } from '../bridge/bridgeAdapter.js';
import { readViewMetadata, buildObjectTypeMismatchMessage } from '../utils/metadataResolver.js';
import {
  resolveIndexedObject,
  indexedSourceNote,
  bridgeUnavailableNote,
} from '../utils/indexedXmlLookup.js';
import { findD365FileOnDisk } from './modifyD365File.js';

const GetViewInfoArgsSchema = z.object({
  viewName: z.string().describe('Name of the view or data entity'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided)'),
  includeFields: z.boolean().optional().default(true).describe('Include field list'),
  includeRelations: z.boolean().optional().default(true).describe('Include relations'),
  includeMethods: z.boolean().optional().default(true).describe('Include methods'),
  includeWorkspace: z.boolean().optional().default(false).describe('Include workspace files'),
  workspacePath: z.string().optional().describe('Path to workspace'),
});

/** Normalised view shape shared by the extracted-metadata JSON and the XML parser. */
interface ViewLike {
  name: string;
  model?: string;
  type?: 'view' | 'data-entity';
  label?: string;
  isPublic?: boolean;
  isReadOnly?: boolean;
  primaryKey?: string;
  fields?: Array<{
    name: string;
    dataSource?: string;
    dataField?: string;
    dataMethod?: string;
    isComputed?: boolean;
  }>;
  relations?: Array<{
    name: string;
    relatedTable: string;
    cardinality?: string;
    fields?: Array<{ field: string; relatedField: string }>;
  }>;
  methods?: Array<{ name: string } | string>;
}

export async function getViewInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetViewInfoArgsSchema.parse(request.params.arguments);

    // 1. C# bridge — AxView (live D365FO metadata)
    const bridgeResult = await tryBridgeView(context.bridge, args.viewName);
    if (bridgeResult) return bridgeResult;

    // 2. C# bridge — AxDataEntityView (data entities are indexed as type 'view')
    const entityResult = await tryBridgeDataEntity(context.bridge, args.viewName);
    if (entityResult) return entityResult;

    // 3. Symbol index → extracted metadata / XML
    const indexResult = await buildViewResponseFromIndex(context, args.viewName, args.modelName);
    if (indexResult) return indexResult;

    // 4. Disk scan — a view created this session and not yet indexed
    const diskResult = await buildViewResponseFromDisk(context, args.viewName, args.modelName);
    if (diskResult) return diskResult;

    return {
      content: [{ type: 'text', text: buildNotFoundText(context, args.viewName) }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error getting view info: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

/**
 * Serve view info from the symbol index: extracted-metadata JSON first, then the
 * indexed XML file (remapped to the local packages path when the DB stores a
 * build-agent path). Falls back to the indexed field/method symbols so a view the
 * index knows about is never reported as "not found".
 */
async function buildViewResponseFromIndex(
  context: XppServerContext,
  viewName: string,
  modelName?: string,
): Promise<{ content: { type: 'text'; text: string }[] } | null> {
  let ref;
  try {
    ref = await resolveIndexedObject(context.symbolIndex.getReadDb(), viewName, ['view'], modelName);
  } catch {
    return null; // DB unavailable
  }
  if (!ref) return null;
  const model = ref.model;

  // Pre-extracted JSON (works without a D365FO installation)
  const extracted = await readViewMetadata(model, ref.name);
  if (extracted) {
    return {
      content: [{ type: 'text', text: formatViewLike(extracted, model, 'symbol index (extracted metadata)') }],
    };
  }

  // XML on disk — the indexed path, or the same path remapped locally
  if (ref.localPath) {
    const parsed = await context.parser.parseViewFile(ref.localPath, model);
    if (parsed.success && parsed.data) {
      return { content: [{ type: 'text', text: formatViewLike(parsed.data, model, `XML: ${ref.localPath}`) }] };
    }
  }

  // Last resort — the field/method symbols captured at index time
  return { content: [{ type: 'text', text: formatViewFromSymbols(context, ref.name, model) }] };
}

async function buildViewResponseFromDisk(
  context: XppServerContext,
  viewName: string,
  modelName?: string,
): Promise<{ content: { type: 'text'; text: string }[] } | null> {
  for (const objectType of ['view', 'data-entity'] as const) {
    const diskPath = await findD365FileOnDisk(objectType, viewName, modelName);
    if (!diskPath) continue;
    const model = modelName || path.basename(path.dirname(path.dirname(diskPath)));
    const parsed = await context.parser.parseViewFile(diskPath, model);
    if (parsed.success && parsed.data) {
      return {
        content: [{
          type: 'text',
          text: formatViewLike(parsed.data, model, `live file (not yet in bridge metadata): ${diskPath}`),
        }],
      };
    }
  }
  return null;
}

function formatViewLike(v: ViewLike, model: string, source: string): string {
  const kind = v.type === 'data-entity' ? 'Data Entity View' : 'View';
  let out = `# ${kind}: ${v.name}\n\n`;
  if (v.label) out += `**Label:** ${v.label}\n`;
  out += `**Model:** ${v.model || model}\n`;
  if (v.isPublic != null) out += `**Public:** ${v.isPublic ? 'Yes' : 'No'}\n`;
  if (v.isReadOnly != null) out += `**Read-Only:** ${v.isReadOnly ? 'Yes' : 'No'}\n`;
  if (v.primaryKey) out += `**Primary Key:** ${v.primaryKey}\n`;
  out += indexedSourceNote(source);

  const fields = v.fields ?? [];
  if (fields.length > 0) {
    const computed = fields.filter(f => f.isComputed || (!!f.dataMethod && !f.dataField));
    const mapped = fields.filter(f => !computed.includes(f));

    out += `## 📊 Fields (${fields.length})\n\n`;
    if (mapped.length > 0) {
      out += `### Mapped Fields (${mapped.length})\n\n`;
      out += `| Field Name | Data Source | Data Field |\n|---|---|---|\n`;
      for (const f of mapped) out += `| ${f.name} | ${f.dataSource ?? '—'} | ${f.dataField ?? '—'} |\n`;
      out += '\n';
    }
    if (computed.length > 0) {
      out += `### Computed Fields (${computed.length})\n\n`;
      out += `| Field Name | Data Method |\n|---|---|\n`;
      for (const f of computed) out += `| ${f.name} | ${f.dataMethod ?? '—'} |\n`;
      out += '\n';
    }
  }

  const relations = v.relations ?? [];
  if (relations.length > 0) {
    out += `## 🔗 Relations (${relations.length})\n\n`;
    for (const rel of relations) {
      out += `- **${rel.name}** → ${rel.relatedTable}${rel.cardinality ? ` (${rel.cardinality})` : ''}\n`;
      for (const c of rel.fields ?? []) out += `  - ${c.field} = ${c.relatedField}\n`;
    }
    out += '\n';
  }

  const methods = v.methods ?? [];
  if (methods.length > 0) {
    out += `## 🔧 Methods (${methods.length})\n\n`;
    for (const m of methods) out += `- ${typeof m === 'string' ? m : m.name}\n`;
  }

  return out;
}

/** Build a minimal view report from the field/method rows stored in the symbol index. */
function formatViewFromSymbols(context: XppServerContext, viewName: string, model: string): string {
  let fields: Array<{ name: string; signature: string | null }> = [];
  let methods: Array<{ name: string; signature: string | null }> = [];
  try {
    const db = context.symbolIndex.getReadDb();
    fields = db.prepare(
      `SELECT name, signature FROM symbols WHERE parent_name = ? AND type = 'field' ORDER BY name`
    ).all(viewName) as typeof fields;
    methods = db.prepare(
      `SELECT name, signature FROM symbols WHERE parent_name = ? AND type = 'method' ORDER BY name`
    ).all(viewName) as typeof methods;
  } catch { /* DB unavailable — emit the header only */ }

  let out = `# View: ${viewName}\n\n**Model:** ${model}\n`;
  out += `_Source: symbol index (bridge and view XML unavailable — field types and relations are not included)._\n\n`;
  out += `## Fields (${fields.length})\n\n`;
  for (const f of fields) out += `- **${f.name}**${f.signature ? ` → ${f.signature}` : ''}\n`;
  if (methods.length > 0) {
    out += `\n## Methods (${methods.length})\n\n`;
    for (const m of methods) out += `- ${m.signature || m.name}\n`;
  }
  return out;
}

function buildNotFoundText(context: XppServerContext, viewName: string): string {
  let text = `View "${viewName}" not found via bridge, symbol index, or on disk.\n`;
  text += bridgeUnavailableNote(context.bridge);
  try {
    text += buildObjectTypeMismatchMessage(context.symbolIndex.getReadDb(), viewName, 'view');
  } catch { /* DB unavailable */ }
  return text;
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.
