/**
 * MCP tool definition for `run_bp_check` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const runBpCheckTool = {
    name: 'run_bp_check',
    description: 'Run Microsoft Best Practices checker (xppbp.exe) on a D365FO project. Returns BP warnings and errors with rule codes (e.g. BPErrorLabelIsText, BPXmlDocNoDocumentationComments).',
    inputSchema: {
      type: 'object',
      properties: {
        objects: {
          type: 'array',
          description: 'Check several objects in ONE call — preferred over targetFilter. Shared preamble is printed once and findings are grouped per object.',
          items: {
            type: 'object',
            properties: {
              objectType: { type: 'string', description: 'class, table, form, enum, view, query, edt, ... Looked up in the symbol index if omitted.' },
              objectName: { type: 'string', description: 'Object name.' },
            },
            required: ['objectName'],
          },
        },
        projectPath: { type: 'string', description: 'Absolute path to the .rnrproj file to analyze. Auto-detected from .mcp.json if omitted.' },
        targetFilter: { type: 'string', description: 'Single-object form: object name to check. Use objects[] for more than one.' },
        targetElementType: { type: 'string', description: 'Element type for targetFilter. Looked up in the symbol index if omitted; ambiguous or unknown names error rather than being assumed to be a class.' },
        modelName: { type: 'string', description: 'Model name to check. Auto-detected from .mcp.json if omitted.' },
        packagePath: { type: 'string', description: 'PackagesLocalDirectory root path. Auto-detected from .mcp.json if omitted.' },
      },
      required: [],
    },
  };
