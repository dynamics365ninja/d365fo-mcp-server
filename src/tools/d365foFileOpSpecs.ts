/**
 * d365fo_file modify-operation parameter specs — the single source of truth
 * for op-specific parameters (names, types, descriptions).
 *
 * The wire schema only advertises a free-form `params` object (see
 * src/server/toolSchemas/d365foFile.ts); when a modify call misses a required
 * parameter, the error returns the COMPLETE spec for that operation via
 * renderOpSpec(). The dispatcher merges `{...args, ...args.params}` so flat
 * calls keep working.
 *
 * tests/utils/toolInventory.test.ts guards that every advertised modify param
 * has an entry here; tests/tools/d365foFileOpSpecs.test.ts guards op coverage.
 */

/** Type + description for a single op parameter, keyed by parameter name. */
export const D365FO_FILE_PARAM_SPECS: Record<string, { type: string; description: string }> = {
  // methods
  methodName: {
    type: 'string',
    description:
      'Method name. add-method/add-display-method: derived from the source signature when omitted; ' +
      'remove-method: required. replace-code: optional scope — for form control overrides use ' +
      '"ControlName.methodName" (e.g. "PostButton.clicked").',
  },
  methodCode: {
    type: 'string',
    description:
      'Alias of sourceCode — full X++ method source incl. modifiers/attributes. A bare body gets its ' +
      'signature assembled from methodModifiers/methodReturnType/methodName/methodParameters.',
  },
  sourceCode: {
    type: 'string',
    description:
      'Full X++ method source incl. modifiers/attributes (top-level core param; alias: methodCode). ' +
      'add-method may carry several methods — they are split and added one <Method> at a time.',
  },
  methodModifiers: { type: 'string', description: 'e.g. "public static"' },
  methodReturnType: { type: 'string', description: 'e.g. "void", "str", "boolean"' },
  methodParameters: { type: 'string', description: 'e.g. "str _param1, int _param2"' },
  oldCode: {
    type: 'string',
    description:
      'Exact existing X++ snippet to find (whitespace-trimmed match); methodName scopes the search to ' +
      'that method\'s Source block.',
  },
  newCode: {
    type: 'string',
    description: 'Replacement for the first occurrence of oldCode; pass "" to delete the snippet.',
  },
  // table delete actions
  deleteActionName: {
    type: 'string',
    description: 'Delete action name — conventionally the related table name.',
  },
  deleteActionTable: {
    type: 'string',
    description: 'Related table the delete action applies to (defaults to deleteActionName).',
  },
  deleteActionType: {
    type: 'string (None | Restricted | Cascade | CascadeRestricted)',
    description: 'Delete action to take on the related table. Defaults to Restricted.',
  },
  // table fields
  fieldName: { type: 'string', description: 'Field name.' },
  fieldNewName: {
    type: 'string',
    description: 'New field name (index DataField refs and TitleField1/2 are fixed automatically).',
  },
  fieldType: {
    type: 'string',
    description:
      'EDT name for the field (e.g. "InventQty", "WHSZoneId", "TransDate"). For modify-field: new EDT to set.',
  },
  fieldBaseType: {
    type: 'string (String | Integer | Real | Date | DateTime | Int64 | GUID | Enum)',
    description:
      'Base type selecting the XML element for add-field (e.g. edt "InventQty" + "Real" → AxTableFieldReal). ' +
      'Auto-resolved from the symbol index when omitted — pass explicitly when the EDT is not indexed yet.',
  },
  fieldMandatory: { type: 'boolean', description: 'Mark the field Mandatory=Yes.' },
  fieldLabel: { type: 'string', description: 'Field label.' },
  fieldHelpText: { type: 'string', description: 'Field help text.' },
  fieldEnumType: {
    type: 'string',
    description:
      'Enum name for an enum-typed field. On add-field this is all an enum field needs — ' +
      'it writes AxTableFieldEnum + EnumType, no EDT.',
  },
  fieldStringSize: { type: 'string', description: 'String size to set on a string-typed field.' },
  autoCorrect: {
    type: 'boolean (default true)',
    description:
      'Apply a correction the server has already fully determined — one valid reading only — and report ' +
      'it as a "Note:" line in the result, instead of failing the call. false = strict: every such case ' +
      'errors again (deterministic callers, eval harness).',
  },
  dataField: {
    type: 'string',
    description:
      'add-field on a data-entity-extension: source table field name for the mapped field ' +
      '(e.g. "MyField"). Required alongside dataSource — used instead of fieldType/fieldBaseType, ' +
      'since a data-entity mapped field (AxDataEntityViewMappedField) has no EDT/base-type of its own.',
  },
  dataSource: {
    type: 'string',
    description:
      'add-field on a data-entity-extension: source data-source/table name on the entity for the ' +
      'mapped field (e.g. "MyTable"). Required alongside dataField.',
  },
  fields: {
    type: 'array of { name, edt?, type?, mandatory?, label? }',
    description:
      'Full replacement field list (atomic — replaces ALL fields; for corrupted field names). ' +
      'Always pass type = the base type (String/Real/Integer/Date/DateTime/Int64/GUID/Enum) alongside edt ' +
      'so the correct XML element is used, e.g. { name: "TransQty", edt: "InventQty", type: "Real" }.',
  },
  // properties
  propertyPath: {
    type: 'string',
    description:
      'Property name to set. Supported names by objectType:\n' +
      '    table: TableGroup, TitleField1/2, TableType (TempDB/InMemory/RegularTable), CacheLookup, ' +
      'ClusteredIndex, PrimaryIndex, SaveDataPerCompany, Label, HelpText, Extends, SystemTable.\n' +
      '    table-extension (stored as <AxPropertyModification>): the table names above plus ' +
      'ModifiedDateTime, CreatedDateTime, ModifiedBy, CreatedBy (Yes/No), CountryRegionCodes ("CZ,SK").\n' +
      '    edt: Extends, StringSize, Label, HelpText, ReferenceTable, ReferenceField.\n' +
      '    class: Extends, Abstract, Final, Label.\n' +
      '    form: any single text element (Caption, Pattern) via XML fallback.\n' +
      '    Example: propertyPath="TableGroup" propertyValue="Group".',
  },
  propertyValue: { type: 'string', description: 'New property value.' },
  // form controls
  controlName: {
    type: 'string',
    description:
      'Name of the new form control — MUST match the field name in the table extension so the binding works.',
  },
  parentControl: {
    type: 'string',
    description:
      'Existing parent tab/group in the base form (e.g. "TabGeneral"). Fuzzy names are auto-resolved ' +
      'against the base form; find the exact name via get_object_info(objectType="form", options={searchControl:"…"}).',
  },
  controlDataSource: {
    type: 'string',
    description: 'Data source name for the control binding (e.g. "CustTable").',
  },
  controlDataField: {
    type: 'string',
    description: 'Data field for the binding — must already exist in the table/table extension.',
  },
  controlType: {
    type: 'string',
    description:
      'String (default), Integer, Real, CheckBox (NoYes/boolean), ComboBox (enums), Date, DateTime, ' +
      'Int64, Group, Button, CommandButton, MenuFunctionButton. Auto-picked from the EDT base type ' +
      'when controlDataField is provided.',
  },
  controlLabel: { type: 'string', description: 'Optional label for the new control.' },
  positionType: {
    type: 'string',
    description: 'AfterItem | BeforeItem. Omit to append at the end of the parent.',
  },
  previousSibling: {
    type: 'string',
    description: 'Name of the sibling control to position after (used with positionType=AfterItem).',
  },
  baseFormName: {
    type: 'string',
    description:
      'Base form name for resolving parentControl — pass only when auto-detection from the extension name fails.',
  },
  // table methods / display methods
  tableMethodType: {
    type: 'string (find | exist | findByRecId | validateWrite | validateDelete | initValue)',
    description:
      'Standard method to auto-generate; find/exist also need tableKeyField. ' +
      'Omit and pass methodName+sourceCode for a custom method.',
  },
  tableKeyField: {
    type: 'string',
    description: 'Primary key field for find/exist (e.g. "ItemId").',
  },
  displayMethodReturnEdt: {
    type: 'string',
    description:
      'Return EDT (e.g. "Name") — auto-generates a stub with methodName. Omit and pass sourceCode for a custom body.',
  },
  // indexes
  indexName: { type: 'string', description: 'Index name.' },
  indexFields: {
    type: 'array of { fieldName, direction? ("Asc"|"Desc") }',
    description: 'Fields that make up the index.',
  },
  indexAllowDuplicates: { type: 'boolean', description: 'Allow duplicates (default: false = unique).' },
  indexAlternateKey: { type: 'boolean', description: 'Mark the index as an alternate key.' },
  indexEnabled: { type: 'boolean', description: 'Whether the index is enabled (default: true).' },
  // relations
  relationName: { type: 'string', description: 'Relation name.' },
  relatedTable: { type: 'string', description: 'Related (foreign key) table name.' },
  relationConstraints: {
    type: 'array of { fieldName, relatedFieldName }',
    description: 'Field constraints (local field = related field pairs).',
  },
  // Value sets are the metamodel enums themselves (verified on platform 7.0.7858.27);
  // anything outside them is rejected by the bridge with the legal list, not dropped.
  relationCardinality: {
    type: 'string',
    description:
      'Local-side cardinality: ZeroOne | ExactlyOne | ZeroMore | OneMore | NotSpecified (default: ZeroMore).',
  },
  relatedTableCardinality: {
    type: 'string',
    description: 'Related-side cardinality: ZeroOne | ExactlyOne | NotSpecified (default: ExactlyOne).',
  },
  relationshipType: {
    type: 'string',
    description:
      'Association | Composition | Aggregation | Link | Specialization | NotSpecified (default: Association).',
  },
  // field groups
  fieldGroupName: { type: 'string', description: 'Field group name.' },
  fieldGroupFields: {
    type: 'array of string',
    description: 'Initial field names (may be empty — add later with add-field-to-field-group).',
  },
  fieldGroupLabel: { type: 'string', description: 'Field group label (optional).' },
  extendBaseFieldGroup: {
    type: 'boolean',
    description:
      'table-extension only: true = extend an existing base-table group (<FieldGroupExtensions>); ' +
      'false = add to a group defined in the extension.',
  },
  // table mappings (AxMap membership)
  mapName: { type: 'string', description: 'Name of the AxMap the table takes part in.' },
  mappingTable: { type: 'string', description: 'Mapped table name (defaults to mapName).' },
  mappingConnections: {
    type: 'array of {mapField, mapFieldTo}',
    description: 'Field pairings: mapField is on the MAP, mapFieldTo on this table. Both required.',
  },
  // form data sources
  dataSourceName: { type: 'string', description: 'Data source reference name (e.g. "MyTable_1").' },
  dataSourceTable: { type: 'string', description: 'Base table for the data source (e.g. "MyTable").' },
  joinSource: {
    type: 'string',
    description: 'Optional existing data source on the form to join the new one to.',
  },
  linkType: {
    type: 'string',
    description:
      'Optional join/link type when joinSource is set: InnerJoin | OuterJoin | ExistJoin | NotExistJoin | ' +
      'Delayed | Active | Passive.',
  },
  // enum values
  enumValueName: { type: 'string', description: 'Enum value name (e.g. "Approved").' },
  enumValueNewName: {
    type: 'string',
    description: 'modify-enum-value: rename the value located by enumValueName to this.',
  },
  enumValueLabel: { type: 'string', description: 'Label reference (e.g. "@MyModel:Approved").' },
  enumValueHelpText: {
    type: 'string',
    description:
      'NOT WRITABLE — an enum value has no help text in the metamodel (AxEnumValue has no ' +
      'HelpText property). Kept only so passing it produces an explanation instead of a ' +
      'spelling suggestion. Use enumValueLabel, or set HelpText on the enum.',
  },
  enumValueInt: { type: 'number', description: 'Explicit integer value (omitted = next available).' },
  enumValueCountryRegionCodes: {
    type: 'string',
    description: 'ISO country/region codes, comma-separated (e.g. "CZ,SK").',
  },
  // menus
  menuItemToAdd: { type: 'string', description: 'Name of the menu item to add (e.g. "MyCustomForm").' },
  menuItemToAddType: {
    type: 'string (display | action | output)',
    description: 'Menu item kind: display (form), action (class), output (report). Default: display.',
  },
};

