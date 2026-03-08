/**
 * Get Query Info Tool
 * Extract query structure: datasources, ranges, joins
 * Returns datasource hierarchy, range definitions, join configuration
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { promises as fs } from 'fs';
import { parseStringPromise } from 'xml2js';
import { buildXmlNotAvailableMessage, resolveDbPathLocally } from '../utils/metadataResolver.js';

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

interface QueryInfo {
  name: string;
  model: string;
  description?: string;
  dataSources: QueryDataSource[];
}

export async function getQueryInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetQueryInfoArgsSchema.parse(request.params.arguments);
    const { symbolIndex, hybridSearch } = context;
    const { 
      queryName, 
      modelName, 
      includeRanges, 
      includeJoins, 
      includeFields,
      includeWorkspace,
      workspacePath
    } = args;

    // 1. Find the query (with workspace support)
    let queryRow: any = null;
    
    // Try workspace first if requested
    if (includeWorkspace && workspacePath && hybridSearch) {
      const workspaceResults = await hybridSearch.search(queryName, {
        types: ['query'],
        limit: 1,
        workspacePath,
        includeWorkspace: true,
      });
      
      if (workspaceResults.length > 0 && workspaceResults[0].source === 'workspace' && workspaceResults[0].file) {
        queryRow = {
          file_path: workspaceResults[0].file.path,
          model: 'Workspace',
          name: queryName,
        };
      }
    }
    
    // Fallback to database if not found in workspace
    if (!queryRow) {
      let stmt;
      if (modelName) {
        stmt = symbolIndex.db.prepare(`
          SELECT file_path, model, name
          FROM symbols
          WHERE type = 'query' AND name = ? AND model = ?
          LIMIT 1
        `);
        queryRow = stmt.get(queryName, modelName) as any;
      } else {
        stmt = symbolIndex.db.prepare(`
          SELECT file_path, model, name
          FROM symbols
          WHERE type = 'query' AND name = ?
          ORDER BY model
          LIMIT 1
        `);
        queryRow = stmt.get(queryName) as any;
      }
    }

    if (!queryRow) {
      throw new Error(`Query "${queryName}" not found. Make sure it's indexed or provide workspacePath for local queries.`);
    }

    // 2. Parse XML (file_path may point to build-agent path — not accessible on this server)
    let xmlContent: string | null = null;
    try {
      xmlContent = await fs.readFile(queryRow.file_path, 'utf-8');
    } catch {
      // Build-agent path not accessible — try to remap to local PackagesLocalDirectory
      const remappedPath = await resolveDbPathLocally(queryRow.file_path);
      if (remappedPath) {
        try {
          xmlContent = await fs.readFile(remappedPath, 'utf-8');
        } catch {
          // Remapped path also not readable
        }
      }
    }

    if (!xmlContent) {
      return {
        content: [{ type: 'text', text: buildXmlNotAvailableMessage('query', queryName, queryRow.file_path) }],
        isError: true,
      };
    }
    const xmlObj = await parseStringPromise(xmlContent);

    // 3. Extract query info
    const queryInfo: QueryInfo = {
      name: queryName,
      model: queryRow.model,
      dataSources: [],
    };

    const axQuery = xmlObj.AxQuery;
    if (!axQuery) {
      throw new Error('Invalid AxQuery XML structure');
    }

    // Extract description
    if (axQuery.Description) {
      queryInfo.description = axQuery.Description[0];
    }

    // Extract data sources
    if (axQuery.DataSources && axQuery.DataSources[0]) {
      queryInfo.dataSources = extractQueryDataSources(
        axQuery.DataSources[0],
        includeRanges,
        includeJoins,
        includeFields
      );
    }

    // 4. Format output
    return formatQueryOutput(queryInfo, includeRanges, includeJoins, includeFields);

  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error getting query info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Extract query data sources recursively
 */
function extractQueryDataSources(
  dataSourcesNode: any,
  includeRanges: boolean,
  includeJoins: boolean,
  includeFields: boolean
): QueryDataSource[] {
  const dataSources: QueryDataSource[] = [];

  if (!dataSourcesNode.AxQuerySimpleRootDataSource && !dataSourcesNode.AxQuerySimpleEmbeddedDataSource) {
    return dataSources;
  }

  // Process root data sources
  if (dataSourcesNode.AxQuerySimpleRootDataSource) {
    for (const dsNode of dataSourcesNode.AxQuerySimpleRootDataSource) {
      const ds = extractQueryDataSource(dsNode, includeRanges, includeJoins, includeFields);
      if (ds) {
        dataSources.push(ds);
      }
    }
  }

  // Process embedded data sources (joins)
  if (dataSourcesNode.AxQuerySimpleEmbeddedDataSource) {
    for (const dsNode of dataSourcesNode.AxQuerySimpleEmbeddedDataSource) {
      const ds = extractQueryDataSource(dsNode, includeRanges, includeJoins, includeFields);
      if (ds) {
        dataSources.push(ds);
      }
    }
  }

  return dataSources;
}

/**
 * Extract single query data source
 */
