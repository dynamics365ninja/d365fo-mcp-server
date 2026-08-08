/**
 * Get Query Info Tool
 * Extract query structure: datasources, ranges, joins.
 *
 * Read-path priority (same chain as tableInfo / viewInfo):
 *   1. C# bridge (IMetadataProvider) — live metadata.
 *   2. Symbol index → query XML (indexed path, or remapped onto the local packages root).
 *   3. Disk scan — a query created this session and not yet indexed.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { parseStringPromise } from '../utils/xml.js';
import type { XppServerContext } from '../types/context.js';
import { tryBridgeQuery } from '../bridge/bridgeAdapter.js';
import { buildObjectTypeMismatchMessage } from '../utils/metadataResolver.js';
import {
  readIndexedXml,
  readXmlFile,
  indexedSourceNote,
  bridgeUnavailableNote,
} from '../utils/indexedXmlLookup.js';
import { findD365FileOnDisk } from '../utils/objectFileLookup.js';

const GetQueryInfoArgsSchema = z.object({
  queryName: z.string().describe('Name of the query'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided)'),
  includeRanges: z.boolean().optional().default(true).describe('Include range definitions'),
  includeJoins: z.boolean().optional().default(true).describe('Include join information'),
  includeFields: z.boolean().optional().default(true).describe('Include field list'),
  includeWorkspace: z.boolean().optional().default(false).describe('Include workspace files'),
  workspacePath: z.string().optional().describe('Path to workspace'),
});

interface QueryRange {
  field: string;
  value: string;
  operator?: string;
}

interface QueryDataSource {
  name: string;
  table: string;
  fetchMode: string;
  ranges: QueryRange[];
  joins: QueryDataSource[];
  fields: string[];
}

export async function getQueryInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetQueryInfoArgsSchema.parse(request.params.arguments);

    // 1. C# bridge (IMetadataProvider — live D365FO metadata)
    const bridgeResult = await tryBridgeQuery(context.bridge, args.queryName);
    if (bridgeResult) return bridgeResult;

    // 2. Symbol index → XML. The bridge returning nothing is NOT proof the query is
    //    missing — it also happens when the bridge is down or its provider does not
    //    cover that package, while `search` still resolves the object.
    const indexed = await readIndexedXml(
      context.symbolIndex.getReadDb(), args.queryName, ['query'], args.modelName,
    );
    if (indexed) {
      const formatted = await formatQueryXml(
        indexed.ref.name, indexed.ref.model, indexed.xml, `XML: ${indexed.ref.localPath}`, args,
      );
      if (formatted) return formatted;
    }

    // 3. Disk scan — a query created this session and not yet indexed
    const diskPath = await findD365FileOnDisk('query', args.queryName, args.modelName);
    if (diskPath) {
      const xml = await readXmlFile(diskPath);
      const formatted = xml && await formatQueryXml(
        args.queryName, args.modelName ?? 'Unknown', xml,
        `live file (not yet in bridge metadata): ${diskPath}`, args,
      );
      if (formatted) return formatted;
    }

    let text = `Query "${args.queryName}" not found via bridge, symbol index, or on disk.\n`;
    text += bridgeUnavailableNote(context);
    try {
      text += buildObjectTypeMismatchMessage(context.symbolIndex.getReadDb(), args.queryName, 'query');
    } catch { /* DB unavailable */ }
    return { content: [{ type: 'text', text }], isError: true };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error getting query info: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