export interface D365FileOpSpec {
  /** Params whose absence makes the operation a guaranteed no-op (error). */
  required: string[];
  /** Params the operation understands beyond the required ones. */
  optional: string[];
  /**
   * Optional params of which AT LEAST ONE must be supplied for the operation to
   * mutate anything. Without one of them the op writes nothing, so reporting
   * success would be a lie (corpus finding #6: `modify-field {fieldName,
   * mandatory:true}` returned "✅ Field 'Description' modified" while the wrong
   * key meant nothing was written).
   */
  mutationOneOf?: string[];
  /** Op-level guidance that used to live in the published schema. */
  note?: string;
}

/**
 * A required param may be satisfied by an alias instead
 * (e.g. add-method accepts methodCode in place of sourceCode).
 */
export const OP_PARAM_ALIASES: Record<string, string[]> = {
  sourceCode: ['methodCode'],
};

/** Per-operation parameter specs for ALL d365fo_file [modify] operations. */
export const D365FO_FILE_OP_SPECS: Record<string, D365FileOpSpec> = {
  'add-method': {
    required: ['methodName', 'sourceCode'],
    optional: ['methodModifiers', 'methodReturnType', 'methodParameters'],
    note:
      'Adds OR updates in place when the method name exists (position preserved). methodName is derived ' +
      'from the source signature when omitted. sourceCode may carry several methods at once.',
  },
  'remove-method': { required: ['methodName'], optional: [] },
  'replace-code': {
    required: ['oldCode', 'newCode'],
    optional: ['methodName'],
    note:
      'Surgical oldCode→newCode replacement — NOT sourceCode/methodCode. Preferred for rewriting a known ' +
      'method. Form control overrides: methodName="ControlName.methodName".',
  },
  'add-field': {
    required: ['fieldName'],
    optional: ['fieldType', 'fieldBaseType', 'fieldEnumType', 'fieldMandatory', 'fieldLabel', 'dataField', 'dataSource', 'fieldGroupName', 'autoCorrect'],
    mutationOneOf: ['fieldType', 'fieldEnumType', 'dataField'],
    note:
      'Enum field: pass fieldEnumType="<enum name>" and NO fieldType — an enum-typed table field ' +
      'is an AxTableFieldEnum with an EnumType and needs no EDT. (fieldType is the EDT name here, ' +
      'never an XML element name like "AxTableFieldEnum" — that one is read as fieldEnumType when the ' +
      'enum is unambiguous, unless autoCorrect=false.) ' +
      'Table/table-extension: otherwise fieldType (EDT) is REQUIRED. data-entity-extension: pass dataField AND ' +
      'dataSource instead — BOTH, or nothing is written; a mapped field has no EDT of its own, it points ' +
      'at dataField on the entity data source dataSource. fieldGroupName is optional and only applies to ' +
      'a data-entity-extension: it appends the field to that BASE-entity field group (shipped extensions ' +
      'use AutoReport). It is not defaulted — a group the base entity does not have is a compile error.',
  },
  'modify-field': {
    required: ['fieldName'],
    optional: ['fieldType', 'fieldMandatory', 'fieldLabel', 'fieldHelpText', 'fieldEnumType', 'fieldStringSize'],
    mutationOneOf: ['fieldType', 'fieldMandatory', 'fieldLabel', 'fieldHelpText', 'fieldEnumType', 'fieldStringSize'],
  },
  'rename-field': {
    required: ['fieldName', 'fieldNewName'],
    optional: [],
    note: 'Also fixes index DataField refs and TitleField1/2.',
  },
  'remove-field': { required: ['fieldName'], optional: [] },
  'replace-all-fields': {
    required: ['fields'],
    optional: [],
    note: 'Atomic rewrite of ALL fields (corrupted field names).',
  },
  'add-display-method': {
    required: ['methodName', 'sourceCode'],
    optional: ['displayMethodReturnEdt'],
    note:
      'Display method with [SysClientCacheDataMethodAttribute]. Pass methodName + displayMethodReturnEdt ' +
      'to auto-generate a stub INSTEAD of sourceCode, or methodName + sourceCode for a custom body.',
  },
  'add-table-method': {
    required: ['methodName', 'sourceCode'],
    optional: ['tableMethodType', 'tableKeyField'],
    note:
      'Canonical find/exist/findByRecId/validateWrite/validateDelete/initValue boilerplate. Pass ' +
      'tableMethodType (+ tableKeyField for find/exist) to auto-generate INSTEAD of methodName+sourceCode.',
  },
  'add-index': {
    required: ['indexName', 'indexFields'],
    optional: ['indexAllowDuplicates', 'indexAlternateKey', 'indexEnabled'],
  },
  'remove-index': { required: ['indexName'], optional: [] },
  'add-full-text-index': {
    required: ['indexName', 'indexFields'],
    optional: [],
    note: '<FullTextIndexes> is a separate collection from <Indexes> with its own element type — add-index cannot reach it. Table and table-extension.',
  },
  'remove-full-text-index': { required: ['indexName'], optional: [] },
  'add-table-mapping': {
    required: ['mapName'],
    optional: ['mappingTable', 'mappingConnections'],
    note: 'Records that the table takes part in an AxMap. mapName is the MAP; each connection pairs mapField (on the map) with mapFieldTo (on this table). Table and table-extension.',
  },
  'remove-table-mapping': { required: ['mapName'], optional: [] },
  'add-relation': {
    required: ['relationName', 'relatedTable'],
    optional: ['relationConstraints', 'relationCardinality', 'relatedTableCardinality', 'relationshipType'],
  },
  'remove-relation': { required: ['relationName'], optional: [] },
  'add-delete-action': {
    required: ['deleteActionName'],
    optional: ['deleteActionTable', 'deleteActionType'],
    note: 'objectType="table" only. deleteActionTable defaults to deleteActionName; deleteActionType defaults to Restricted.',
  },
  'remove-delete-action': { required: ['deleteActionName'], optional: [] },
  'add-field-group': {
    required: ['fieldGroupName'],
    optional: ['fieldGroupFields', 'fieldGroupLabel'],
  },
  'remove-field-group': { required: ['fieldGroupName'], optional: [] },
  'add-field-to-field-group': {
    required: ['fieldGroupName', 'fieldName'],
    optional: ['extendBaseFieldGroup', 'autoCorrect'],
    note:
      'table-extension: a group owned by the BASE table is detected and extended through ' +
      '<FieldGroupExtensions> on its own (reported as a Note) — pass extendBaseFieldGroup=true to state ' +
      'it up front, or autoCorrect=false to have the mismatch error instead.',
  },
  'add-field-modification': {
    required: ['fieldName'],
    optional: ['fieldLabel', 'fieldMandatory'],
    note: 'table-extension only: override a base-table field\'s label/mandatory.',
  },
  'add-data-source': {
    required: ['dataSourceName', 'dataSourceTable'],
    optional: ['joinSource', 'linkType'],
    note: 'form-extension only.',
  },
  'add-control': {
    required: ['controlName', 'parentControl'],
    optional: [
      'controlDataSource', 'controlDataField', 'controlType', 'controlLabel',
      'positionType', 'previousSibling', 'baseFormName',
    ],
    note: 'objectType="form": parentControl="Design" adds the control at the TOP LEVEL of the '
      + 'form design — use it for the first control on a form whose design is still empty. '
      + 'Otherwise pass the exact name of an existing container (Tab, TabPage, Group, Grid).',
  },
  'add-enum-value': {
    required: ['enumValueName'],
    optional: ['enumValueLabel', 'enumValueHelpText', 'enumValueInt', 'enumValueCountryRegionCodes'],
  },
  'modify-enum-value': {
    required: ['enumValueName'],
    optional: ['enumValueNewName', 'enumValueLabel', 'enumValueInt'],
    mutationOneOf: ['enumValueNewName', 'enumValueLabel', 'enumValueInt'],
  },
  'remove-enum-value': { required: ['enumValueName'], optional: [] },
  'add-menu-item-to-menu': {
    required: ['menuItemToAdd'],
    optional: ['menuItemToAddType'],
  },
  'modify-property': { required: ['propertyPath', 'propertyValue'], optional: [] },
};

