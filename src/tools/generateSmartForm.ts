/**
 * Generate Smart Form Tool
 * AI-driven form generation using indexed metadata patterns
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { XppSymbolIndex } from '../metadata/symbolIndex.js';
import { SmartXmlBuilder, FormDataSourceSpec, FormControlSpec } from '../utils/smartXmlBuilder.js';
import { FormPatternTemplates } from '../utils/formPatternTemplates.js';
import { handleGetFormPatterns } from './getFormPatterns.js';
import path from 'path';
import fs from 'fs';
import { getConfigManager } from '../utils/configManager.js';
import { resolveObjectPrefix, applyObjectPrefix } from '../utils/modelClassifier.js';
import { ProjectFileManager } from './createD365File.js';
import { extractModelFromProject, findProjectInSolution } from '../utils/projectUtils.js';

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
  description: 'Generate AxForm XML using D365FO pattern-aware templates. Supported patterns: SimpleList | SimpleListDetails | DetailsMaster | DetailsTransaction | Dialog | TableOfContents | Lookup | Workspace. Can copy structure from existing forms or auto-generate grid from table fields.',
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
        description: 'Optional: D365FO form pattern. Valid values: SimpleList (default, for setup/config lists), SimpleListDetails (list + detail panel), DetailsMaster (full master record), DetailsTransaction (header+lines, e.g. orders), Dialog (popup dialog), TableOfContents (tabbed settings page), Lookup (dropdown lookup), Workspace (operational workspace with KPI tiles and panorama sections). Aliases like "list", "master", "transaction", "dialog", "workspace", "panorama" are also accepted.',
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
  // Also collects gridFields for pattern templates regardless of generateControls flag
  let gridFields: string[] = [];
  if (dataSource && dataSources.length > 0) {
    try {
      const db = symbolIndex.db;

      // Query fields directly from symbols DB
      const dbFields = db.prepare(`
        SELECT name FROM symbols
        WHERE type = 'field' AND parent_name = ?
        ORDER BY name
      `).all(dataSource) as Array<{ name: string }>;

      if (dbFields.length > 0) {
        // Collect field names excluding system fields for grid display
        gridFields = dbFields
          .map((f: { name: string }) => f.name)
          .filter((n: string) => !['RecId', 'RecVersion', 'DataAreaId', 'Partition'].includes(n))
          .slice(0, 8); // Cap at 8 columns — reasonable for most patterns

        if (generateControls) {
          // Legacy path: also build explicit controls for backward compat
          const gridControl = builder.buildGridControl(
            `${dataSource}Grid`,
            dataSource,
            gridFields
          );
          controls.push(gridControl);
          console.log(`[generateSmartForm] Generated grid with ${gridFields.length} fields`);
        } else {
          console.log(`[generateSmartForm] Collected ${gridFields.length} grid fields for pattern template`);
        }
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
    // .rnrproj extraction failed (or wasn't attempted) — fall back in this order on ALL platforms:
    //   1. .mcp.json context (modelName field or last segment of workspacePath)
    //   2. Auto-detected model name (async) — e.g. from PackagesLocalDirectory regex / well-known paths
    //   3. D365FO_MODEL_NAME env var
    //   4. modelName arg — LAST because the AI often passes a placeholder like "any" or "whatever"
    const configModel = configManager.getModelName();
    const autoModel = configModel ? null : (await configManager.getAutoDetectedModelName());
    resolvedModel = configModel || autoModel || process.env.D365FO_MODEL_NAME || modelName || undefined;
    if (resolvedModel) {
      const ctx = configManager.getContext();
      const source = configModel === resolvedModel
        ? (ctx?.modelName ? 'modelName (mcp.json)' : 'workspacePath (mcp.json)')
        : autoModel === resolvedModel ? 'auto-detected (well-known paths)'
        : process.env.D365FO_MODEL_NAME === resolvedModel ? 'D365FO_MODEL_NAME env var'
        : 'modelName arg (fallback)';
      console.log(`[generateSmartForm] Using model from ${source}: ${resolvedModel}`);
    } else if (!isNonWindows) {
      // Windows VM: all sources exhausted — tell the user exactly what to configure.
      throw new Error(
        'Could not resolve model name. Provide modelName, projectPath, or solutionPath, ' +
        'or configure projectPath/solutionPath in .mcp.json or set D365FO_MODEL_NAME env var.'
      );
    }
    // Non-Windows: if still null, continue without a prefix.
  }

  console.log(`[generateSmartForm] Using model: ${resolvedModel ?? '(none — no prefix)'}`);

  // Apply extension prefix to form name (skip when model unknown)
  const objectPrefix = resolvedModel ? resolveObjectPrefix(resolvedModel) : '';
  const finalName = objectPrefix ? applyObjectPrefix(name, objectPrefix) : name;
  if (finalName !== name) {
    console.log(`[generateSmartForm] Applied prefix "${objectPrefix}": ${name} → ${finalName}`);
  }

  // Generate XML using pattern-specific template
  const normalizedPattern = FormPatternTemplates.normalizePattern(formPattern || 'SimpleList');
  const primaryDs = dataSources[0];
  const xml = FormPatternTemplates.build(normalizedPattern, {
    formName: finalName,
    dsName: primaryDs?.name,
    dsTable: primaryDs?.table,
    caption: caption || label || finalName,
    gridFields,
  });

  console.log(`[generateSmartForm] Generated XML (${xml.length} bytes)`);

  // On non-Windows (Azure/Linux) — return XML as text, no file write possible.
  if (isNonWindows) {
    console.log(`[generateSmartForm] Non-Windows environment — returning XML as text (no file write)`);
    const noModelNote = resolvedModel
      ? ''
      : `\n> ⚠️  No model resolved — XML generated without prefix. Pass \`modelName\` with the actual model name from .mcp.json (e.g. \`"ContosoExt"\`) for correct object naming.`;
    const nextStep = [
      ``,
      `**✅ MANDATORY NEXT STEP — immediately call \`create_d365fo_file\` with the XML below:**`,
      `\`\`\``,
      `create_d365fo_file(`,
      `  objectType="form",`,
      `  objectName="${finalName}",`,
      `  xmlContent="<copy the full XML block below>",`,
      `  addToProject=true`,
      `)`,
      `\`\`\``,
      `⛔ NEVER use \`create_file\`, PowerShell scripts, or any built-in file tool — they corrupt D365FO metadata and break VS project integration.`,
    ].join('\n');
    return {
      content: [
        {
          type: 'text',
          text: [
            `✅ Form XML generated for **${finalName}**`,
            resolvedModel ? `   Model: ${resolvedModel}` : `   ℹ️  No model resolved — no prefix applied. Pass modelName to set prefix.`,
            `   DataSources: ${dataSources.length}, Controls: ${controls.length}`,
            noModelNote,
            ``,
            `ℹ️  MCP server is running on Azure/Linux — file writing is handled by the local Windows companion. This is the expected hybrid workflow.`,
            nextStep,
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
  // Defense-in-depth: resolvedModel should have been validated in the block above,
  // but path.join(packagePath, undefined, ...) throws a cryptic TypeError — guard explicitly.
  if (!resolvedModel) {
    return {
      content: [{
        type: 'text',
        text:
          `❌ Cannot write form file: model name could not be resolved.\n\n` +
          `Add \`projectPath\` to .mcp.json so the tool can extract the model name from your .rnrproj:\n` +
          `\`\`\`json\n{ "servers": { "context": { "projectPath": "K:\\\\VSProjects\\\\...\\\\YourProject.rnrproj" } } }\n\`\`\``,
      }],
      isError: true,
    };
  }
  const targetPath = path.join(packagePath, resolvedModel, resolvedModel, 'AxForm', `${finalName}.xml`);
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

  // Add to Visual Studio project if a projectPath is known
  let projectMessage = '';
  const effectiveProjectPath = resolvedProjectPath ||
    (await getConfigManager().getProjectPath()) ||
    undefined;

  if (effectiveProjectPath) {
    try {
      const projectManager = new ProjectFileManager();
      const wasAdded = await projectManager.addToProject(
        effectiveProjectPath,
        'form',
        finalName,
        normalizedPath
      );
      projectMessage = wasAdded
        ? `\n✅ Added to Visual Studio project:\n📋 Project: ${effectiveProjectPath}`
        : `\n✅ Already in Visual Studio project:\n📋 Project: ${effectiveProjectPath}`;
      console.log(`[generateSmartForm] addToProject result: ${wasAdded ? 'added' : 'already present'}`);
    } catch (projErr) {
      projectMessage = `\n⚠️ File created but could not be added to project: ${projErr instanceof Error ? projErr.message : String(projErr)}`;
      console.error(`[generateSmartForm] addToProject error:`, projErr);
    }
  } else {
    projectMessage = `\n⚠️ addToProject skipped — no projectPath found in .mcp.json or tool args.`;
  }

  return {
    content: [
      {
        type: 'text',
        text: [
          `✅ Form **${finalName}** created directly on the Windows VM.`,
          ``,
          `📁 File: ${normalizedPath}`,
          `📦 Model: ${resolvedModel}`,
          `📊 DataSources: ${dataSources.length}, Controls: ${controls.length}`,
          projectMessage,
          ``,
          `⛔ DO NOT call \`create_d365fo_file\` — the file is already written to disk.`,
          `⛔ DO NOT call \`generate_smart_form\` again — task is COMPLETE.`,
          ``,
          `Next steps for the user:`,
          `1. Reload the project in Visual Studio (or close/reopen solution)`,
          `2. Build the project to synchronize the form`,
          `3. Refresh AOT to see the new object`,
        ].join('\n'),
      },
    ],
  };
}

// extractModelFromProject and findProjectInSolution moved to ../utils/projectUtils.ts
