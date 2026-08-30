/**
 * generate_object mode parameter specs — the single source of truth for
 * mode-specific parameters (names, types, descriptions).
 *
 * The wire schema only advertises the discriminators (`mode`, `pattern`,
 * `objectType`, `name`, `modelName`) plus a free-form `params` object; inlining
 * all six modes' parameters cost ~7.5 KB on EVERY request while any one call
 * needs exactly one mode (issue #825). The contract is fetched on demand via
 * get_knowledge(kind="op-spec", topic="<mode>") and repeated in the error a
 * call gets when a required parameter is missing.
 *
 * The dispatcher merges `{...args, ...args.params}` so flat calls keep working.
 *
 * tests/tools/generateObjectOpSpecs.test.ts guards mode coverage.
 */

/** Type + description for a single generate_object parameter, keyed by name. */
export const GENERATE_OBJECT_PARAM_SPECS: Record<string, { type: string; description: string }> = {
  // shared identity / placement
  name: {
    type: 'string',
    description:
      'REQUIRED. [pattern] element name (extensions: base element; form-datasource/control-extension: ' +
      'the FORM name). [scaffold] object name WITHOUT model prefix. [find-methods|relation-xpp|fields|' +
      'table-relation] the existing table name.',
  },
  modelName: {
    type: 'string',
    description: 'Model name from .mcp.json (auto-detected if omitted). NEVER use placeholders like "MyModel".',
  },
  projectPath: { type: 'string', description: '[scaffold] Path to .rnrproj file for model extraction.' },
  solutionPath: { type: 'string', description: '[scaffold] Path to solution directory (alternative to projectPath).' },
  // mode=pattern
  pattern: {
    type: 'string',
    description:
      'REQUIRED. CoC skeletons: class/table-extension, form-handler, form-datasource-extension ' +
      '(name=FormName, baseName=DataSourceName), form-control-extension (name=FormName, baseName=ControlName), ' +
      'map-extension. ssrs-report-full = Contract+DP+Controller; service-class-ais = CRUD service + contract.',
  },
  menuItemType: {
    type: 'string (display | action | output)',
    description: 'For the menu-item pattern: kind of menu item (display=form, action=class, output=report).',
  },
  baseName: {
    type: 'string',
    description:
      'event-handler: base class/table. form-datasource-extension: data source name (defaults to form name). ' +
      'form-control-extension: exact control name (find via get_object_info(objectType="form")).',
  },
  targetObject: {
    type: 'string',
    description: 'For the menu-item and security-privilege patterns: target form/class/report name.',
  },
  testMethods: {
    type: 'string[]',
    description:
      'systest: target-class methods to write a test for — one [SysTestMethod] each. ' +
      'Every generated test fails until its assertion is written, which is what makes the ' +
      'first run meaningful. Read the method names from get_object_info(objectType="class").',
  },
  serviceMethod: {
    type: 'string',
    description: 'sysoperation: service method the Controller calls (default "process").',
  },
  // mode=scaffold
  objectType: { type: 'string (table | form | report)', description: 'REQUIRED. Kind of object to generate.' },
  label: { type: 'string', description: 'Optional label for the generated object.' },
  caption: {
    type: 'string',
    description: 'Optional caption/title (form: window title; report: human-readable report title). ' +
      'Pass a label ID ("@Module:LabelId") to also label the objects: for a report it becomes the ' +
      'Label of the tmp table and the output menu item. Prose titles the RDL header only — a Label ' +
      'property must hold a label ID, so anything else leaves those objects unlabelled rather than ' +
      'earning them a BPErrorLabelIsText.',
  },
  packagePath: { type: 'string', description: 'Base packages directory path.' },
  tableGroup: {
    type: 'string',
    description:
      'Business role (TableGroup enum): Main, Transaction, Parameter, Group, WorksheetHeader/WorksheetLine, ' +
      'Reference, Miscellaneous, Framework. ⛔ NEVER pass "TempDB"/"InMemory" here — that is tableType.',
  },
  tableType: {
    type: 'string',
    description: 'Storage type: Regular (default, omit), TempDB, InMemory. ⛔ NEVER pass as tableGroup.',
  },
  generateCommonFields: {
    type: 'boolean',
    description: 'Auto-generate common fields based on table group patterns.',
  },
  preview: { type: 'boolean', description: 'Return the XML without writing to disk.' },
  dataSource: { type: 'string', description: 'Table name for the primary datasource.' },
  formPattern: {
    type: 'string',
    description:
      'Form pattern: SimpleList, SimpleListDetails, DetailsMaster, DetailsTransaction, Dialog, DropDialog, ' +
      'TableOfContents, Lookup, ListPage, Workspace.',
  },
  cloneFrom: {
    type: 'string',
    description:
      'PREFERRED: clone a reference form\'s XML re-bound via tableMapping (methods stripped; fields missing ' +
      'on target tables dropped and reported).',
  },
  tableMapping: {
    type: 'object (string → string)',
    description: 'With cloneFrom: sourceTable → targetTable map, e.g. {"CustGroup": "MyRentalGroup"}.',
  },
  includeMethodStubs: {
    type: 'boolean',
    description: 'Inject pattern-appropriate lifecycle method stubs with TODO markers.',
  },
  generateControls: { type: 'boolean', description: 'Auto-generate grid controls for the datasource.' },
  fields: {
    type: 'array of {name, edt?, enumType?, type?, dataType?, label?, mandatory?}',
    description:
      'Structured field specs; takes priority over fieldsHint. PREFER for enum-backed fields or an explicit ' +
      'EDT — a bare name cannot express either. edt = explicit EDT (omit to auto-resolve from the name); ' +
      'enumType = enum name (AxTableFieldEnum); type = base type (String/Integer/Int64/Real/Date/UtcDateTime/' +
      'Guid); dataType = [scaffold:report] .NET type, e.g. "System.Double".',
  },
  contractParams: {
    type: 'array of {name, type?, label?, mandatory?}',
    description: 'Dialog parameters for the Contract class. type = X++ EDT or primitive (e.g. "TransDate").',
  },
  additionalDatasets: {
    type: 'array of {name, fieldsHint?, fields?}',
    description:
      'Multi-dataset report: each entry adds a TempDB TmpTable + a get<Table>() DP method. name = suffix ' +
      '("Header" → <Report>HeaderTmp).',
  },
  generateController: { type: 'boolean', description: 'Generate the Controller class (default: true).' },
  aotQuery: {
    type: 'string',
    description: 'AOT query name — DP gains [SRSReportQueryAttribute] and a query-based processReport() via this.parmQuery().',
  },
  callerTableName: {
    type: 'string',
    description: 'Caller record table (e.g. "CustTable") — Controller pre-fills the contract from args.record() in prePromptModifyContract().',
  },
  preProcess: {
    type: 'boolean',
    description: 'DP extends SrsReportDataProviderPreProcessTempDB (long-running reports: data staged on the AOS before the render request; TempDB pairing, [SRSReportParameterAttribute] kept, no extra hook method — processReport() is the pre-processing step).',
  },
  controllerType: {
    type: 'string',
    description: '"simple" (default — SrsReportRunController) or "printMgmt" (SrsPrintMgmtController with the abstract runPrintMgmt() implemented and an initPrintMgmtReportRun() whose PrintMgmtReportRun::construct(hierarchy, node, documentType) placeholders you replace — there is no parmPrintMgmtDocType).',
  },
  uiBuilder: {
    type: 'boolean',
    description: 'Also emit a <Name>UIBuilder class (extends SrsReportDataContractUIBuilder) and bind it on the contract via [SysOperationContractProcessing] — for custom dialog lookups/events.',
  },
  designStyle: {
    type: 'string',
    description: 'RDL design pattern: "SimpleList" (default) or "GroupedWithTotals".',
  },
  copyFrom: { type: 'string', description: 'Copy structure from an existing object (forms: prefer cloneFrom).' },
  fieldsHint: {
    type: 'string',
    description:
      'Comma-separated field names; EDTs auto-suggested from the index. ⚠️ EDTs/enums created this session ' +
      'are not yet indexed — call update_symbol_index first, else those fields default to String255.',
  },
  // mode=find-methods
  keyFields: {
    type: 'array of string',
    description: 'Explicit key field names (order matters); overrides index detection.',
  },
  includeExists: { type: 'boolean', description: 'Emit exists() (default true).' },
  includeFindRecId: { type: 'boolean', description: 'Emit findRecId() (default true).' },
  // mode=relation-xpp
  relationName: { type: 'string', description: 'One relation to convert. Omit = all relations.' },
  style: { type: 'string (select | query | both)', description: 'select | query | both (default).' },
  // mode=fields
  fieldGroup: {
    type: 'string',
    description: 'Field-group name — emits an AxTableFieldGroup listing the new fields.',
  },
};