/**
 * Per-objectType `properties` contract for d365fo_file [create], keyed by the
 * objectType enum value. Moved out of the published inputSchema (issue #825):
 * inlining all 19 contracts cost ~2.4 KB on EVERY request while any one call
 * needs exactly one of them. Fetched on demand through the op-spec lookup —
 * see renderCreatePropertySpec / src/tools/opSpecs.ts.
 *
 * Text is the contract verbatim as it was advertised; objectTypes absent here
 * take no `properties` beyond objectName/sourceCode.
 */
export const D365FO_FILE_CREATE_PROPERTY_SPECS: Record<string, string> = {
  class: 'extends, implements, isFinal, isAbstract',
  table:
    'label, tableGroup, tableType, titleField1/2, cacheLookup?, primaryIndex?, ' +
    'allowRowVersionChangeTracking? (dual-write), created/modifiedBy/DateTime?, ' +
    'fields[{name,type?|edt?|fieldType?,enumType?,label?,mandatory?}] — enum fields need enumType ' +
    '(+ optionally fieldType:"AxTableFieldEnum")',
  enum: 'label, useEnumValue, configurationKey, isExtensible, enumValues[{name,value?,label?,helpText?}]',
  'enum-extension': 'enumValues[{name,label?,value?,countryRegionCodes?}]',
  'table-extension':
    'fields[{name,edt?,enumType?,label?,mandatory?,fieldType?}] — enum fields need ' +
    'fieldType:"AxTableFieldEnum" + enumType',
  edt: 'label, extends, edtType, stringSize',
  'edt-extension':
    'label?, helpText?, stringSize?, extends?, formHelp?, propertyModifications?[{name,value}] = the change',
  form: 'caption, formTemplate, dataSource',
  'security-privilege':
    'label, targetObject, objectType (MenuItemDisplay|Action|Output), accessLevel (view|maintain), ' +
    'dataEntity (grants perms)',
  'security-duty': 'label, privileges[]',
  'security-role': 'label, duties[], privileges[]',
  'menu-item-display': 'label, object, objectType',
  'menu-item-action': 'label, object, objectType',
  'menu-item-output': 'label, object, objectType',
  'data-entity':
    'primaryTable, fields[{name,dataField?}], primaryKey?, primaryKeyFields?[], isPublic?, ' +
    'entityCategory?, dynamicFields?, allowRowVersionChangeTracking? (dual-write: set on the source ' +
    'TABLES too), dataManagementEnabled? (needs staging table)',
  map:
    'label?, developerDocumentation?, fields[{name,type?,edt?,enumType?,stringSize?}], mappingTable?, ' +
    'mappings?[{mapField,mapFieldTo}] (one connection/field by default)',
  query: 'title?, dataSource (root table; table also works), dataSourceName?, fields?[{name,field?}]',
  view: 'query (existing AxQuery), fields[{name,dataField?}] — dataSource defaults to query',
  service:
    'serviceClass (defaults to the service name), externalName?, namespace?, description?, ' +
    'operations["opName"] or [{name?,method?,enableIdempotence?,subscriberAccessLevelRead?}]\n' +
    '  ⚠ CROSS-REFS (serviceClass) are written VERBATIM — only objectName is prefixed. Pass the FINAL ' +
    'name (e.g. "ContosoDemoNoteService", not "DemoNoteService").',
  'service-group':
    'autoDeploy? (Yes publishes at /api/services), description?, services["MyService"] or [{name?,service?}]\n' +
    '  ⚠ CROSS-REFS (services[].service) are written VERBATIM — only objectName is prefixed. Pass the ' +
    'FINAL name or the group resolves to nothing; verbatim also lets it reference an unprefixed MS service.',
};

