/**
 * Generate Smart Table Tool
 * AI-driven table generation using indexed metadata patterns
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { XppSymbolIndex } from '../metadata/symbolIndex.js';
import { SmartXmlBuilder, TableFieldSpec, TableIndexSpec, TableRelationSpec } from '../utils/smartXmlBuilder.js';
import path from 'path';
import fs from 'fs';
import { getConfigManager } from '../utils/configManager.js';
import { resolveObjectPrefix, applyObjectPrefix } from '../utils/modelClassifier.js';

interface GenerateSmartTableArgs {
  name: string;
  label?: string;
  tableGroup?: string;
  copyFrom?: string;
  fieldsHint?: string;
  generateCommonFields?: boolean;
  modelName?: string;
  projectPath?: string;
  solutionPath?: string;
}

export const generateSmartTableTool: Tool = {
  name: 'generate_smart_table',
  description: 'Generate AxTable XML with AI-driven field/index/relation suggestions based on indexed patterns. Can copy structure from existing tables, analyze table group patterns, or use field hints.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Table name (e.g., "MyCustomTable")',
      },
      label: {
        type: 'string',
        description: 'Optional label for the table',
      },
      tableGroup: {
        type: 'string',
        description: 'Table group (e.g., "Main", "Parameter", "Group", "Transaction")',
      },
      copyFrom: {
        type: 'string',
        description: 'Optional: Copy structure from existing table (name)',
  },
      fieldsHint: {
        type: 'string',
        description: 'Optional: Comma-separated field hints (e.g., "RecId, Name, Amount, Customer"). Tool will suggest EDTs.',
      },
      generateCommonFields: {
        type: 'boolean',
        description: 'If true, analyze table group patterns and generate common fields automatically',
      },
      modelName: {
        type: 'string',
        description: 'Model name for file creation (auto-detected from projectPath)',
      },
      projectPath: {
        type: 'string',
        description: 'Path to .rnrproj file (used to extract correct ModelName)',
      },
      solutionPath: {
        type: 'string',
        description: 'Path to solution directory (alternative to projectPath)',
      },
    },
    required: ['name'],
  },
};

export async function handleGenerateSmartTable(
  args: GenerateSmartTableArgs,
  symbolIndex: XppSymbolIndex
): Promise<any> {
  const { 
    name, 
    label, 
    tableGroup = 'Main', 
    copyFrom, 
    fieldsHint, 
    generateCommonFields,
    modelName,
    projectPath,
    solutionPath,
  } = args;

  console.log(`[generateSmartTable] Generating table: ${name}, tableGroup=${tableGroup}, copyFrom=${copyFrom}`);

  const builder = new SmartXmlBuilder();
  let fields: TableFieldSpec[] = [];
  let indexes: TableIndexSpec[] = [];
  let relations: TableRelationSpec[] = [];

  // Strategy 1: Copy from existing table
  if (copyFrom) {
    console.log(`[generateSmartTable] Copying structure from: ${copyFrom}`);
    try {
      const db = symbolIndex.db;

      // Copy fields directly from the symbols DB
      const dbFields = db.prepare(`
        SELECT name, signature FROM symbols
        WHERE type = 'field' AND parent_name = ?
        ORDER BY name
      `).all(copyFrom) as Array<{ name: string; signature: string }>;

      if (dbFields.length === 0) {
        throw new Error(`Table "${copyFrom}" not found or has no indexed fields`);
      }

      fields = dbFields.map((f: { name: string; signature: string }) => ({
        name: f.name,
        edt: f.signature || undefined,
      }));

      // Copy relations from table_relations
      const dbRelations = db.prepare(`
        SELECT relation_name, target_table, constraint_fields FROM table_relations
        WHERE source_table = ?
      `).all(copyFrom) as Array<{ relation_name: string; target_table: string; constraint_fields: string | null }>;

      relations = dbRelations.map((rel: { relation_name: string; target_table: string; constraint_fields: string | null }) => ({
        name: rel.relation_name.replace(copyFrom, name),
        targetTable: rel.target_table,
        constraints: rel.constraint_fields ? JSON.parse(rel.constraint_fields) : [],
      }));

      console.log(`[generateSmartTable] Copied ${fields.length} fields, ${relations.length} relations from ${copyFrom}`);
    } catch (error) {
      console.error(`[generateSmartTable] Failed to copy from ${copyFrom}:`, error);
      throw new Error(`Failed to copy structure from ${copyFrom}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Strategy 2: Generate common fields based on table group patterns
  if (generateCommonFields && !copyFrom) {
    console.log(`[generateSmartTable] Analyzing patterns for table group: ${tableGroup}`);
    try {
      const db = symbolIndex.db;

      // Use heuristic name patterns (matching analyzeTableGroup logic)
      const namePatterns: Record<string, string> = {
        Transaction: '%Trans%',
        Parameter: '%Parameters',
        Main: '%Table',
      };
      const namePattern = namePatterns[tableGroup];

      const sampleTables = db.prepare(`
        SELECT DISTINCT name FROM symbols
        WHERE type = 'table'
        ${namePattern ? 'AND name LIKE ?' : ''}
        LIMIT 20
      `).all(...(namePattern ? [namePattern] : [])) as Array<{ name: string }>;

      if (sampleTables.length > 0) {
        // Build field frequency map
        const fieldFrequency = new Map<string, { edt: string; count: number }>();
        for (const table of sampleTables) {
          const tableFields = db.prepare(`
            SELECT name, signature FROM symbols
            WHERE type = 'field' AND parent_name = ?
          `).all(table.name) as Array<{ name: string; signature: string }>;

          for (const field of tableFields) {
            if (!field.signature) continue;
            const key = `${field.name}:${field.signature}`;
            const existing = fieldFrequency.get(key);
            if (existing) {
              existing.count++;
            } else {
              fieldFrequency.set(key, { edt: field.signature, count: 1 });
            }
          }
        }

        // Add fields appearing in 30%+ of sample tables
        const threshold = Math.max(1, Math.floor(sampleTables.length * 0.3));
        const commonFields = Array.from(fieldFrequency.entries())
          .filter(([, data]) => data.count >= threshold)
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 10);

        for (const [key, data] of commonFields) {
          const fieldName = key.split(':')[0];
          if (!fields.find(f => f.name === fieldName)) {
            fields.push({ name: fieldName, edt: data.edt });
          }
        }

        console.log(`[generateSmartTable] Generated ${fields.length} fields from ${tableGroup} table group patterns`);
      }
    } catch (error) {
      console.warn(`[generateSmartTable] Pattern analysis failed:`, error);
      // Continue without pattern-based fields
    }
  }

  // Strategy 3: Parse field hints and suggest EDTs
  if (fieldsHint && !copyFrom) {
    console.log(`[generateSmartTable] Parsing field hints: ${fieldsHint}`);
    const hintFields = fieldsHint.split(',').map(s => s.trim()).filter(s => s.length > 0);
    
    for (const hint of hintFields) {
      // Check if field already exists
      if (fields.find(f => f.name === hint)) {
        continue;
      }

      // Try to suggest EDT based on name
      const edt = suggestEdtFromFieldName(hint);
      fields.push({
        name: hint,
        edt,
        mandatory: hint.toLowerCase().includes('recid') || hint.toLowerCase().includes('id'),
      });
    }

    console.log(`[generateSmartTable] Added ${hintFields.length} fields from hints`);
  }

  // Fallback: Add RecId if no fields generated
  if (fields.length === 0) {
    console.log(`[generateSmartTable] No fields generated, adding default RecId`);
    fields.push({
      name: 'RecId',
      edt: 'RecId',
      mandatory: true,
    });
  }

  // Ensure primary key index exists
  const hasRecIdIndex = indexes.some(idx => 
    idx.fields.includes('RecId') || idx.name.toLowerCase().includes('recid')
  );
  
  if (!hasRecIdIndex && fields.some(f => f.name === 'RecId')) {
    indexes.unshift(builder.buildPrimaryKeyIndex(name, ['RecId']));
    console.log(`[generateSmartTable] Added primary key index on RecId`);
  }

  // Determine package path
  const configManager = getConfigManager();
  const packagePath = configManager.getPackagePath() || 'K:\\AosService\\PackagesLocalDirectory';

  // Resolve project/solution path — fall back to configManager (from .mcp.json / auto-detection)
  let resolvedProjectPath = projectPath;
  let resolvedSolutionPath = solutionPath;
  if (!resolvedProjectPath && !resolvedSolutionPath) {
    resolvedProjectPath = (await configManager.getProjectPath()) || undefined;
    resolvedSolutionPath = (await configManager.getSolutionPath()) || undefined;
    if (resolvedProjectPath) {
      console.log(`[generateSmartTable] Using projectPath from config/auto-detect: ${resolvedProjectPath}`);
    } else if (resolvedSolutionPath) {
      console.log(`[generateSmartTable] Using solutionPath from config/auto-detect: ${resolvedSolutionPath}`);
    }
  }

  // Resolve actual model name — always prefer extracting from .rnrproj over using modelName arg
  let resolvedModel = modelName;
  if (resolvedProjectPath) {
    const extracted = extractModelFromProject(resolvedProjectPath);
    if (extracted) {
      resolvedModel = extracted;
      console.log(`[generateSmartTable] Extracted model from .rnrproj: ${resolvedModel}`);
    }
  } else if (resolvedSolutionPath) {
    const project = findProjectInSolution(resolvedSolutionPath);
    if (project) {
      const extracted = extractModelFromProject(project);
      if (extracted) {
        resolvedModel = extracted;
        console.log(`[generateSmartTable] Extracted model from solution .rnrproj: ${resolvedModel}`);
      }
    }
  }

  const isNonWindows = process.platform !== 'win32';

  if (!resolvedModel) {
    if (isNonWindows) {
      // Azure/Linux: model resolution requires .rnrproj which is only on the Windows VM.
      // Use modelName arg as-is for prefix resolution (caller may pass e.g. "AslCore").
      // If not provided either, generate XML without prefix and return it as text.
      resolvedModel = modelName || undefined;
    } else {
      throw new Error(
        'Could not resolve model name. Provide modelName, projectPath, or solutionPath, ' +
        'or configure projectPath/solutionPath in .mcp.json.'
      );
    }
  }

  console.log(`[generateSmartTable] Using model: ${resolvedModel ?? '(none — no prefix)'}`);

  // Apply extension prefix to table name (skip when model unknown)
  const objectPrefix = resolvedModel ? resolveObjectPrefix(resolvedModel) : '';
  const finalName = objectPrefix ? applyObjectPrefix(name, objectPrefix) : name;
  if (finalName !== name) {
    console.log(`[generateSmartTable] Applied prefix "${objectPrefix}": ${name} → ${finalName}`);
  }

  // Generate XML
  const xml = builder.buildTableXml({
    name: finalName,
    label: label || finalName,
    tableGroup,
    fields,
    indexes,
    relations,
  });

  console.log(`[generateSmartTable] Generated XML (${xml.length} bytes)`);

  // On non-Windows (Azure/Linux): return XML as text — cannot write to K:\ drive
  if (isNonWindows) {
    const warning = resolvedModel
      ? `> **Note**: Running on non-Windows. XML returned as text — file was not written to disk.\n> To write to the AOT, run the MCP server on the D365FO Windows VM.\n\n`
      : `> **Note**: Running on non-Windows and no model name resolved. XML returned without prefix.\n> Provide \`modelName\` (e.g. \`"AslCore"\`) to get correct object naming.\n\n`;
    return {
      content: [{
        type: 'text',
        text: `${warning}\`\`\`xml\n${xml}\n\`\`\``,
      }],
    };
  }

  // Write to file
  const targetPath = path.join(packagePath, resolvedModel!, resolvedModel!, 'AxTable', `${finalName}.xml`);

  // Normalize path to Windows format (backslashes) for consistency
  const normalizedPath = targetPath.replace(/\//g, '\\');

  // Reject Windows paths when running on non-Windows (e.g. Linux Azure proxy)
  if (process.platform !== 'win32' && /^[A-Z]:\\/.test(normalizedPath)) {
    throw new Error(
      `❌ Cannot create D365FO file on non-Windows system!\n\n` +
      `Attempting to create: ${normalizedPath}\n` +
      `Running on: ${process.platform}\n\n` +
      `The generate_smart_table tool requires direct access to the D365FO Windows VM.\n` +
      `Run the MCP server locally on the D365FO Windows VM.`
    );
  }

  // Verify drive/root exists before attempting recursive mkdir
  const driveOrRoot = path.parse(normalizedPath).root;
  if (driveOrRoot && !fs.existsSync(driveOrRoot)) {
    throw new Error(
      `❌ Drive or root path does not exist: ${driveOrRoot}\n\n` +
      `Attempting to create: ${normalizedPath}\n\n` +
      `Update "packagePath" in .mcp.json to match your actual D365FO installation.`
    );
  }

  // Create directory if needed
  const dir = path.dirname(normalizedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write file
  fs.writeFileSync(normalizedPath, xml, 'utf-8');
  console.log(`[generateSmartTable] Created file: ${normalizedPath}`);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          tableName: finalName,
          filePath: normalizedPath,
          fieldsGenerated: fields.length,
          indexesGenerated: indexes.length,
          relationsGenerated: relations.length,
          strategy: copyFrom ? 'copy' : generateCommonFields ? 'patterns' : fieldsHint ? 'hints' : 'default',
          xml,
        }, null, 2),
      },
    ],
  };
}

/**
 * Suggest EDT based on field name heuristics
 */
