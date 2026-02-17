/**
 * Get Form Info Tool
 * Extract form structure: controls, datasources, methods
 * Returns control hierarchy, datasource configuration, form methods
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { promises as fs } from 'fs';
import { parseStringPromise } from 'xml2js';

const GetFormInfoArgsSchema = z.object({
  formName: z.string().describe('Name of the form'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided)'),
  includeControls: z.boolean().optional().default(true).describe('Include control hierarchy'),
  includeDataSources: z.boolean().optional().default(true).describe('Include datasource information'),
  includeMethods: z.boolean().optional().default(true).describe('Include form methods'),
  includeWorkspace: z.boolean().optional().default(false).describe('Include workspace files'),
  workspacePath: z.string().optional().describe('Path to workspace'),
});

interface FormControl {
  name: string;
  type: string;
  properties: Record<string, string>;
  children: FormControl[];
}

interface FormDataSource {
  name: string;
  table: string;
  allowEdit: boolean;
  allowCreate: boolean;
  allowDelete: boolean;
  fields: string[];
  methods: string[];
}

interface FormMethod {
  name: string;
  signature: string;
}

interface FormInfo {
  name: string;
  model: string;
  design: FormControl[];
  dataSources: FormDataSource[];
  methods: FormMethod[];
}

export async function getFormInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetFormInfoArgsSchema.parse(request.params.arguments);
    const { symbolIndex, hybridSearch } = context;
    const { 
      formName, 
      modelName, 
      includeControls, 
      includeDataSources, 
      includeMethods,
      includeWorkspace,
      workspacePath
    } = args;

    // 1. Find the form (with workspace support)
    let formRow: any = null;
    
    // Try workspace first if requested
    if (includeWorkspace && workspacePath && hybridSearch) {
      const workspaceResults = await hybridSearch.search(formName, {
        types: ['form'],
        limit: 1,
        workspacePath,
        includeWorkspace: true,
      });
      
      if (workspaceResults.length > 0 && workspaceResults[0].source === 'workspace' && workspaceResults[0].file) {
        formRow = {
          file_path: workspaceResults[0].file.path,
          model: 'Workspace',
          name: formName,
        };
      }
    }
    
    // Fallback to database if not found in workspace
    if (!formRow) {
      let stmt;
      if (modelName) {
        stmt = symbolIndex.db.prepare(`
          SELECT file_path, model, name
          FROM symbols
          WHERE type = 'form' AND name = ? AND model = ?
          LIMIT 1
        `);
        formRow = stmt.get(formName, modelName) as any;
      } else {
        stmt = symbolIndex.db.prepare(`
          SELECT file_path, model, name
          FROM symbols
          WHERE type = 'form' AND name = ?
          ORDER BY model
          LIMIT 1
        `);
        formRow = stmt.get(formName) as any;
      }
    }

    if (!formRow) {
      throw new Error(`Form "${formName}" not found. Make sure it's indexed or provide workspacePath for local forms.`);
    }

    // 2. Parse XML
    const xmlContent = await fs.readFile(formRow.file_path, 'utf-8');
    const xmlObj = await parseStringPromise(xmlContent);

    // 3. Extract form info
    const formInfo: FormInfo = {
      name: formName,
      model: formRow.model,
      design: [],
      dataSources: [],
      methods: [],
    };

    const axForm = xmlObj.AxForm;
    if (!axForm) {
      throw new Error('Invalid AxForm XML structure');
    }

    // Extract data sources
    if (includeDataSources && axForm.DataSources) {
      formInfo.dataSources = extractDataSources(axForm.DataSources[0]);
    }

    // Extract design (controls)
    if (includeControls && axForm.Design) {
      formInfo.design = extractControls(axForm.Design[0]);
    }

    // Extract methods
    if (includeMethods && axForm.Methods) {
      formInfo.methods = extractMethods(axForm.Methods[0]);
    }

    // 4. Format output
    return formatFormOutput(formInfo, includeControls, includeDataSources, includeMethods);

  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error getting form info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Extract datasources from form XML
 */