/**
 * Full `properties` contract for one [create] objectType — the create-side twin
 * of renderOpSpec(), used by the op-spec lookup and by create-path errors.
 */
export function renderCreatePropertySpec(objectType: string): string {
  const spec = D365FO_FILE_CREATE_PROPERTY_SPECS[objectType];
  if (!spec) {
    return (
      `objectType '${objectType}' takes no extra \`properties\` beyond objectName/sourceCode ` +
      `(or is not a d365fo_file objectType). Types that do: ` +
      `${Object.keys(D365FO_FILE_CREATE_PROPERTY_SPECS).join(', ')}.`
    );
  }
  return (
    `d365fo_file(action="create", objectType="${objectType}") \`properties\` contract — ` +
    `pass these NESTED inside \`properties\`:\n  ${spec}`
  );
}

/**
 * Params every modify call accepts regardless of operation (routing, file
 * resolution, project/backup handling). Anything outside this set and outside
 * the operation's own spec is not consumed by the operation.
 */
export const D365FO_FILE_CORE_PARAMS: ReadonlySet<string> = new Set([
  // routing / dispatch
  'action', 'params', 'operation', 'objectType', 'objectName',
  // file + model resolution
  'filePath', 'workspacePath', 'modelName', 'model', 'packageName', 'packagePath',
  // side options
  'createBackup', 'addToProject', 'projectPath', 'solutionPath', 'groundingToken',
  'autoCorrect',
]);

