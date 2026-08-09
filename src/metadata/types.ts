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
  /**
   * Declaration unparseable, so `parameters` is empty for lack of evidence
   * rather than because the method takes none. Arity checks must skip, not
   * assume zero.
   */
  parametersUnknown?: boolean;
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
  /** Default as declared; a dropped default makes an optional parameter look required. */
  defaultValue?: string;
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
  /**
   * Set by `search` when this row's file is gone from disk (see
   * indexedPathIsMissing). Not a stored column — a rendering flag, so the reader
   * sees both the hit and the fact that it is a cache row.
   */
  staleIndexRow?: boolean;
  calledByCount?: number;
  /** Comma-separated related methods. */
  relatedMethods?: string;
  /** JSON of common API usage patterns. */
  apiPatterns?: string;
}

