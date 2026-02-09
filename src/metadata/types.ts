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
  // Enhanced metadata for better Copilot integration
  tags?: string[];              // Semantic tags (controller, utility, etc.)
  usedTypes?: string[];         // Classes/tables used in class
  description?: string;         // Generated description from docs/declaration
}

export interface XppMethodInfo {
  name: string;
  visibility: 'public' | 'private' | 'protected';
  returnType: string;
  parameters: XppParameterInfo[];
  isStatic: boolean;
  source: string;
  documentation?: string;
  // Enhanced metadata for better Copilot integration
  sourceSnippet?: string;       // First 10 lines for preview
  complexity?: number;          // Complexity score (0-100)
  usedTypes?: string[];         // Classes/tables used in method
  methodCalls?: string[];       // Methods called within this method
  tags?: string[];              // Semantic tags (validation, query, etc.)
  inlineComments?: string;      // Extracted inline comments
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
  // Enhanced metadata for better Copilot integration
  description?: string;         // Human-readable description
  tags?: string;                // Comma-separated tags (stored as TEXT in SQLite)
  sourceSnippet?: string;       // First 10 lines for preview
  complexity?: number;          // Complexity score (0-100)
  usedTypes?: string;           // Comma-separated types used
  methodCalls?: string;         // Comma-separated method calls
  inlineComments?: string;      // Extracted inline comments
  extendsClass?: string;        // For classes: extends relationship
  implementsInterfaces?: string;// For classes: comma-separated interfaces
  usageExample?: string;        // Generated usage example
  // Pattern analysis metadata
  usageFrequency?: number;      // How many places use/call this
  patternType?: string;         // Helper, Service, Repository, Controller, etc.
  typicalUsages?: string;       // JSON array of typical usage examples
  calledByCount?: number;       // How many methods call this
  relatedMethods?: string;      // Comma-separated related methods
  apiPatterns?: string;         // JSON of common API usage patterns
}

export interface CodePattern {
  patternName: string;
  patternType: string;          // Helper, Service, Repository, etc.
  commonMethods: string[];      // Most frequent methods in this pattern
  dependencies: string[];       // Common dependencies
  usageExamples: string[];      // Real implementation examples
  frequency: number;            // How many classes follow this pattern
  domain?: string;              // Customer, Inventory, Sales, etc.
  characteristics?: string[];   // Distinguishing features
}
