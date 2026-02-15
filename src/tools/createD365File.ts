/**
 * D365FO File Creator Tool
 * Creates physical XML files in the AOT package structure
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Parser, Builder } from 'xml2js';

const CreateD365FileArgsSchema = z.object({
  objectType: z
    .enum(['class', 'table', 'enum', 'form', 'query', 'view', 'data-entity'])
    .describe('Type of D365FO object to create'),
  objectName: z
    .string()
    .describe('Name of the object (e.g., MyHelperClass, MyCustomTable)'),
  modelName: z
    .string()
    .describe('Model name (e.g., ContosoExtensions, ApplicationSuite)'),
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
    .default(false)
    .describe('Whether to automatically add file to Visual Studio project'),
  projectPath: z
    .string()
    .optional()
    .describe('Path to .rnrproj file (if not specified, will try to find in solutionPath)'),
  solutionPath: z
    .string()
    .optional()
    .describe('Path to active VS solution directory (e.g., from GitHub Copilot context)'),
});

/**
 * Project File Finder
 * Finds .rnrproj files in solution directory or specific paths
 */
class ProjectFileFinder {
  /**
   * Find .rnrproj file in solution directory
   * Recursively searches for .rnrproj files matching the model name
   */
  static async findProjectInSolution(
    solutionPath: string,
    modelName: string
  ): Promise<string | null> {
    try {
      // Check if solution directory exists
      try {
        await fs.access(solutionPath);
      } catch {
        return null;
      }

      // Read all files in solution directory (non-recursive first)
      const files = await fs.readdir(solutionPath);
      
      // Find .rnrproj files that might match the model
      const projectFiles = files.filter(file => 
        file.endsWith('.rnrproj') && 
        (file.includes(modelName) || file === `${modelName}.rnrproj`)
      );
      
      if (projectFiles.length > 0) {
        return path.join(solutionPath, projectFiles[0]);
      }

      // If not found, try subdirectories (one level deep)
      for (const file of files) {
        const fullPath = path.join(solutionPath, file);
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isDirectory()) {
            const subFiles = await fs.readdir(fullPath);
            const subProjectFiles = subFiles.filter(subFile => 
              subFile.endsWith('.rnrproj') && 
              (subFile.includes(modelName) || subFile === `${modelName}.rnrproj`)
            );
            
            if (subProjectFiles.length > 0) {
              return path.join(fullPath, subProjectFiles[0]);
            }
          }
        } catch {
          // Skip inaccessible directories
          continue;
        }
      }

