/**
 * Get View Info Tool
 * Extract data entity view structure: computed columns, relations, methods
 * Returns view metadata, field mappings, computed columns
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { promises as fs } from 'fs';
import { parseStringPromise } from 'xml2js';
import { buildXmlNotAvailableMessage, readViewMetadata } from '../utils/metadataResolver.js';

const GetViewInfoArgsSchema = z.object({
  viewName: z.string().describe('Name of the view or data entity'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided)'),
  includeFields: z.boolean().optional().default(true).describe('Include field list'),
  includeRelations: z.boolean().optional().default(true).describe('Include relations'),
  includeMethods: z.boolean().optional().default(true).describe('Include methods'),
  includeWorkspace: z.boolean().optional().default(false).describe('Include workspace files'),
  workspacePath: z.string().optional().describe('Path to workspace'),
});

interface ViewField {
  name: string;
  dataSource?: string;
  dataField?: string;
  dataMethod?: string;
  isComputed: boolean;
}

interface ViewRelation {
  name: string;
  relatedTable: string;
  relationType: string;
  cardinality: string;
}

interface ViewInfo {
  name: string;
  model: string;
  label?: string;
  isPublic: boolean;
  isReadOnly: boolean;
  primaryKey?: string;
  fields: ViewField[];
  relations: ViewRelation[];
  methods: string[];
}

export async function getViewInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetViewInfoArgsSchema.parse(request.params.arguments);
    const { symbolIndex, hybridSearch } = context;
    const { 
      viewName, 
      modelName, 
      includeFields, 
      includeRelations, 
      includeMethods,
      includeWorkspace,
      workspacePath
    } = args;

    // 1. Find the view (with workspace support)
    let viewRow: any = null;
    
    // Try workspace first if requested
    if (includeWorkspace && workspacePath && hybridSearch) {
      const workspaceResults = await hybridSearch.search(viewName, {
        types: ['view'],
        limit: 1,
        workspacePath,
        includeWorkspace: true,
      });
      
      if (workspaceResults.length > 0 && workspaceResults[0].source === 'workspace' && workspaceResults[0].file) {
        viewRow = {
          file_path: workspaceResults[0].file.path,
          model: 'Workspace',
          name: viewName,
        };
      }
    }
    
    // Fallback to database if not found in workspace
    if (!viewRow) {
      let stmt;
      if (modelName) {
        stmt = symbolIndex.db.prepare(`
          SELECT file_path, model, name
          FROM symbols
          WHERE type = 'view' AND name = ? AND model = ?
          LIMIT 1
        `);
        viewRow = stmt.get(viewName, modelName) as any;
      } else {
        stmt = symbolIndex.db.prepare(`
          SELECT file_path, model, name
          FROM symbols
          WHERE type = 'view' AND name = ?
          ORDER BY model
          LIMIT 1
        `);
        viewRow = stmt.get(viewName) as any;
      }
    }

    if (!viewRow) {
      throw new Error(`View "${viewName}" not found. Make sure it's indexed or provide workspacePath for local views.`);
    }

    // 2. Parse XML (file_path may point to build-agent path — not accessible on this server)
    let xmlContent: string;
    try {
      xmlContent = await fs.readFile(viewRow.file_path, 'utf-8');
    } catch {
      if (viewRow.model && viewRow.model !== 'Workspace') {
        const extracted = await readViewMetadata(viewRow.model, viewName);
        if (extracted) {
          const fallbackInfo: ViewInfo = {
            name: extracted.name,
            model: extracted.model,
            label: extracted.label,
            isPublic: !!extracted.isPublic,
            isReadOnly: !!extracted.isReadOnly,
            primaryKey: extracted.primaryKey,
            fields: (extracted.fields || []).map((field: any) => ({
              name: field.name,
              dataSource: field.dataSource,
              dataField: field.dataField,
              dataMethod: field.dataMethod,
              isComputed: !!field.isComputed,
            })),
            relations: (extracted.relations || []).map((relation: any) => ({
              name: relation.name,
              relatedTable: relation.relatedTable,
              relationType: relation.relationType,
              cardinality: relation.cardinality,
            })),
            methods: (extracted.methods || []).map((method: any) => (typeof method === 'string' ? method : method.name || 'Unknown')),
          };

          return formatViewOutput(fallbackInfo, includeFields, includeRelations, includeMethods);
        }
      }

      return {
        content: [{ type: 'text', text: buildXmlNotAvailableMessage('view', viewName, viewRow.file_path) }],
        isError: true,
      };
    }
    const xmlObj = await parseStringPromise(xmlContent);

    // 3. Extract view info
    const viewInfo: ViewInfo = {
      name: viewName,
      model: viewRow.model,
      label: undefined,
      isPublic: false,
      isReadOnly: false,
      fields: [],
      relations: [],
      methods: [],
    };

    const axView = xmlObj.AxDataEntityView || xmlObj.AxView;
    if (!axView) {
      throw new Error('Invalid view XML structure');
    }

    // Extract properties
    if (axView.IsPublic) {
      viewInfo.isPublic = axView.IsPublic[0] === 'Yes';
    }

    if (axView.IsReadOnly) {
      viewInfo.isReadOnly = axView.IsReadOnly[0] === 'Yes';
    }

    if (axView.PrimaryKey) {
      viewInfo.primaryKey = axView.PrimaryKey[0];
    }

    if (axView.Label) {
      viewInfo.label = axView.Label[0];
    }

    // Extract fields
    if (includeFields && axView.Fields && axView.Fields[0]) {
      viewInfo.fields = extractViewFields(axView.Fields[0]);
    }

    // Extract relations
    if (includeRelations && axView.Relations && axView.Relations[0]) {
      viewInfo.relations = extractViewRelations(axView.Relations[0]);
    }

    // Extract methods
    if (includeMethods && axView.Methods && axView.Methods[0] && axView.Methods[0].Method) {
      viewInfo.methods = axView.Methods[0].Method.map((m: any) => m.Name ? m.Name[0] : 'Unknown');
    }

    // 4. Format output
    return formatViewOutput(viewInfo, includeFields, includeRelations, includeMethods);

  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error getting view info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Extract view fields
 */
