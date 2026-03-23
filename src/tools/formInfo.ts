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
import { resolveDbPathLocally } from '../utils/metadataResolver.js';
import { findD365FileOnDisk } from './modifyD365File.js';
import { getConfigManager } from '../utils/configManager.js';
import { tryBridgeForm } from '../bridge/bridgeAdapter.js';
import path from 'path';

const GetFormInfoArgsSchema = z.object({
  formName: z.string().describe('Name of the form'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided)'),
  filePath: z.string().optional().describe(
    'Absolute path to the form XML file on disk. ' +
    'Use this when get_form_info previously returned a "could not be read from disk" warning with a guessed path. ' +
    'Bypasses the DB path lookup entirely. ' +
    'Example: filePath="K:\\AOSService\\PackagesLocalDirectory\\AslCore\\AslCore\\AxForm\\MyForm.xml"'
  ),
  includeControls: z.boolean().optional().default(true).describe('Include control hierarchy'),
  includeDataSources: z.boolean().optional().default(true).describe('Include datasource information'),
  includeMethods: z.boolean().optional().default(true).describe('Include form methods'),
  includeWorkspace: z.boolean().optional().default(false).describe('Include workspace files'),
  workspacePath: z.string().optional().describe('Path to workspace'),
  searchControl: z.string().optional().describe(
    'Case-insensitive substring search for a control by name. ' +
    'Returns matching controls with their full path, parent name, and immediate children. ' +
    'Use this to find the exact name of a tab, group, or field (e.g. searchControl="General"). ' +
    'NEVER use PowerShell Get-Content to search form XML — use this parameter instead.'
  ),
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
      filePath: explicitFilePath,
      includeControls, 
      includeDataSources, 
      includeMethods,
      includeWorkspace,
      workspacePath,
      searchControl,
    } = args;

    // 0. If an explicit filePath is provided, skip the DB lookup entirely.
    // This is the retry path when Strategy A–D failed and the caller supplies the path directly.
    if (explicitFilePath) {
      let xmlContent: string | null = null;
      try {
        xmlContent = await fs.readFile(explicitFilePath, 'utf-8');
      } catch (e) {
        return {
          content: [{ type: 'text', text:
            `❌ get_form_info: cannot read form XML at explicit filePath="${explicitFilePath}": ` +
            `${e instanceof Error ? e.message : String(e)}\n\n` +
            `Check the path is correct and accessible. DO NOT use PowerShell — fix the filePath parameter.`,
          }],
          isError: true,
        };
      }
      return await parseAndFormatForm(formName, 'Unknown', xmlContent, includeControls, includeDataSources, includeMethods, searchControl);
    }

    // Try C# bridge first (IMetadataProvider — live D365FO metadata)
    const bridgeResult = await tryBridgeForm(context.bridge, formName);
    if (bridgeResult) return bridgeResult;

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

    // 2. Read the form XML — four strategies, most specific to most generic
    //
    // Strategy A: read the DB-stored path directly (works for absolute Windows paths from
    //             a locally indexed DB, e.g. K:\AOSService\PackagesLocalDirectory\...\AxForm\SalesTable.xml)
    let xmlContent: string | null = null;
    try {
      const fileContent = await fs.readFile(formRow.file_path, 'utf-8');
      const trimmed = fileContent.trimStart();
      if (trimmed.startsWith('{')) {
        // JSON metadata — extract sourcePath and read actual XML from there
        const data = JSON.parse(fileContent);
        if (data.sourcePath) {
          try {
            xmlContent = await fs.readFile(data.sourcePath, 'utf-8');
          } catch {
            // sourcePath not accessible
          }
        }
      } else {
        xmlContent = fileContent;
      }
    } catch {
      // file_path not accessible — try fallbacks below
    }

    // Strategy B: DB stores a RELATIVE path (e.g. "AslCore/AslCore/AxForm/MyForm.xml").
    // Join it with the configured packages path to get the absolute path on this machine.
    if (!xmlContent && !path.isAbsolute(formRow.file_path)) {
      const cm = getConfigManager();
      await cm.ensureLoaded();
      const pkgPath = cm.getPackagePath() || 'K:\\AOSService\\PackagesLocalDirectory';
      const absolutePath = path.join(pkgPath, formRow.file_path);
      try {
        xmlContent = await fs.readFile(absolutePath, 'utf-8');
      } catch {
        // Not accessible at this packages path
      }
    }

    // Strategy C: build-agent path (e.g. /home/vsts/work/.../PackagesLocalDirectory/...) —
    // remap to local PackagesLocalDirectory.
    if (!xmlContent) {
      const remappedPath = await resolveDbPathLocally(formRow.file_path);
      if (remappedPath) {
        try {
          xmlContent = await fs.readFile(remappedPath, 'utf-8');
        } catch {
          // Remapped path not readable
        }
      }
    }

    // Strategy D: scan the configured packages directory for the form XML using the model
    // name from the DB row (handles cases where Strategy B fails because the configured
    // packages path differs from the default, or UDE layout is used).
    if (!xmlContent) {
      const diskPath = await findD365FileOnDisk('form', formName, formRow.model);
      if (diskPath) {
        try {
          xmlContent = await fs.readFile(diskPath, 'utf-8');
        } catch {
          // Local path also not accessible
        }
      }
    }

    if (!xmlContent) {
      // Build a list of paths we tried so the human/AI can diagnose and retry
      const cm = getConfigManager();
      await cm.ensureLoaded();
      const pkgPath = cm.getPackagePath() || 'K:\\AOSService\\PackagesLocalDirectory';
      const guessedAbsPath = path.isAbsolute(formRow.file_path)
        ? formRow.file_path
        : path.join(pkgPath, formRow.file_path);

      return {
        content: [{
          type: 'text',
          text:
            `⚠️ get_form_info: form XML for "${formName}" (model: ${formRow.model}) could not be read from disk.\n\n` +
            `**DO NOT use PowerShell or read_file to work around this — retry get_form_info with the filePath parameter instead.**\n\n` +
            `Tried path (from DB): \`${formRow.file_path}\`\n` +
            `Guessed absolute path: \`${guessedAbsPath}\`\n\n` +
            `✅ **Retry with explicit filePath:**\n` +
            `  get_form_info(formName="${formName}", filePath="${guessedAbsPath}")\n\n` +
            `If the path above is wrong, locate the form at:\n` +
            `  \`{packagePath}\\${formRow.model}\\${formRow.model}\\AxForm\\${formName}.xml\`\n` +
            `and pass it via the filePath parameter.`,
        }],
      };
    }

    return await parseAndFormatForm(formName, formRow.model, xmlContent, includeControls, includeDataSources, includeMethods, searchControl);

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

// ── Shared XML parse + format helper ────────────────────────────────────────

/**
 * Parse form XML and return the formatted tool response.
 * Shared by both the normal DB-lookup path and the explicit filePath bypass.
 */
async function parseAndFormatForm(
  formName: string,
  modelName: string,
  xmlContent: string,
  includeControls: boolean,
  includeDataSources: boolean,
  includeMethods: boolean,
  searchControl?: string,
) {
  const xmlObj = await parseStringPromise(xmlContent);

  const formInfo: FormInfo = {
    name: formName,
    model: modelName,
    design: [],
    dataSources: [],
    methods: [],
  };

  const axForm = xmlObj.AxForm;
  if (!axForm) {
    throw new Error('Invalid AxForm XML structure');
  }

  if (includeDataSources && axForm.DataSources) {
    formInfo.dataSources = extractDataSources(axForm.DataSources[0]);
  }
  if (includeControls && axForm.Design) {
    formInfo.design = extractControls(axForm.Design[0]);
  }
  if (includeMethods && axForm.SourceCode && axForm.SourceCode[0] && axForm.SourceCode[0].Methods) {
    formInfo.methods = extractMethods(axForm.SourceCode[0].Methods[0]);
  }

  if (searchControl) {
    const matches = searchControlsInHierarchy(formInfo.design, searchControl);
    return {
      content: [{ type: 'text', text: formatControlSearchResults(formInfo.name, formInfo.model, matches, searchControl) }],
    };
  }

  return formatFormOutput(formInfo, includeControls, includeDataSources, includeMethods);
}

// ── Control search helpers ───────────────────────────────────────────────────

interface ControlSearchResult {
  control: FormControl;
  /** Full name path from root, e.g. ['Design', 'Tab', 'TabPageGeneral'] */
  path: string[];
  /** Direct parent control name, or null if top-level */
  parentName: string | null;
}

/**
 * Walk the control hierarchy recursively and collect all controls whose name
 * contains `query` (case-insensitive).
 */
function searchControlsInHierarchy(
  controls: FormControl[],
  query: string,
  path: string[] = [],
  parentName: string | null = null,
): ControlSearchResult[] {
  const results: ControlSearchResult[] = [];
  const lowerQuery = query.toLowerCase();

  for (const ctrl of controls) {
    const currentPath = [...path, ctrl.name];
    if (ctrl.name.toLowerCase().includes(lowerQuery)) {
      results.push({ control: ctrl, path: currentPath, parentName });
    }
    // Always recurse regardless of whether this node matched
    results.push(...searchControlsInHierarchy(ctrl.children, query, currentPath, ctrl.name));
  }

  return results;
}

/**
 * Format the search results in a way that gives the AI exactly what it needs
 * to write a form extension: exact control name, path, parent, and children.
 */
function formatControlSearchResults(
  formName: string,
  modelName: string,
  results: ControlSearchResult[],
  query: string,
): string {
  let out = `# Form: \`${formName}\` (${modelName}) — control search: "${query}"\n\n`;

  if (results.length === 0) {
    out += `No controls found matching "${query}".\n\n`;
    out += `Tip: call get_form_info without searchControl to browse the full control hierarchy.\n`;
    return out;
  }

  out += `Found **${results.length}** control(s):\n\n`;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    out += `---\n`;
    out += `**[${i + 1}] ${r.control.name}** (${r.control.type})\n`;
    out += `Path: \`${r.path.join(' › ')}\`\n`;
    if (r.parentName) {
      out += `Parent: \`${r.parentName}\`\n`;
    }

    // Key properties
    const propPairs = Object.entries(r.control.properties);
    if (propPairs.length > 0) {
      out += `Properties: ${propPairs.map(([k, v]) => `${k}=${v}`).join(' | ')}\n`;
    }

    // Children list (for knowing what's already inside)
    if (r.control.children.length > 0) {
      out += `\nChildren (${r.control.children.length}):\n`;
      const shown = r.control.children.slice(0, 15);
      for (const child of shown) {
        const extras: string[] = [];
        if (child.properties.DataSource) extras.push(`DS: ${child.properties.DataSource}`);
        if (child.properties.DataField) extras.push(`Field: ${child.properties.DataField}`);
        if (child.properties.Caption) extras.push(`Caption: ${child.properties.Caption}`);
        const extStr = extras.length > 0 ? `  [${extras.join(', ')}]` : '';
        out += `  • \`${child.name}\` (${child.type})${extStr}\n`;
      }
      if (r.control.children.length > 15) {
        out += `  … and ${r.control.children.length - 15} more\n`;
      }
    }

    out += `\n💡 **Form extension usage:**\n`;
    out += `  • Add a control **inside** \`${r.control.name}\`: set \`parent="${r.control.name}"\`\n`;
    if (r.parentName) {
      out += `  • Add a control **after** \`${r.control.name}\`: set \`parent="${r.parentName}", after="${r.control.name}"\`\n`;
    }
    out += `\n`;
  }

  return out;
}

