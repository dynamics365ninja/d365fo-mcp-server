/**
 * MCP tool definition for `get_workspace_info` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const getWorkspaceInfoTool = {
    name: 'get_workspace_info',
    description: `ALWAYS call FIRST at session start. Returns model name, package path, framework directory, project path, environment type, and EXTENSION_PREFIX. Flags placeholder model names and missing prefix. Pass projectName/projectPath whenever you already know the target project. Authoritative source for target model — not search results.`,
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Set when the USER named the project, or you already know it from context — only changes where WRITES land, not reads: reads span every model already. The PROJECT file name, e.g. "Contoso - FeatureManagement". NOT a model name: naming one selects none.',
        },
        projectPath: {
          type: 'string',
          description: 'Absolute path to a .rnrproj file. Use when projectName is ambiguous or none was selected. Example: "K:\\\\repos\\\\Contoso\\\\MyProject\\\\MyProject.rnrproj"',
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