function extractQueryDataSource(
  dsNode: any,
  includeRanges: boolean,
  includeJoins: boolean,
  includeFields: boolean
): QueryDataSource | null {
  if (!dsNode) return null;

  const ds: QueryDataSource = {
    name: dsNode.Name ? dsNode.Name[0] : 'Unknown',
    table: dsNode.Table ? dsNode.Table[0] : 'Unknown',
    fetchMode: dsNode.FetchMode ? dsNode.FetchMode[0] : 'Unknown',
    ranges: [],
    joins: [],
    fields: [],
  };

  // Extract ranges
  if (includeRanges && dsNode.Ranges && dsNode.Ranges[0]) {
    ds.ranges = extractQueryRanges(dsNode.Ranges[0]);
  }

  // Extract fields
  if (includeFields && dsNode.Fields && dsNode.Fields[0]) {
    ds.fields = extractQueryFields(dsNode.Fields[0]);
  }

  // Extract child data sources (joins)
  if (includeJoins && dsNode.DataSources && dsNode.DataSources[0]) {
    ds.joins = extractQueryDataSources(dsNode.DataSources[0], includeRanges, includeJoins, includeFields);
  }

  return ds;
}

/**
 * Extract query ranges
 */
function extractQueryRanges(rangesNode: any): QueryRange[] {
  const ranges: QueryRange[] = [];

  if (!rangesNode.AxQuerySimpleDataSourceRange) {
    return ranges;
  }

  for (const rangeNode of rangesNode.AxQuerySimpleDataSourceRange) {
    const range: QueryRange = {
      field: rangeNode.Field ? rangeNode.Field[0] : 'Unknown',
      value: rangeNode.Value ? rangeNode.Value[0] : '',
    };

    if (rangeNode.Operator) {
      range.operator = rangeNode.Operator[0];
    }

    ranges.push(range);
  }

  return ranges;
}

/**
 * Extract query fields
 */
function extractQueryFields(fieldsNode: any): string[] {
  const fields: string[] = [];

  if (!fieldsNode.AxQuerySimpleDataSourceField) {
    return fields;
  }

  for (const fieldNode of fieldsNode.AxQuerySimpleDataSourceField) {
    const fieldName = fieldNode.Field ? fieldNode.Field[0] : 'Unknown';
    fields.push(fieldName);
  }

  return fields;
}

/**
 * Format query output
 */
function formatQueryOutput(
  queryInfo: QueryInfo,
  includeRanges: boolean,
  includeJoins: boolean,
  includeFields: boolean
): any {
  let output = `# Query: \`${queryInfo.name}\`\n\n`;
  output += `**Model:** ${queryInfo.model}\n\n`;

  if (queryInfo.description) {
    output += `**Description:** ${queryInfo.description}\n\n`;
  }

  // Data Sources
  if (queryInfo.dataSources.length > 0) {
    output += `## 📊 Data Sources\n\n`;
    output += formatDataSourceHierarchy(queryInfo.dataSources, 0, includeRanges, includeJoins, includeFields);
  }

  // Summary
  output += `## 📈 Summary\n\n`;
  const dsCount = countDataSources(queryInfo.dataSources);
  const rangeCount = countRanges(queryInfo.dataSources);
  output += `- **Data Sources:** ${dsCount}\n`;
  output += `- **Total Ranges:** ${rangeCount}\n`;

  return {
    content: [
      {
        type: 'text',
        text: output,
      },
    ],
  };
}

/**
 * Format data source hierarchy
 */
function formatDataSourceHierarchy(
  dataSources: QueryDataSource[],
  indent: number,
  includeRanges: boolean,
  includeJoins: boolean,
  includeFields: boolean
): string {
  let output = '';
  const indentStr = '  '.repeat(indent);

  for (const ds of dataSources) {
    output += `${indentStr}### ${ds.name}\n\n`;
    output += `${indentStr}**Table:** \`${ds.table}\`\n`;
    output += `${indentStr}**Fetch Mode:** ${ds.fetchMode}\n\n`;

    // Ranges
    if (includeRanges && ds.ranges.length > 0) {
      output += `${indentStr}**Ranges:**\n`;
      for (const range of ds.ranges) {
        const operator = range.operator ? ` (${range.operator})` : '';
        output += `${indentStr}- **${range.field}**${operator}: \`${range.value}\`\n`;
      }
      output += '\n';
    }

    // Fields
    if (includeFields && ds.fields.length > 0) {
      output += `${indentStr}**Fields (${ds.fields.length}):**\n`;
      for (const field of ds.fields.slice(0, 10)) {
        output += `${indentStr}- ${field}\n`;
      }
      if (ds.fields.length > 10) {
        output += `${indentStr}- ... (${ds.fields.length - 10} more fields)\n`;
      }
      output += '\n';
    }

    // Joins
    if (includeJoins && ds.joins.length > 0) {
      output += `${indentStr}**Joined Data Sources:**\n\n`;
      output += formatDataSourceHierarchy(ds.joins, indent + 1, includeRanges, includeJoins, includeFields);
    }
  }

  return output;
}

/**
 * Count total data sources recursively
 */
function countDataSources(dataSources: QueryDataSource[]): number {
  let count = dataSources.length;
  for (const ds of dataSources) {
    count += countDataSources(ds.joins);
  }
  return count;
}

/**
 * Count total ranges recursively
 */
function countRanges(dataSources: QueryDataSource[]): number {
  let count = 0;
  for (const ds of dataSources) {
    count += ds.ranges.length;
    count += countRanges(ds.joins);
  }
  return count;
}

export const getQueryInfoToolDefinition = {
  name: 'get_query_info',
  description: '🔍 Extract query structure: datasources, ranges, joins, fields. Returns datasource hierarchy with range definitions and join configuration. Essential for understanding query logic and adding ranges or joins.',
  inputSchema: GetQueryInfoArgsSchema,
};