function extractViewFields(fieldsNode: any): ViewField[] {
  const fields: ViewField[] = [];

  // Check for data entity view fields
  if (fieldsNode.AxDataEntityViewField) {
    for (const fieldNode of fieldsNode.AxDataEntityViewField) {
      const field: ViewField = {
        name: fieldNode.Name ? fieldNode.Name[0] : 'Unknown',
        isComputed: false,
      };

      if (fieldNode.DataSource) {
        field.dataSource = fieldNode.DataSource[0];
      }

      if (fieldNode.DataField) {
        field.dataField = fieldNode.DataField[0];
      }

      if (fieldNode.DataMethod) {
        field.dataMethod = fieldNode.DataMethod[0];
        field.isComputed = true;
      }

      fields.push(field);
    }
  }

  // Check for regular view fields
  if (fieldsNode.AxViewField) {
    for (const fieldNode of fieldsNode.AxViewField) {
      const field: ViewField = {
        name: fieldNode.Name ? fieldNode.Name[0] : 'Unknown',
        isComputed: false,
      };

      if (fieldNode.DataSource) {
        field.dataSource = fieldNode.DataSource[0];
      }

      if (fieldNode.DataField) {
        field.dataField = fieldNode.DataField[0];
      }

      fields.push(field);
    }
  }

  return fields;
}

/**
 * Extract view relations
 */
function extractViewRelations(relationsNode: any): ViewRelation[] {
  const relations: ViewRelation[] = [];

  if (relationsNode.AxDataEntityViewRelation || relationsNode.AxViewRelation) {
    const relationNodes = relationsNode.AxDataEntityViewRelation || relationsNode.AxViewRelation;

    for (const relNode of relationNodes) {
      const relation: ViewRelation = {
        name: relNode.Name ? relNode.Name[0] : 'Unknown',
        relatedTable: relNode.RelatedDataEntity ? relNode.RelatedDataEntity[0] : relNode.RelatedTable ? relNode.RelatedTable[0] : 'Unknown',
        relationType: relNode.RelationType ? relNode.RelationType[0] : 'Unknown',
        cardinality: relNode.Cardinality ? relNode.Cardinality[0] : 'Unknown',
      };

      relations.push(relation);
    }
  }

  return relations;
}

