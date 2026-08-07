/**
 * MCP tool definition for `update_symbol_index` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const updateSymbolIndexTool = {
    name: 'update_symbol_index',
    description:
      'Index a newly generated or modified D365FO XML file immediately so references to it work without restarting the server. ' +
      'Call this after d365fo_file(action="create") — pass the created file\'s `filePath` — to make the new object instantly searchable AND, for new AxEnum/AxEdt files, resolvable by scaffolding (so enum fields become AxTableFieldEnum and EDT fields get the correct base type). ' +
      'Call WITHOUT `filePath` for a lightweight refresh: it refreshes the C# bridge provider and drops workspace caches so objects created via the bridge this session become resolvable (does NOT fully index them into the symbol DB).',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: ['string', 'array'], items: { type: 'string' }, description: 'Absolute path to the modified or created XML file (e.g. K:\\\\AosService\\\\PackagesLocalDirectory\\\\MyModel\\\\MyModel\\\\AxClass\\\\MyClass.xml), or an ARRAY — batch them, each call costs a bridge refresh.' },
      },
    },
  };