function extractDataSources(dataSourcesNode: any): FormDataSource[] {
  const dataSources: FormDataSource[] = [];

  if (!dataSourcesNode.AxFormDataSourceRoot) {
    return dataSources;
  }

  for (const dsNode of dataSourcesNode.AxFormDataSourceRoot) {
    const ds: FormDataSource = {
      name: dsNode.Name ? dsNode.Name[0] : 'Unknown',
      table: dsNode.Table ? dsNode.Table[0] : 'Unknown',
      allowEdit: dsNode.AllowEdit ? dsNode.AllowEdit[0] === 'Yes' : true,
      allowCreate: dsNode.AllowCreate ? dsNode.AllowCreate[0] === 'Yes' : true,
      allowDelete: dsNode.AllowDelete ? dsNode.AllowDelete[0] === 'Yes' : true,
      fields: [],
      methods: [],
    };

    // Extract fields
    if (dsNode.Fields && dsNode.Fields[0]) {
      ds.fields = extractDataSourceFields(dsNode.Fields[0]);
    }

    // Extract methods
    if (dsNode.Methods && dsNode.Methods[0] && dsNode.Methods[0].Method) {
      ds.methods = dsNode.Methods[0].Method.map((m: any) => m.Name ? m.Name[0] : 'Unknown');
    }

    dataSources.push(ds);
  }

  return dataSources;
}

/**
 * Extract fields from datasource
 */
function extractDataSourceFields(fieldsNode: any): string[] {
  const fields: string[] = [];

  if (fieldsNode.AxFormDataSourceField) {
    for (const fieldNode of fieldsNode.AxFormDataSourceField) {
      const fieldName = fieldNode.DataField ? fieldNode.DataField[0] : 'Unknown';
      fields.push(fieldName);
    }
  }

  return fields;
}

/**
 * Extract controls from design
 */
function extractControls(designNode: any): FormControl[] {
  const controls: FormControl[] = [];

  // Find root container (usually FormDesign)
  const rootKeys = Object.keys(designNode).filter(k => k.startsWith('AxForm'));
  
  for (const key of rootKeys) {
    const nodes = designNode[key];
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        const control = extractControl(node, key);
        if (control) {
          controls.push(control);
        }
      }
    }
  }

  return controls;
}

/**
 * Extract single control
 */
function extractControl(node: any, nodeType: string): FormControl | null {
  if (!node) return null;

  const control: FormControl = {
    name: node.Name ? node.Name[0] : 'Unknown',
    type: nodeType.replace('AxForm', ''),
    properties: {},
    children: [],
  };

  // Extract common properties
  const propertiesToExtract = [
    'Caption',
    'Visible',
    'Enabled',
    'AutoDeclaration',
    'DataSource',
    'DataField',
    'DataMethod',
    'HelpText',
    'Label',
    'Width',
    'Height',
  ];

  for (const prop of propertiesToExtract) {
    if (node[prop]) {
      control.properties[prop] = node[prop][0];
    }
  }

  // Recursively extract child controls
  const childKeys = Object.keys(node).filter(k => k.startsWith('AxForm') && k !== nodeType);
  
  for (const childKey of childKeys) {
    const childNodes = node[childKey];
    if (Array.isArray(childNodes)) {
      for (const childNode of childNodes) {
        const childControl = extractControl(childNode, childKey);
        if (childControl) {
          control.children.push(childControl);
        }
      }
    }
  }

  return control;
}

/**
 * Extract methods from form
 */
