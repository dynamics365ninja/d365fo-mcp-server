/**
 * D365FO File Creator Tool
 * Creates physical XML files in the AOT package structure
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Parser, Builder } from 'xml2js';
import { getConfigManager } from '../utils/configManager.js';
import { registerCustomModel, resolveObjectPrefix, applyObjectPrefix } from '../utils/modelClassifier.js';
import { PackageResolver } from '../utils/packageResolver.js';

const CreateD365FileArgsSchema = z.object({
  objectType: z
    .enum(['class', 'table', 'enum', 'form', 'query', 'view', 'data-entity'])
    .describe('Type of D365FO object to create'),
  objectName: z
    .string()
    .describe('Name of the object (e.g., MyHelperClass, MyCustomTable)'),
  modelName: z
    .string()
    .optional()
    .describe('Model name (e.g., ContosoExtensions). Auto-detected from mcp.json if omitted.'),
  packageName: z
    .string()
    .optional()
    .describe('Package name (e.g., CustomExtensions, ApplicationSuite). Auto-resolved from model name if omitted.'),
  packagePath: z
    .string()
    .optional()
    .describe('Base package path (default: K:\\AosService\\PackagesLocalDirectory)'),
  sourceCode: z
    .string()
    .optional()
    .describe('X++ source code for the object (class declaration, methods, etc.)'),
  properties: z
    .record(z.string(), z.any())
    .optional()
    .describe('Additional properties for the object (extends, implements, etc.)'),
  addToProject: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to automatically add file to Visual Studio project (default: true — always pass true unless explicitly told not to)'),
  projectPath: z
    .string()
    .optional()
    .describe('Path to .rnrproj file. Required for addToProject to work. If not specified, auto-detected from .mcp.json or workspace context.'),
  solutionPath: z
    .string()
    .optional()
    .describe('Path to active VS solution directory. Used to find .rnrproj when projectPath is not given.'),
  xmlContent: z
    .string()
    .optional()
    .describe(
      'Custom XML content to write verbatim instead of generating a template. ' +
      'Use this in hybrid setups: call generate_smart_table / generate_smart_form on Azure ' +
      'to get AI-driven XML, then pass that XML here on the local Windows VM to write the file ' +
      'and add it to the VS2022 project.'
    ),
});

/**
 * Project File Finder
 * Finds .rnrproj files in solution directory or specific paths
 */
class ProjectFileFinder {
  /**
   * Find .rnrproj file in solution directory
   * Recursively searches for .rnrproj files matching the model name (up to 3 levels deep)
   */
  static async findProjectInSolution(
    solutionPath: string,
    modelName: string
  ): Promise<string | null> {
    return ProjectFileFinder.findRecursive(solutionPath, modelName, 0, 3);
  }

  private static async findRecursive(
    dir: string,
    modelName: string,
    currentDepth: number,
    maxDepth: number
  ): Promise<string | null> {
    if (currentDepth > maxDepth) return null;

    try {
      await fs.access(dir);
    } catch {
      return null;
    }

    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      return null;
    }

    // Check .rnrproj files at this level first
    const projectFiles = files.filter(file =>
      file.endsWith('.rnrproj') &&
      (file.includes(modelName) || file === `${modelName}.rnrproj`)
    );

    if (projectFiles.length > 0) {
      return path.join(dir, projectFiles[0]);
    }

    // Recurse into subdirectories
    for (const file of files) {
      const fullPath = path.join(dir, file);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
          const found = await ProjectFileFinder.findRecursive(fullPath, modelName, currentDepth + 1, maxDepth);
          if (found) return found;
        }
      } catch {
        continue;
      }
    }

    return null;
  }
}

/**
 * Map a D365FO base type name to the XML i:type attribute used in <AxTableField>.
 */
function fieldTypeToAxType(fieldType: string): string {
  const typeMap: Record<string, string> = {
    String:   'AxTableFieldString',
    Integer:  'AxTableFieldInt',
    Int64:    'AxTableFieldInt64',
    Real:     'AxTableFieldReal',
    Date:     'AxTableFieldDate',
    DateTime: 'AxTableFieldDateTime',
    Enum:     'AxTableFieldEnum',
    GUID:     'AxTableFieldGuid',
    Container:'AxTableFieldContainer',
  };
  return typeMap[fieldType] || 'AxTableFieldString';
}

/**
 * XML Templates for different D365FO object types
 */