/**
 * Params an operation ADVERTISES but the write path does not actually serialise.
 * They must never be accepted in silence — the caller has to learn that the
 * value did not reach the XML (corpus cluster #35).
 *
 * Keep this list empty-by-default: an entry here is a confession, not a design.
 * An entry is either a pending VM-side (C#) task or — as with the one below — a
 * parameter the metamodel cannot express at all, in which case the note says so
 * instead of promising a fix that will never come.
 */
export const OP_UNHONOURED_PARAMS: Record<string, Record<string, string>> = {
  'add-enum-value': {
    enumValueHelpText:
      'an enum VALUE has no help text in the D365FO metamodel. Verified by reflection on this ' +
      "platform (7.0.7858.27): AxEnumValue exposes Name, Tags, Label, ConfigurationKey, Value, " +
      'CountryRegionCodes, FeatureClass — and no HelpText; only the AxEnum itself has Help/HelpText. ' +
      'Real AOT enum XML agrees. Use enumValueLabel for the value, or set HelpText on the enum.',
  },
};

/** One parameter the caller supplied that the operation will not consume. */
export interface IgnoredParam {
  name: string;
  /**
   * unknown      — not a parameter of ANY operation (usually a misspelling)
   * other-op     — a real parameter, but not one this operation reads
   * not-honoured — accepted by this operation, but never written (see OP_UNHONOURED_PARAMS)
   */
  reason: 'unknown' | 'other-op' | 'not-honoured';
  /** Closest parameter of THIS operation, when the name looks like a near-miss. */
  suggestion?: string;
  /** Why the value is dropped (for 'not-honoured'). */
  detail?: string;
}

