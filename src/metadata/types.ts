/**
 * X++ Metadata Type Definitions
 */

export interface XppParseResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface XppClassInfo {
  name: string;
  model: string;
  sourcePath: string;  // Path to original XML file
  extends?: string;
  implements: string[];
  isAbstract: boolean;
  isFinal: boolean;
  declaration: string;
  methods: XppMethodInfo[];
  documentation?: string;
}

export interface XppMethodInfo {
  name: string;
  visibility: 'public' | 'private' | 'protected';
  returnType: string;
  parameters: XppParameterInfo[];
  isStatic: boolean;
  source: string;
  documentation?: string;
}

export interface XppParameterInfo {
  name: string;
  type: string;
}

export interface XppTableInfo {
  name: string;
  model: string;
  sourcePath: string;  // Path to original XML file
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

export interface XppSymbol {
  name: string;
  type: 'class' | 'table' | 'method' | 'field' | 'enum' | 'edt';
  parentName?: string;
  signature?: string;
  filePath: string;
  model: string;
}
