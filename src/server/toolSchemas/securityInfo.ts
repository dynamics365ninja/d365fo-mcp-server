/**
 * MCP tool definition for `security_info` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const securityInfoTool = {
    name: 'security_info',
    description:
      'D365FO security lookup. Choose a `mode`:\n' +
      '• artifact → details + full hierarchy of a named privilege/duty/role (Role → Duties → Privileges → Entry Points).\n' +
      '• coverage → reverse chain for an object: which privileges/duties/roles grant access (object → menu items → privileges → duties → roles).',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          // No description: it restated the two bullets above.
          enum: ['artifact', 'coverage'],
        },
        // mode=artifact
        name: { type: 'string', description: '[artifact] REQUIRED. Name of the security privilege, duty, or role' },
        artifactType: {
          type: 'string',
          enum: ['privilege', 'duty', 'role'],
          description: '[artifact] REQUIRED. Type of security artifact to look up',
        },
        includeChain: { type: 'boolean', description: '[artifact] Walk the full hierarchy (default: true)', default: true },
        // mode=coverage
        objectName: { type: 'string', description: '[coverage] REQUIRED. Name of the form, table, class, or menu item' },
        objectType: {
          type: 'string',
          enum: ['form', 'table', 'class', 'menu-item', 'auto'],
          description: '[coverage] Type of the object (default: auto-detect)',
          default: 'auto',
        },
      },
      required: ['mode'],
    },
  };
