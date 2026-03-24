/**
 * TypeScript interfaces matching the C# bridge Models.
 * These are the JSON shapes returned by the D365MetadataBridge process.
 */

// ===========================
// Protocol types
// ===========================

export interface BridgeRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface BridgeResponse<T = unknown> {
  id: string;
  result?: T;
  error?: BridgeError;
}

export interface BridgeError {
  code: number;
  message: string;
}

export interface BridgeReadyPayload {
  version: string;
  status: 'ready';
  packagesPath: string;
  metadataAvailable: boolean;
  xrefAvailable: boolean;
}

export interface BridgeInfoPayload {
  version: string;
  metadataAvailable: boolean;
  xrefAvailable: boolean;
  capabilities: string[];
}

// ===========================
// Metadata types — Tables
// ===========================

export interface BridgeTableInfo {
  name: string;
  label?: string;
  developerDocumentation?: string;
  tableGroup?: string;
  tabletype?: string;
  cacheLookup?: string;
  clusteredIndex?: string;
  primaryIndex?: string;
  saveDataPerCompany?: string;
  extends?: string;
  supportInheritance?: string;
  model?: string;
  fields: BridgeFieldInfo[];
  indexes: BridgeIndexInfo[];
  relations: BridgeRelationInfo[];
  methods: BridgeMethodInfo[];
}

export interface BridgeFieldInfo {
  name: string;
  fieldType: string;
  extendedDataType?: string;
  label?: string;
  helpText?: string;
  mandatory: boolean;
  allowEdit?: string;
  stringSize?: number;
  enumType?: string;
}

export interface BridgeIndexInfo {
  name: string;
  allowDuplicates: boolean;
  fields: string[];
}

export interface BridgeRelationInfo {
  name: string;
  relatedTable: string;
  cardinality?: string;
  relatedTableCardinality?: string;
  constraints: BridgeRelationConstraint[];
}

export interface BridgeRelationConstraint {
  field?: string;
  relatedField?: string;
  value?: string;
}

// ===========================
// Metadata types — Classes
// ===========================

export interface BridgeClassInfo {
  name: string;
  extends?: string;
  isAbstract: boolean;
  isFinal: boolean;
  isStatic: boolean;
  model?: string;
  declaration?: string;
  methods: BridgeMethodInfo[];
}

export interface BridgeMethodInfo {
  name: string;
  returnType?: string;
  source?: string;
  isStatic?: boolean;
  visibility?: string;
}

// ===========================
// Metadata types — Enums
// ===========================

export interface BridgeEnumInfo {
  name: string;
  label?: string;
  helpText?: string;
  isExtensible: boolean;
  model?: string;
  values: BridgeEnumValueInfo[];
}

export interface BridgeEnumValueInfo {
  name: string;
  value: number;
  label?: string;
}

// ===========================
// Metadata types — EDTs
// ===========================

export interface BridgeEdtInfo {
  name: string;
  baseType?: string;
  extends?: string;
  label?: string;
  helpText?: string;
  stringSize?: number;
  enumType?: string;
  referenceTable?: string;
  model?: string;
  // Gap-fill properties
  formHelp?: string;
  configurationKey?: string;
  alignment?: string;
  displayLength?: number;
  relationType?: string;
  noOfDecimals?: number;
  decimalSeparator?: string;
  signDisplay?: string;
}

// ===========================
// Metadata types — Forms
// ===========================

export interface BridgeFormInfo {
  name: string;
  model?: string;
  formPattern?: string;
  dataSources: BridgeFormDataSource[];
  controls: BridgeFormControl[];
  methods?: BridgeMethodInfo[];
}

export interface BridgeFormDataSource {
  name: string;
  table: string;
  joinSource?: string;
  linkType?: string;
  allowEdit?: string;
  allowCreate?: string;
  allowDelete?: string;
}

export interface BridgeFormControl {
  name: string;
  controlType: string;
  dataSource?: string;
  dataField?: string;
  children?: BridgeFormControl[];
  caption?: string;
  label?: string;
  helpText?: string;
  visible?: string;
  enabled?: string;
  dataMethod?: string;
  autoDeclaration?: string;
}

// ===========================
// Metadata types — Queries
// ===========================

export interface BridgeQueryInfo {
  name: string;
  model?: string;
  description?: string;
  dataSources: BridgeQueryDataSource[];
}

export interface BridgeQueryDataSource {
  name: string;
  table: string;
  joinMode?: string;
  fetchMode?: string;
  childDataSources?: BridgeQueryDataSource[];
  ranges?: BridgeQueryRange[];
  fields?: string[];
}

export interface BridgeQueryRange {
  field: string;
  value?: string;
  status?: string;
}

// ===========================
// Metadata types — Views
// ===========================

