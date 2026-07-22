/**
 * MCP tool definition for `generate_object` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
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
      'For a single existing object definition\'s XML use d365fo_file(action="generate") instead.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['pattern', 'scaffold', 'find-methods', 'relation-xpp', 'fields', 'table-relation'],
          description: 'pattern = X++ skeleton; scaffold = whole table/form/report (set objectType); find-methods/relation-xpp/fields/table-relation = X++/XML helpers for an existing table.',
        },
        // shared identity / placement
        name: { type: 'string', description: 'REQUIRED. [pattern] element name (extensions: base element; form-datasource/control-extension: the FORM name). [scaffold] object name WITHOUT model prefix.' },
        modelName: { type: 'string', description: 'Model name from .mcp.json (auto-detected if omitted). NEVER use placeholders like "MyModel".' },
        projectPath: { type: 'string', description: '[scaffold] Path to .rnrproj file for model extraction.' },
        solutionPath: { type: 'string', description: '[scaffold] Path to solution directory (alternative to projectPath).' },
        // mode=pattern
        pattern: {
          type: 'string',
          enum: [
            'class', 'runnable', 'form-handler', 'data-entity', 'batch-job', 'table-extension',
            'sysoperation', 'event-handler', 'security-privilege', 'menu-item',
            'class-extension', 'ssrs-report-full', 'lookup-form',
            'dialog-box', 'dimension-controller', 'number-seq-handler',
            'display-menu-controller', 'data-entity-staging', 'service-class-ais',
            'form-datasource-extension', 'form-control-extension', 'map-extension',
          ],
          description: '[pattern] REQUIRED. CoC skeletons: class/table-extension, form-handler, form-datasource-extension (name=FormName, baseName=DataSourceName), form-control-extension (name=FormName, baseName=ControlName), map-extension. ssrs-report-full = Contract+DP+Controller; service-class-ais = CRUD service + contract.',
        },
        menuItemType: {
          type: 'string',
          enum: ['display', 'action', 'output'],
          description: '[pattern] For menu-item pattern: type of menu item (display=form, action=class, output=report)',
        },
        baseName: {
          type: 'string',
          description: '[pattern] event-handler: base class/table. form-datasource-extension: data source name (defaults to form name). form-control-extension: exact control name (find via get_object_info(objectType="form")).',
        },
        targetObject: {
          type: 'string',
          description: '[pattern] For menu-item and security-privilege patterns: target form/class/report name',
        },
        serviceMethod: {
          type: 'string',
          description: '[pattern] sysoperation: Service method the Controller calls (default "process").',
        },
        // mode=scaffold
        objectType: {
          type: 'string',
          enum: ['table', 'form', 'report'],
          description: '[scaffold] REQUIRED. Kind of object to generate.',
        },
        label: { type: 'string', description: '[scaffold:table|form] Optional label for the generated object.' },
        caption: { type: 'string', description: '[scaffold:form|report] Optional caption/title (form: window title; report: human-readable report title).' },
        packagePath: { type: 'string', description: '[scaffold:report] Base packages directory path.' },
        tableGroup: {
          type: 'string',
          description: '[scaffold:table] Business role (TableGroup enum): Main, Transaction, Parameter, Group, WorksheetHeader/WorksheetLine, Reference, Miscellaneous, Framework. ⛔ NEVER pass "TempDB"/"InMemory" here — that is tableType.',
        },
        tableType: {
          type: 'string',
          description: '[scaffold:table] Storage type: Regular (default, omit), TempDB, InMemory. ⛔ NEVER pass as tableGroup.',
        },
        generateCommonFields: { type: 'boolean', description: '[scaffold:table] Auto-generate common fields based on table group patterns.' },
        preview: { type: 'boolean', description: '[scaffold:table] Return the XML without writing to disk.' },
        dataSource: { type: 'string', description: '[scaffold:form] Optional: Table name for primary datasource.' },
        formPattern: {
          type: 'string',
          description: '[scaffold:form] Optional: Form pattern (SimpleList, SimpleListDetails, DetailsMaster, DetailsTransaction, Dialog, DropDialog, TableOfContents, Lookup, ListPage, Workspace).',
        },
        cloneFrom: {
          type: 'string',
          description: '[scaffold:form] PREFERRED: clone a reference form\'s XML re-bound via tableMapping (methods stripped; fields missing on target tables dropped and reported).',
        },
        tableMapping: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: '[scaffold:form] With cloneFrom: sourceTable → targetTable map, e.g. {"CustGroup": "MyRentalGroup"}.',
        },
        includeMethodStubs: { type: 'boolean', description: '[scaffold:form] Inject pattern-appropriate lifecycle method stubs with TODO markers.' },
        generateControls: { type: 'boolean', description: '[scaffold:form] Auto-generate grid controls for datasource.' },
        fields: {
          type: 'array',
          description: '[scaffold:table|report | fields] Structured field specs; takes priority over fieldsHint. PREFER for enum-backed fields or an explicit EDT — a bare name cannot express either. name + optional edt/enumType/type/label/mandatory (EDT auto-resolved when omitted).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              edt: { type: 'string', description: 'Explicit EDT — for mode="fields", omit to auto-resolve from the field name.' },
              enumType: { type: 'string', description: '[fields] Enum name for an enum-backed field (AxTableFieldEnum).' },
              type: { type: 'string', description: '[fields] Explicit base type (String/Integer/Int64/Real/Date/UtcDateTime/Guid).' },
              dataType: { type: 'string', description: '[scaffold:report] .NET type, e.g. "System.Double"' },
              label: { type: 'string' },
              mandatory: { type: 'boolean', description: '[fields] Mark the field Mandatory=Yes.' },
            },
            required: ['name'],
          },
        },
        contractParams: {
          type: 'array',
          description: '[scaffold:report] Dialog parameters for the Contract class.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', description: 'X++ type — EDT or primitive (e.g. "TransDate", "CustAccount")' },
              label: { type: 'string' },
              mandatory: { type: 'boolean' },
            },
            required: ['name'],
          },
        },
        additionalDatasets: {
          type: 'array',
          description: '[scaffold:report] Multi-dataset report: each entry adds a TempDB TmpTable + a get<Table>() DP method. name = suffix ("Header" → <Report>HeaderTmp).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              fieldsHint: { type: 'string' },
              fields: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
            },
            required: ['name'],
          },
        },
        generateController: { type: 'boolean', description: '[scaffold:report] Generate Controller class (default: true).' },
        designStyle: { type: 'string', description: '[scaffold:report] RDL design pattern: "SimpleList" (default) or "GroupedWithTotals".' },
        copyFrom: { type: 'string', description: '[scaffold] Copy structure from an existing object (forms: prefer cloneFrom).' },
        fieldsHint: { type: 'string', description: '[scaffold:table|report] Comma-separated field names; EDTs auto-suggested from the index. ⚠️ EDTs/enums created this session are not yet indexed — call update_symbol_index first, else those fields default to String255.' },
        // mode=find-methods
        keyFields: {
          type: 'array',
          items: { type: 'string' },
          description: '[find-methods] Explicit key field names (order matters); overrides index detection.',
        },
        includeExists: { type: 'boolean', description: '[find-methods] Emit exists() (default true).' },
        includeFindRecId: { type: 'boolean', description: '[find-methods] Emit findRecId() (default true).' },
        // mode=relation-xpp
        relationName: { type: 'string', description: '[relation-xpp] One relation to convert. Omit = all relations.' },
        style: { type: 'string', enum: ['select', 'query', 'both'], description: '[relation-xpp] select | query | both (default).' },
        // mode=fields (shares the `fields` array above)
        fieldGroup: { type: 'string', description: '[fields] Field-group name — emits an AxTableFieldGroup listing the new fields.' },
      },
      required: ['mode'],
    },
  };
