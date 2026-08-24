/**
 * MCP tool definition for `extension_info` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const extensionInfoTool = {
    name: 'extension_info',
    description:
      'D365FO extensibility analyzer. Choose a `mode`:\n' +
      '• coc → Chain of Command extensions + event subscriptions for a class/table. Use before writing a CoC extension to check for conflicts.\n' +
      '• events → event handler subscriptions (SubscribesTo, delegate +=) for a class/table. Use before adding handlers to check for duplicates.\n' +
      '• table-merge → all extensions of a table across models + effective merged schema (base + extension fields/indexes/methods).\n' +
      '• points → available extension points (CoC-eligible/replaceable methods, delegates, blocked methods) and which are already extended.\n' +
      '• strategy → recommends the best extensibility mechanism for a goal (CoC, event handler, business event, data entity, …) with reasoning, risks, alternatives, next steps.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['coc', 'events', 'table-merge', 'points', 'strategy'],
          description: 'coc/events/table-merge/points need `target`; strategy needs `goal`.',
        },
        target: {
          type: 'string',
          description: 'The base object: [coc] class/table being extended; [events] class/table whose handlers to find; [table-merge] base table; [points] class/table/form; [strategy] optional target object.',
        },
        method: {
          type: 'string',
          description: '[coc] filter to a specific method name; [events] filter to a specific event name (e.g. onInserted).',
        },
        objectType: {
          type: 'string',
          enum: ['class', 'table', 'form', 'auto'],
          description: '[events] set "table" when target is a table (else class is assumed); [points] object type (default: auto-detect).',
          default: 'auto',
        },
        goal: {
          type: 'string',
          description: '[strategy] REQUIRED. What you want to achieve — e.g. "validate that SalesLine quantity is positive".',
        },
        scenario: {
          type: 'string',
          enum: ['data-validation', 'field-defaulting', 'field-change-reaction', 'business-logic-change',
                 'outbound-integration', 'inbound-data', 'ui-modification',
                 'document-output', 'number-sequence', 'security-access',
                 'batch-processing', 'custom'],
          description: '[strategy] Scenario category (auto-detected from goal if omitted). field-defaulting = set defaults on NEW records (initValue); field-change-reaction = react when a user/code CHANGES a field (modifiedField).',
        },
        handlerType: {
          type: 'string',
          enum: ['static', 'delegate', 'all'],
          description: '[events] Filter by handler type (default: all).',
          default: 'all',
        },
        includeEventHandlers: {
          type: 'boolean',
          description: '[coc] Also find static event subscriptions (SubscribesTo) (default: true).',
          default: true,
        },
        includeEffectiveSchema: {
          type: 'boolean',
          description: '[table-merge] Merge base + extension counts (default: true).',
          default: true,
        },
        showExistingExtensions: {
          type: 'boolean',
          description: '[points] Also list who already wraps/subscribes each point — opt-in, roughly doubles the response.',
          default: false,
        },
      },
      required: ['mode'],
    },
  };
