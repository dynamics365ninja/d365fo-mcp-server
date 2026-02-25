/**
 * Generate Smart Form Tool
 * AI-driven form generation using indexed metadata patterns
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { XppSymbolIndex } from '../metadata/symbolIndex.js';
import { SmartXmlBuilder, FormDataSourceSpec, FormControlSpec } from '../utils/smartXmlBuilder.js';
import { handleGetFormPatterns } from './getFormPatterns.js';
import path from 'path';
import fs from 'fs';
import { getConfigManager } from '../utils/configManager.js';
import { resolveObjectPrefix, applyObjectPrefix } from '../utils/modelClassifier.js';

interface GenerateSmartFormArgs {
  name: string;
  label?: string;
  caption?: string;
  dataSource?: string;
  formPattern?: string;
  copyFrom?: string;
  generateControls?: boolean;
  modelName?: string;
  projectPath?: string;
  solutionPath?: string;
}

export const generateSmartFormTool: Tool = {
  name: 'generate_smart_form',
  description: 'Generate AxForm XML with AI-driven datasource/control suggestions based on indexed patterns. Can copy structure from existing forms, analyze form patterns, or auto-generate grid from table.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Form name (e.g., "MyCustomForm")',
      },
      label: {
        type: 'string',
        description: 'Optional label for the form',
      },
      caption: {
        type: 'string',
        description: 'Optional caption/title datasource',
      },
      dataSource: {
        type: 'string',
        description: 'Optional: Table name for primary datasource. Tool will auto-generate grid with fields.',
      },
      formPattern: {
        type: 'string',
        description: 'Optional: Form pattern (e.g., "SimpleList", "DetailsTransaction"). Tool will analyze similar forms.',
      },
      copyFrom: {
        type: 'string',
        description: 'Optional: Copy structure from existing form (name)',
      },
      generateControls: {
        type: 'boolean',
        description: 'If true, auto-generate grid controls for datasource fields',
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

export async function handleGenerateSmartForm(
  args: GenerateSmartFormArgs,
  symbolIndex: XppSymbolIndex
): Promise<any> {
  const {
    name,
    label,
    caption,
    dataSource,
    formPattern,
    copyFrom,
    generateControls,
    modelName,
    projectPath,
    solutionPath,
  } = args;

  console.log(`[generateSmartForm] Generating form: ${name}, dataSource=${dataSource}, pattern=${formPattern}, copyFrom=${copyFrom}`);

  const builder = new SmartXmlBuilder();
  let dataSources: FormDataSourceSpec[] = [];
  let controls: FormControlSpec[] = [];

  // Strategy 1: Copy from existing form
  if (copyFrom) {
    console.log(`[generateSmartForm] Copying structure from: ${copyFrom}`);
    try {
      const db = symbolIndex.db;

      // Copy datasources directly from form_datasources DB
      const dbDataSources = db.prepare(`
        SELECT datasource_name, table_name, allow_edit, allow_create, allow_delete
        FROM form_datasources
        WHERE form_name = ?
        ORDER BY datasource_name
      `).all(copyFrom) as Array<{
        datasource_name: string;
        table_name: string;
        allow_edit: number;
        allow_create: number;
        allow_delete: number;
      }>;

      if (dbDataSources.length === 0) {
        // Fall back: check if form exists at all
        const formExists = db.prepare(`
          SELECT name FROM symbols WHERE type = 'form' AND name = ? LIMIT 1
        `).get(copyFrom);

        if (!formExists) {
          throw new Error(`Form "${copyFrom}" not found in index`);
        }
        console.warn(`[generateSmartForm] Form "${copyFrom}" found but has no indexed datasources`);
      }

      dataSources = dbDataSources.map((ds) => ({
        name: ds.datasource_name,
        table: ds.table_name,
        allowEdit: ds.allow_edit === 1,
        allowCreate: ds.allow_create === 1,
        allowDelete: ds.allow_delete === 1,
      }));

      console.log(`[generateSmartForm] Copied ${dataSources.length} datasources from ${copyFrom}`);
    } catch (error) {
      console.error(`[generateSmartForm] Failed to copy from ${copyFrom}:`, error);
      throw new Error(`Failed to copy structure from ${copyFrom}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Strategy 2: Create datasource from table and analyze patterns
  if (dataSource && !copyFrom) {
    console.log(`[generateSmartForm] Creating datasource for table: ${dataSource}`);
    
    dataSources.push({
      name: dataSource,
      table: dataSource,
      allowEdit: true,
      allowCreate: true,
      allowDelete: true,
    });

    // Analyze similar forms using this table
    if (formPattern) {
      try {
        await handleGetFormPatterns(
          { formPattern },
          symbolIndex
        );
        console.log(`[generateSmartForm] Analyzed pattern: ${formPattern}`);
      } catch (error) {
        console.warn(`[generateSmartForm] Pattern analysis failed:`, error);
      }
    }
  }

  // Strategy 3: Generate controls for datasource fields
  if (generateControls && dataSource && dataSources.length > 0) {
    console.log(`[generateSmartForm] Generating controls for datasource: ${dataSource}`);

    try {
      const db = symbolIndex.db;

      // Query fields directly from symbols DB
      const dbFields = db.prepare(`
        SELECT name FROM symbols
        WHERE type = 'field' AND parent_name = ?
        ORDER BY name
      `).all(dataSource) as Array<{ name: string }>;

      if (dbFields.length > 0) {
        // Generate grid with all fields excluding RecId
        const fieldNames = dbFields
          .map((f: { name: string }) => f.name)
          .filter((n: string) => n !== 'RecId');

        const gridControl = builder.buildGridControl(
          `${dataSource}Grid`,
          dataSource,
          fieldNames
        );

        controls.push(gridControl);
        console.log(`[generateSmartForm] Generated grid with ${fieldNames.length} fields`);
      }
    } catch (error) {
      console.warn(`[generateSmartForm] Failed to generate controls:`, error);
    }
  }

  // Fallback: At least one datasource needed
  if (dataSources.length === 0) {
    console.warn(`[generateSmartForm] No datasource configured, form will be empty`);
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
      console.log(`[generateSmartForm] Using projectPath from config/auto-detect: ${resolvedProjectPath}`);
    } else if (resolvedSolutionPath) {
      console.log(`[generateSmartForm] Using solutionPath from config/auto-detect: ${resolvedSolutionPath}`);
    }
  }

  // Resolve actual model name — always prefer extracting from .rnrproj over using modelName arg
  let resolvedModel = modelName;
  if (resolvedProjectPath) {
    const extracted = extractModelFromProject(resolvedProjectPath);
    if (extracted) {
      resolvedModel = extracted;
      console.log(`[generateSmartForm] Extracted model from .rnrproj: ${resolvedModel}`);
    }
  } else if (resolvedSolutionPath) {
    const project = findProjectInSolution(resolvedSolutionPath);
    if (project) {
      const extracted = extractModelFromProject(project);
      if (extracted) {
        resolvedModel = extracted;
        console.log(`[generateSmartForm] Extracted model from solution .rnrproj: ${resolvedModel}`);
      }
    }
  }

  const isNonWindows = process.platform !== 'win32';

  if (!resolvedModel) {
    if (isNonWindows) {
      resolvedModel = modelName || undefined;
    } else {
      throw new Error(
        'Could not resolve model name. Provide modelName, projectPath, or solutionPath, ' +
        'or configure projectPath/solutionPath in .mcp.json.'
      );
    }
  }

  console.log(`[generateSmartForm] Using model: ${resolvedModel ?? '(none — no prefix)'}`);

  // Apply extension prefix to form name (skip when model unknown)
  const objectPrefix = resolvedModel ? resolveObjectPrefix(resolvedModel) : '';
  const finalName = objectPrefix ? applyObjectPrefix(name, objectPrefix) : name;
  if (finalName !== name) {
    console.log(`[generateSmartForm] Applied prefix "${objectPrefix}": ${name} → ${finalName}`);
  }

  // Generate XML
  const xml = builder.buildFormXml({
    name: finalName,
    label: label || finalName,
    caption,
    dataSources,
    controls,
  });

  console.log(`[generateSmartForm] Generated XML (${xml.length} bytes)`);

  // On non-Windows (Azure/Linux) — return XML as text, no file write possible.
  if (isNonWindows) {
    console.log(`[generateSmartForm] Non-Windows environment — returning XML as text (no file write)`);
    return {
      content: [
        {
          type: 'text',
          text: [
            `✅ Generated form XML for **${finalName}**`,
            resolvedModel ? `   Model: ${resolvedModel}` : `   ℹ️  No model resolved — no prefix applied. Pass modelName to set prefix.`,
            `   DataSources: ${dataSources.length}, Controls: ${controls.length}`,
            ``,
            `⚠️  Running on Azure/Linux — file was NOT written to disk.`,
            `   To create the physical file, call create_d365fo_file with the XML below on your local Windows VM.`,
            ``,
            `\`\`\`xml`,
            xml,
            `\`\`\``,
          ].join('\n'),
        },
      ],
    };
  }

  // Windows — write to file
  const targetPath = path.join(packagePath, resolvedModel!, resolvedModel!, 'AxForm', `${finalName}.xml`);
  const normalizedPath = targetPath.replace(/\//g, '\\');

  // Verify drive/root exists
  const driveOrRoot = path.parse(normalizedPath).root;
  if (driveOrRoot && !fs.existsSync(driveOrRoot)) {
    throw new Error(
      `❌ Drive or root path does not exist: ${driveOrRoot}\n\n` +
      `Attempting to create: ${normalizedPath}\n\n` +
      `Update "packagePath" in .mcp.json to match your actual D365FO installation.`
    );
  }

  const dir = path.dirname(normalizedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(normalizedPath, xml, 'utf-8');
  console.log(`[generateSmartForm] Created file: ${normalizedPath}`);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          formName: finalName,
          filePath: normalizedPath,
          dataSourcesGenerated: dataSources.length,
          controlsGenerated: controls.length,
          strategy: copyFrom ? 'copy' : dataSource ? 'datasource' : formPattern ? 'pattern' : 'default',
          xml,
        }, null, 2),
      },
    ],
  };
}

/**
 * Extract model name from .rnrproj file.
 * Returns null if the file cannot be read (e.g. Windows path on Linux) or
 * if <ModelName> is not found — callers must handle null gracefully.
 */
function extractModelFromProject(projectPath: string): string | null {
  // Windows paths (K:\...) are not accessible on non-Windows — skip silently
  if (process.platform !== 'win32' && /^[A-Z]:\\/i.test(projectPath)) {
    console.warn(`[generateSmartForm] Skipping .rnrproj read on non-Windows: ${projectPath}`);
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