class XmlTemplateGenerator {
  /**
   * Generate AxClass XML structure
   */
  static generateAxClassXml(
    className: string,
    sourceCode?: string,
    properties?: Record<string, any>
  ): string {
    const declaration = sourceCode || `public class ${className}\n{\n}`;
    const extendsAttr = properties?.extends
      ? `\t<Extends>${properties.extends}</Extends>\n`
      : '';
    const implementsAttr = properties?.implements
      ? `\t<Implements>${properties.implements}</Implements>\n`
      : '';
    const isFinalAttr = properties?.isFinal ? `\t<IsFinal>Yes</IsFinal>\n` : '';
    const isAbstractAttr = properties?.isAbstract
      ? `\t<IsAbstract>Yes</IsAbstract>\n`
      : '';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${className}</Name>
${extendsAttr}${implementsAttr}${isFinalAttr}${isAbstractAttr}\t<SourceCode>
\t\t<Declaration><![CDATA[
${declaration}
]]></Declaration>
\t\t<Methods />
\t</SourceCode>
</AxClass>
`;
  }

  /**
   * Generate AxTable XML structure (based on real D365FO table structure)
   */
  static generateAxTableXml(
    tableName: string,
    properties?: Record<string, any>
  ): string {
    const label = properties?.label || tableName;
    const tableGroup = properties?.tableGroup || 'Main';
    const titleField1 = properties?.titleField1 || '';
    const titleField2 = properties?.titleField2 || '';
    const configKey = properties?.configurationKey || '';
    const primaryIndex = properties?.primaryIndex || '';
    const cacheLookup = properties?.cacheLookup || '';

    // Build optional configuration key
    const configKeyXml = configKey
      ? `\t<ConfigurationKey>${configKey}</ConfigurationKey>\n`
      : '';

    // Build optional cache lookup (only if explicitly set)
    const cacheLookupXml = cacheLookup
      ? `\t<CacheLookup>${cacheLookup}</CacheLookup>\n`
      : '';

    // Build optional primary index (NOTE: ClusteredIndex is NOT in real D365FO files)
    const primaryIndexXml = primaryIndex
      ? `\t<PrimaryIndex>${primaryIndex}</PrimaryIndex>\n\t<ReplacementKey>${primaryIndex}</ReplacementKey>\n`
      : '';

    // Build <Fields> block from properties.fields array (TableFieldSpec[]).
    // Copilot may pass field definitions via properties.fields or via sourceCode JSON —
    // both paths merge into properties before calling here (see generate()).
    const fieldSpecs: Array<{ name: string; edt?: string; type?: string; mandatory?: boolean; label?: string }> =
      Array.isArray(properties?.fields) ? properties.fields : [];

    let fieldsXml: string;
    if (fieldSpecs.length === 0) {
      fieldsXml = '\t<Fields />\n';
    } else {
      fieldsXml = '\t<Fields>\n';
      for (const f of fieldSpecs) {
        const iType = f.edt ? 'AxTableFieldString' : fieldTypeToAxType(f.type || 'String');
        fieldsXml += `\t\t<AxTableField xmlns="" i:type="${iType}">\n`;
        fieldsXml += `\t\t\t<Name>${f.name}</Name>\n`;
        if (f.edt)       fieldsXml += `\t\t\t<ExtendedDataType>${f.edt}</ExtendedDataType>\n`;
        if (f.mandatory) fieldsXml += `\t\t\t<Mandatory>Yes</Mandatory>\n`;
        if (f.label)     fieldsXml += `\t\t\t<Label>${f.label}</Label>\n`;
        fieldsXml += `\t\t</AxTableField>\n`;
      }
      fieldsXml += '\t</Fields>\n';
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${tableName}</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ${tableName} extends common
{
}
]]></Declaration>
\t\t<Methods />
\t</SourceCode>
${configKeyXml}\t<Label>${label}</Label>
\t<TableGroup>${tableGroup}</TableGroup>
\t<TitleField1>${titleField1}</TitleField1>
\t<TitleField2>${titleField2}</TitleField2>
${cacheLookupXml}${primaryIndexXml}\t<DeleteActions />
\t<FieldGroups>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoReport</Name>
\t\t\t<Fields />
\t\t</AxTableFieldGroup>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoLookup</Name>
\t\t\t<Fields />
\t\t</AxTableFieldGroup>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoIdentification</Name>
\t\t\t<AutoPopulate>Yes</AutoPopulate>
\t\t\t<Fields />
\t\t</AxTableFieldGroup>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoSummary</Name>
\t\t\t<Fields />
\t\t</AxTableFieldGroup>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoBrowse</Name>
\t\t\t<Fields />
\t\t</AxTableFieldGroup>
\t</FieldGroups>
${fieldsXml}\t<Indexes />
\t<Mappings />
\t<Relations />
\t<StateMachines />
</AxTable>
`;
  }

  /**
   * Generate AxEnum XML structure
   */
  static generateAxEnumXml(
    enumName: string,
    properties?: Record<string, any>
  ): string {
    const label = properties?.label || enumName;
    const useEnumValue = properties?.useEnumValue ? 'Yes' : 'No';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxEnum xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${enumName}</Name>
\t<Label>${label}</Label>
\t<UseEnumValue>${useEnumValue}</UseEnumValue>
\t<EnumValues />
</AxEnum>
`;
  }

  /**
   * Generate AxForm XML structure (based on real D365FO form structure)
   */
  static generateAxFormXml(
    formName: string,
    properties?: Record<string, any>
  ): string {
    const caption = properties?.caption || `@${formName}`;
    const formTemplate = properties?.formTemplate || 'DetailsPage';
    const pattern = properties?.pattern || 'DetailsTransaction';
    const dataSource = properties?.dataSource || '';
    const interactionClass = properties?.interactionClass || '';
    const style = properties?.style || 'DetailsFormTransaction';

    // Build class declaration for SourceCode
    const extendsFrom = properties?.extends || 'FormRun';
    const classDeclaration = properties?.classDeclaration || 
      `[Form]\npublic class ${formName} extends ${extendsFrom}\n{\n}`;

    // Build optional InteractionClass
    const interactionClassXml = interactionClass
      ? `\t<InteractionClass>${interactionClass}</InteractionClass>\n`
      : '';

    // Build DataSource reference for Design
    const dataSourceXml = dataSource
      ? `\t\t<DataSource xmlns="">${dataSource}</DataSource>\n`
      : '';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${formName}</Name>
\t<SourceCode>
\t\t<Methods xmlns="">
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><![CDATA[
${classDeclaration}
]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t</SourceCode>
\t<FormTemplate>${formTemplate}</FormTemplate>
${interactionClassXml}\t<DataSources />
\t<Design>
\t\t<Caption xmlns="">${caption}</Caption>
${dataSourceXml}\t\t<Pattern xmlns="">${pattern}</Pattern>
\t\t<Style xmlns="">${style}</Style>
\t\t<Controls xmlns="" />
\t</Design>
\t<Parts />
</AxForm>
`;
  }

