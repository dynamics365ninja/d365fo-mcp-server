/**
 * MCP tool definition for `labels` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const labelsTool = {
    name: 'labels',
    description:
      'Unified label operations — read and write. Choose an `action`:\n' +
      '• search → full-text query across indexed label files. Always run before action=create.\n' +
      '• info → all translations for a labelId; without labelId lists label files (with labelFileId: physical .label.txt path per language).\n' +
      '• create → add a new label to an AxLabelFile across every language .label.txt (write). Label IDs describe MEANING — never add a model prefix; target the model\'s ORIGINAL label file, never an …_Extension… file. Fails if the label exists. Bulk: pass labels:[{labelId, translations}, …] with shared labelFileId/model at top level.\n' +
      '• update → overwrite the text of an EXISTING label; same args as create with corrected translations[] (write).\n' +
      '• rename → rename a label ID across .label.txt + X++ + XML + index. Use dryRun=true first (write).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'info', 'create', 'update', 'rename', 'list', 'list-files'],
          description: 'Label operation to perform. "list"/"list-files" are aliases of "info" (lists label files).',
        },
        // ── shared filters ─────────────────────────────────────────────
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
        limit: {
          type: 'number',
          description: '[search] Maximum number of results (default 30).',
        },
        // ── action=search ──────────────────────────────────────────────
        query: {
          type: 'string',
          description: '[search] REQUIRED. Search text — matches label ID, text and developer comment.',
        },
        // ── action=info ────────────────────────────────────────────────
        labelId: {
          type: 'string',
          description: '[info] Exact label ID. Omit for action=info to list available label files for the model.',
        },
        // ── action=create ──────────────────────────────────────────────
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
        defaultComment: {
          type: 'string',
          description: '[create] Developer comment for languages without explicit comment.',
        },
        description: {
          type: 'string',
          description:
            '[create] Label description (comment line in .label.txt). Defaults to VS project name from .rnrproj when omitted, then falls back to labelFileId. ' +
            'Per-translation comment and defaultComment take priority.',
        },
        packageName: {
          type: 'string',
          description: '[create|rename] Package name for the model. Auto-resolved if omitted.',
        },
        packagePath: {
          type: 'string',
          description: '[create|rename] Root packages path. Auto-detected from environment config if omitted.',
        },
        projectPath: {
          type: 'string',
          description: '[create] Path to the .rnrproj project file. Auto-detected from .mcp.json if omitted.',
        },
        solutionPath: {
          type: 'string',
          description: '[create] Path to the .sln solution directory. Fallback to find .rnrproj if projectPath is not set.',
        },
        addToProject: {
          type: 'boolean',
          description: '[create] Add label file XML descriptors to the VS project (default: true).',
        },
        createLabelFileIfMissing: {
          type: 'boolean',
          description: '[create] Create the AxLabelFile structure if missing (default: true). A wrong-path guard still fails loudly when the model directory is not found, so no phantom file is produced. Set false to fail fast instead.',
        },
        sortLabels: {
          type: 'boolean',
          description: '[create] Sort labels alphabetically in .label.txt (default true, from LABEL_SORT_ORDER env; false = append at end).',
        },
        languages: {
          type: 'array',
          items: { type: 'string' },
          description: '[create] Restrict which language .label.txt files are written (e.g. ["en-US"]). Omitted = every language folder present in the model.',
        },
        // ── action=rename ──────────────────────────────────────────────
        oldLabelId: {
          type: 'string',
          description: '[rename] REQUIRED. Current label ID (e.g. MyOldField).',
        },
        newLabelId: {
          type: 'string',
          description: '[rename] REQUIRED. New label ID — must be alphanumeric, no spaces.',
        },
        searchPaths: {
          type: 'array',
          items: { type: 'string' },
          description: '[rename] Additional absolute directory paths to scan for X++ / XML references.',
        },
        dryRun: {
          type: 'boolean',
          description: '[rename] Preview changes without writing anything (default: false). Use this first!',
        },
        // ── shared write knob ──────────────────────────────────────────
        updateIndex: {
          type: 'boolean',
          description: '[create|rename] Update the MCP label index after writing (default: true).',
        },
        allowExtensionLabelFile: {
          type: 'boolean',
          description: '[create|rename] Allow writing to a label file EXTENSION ("_Extension" marker). Default false — new labels belong in the model\'s ORIGINAL label file.',
        },
      },
      required: ['action'],
    },
  };
