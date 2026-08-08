/**
 * MCP tool definition for `search` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const searchTool = {
    name: 'search',
    description:
      'Search pre-indexed D365FO objects by name or keyword. Three modes in ONE tool:\n' +
      '• single (default) → pass `query`; returns name, type, model.\n' +
      '• batch → pass `queries[]` (max 10) to run searches in parallel (3× faster, with dedup + cross-reference).\n' +
      '• extensions → set `scope:"extensions"` to restrict to custom/ISV models only (filters out Microsoft standard code). Model names in those results are SOURCE models — never use them as create/modify targets.\n' +
      'Use get_object_info(objectType, name) when you already know the exact name and need full details.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['all', 'extensions'],
          default: 'all',
          description: '[single] Search the whole index ("all", default) or only custom/ISV models ("extensions"). Ignored when `queries[]` is provided.',
        },
        query: { type: 'string', description: '[single|extensions] Search query (class name, method name, table name, etc.). REQUIRED unless using batch `queries[]`.' },
        type: {
          type: 'string',
          enum: ['class', 'table', 'field', 'method', 'enum', 'edt', 'form', 'query', 'view', 'report',
            'security-privilege', 'security-duty', 'security-role',
            'menu-item-display', 'menu-item-action', 'menu-item-output',
            'table-extension', 'class-extension', 'form-extension',
            'enum-extension', 'edt-extension', 'data-entity-extension',
            'all'],
          description: '[single] Filter by object type ("all" = no filter).',
          default: 'all'
        },
        prefix: { type: 'string', description: '[extensions] Extension prefix filter (e.g., ISV_, Custom_).' },
        limit: { type: 'number', description: '[single|extensions] Maximum results to return', default: 20 },
        verbose: {
          type: 'boolean',
          default: false,
          description: '[single] Include related-searches/patterns/tips sections (off by default to keep responses compact).',
        },
        workspacePath: {
          type: 'string',
          description: '[single] Optional workspace path to search local project files in addition to external metadata',
        },
        includeWorkspace: {
          type: 'boolean',
          default: false,
          description: '[single] Whether to include workspace files in search results (workspace-aware search)',
        },
        queries: {
          type: 'array',
          description: '[batch] Array of search queries to execute in parallel (max 10). When provided, runs in batch mode and `scope`/`query` are ignored.',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query (class name, method name, etc.)',
              },
              type: {
                type: 'string',
                default: 'all',
                description: 'Filter by object type — same values as the top-level `type`. Omit to inherit globalTypeFilter or default to "all"',
              },
              limit: {
                type: 'number',
                default: 10,
                description: 'Maximum results to return for this query',
              },
              workspacePath: {
                type: 'string',
                description: 'Optional workspace path to search local files',
              },
              includeWorkspace: {
                type: 'boolean',
                default: false,
                description: 'Whether to include workspace files in results',
              },
            },
            required: ['query'],
          },
        },
        globalTypeFilter: {
          type: 'array',
          maxItems: 5,
          description:
            '[batch] Default type filter for queries without an explicit per-query type. ' +
            'E.g. ["class"] restricts all untyped queries to classes. ' +
            'Multiple values fan out each untyped query into one search per type. ' +
            'Values: same as the top-level `type`, except "all" (which means "no filter" — omit this instead).',
          items: { type: 'string' },
        },
        deduplicate: {
          type: 'boolean',
          default: true,
          description:
            '[batch] When true, symbols appearing in multiple query results are collapsed. ' +
            'Later occurrences are replaced with a reference to the query where they first appeared.',
        },
        crossReference: {
          type: 'boolean',
          default: true,
          description:
            '[batch] Append a cross-reference summary at the end listing symbols that appeared in multiple queries. ' +
            'Useful for identifying the most relevant / commonly matched objects across all searches.',
        },
      },
    },
  };