function suggestEdtFromFieldName(fieldName: string): string {
  const nameLower = fieldName.toLowerCase();

  // Common patterns
  if (nameLower === 'recid') return 'RecId';
  if (nameLower.includes('name')) return 'Name';
  if (nameLower.includes('description')) return 'Description';
  if (nameLower.includes('amount')) return 'AmountMST';
  if (nameLower.includes('quantity') || nameLower.includes('qty')) return 'Qty';
  if (nameLower.includes('price')) return 'PriceUnit';
  if (nameLower.includes('date')) return 'TransDate';
  if (nameLower.includes('time') || nameLower.includes('datetime')) return 'TransDateTime';
  if (nameLower.includes('account')) return 'LedgerAccount';
  if (nameLower.includes('customer') || nameLower.includes('cust')) return 'CustAccount';
  if (nameLower.includes('vendor') || nameLower.includes('vend')) return 'VendAccount';
  if (nameLower.includes('item')) return 'ItemId';
  if (nameLower.includes('percent') || nameLower.includes('pct')) return 'Percent';
  if (nameLower.includes('status')) return 'NoYesId';
  if (nameLower.includes('enabled')) return 'NoYesId';
  if (nameLower.includes('id') && !nameLower.includes('recid')) return 'RefRecId';

  // Default to string
  return 'String255';
}

