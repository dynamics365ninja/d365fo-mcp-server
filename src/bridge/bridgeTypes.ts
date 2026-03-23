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
}

// ===========================
// Metadata types — Forms
// ===========================

export interface BridgeFormInfo {
  name: string;
  model?: string;
  dataSources: BridgeFormDataSource[];
  controls: BridgeFormControl[];
}

export interface BridgeFormDataSource {
  name: string;
  table: string;
  joinSource?: string;
}

export interface BridgeFormControl {
  name: string;
  controlType: string;
  dataSource?: string;
  dataField?: string;
  children?: BridgeFormControl[];
}

// ===========================
// Metadata types — Queries
// ===========================

export interface BridgeQueryInfo {
  name: string;
  model?: string;
  dataSources: BridgeQueryDataSource[];
}

export interface BridgeQueryDataSource {
  name: string;
  table: string;
  joinMode?: string;
  children?: BridgeQueryDataSource[];
}

// ===========================
// Metadata types — Views
// ===========================

export interface BridgeViewInfo {
  name: string;
  label?: string;
  model?: string;
  query?: string;
  fields: BridgeViewField[];
}

export interface BridgeViewField {
  name: string;
  fieldType: string;
  mandatory: boolean;
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
  keys: BridgeDataEntityKey[];
  fieldMappings: BridgeDataEntityFieldMapping[];
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
  dataSets: string[];
  designs: string[];
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
