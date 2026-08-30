/**
 * MCP tool definition for `labels` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const labelsTool = {
    name: 'labels',
    description:
      'Unified label operations — read and write. Writing an object? d365fo_file create/modify already turn a raw-text label/fieldLabel into a real @Ref by themselves; no call here is needed. Choose an `action`:\n' +
      '• search → full-text query across indexed label files. Never needed before a create.\n' +
      '• info → all translations for a labelId; without labelId lists label files (with labelFileId: physical .label.txt path per language).\n' +
      '• create → add a label to an AxLabelFile across every language .label.txt (write). ALWAYS pass createIfMissing=true: it creates when absent and reuses when present, so this ONE call replaces search-then-create. Bulk: labels:[{labelId, translations}, …] with shared labelFileId/model at top level does a whole object in one call. Label IDs describe MEANING — never a model prefix; target the model\'s ORIGINAL label file, never an …_Extension… one.\n' +
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
          description: 'Optional write plumbing — the auto-resolved overrides named at the end of the description above.',
        },
        // No description: the five bullets above already say what each value does,
        // and restating it here was ~45 chars of the payload per session.
        action: {
          type: 'string',
          enum: ['search', 'info', 'create', 'update', 'rename'],
        },
        // shared filters
        model: {
          type: 'string',
          description: '[search|info|create|update|rename] Model that owns the label file (e.g. ContosoExt).',
        },
        labelFileId: {
          type: 'string',
          description: '[search|info|create|update|rename] AxLabelFile ID (e.g. ContosoExt, SYS). For a NEW label file this ID is the MODEL name, never the bare EXTENSION_PREFIX.',
        },
        language: {
          type: 'string',
          description: '[search] Language/locale (default: en-US). Examples: cs, de, sk.',
        },
        maxResults: {
          type: 'number',
          description: '[search] Max labels listed (default 10); a truncated set reports how many more matched.',
        },
        verbose: {
          type: 'boolean',
          description: '[search] Default one line per label; true = full multi-line block.',
        },
        // action=search
        query: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description: '[search] REQUIRED. Search text — matches label ID, text and developer comment. ARRAY = try several phrasings in ONE call.',
        },
        // action=info
        labelId: {
          type: 'string',
          description:
            '[info] Label ID, any spelling: SYS67433, @SYS67433, @ContosoExt:MyLabel ' +
            '(paste search output). labelFileId/model optional. Omit to list label files.',
        },
        // action=create
        labels: {
          type: 'array',
          description:
            '[create] Bulk mode — shared fields stay at the top level (top-level labelId/translations are then ignored); a failed entry does not abort the batch.',
          items: {
            type: 'object',
            properties: {
              labelId: { type: 'string' },
              translations: { type: 'array', items: { type: 'object' } },
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
              text: { type: 'string' },
              comment: { type: 'string' },
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
          description: '[rename] REQUIRED. New label ID.',
        },
        dryRun: {
          type: 'boolean',
          description: '[rename] Preview changes without writing anything.',
        },
      },
      required: ['action'],
    },
  };
