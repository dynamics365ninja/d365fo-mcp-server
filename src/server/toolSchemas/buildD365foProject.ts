/**
 * MCP tool definition for `build_d365fo_project` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const buildD365foProjectTool = {
    name: 'build_d365fo_project',
    description:
      'Build a D365FO model with xppc.exe (compiles the ENTIRE model, not one project). ' +
      'Blocks until done — call ONCE per build, do NOT poll (wait:false = legacy polling mode). ' +
      'fullBuild:true fixes "not been successfully compiled since it was last changed" stale-symbol errors.',
    inputSchema: {
      type: 'object',
      properties: {
        modelName: {
          type: 'string',
          description: 'D365FO model name to build (e.g. MyCustomModel). Auto-detected from workspace if omitted.',
        },
        projectPath: {
          type: 'string',
          description: '(Legacy) Absolute path to a .rnrproj file — used only to extract the model name when modelName is not provided.',
        },
        force: {
          type: 'boolean',
          description: 'Kill any running build processes for this model and restart.',
        },
        fullBuild: {
          type: 'boolean',
          description: 'Full recompile of the TARGET model only (deps stay incremental). Use when xppc reports stale symbol errors.',
        },
        buildReferencedModels: {
          type: 'boolean',
          description: 'DISABLED — always ignored. Rebuilding dependency models on every build slows the run down and referenced models are expected to already be compiled.',
        },
        wait: {
          type: 'boolean',
          description: 'When true (default) the tool blocks until the build finishes and returns the final result in a single call. The agent should make exactly one call per requested build. Set false for legacy fire-and-forget polling behaviour.',
        },
        waitTimeoutMs: {
          type: 'number',
          description: 'Maximum time (ms) to block when wait:true before returning a "still running" snapshot. Defaults to 30 minutes. The build itself continues in the background.',
        },
      },
      required: [],
    },
  };
