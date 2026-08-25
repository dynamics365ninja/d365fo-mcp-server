/**
 * MCP tool definition for `verify_d365fo_project` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const verifyD365foProjectTool = {
    name: 'verify_d365fo_project',
    description:
      'Verify that D365FO objects exist on disk at the correct AOT path and are referenced in the .rnrproj project file. Use instead of PowerShell. ' +
      'Runs AFTER a build, not after a write: d365fo_file already verifies its own write inline (on disk + .rnrproj reference) and says so in its response. ' +
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
        // packageName / packagePath are NOT published: both are auto-resolved
        // plumbing (from modelName and from the detected PackagesLocalDirectory),
        // the same trade `labels` and `get_knowledge` already made for their
        // resolution overrides. The handler still accepts both.
      },
    },
  };
