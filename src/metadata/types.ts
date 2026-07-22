/**
 * X++ Metadata Type Definitions
 */

import type { XppExtensionOf } from './xppDeclaration.js';

export type { XppExtensionOf };

export interface XppParseResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface XppClassInfo {
  name: string;
  model: string;
  sourcePath: string;
  extends?: string;
  implements: string[];
  isAbstract: boolean;
  isFinal: boolean;
  declaration: string;
  /**
   * Set when the class carries [ExtensionOf(...)] — i.e. it is a class
   * extension. Class extensions are plain AxClass files (the AOT has no
   * AxClassExtension artifact), so this attribute is what distinguishes them.
   */
  extensionOf?: XppExtensionOf;
  methods: XppMethodInfo[];
  documentation?: string;
  tags?: string[];
  usedTypes?: string[];
  description?: string;
}

export interface XppMethodInfo {
  name: string;
  visibility: 'public' | 'private' | 'protected';
  returnType: string;
  parameters: XppParameterInfo[];
  isStatic: boolean;
  source: string;
  documentation?: string;
  sourceSnippet?: string;
  /** Complexity score (0-100). */
  complexity?: number;
  usedTypes?: string[];
  methodCalls?: string[];
  tags?: string[];
  inlineComments?: string;
}

export interface XppParameterInfo {
  name: string;
  type: string;
}

export interface XppTableInfo {
  name: string;
  model: string;
  sourcePath: string;
  label: string;
  tableGroup: string;
  primaryIndex?: string;
  clusteredIndex?: string;
  fields: XppFieldInfo[];
  indexes: XppIndexInfo[];
  relations: XppRelationInfo[];
  methods: XppMethodInfo[];
}

export interface XppFieldInfo {
  name: string;
  type: string;
  extendedDataType?: string;
  enumType?: string;
  mandatory: boolean;
  label?: string;
}

export interface XppIndexInfo {
  name: string;
  fields: string[];
  unique: boolean;
  clustered: boolean;
}

export interface XppRelationInfo {
  name: string;
  relatedTable: string;
  constraints: XppConstraintInfo[];
}

export interface XppConstraintInfo {
  field: string;
  relatedField: string;
}

export interface XppViewFieldInfo {
  name: string;
  dataSource?: string;
  dataField?: string;
  dataMethod?: string;
  labelId?: string;
  isComputed: boolean;
}

export interface XppViewRelationFieldInfo {
  field: string;
  relatedField: string;
}

export interface XppViewRelationInfo {
  name: string;
  relatedTable: string;
  relationType: string;
  cardinality: string;
  fields: XppViewRelationFieldInfo[];
}

export interface XppViewInfo {
  name: string;
  model: string;
  sourcePath: string;
  type: 'view' | 'data-entity';
  label?: string;
  isPublic: boolean;
  isReadOnly: boolean;
  primaryKey?: string;
  primaryKeyFields: string[];
  fields: XppViewFieldInfo[];
  relations: XppViewRelationInfo[];
  methods: XppMethodInfo[];
}

