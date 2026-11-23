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
      '• list → page one label file\'s labels; idPrefix/comment/missingLanguage/offset go in params.\n' +
      '• create → add a label to an AxLabelFile across every language .label.txt (write). ALWAYS pass createIfMissing=true: it creates when absent and reuses when present, so this ONE call replaces search-then-create. Bulk: labels:[{labelId, translations}, …] with shared labelFileId/model at top level does a whole object in one call. Label IDs describe MEANING — never a model prefix; target the model\'s ORIGINAL label file, never an …_Extension… one.\n' +
      '• update → overwrite the text of an EXISTING label; same args as create with corrected translations[] (write).\n' +
      '• rename → rename a label ID across .label.txt + X++ + XML + index. Use dryRun=true first (write).\n' +
      'Write plumbing (paths, languages, sortLabels…) is auto-resolved; ' +
      'overrides and list filters: get_knowledge(kind="op-spec", topic="labels").',
    inputSchema: {
      type: 'object',
      properties: {
        params: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional overrides / list filters (see op-spec).',
        },
        // No description: the five bullets above already say what each value does,
        // and restating it here was ~45 chars of the payload per session.
        action: {
          type: 'string',
          enum: ['search', 'info', 'list', 'create', 'update', 'rename', 'delete'],
        },
        // shared filters
        model: {
          type: 'string',
          description: '[search|info|list|create|update|rename] Model owning the label file.',
        },
        labelFileId: {
          type: 'string',
          description: '[search|info|list|create|update|rename] AxLabelFile ID (e.g. ContosoExt, SYS). New file: ID = MODEL name, never EXTENSION_PREFIX.',
        },
        language: {
          type: 'string',
          description: '[search|list] Language/locale (default en-US), e.g. cs, de, sk, fi.',
        },
        maxResults: {
          type: 'number',
          description: '[search|list] Page size (search 10, list 50); reports how many more matched.',
        },
        verbose: {
          type: 'boolean',
          description: '[search|list] true = full block (list: all languages).',
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
            '[info|delete] Label ID, any spelling: SYS67433, @SYS67433, @ContosoExt:MyLabel ' +
            '(paste search output). labelFileId/model optional. Omit to list label files.',
        },
        // action=create
        labels: {
          type: 'array',
          description:
            '[create|update] Bulk mode — shared fields stay at the top level (top-level labelId/translations are then ignored); a failed entry does not abort the batch.',
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
          description: '[create] REQUIRED for single-label create (omit with labels[]). Translations for each language. Provide at least en-US.',
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