/**
 * Extract datasources from form XML
 */
function extractDataSources(dataSourcesNode: any): FormDataSource[] {
  const dataSources: FormDataSource[] = [];

  // Form XML uses AxFormDataSource (not AxFormDataSourceRoot)
  const dsArray = dataSourcesNode.AxFormDataSource || dataSourcesNode.AxFormDataSourceRoot;
  if (!dsArray) {
    return dataSources;
  }

  for (const dsNode of dsArray) {
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

  // Design XML can be structured as:
  // 1. Design > AxFormDesign > Controls > AxFormControl[]
  // 2. Design > Controls > AxFormControl[] (older format)
  
  // Try AxFormDesign wrapper first (newer format)
  let controlsNode = null;
  if (designNode.AxFormDesign && designNode.AxFormDesign[0]) {
    controlsNode = designNode.AxFormDesign[0].Controls;
  } else if (designNode.Controls) {
    controlsNode = designNode.Controls;
  }
  
  if (controlsNode && controlsNode[0] && controlsNode[0].AxFormControl) {
    for (const node of controlsNode[0].AxFormControl) {
      const control = extractControl(node);
      if (control) {
        controls.push(control);
      }
    }
  }

  return controls;
}

/**
 * Extract single control
 */
function extractControl(node: any): FormControl | null {
  if (!node) return null;

  const control: FormControl = {
    name: node.Name ? node.Name[0] : 'Unknown',
    type: node.Type ? node.Type[0] : 'Group',
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

  // Recursively extract child controls (nested under Controls > AxFormControl)
  if (node.Controls && node.Controls[0] && node.Controls[0].AxFormControl) {
    for (const childNode of node.Controls[0].AxFormControl) {
      const childControl = extractControl(childNode);
      if (childControl) {
        control.children.push(childControl);
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
