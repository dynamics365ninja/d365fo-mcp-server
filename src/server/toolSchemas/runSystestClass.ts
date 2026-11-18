/**
 * MCP tool definition for `run_systest_class` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const runSystestClassTool = {
    name: 'run_systest_class',
    description: 'Run D365FO unit test classes (SysTestConsole; UDE: cloud runtime), with per-method results.',
    inputSchema: {
      type: 'object',
      properties: {
        className: { type: 'string', description: 'SysTest class, e.g. "MyModuleTest". UDE: several of one model, comma-separated, in one run' },
        modelName: { type: 'string', description: 'The model containing the test class. Auto-detected if omitted.' },
        packagePath: { type: 'string', description: 'PackagesLocalDirectory root path. Auto-detected if omitted.' },
        testMethod: { type: 'string', description: 'Optional: run only this specific test method within the class (e.g. "testValidation").' },
      },
      required: ['className'],
    },
  };
