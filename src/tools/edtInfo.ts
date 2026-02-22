/**
 * Get EDT Info Tool
 * Extract Extended Data Type (EDT) properties from AxEdt metadata
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { promises as fs } from 'fs';
import { parseStringPromise } from 'xml2js';
import { readEdtRawXml, buildXmlNotAvailableMessage } from '../utils/metadataResolver.js';

const GetEdtInfoArgsSchema = z.object({
  edtName: z.string().describe('Name of the Extended Data Type (EDT)'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided)'),
  includeWorkspace: z.boolean().optional().default(false).describe('Include workspace files'),
  workspacePath: z.string().optional().describe('Path to workspace'),
});

interface EdtInfo {
  name: string;
  model: string;
  baseType?: string;
  enumType?: string;
  referenceTable?: string;
  relationType?: string;
  stringSize?: string;
  displayLength?: string;
  label?: string;
  helpText?: string;
  formHelp?: string;
  configurationKey?: string;
  alignment?: string;
  decimalSeparator?: string;
  signDisplay?: string;
  noOfDecimals?: string;
  additionalProperties: Record<string, string>;
}

export async function getEdtInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetEdtInfoArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    const { edtName, modelName } = args;

    let stmt;
    let edtRow: any;

    if (modelName) {
      stmt = symbolIndex.db.prepare(`
        SELECT file_path, model, name
        FROM symbols
        WHERE type = 'edt' AND name = ? AND model = ?
        LIMIT 1
      `);
      edtRow = stmt.get(edtName, modelName) as any;
    } else {
      stmt = symbolIndex.db.prepare(`
        SELECT file_path, model, name
        FROM symbols
        WHERE type = 'edt' AND name = ?
        ORDER BY model
        LIMIT 1
      `);
      edtRow = stmt.get(edtName) as any;
    }

    if (!edtRow) {
      throw new Error(`EDT "${edtName}" not found. Make sure EDT metadata is extracted and indexed.`);
    }

    let rawXml: string | null = null;

    rawXml = await readEdtRawXml(edtRow.model, edtName);

    if (!rawXml) {
      try {
        rawXml = await fs.readFile(edtRow.file_path, 'utf-8');
      } catch {
        // Build-agent path not accessible
      }
    }

    if (!rawXml) {
      return {
        content: [{ type: 'text', text: buildXmlNotAvailableMessage('edt', edtName, edtRow.file_path) }],
        isError: true,
      };
    }

    const xmlObj = await parseStringPromise(rawXml);

    if (!xmlObj.AxEdt) {
      throw new Error('Invalid EDT XML structure (AxEdt root not found)');
    }

    const edtInfo = extractEdtInfo(xmlObj.AxEdt, edtName, edtRow.model);

    return {
      content: [
        {
          type: 'text',
          text: formatEdtOutput(edtInfo),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error getting EDT info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

function extractEdtInfo(axEdt: any, edtName: string, model: string): EdtInfo {
  const getValue = (key: string): string | undefined => {
    const raw = axEdt[key]?.[0];
    return typeof raw === 'string' && raw.trim().length > 0 ? raw : undefined;
  };

  const info: EdtInfo = {
    name: edtName,
    model,
    baseType: getValue('Extends'),
    enumType: getValue('EnumType'),
    referenceTable: getValue('ReferenceTable'),
    relationType: getValue('RelationType'),
    stringSize: getValue('StringSize'),
    displayLength: getValue('DisplayLength'),
    label: getValue('Label'),
    helpText: getValue('HelpText'),
    formHelp: getValue('FormHelp'),
    configurationKey: getValue('ConfigurationKey'),
    alignment: getValue('Alignment'),
    decimalSeparator: getValue('DecimalSeparator'),
    signDisplay: getValue('SignDisplay'),
    noOfDecimals: getValue('NoOfDecimals'),
    additionalProperties: {},
  };

  const known = new Set([
    'Name', 'Extends', 'EnumType', 'ReferenceTable', 'RelationType', 'StringSize', 'DisplayLength',
    'Label', 'HelpText', 'FormHelp', 'ConfigurationKey', 'Alignment', 'DecimalSeparator',
    'SignDisplay', 'NoOfDecimals', 'ArrayElements', 'Relations', 'TableReferences'
  ]);

  for (const [key, value] of Object.entries(axEdt)) {
    if (known.has(key)) continue;

    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string' && first.trim().length > 0) {
      info.additionalProperties[key] = first;
    }
  }

  return info;
}

function formatEdtOutput(edtInfo: EdtInfo): string {
  let output = `# Extended Data Type: \`${edtInfo.name}\`\n\n`;
  output += `**Model:** ${edtInfo.model}\n\n`;

  output += `## 🔧 Core Properties\n\n`;
  output += `| Property | Value |\n`;
  output += `|----------|-------|\n`;

  const rows: Array<[string, string | undefined]> = [
    ['Base Type (Extends)', edtInfo.baseType],
    ['Enum Type', edtInfo.enumType],
    ['Reference Table', edtInfo.referenceTable],
    ['Relation Type', edtInfo.relationType],
    ['String Size', edtInfo.stringSize],
    ['Display Length', edtInfo.displayLength],
    ['Label', edtInfo.label],
    ['Help Text', edtInfo.helpText],
    ['Form Help', edtInfo.formHelp],
    ['Configuration Key', edtInfo.configurationKey],
    ['Alignment', edtInfo.alignment],
    ['Decimal Separator', edtInfo.decimalSeparator],
    ['Sign Display', edtInfo.signDisplay],
    ['No. of Decimals', edtInfo.noOfDecimals],
  ];

  for (const [key, value] of rows) {
    if (value) {
      output += `| ${key} | ${value} |\n`;
    }
  }

  if (Object.keys(edtInfo.additionalProperties).length > 0) {
    output += `\n## ➕ Additional Properties\n\n`;
    output += `| Property | Value |\n`;
    output += `|----------|-------|\n`;
    for (const [key, value] of Object.entries(edtInfo.additionalProperties)) {
      output += `| ${key} | ${value} |\n`;
    }
  }

  output += `\n## 💡 Usage Example\n\n`;
  output += `\`\`\`xpp\n`;
  output += `// Declare EDT variable\n`;
  output += `${edtInfo.name} value;\n\n`;
  output += `// Assign value\n`;
  output += `value = \"example\";\n`;
  output += `\`\`\`\n`;

  return output;
}

export const getEdtInfoToolDefinition = {
  name: 'get_edt_info',
  description: '📊 Get complete Extended Data Type (EDT) definition including base type, labels, reference table, string/number settings, and EDT properties from AxEdt metadata.',
  inputSchema: GetEdtInfoArgsSchema,
};
