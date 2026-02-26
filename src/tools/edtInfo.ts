/**
 * Get EDT Info Tool
 * Extract Extended Data Type (EDT) properties from AxEdt metadata
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { promises as fs } from 'fs';
import { parseStringPromise } from 'xml2js';
import { readEdtRawXml } from '../utils/metadataResolver.js';

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
  _fromDb?: boolean;
}

export async function getEdtInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetEdtInfoArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    const { edtName, modelName } = args;

    // ── Step 1: query edt_metadata (rich columns, always present in DB) ──────
    let edtDbRow: any;

    if (modelName) {
      edtDbRow = symbolIndex.db.prepare(`
        SELECT edt_name, model, extends, enum_type, reference_table, relation_type,
               string_size, display_length, label
        FROM edt_metadata
        WHERE edt_name = ? AND model = ?
        LIMIT 1
      `).get(edtName, modelName);
    } else {
      edtDbRow = symbolIndex.db.prepare(`
        SELECT edt_name, model, extends, enum_type, reference_table, relation_type,
               string_size, display_length, label
        FROM edt_metadata
        WHERE edt_name = ?
        ORDER BY model
        LIMIT 1
      `).get(edtName);
    }

    // ── Fallback: if not in edt_metadata, try symbols table + XML directly ──
    if (!edtDbRow) {
      const symRow = symbolIndex.db.prepare(`
        SELECT name, model, file_path FROM symbols WHERE type = 'edt' AND name = ?
        ORDER BY model LIMIT 1
      `).get(edtName) as { name: string; model: string; file_path: string } | undefined;

      if (!symRow) {
        throw new Error(`EDT "${edtName}" not found. Make sure EDT metadata is extracted and indexed.`);
      }

      // Minimal DB row from symbols so the rest of the flow can continue
      edtDbRow = { edt_name: symRow.name, model: symRow.model };

      let xmlFromSym: string | null = null;
      if (symRow.file_path) {
        try {
          xmlFromSym = await fs.readFile(symRow.file_path, 'utf-8');
        } catch {
          // File not accessible on this machine — build minimal output from symbols row
        }
      }
      if (!xmlFromSym) {
        xmlFromSym = await readEdtRawXml(symRow.model, edtName);
      }

      if (xmlFromSym) {
        const xmlObj = await parseStringPromise(xmlFromSym);
        if (!xmlObj.AxEdt) throw new Error('Invalid EDT XML structure (AxEdt root not found)');
        const edtInfo = extractEdtInfo(xmlObj.AxEdt, edtName, symRow.model);
        return { content: [{ type: 'text', text: formatEdtOutput(edtInfo) }] };
      }

      // Last resort: return minimal info from symbols
      const minimal: EdtInfo = {
        name: symRow.name,
        model: symRow.model,
        additionalProperties: {},
        _fromDb: true,
      };
      return { content: [{ type: 'text', text: formatEdtOutput(minimal) }] };
    }

    // ── Step 2: try to enrich with full XML (may not be available) ───────────
    let rawXml: string | null = null;
    rawXml = await readEdtRawXml(edtDbRow.model, edtName);

    if (!rawXml) {
      // Try the file_path stored in symbols table as last resort
      const symRow = symbolIndex.db.prepare(`
        SELECT file_path FROM symbols WHERE type = 'edt' AND name = ? AND model = ? LIMIT 1
      `).get(edtName, edtDbRow.model) as { file_path: string } | undefined;

      if (symRow?.file_path) {
        try {
          rawXml = await fs.readFile(symRow.file_path, 'utf-8');
        } catch {
          // Build-agent path not accessible — will use DB fallback below
        }
      }
    }

    // ── Step 3: build EdtInfo from XML if available, else from DB columns ────
    let edtInfo: EdtInfo;

    if (rawXml) {
      const xmlObj = await parseStringPromise(rawXml);
      if (!xmlObj.AxEdt) {
        throw new Error('Invalid EDT XML structure (AxEdt root not found)');
      }
      edtInfo = extractEdtInfo(xmlObj.AxEdt, edtName, edtDbRow.model);
    } else {
      // Graceful fallback: use data already stored in edt_metadata table
      edtInfo = buildEdtInfoFromDb(edtDbRow);
    }

    return {
      content: [{ type: 'text', text: formatEdtOutput(edtInfo) }],
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

/**
 * Build EdtInfo from edt_metadata DB row — used when XML file is not accessible
 * (e.g. metadata built on Azure DevOps build agent with paths not available locally).
 */
function buildEdtInfoFromDb(row: {
  edt_name: string;
  model: string;
  extends?: string | null;
  enum_type?: string | null;
  reference_table?: string | null;
  relation_type?: string | null;
  string_size?: string | null;
  display_length?: string | null;
  label?: string | null;
}): EdtInfo {
  return {
    name: row.edt_name,
    model: row.model,
    baseType: row.extends ?? undefined,
    enumType: row.enum_type ?? undefined,
    referenceTable: row.reference_table ?? undefined,
    relationType: row.relation_type ?? undefined,
    stringSize: row.string_size ?? undefined,
    displayLength: row.display_length ?? undefined,
    label: row.label ?? undefined,
    helpText: undefined,
    formHelp: undefined,
    configurationKey: undefined,
    alignment: undefined,
    decimalSeparator: undefined,
    signDisplay: undefined,
    noOfDecimals: undefined,
    additionalProperties: {},
    _fromDb: true,
  };
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

  if (edtInfo._fromDb) {
    output += `> ⚠️ _Full XML not available (built on remote agent). Showing indexed properties from database._\n\n`;
  }

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
