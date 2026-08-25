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
          description: '[single] Whole index, or only custom/ISV models. Ignored when `queries[]` is provided.',
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
          description: '[single] Include related-searches/patterns/tips sections.',
        },
        queries: {
          type: 'array',
          description: '[batch] Array of search queries to execute in parallel (max 10). When provided, runs in batch mode and `scope`/`query` are ignored.',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              // Deliberately terse: the top-level `query` above already spells
              // out what a query is, and this schema is paid for once per session.
              query: { type: 'string', description: 'Search query.' },
              type: {
                type: 'string',
                default: 'all',
                description: 'Filter by object type — same values as the top-level `type`.',
              },
              limit: {
                type: 'number',
                default: 10,
                description: 'Maximum results to return for this query',
              },
            },
            required: ['query'],
          },
        },
      },
    },
  };