function extractMethods(methodsNode: any): FormMethod[] {
  const methods: FormMethod[] = [];

  if (!methodsNode.Method) {
    return methods;
  }

  for (const methodNode of methodsNode.Method) {
    const name = methodNode.Name ? methodNode.Name[0] : 'Unknown';
    const source = methodNode.Source ? methodNode.Source[0] : '';
    
    // Extract first line as signature
    const signature = source.split('\n')[0].trim();

    methods.push({
      name,
      signature,
    });
  }

  return methods;
}

/**
 * Format form output
 */
function formatFormOutput(
  formInfo: FormInfo,
  includeControls: boolean,
  includeDataSources: boolean,
  includeMethods: boolean
): any {
  let output = `# Form: \`${formInfo.name}\`\n\n`;
  output += `**Model:** ${formInfo.model}\n\n`;

  // Data Sources
  if (includeDataSources && formInfo.dataSources.length > 0) {
    output += `## 📊 Data Sources\n\n`;
    for (const ds of formInfo.dataSources) {
      output += `### ${ds.name}\n\n`;
      output += `**Table:** \`${ds.table}\`\n`;
      output += `**Permissions:**\n`;
      output += `- Allow Edit: ${ds.allowEdit ? '✅' : '❌'}\n`;
      output += `- Allow Create: ${ds.allowCreate ? '✅' : '❌'}\n`;
      output += `- Allow Delete: ${ds.allowDelete ? '✅' : '❌'}\n`;
      
      if (ds.fields.length > 0) {
        output += `\n**Fields (${ds.fields.length}):**\n`;
        for (const field of ds.fields.slice(0, 20)) {
          output += `- ${field}\n`;
        }
        if (ds.fields.length > 20) {
          output += `- ... (${ds.fields.length - 20} more fields)\n`;
        }
      }

      if (ds.methods.length > 0) {
        output += `\n**Methods (${ds.methods.length}):**\n`;
        for (const method of ds.methods) {
          output += `- ${method}\n`;
        }
      }

      output += `\n`;
    }
  }

  // Design (Controls)
  if (includeControls && formInfo.design.length > 0) {
    output += `## 🎨 Design (Controls)\n\n`;
    output += formatControlHierarchy(formInfo.design, 0);
  }

  // Methods
  if (includeMethods && formInfo.methods.length > 0) {
    output += `## 🔧 Form Methods\n\n`;
    for (const method of formInfo.methods) {
      output += `### ${method.name}\n\n`;
      output += `\`\`\`xpp\n${method.signature}\n\`\`\`\n\n`;
    }
  }

  // Summary
  output += `## 📈 Summary\n\n`;
  output += `- **Data Sources:** ${formInfo.dataSources.length}\n`;
  output += `- **Controls:** ${countControls(formInfo.design)}\n`;
  output += `- **Methods:** ${formInfo.methods.length}\n`;

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
 * Format control hierarchy
 */
function formatControlHierarchy(controls: FormControl[], indent: number): string {
  let output = '';
  const indentStr = '  '.repeat(indent);

  for (const control of controls) {
    output += `${indentStr}- **${control.name}** (${control.type})\n`;
    
    const importantProps = ['Caption', 'DataSource', 'DataField', 'Visible', 'Enabled'];
    const propsToShow = Object.entries(control.properties)
      .filter(([key]) => importantProps.includes(key))
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
    
    if (propsToShow) {
      output += `${indentStr}  *${propsToShow}*\n`;
    }

    if (control.children.length > 0) {
      output += formatControlHierarchy(control.children, indent + 1);
    }
  }

  return output;
}

/**
 * Count total controls recursively
 */
function countControls(controls: FormControl[]): number {
  let count = controls.length;
  for (const control of controls) {
    count += countControls(control.children);
  }
  return count;
}

export const getFormInfoToolDefinition = {
  name: 'get_form_info',
  description: '📋 Extract form structure: controls, datasources, methods. Returns control hierarchy with properties, datasource configuration (table, permissions, fields), and form methods. Essential for understanding form layout and adding controls or datasource methods.',
  inputSchema: GetFormInfoArgsSchema,
};
