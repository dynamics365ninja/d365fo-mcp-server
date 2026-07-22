/**
 * MCP tool definition for `prepare` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const prepareTool = {
    name: 'prepare',
    description:
      'ONE-call context aggregator + groundingToken (30-min TTL, required for extension/new-object writes when ' +
      'GROUNDING_ENFORCE=true). Choose a `mode`:\n' +
      '• change → extending/modifying an EXISTING object: exact signature, existing CoC wrappers, eligibility, ' +
      'recommended strategy, naming, patterns. Replaces the analyze→search→info→generate loop.\n' +
      '• create → a NEW object: collision check, naming with auto-prefix, similar objects, EDT suggestions, ' +
      'reusable labels, mined property defaults.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['change', 'create'],
          description: 'change = extend/modify an existing object; create = a brand-new object.',
        },
        goal: {
          type: 'string',
          description: 'One-sentence description of the intent. Example (change): "Add CoC on CustTable.validateWrite". Example (create): "Parameter table for the Contoso import feature."',
        },
        objectName: {
          type: 'string',
          description: '[change] Name of the object to extend/modify (e.g. "CustTable"). [create] Proposed BASE name WITHOUT model prefix (same value you would pass to d365fo_file create).',
        },
        objectType: {
          type: 'string',
          enum: [
            'class', 'table', 'form', 'enum', 'edt', 'query', 'view',
            'data-entity', 'report', 'map', 'menu-item-display', 'menu-item-action',
            'menu-item-output', 'menu', 'security-privilege', 'security-duty', 'security-role',
            'business-event', 'tile', 'kpi', 'service', 'service-group',
            'macro', 'configuration-key', 'security-policy', 'aggregate-measurement', 'license-code',
          ],
          description: '[change] D365FO object type — auto-detected when omitted. [create] REQUIRED — type of the new object.',
        },
        methodName: {
          type: 'string',
          description: '[change] Target method name when the change involves a specific method (CoC or event handlers). Example: "validateWrite".',
        },
        proposedName: {
          type: 'string',
          description: '[change] Proposed name for the new extension class/object. When provided, naming validation runs.',
        },
        fieldsHint: {
          type: 'array',
          items: { type: 'string' },
          description: '[create] For tables/views: planned field names — each gets EDT suggestions from the index.',
        },
      },
      required: ['mode', 'goal', 'objectName'],
    },
  };
