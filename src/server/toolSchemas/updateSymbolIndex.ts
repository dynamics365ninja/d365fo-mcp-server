/**
 * MCP tool definition for `update_symbol_index` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const updateSymbolIndexTool = {
    name: 'update_symbol_index',
    // Two facts, and nothing else: what it is FOR (files changed outside this
    // server) and when NOT to call it (after a create/modify, which refresh the
    // index themselves). Both are pinned by tests/utils/toolInventory.test.ts.
    description:
      'Index D365FO XML file(s) changed OUTSIDE this server (hand edit, Visual Studio, git checkout). ' +
      'Do NOT call after d365fo_file create/modify — those refresh the index themselves, so it is a wasted round trip. ' +
      'Omit `filePath` for a bridge/cache refresh only.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: ['string', 'array'], items: { type: 'string' }, description: 'Absolute path to the changed XML file, or an ARRAY — batch them, each call costs a bridge refresh.' },
      },
    },
  };
