/**
 * MCP tool definition for `validate_object_naming` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const validateObjectNamingTool = {
    name: 'validate_object_naming',
    description: 'Validate a proposed D365FO object name against naming conventions: extension naming, ISV prefix, type-specific suffixes, and conflict detection against the symbol index.',
    inputSchema: {
      type: 'object',
      properties: {
        proposedName: { type: 'string', description: 'The proposed object name to validate' },
        objectType: {
          type: 'string',
          enum: ['class', 'table', 'form', 'enum', 'edt', 'query', 'view', 'report',
            'table-extension', 'class-extension', 'form-extension', 'enum-extension', 'edt-extension',
            'menu-item', 'security-privilege', 'security-duty', 'security-role', 'data-entity'],
          description: 'Type of the D365FO object',
        },
        baseObjectName: {
          type: 'string',
          description: 'Required for extension types: name of the object being extended',
        },
        modelPrefix: {
          type: 'string',
          description: 'Expected ISV/model prefix (2-4 uppercase letters, e.g. "WHS"). Auto-detected if omitted.',
        },
      },
      required: ['proposedName', 'objectType'],
    },
  };
