/**
 * MCP tool definition for `verify_d365fo_project` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const verifyD365foProjectTool = {
    name: 'verify_d365fo_project',
    description:
      'Verify that D365FO objects exist on disk at the correct AOT path and are referenced in the .rnrproj project file. Use instead of PowerShell to check d365fo_file(action="create") results. ' +
      'Omit `objects` to verify the ENTIRE project: every object referenced in the .rnrproj is checked on disk (requires projectPath, or an auto-detected/configured project).',
    inputSchema: {
      type: 'object',
      properties: {
        objects: {
          type: 'array',
          description: 'List of objects to verify. OPTIONAL — omit to verify every object referenced in the project (.rnrproj).',
          items: {
            type: 'object',
            properties: {
              objectType: {
                type: 'string',
                enum: ['class', 'table', 'enum', 'form', 'query', 'view', 'data-entity', 'report',
                  'edt', 'edt-extension', 'table-extension', 'form-extension', 'data-entity-extension',
                  'enum-extension', 'menu-item-display', 'menu-item-action', 'menu-item-output',
                  'menu-item-display-extension', 'menu-item-action-extension', 'menu-item-output-extension',
                  'menu', 'menu-extension', 'security-privilege', 'security-duty', 'security-role'],
                description: 'Type of D365FO object',
              },
              objectName: { type: 'string', description: 'Name of the object' },
            },
            required: ['objectType', 'objectName'],
          },
        },
        projectPath: {
          type: 'string',
          description: 'Absolute path to the .rnrproj file. Required for project-reference check.',
        },
        modelName: {
          type: 'string',
          description: 'Model name. Auto-detected if omitted.',
        },
        packageName: { type: 'string', description: 'Package name. Auto-resolved from model name if omitted.' },
        packagePath: { type: 'string', description: 'Base package path (default: auto-detected PackagesLocalDirectory)' },
      },
    },
  };
