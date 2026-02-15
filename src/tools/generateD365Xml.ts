/**
 * D365FO XML Generator Tool
 * Generates D365FO XML content for classes, tables, enums, etc.
 * Returns XML as text - user/Copilot creates the physical file
 * Works remotely through Azure (no file system access needed)
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const GenerateD365XmlArgsSchema = z.object({
  objectType: z
    .enum(['class', 'table', 'enum', 'form', 'query', 'view', 'data-entity'])
    .describe('Type of D365FO object'),
  objectName: z
    .string()
    .describe('Name of the object (e.g., MyHelperClass, MyCustomTable)'),
  modelName: z
    .string()
    .describe('Model name (e.g., ContosoExtensions, ApplicationSuite)'),
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
 * XML Template Generator for D365FO Objects
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
   * Generate AxTable XML structure
   */
  static generateAxTableXml(
    tableName: string,
    properties?: Record<string, any>
  ): string {
    const label = properties?.label || tableName;
    const tableGroup = properties?.tableGroup || 'Main';
    const titleField1 = properties?.titleField1 || '';
    const titleField2 = properties?.titleField2 || '';

    const titleField1Xml = titleField1
      ? `\t<TitleField1>${titleField1}</TitleField1>\n`
      : '';
    const titleField2Xml = titleField2
      ? `\t<TitleField2>${titleField2}</TitleField2>\n`
      : '';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${tableName}</Name>
\t<Label>${label}</Label>
\t<TableGroup>${tableGroup}</TableGroup>
${titleField1Xml}${titleField2Xml}\t<Fields />
\t<Indexes />
\t<Relations />
\t<SourceCode>
\t\t<Methods />
\t</SourceCode>
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
    const isExtensible = properties?.isExtensible ? 'Yes' : 'No';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxEnum xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${enumName}</Name>
\t<Label>${label}</Label>
\t<IsExtensible>${isExtensible}</IsExtensible>
\t<EnumValues />
</AxEnum>
`;
  }

  /**
   * Generate AxForm XML structure
   */
  static generateAxFormXml(
    formName: string,
    properties?: Record<string, any>
  ): string {
    const label = properties?.label || formName;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${formName}</Name>
\t<Label>${label}</Label>
\t<Design />
\t<DataSources />
\t<Methods />
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
    const label = properties?.label || queryName;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxQuery xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${queryName}</Name>
\t<Label>${label}</Label>
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
\t<ViewMetadata />
\t<Fields />
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

    return `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${entityName}</Name>
\t<Label>${label}</Label>
\t<PublicEntityName>${publicEntityName}</PublicEntityName>
\t<DataSources />
\t<Fields />
\t<Keys />
\t<Mappings />
</AxDataEntityView>
`;
  }

  /**
   * Main generate method
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
 * Generate D365FO XML handler function
 */
export async function handleGenerateD365Xml(
  request: CallToolRequest
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const args = GenerateD365XmlArgsSchema.parse(request.params.arguments);

  try {
    console.error(
      `[generate_d365fo_xml] Generating XML for ${args.objectType}: ${args.objectName}, model: ${args.modelName}`
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
    };

    const objectFolder = objectFolderMap[args.objectType];
    if (!objectFolder) {
      throw new Error(`Unsupported object type: ${args.objectType}`);
    }

    // Generate XML content
    const xmlContent = XmlTemplateGenerator.generate(
      args.objectType,
      args.objectName,
      args.sourceCode,
      args.properties
    );

    console.error(
      `[generate_d365fo_xml] Generated XML content: ${xmlContent.length} bytes`
    );

    // Construct recommended file path
    const recommendedPath = `K:\\AosService\\PackagesLocalDirectory\\${args.modelName}\\${args.modelName}\\${objectFolder}\\${args.objectName}.xml`;

    // Return XML content with instructions
    const instructions = `✅ Generated D365FO ${args.objectType} XML for: ${args.objectName}

📋 Model: ${args.modelName}
📁 Recommended path: ${recommendedPath}

⚠️ NEXT STEPS (GitHub Copilot must do this):

1. Create the file using create_file tool with this path:
   ${recommendedPath}

2. Add to Visual Studio project (.rnrproj):
   <Content Include="${recommendedPath.replace(/\\/g, '\\\\')}" />
   
3. Build the project to synchronize with AOT

---

📄 XML Content:

\`\`\`xml
${xmlContent}
\`\`\``;

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
    };
  }
}