      return null;
    } catch {
      return null;
    }
  }
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

    return `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${tableName}</Name>
\t<SourceCode>
\t\t<Methods />
\t</SourceCode>
${configKeyXml}\t<Label>${label}</Label>
\t<TableGroup>${tableGroup}</TableGroup>
\t<TitleField1>${titleField1}</TitleField1>
\t<TitleField2>${titleField2}</TitleField2>
${cacheLookupXml}${primaryIndexXml}\t<DeleteActions />
\t<FieldGroups />
\t<Fields />
\t<Indexes />
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
      case 'table':
        return this.generateAxTableXml(objectName, properties);
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
class ProjectFileManager {
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
   * Get folder name for object type in project
   */
  private getFolderName(objectType: string): string {
    const folderMap: Record<string, string> = {
      class: 'Classes',
      table: 'Tables',
      enum: 'Enums',
      form: 'Forms',
      query: 'Queries',
      view: 'Views',
      'data-entity': 'Data Entities',
    };
    return folderMap[objectType] || 'Classes';
  }

  /**
   * Add file reference to Visual Studio project
   * D365FO projects use ABSOLUTE paths to XML files in PackagesLocalDirectory
   */
  async addToProject(
    projectPath: string,
    objectType: string,
    objectName: string,
    absoluteXmlPath: string
  ): Promise<void> {
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

    // Get folder name for project organization
    const folderName = this.getFolderName(objectType);

    // Add folder if not exists
    const folderExists = folderGroup.Folder.some(
      (folder: any) =>
        folder.$ && folder.$.Include === `${folderName}\\`
    );
    if (!folderExists) {
      folderGroup.Folder.push({
        $: { Include: `${folderName}\\` },
      });
    }

    // Normalize path separators to backslash for Windows
    const normalizedPath = absoluteXmlPath.replace(/\//g, '\\');

    // Check if file already in project (check both normalized and original path)
    const fileExists = contentGroup.Content.some(
      (content: any) =>
        content.$ && (
          content.$.Include === normalizedPath ||
          content.$.Include === absoluteXmlPath
        )
    );

    if (fileExists) {
      throw new Error(`File ${objectName} is already in the project`);
    }

    // Add file reference with ABSOLUTE path (D365FO standard)
    // The Include attribute must contain the full path to the XML file
    contentGroup.Content.push({
      $: { Include: normalizedPath },
      SubType: 'Content',
      Name: objectName,
      Link: `${folderName}\\${objectName}.xml`,
    });

    console.error(
      `[ProjectFileManager] Added file reference to project, Content items: ${contentGroup.Content.length}`
    );

    // Write back to project file
    const updatedXml = this.builder.buildObject(project);
    await fs.writeFile(projectPath, updatedXml, 'utf-8');

    console.error(`[ProjectFileManager] Project file saved successfully`);
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

    // Construct full path
    const basePath =
      args.packagePath || 'K:\\AosService\\PackagesLocalDirectory';
    const modelPath = path.join(
      basePath,
      args.modelName,
      args.modelName,
      objectFolder
    );
    const fileName = `${args.objectName}.xml`;
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
    
    try {
      await fs.mkdir(directory, { recursive: true });
      console.error(`[create_d365fo_file] Directory ready: ${directory}`);
    } catch (mkdirError) {
      console.error(
        `[create_d365fo_file] Failed to create directory:`,
        mkdirError
      );
      throw new Error(
        `Failed to create directory ${directory}: ${mkdirError instanceof Error ? mkdirError.message : 'Unknown error'}`
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

    // Generate XML content
    const xmlContent = XmlTemplateGenerator.generate(
      args.objectType,
      args.objectName,
      args.sourceCode,
      args.properties
    );

    // Debug: Log XML content length
    console.error(
      `[create_d365fo_file] Generated XML content: ${xmlContent.length} bytes`
    );
    console.error(
      `[create_d365fo_file] XML preview: ${xmlContent.substring(0, 200)}...`
    );

    // Write file
    try {
      await fs.writeFile(normalizedFullPath, xmlContent, 'utf-8');
      console.error(
        `[create_d365fo_file] File written successfully: ${normalizedFullPath}`
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
        `[create_d365fo_file] addToProject requested, solutionPath: ${args.solutionPath}, projectPath: ${args.projectPath}`
      );

      // Try to find project file if not explicitly specified
      let projectPath = args.projectPath;
      
      if (!projectPath && args.solutionPath) {
        // Try to find project in solution directory
        console.error(
          `[create_d365fo_file] Searching for .rnrproj in solution: ${args.solutionPath}, model: ${args.modelName}`
        );
        const detectedPath = await ProjectFileFinder.findProjectInSolution(
          args.solutionPath,
          args.modelName
        );

        if (!detectedPath) {
          console.error(
            `[create_d365fo_file] No .rnrproj found in solution directory`
          );
          projectMessage = `\n⚠️ Could not find .rnrproj file for model '${args.modelName}' in solution directory.\n` +
            `Searched in: ${args.solutionPath}\n` +
            `Please specify projectPath parameter explicitly.\n`;
        } else {
          console.error(
            `[create_d365fo_file] Found project file: ${detectedPath}`
          );
          projectPath = detectedPath;
        }
      } else if (!projectPath) {
        projectMessage = `\n⚠️ Cannot add to project: either projectPath or solutionPath must be specified.\n` +
          `Tip: GitHub Copilot can provide solutionPath from active VS solution context.\n`;
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
          await projectManager.addToProject(
            projectPath,
            args.objectType,
            args.objectName,
            absoluteXmlPath
          );

          console.error(`[create_d365fo_file] Successfully added to project`);
          projectMessage = `\n✅ Successfully added to Visual Studio project:\n📋 Project: ${projectPath}\n`;
        } catch (projectError) {
          console.error(
            `[create_d365fo_file] Failed to add to project:`,
            projectError
          );
          projectMessage = `\n⚠️ File created but failed to add to project:\n${projectError instanceof Error ? projectError.message : 'Unknown error'}\n`;
        }
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
            `📄 Object: ${args.objectName}\n` +
            `📦 Model: ${args.modelName}\n` +
            `🔧 Type: ${objectFolder}\n` +
            projectMessage +
            `\n${nextSteps}\n` +
            `File content preview:\n\`\`\`xml\n${xmlContent.substring(0, 500)}...\n\`\`\``,
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
