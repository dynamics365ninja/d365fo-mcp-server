/**
 * MCP tool definition for `build_d365fo_project` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 *
 * `dbSync` was folded in from the retired `trigger_db_sync` tool, mirroring the
 * `bpCheck` precedent exactly: a sync always follows a successful build, so the
 * knob belongs on the build rather than costing a second round trip and a
 * second published schema. A partial sync with NO rebuild (a modify-only
 * session) stays reachable through the still-routable `trigger_db_sync` name.
 *
 * `deploy` follows the same precedent for UDE, where tests run in the cloud
 * runtime against deployed code: a deployment always follows a successful build.
 * `wait` and `waitTimeoutMs` are kept short because the tool description already
 * says the call blocks until done.
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
        // projectPath is NOT published: it was self-described "(Legacy)" and its
        // only job is deriving a model name that `modelName` states directly.
        // The handler still accepts it.
        force: {
          type: 'boolean',
          description: 'Kill any running build processes for this model and restart.',
        },
        fullBuild: {
          type: 'boolean',
          description: 'Full recompile of TARGET model (not deps). Fixes stale symbols; auto when an entity with OData actions changes.',
        },
        bpCheck: {
          type: 'boolean',
          description: 'On a SUCCESSFUL build, also run the best-practice checker and append its findings. Prefer this to a follow-up run_bp_check call: one build call instead of two round trips.',
        },
        dbSync: {
          type: ['boolean', 'array'],
          items: { type: 'string' },
          description: 'On a SUCCESSFUL build, also run the database sync (SyncEngine.exe) — REQUIRED after any table/view/data-entity change. true = partial sync of the syncable objects in the project, full-model when it has none; an ARRAY syncs exactly those tables/views (much faster). With deploy: full sync in the environment.',
        },
        deploy: {
          type: 'boolean',
          description: 'UDE: on a SUCCESSFUL build, deploy the model\'s package to the cloud runtime that run_systest_class tests run in. No DB sync (~3 min) unless dbSync (~20 min).',
        },
        restartAos: {
          type: 'boolean',
          description: 'After a successful build (+dbSync), restart the local IIS/IIS Express AOS serving aosUrl.',
        },
        aosUrl: {
          type: 'string',
          description: 'restartAos root. Default: Infrastructure.HostUrl in AosService web.config; required on UDE.',
        },
        wait: {
          type: 'boolean',
          description: 'Default true: one call returns the final result. false = legacy fire-and-forget.',
        },
        waitTimeoutMs: {
          type: 'number',
          description: 'Max ms to block (default 30 min) before a "still running" snapshot; the build continues.',
        },
      },
      required: [],
    },
  };