  /**
   * Generate AxQuery XML structure
   */
  static generateAxQueryXml(
    queryName: string,
    properties?: Record<string, any>
  ): string {
    const title = properties?.title || queryName;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxQuery xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${queryName}</Name>
\t<Title>${title}</Title>
\t<DataSources />
</AxQuery>
`;
  }

  /**
   * Generate AxView XML structure
   */
  static generateAxViewXml(
    viewName: string,
    properties?: Record<string, any>
  ): string {
    const label = properties?.label || viewName;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${viewName}</Name>
\t<Label>${label}</Label>
\t<Fields />
\t<Mappings />
\t<Metadata />
\t<ViewMetadata />
</AxView>
`;
  }

  /**
   * Generate AxDataEntityView XML structure
   */
  static generateAxDataEntityXml(
    entityName: string,
    properties?: Record<string, any>
  ): string {
    const label = properties?.label || entityName;
    const publicEntityName = properties?.publicEntityName || entityName;
    const publicCollectionName =
      properties?.publicCollectionName || `${entityName}Collection`;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${entityName}</Name>
\t<Label>${label}</Label>
\t<DataManagementEnabled>Yes</DataManagementEnabled>
\t<DataManagementStagingTable>${entityName}Staging</DataManagementStagingTable>
\t<EntityCategory>Transaction</EntityCategory>
\t<IsPublic>Yes</IsPublic>
\t<PublicCollectionName>${publicCollectionName}</PublicCollectionName>
\t<PublicEntityName>${publicEntityName}</PublicEntityName>
\t<Fields />
\t<Keys />
\t<Mappings />
\t<Ranges />
\t<Relations />
\t<ViewMetadata />
</AxDataEntityView>
`;
  }

  /**
   * Generate XML based on object type
   */
  static generate(
    objectType: string,
    objectName: string,
    sourceCode?: string,
    properties?: Record<string, any>
  ): string {
    switch (objectType) {
      case 'class':
        return this.generateAxClassXml(objectName, sourceCode, properties);
      case 'table': {
        // sourceCode is not used for tables directly, but Copilot may pass field
        // definitions as a JSON string in sourceCode. Try to parse and merge into properties.
        let mergedProperties = properties;
        if (sourceCode && sourceCode.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(sourceCode);
            if (parsed && (Array.isArray(parsed.fields) || parsed.label || parsed.tableGroup)) {
              mergedProperties = { ...parsed, ...properties }; // explicit properties win
              console.error('[create_d365fo_file] Parsed table field definitions from sourceCode JSON');
            }
          } catch {
            // Not valid JSON — ignore
          }
        }
        return this.generateAxTableXml(objectName, mergedProperties);
      }
      case 'enum':
        return this.generateAxEnumXml(objectName, properties);
      case 'form':
        return this.generateAxFormXml(objectName, properties);
      case 'query':
        return this.generateAxQueryXml(objectName, properties);
      case 'view':
        return this.generateAxViewXml(objectName, properties);
      case 'data-entity':
        return this.generateAxDataEntityXml(objectName, properties);
      default:
        throw new Error(`Unsupported object type: ${objectType}`);
    }
  }
}

/**
 * Visual Studio Project (.rnrproj) Manipulator
 */
export class ProjectFileManager {
  private parser: Parser;
  private builder: Builder;

  constructor() {
    this.parser = new Parser({
      explicitArray: false,
      mergeAttrs: false,
      trim: true,
    });
    this.builder = new Builder({
      xmldec: { version: '1.0', encoding: 'utf-8' },
      renderOpts: { pretty: true, indent: '  ' },
    });
  }

  /**
   * Get friendly display folder name for project (used in Folder Include and Link)
   * e.g. class → Classes, enum → Base Enums
   */
  private getFolderName(objectType: string): string {
    const folderMap: Record<string, string> = {
      class: 'Classes',
      table: 'Tables',
      enum: 'Base Enums',
      form: 'Forms',
      query: 'Queries',
      view: 'Views',
      'data-entity': 'Data Entities',
      'table-extension': 'Table Extensions',
      'form-extension': 'Form Extensions',
      'data-entity-extension': 'Data Entity Extensions',
    };
    return folderMap[objectType] || 'Classes';
  }

  /**
   * Get AOT folder prefix for Content Include path (no .xml extension)
   * e.g. class → AxClass, enum → AxEnum, data-entity → AxDataEntityView
   */
  private getAxFolderPrefix(objectType: string): string {
    const prefixMap: Record<string, string> = {
      class: 'AxClass',
      table: 'AxTable',
      enum: 'AxEnum',
      form: 'AxForm',
      query: 'AxQuery',
      view: 'AxView',
      'data-entity': 'AxDataEntityView',
      'table-extension': 'AxTableExtension',
      'form-extension': 'AxFormExtension',
      'data-entity-extension': 'AxDataEntityViewExtension',
    };
    return prefixMap[objectType] || 'AxClass';
  }

  /**
   * Add file reference to Visual Studio project
   * D365FO projects use ABSOLUTE paths to XML files in PackagesLocalDirectory
   * Returns true if file was added, false if file already exists in project
   */
  async addToProject(
    projectPath: string,
    objectType: string,
    objectName: string,
    absoluteXmlPath: string
  ): Promise<boolean> {
    console.error(
      `[ProjectFileManager] Adding to project: ${projectPath}, type: ${objectType}, name: ${objectName}`
    );
    console.error(`[ProjectFileManager] Absolute XML path: ${absoluteXmlPath}`);

    // Read project file
    const projectXml = await fs.readFile(projectPath, 'utf-8');
    const project = await this.parser.parseStringPromise(projectXml);

    console.error(
      `[ProjectFileManager] Parsed project, ItemGroup count: ${Array.isArray(project.Project.ItemGroup) ? project.Project.ItemGroup.length : 'single'}`
    );

    // Ensure project structure exists
    if (!project.Project) {
      throw new Error('Invalid .rnrproj file structure');
    }

    // Initialize ItemGroup if not exists
    if (!project.Project.ItemGroup) {
      project.Project.ItemGroup = [{ Folder: [] }, { Content: [] }];
    }

    // Convert to array if single ItemGroup
    if (!Array.isArray(project.Project.ItemGroup)) {
      project.Project.ItemGroup = [project.Project.ItemGroup];
    }

    // Find or create Folder ItemGroup
    let folderGroup = project.Project.ItemGroup.find(
      (group: any) => group.Folder !== undefined
    );
    if (!folderGroup) {
      folderGroup = { Folder: [] };
      project.Project.ItemGroup.push(folderGroup);
    }

    // Find or create Content ItemGroup
    let contentGroup = project.Project.ItemGroup.find(
      (group: any) => group.Content !== undefined
    );
    if (!contentGroup) {
      contentGroup = { Content: [] };
      project.Project.ItemGroup.push(contentGroup);
    }

    // Ensure arrays
    if (!Array.isArray(folderGroup.Folder)) {
      folderGroup.Folder = folderGroup.Folder ? [folderGroup.Folder] : [];
    }
    if (!Array.isArray(contentGroup.Content)) {
      contentGroup.Content = contentGroup.Content ? [contentGroup.Content] : [];
    }

    // Get folder names for project organization
    const displayFolderName = this.getFolderName(objectType);
    const axFolderPrefix = this.getAxFolderPrefix(objectType);

    // Add folder if not exists (uses friendly display name, e.g. "Classes\")
    const folderExists = folderGroup.Folder.some(
      (folder: any) =>
        folder.$ && folder.$.Include === `${displayFolderName}\\`
    );
    if (!folderExists) {
      folderGroup.Folder.push({
        $: { Include: `${displayFolderName}\\` },
      });
    }

    // D365FO .rnrproj standard:
    //   Content Include = AxClass\ObjectName  (Ax prefix, NO .xml extension)
    //   Link            = Classes\ObjectName  (display name, NO .xml extension)
    const contentInclude = `${axFolderPrefix}\\${objectName}`;
    const linkPath = `${displayFolderName}\\${objectName}`;

    // Check if file already in project
    const fileExists = contentGroup.Content.some(
      (content: any) =>
        content.$ && content.$.Include === contentInclude
    );

    if (fileExists) {
      console.error(
        `[ProjectFileManager] File ${objectName} is already in the project - skipping`
      );
      return false; // File already exists in project
    }

    // Add file reference
    contentGroup.Content.push({
      $: { Include: contentInclude },
      SubType: 'Content',
      Name: objectName,
      Link: linkPath,
    });

    console.error(
      `[ProjectFileManager] Added file reference to project, Content items: ${contentGroup.Content.length}`
    );

    // Write back to project file
    const updatedXml = this.builder.buildObject(project);
    await fs.writeFile(projectPath, updatedXml, 'utf-8');

    console.error(`[ProjectFileManager] Project file saved successfully`);
    return true; // File successfully added
  }

  /**
   * Extract ModelName from Visual Studio project file
   * Returns the actual model name from PropertyGroup/Model or PropertyGroup/ModelName
   */
  async extractModelName(projectPath: string): Promise<string | null> {
    try {
      console.error(
        `[ProjectFileManager] Extracting model name from: ${projectPath}`
      );

      // Read project file
      const projectXml = await fs.readFile(projectPath, 'utf-8');
      const project = await this.parser.parseStringPromise(projectXml);

      // Look for PropertyGroup with Model or ModelName
      if (project.Project && project.Project.PropertyGroup) {
        const propertyGroups = Array.isArray(project.Project.PropertyGroup)
          ? project.Project.PropertyGroup
          : [project.Project.PropertyGroup];

        for (const group of propertyGroups) {
          // Try <Model> tag first (standard D365FO format)
          if (group.Model) {
            const modelName = group.Model;
            console.error(
              `[ProjectFileManager] Found Model in project: ${modelName}`
            );
            return modelName;
          }
          
          // Fallback to <ModelName> tag (alternative format)
          if (group.ModelName) {
            const modelName = group.ModelName;
            console.error(
              `[ProjectFileManager] Found ModelName in project: ${modelName}`
            );
            return modelName;
          }
        }
      }

      console.error(
        `[ProjectFileManager] No Model or ModelName found in project file`
      );
      return null;
    } catch (error) {
      console.error(
        `[ProjectFileManager] Error extracting model name:`,
        error
      );
      return null;
    }
  }
}

/**
 * Create D365FO file handler function
 */
export async function handleCreateD365File(
  request: CallToolRequest
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const args = CreateD365FileArgsSchema.parse(request.params.arguments);

  try {
    // Step 1: Try to find and parse .rnrproj to get actual ModelName
    let actualModelName = args.modelName;
    let wasAutoExtracted = false;
    let projectPathToUse = args.projectPath;
    let solutionPathToUse = args.solutionPath;
    
    console.error(
      `[create_d365fo_file] Initial modelName: ${actualModelName}`
    );

    // If neither projectPath nor solutionPath provided, try to get from config or auto-detect
    if (!projectPathToUse && !solutionPathToUse) {
      const configManager = getConfigManager();

      // Try to auto-detect from workspace (async)
      projectPathToUse = await configManager.getProjectPath() || undefined;
      solutionPathToUse = await configManager.getSolutionPath() || undefined;

      // If model name was not passed as argument, try to resolve from mcp.json config
      if (!actualModelName) {
        actualModelName = configManager.getModelName() ?? undefined;
        if (actualModelName) {
          const ctx = configManager.getContext();
          const source = ctx?.modelName ? 'modelName (mcp.json)' : 'workspacePath (mcp.json)';
          console.error(`[create_d365fo_file] Using modelName from ${source}: ${actualModelName}`);
        }
      }

      if (projectPathToUse) {
        console.error(
          `[create_d365fo_file] Using projectPath (auto-detected or from .mcp.json): ${projectPathToUse}`
        );
      } else if (solutionPathToUse) {
        console.error(
          `[create_d365fo_file] Using solutionPath (auto-detected or from .mcp.json): ${solutionPathToUse}`
        );
      }
    }

    // If projectPath is available, extract model name from it
    if (projectPathToUse) {
      const projectManager = new ProjectFileManager();
      const extractedModelName = await projectManager.extractModelName(
        projectPathToUse
      );
      if (extractedModelName) {
        actualModelName = extractedModelName;
        wasAutoExtracted = true;
        console.error(
          `[create_d365fo_file] Extracted ModelName from projectPath: ${actualModelName}`
        );
        
        // ✨ Register extracted model as custom (since it came from user's project)
        registerCustomModel(actualModelName);
      }
    }
    // If solutionPath is available, try to find .rnrproj and extract model name
    else if (solutionPathToUse) {
      const foundProjectPath = await ProjectFileFinder.findProjectInSolution(
        solutionPathToUse,
        actualModelName ?? ''
      );
      
      if (foundProjectPath) {
        const projectManager = new ProjectFileManager();
        const extractedModelName = await projectManager.extractModelName(
          foundProjectPath
        );
        if (extractedModelName) {
          actualModelName = extractedModelName;
          wasAutoExtracted = true;
          console.error(
            `[create_d365fo_file] Extracted ModelName from solutionPath .rnrproj: ${actualModelName}`
          );
          
          // ✨ Register extracted model as custom (since it came from user's project)
          registerCustomModel(actualModelName);
        }
      }
    }

    // ⚠️ CRITICAL: modelName is required — must come from args, mcp.json, or .rnrproj extraction
    if (!actualModelName) {
      const errorMsg =
        '❌ ERROR: modelName could not be resolved.\n\n' +
        'Provide it in one of these ways:\n' +
        '  1. Pass modelName explicitly in the tool call arguments\n' +
        '  2. Add modelName to .mcp.json context: { "context": { "modelName": "YourModel" } }\n' +
        '  3. Add workspacePath ending with the package/model name: { "context": { "workspacePath": "K:\\\\...\\\\YourModel" } }\n' +
        '  4. Add projectPath or solutionPath to .mcp.json so the model is auto-extracted from .rnrproj';
      console.error(`[create_d365fo_file] ${errorMsg}`);
      return { content: [{ type: 'text', text: errorMsg }] };
    }

    // ⚠️ CRITICAL WARNING: If no project/solution path available anywhere
    if (!projectPathToUse && !solutionPathToUse) {
      console.error(
        `[create_d365fo_file] ⚠️ WARNING: No projectPath or solutionPath available (not in args, not in .mcp.json)!`
      );
      console.error(
        `[create_d365fo_file] ⚠️ Using modelName AS-IS: "${actualModelName}"`
      );
      console.error(
        `[create_d365fo_file] ⚠️ If "${actualModelName}" is a Microsoft model (e.g., ApplicationSuite), this will create the file in the WRONG location!`
      );
      console.error(
        `[create_d365fo_file] ⚠️ Add projectPath or solutionPath to .mcp.json config to auto-extract correct ModelName from .rnrproj!`
      );
      
      // Extra validation: Check for suspicious/placeholder model names
      const suspiciousNames = ['auto', 'test', 'example', 'temp', 'undefined', 'null'];
      // Known Microsoft standard D365FO models — NEVER use for custom code
      const knownMicrosoftModels = [
        'applicationsuite', 'applicationcommon', 'applicationfoundation', 'applicationplatform',
        'applicationwebcomponents', 'applicationworkspaces', 'foundation',
        'directory', 'dimensions', 'currency', 'calendar', 'casemanagement',
        'contactperson', 'datasharing', 'dataupgrade', 'datamaintenance',
        'electronicreporting', 'electronicreportingcore',
        'banktype', 'banktypes', 'benefitsmanagement', 'creditmanagement',
      ];
      const modelLower = actualModelName.toLowerCase();
      const isPlaceholder = suspiciousNames.includes(modelLower);
      const isMicrosoftModel = knownMicrosoftModels.includes(modelLower);

      if (isPlaceholder || isMicrosoftModel) {
        const reason = isPlaceholder
          ? `"${actualModelName}" is a placeholder value, not a real D365FO model`
          : `"${actualModelName}" is a Microsoft standard model — custom code must NEVER be created there`;
        const errorMsg =
          `❌ ERROR: ${reason}\n\n` +
          `Root cause: No projectPath or solutionPath was found (not in tool args, not in .mcp.json config).\n` +
          `Without projectPath, the tool uses the modelName parameter AS-IS, which is wrong.\n\n` +
          `To fix — add projectPath to .mcp.json (in the MCP server directory)::\n` +
          `  {\n` +
          `    "servers": {\n` +
          `      "context": {\n` +
          `        "projectPath": "K:\\\\VSProjects\\\\YourSolution\\\\YourProject\\\\YourProject.rnrproj",\n` +
          `        "solutionPath": "K:\\\\VSProjects\\\\YourSolution",\n` +
          `        "packagePath": "K:\\\\AosService\\\\PackagesLocalDirectory"\n` +
          `      }\n` +
          `    }\n` +
          `  }\n\n` +
          `Or pass projectPath explicitly in the tool call arguments.`;

        console.error(`[create_d365fo_file] ${errorMsg}`);

        return {
          content: [
            {
              type: 'text',
              text: errorMsg
            }
          ]
        };
      }
    }

    console.error(
      `[create_d365fo_file] Final ModelName to use: ${actualModelName}${wasAutoExtracted ? ' (auto-extracted ✓)' : ' (as-is, NOT auto-extracted ⚠️)'}`
    );

    // Apply extension prefix to object name
    const objectPrefix = resolveObjectPrefix(actualModelName);
    const finalObjectName = applyObjectPrefix(args.objectName, objectPrefix);
    if (finalObjectName !== args.objectName) {
      console.error(`[create_d365fo_file] Applied prefix "${objectPrefix}": ${args.objectName} → ${finalObjectName}`);
    }

    // Determine object folder based on type
    const objectFolderMap: Record<string, string> = {
      class: 'AxClass',
      table: 'AxTable',
      enum: 'AxEnum',
      form: 'AxForm',
      query: 'AxQuery',
      view: 'AxView',
      'data-entity': 'AxDataEntityView',
    };

    const objectFolder = objectFolderMap[args.objectType];
    if (!objectFolder) {
      throw new Error(`Unsupported object type: ${args.objectType}`);
    }

    // Construct full path - resolve package name
    // Package name can differ from model name in any environment (not just UDE).
    const configManager = getConfigManager();
    const configPackagePath = configManager.getPackagePath();
    const envType = await configManager.getDevEnvironmentType();

    let basePath: string;
    let resolvedPackageName: string;

    if (args.packageName) {
      // Explicit packageName always wins, regardless of environment type
      resolvedPackageName = args.packageName;
      if (envType === 'ude') {
        const customPath = await configManager.getCustomPackagesPath();
        basePath = customPath || args.packagePath || configPackagePath || 'K:\\AosService\\PackagesLocalDirectory';
      } else {
        basePath = args.packagePath || configPackagePath || 'K:\\AosService\\PackagesLocalDirectory';
      }
    } else if (envType === 'ude') {
      // UDE mode: auto-resolve package name via descriptor scan
      const customPath = await configManager.getCustomPackagesPath();
      const msPath = await configManager.getMicrosoftPackagesPath();
      const roots = [customPath, msPath].filter(Boolean) as string[];

      const resolver = new PackageResolver(roots);
      const resolved = await resolver.resolve(actualModelName);

      if (resolved) {
        resolvedPackageName = resolved.packageName;
        basePath = resolved.rootPath;
      } else {
        // Fallback: assume package == model (common case)
        resolvedPackageName = actualModelName;
        basePath = customPath || args.packagePath || configPackagePath || 'K:\\AosService\\PackagesLocalDirectory';
      }
    } else {
      // Traditional mode without explicit packageName: assume package == model
      resolvedPackageName = actualModelName;
      basePath =
        args.packagePath ||
        configPackagePath ||
        'K:\\AosService\\PackagesLocalDirectory';
    }

    console.error(
      `[create_d365fo_file] Environment: ${envType}, Package: ${resolvedPackageName}, Model: ${actualModelName}`,
    );

    const modelPath = path.join(
      basePath,
      resolvedPackageName,
      actualModelName,
      objectFolder,
    );
    const fileName = `${finalObjectName}.xml`;
    const fullPath = path.join(modelPath, fileName);
    
    // Normalize path to Windows format (backslashes) for consistency
    const normalizedFullPath = fullPath.replace(/\//g, '\\');

    // Ensure directory exists (create if needed)
    const directory = path.dirname(normalizedFullPath);
    console.error(
      `[create_d365fo_file] Ensuring directory exists: ${directory}`
    );
    
    // Check if this looks like a Windows path on non-Windows system
    if (process.platform !== 'win32' && /^[A-Z]:\\/.test(normalizedFullPath)) {
      throw new Error(
        `❌ Cannot create D365FO file on non-Windows system!\n\n` +
        `Attempting to create: ${normalizedFullPath}\n` +
        `Running on: ${process.platform}\n\n` +
        `The create_d365fo_file tool requires:\n` +
        `1. Running on Windows (local D365FO VM)\n` +
        `2. Direct access to K:\\AosService\\PackagesLocalDirectory\n\n` +
        `This tool CANNOT work through Azure MCP proxy (runs on Linux).\n\n` +
        `Solutions:\n` +
        `- Run MCP server locally on D365FO Windows VM\n` +
        `- Use VS 2022 with local MCP stdio transport\n` +
        `- DO NOT use Azure HTTP proxy for file creation\n`
      );
    }
    
    // Verify drive/root exists before attempting recursive mkdir
    // (Node.js gives a cryptic '\\?' error when the drive letter doesn't exist)
    const driveOrRoot = path.parse(directory).root; // e.g. "K:\" or "C:\"
    if (driveOrRoot) {
      try {
        await fs.access(driveOrRoot);
      } catch {
        throw new Error(
          `❌ Drive or root path does not exist: ${driveOrRoot}\n\n` +
          `Attempting to create: ${directory}\n\n` +
          `The packagePath in your .mcp.json points to a drive that is not accessible.\n` +
          `Update "packagePath" in .mcp.json to match your actual D365FO installation:\n\n` +
          `Common paths:\n` +
          `  C:\\AosService\\PackagesLocalDirectory\n` +
          `  K:\\AosService\\PackagesLocalDirectory\n` +
          `  J:\\AosService\\PackagesLocalDirectory\n\n` +
          `Current packagePath: ${basePath}\n` +
          `Current drive checked: ${driveOrRoot}`
        );
      }
    }

    try {
      await fs.mkdir(directory, { recursive: true });
      console.error(`[create_d365fo_file] Directory ready: ${directory}`);
    } catch (mkdirError) {
      console.error(
        `[create_d365fo_file] Failed to create directory:`,
        mkdirError
      );
      const hint =
        (mkdirError instanceof Error && mkdirError.message.includes('\\?'))
          ? `\n\nHint: The path "${directory}" could not be created. ` +
            `Verify the drive letter exists and the path is correct. ` +
            `Update "packagePath" in .mcp.json to fix this.`
          : '';
      throw new Error(
        `Failed to create directory ${directory}: ${mkdirError instanceof Error ? mkdirError.message : 'Unknown error'}${hint}`
      );
    }

    // Check if file already exists
    try {
      await fs.access(normalizedFullPath);
      return {
        content: [
          {
            type: 'text',
            text: `⚠️ File already exists: ${normalizedFullPath}\n\nPlease choose a different name or delete the existing file first.`,
          },
        ],
      };
    } catch {
      // File doesn't exist, proceed with creation
    }

    // Generate (or use provided) XML content
    let xmlContent = args.xmlContent
      ? args.xmlContent
      : XmlTemplateGenerator.generate(
          args.objectType,
          finalObjectName,
          args.sourceCode,
          args.properties
        );

    // CRITICAL FIX: Replace unprefixed class/table names with prefixed finalObjectName
    // When xmlContent or sourceCode contains `class MyClass` but finalObjectName is `MyPrefixMyClass`,
    // the file would be named MyPrefixMyClass.xml but contain `class MyClass` — inconsistency!
    if (finalObjectName !== args.objectName && (args.xmlContent || args.sourceCode)) {
      // Pattern to match: `class OriginalName` or `public class OriginalName`
      const classPattern = new RegExp(
        `\\b(public\\s+|private\\s+|protected\\s+|internal\\s+|final\\s+)?class\\s+${args.objectName}\\b`,
        'g'
      );
      const replacedContent = xmlContent.replace(classPattern, (match) => {
        return match.replace(args.objectName, finalObjectName);
      });
      
      if (replacedContent !== xmlContent) {
        console.error(
          `[create_d365fo_file] ✅ Fixed class name inconsistency: ` +
          `replaced \`class ${args.objectName}\` with \`class ${finalObjectName}\` in XML content`
        );
        xmlContent = replacedContent;
      }
    }

    // Debug: Log XML content length
    const xmlSource = args.xmlContent ? 'provided by caller' : 'generated from template';
    console.error(
      `[create_d365fo_file] XML content (${xmlSource}): ${xmlContent.length} bytes`
    );
    console.error(
      `[create_d365fo_file] XML preview: ${xmlContent.substring(0, 200)}...`
    );

    // Write file with UTF-8 BOM (required for D365FO XML files)
    try {
      const utf8BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
      const xmlBuffer = Buffer.concat([utf8BOM, Buffer.from(xmlContent, 'utf-8')]);
      await fs.writeFile(normalizedFullPath, xmlBuffer);
      console.error(
        `[create_d365fo_file] File written successfully with UTF-8 BOM: ${normalizedFullPath}`
      );
    } catch (writeError) {
      console.error(`[create_d365fo_file] Failed to write file:`, writeError);
      
      // Check if it's a disk/path issue
      const errorMessage = writeError instanceof Error ? writeError.message : String(writeError);
      if (errorMessage.includes('EINVAL') || errorMessage.includes('ENOENT')) {
        throw new Error(
          `Failed to write file to ${normalizedFullPath}.\n\n` +
          `Possible causes:\n` +
          `1. Drive K:\\ does not exist (running on Linux/Mac? Use packagePath parameter to override)\n` +
          `2. Directory ${path.dirname(normalizedFullPath)} is not accessible\n` +
          `3. Insufficient permissions\n\n` +
          `Original error: ${errorMessage}`
        );
      }
      throw writeError;
    }

    // Verify file was written
    const stats = await fs.stat(normalizedFullPath);
    console.error(
      `[create_d365fo_file] File written: ${normalizedFullPath}, size: ${stats.size} bytes`
    );

    // Add to Visual Studio project if requested
    let projectMessage = '';
    if (args.addToProject) {
      console.error(
        `[create_d365fo_file] addToProject requested, solutionPath: ${solutionPathToUse}, projectPath: ${projectPathToUse}`
      );

      // Try to find project file if not explicitly specified
      // Use projectPathToUse which includes values from .mcp.json config
      let projectPath = projectPathToUse;
      
      if (!projectPath && solutionPathToUse) {
        // Try to find project in solution directory
        // Use solutionPathToUse which includes values from .mcp.json config
        console.error(
          `[create_d365fo_file] Searching for .rnrproj in solution: ${solutionPathToUse}, model: ${actualModelName}`
        );
        const detectedPath = await ProjectFileFinder.findProjectInSolution(
          solutionPathToUse,
          actualModelName
        );

        if (!detectedPath) {
          console.error(
            `[create_d365fo_file] No .rnrproj found in solution directory`
          );
          projectMessage = `\n⚠️ Could not find .rnrproj file for model '${actualModelName}' in solution directory.\n` +
            `Searched in: ${solutionPathToUse}\n` +
            `Please specify projectPath parameter explicitly or add it to .mcp.json.\n`;
        } else {
          console.error(
            `[create_d365fo_file] Found project file: ${detectedPath}`
          );
          projectPath = detectedPath;
        }
      } else if (!projectPath) {
        projectMessage = `\n⚠️ Cannot add to project: projectPath could not be resolved.\n` +
          `Add projectPath to .mcp.json config, or pass it as a tool argument.\n` +
          `Example .mcp.json: { "servers": { "context": { "projectPath": "K:\\\\VSProjects\\\\MySolution\\\\MyModel\\\\MyModel.rnrproj" } } }\n`;
      }

      if (projectPath) {
        try {
          console.error(
            `[create_d365fo_file] Adding to project: ${projectPath}`
          );
          // Validate project file exists
          await fs.access(projectPath);

          // D365FO projects expect ABSOLUTE paths to XML files, not relative
          // The full path must point to the exact XML location in PackagesLocalDirectory
          // Ensure Windows path format with backslashes
          const absoluteXmlPath = normalizedFullPath;

          console.error(
            `[create_d365fo_file] Absolute XML path: ${absoluteXmlPath}`
          );

          // Add to project
          const projectManager = new ProjectFileManager();
          const wasAdded = await projectManager.addToProject(
            projectPath,
            args.objectType,
            finalObjectName,
            absoluteXmlPath
          );

          if (wasAdded) {
            console.error(`[create_d365fo_file] Successfully added to project`);
            projectMessage = `\n✅ Successfully added to Visual Studio project:\n📋 Project: ${projectPath}\n`;
          } else {
            console.error(`[create_d365fo_file] File already exists in project`);
            projectMessage = `\n✅ File already exists in Visual Studio project:\n📋 Project: ${projectPath}\n`;
          }
        } catch (projectError) {
          console.error(
            `[create_d365fo_file] Failed to add to project:`,
            projectError
          );
          projectMessage = `\n⚠️ File created but failed to add to project:\n${projectError instanceof Error ? projectError.message : 'Unknown error'}\n`;
        }
      } else if (!projectMessage) {
        // No projectPath found from any source — surface this in the response so AI and user see it
        projectMessage = `\n⚠️ addToProject=true but no projectPath could be resolved.\n` +
          `The file was created on disk but was NOT added to the Visual Studio project.\n\n` +
          `To fix this, add projectPath to your .mcp.json:\n` +
          `  {\n` +
          `    "servers": { "context": {\n` +
          `      "projectPath": "K:\\\\VSProjects\\\\YourSolution\\\\YourModel\\\\YourModel.rnrproj"\n` +
          `    } }\n` +
          `  }\n` +
          `Until then, add the file manually in Visual Studio: right-click project → Add Existing Item → ${normalizedFullPath}\n`;
      }
    }

    // Build success message
    const nextSteps = args.addToProject
      ? `Next steps:\n` +
        `1. Reload project in Visual Studio (or close/reopen solution)\n` +
        `2. Build the project to synchronize the object\n` +
        `3. Refresh AOT in Visual Studio to see the new object\n`
      : `Next steps:\n` +
        `1. Add the file to your Visual Studio project (.rnrproj)\n` +
        `2. Build the project to synchronize the object\n` +
        `3. Refresh AOT in Visual Studio to see the new object\n`;

    // Return success message with file path
    return {
      content: [
        {
          type: 'text',
          text: `✅ Successfully created D365FO ${args.objectType} file:\n\n` +
            `📁 Path: ${normalizedFullPath}\n` +
            `📄 Object: ${finalObjectName}${finalObjectName !== args.objectName ? ` (prefixed from "${args.objectName}")` : ''}\n` +
            `📦 Model: ${actualModelName}\n` +
            `🔧 Type: ${objectFolder}\n` +
            projectMessage +
            `\n${nextSteps}\n` +
            `⛔ TASK COMPLETE — do NOT call \`generate_smart_table\`, \`generate_smart_form\`, or \`create_d365fo_file\` again for this object.`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error creating D365FO file:\n\n${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
    };
  }
}

export const createD365FileToolDefinition = {
  name: 'create_d365fo_file',
  description:
    'Creates a physical D365FO XML file in the correct AOT package structure. ' +
    'This tool generates the complete XML metadata file for classes, tables, enums, forms, etc. ' +
    'and saves it to the proper location in PackagesLocalDirectory. ' +
    'Use this instead of creating files in the project folder directly.',
  inputSchema: CreateD365FileArgsSchema,
};