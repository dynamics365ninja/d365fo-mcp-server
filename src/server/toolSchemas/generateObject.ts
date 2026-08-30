/**
 * MCP tool definition for `generate_object` (name/description/inputSchema).
 *
 * Like `d365fo_file`, this carries the DISCRIMINATORS only (mode / pattern /
 * objectType as closed enums) plus a free-form `params`. The per-mode parameter
 * contract lives in src/tools/generateObjectOpSpecs.ts and is fetched on demand
 * via get_knowledge(kind="op-spec", topic="<mode>"), because this payload is
 * re-sent on every request while a call uses exactly one mode (issue #825).
 * The dispatcher merges `{...args, ...args.params}`, and a call missing a
 * required parameter is answered with the mode's complete spec.
 *
 * Serialized payload must not change unintentionally —
 * tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const generateObjectTool = {
    name: 'generate_object',
    description:
      'Generate X++/AOT code. Choose a `mode`:\n' +
      '• pattern → a named X++ skeleton from the pattern enum (text only, no write). Call analyze_code(mode="patterns") first, then generate_object(mode="pattern"), then d365fo_file(action="create").\n' +
      '• scaffold → pattern-aware whole-object generation (table/form/report) with intelligent field/index/relation or form-pattern suggestions; set objectType.\n' +
      '• find-methods → find()/findRecId()/exists() for a table (text), keyed on its primary/unique index.\n' +
      '• relation-xpp → a table\'s relation(s) → X++ select + QueryBuildRange (text).\n' +
      '• fields → field names → AxTableField XML with auto-resolved EDTs + optional field group.\n' +
      '• table-relation → EDT-referencing fields → AxTableRelation XML (inverse of relation-xpp).\n' +
      '📖 Mode parameters are NOT inlined here: get_knowledge(kind="op-spec", topic="<mode>") — "scaffold:table"/"scaffold:form"/"scaffold:report" for the scaffolds — returns the contract; pass its values nested in `params`.\n' +
      'For a single existing object definition\'s XML use d365fo_file(action="generate") instead.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          // No description: it restated the bullet list in this tool's own
          // description, which is sent in the same payload.
          enum: ['pattern', 'scaffold', 'find-methods', 'relation-xpp', 'fields', 'table-relation'],
        },
        name: {
          type: 'string',
          description: 'REQUIRED. [pattern] element name (extensions: base element; form-datasource/control-extension: the FORM name). [scaffold] object name WITHOUT model prefix. [other modes] the existing table.',
        },
        modelName: { type: 'string', description: 'Model name (auto-detected). NEVER use placeholders like "MyModel".' },
        pattern: {
          type: 'string',
          enum: [
            'class', 'runnable', 'form-handler', 'data-entity', 'batch-job', 'table-extension',
            'sysoperation', 'event-handler', 'security-privilege', 'menu-item',
            'class-extension', 'ssrs-report-full', 'lookup-form',
            'dialog-box', 'dimension-controller', 'number-seq-handler',
            'display-menu-controller', 'data-entity-staging', 'service-class-ais',
            'form-datasource-extension', 'form-control-extension', 'map-extension',
            'systest',
            'report-dataset-extension', 'report-custom-design', 'report-menu-redirect',
          ],
          // Paid for the three report-* enum values by dropping the
          // CoC-skeleton roll-call: it re-listed five values printed
          // verbatim in the enum right above, in the same payload.
          description: '[pattern] REQUIRED. ssrs-report-full = Contract+DP+Controller; service-class-ais = CRUD service + contract; systest = failing SysTestCase (TDD red); report-* extend a STANDARD report (recipes: object_patterns(domain="report")).',
        },
        objectType: {
          type: 'string',
          enum: ['table', 'form', 'report'],
          description: '[scaffold] REQUIRED. Kind of object to generate.',
        },
        params: {
          type: 'object',
          additionalProperties: true,
          description:
            // The op-spec pointer this used to repeat is already in this
            // tool's own description, sent in the same payload.
            'Mode-specific parameters as ONE nested object (label, fields[], fieldsHint, cloneFrom, tableMapping, ' +
            'formPattern, contractParams[], keyFields[], style, fieldGroup, …). A missing required one is ' +
            'answered with that mode\'s COMPLETE spec.',
        },
      },
      required: ['mode'],
    },
  };
