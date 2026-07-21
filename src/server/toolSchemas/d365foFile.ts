/**
 * MCP tool definition for `d365fo_file` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const d365foFileTool = {
    name: 'd365fo_file',
    description: `Create, modify, or generate a D365FO AOT object. Choose an \`action\`:
• create → write a NEW object file into PackagesLocalDirectory (UTF-8 BOM, auto-added to .rnrproj). THE WRITE STEP — incomplete until isError=false; treat ⚠️/❌ as failure. Extensions: objectName="BaseObject.PrefixExtension". (Windows)
• modify → edit an EXISTING object via IMetadataProvider. APPLIES IMMEDIATELY, no dry-run — get user confirmation BEFORE calling; revert with undo_last_modification. Requires \`operation\`. (Windows)
• generate → XML as TEXT only, no write (Azure/Linux fallback when create reports "requires file system access"); save it yourself with UTF-8 BOM. ALWAYS try action=create first.

Model from .mcp.json; prefix auto-applied from EXTENSION_PREFIX. Classes: member vars inside the class { }, methods after the closing }.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'modify', 'generate'],
          description: 'create = new object file (write); modify = edit existing object (write); generate = XML text only (no write).',
        },
        objectType: {
          type: 'string',
          enum: [
            'class', 'table', 'enum', 'form', 'query', 'view', 'data-entity', 'report', 'edt',
            'table-extension', 'class-extension', 'form-extension', 'enum-extension', 'edt-extension',
            'data-entity-extension', 'menu-item-display-extension',
            'menu-item-action-extension', 'menu-item-output-extension', 'menu-extension',
            'menu-item-display', 'menu-item-action', 'menu-item-output', 'menu',
            'security-privilege', 'security-duty', 'security-role',
            'security-duty-extension', 'security-role-extension',
            'business-event', 'tile', 'kpi', 'map',
            'service', 'service-group',
          ],
          description:
            'Each security/menu-item type maps to its own AOT folder — NEVER use security-privilege for duty or role. ' +
            'class-extension = [ExtensionOf] final class skeleton; business-event = BusinessEventsBase + Contract pair. ' +
            '[modify] supports class/table/form/enum/query/view/edt/data-entity/report + *-extension variants. ' +
            '[generate] supports class/table/enum/form/query/view/data-entity/report + table/form/enum/edt/data-entity-extension.'
        },
        objectName: {
          type: 'string',
          description: 'Base name WITHOUT model prefix — the tool prepends EXTENSION_PREFIX (or modelName) and detects an existing prefix. Extension classes: pass "{Base}_Extension" with NO prefix infix (produces e.g. "SalesFormLetterMY_Extension"). NEVER hand-build the prefix.'
        },
        modelName: {
          type: 'string',
          description: 'Target model name — auto-detected from .mcp.json if omitted. NEVER guess or take model names from search results (source models).'
        },
        packageName: {
          type: 'string',
          description: 'Package name — auto-resolved from model name; pass only if they differ.',
        },
        packagePath: {
          type: 'string',
          description: 'Base package path (default: K:\\AosService\\PackagesLocalDirectory). [modify] also locates objects outside the default dir; for models outside bridge startup roots set D365FO_CUSTOM_PACKAGES_PATH or pass filePath.'
        },
        sourceCode: {
          type: 'string',
          description: 'X++ source for the object. FOR CLASSES the content is auto-split: <Declaration> = the class line + ALL member variables inside the outer { }; <Methods> = each method AFTER the closing }. CRITICAL: member variables MUST sit inside the class { }, methods after — never reversed.'
        },
        properties: {
          type: 'object',
          description:
            'Additional properties by objectType:\n' +
            '• class: extends, implements, isFinal, isAbstract\n' +
            '• table: label, tableGroup, tableType, titleField1/2, fields[{name,type?|edt?|fieldType?,enumType?,label?,mandatory?}] — enum fields need enumType (+ optionally fieldType:"AxTableFieldEnum")\n' +
            '• enum: label, useEnumValue, configurationKey, isExtensible, enumValues[{name,value?,label?,helpText?}]\n' +
            '• enum-extension: enumValues[{name,label?,value?,countryRegionCodes?}]\n' +
            '• table-extension: fields[{name,edt?,enumType?,label?,mandatory?,fieldType?}] — enum fields need fieldType:"AxTableFieldEnum" + enumType\n' +
            '• edt: label, extends, edtType, stringSize\n' +
            '• form: caption, formTemplate, dataSource\n' +
            '• security-privilege: label, targetObject, objectType (MenuItemDisplay|Action|Output), accessLevel (view|maintain), dataEntity (grants perms)\n' +
            '• security-duty: label, privileges[]\n' +
            '• security-role: label, duties[], privileges[]\n' +
            '• menu-item-*: label, object, objectType\n' +
            '• data-entity: primaryTable, fields[{name,dataField?}], dataManagementEnabled? (default false; true only if staging table exists)\n' +
            '• map: label?, developerDocumentation?, fields[{name,type?,edt?,enumType?,stringSize?}], mappingTable?, mappings?[{mapField,mapFieldTo}] (defaults to one connection/field when mappingTable set)\n' +
            '• query: title?, dataSource (root table; table also works), dataSourceName?, fields?[{name,field?}]\n' +
            '• view: query (existing AxQuery), fields[{name,dataField?}] — dataSource defaults to query\n' +
            '• service: serviceClass (defaults to the service name), externalName?, namespace?, description?, operations["opName"] or [{name?,method?,enableIdempotence?,subscriberAccessLevelRead?}]\n' +
            '• service-group: autoDeploy? (Yes publishes at /api/services), description?, services["MyService"] or [{name?,service?}]\n' +
            '  ⚠ service/service-group CROSS-REFS (serviceClass, services[].service) are written VERBATIM — only objectName is prefixed. ' +
            'Pass the FINAL name of the already-created service/class (e.g. "ContosoDemoNoteService", not "DemoNoteService"), else the group resolves to nothing — verbatim lets a group also reference an unprefixed Microsoft service (DimensionService).'
        },
        addToProject: {
          type: 'boolean',
          description: 'Add the file to the .rnrproj project. Keep the default (true) unless explicitly asked otherwise.',
          default: true
        },
        projectPath: {
          type: 'string',
          description: 'Path to .rnrproj file (needed for addToProject). Auto-detected from .mcp.json or workspace if omitted.'
        },
        solutionPath: {
          type: 'string',
          description: 'VS solution directory — used to find .rnrproj when projectPath unset.'
        },
        xmlContent: {
          type: 'string',
          description: 'Complete XML to write verbatim (with overwrite=true rewrites an existing object; Azure/Linux: pass XML from action=generate).',
        },
        overwrite: {
          type: 'boolean',
          description: 'Allow overwriting an existing file (use with xmlContent to rewrite an object \u2014 never via PowerShell/create_file).',
          default: false,
        },
        groundingToken: {
          type: 'string',
          description:
            'Provenance token from prepare(change/create). Required for *-extension objectTypes when ' +
            'GROUNDING_ENFORCE=true; object-bound — only valid for the object it was issued for.',
        },
        // action=modify only
        operation: {
          type: 'string',
          enum: [
            'add-method', 'remove-method', 'replace-code',
            'add-field', 'modify-field', 'rename-field', 'replace-all-fields', 'remove-field',
            'add-display-method', 'add-table-method',
            'add-index', 'remove-index',
            'add-relation', 'remove-relation',
            'add-field-group', 'remove-field-group', 'add-field-to-field-group',
            'add-field-modification',
            'add-data-source', 'add-control',
            'add-enum-value', 'modify-enum-value', 'remove-enum-value',
            'add-menu-item-to-menu',
            'modify-property',
          ],
          description:
            '[modify] REQUIRED. Modification to perform. Non-obvious ones:\n' +
            'add-method: adds OR updates in place when the method name exists (position preserved).\n' +
            'replace-code: surgical oldCode→newCode replacement; preferred for rewriting a known method. Form control overrides: methodName="ControlName.methodName".\n' +
            'rename-field: also fixes index DataField refs and TitleField1/2.\n' +
            'replace-all-fields: atomic rewrite of ALL fields (corrupted field names).\n' +
            'add-display-method: display method with [SysClientCacheDataMethodAttribute].\n' +
            'add-table-method: canonical find/exist/findByRecId/validateWrite/validateDelete/initValue boilerplate.\n' +
            'add-field-modification: override base-table field label/mandatory in a table-extension.\n' +
            'modify-property: any object-level property (TableGroup, TitleField1, TableType, Extends…) — see propertyPath.'
        },
        params: {
          type: 'object',
          additionalProperties: true,
          description:
            '[modify] Operation-specific parameters as ONE object. Common shapes: ' +
            'add-method {methodName, sourceCode} · replace-code {oldCode, newCode, methodName?} · ' +
            'add-field {fieldName, fieldType(EDT), fieldBaseType?} · rename-field {fieldName, fieldNewName} · ' +
            'add-index {indexName, indexFields[{fieldName}]} · add-relation {relationName, relatedTable, relationConstraints?} · ' +
            'add-field-group {fieldGroupName, fieldGroupFields?} · add-data-source {dataSourceName, dataSourceTable} · ' +
            'add-control {controlName, parentControl, controlDataSource?, controlDataField?} · ' +
            'enum ops {enumValueName, enumValueNewName?(modify-enum-value rename), enumValueLabel?, enumValueInt?} · add-menu-item-to-menu {menuItemToAdd} · ' +
            'modify-property {propertyPath, propertyValue} · add-table-method {tableMethodType, tableKeyField?} · ' +
            'add-display-method {methodName, displayMethodReturnEdt}. ' +
            'A missing/wrong parameter returns the COMPLETE spec (names, types, descriptions) for that operation — ' +
            'follow the error guidance instead of guessing. Same keys also accepted flat at top level.',
        },
        createBackup: {
          type: 'boolean',
          description: '[modify] Create backup before modification (default false)',
          default: false
        },
        filePath: {
          type: 'string',
          description: '[modify] Absolute path to the XML file — bypasses symbol-DB lookup. Use when the object was just created.'
        },
        workspacePath: {
          type: 'string',
          description: '[modify] Workspace path for finding file'
        },
      },
      required: ['action'],
    },
  };