/** Every parameter name known to any operation (plus aliases). */
function allKnownParamNames(): Set<string> {
  const names = new Set<string>(Object.keys(D365FO_FILE_PARAM_SPECS));
  for (const spec of Object.values(D365FO_FILE_OP_SPECS)) {
    for (const p of [...spec.required, ...spec.optional]) names.add(p);
  }
  for (const aliases of Object.values(OP_PARAM_ALIASES)) {
    for (const a of aliases) names.add(a);
  }
  return names;
}

/** Params this operation reads, including aliases of its required params. */
function opParamNames(operation: string): string[] {
  const spec = D365FO_FILE_OP_SPECS[operation];
  if (!spec) return [];
  const names = [...spec.required, ...spec.optional];
  for (const p of spec.required) names.push(...(OP_PARAM_ALIASES[p] ?? []));
  return names;
}

/**
 * Near-miss suggestion for an unrecognised key: `mandatory` → `fieldMandatory`,
 * `allowDuplicates` → `indexAllowDuplicates`, `alternateKey` → `indexAlternateKey`.
 * Only suffix/prefix containment is used — no fuzzy distance guessing.
 */
function suggestParam(operation: string, key: string): string | undefined {
  const k = key.toLowerCase();
  const candidates = opParamNames(operation);
  return (
    candidates.find(p => p.toLowerCase() === k) ??
    candidates.find(p => p.toLowerCase().endsWith(k)) ??
    candidates.find(p => k.endsWith(p.toLowerCase()))
  );
}

