/**
 * D365FO XML Generator Tool
 * Generates D365FO XML content for classes, tables, enums, etc.
 * Returns XML as text - user/Copilot creates the physical file
 * Works remotely through Azure (no file system access needed)
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { escapeXml } from '../../utils/xmlEscape.js';
import { z } from 'zod';
import { getConfigManager } from '../../utils/configManager.js';

const GenerateD365XmlArgsSchema = z.object({
  objectType: z
    .enum([
      'class', 'table', 'enum', 'form', 'query', 'view', 'data-entity', 'report',
      'edt', 'edt-extension',
      'table-extension', 'form-extension', 'data-entity-extension', 'enum-extension',
      'menu-item-display', 'menu-item-action', 'menu-item-output',
      'menu-item-display-extension', 'menu-item-action-extension', 'menu-item-output-extension',
      'menu', 'menu-extension',
      'security-privilege', 'security-duty', 'security-role',
      'security-duty-extension', 'security-role-extension', 'map',
      'service', 'service-group',
    ])
    .describe('Type of D365FO object'),
  objectName: z
    .string()
    .describe('Name of the object (e.g., MyHelperClass, MyCustomTable)'),
  modelName: z
    .string()
    .optional()
    .describe('Model name (e.g., ContosoExtensions). Auto-detected from mcp.json if omitted.'),
  sourceCode: z
    .string()
    .optional()
    .describe('X++ source code for the object (class declaration, methods, etc.)'),
  properties: z
    .record(z.string(), z.any())
    .optional()
    .describe('Additional properties for the object (extends, implements, label, etc.)'),
});

/**
 * The generate tool used to declare its own XmlTemplateGenerator, advertised as a
 * mirror of createD365File.ts's. It was not one: 26 of the 27 shared methods had
 * diverged. Both now import the single implementation — see
 * ./xmlTemplateGenerator.ts for the list of fixes that never crossed the fork.
 */
import { XmlTemplateGenerator } from './xmlTemplateGenerator.js';
export { XmlTemplateGenerator };

/**
 * Generate D365FO XML handler function
 */
export async function handleGenerateD365Xml(
  request: CallToolRequest
): Promise<any> {
  try {
    const args = GenerateD365XmlArgsSchema.parse(request.params.arguments);

    // Resolve model name: arg → mcp.json modelName → workspacePath segment
    const configManager = getConfigManager();
    const modelName = args.modelName || configManager.getModelName();
    if (!modelName) {
      const errorMsg =
        '❌ ERROR: modelName could not be resolved.\n\n' +
        'Provide it in one of these ways:\n' +
        '  1. Pass modelName explicitly in the tool call arguments\n' +
        '  2. Add modelName to .mcp.json context: { "context": { "modelName": "YourModel" } }\n' +
        '  3. Add workspacePath ending with the package/model name: { "context": { "workspacePath": "K:\\\\...\\\\YourModel" } }';
      return { content: [{ type: 'text', text: errorMsg }], isError: true };
    }

    console.error(
      `[generate_d365fo_xml] Generating XML for ${args.objectType}: ${args.objectName}, model: ${modelName}`
    );

    // Determine object folder based on type
    const objectFolderMap: Record<string, string> = {
      class: 'AxClass',
      table: 'AxTable',
      enum: 'AxEnum',
      form: 'AxForm',
      query: 'AxQuery',
      view: 'AxView',
      'data-entity': 'AxDataEntityView',
      report: 'AxReport',
      edt: 'AxEdt',
      'edt-extension': 'AxEdtExtension',
      'table-extension': 'AxTableExtension',
      'form-extension': 'AxFormExtension',
      'data-entity-extension': 'AxDataEntityViewExtension',
      'enum-extension': 'AxEnumExtension',
      'menu-item-display': 'AxMenuItemDisplay',
      'menu-item-action': 'AxMenuItemAction',
      'menu-item-output': 'AxMenuItemOutput',
      'menu-item-display-extension': 'AxMenuItemDisplayExtension',
      'menu-item-action-extension': 'AxMenuItemActionExtension',
      'menu-item-output-extension': 'AxMenuItemOutputExtension',
      menu: 'AxMenu',
      'menu-extension': 'AxMenuExtension',
      'security-privilege': 'AxSecurityPrivilege',
      'security-duty': 'AxSecurityDuty',
      'security-role': 'AxSecurityRole',
      'security-duty-extension': 'AxSecurityDutyExtension',
      'security-role-extension': 'AxSecurityRoleExtension',
      map: 'AxMap',
      service: 'AxService',
      'service-group': 'AxServiceGroup',
    };

    const objectFolder = objectFolderMap[args.objectType];
    if (!objectFolder) {
      throw new Error(`Unsupported object type: ${args.objectType}`);
    }

    // Generate XML content
    let xmlContent = XmlTemplateGenerator.generate(
      args.objectType,
      args.objectName,
      args.sourceCode,
      args.properties
    );

    // For reports: convert any remaining CDATA <Text> to entity-encoded form.
    // The generator now emits entity-encoded directly, but guard against xmlContent
    // passed in pre-generated form with CDATA.
    if (args.objectType === 'report') {
      xmlContent = xmlContent.replace(
        /<Text><!\[CDATA\[([\s\S]*?)\]\]><\/Text>/g,
        (_m, inner: string) => `<Text>${escapeXml(inner)}</Text>`
      );
    }

    console.error(
      `[generate_d365fo_xml] Generated XML content: ${xmlContent.length} bytes`
    );

    // Construct recommended file path
    const recommendedPath = `K:\\AosService\\PackagesLocalDirectory\\${modelName}\\${modelName}\\${objectFolder}\\${args.objectName}.xml`;

    // Return XML content with instructions
    const instructions = `✅ Generated D365FO ${args.objectType} XML for: ${args.objectName}

📋 Model: ${modelName}
📁 Recommended path: ${recommendedPath}

⚠️ CRITICAL NEXT STEPS (GitHub Copilot MUST do this):

1. **Create the file** using create_file tool:
   - Path: ${recommendedPath}
   - Content: Use the XML content below (between xml markers)
   - ⚠️ IMPORTANT: D365FO requires UTF-8 with BOM encoding!
   - VS Code create_file uses UTF-8 without BOM by default, which may cause "unicode substitution character" errors

2. **If you see encoding errors**, manually add UTF-8 BOM:
   - Open file in hex editor
   - Ensure first 3 bytes are: EF BB BF (UTF-8 BOM)
   - Or use d365fo_file(action="create") tool instead (if MCP server runs on local Windows)

3. **Add to Visual Studio project** (.rnrproj):
   <Content Include="${recommendedPath.replace(/\\/g, '\\\\')}" />
   
4. **Build the project** to synchronize with AOT

---

📄 XML Content (copy exactly, do not modify):

\`\`\`xml
${xmlContent}
\`\`\`

---

💡 **Alternative:** If MCP server runs on local Windows, use \`d365fo_file(action="create")\` tool instead - it handles UTF-8 BOM automatically and adds to VS project.`;

    return {
      content: [
        {
          type: 'text',
          text: instructions,
        },
      ],
    };
  } catch (error) {
    console.error(`[generate_d365fo_xml] Error:`, error);
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error generating D365FO XML:\n\n${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