export interface BridgeViewInfo {
  name: string;
  label?: string;
  model?: string;
  query?: string;
  isPublic?: boolean;
  isReadOnly?: boolean;
  primaryKey?: string;
  fields: BridgeViewField[];
  relations?: BridgeRelationInfo[];
  methods?: BridgeMethodInfo[];
  dataSources?: BridgeDataEntityDataSource[];
}

export interface BridgeViewField {
  name: string;
  fieldType: string;
  dataSource?: string;
  dataField?: string;
  dataMethod?: string;
  label?: string;
  isComputed?: boolean;
}

// ===========================
// Metadata types — Data Entities
// ===========================

export interface BridgeDataEntityInfo {
  name: string;
  label?: string;
  publicEntityName?: string;
  publicCollectionName?: string;
  isPublic: boolean;
  model?: string;
  dataSources: BridgeDataEntityDataSource[];
  fields: BridgeFieldInfo[];
  // Gap-fill properties
  isReadOnly?: boolean;
  entityCategory?: string;
  dataManagementEnabled?: boolean;
  stagingTable?: string;
  keys?: BridgeDataEntityKey[];
  fieldMappings?: BridgeDataEntityFieldMapping[];
  computedColumns?: string[];
}

export interface BridgeDataEntityDataSource {
  name: string;
  table: string;
}

export interface BridgeDataEntityKey {
  name: string;
  fields: string[];
}

export interface BridgeDataEntityFieldMapping {
  fieldName: string;
  dataSource?: string;
  dataField?: string;
}

// ===========================
// Metadata types — Reports
// ===========================

export interface BridgeReportInfo {
  name: string;
  model?: string;
  dataSets: BridgeReportDataSet[];
  designs?: BridgeReportDesign[];
}

export interface BridgeReportDataSet {
  name: string;
  dataSourceType?: string;
  query?: string;
  fields?: BridgeReportDataSetField[];
}

export interface BridgeReportDataSetField {
  name: string;
  dataField?: string;
  dataType?: string;
}

export interface BridgeReportDesign {
  name: string;
  caption?: string;
  style?: string;
  hasRdl?: boolean;
}

// ===========================
// Cross-reference types
// ===========================

export interface BridgeReferenceResult {
  objectPath: string;
  count: number;
  references: BridgeReferenceInfo[];
}

export interface BridgeReferenceInfo {
  sourcePath: string;
  sourceModule?: string;
  kind?: string;
  line: number;
  column: number;
}

// ===========================
// Search types
// ===========================

export interface BridgeSearchResult {
  results: BridgeSearchItem[];
}

export interface BridgeSearchItem {
  name: string;
  type: string;
  model?: string;
}

// ===========================
// Method source types
// ===========================

export interface BridgeMethodSource {
  className: string;
  methodName: string;
  found: boolean;
  source?: string;
}

// ===========================
// List objects types
// ===========================

export interface BridgeListResult {
  type: string;
  count: number;
  names: string[];
}

// ===========================
// Write-support types (Phase 3)
// ===========================

export interface BridgeValidateResult {
  valid: boolean;
  reason?: string;
  objectType?: string;
  objectName?: string;
  fieldCount?: number;
  methodCount?: number;
  indexCount?: number;
  valueCount?: number;
}

export interface BridgeResolveResult {
  exists: boolean;
  objectType: string;
  objectName: string;
  model?: string;
}

export interface BridgeRefreshResult {
  refreshed: boolean;
  elapsedMs: number;
}

// ===========================
// Write operation types (Phase 4)
// ===========================

/** Result from createObject / addMethod / addField / setProperty / replaceCode */
export interface BridgeWriteResult {
  success: boolean;
  objectType?: string;
  objectName?: string;
  modelName?: string;
  filePath?: string;
  operation?: string;
  methodName?: string;
  fieldName?: string;
  fieldType?: string;
  propertyPath?: string;
  propertyValue?: string;
  api?: string;
}

/** Method parameter for createObject */
export interface BridgeMethodParam {
  name: string;
  source?: string;
}

/** Field parameter for createObject (table) */
export interface BridgeFieldParam {
  name: string;
  fieldType?: string;
  edt?: string;
  enumType?: string;
  mandatory?: boolean;
  label?: string;
  helpText?: string;
  stringSize?: number;
}

/** Field group parameter for createObject (table) */
export interface BridgeFieldGroupParam {
  name: string;
  label?: string;
  fields?: string[];
}

/** Index parameter for createObject (table) */
export interface BridgeIndexParam {
  name: string;
  allowDuplicates?: boolean;
  alternateKey?: boolean;
  fields?: string[];
}

/** Relation parameter for createObject (table) */
export interface BridgeRelationParam {
  name: string;
  relatedTable?: string;
  constraints?: { field?: string; relatedField?: string }[];
}

/** Enum value parameter for createObject (enum) */
export interface BridgeEnumValueParam {
  name: string;
  value: number;
  label?: string;
}
