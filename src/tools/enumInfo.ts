/**
 * Get Enum Info Tool
 * Extract enum values and enum properties
 * Returns enum values with labels and numeric values
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { promises as fs } from 'fs';
import { parseStringPromise } from 'xml2js';
import { readEnumRawXml, buildXmlNotAvailableMessage } from '../utils/metadataResolver.js';

const GetEnumInfoArgsSchema = z.object({
  enumName: z.string().describe('Name of the enum'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided)'),
  includeLabels: z.boolean().optional().default(true).describe('Include enum value labels'),
  includeWorkspace: z.boolean().optional().default(false).describe('Include workspace files'),
  workspacePath: z.string().optional().describe('Path to workspace'),
});

interface EnumValue {
  name: string;
  value: number;
  label?: string;
}

interface EnumInfo {
  name: string;
  model: string;
  type: 'enum';
  isExtensible: boolean;
  useEnumValue: boolean;
  values: EnumValue[];
}

export async function getEnumInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetEnumInfoArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    const { 
      enumName, 
      modelName, 
      includeLabels
    } = args;

    // 1. Find enum in index
    let stmt;
    if (modelName) {
      stmt = symbolIndex.db.prepare(`
        SELECT file_path, model, name, type
        FROM symbols
        WHERE type = 'enum' AND name = ? AND model = ?
        LIMIT 1
      `);
      var enumRow = stmt.get(enumName, modelName) as any;
    } else {
      stmt = symbolIndex.db.prepare(`
        SELECT file_path, model, name, type
        FROM symbols
        WHERE type = 'enum' AND name = ?
        ORDER BY model
        LIMIT 1
      `);
      var enumRow = stmt.get(enumName) as any;
    }

    if (!enumRow) {
      throw new Error(`Enum "${enumName}" not found. Make sure it's indexed.`);
    }

    // 2. Get raw XML — try extracted-metadata JSON first, then XML file at DB path
    let rawXml: string | null = null;

    // Primary: extracted-metadata JSON (always available, no file-path issues)
    rawXml = await readEnumRawXml(enumRow.model, enumName);

    // Secondary: actual XML file (works only on D365FO VM)
    if (!rawXml) {
      try {
        rawXml = await fs.readFile(enumRow.file_path, 'utf-8');
      } catch {
        // Build-agent path not accessible
      }
    }

    if (!rawXml) {
      return {
        content: [{ type: 'text', text: buildXmlNotAvailableMessage('enum', enumName, enumRow.file_path) }],
        isError: true,
      };
    }

    const xmlObj = await parseStringPromise(rawXml);

    // 3. Extract enum info
    const enumInfo: EnumInfo = {
      name: enumName,
      model: enumRow.model,
      type: 'enum',
      isExtensible: false,
      useEnumValue: false,
      values: [],
    };

    if (!xmlObj.AxEnum) {
      throw new Error('Invalid enum XML structure');
    }

    extractEnumInfo(xmlObj.AxEnum, enumInfo, includeLabels);

    // 4. Format output
    return formatEnumOutput(enumInfo, includeLabels);

  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error getting enum info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Extract enum information
 */
function extractEnumInfo(axEnum: any, enumInfo: EnumInfo, includeLabels: boolean): void {
  // Extract properties
  if (axEnum.IsExtensible) {
    enumInfo.isExtensible = axEnum.IsExtensible[0] === 'Yes';
  }

  if (axEnum.UseEnumValue) {
    enumInfo.useEnumValue = axEnum.UseEnumValue[0] === 'Yes';
  }

  // Extract enum values
  if (axEnum.EnumValues && axEnum.EnumValues[0] && axEnum.EnumValues[0].AxEnumValue) {
    for (const valueNode of axEnum.EnumValues[0].AxEnumValue) {
      const value: EnumValue = {
        name: valueNode.Name ? valueNode.Name[0] : 'Unknown',
        value: valueNode.Value ? parseInt(valueNode.Value[0], 10) : 0,
      };

      if (includeLabels && valueNode.Label) {
        value.label = valueNode.Label[0];
      }

      enumInfo.values.push(value);
    }
  }
}

/**
 * Format enum output
 */
function formatEnumOutput(enumInfo: EnumInfo, includeLabels: boolean): any {
  let output = `# Enum: \`${enumInfo.name}\`\n\n`;
  output += `**Model:** ${enumInfo.model}\n`;
  output += `**Extensible:** ${enumInfo.isExtensible ? '✅' : '❌'}\n`;
  output += `**Use Enum Value:** ${enumInfo.useEnumValue ? '✅' : '❌'}\n`;
  output += `\n`;

  if (enumInfo.values.length > 0) {
    output += `## 📋 Enum Values (${enumInfo.values.length})\n\n`;
    output += `| Name | Value${includeLabels ? ' | Label' : ''} |\n`;
    output += `|------|-------${includeLabels ? '|-------' : ''}|\n`;

    for (const value of enumInfo.values) {
      output += `| ${value.name} | ${value.value}`;
      if (includeLabels) {
        output += ` | ${value.label || '-'}`;
      }
      output += ` |\n`;
    }
    output += `\n`;
  }

  output += `## 💡 Usage Example\n\n`;
  output += `\`\`\`xpp\n`;
  output += `// Assign enum value\n`;
  output += `${enumInfo.name} myEnum = ${enumInfo.name}::${enumInfo.values[0]?.name || 'Value'};\n\n`;
  output += `// Compare enum value\n`;
  output += `if (myEnum == ${enumInfo.name}::${enumInfo.values[0]?.name || 'Value'})\n`;
  output += `{\n`;
  output += `    // Do something\n`;
  output += `}\n`;
  output += `\`\`\`\n`;

  return {
    content: [
      {
        type: 'text',
        text: output,
      },
    ],
  };
}

export const getEnumInfoToolDefinition = {
  name: 'get_enum_info',
  description: '🏷️ Extract enum values with labels and numeric values. Essential for understanding available enum options.',
  inputSchema: GetEnumInfoArgsSchema,
};