/** Parse AxQuery XML and render the datasource hierarchy. Returns null when the XML isn't an AxQuery. */
async function formatQueryXml(
  queryName: string,
  model: string,
  xml: string,
  source: string,
  opts: { includeRanges: boolean; includeJoins: boolean; includeFields: boolean },
): Promise<{ content: { type: 'text'; text: string }[] } | null> {
  let axQuery: any;
  try {
    axQuery = (await parseStringPromise(xml))?.AxQuery;
  } catch {
    return null;
  }
  if (!axQuery) return null;

  const dataSources = axQuery.DataSources?.[0]
    ? extractDataSources(axQuery.DataSources[0], opts)
    : [];

  let out = `# Query: \`${queryName}\`\n\n**Model:** ${model}\n`;
  if (axQuery.Description?.[0]) out += `**Description:** ${axQuery.Description[0]}\n`;
  out += indexedSourceNote(source);

  if (dataSources.length > 0) {
    out += `## 📊 Data Sources\n\n`;
    out += formatHierarchy(dataSources, 0, opts);
  }
  out += `## 📈 Summary\n\n`;
  out += `- **Data Sources:** ${countDataSources(dataSources)}\n`;
  out += `- **Total Ranges:** ${countRanges(dataSources)}\n`;

  return { content: [{ type: 'text', text: out }] };
}

function extractDataSources(
  node: any,
  opts: { includeRanges: boolean; includeJoins: boolean; includeFields: boolean },
): QueryDataSource[] {
  const out: QueryDataSource[] = [];
  // Root/embedded datasources use different element names across query flavours.
  const nodes = [
    ...(node.AxQuerySimpleRootDataSource ?? []),
    ...(node.AxQuerySimpleEmbeddedDataSource ?? []),
    ...(node.AxQuerySimpleRootObject ?? []),
  ];
  for (const dsNode of nodes) {
    out.push({
      name: dsNode.Name?.[0] ?? 'Unknown',
      table: dsNode.Table?.[0] ?? 'Unknown',
      fetchMode: dsNode.FetchMode?.[0] ?? 'Unknown',
      ranges: opts.includeRanges && dsNode.Ranges?.[0] ? extractRanges(dsNode.Ranges[0]) : [],
      fields: opts.includeFields && dsNode.Fields?.[0] ? extractFields(dsNode.Fields[0]) : [],
      joins: opts.includeJoins && dsNode.DataSources?.[0] ? extractDataSources(dsNode.DataSources[0], opts) : [],
    });
  }
  return out;
}

function extractRanges(node: any): QueryRange[] {
  return (node.AxQuerySimpleDataSourceRange ?? []).map((r: any) => ({
    field: r.Field?.[0] ?? 'Unknown',
    value: r.Value?.[0] ?? '',
    operator: r.Operator?.[0],
  }));
}

function extractFields(node: any): string[] {
  return (node.AxQuerySimpleDataSourceField ?? []).map((f: any) => f.Field?.[0] ?? 'Unknown');
}

function formatHierarchy(
  dataSources: QueryDataSource[],
  indent: number,
  opts: { includeRanges: boolean; includeJoins: boolean; includeFields: boolean },
): string {
  let out = '';
  const pad = '  '.repeat(indent);
  for (const ds of dataSources) {
    out += `${pad}### ${ds.name}\n\n${pad}**Table:** \`${ds.table}\`\n${pad}**Fetch Mode:** ${ds.fetchMode}\n\n`;
    if (opts.includeRanges && ds.ranges.length > 0) {
      out += `${pad}**Ranges:**\n`;
      for (const r of ds.ranges) {
        out += `${pad}- **${r.field}**${r.operator ? ` (${r.operator})` : ''}: \`${r.value}\`\n`;
      }
      out += '\n';
    }
    if (opts.includeFields && ds.fields.length > 0) {
      out += `${pad}**Fields (${ds.fields.length}):**\n`;
      for (const f of ds.fields.slice(0, 10)) out += `${pad}- ${f}\n`;
      if (ds.fields.length > 10) out += `${pad}- ... (${ds.fields.length - 10} more fields)\n`;
      out += '\n';
    }
    if (opts.includeJoins && ds.joins.length > 0) {
      out += `${pad}**Joined Data Sources:**\n\n`;
      out += formatHierarchy(ds.joins, indent + 1, opts);
    }
  }
  return out;
}

function countDataSources(dataSources: QueryDataSource[]): number {
  return dataSources.reduce((n, ds) => n + 1 + countDataSources(ds.joins), 0);
}

function countRanges(dataSources: QueryDataSource[]): number {
  return dataSources.reduce((n, ds) => n + ds.ranges.length + countRanges(ds.joins), 0);
}

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.