/**
 * Parameters the caller supplied that the operation will NOT consume.
 *
 * The wire schema advertises a free-form `params` object and the Zod schema
 * strips unknown keys, so a misspelled or misplaced parameter used to vanish
 * without a trace and the op still answered "✅". Everything this returns must
 * be surfaced to the caller.
 */
export function findIgnoredParams(
  operation: string,
  providedKeys: readonly string[],
): IgnoredParam[] {
  if (!D365FO_FILE_OP_SPECS[operation]) return [];
  const known = allKnownParamNames();
  const mine = new Set(opParamNames(operation));
  const unhonoured = OP_UNHONOURED_PARAMS[operation] ?? {};

  const ignored: IgnoredParam[] = [];
  for (const key of providedKeys) {
    if (D365FO_FILE_CORE_PARAMS.has(key)) continue;
    if (mine.has(key)) {
      if (unhonoured[key]) ignored.push({ name: key, reason: 'not-honoured', detail: unhonoured[key] });
      continue;
    }
    ignored.push({
      name: key,
      reason: known.has(key) ? 'other-op' : 'unknown',
      suggestion: suggestParam(operation, key),
    });
  }
  return ignored;
}

/** Human-readable warning block for ignored params (empty string when none). */
export function renderIgnoredParamsWarning(operation: string, ignored: readonly IgnoredParam[]): string {
  if (ignored.length === 0) return '';
  const lines = ignored.map(p => {
    if (p.reason === 'not-honoured') {
      return `  ⚠️ ${p.name}: NOT WRITTEN — ${p.detail}`;
    }
    const what = p.reason === 'unknown'
      ? 'not a recognised d365fo_file parameter'
      : `not read by operation '${operation}'`;
    const hint = p.suggestion ? ` — did you mean '${p.suggestion}'?` : '';
    return `  ⚠️ ${p.name}: IGNORED (${what})${hint}`;
  });
  return [
    `⚠️ ${ignored.length} parameter(s) did not reach the written XML:`,
    ...lines,
    `The value(s) above were NOT applied. Re-run with the correct parameter name(s).`,
  ].join('\n');
}

