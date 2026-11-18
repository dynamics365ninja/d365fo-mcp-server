/**
 * MCP tool definition for `run_bp_check` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const runBpCheckTool = {
    name: 'run_bp_check',
    description: 'Run Microsoft Best Practices checker (xppbp.exe) on a D365FO project. Returns BP warnings and errors with rule codes. ' +
      'Runs AFTER a build, not after a write; build_d365fo_project(bpCheck:true) already folds it in, so a separate call is rarely needed.',
    inputSchema: {
      type: 'object',
      properties: {
        objects: {
          type: 'array',
          description: 'Several objects in ONE call, findings grouped per object. An entry "git:<ref>" (e.g. "git:origin/main") checks only objects changed since that ref. Later runs list only findings new since the last run.',
          items: {
            type: 'object',
            properties: {
              objectType: { type: 'string', description: 'class, table, form, enum, view, query, edt, ... Looked up in the symbol index if omitted.' },
              objectName: { type: 'string', description: 'Object name.' },
            },
            required: ['objectName'],
          },
        },
        projectPath: { type: 'string', description: 'Absolute path to the .rnrproj file to analyze. Auto-detected if omitted.' },
        // targetFilter / targetElementType are NOT published: they are the
        // single-object spelling of the objects[] array this schema itself calls
        // "preferred", and were passed 0 times in 273 sampled tool calls. The
        // handler still accepts both, so an agent holding the old spelling gets
        // an answer — only the ~330 chars of advertisement are gone.
        modelName: { type: 'string', description: 'Model name to check. Auto-detected if omitted.' },
        packagePath: { type: 'string', description: 'PackagesLocalDirectory root path. Auto-detected if omitted.' },
      },
      required: [],
    },
  };
