/**
 * MCP tool definition for `validate_code` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const validateCodeTool = {
    name: 'validate_code',
    description:
      'Static validator for generated X++/XML (paste the text). Choose a `mode`:\n' +
      '• syntax → offline best-practice/BP validator (no xppbp.exe). Structured violations {rule, severity, line, excerpt, fix}. Covers select, CoC, BP and table-XML rules mined from standard models.\n' +
      '• references → semantic reference resolver (index-only): verifies every type, field, method (incl. arity), enum, label and intrinsic (tableStr/fieldStr/…) EXISTS in the indexed codebase. codeType="xml-table" checks XML refs instead: EDT/enum/relation/extends/label.\n' +
      'Call mode="both" AFTER generating, BEFORE writes; fix errors in the same turn. Write tools run references internally when GROUNDING_ENFORCE=true.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['both', 'syntax', 'references'],
          description: 'both = run the two checks in ONE call (preferred).',
        },
        code: {
          type: 'string',
          description: 'X++ source code or XML metadata to validate. Paste the full generated text.',
        },
        codeType: {
          type: 'string',
          enum: ['xpp', 'xml-table', 'xml-form', 'xml-any', 'xml-report'],
          default: 'xpp',
          description: '[syntax] "xpp" X++ source (default), "xml-table" AxTable, "xml-form" AxForm/AxFormExtension, "xml-report" AxReport, "xml-any" other XML.',
        },
        context: {
          type: 'string',
          description: 'Optional: owning class/table name, used in diagnostic messages.',
        },
      },
      required: ['mode', 'code'],
    },
  };