export interface GenerateObjectModeSpec {
  /** Params whose absence makes the call a guaranteed error. */
  required: string[];
  /** Params the mode understands beyond the required ones. */
  optional: string[];
  /** Mode-level guidance that used to live in the published schema. */
  note?: string;
}

/**
 * Per-mode parameter specs. `scaffold` splits by objectType because the three
 * scaffolds share almost nothing — `scaffold:form` is the spec a form call needs.
 */
export const GENERATE_OBJECT_MODE_SPECS: Record<string, GenerateObjectModeSpec> = {
  pattern: {
    required: ['name', 'pattern'],
    optional: ['menuItemType', 'baseName', 'targetObject', 'serviceMethod', 'testMethods', 'modelName'],
    note:
      'Text only, no write. Call analyze_code(mode="patterns") first, then generate_object(mode="pattern"), ' +
      'then d365fo_file(action="create") to write the result.',
  },
  scaffold: {
    required: ['name', 'objectType'],
    optional: ['modelName', 'projectPath', 'solutionPath', 'copyFrom'],
    note:
      'objectType selects the scaffold; ask for the one you need — topic="scaffold:table", ' +
      '"scaffold:form" or "scaffold:report".',
  },
  'scaffold:table': {
    required: ['name'],
    optional: [
      'label', 'tableGroup', 'tableType', 'generateCommonFields', 'preview',
      'fields', 'fieldsHint', 'copyFrom', 'modelName', 'projectPath', 'solutionPath',
    ],
  },
  'scaffold:form': {
    required: ['name'],
    optional: [
      'caption', 'dataSource', 'formPattern', 'cloneFrom', 'tableMapping',
      'includeMethodStubs', 'generateControls', 'label', 'copyFrom',
      'modelName', 'projectPath', 'solutionPath',
    ],
    note: 'cloneFrom + tableMapping is the highest-fidelity route — it re-binds a real reference form.',
  },
  'scaffold:report': {
    required: ['name'],
    optional: [
      'caption', 'packagePath', 'fields', 'fieldsHint', 'contractParams', 'additionalDatasets',
      'generateController', 'designStyle', 'copyFrom', 'modelName', 'projectPath', 'solutionPath',
      'aotQuery', 'callerTableName', 'preProcess', 'controllerType', 'uiBuilder',
    ],
    note: 'Pattern recipes (roster + when-to-use): object_patterns(domain="report").',
  },
  'find-methods': {
    required: ['name'],
    optional: ['keyFields', 'includeExists', 'includeFindRecId'],
    note: 'name = the existing table; keys come from its primary/unique index unless keyFields is given.',
  },
  'relation-xpp': {
    required: ['name'],
    optional: ['relationName', 'style'],
    note: 'name = the existing table. Inverse of mode="table-relation".',
  },
  fields: {
    required: ['name'],
    optional: ['fields', 'fieldsHint', 'fieldGroup'],
    note: 'Emits AxTableField XML with auto-resolved EDTs. Pass fields[] OR fieldsHint.',
  },
  'table-relation': {
    required: ['name'],
    optional: ['fields'],
    note: 'name = the existing table. fields omitted = scan every EDT-referencing field.',
  },
};

