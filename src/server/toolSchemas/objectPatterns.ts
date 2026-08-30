/**
 * MCP tool definition for `object_patterns` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const objectPatternsTool = {
    name: 'object_patterns',
    description:
      'Pattern toolkit. Choose a `domain`:\n' +
      '• table → field/index/relation patterns for D365FO tables. Filter by tableGroup or similarTo a given table.\n' +
      '• form → form-pattern toolkit; pick an `action`:\n' +
      '   - analyze → pattern advisor + usage analysis. For a NEW form pass `recommend` (preferred): the Microsoft decision tree picks the pattern and names reference forms to clone. Or filter by formPattern / dataSource / similarTo.\n' +
      '   - spec → structure spec of a pattern/sub-pattern: hierarchy, ordering, allowed children, reference forms, lifecycle.\n' +
      '   - validate → AxForm XML validator (hierarchy/order, sub-patterns, PatternVersion) → FP001-FP010. Call before d365fo_file action=create.\n' +
      '• report → SSRS implementation recipes: object roster, scaffold call, checks. Optional pattern=<id>.\n' +
      '• mobile-app → warehouse-app screen recipes, led by the choice between the two frameworks that build them (ProcessGuide vs WHSWorkExecuteDisplay): create a flow, add or replace one screen, step icon/title, GS1 scan input. Optional pattern=<id>.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          enum: ['table', 'form', 'report', 'mobile-app'],
          description: 'Optional — inferred from the other params (action/pattern/xml/formName → form; tableGroup → table). A concept like "number-sequence" is not a domain: that is get_knowledge.',
        },
        // domain=table
        tableGroup: {
          type: 'string',
          enum: ['Main', 'Transaction', 'Parameter', 'Group', 'Reference', 'Miscellaneous', 'WorksheetHeader', 'WorksheetLine'],
          description: '[table] Table group type to analyze (choose one).',
        },
        // domain=form
        action: {
          type: 'string',
          enum: ['analyze', 'validate', 'spec', 'repair'],
          description: '[form] Which form-pattern operation to run. repair = auto-fill missing required controls.',
        },
        // domain=form, action=analyze
        formPattern: {
          type: 'string',
          enum: ['DetailsTransaction', 'ListPage', 'SimpleList', 'SimpleListDetails', 'Dialog', 'DropDialog', 'FormPart', 'Lookup'],
          description: '[analyze] D365FO form pattern to analyze',
        },
        dataSource: {
          type: 'string',
          description: '[form/analyze] Table name - find forms using this table',
        },
        similarTo: {
          type: 'string',
          description: '[table] table / [form-analyze] form name to find similar patterns.',
        },
        recommend: {
          type: 'object',
          description: '[analyze] Pattern advisor: describe requirements, get a recommended pattern + reference forms to clone.',
          properties: {
            entityKind: {
              type: 'string',
              enum: ['master', 'transaction', 'setup', 'parameters', 'inquiry', 'lookup', 'workspace', 'dialogTask'],
              description: 'Kind of entity being modelled.',
            },
            hasHeaderLines: {
              type: 'boolean',
              description: 'True when data is a header with line items',
            },
            fieldCount: {
              type: 'number',
              description: 'Approximate fields users see/edit per record.',
            },
            usageIntent: {
              type: 'string',
              enum: ['maintain', 'viewOnly', 'pickValue', 'quickCreate', 'dashboard', 'wizard'],
              description: 'Primary user activity on the form',
            },
            tableName: {
              type: 'string',
              description: 'Main table — pulls field count and existing-form evidence from the index.',
            },
          },
        },
        limit: {
          type: 'number',
          description: '[analyze] Max pattern examples.',
          default: 10,
        },
        // action=spec
        pattern: {
          type: 'string',
          description: '[spec|report|mobile-app] Pattern name (id, xmlName or alias) — e.g. "SimpleList", "FieldsFieldGroups", "PrintMgmtFormLetter", "processguide-flow".',
        },
        // action=validate
        xml: {
          type: 'string',
          description: '[validate] Complete AxForm XML to validate. Provide this OR formName/filePath.',
        },
        formName: {
          type: 'string',
          description: '[validate] Name of an indexed form — XML is loaded from the metadata store.',
        },
        filePath: {
          type: 'string',
          description: '[form/validate] Path to an AxForm XML file not yet indexed.',
        },
      },
      // domain is optional: inferred from other params (also accepts `patternType` alias).
      required: [],
    },
  };
