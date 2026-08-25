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
  fieldLabel: {
    type: 'string',
    description:
      'Field label. On an ENUM field it must be a different label ID than the enum\'s own label — ' +
      'BPErrorFieldLabelIsCopyOfEnumLabel rejects the copy. Same visible text is fine, so create both ' +
      'IDs in the one labels(action="create", labels=[…]) batch that creates the enum labels.',
  },
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
      'add-control: name of the new form control — MUST match the field name in the table extension so ' +
      'the binding works. remove-control: <Name> of the existing control to delete, at any depth in the ' +
      'design.',
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
    description:
      'AfterItem (needs previousSibling) | Begin | End. Omit to append at the end of the parent. ' +
      'These are the values D365FO form-extension metadata actually carries; anything else is refused.',
  },
  previousSibling: {
    type: 'string',
    description:
      'Name of the sibling control to position after. Implies positionType=AfterItem when that is omitted.',
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
  // add-query-range
  rangeField: {
    type: 'string',
    description: 'Field name to filter on (e.g. "IsActive"). Becomes <Field> in the range object.',
  },
  rangeName: {
    type: 'string',
    description:
      'Name for the range object (<Name>). Defaults to rangeField when omitted. ' +
      'Only ever matched against other ranges of the SAME data source.',
  },
  rangeValue: {
    type: 'string',
    description:
      'Filter value the range applies (e.g. "1" for a NoYes field, "Sales" for an enum, ' +
      '"1..99" for an interval). Required: a range with no value filters nothing. ' +
      'For the empty-string filter pass the two characters "" — that is how D365FO stores it.',
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
  removeSeparator: {
    type: 'boolean (default false)',
    description:
      'remove-control: also delete the adjacent AxFormButtonSeparatorControl — the sibling after the ' +
      'control, else the one before it. Removing a toolbar button usually orphans its separator, which ' +
      'then shows as a stray divider. Opt-in: a separator between two REMAINING buttons is load-bearing.',
  },
  // security privileges
  entryPointName: {
    type: 'string',
    description:
      '<Name> of the AxSecurityEntryPointReference to remove — conventionally the menu item name. ' +
      'This is the entry point ON the privilege, not the privilege itself (that is objectName).',
  },
  entryPointObjectName: {
    type: 'string',
    description:
      '<ObjectName> of the entry point — the menu item or service operation it grants access to. Use ' +
      'instead of entryPointName when the entry point carries a different <Name> than its target.',
  },
  entryPointObjectType: {
    type: 'string (MenuItemDisplay | MenuItemAction | MenuItemOutput | ServiceOperation | None)',
    description:
      '<ObjectType> (EntryPointType) of the entry point. REQUIRED on add-entry-point; on ' +
      'remove-entry-point only needed to disambiguate one ObjectName referenced through two ' +
      'entry-point types — two matches are refused, never guessed. A value outside the enum ' +
      'deserializes to nothing, so it is rejected rather than written.',
  },
  accessLevel: {
    type: 'string (view | read | maintain)',
    description:
      'add-entry-point: permissions the <Grant> carries. "view"/"read" grant Read; "maintain" grants ' +
      'Correct+Create+Delete+Read+Update (plus Invoke on a ServiceOperation). DEFAULTS to "view", so a maintain privilege must say so explicitly. ' +
      'Nothing else is accepted — "full"/"edit" used to be taken and silently degraded to Read-only.',
  },
  // BP-check suppressions
  diagnosticPath: {
    type: 'string',
    description:
      'remove-diagnostic-suppression: REQUIRED — exact <Path> of the <Diagnostic> to remove (e.g. ' +
      '"dynamics://Form/MyForm"), copied verbatim from the suppression entry. ' +
      'add-diagnostic-suppression: the dynamics:// path a BP-check finding was raised against — copy it ' +
      'verbatim from the finding when you have it (the only way to address a sub-element: a control, a ' +
      'field, a method, an enum value). Preferred over diagnosticElementType + diagnosticElementName, which ' +
      'can only derive a path to a whole top-level object. This is the same value ' +
      'get_knowledge(kind="bp-moniker", action="suppress") renders it from.',
  },
  diagnosticMoniker: {
    type: 'string',
    description:
      'remove-diagnostic-suppression: <Moniker> of the suppression to remove. Only needed when the same ' +
      'diagnosticPath carries more than one <Diagnostic> (two different rules ignored on the same target) ' +
      '— two matches on path alone are refused, never guessed. ' +
      'add-diagnostic-suppression: REQUIRED — the BP moniker being suppressed, validated against the known ' +
      'catalog (e.g. "BPErrorPrivilegeNotCoveredByDuty").',
  },
  diagnosticElementType: {
    type: 'string (AxClass | AxTable | AxForm | AxView | AxMap | AxEnum | AxQuerySimple | ' +
      'AxDataEntityView | AxSecurityPrivilege | AxSecurityDuty | AxSecurityRole | AxTableExtension | ' +
      'AxFormExtension | AxMenuExtension | AxMenu | AxMenuItemDisplay | AxMenuItemAction | ' +
      'AxMenuItemOutput | AxEdtString | AxEdtInt | … | AxConfigurationKey | AxLicenseCode)',
    description:
      'add-diagnostic-suppression: top-level AOT element type of the object the finding was raised against ' +
      '— used with diagnosticElementName to DERIVE diagnosticPath when it is not given directly. Only ' +
      'addresses a whole object; a sub-element needs diagnosticPath verbatim from the finding instead.',
  },
  diagnosticElementName: {
    type: 'string',
    description:
      'add-diagnostic-suppression: name of the object the finding was raised against, paired with ' +
      'diagnosticElementType to derive diagnosticPath.',
  },
  diagnosticJustification: {
    type: 'string',
    description:
      'add-diagnostic-suppression: why this warning is being ignored. Omitting it writes an obvious TODO ' +
      'placeholder plus a warning — a suppression with no stated reason is what a reviewer rejects.',
  },
  diagnosticMessage: {
    type: 'string',
    description:
      'add-diagnostic-suppression: the real message text from the BP-check finding, if known. Never ' +
      'invented when omitted — <Message> is simply left off, which is normal (absent from most real entries).',
  },
  diagnosticSeverity: {
    type: 'string (Error | Warning)',
    description: 'add-diagnostic-suppression: <Severity> of the diagnostic being suppressed. Default: Warning.',
  },
  diagnosticItemSpecific: {
    type: 'boolean (default false)',
    description:
      'add-diagnostic-suppression: emit the <ItemSpecific> block — rare, only for element-specific rules ' +
      '(BPErrorUnknownLabel, BPXmlDoc*, BPErrorPrivilegeNotCoveredByDuty, …). Requires diagnosticElementName.',
  },
  // Alias spellings (see OP_PARAM_ALIASES). They never appear as their own line
  // in a rendered spec - renderOpSpec walks required/optional only - but every
  // alias must be describable, so the registry guard can prove none is a typo.
  parent: { type: 'string', description: 'Alias of parentControl (as printed by get_object_info form control search).' },
  after: { type: 'string', description: 'Alias of previousSibling (as printed by get_object_info form control search).' },
  edt: { type: 'string', description: 'Alias of fieldType - the element-level spelling used by fields[{ name, edt, type }].' },
  type: { type: 'string', description: 'Alias of fieldBaseType - the element-level spelling used by fields[{ name, edt, type }].' },
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
 *
 * The alias is also RENAMED to its canonical spelling before the modify args are
 * validated (see normalizeModifyArgs in write/modifyD365File.ts), so an alias is
 * a working parameter and not merely a name that suppresses a warning. That
 * rename fires only when the canonical param is declared by the operation and
 * was not supplied itself, which is why an alias may safely stand for an
 * OPTIONAL param too — `opParamNames` below only expands aliases of REQUIRED
 * ones, since that is all the required-satisfaction check needs.
 *
 * Why these four, all measured:
 *   • parent / after — get_object_info(form, options.searchControl) renders a
 *     usage hint saying `parent="…"` / `after="…"`, which add-control did not
 *     accept (it wants parentControl / previousSibling). Following the tool's
 *     own hint cost a guaranteed retry, so the hint was fixed AND the older
 *     spelling kept working.
 *   • edt / type — the element-level spelling of a field's parts, as used by
 *     `fields:[{ name, edt, type }]` here and by create's `properties.fields`.
 *     A caller that flattens one such element into `params` sends {name, edt,
 *     type}: live probe, add-field {name:"Note2", edt:"Notes"} wrote nothing and
 *     returned the full 3,000-char spec. (`name` is not listed here — the
 *     did-you-mean the server already computes resolves it to fieldName.)
 */
export const OP_PARAM_ALIASES: Record<string, string[]> = {
  sourceCode: ['methodCode'],
  parentControl: ['parent'],
  previousSibling: ['after'],
  fieldType: ['edt'],
  fieldBaseType: ['type'],
};

/**
 * The canonical param an alias key stands for on THIS operation, or undefined.
 *
 * Deliberately checks the operation's own declared params (required AND
 * optional) rather than opParamNames(): an alias is only meaningful where the
 * canonical parameter is something the operation actually reads.
 */
export function canonicalParamForAlias(operation: string, key: string): string | undefined {
  const spec = D365FO_FILE_OP_SPECS[operation];
  if (!spec) return undefined;
  for (const [canonical, aliases] of Object.entries(OP_PARAM_ALIASES)) {
    if (!aliases.includes(key)) continue;
    if (spec.required.includes(canonical) || spec.optional.includes(canonical)) return canonical;
  }
  return undefined;
}

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
      'it up front, or autoCorrect=false to have the mismatch error instead. ' +
      'fieldName follows the prefix add-field applied: send both in one operations[] and the bare name is ' +
      'retargeted at the prefixed field (reported as a Note), unless the base table declares a field of ' +
      'that name too — then it is taken as naming the base-table field.',
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
  'add-query-range': {
    required: ['dataSourceName', 'rangeField', 'rangeValue'],
    optional: ['rangeName'],
    note:
      'objectType="data-entity" only. Adds an <AxQuerySimpleDataSourceRange> to the <Ranges> that the ' +
      'named data source OWNS inside <ViewMetadata>. dataSourceName is the <Name> of either the root ' +
      'data source (<AxQuerySimpleRootDataSource>, usually the primary table) or a joined one ' +
      '(<AxQuerySimpleEmbeddedDataSource>) — a joined data source keeps its own <Ranges>, and filtering ' +
      'the joined table is not the same query as filtering the root. ' +
      'rangeName defaults to rangeField when omitted. ' +
      'rangeValue is required (e.g. "1" to restrict to active rows); pass "" (two characters) for the ' +
      'empty-string filter. Idempotent per data source.',
  },
  'remove-query-range': {
    required: ['dataSourceName', 'rangeName'],
    optional: [],
    note:
      'objectType="data-entity" only. Removes the <AxQuerySimpleDataSourceRange> whose <Name> equals ' +
      'rangeName from the <Ranges> the named data source OWNS — a same-named range on a joined data ' +
      'source is left alone. Collapses <Ranges> to <Ranges /> when empty. Idempotent.',
  },
  'add-control': {
    required: ['controlName', 'parentControl'],
    optional: [
      'controlDataSource', 'controlDataField', 'controlType', 'controlLabel',
      'positionType', 'previousSibling', 'baseFormName',
    ],
    note: 'objectType="form": parentControl="Design" adds the control at the TOP LEVEL of the '
      + 'form design — use it for the first control on a form whose design is still empty. '
      + 'Otherwise pass the exact name of an existing container (Tab, TabPage, Group, Grid). '
      + 'objectType="form-extension": parentControl may name a base-form container OR a container '
      + 'the extension itself defines — the writer picks the right XML shape from which it is, so '
      + 'just pass the name. A BASE-FORM parent bound to a table field group via <DataGroup> is '
      + 'REFUSED: the compiler generates that group\'s members, so an explicit control collides — add '
      + 'the field to the field group instead (add-field-to-field-group) and refresh the group in the '
      + 'designer. On an EXTENSION-OWNED <DataGroup> parent the control IS written, with a warning: '
      + 'nothing tops that group up, so the explicit control is what puts the field on the form, and '
      + 'the field group entry is needed as well so a later designer Refresh does not discard it. '
      + 'previousSibling works under either parent — under an extension-defined parent it orders the '
      + 'control in the XML, under a base-form parent it is written as '
      + '<PositionType>AfterItem</PositionType> + <PreviousSibling>.',
  },
  'remove-control': {
    required: ['controlName'],
    optional: ['removeSeparator'],
    note:
      'objectType="form" or "form-extension". Removes the control WHEREVER it sits in the design — '
      + 'controls nest (ActionPane → ButtonGroup → Button), so no parentControl is needed. '
      + 'On a form-extension the whole <AxFormExtensionControl> envelope goes, not just its '
      + '<FormControl>: an envelope without its control is a <Parent> reference to nothing. '
      + 'A control the form SHOWS but does not DEFINE belongs to the base form and is reported as '
      + 'not found — a form extension cannot delete a base control, only hide it '
      + '(modify-property Visible=No on a control extension). Emptying a <Controls> collection '
      + 'collapses it to <Controls />, the spelling the serializer uses.',
  },
  'add-entry-point': {
    required: ['entryPointObjectName', 'entryPointObjectType'],
    optional: ['entryPointName', 'accessLevel'],
    note:
      'objectType="security-privilege". Adds one <AxSecurityEntryPointReference> — the block that ' +
      'grants a menu item or service operation through this privilege. create takes only ONE entry ' +
      'point (properties.targetObject), so this is how a privilege gets a second: without it the only ' +
      'route was create(overwrite=true, xmlContent=...), i.e. hand-authored XML. ' +
      'entryPointObjectType is a CLOSED enum (MenuItemDisplay | MenuItemAction | MenuItemOutput | ' +
      'ServiceOperation | None) — an unknown value deserializes to nothing, so the privilege would ' +
      'build clean, pass BP and grant access to no object at all. ' +
      'entryPointName defaults to entryPointObjectName (they are equal in 910 of the 1036 shipped ' +
      'entry points). accessLevel is "view"/"read" (Read) or "maintain" (Correct+Create+Delete+Read+Update, plus Invoke on a ServiceOperation); ' +
      'it defaults to "view", so pass "maintain" explicitly for a maintain privilege. ' +
      'Idempotent on the entry point <Name>.',
  },
  'remove-entry-point': {
    required: [],
    optional: ['entryPointName', 'entryPointObjectName', 'entryPointObjectType'],
    mutationOneOf: ['entryPointName', 'entryPointObjectName'],
    note:
      'objectType="security-privilege". Removes one <AxSecurityEntryPointReference> — the block that '
      + 'grants a menu item through this privilege. Identify it by entryPointName, or by '
      + 'entryPointObjectName (+ entryPointObjectType when the same object is referenced through two '
      + 'entry-point types). Two matches are REFUSED rather than resolved: removing the wrong entry '
      + 'point revokes access to a different object, builds clean, and only surfaces as a user losing '
      + 'a form. Removing the last one collapses <EntryPoints> to <EntryPoints />. '
      + 'A privilege left with no entry points and no data-entity permissions grants nothing — delete '
      + 'it with d365fo_file(action="delete") and drop its BP suppression entry.',
  },
  'remove-diagnostic-suppression': {
    required: ['diagnosticPath'],
    optional: ['diagnosticMoniker'],
    note:
      'objectType="ignore-diagnostic-list". Removes one <Diagnostic> from a {Model}_BPSuppressions.xml ' +
      '— objectName is the file\'s own base name, "{Model}_BPSuppressions" (or pass filePath). Identify ' +
      'the entry by diagnosticPath, the exact <Path> a BP-check finding was suppressed against; add ' +
      'diagnosticMoniker when the same path carries more than one suppressed rule. Two matches on path ' +
      'alone are REFUSED rather than resolved: removing the wrong one leaves a live finding silenced. ' +
      'Removing the last entry collapses <Items> to <Items />. ' +
      'd365fo_file(action="delete") already strips suppressions whose <Path> targets the deleted object ' +
      '— use this operation for suppressions left stale by other means (a moniker fixed in code, a ' +
      'renamed sub-element).',
  },
  'add-diagnostic-suppression': {
    required: ['diagnosticMoniker'],
    optional: [
      'diagnosticPath', 'diagnosticElementType', 'diagnosticElementName',
      'diagnosticJustification', 'diagnosticMessage', 'diagnosticSeverity', 'diagnosticItemSpecific',
    ],
    note:
      'objectType="ignore-diagnostic-list". Adds one <Diagnostic> to a {Model}_BPSuppressions.xml — ' +
      'objectName is the file\'s own base name, "{Model}_BPSuppressions" (or pass filePath). Needs ' +
      'diagnosticMoniker PLUS either diagnosticPath (verbatim from the finding — the only way to address ' +
      'a control/field/method/enum value) or diagnosticElementType + diagnosticElementName (derives a path ' +
      'to a whole top-level object only). Builds the <Diagnostic> the same way ' +
      'get_knowledge(kind="bp-moniker", action="suppress") does, so the two cannot describe two different ' +
      'shapes — that helper is now redundant for anyone with write access to the metadata; call this ' +
      'directly instead of rendering text to paste by hand. Refuses a duplicate (same diagnosticPath AND ' +
      'diagnosticMoniker already present) rather than writing a second copy. When the model has never ' +
      'suppressed anything before, {Model}_BPSuppressions.xml does not exist yet — this creates it and its ' +
      'AxIgnoreDiagnosticList folder, in the shape real shipped suppression lists have, and says so in the ' +
      'reply so you can add it to the model\'s .rnrproj if Visual Studio does not pick it up.',
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
  'modify-property': {
    required: ['propertyPath', 'propertyValue'],
    optional: ['controlName'],
    note:
      'controlName is for objectType="form-extension" ONLY, and it is what customises a control of ' +
      'the BASE form: the property goes to <ControlModifications>, the collection shipped extensions ' +
      'use for exactly this (83 of 416, Visible/Enabled/Caption/HelpText/Label/CountryRegionCodes). ' +
      'A dotted propertyPath ("MyGrid.Visible") is read the same way. WITHOUT a control the property ' +
      'is the EXTENSION\'s own — on a form extension that changes the WHOLE FORM, so hiding one ' +
      'control by omitting controlName hides the form instead. One envelope per control: a second ' +
      'property joins the existing one. Idempotent.',
  },
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
  enum:
    'label, useEnumValue, configurationKey, isExtensible, enumValues[{name,value?,label?,helpText?}] — ' +
    'an explicit value: sets UseEnumValue=Yes for you; an OFF-POSITIONAL one (a number differing from the ' +
    "entry's index) is refused when combined with isExtensible rather than dropped, since xppc requires " +
    'UseEnumValue=No and no <Value> on an extensible enum. Plain 0,1,2 numbering states nothing the order ' +
    'does not, so it is accepted and the numbers are dropped. ' +
    'CHOOSE isExtensible DELIBERATELY: it also bars `<`/`>`/`<=`/`>=` on the enum ("Cannot use extensible ' +
    'enumerated type in non-equality comparison"), so any enum whose values get RANKED in X++ — a tier, a ' +
    'severity, a no-downgrade check — must be isExtensible:false',
  'enum-extension': 'enumValues[{name,label?,value?,countryRegionCodes?}]',
  'table-extension':
    'fields[{name,edt?,enumType?,label?,mandatory?,fieldType?}] — enum fields need ' +
    'fieldType:"AxTableFieldEnum" + enumType',
  edt: 'label, extends, edtType, stringSize',
  'edt-extension':
    'label?, helpText?, stringSize?, extends?, formHelp?, propertyModifications?[{name,value}] = the change',
  form: 'caption, formTemplate, dataSource',
  'security-privilege':
    'label, targetObject, objectType (MenuItemDisplay|MenuItemAction|MenuItemOutput|ServiceOperation), ' +
    'accessLevel (view|read = Read only, maintain = Correct+Create+Delete+Read+Update, plus Invoke on a ServiceOperation — nothing else is accepted; "full"/"edit" ' +
    'used to degrade silently to Read-only), dataEntity (grants perms)',
  'security-duty': 'label, privileges[]',
  'security-role': 'label, duties[], privileges[]',
  'menu-item-display': 'label, object, objectType',
  'menu-item-action': 'label, object, objectType',
  'menu-item-output': 'label, object, objectType',
  'data-entity':
    'primaryTable + fields[{name,dataField?}] — BOTH REQUIRED (without them the entity has no query ' +
    'and returns no data, which builds clean; the create is refused instead), primaryKey?, ' +
    'primaryKeyFields?[], isPublic?, entityCategory? ' +
    '(Master|Configuration|Transaction|Reference|Document|Parameters — note the plural), ' +
    'dynamicFields?, allowRowVersionChangeTracking? (dual-write: set on the source ' +
    'TABLES too), dataManagementEnabled? (needs staging table)',
  map:
    'label?, developerDocumentation?, fields[{name,type?,edt?,enumType?,stringSize?}] — type is ' +
    'String|Integer|Int64|Real|Date|Time|UtcDateTime|Enum|Container|Guid (no Boolean: use Enum + ' +
    'enumType:"NoYes"), mappingTable?, mappings?[{mapField,mapFieldTo}] (one connection/field by default)',
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
  // Internal, injected by runModifyBatch — the operation names travelling in the
  // same operations[] batch, so an advisory note can tell whether its advice has
  // already been taken. It is absent from the published schema, so no caller can
  // send it; omitting it here made every batched entry report
  // "peerOperations: IGNORED (not a recognised d365fo_file parameter)" — the
  // exact false warning the batch flow exists to stop producing.
  'peerOperations',
  // Internal, injected by runModifyBatch — decisions only the BATCH can make:
  // which single entry prints the shared best-practice advisory and which fields
  // it covers. A 3-field batch printed the identical 350-char field-group
  // paragraph three times because each entry could only see itself.
  'batchAdvice',
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
 * Every param of this operation that `key` could plausibly be a misspelling of,
 * best tier first: exact (case-insensitive), then `param` ends with `key`
 * (`mandatory` → `fieldMandatory`), then `key` ends with `param`. Only
 * suffix/prefix containment is used — no fuzzy distance guessing.
 *
 * Returns only the BEST non-empty tier: a weaker match is not a rival candidate,
 * it is a worse one. Within that tier the order is required-params first, then
 * shortest name — which is what makes `name` on add-field resolve to `fieldName`
 * (required) rather than to `fieldGroupName`, so the correction the server prints
 * is also one it can safely apply.
 */
export function paramCorrectionCandidates(operation: string, key: string): string[] {
  const k = key.toLowerCase();
  const spec = D365FO_FILE_OP_SPECS[operation];
  const candidates = [...new Set(opParamNames(operation))];
  const tiers = [
    candidates.filter(p => p.toLowerCase() === k),
    candidates.filter(p => p.toLowerCase().endsWith(k)),
    candidates.filter(p => k.endsWith(p.toLowerCase())),
  ];
  const best = tiers.find(t => t.length > 0) ?? [];
  return [...best].sort((a, b) => {
    const ra = spec?.required.includes(a) ? 0 : 1;
    const rb = spec?.required.includes(b) ? 0 : 1;
    return ra !== rb ? ra - rb : a.length - b.length;
  });
}

/**
 * Near-miss suggestion for an unrecognised key: `mandatory` → `fieldMandatory`,
 * `allowDuplicates` → `indexAllowDuplicates`, `alternateKey` → `indexAlternateKey`.
 */
function suggestParam(operation: string, key: string): string | undefined {
  return paramCorrectionCandidates(operation, key)[0];
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
    // The published schema no longer carries op params (issue #825), so the spec
    // names the lookup that returns it — otherwise the only way to see the
    // contract is to fail a call first. Kept to one line: the rationale for why
    // flat keys fail was ~340 chars in front of every spec and changed nothing
    // the caller does about it.
    `Parameter spec for operation '${operation}' — pass these NESTED inside \`params\` ` +
    `(strict MCP clients drop undeclared top-level keys). ` +
    `Re-fetch: get_knowledge(kind="op-spec", topic="${operation}").`,
    ...op.required.map(p => renderParamLine(p, 'REQUIRED')),
    ...op.optional.map(p => renderParamLine(p, 'optional')),
  ];
  if (op.note) lines.push(`Note: ${op.note}`);
  return lines.join('\n');
}