/**
 * Format view output
 */
function formatViewOutput(
  viewInfo: ViewInfo,
  includeFields: boolean,
  includeRelations: boolean,
  includeMethods: boolean
): any {
  let output = `# View: \`${viewInfo.name}\`\n\n`;
  output += `**Model:** ${viewInfo.model}\n`;
  if (viewInfo.label) {
    output += `**Label:** ${viewInfo.label}\n`;
  }
  output += `**Public:** ${viewInfo.isPublic ? '✅' : '❌'}\n`;
  output += `**Read-Only:** ${viewInfo.isReadOnly ? '✅' : '❌'}\n`;
  
  if (viewInfo.primaryKey) {
    output += `**Primary Key:** ${viewInfo.primaryKey}\n`;
  }
  
  output += `\n`;

  // Fields
  if (includeFields && viewInfo.fields.length > 0) {
    output += `## 📊 Fields (${viewInfo.fields.length})\n\n`;
    
    const computedFields = viewInfo.fields.filter(f => f.isComputed);
    const mappedFields = viewInfo.fields.filter(f => !f.isComputed);

    if (mappedFields.length > 0) {
      output += `### Mapped Fields\n\n`;
      output += `| Field Name | Data Source | Data Field |\n`;
      output += `|------------|-------------|------------|\n`;
      
      for (const field of mappedFields) {
        output += `| ${field.name} | ${field.dataSource || '-'} | ${field.dataField || '-'} |\n`;
      }
      output += `\n`;
    }

    if (computedFields.length > 0) {
      output += `### Computed Fields\n\n`;
      output += `| Field Name | Data Method |\n`;
      output += `|------------|-------------|\n`;
      
      for (const field of computedFields) {
        output += `| ${field.name} | ${field.dataMethod || '-'} |\n`;
      }
      output += `\n`;
    }
  }

  // Relations
  if (includeRelations && viewInfo.relations.length > 0) {
    output += `## 🔗 Relations (${viewInfo.relations.length})\n\n`;
    output += `| Name | Related Table | Type | Cardinality |\n`;
    output += `|------|---------------|------|-------------|\n`;
    
    for (const rel of viewInfo.relations) {
      output += `| ${rel.name} | ${rel.relatedTable} | ${rel.relationType} | ${rel.cardinality} |\n`;
    }
    output += `\n`;
  }

  // Methods
  if (includeMethods && viewInfo.methods.length > 0) {
    output += `## 🔧 Methods (${viewInfo.methods.length})\n\n`;
    for (const method of viewInfo.methods) {
      output += `- ${method}\n`;
    }
    output += `\n`;
  }

  // Summary
  output += `## 📈 Summary\n\n`;
  const computedCount = viewInfo.fields.filter(f => f.isComputed).length;
  const mappedCount = viewInfo.fields.filter(f => !f.isComputed).length;
  
  output += `- **Total Fields:** ${viewInfo.fields.length}\n`;
  output += `  - Mapped Fields: ${mappedCount}\n`;
  output += `  - Computed Fields: ${computedCount}\n`;
  output += `- **Relations:** ${viewInfo.relations.length}\n`;
  output += `- **Methods:** ${viewInfo.methods.length}\n`;

  return {
    content: [
      {
        type: 'text',
        text: output,
      },
    ],
  };
}

export const getViewInfoToolDefinition = {
  name: 'get_view_info',
  description: '🗂️ Extract data entity view structure: computed columns, relations, methods. Returns view metadata with field mappings (DataSource.DataField), computed columns (DataMethod), and relations. Essential for understanding view logic and OData entity structure.',
  inputSchema: GetViewInfoArgsSchema,
};
