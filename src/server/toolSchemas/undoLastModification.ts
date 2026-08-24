/**
 * MCP tool definition for `undo_last_modification` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const undoLastModificationTool = {
    name: 'undo_last_modification',
    description: 'Roll back a file. Tracked by git -> git checkout HEAD, which discards ALL uncommitted changes to it, not just the last edit. Untracked -> deletes it. Also re-syncs the symbol/label index, which a manual git revert or editor undo would leave stale.\n\n⚠️ Local companion tool: write-only/local mode (Windows VM) only.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the file to restore to HEAD (or delete, if untracked)' },
      },
      required: ['filePath'],
    },
  };
