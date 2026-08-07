/**
 * MCP tool definition for `get_workspace_info` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const getWorkspaceInfoTool = {
    name: 'get_workspace_info',
    description: `ALWAYS call FIRST at session start. Returns model name, package path, framework directory, project path, environment type, and EXTENSION_PREFIX. Flags placeholder model names and missing prefix. projectName/projectPath ONLY when the USER changed project. This is the authoritative source for target model — not search results.`,
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Only when the USER says "switch to <project>". Just the model name, e.g. "ContosoEDS"; path resolved from D365FO_SOLUTIONS_PATH. NOT a way to reach another model — reads span every model already, writes stay in the workspace model.',
        },
        projectPath: {
          type: 'string',
          description: 'Absolute path to a .rnrproj file. Fallback when projectName is ambiguous or D365FO_SOLUTIONS_PATH is not configured. Example: "K:\\\\repos\\\\Contoso\\\\MyProject\\\\MyProject.rnrproj"',
        },
        diagnostics: {
          type: 'boolean',
          default: false,
          description: 'Include verbose sections (config sources, suffix, project paths, index scan, stdio handshake). Use when debugging config or connectivity.',
        },
      },
      required: [],
    },
  };
