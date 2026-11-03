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
    // `model` paid for itself: the wording around it was tightened so the
    // payload grew by less than the parameter costs on its own.
    description:
      'Index D365FO XML changed OUTSIDE this server (VS, hand edit, git pull). ' +
      'Do NOT call after d365fo_file create/modify — they re-index already. ' +
      'No args = bridge/cache refresh only.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: ['string', 'array'], items: { type: 'string' }, description: 'Absolute XML path, or an ARRAY — batch them (one bridge refresh per call).' },
        model: { type: 'string', description: 'Custom model: re-index all its changed, new and deleted files.' },
      },
    },
  };