/**
 * Extract model name from .rnrproj file.
 * Returns null if the file cannot be read (e.g. Windows path on Linux) or
 * if <ModelName> is not found — callers must handle null gracefully.
 */
function extractModelFromProject(projectPath: string): string | null {
  // Windows paths (K:\...) are not accessible on non-Windows — skip silently
  if (process.platform !== 'win32' && /^[A-Z]:\\/i.test(projectPath)) {
    console.warn(`[generateSmartTable] Skipping .rnrproj read on non-Windows: ${projectPath}`);
    return null;
  }
  try {
    const content = fs.readFileSync(projectPath, 'utf-8');
    const match = content.match(/<ModelName>(.*?)<\/ModelName>/);
    if (match && match[1]) {
      return match[1];
    }
  } catch (error) {
    console.error(`Failed to extract model from ${projectPath}:`, error);
  }
  return null;
}

/**
 * Find .rnrproj file in solution directory
 */
function findProjectInSolution(solutionPath: string): string | null {
  try {
    const files = fs.readdirSync(solutionPath, { recursive: true }) as string[];
    const projectFile = files.find(f => f.endsWith('.rnrproj'));
    return projectFile ? path.join(solutionPath, projectFile) : null;
  } catch (error) {
    console.error(`Failed to find project in ${solutionPath}:`, error);
    return null;
  }
}
