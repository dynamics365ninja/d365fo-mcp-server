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
  fieldEnumType: { type: 'string', description: 'Enum name to set on an enum-typed field.' },
  fieldStringSize: { type: 'string', description: 'String size to set on a string-typed field.' },
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
  relationCardinality: {
    type: 'string',
    description: 'Local-side cardinality: ZeroMore | ZeroOne | ExactlyOne (default: ZeroMore).',
  },
  relatedTableCardinality: {
    type: 'string',
    description: 'Related-side cardinality: ZeroMore | ZeroOne | ExactlyOne (default: ExactlyOne).',
  },
  relationshipType: {
    type: 'string',
    description: 'Association | Composition | Aggregation | Link | Specialization (default: Association).',
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
  enumValueLabel: { type: 'string', description: 'Label reference (e.g. "@MyModel:Approved").' },
  enumValueHelpText: { type: 'string', description: 'Help-text reference (optional).' },
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
    required: ['fieldName', 'fieldType'],
    optional: ['fieldBaseType', 'fieldMandatory', 'fieldLabel'],
  },
  'modify-field': {
    required: ['fieldName'],
    optional: ['fieldType', 'fieldMandatory', 'fieldLabel', 'fieldHelpText', 'fieldEnumType', 'fieldStringSize'],
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
  'add-relation': {
    required: ['relationName', 'relatedTable'],
    optional: ['relationConstraints', 'relationCardinality', 'relatedTableCardinality', 'relationshipType'],
  },
  'remove-relation': { required: ['relationName'], optional: [] },
  'add-field-group': {
    required: ['fieldGroupName'],
    optional: ['fieldGroupFields', 'fieldGroupLabel'],
  },
  'remove-field-group': { required: ['fieldGroupName'], optional: [] },
  'add-field-to-field-group': {
    required: ['fieldGroupName', 'fieldName'],
    optional: ['extendBaseFieldGroup'],
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
    optional: ['enumValueLabel', 'enumValueInt'],
  },
  'remove-enum-value': { required: ['enumValueName'], optional: [] },
  'add-menu-item-to-menu': {
    required: ['menuItemToAdd'],
    optional: ['menuItemToAddType'],
  },
  'modify-property': { required: ['propertyPath', 'propertyValue'], optional: [] },
};

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
    `Parameter spec for operation '${operation}' (pass inside \`params\` or flat at top level):`,
    ...op.required.map(p => renderParamLine(p, 'REQUIRED')),
    ...op.optional.map(p => renderParamLine(p, 'optional')),
  ];
  if (op.note) lines.push(`Note: ${op.note}`);
  return lines.join('\n');
}