/**
 * Reports that an operation was called with none of the params that would make
 * it mutate anything (see D365FileOpSpec.mutationOneOf). Returns the list of
 * candidate params, or [] when the call is fine.
 */
export function findMissingMutationParams(
  operation: string,
  providedKeys: readonly string[],
): string[] {
  const oneOf = D365FO_FILE_OP_SPECS[operation]?.mutationOneOf;
  if (!oneOf || oneOf.length === 0) return [];
  const provided = new Set(providedKeys);
  return oneOf.some(p => provided.has(p)) ? [] : [...oneOf];
}

/** Required params for an operation ([] for unknown ops — matches old paramHints). */
export function getRequiredParams(operation: string): string[] {
  return D365FO_FILE_OP_SPECS[operation]?.required ?? [];
}

function renderParamLine(name: string, marker: string): string {
  const spec = D365FO_FILE_PARAM_SPECS[name];
  if (!spec) return `  ${marker} ${name}`;
  const aliasNote = OP_PARAM_ALIASES[name]?.length ? ` (alias: ${OP_PARAM_ALIASES[name].join(', ')})` : '';
  return `  ${marker} ${name} (${spec.type})${aliasNote}: ${spec.description}`;
}

/**
 * Full parameter spec for one operation — names, types, descriptions — used in
 * error messages so a failed call carries everything needed to retry correctly.
 */
export function renderOpSpec(operation: string): string {
  const op = D365FO_FILE_OP_SPECS[operation];
  if (!op) return `Unknown operation '${operation}'. Valid operations: ${Object.keys(D365FO_FILE_OP_SPECS).join(', ')}.`;
  const lines = [
    // The published schema no longer carries op params (issue #825), so every
    // spec names the lookup that returns it — otherwise the only way to see the
    // contract is to fail a call first.
    `(Fetch this spec any time with get_knowledge(kind="op-spec", topic="${operation}").)`,
    `Parameter spec for operation '${operation}' — pass these NESTED inside \`params\`. ` +
    `(Flat top-level keys still work for a few legacy names, but do not rely on it: strict MCP clients ` +
    `validate against the base wire schema and drop anything undeclared before it reaches this server, ` +
    `which then surfaces as a "required parameters missing" error that names the wrong cause.)`,
    ...op.required.map(p => renderParamLine(p, 'REQUIRED')),
    ...op.optional.map(p => renderParamLine(p, 'optional')),
  ];
  if (op.note) lines.push(`Note: ${op.note}`);
  return lines.join('\n');
}