/** Required params for a mode ([] for unknown modes). */
export function getGenerateObjectRequiredParams(mode: string): string[] {
  return GENERATE_OBJECT_MODE_SPECS[mode]?.required ?? [];
}

function renderParamLine(name: string, marker: string): string {
  const spec = GENERATE_OBJECT_PARAM_SPECS[name];
  if (!spec) return `  ${marker} ${name}`;
  return `  ${marker} ${name} (${spec.type}): ${spec.description}`;
}

/**
 * Full parameter spec for one generate_object mode — names, types, descriptions.
 * Used by the op-spec lookup and by the missing-parameter error, so a failed
 * call carries everything needed to retry correctly.
 */
export function renderGenerateObjectSpec(mode: string): string {
  const spec = GENERATE_OBJECT_MODE_SPECS[mode];
  if (!spec) {
    return (
      `Unknown generate_object mode '${mode}'. Valid topics: ` +
      `${Object.keys(GENERATE_OBJECT_MODE_SPECS).join(', ')}.`
    );
  }
  const lines = [
    `Parameter spec for generate_object(mode="${mode.split(':')[0]}") — pass anything beyond ` +
    `mode/name/pattern/objectType/modelName NESTED inside \`params\` ` +
    `(strict MCP clients drop undeclared top-level keys). ` +
    `Re-fetch: get_knowledge(kind="op-spec", topic="${mode}").`,
    ...spec.required.map(p => renderParamLine(p, 'REQUIRED')),
    ...spec.optional.map(p => renderParamLine(p, 'optional')),
  ];
  if (spec.note) lines.push(`Note: ${spec.note}`);
  return lines.join('\n');
}
