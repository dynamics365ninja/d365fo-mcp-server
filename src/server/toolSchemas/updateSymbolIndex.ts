/**
 * MCP tool definition for `update_symbol_index` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const updateSymbolIndexTool = {
    name: 'update_symbol_index',
    description:
      'Index D365FO XML file(s) changed OUTSIDE this server (hand edit, Visual Studio, git checkout). ' +
      'Do NOT call after d365fo_file create/modify — those refresh the index on their way out, so a follow-up call is a wasted round trip. ' +
      'One genuine same-session case: a brand-new AxEdt/AxEnum you are about to name in a generate_object `fieldsHint`. ' +
      'Omit `filePath` for a bridge/cache refresh only (no symbol-DB indexing).',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: ['string', 'array'], items: { type: 'string' }, description: 'Absolute path to the changed XML file, or an ARRAY — batch them, each call costs a bridge refresh.' },
      },
    },
  };
