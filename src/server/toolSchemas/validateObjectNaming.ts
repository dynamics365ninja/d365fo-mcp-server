/**
 * MCP tool definition for `validate_object_naming` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const validateObjectNamingTool = {
    name: 'validate_object_naming',
    description: 'Validate a proposed D365FO object name: extension naming/formats, ISV prefix, type suffixes, conflicts in the symbol index.',
    inputSchema: {
      type: 'object',
      properties: {
        proposedName: { type: 'string', description: 'The proposed object name to validate' },
        objectType: {
          type: 'string',
          enum: ['class', 'table', 'form', 'enum', 'edt', 'query', 'view', 'report',
            'table-extension', 'class-extension', 'form-extension', 'enum-extension', 'edt-extension',
            'menu-item', 'security-privilege', 'security-duty', 'security-role', 'data-entity'],
        },
        baseObjectName: {
          type: 'string',
          description: 'Extension types: the object being extended',
        },
        baseObjectType: {
          type: 'string',
          description: 'class-extension: its type (class|table|form|…); picks the name format',
        },
        modelPrefix: {
          type: 'string',
          description: 'ISV/model prefix (e.g. "WHS"); auto-detected if omitted.',
        },
      },
      required: ['proposedName', 'objectType'],
    },
  };