export interface XppSymbol {
  name: string;
  type: 'class' | 'table' | 'form' | 'query' | 'view' | 'method' | 'field' | 'enum' | 'edt' | 'report'
      | 'security-privilege' | 'security-duty' | 'security-role'
      | 'menu-item-display' | 'menu-item-action' | 'menu-item-output'
      | 'table-extension' | 'class-extension' | 'form-extension'
      | 'enum-extension' | 'edt-extension' | 'data-entity-extension'
      | 'view-extension' | 'query-extension' | 'map-extension' | 'menu-extension'
      | 'security-duty-extension' | 'security-role-extension'
      | 'menu-item-display-extension' | 'menu-item-action-extension'
      | 'menu-item-output-extension'
      | 'menu' | 'service' | 'service-group'
      | 'map' | 'configuration-key' | 'license-code' | 'security-policy' | 'macro';
  parentName?: string;
  signature?: string;
  filePath: string;
  model: string;
  /** Package containing this model; may differ from `model`. */
  packageName?: string;
  description?: string;
  /** Comma-separated tags (stored as TEXT in SQLite). */
  tags?: string;
  sourceSnippet?: string;
  source?: string;
  complexity?: number;
  /** Comma-separated types used. */
  usedTypes?: string;
  /** Comma-separated method calls. */
  methodCalls?: string;
  inlineComments?: string;
  extendsClass?: string;
  /** Comma-separated interfaces implemented (classes only). */
  implementsInterfaces?: string;
  usageExample?: string;
  patternType?: string;
  /** JSON array of typical usage examples. */
  typicalUsages?: string;
  usageFrequency?: number;
  calledByCount?: number;
  /** Comma-separated related methods. */
  relatedMethods?: string;
  /** JSON of common API usage patterns. */
  apiPatterns?: string;
}

export interface XppFormInfo {
  name: string;
  model: string;
  sourcePath: string;
  label?: string;
  caption?: string;
  /** E.g. 'DetailsTransaction', 'ListPage', 'SimpleList'. */
  formPattern?: string;
  dataSources: XppFormDataSource[];
  design: XppFormControl[];
  methods: XppMethodInfo[];
}

export interface XppFormDataSource {
  name: string;
  table: string;
  allowEdit: boolean;
  allowCreate: boolean;
  allowDelete: boolean;
  fields: string[];
  methods: string[];
}

export interface XppFormControl {
  name: string;
  /** E.g. 'ActionPane', 'Grid', 'Group', 'String', 'Button'. */
  type: string;
  properties: Record<string, string>;
  children: XppFormControl[];
}

export interface XppEdtInfo {
  name: string;
  model: string;
  sourcePath: string;
  extends?: string;
  enumType?: string;
  referenceTable?: string;
  relationType?: string;
  stringSize?: string;
  displayLength?: string;
  label?: string;
  helpText?: string;
  formHelp?: string;
  configurationKey?: string;
  alignment?: string;
  decimalSeparator?: string;
  signDisplay?: string;
  noOfDecimals?: string;
  additionalProperties: Record<string, string>;
}

export interface CodePattern {
  patternName: string;
  patternType: string;
  commonMethods: string[];
  dependencies: string[];
  usageExamples: string[];
  frequency: number;
  domain?: string;
  characteristics?: string[];
}

export interface XppSecurityEntryPoint {
  name: string;
  /** MenuItemDisplay / MenuItemAction / MenuItemOutput / WebActionItem. */
  objectType: string;
  /** Read / Update / Create / Delete / Correct / Invoke. */
  accessLevel: string;
}

export interface XppSecurityPrivilegeInfo {
  name: string;
  model: string;
  sourcePath: string;
  label?: string;
  entryPoints: XppSecurityEntryPoint[];
}

export interface XppSecurityDutyInfo {
  name: string;
  model: string;
  sourcePath: string;
  label?: string;
  privileges: string[];
}

export interface XppSecurityRoleInfo {
  name: string;
  model: string;
  sourcePath: string;
  label?: string;
  description?: string;
  duties: string[];
}

export interface XppMenuItemInfo {
  name: string;
  model: string;
  sourcePath: string;
  label?: string;
  menuItemType: 'display' | 'action' | 'output';
  targetObject?: string;
  /** Form / Class / Query / Report. */
  targetType?: string;
  securityPrivilege?: string;
}

export interface XppExtensionInfo {
  name: string;
  model: string;
  sourcePath: string;
  extensionType: string;
  baseObjectName: string;
  addedFields?: string[];
  addedMethods?: string[];
  addedIndexes?: string[];
  /** Methods wrapped via CoC (call next). */
  cocMethods?: string[];
  /** Events subscribed to via [SubscribesTo]. */
  eventSubscriptions?: string[];
}
