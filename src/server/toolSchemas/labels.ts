/**
 * MCP tool definition for `labels` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const labelsTool = {
    name: 'labels',
    description:
      'Unified label operations — read and write. Choose an `action`:\n' +
      '• search → full-text query across indexed label files.\n' +
      '• info → all translations for a labelId; without labelId lists label files (with labelFileId: physical .label.txt path per language).\n' +
      '• create → add a new label to an AxLabelFile across every language .label.txt (write). Label IDs describe MEANING — never add a model prefix; target the model\'s ORIGINAL label file, never an …_Extension… file. Pass createIfMissing=true to reuse an existing label instead of reporting it — one call, no search first. Bulk: pass labels:[{labelId, translations}, …] with shared labelFileId/model at top level.\n' +
      '• update → overwrite the text of an EXISTING label; same args as create with corrected translations[] (write).\n' +
      '• rename → rename a label ID across .label.txt + X++ + XML + index. Use dryRun=true first (write).\n' +
      'Write plumbing (paths, languages, sortLabels, allowExtensionLabelFile…) is auto-resolved; ' +
      'override it via get_knowledge(kind="op-spec", topic="labels").',
    inputSchema: {
      type: 'object',
      properties: {
        params: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional write plumbing (packagePath, projectPath, languages, sortLabels, allowExtensionLabelFile, …) — all auto-resolved when omitted. Contract: get_knowledge(kind="op-spec", topic="labels").',
        },
        action: {
          type: 'string',
          enum: ['search', 'info', 'create', 'update', 'rename', 'list', 'list-files'],
          description: 'Label operation to perform. "list"/"list-files" are aliases of "info" (lists label files).',
        },
        // shared filters
        model: {
          type: 'string',
          description: '[search|info|create|update|rename] Model that owns the label file (e.g. ContosoExt).',
        },
        labelFileId: {
          type: 'string',
          description: '[search|info|create|update|rename] AxLabelFile ID (e.g. ContosoExt, SYS). For action=info with no labelId, returns the physical .label.txt path per language. For create/update/rename use the model\'s ORIGINAL label file, not an extension (…_Extension…). For a NEW label file this ID is the MODEL name, never the bare EXTENSION_PREFIX.',
        },
        language: {
          type: 'string',
          description: '[search] Language/locale (default: en-US). Examples: cs, de, sk.',
        },
        maxResults: {
          type: 'number',
          description: '[search] Max labels listed (default 10, alias `limit`); a truncated set reports how many more matched.',
        },
        limit: { type: 'number', description: '[search] Alias of maxResults.' },
        verbose: {
          type: 'boolean',
          description: '[search] Default one line per label; true = full multi-line block.',
        },
        // action=search
        query: {
          type: 'string',
          description: '[search] REQUIRED. Search text — matches label ID, text and developer comment.',
        },
        // action=info
        labelId: {
          type: 'string',
          description: '[info] Exact label ID. Omit for action=info to list available label files for the model.',
        },
        // action=create
        labels: {
          type: 'array',
          description:
            '[create] OPTIONAL bulk mode — create several labels in one call; shared fields (labelFileId, model, languages, paths…) stay at the top level and top-level labelId/translations are ignored. A failed entry does not abort the batch.',
          items: {
            type: 'object',
            properties: {
              labelId: { type: 'string', description: 'Label ID for this entry — alphanumeric, no model prefix.' },
              translations: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    language: { type: 'string', description: 'Locale code, e.g. en-US, cs, de, sk' },
                    text: { type: 'string', description: 'Label text' },
                    comment: { type: 'string', description: 'Developer comment (optional)' },
                  },
                  required: ['language', 'text'],
                },
              },
            },
            required: ['labelId', 'translations'],
          },
        },
        translations: {
          type: 'array',
          description: '[create] REQUIRED for single-label create (omit when using labels[]). Translations for each language. Provide at least en-US.',
          items: {
            type: 'object',
            properties: {
              language: { type: 'string', description: 'Locale code, e.g. en-US, cs, de, sk' },
              text: { type: 'string', description: 'Label text' },
              comment: { type: 'string', description: 'Developer comment (optional)' },
            },
            required: ['language', 'text'],
          },
        },
        oldLabelId: {
          type: 'string',
          description: '[rename] REQUIRED. Current label ID (e.g. MyOldField).',
        },
        newLabelId: {
          type: 'string',
          description: '[rename] REQUIRED. New label ID — must be alphanumeric, no spaces.',
        },
        dryRun: {
          type: 'boolean',
          description: '[rename] Preview changes without writing anything (default: false). Use this first!',
        },
      },
      required: ['action'],
    },
  };
