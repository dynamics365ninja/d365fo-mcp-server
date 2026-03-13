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
      | 'enum-extension' | 'edt-extension' | 'data-entity-extension';
  parentName?: string;
  signature?: string;
  filePath: string;
  model: string;
  packageName?: string;            // Package that contains this model (may differ from model)
  // Enhanced metadata for better Copilot integration
  description?: string;         // Human-readable description
  tags?: string;                // Comma-separated tags (stored as TEXT in SQLite)
  sourceSnippet?: string;       // First 10 lines for preview
  source?: string;              // Full method source code
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

/**
 * Form metadata types
 */
export interface XppFormInfo {
  name: string;
  model: string;
  sourcePath: string;
  label?: string;
  caption?: string;
  formPattern?: string;  // E.g., 'DetailsTransaction', 'ListPage', 'SimpleList'
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
  type: string;  // E.g., 'ActionPane', 'Grid', 'Group', 'String', 'Button'
  properties: Record<string, string>;
  children: XppFormControl[];
}

/**
 * EDT metadata types
 */
export interface XppEdtInfo {
  name: string;
  model: string;
  sourcePath: string;
  extends?: string;        // Base type it extends (e.g., 'String', 'Integer', or another EDT)
  enumType?: string;       // Associated enum type name
  referenceTable?: string; // Related table for foreign key lookups
  relationType?: string;   // Type of relation (e.g., 'OneToMany')
  stringSize?: string;     // String length (e.g., '20')
  displayLength?: string;  // Display width
  label?: string;          // User-facing label
  helpText?: string;       // Help text
  formHelp?: string;       // Form help reference
  configurationKey?: string;
  alignment?: string;      // Left, Right, Center
  decimalSeparator?: string;
  signDisplay?: string;
  noOfDecimals?: string;
  additionalProperties: Record<string, string>;
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

/**
 * Security artifact types
 */
export interface XppSecurityEntryPoint {
  name: string;
  objectType: string;     // MenuItemDisplay / MenuItemAction / MenuItemOutput / WebActionItem
  accessLevel: string;    // Read / Update / Create / Delete / Correct / Invoke
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
  privileges: string[];   // Privilege names
}

export interface XppSecurityRoleInfo {
  name: string;
  model: string;
  sourcePath: string;
  label?: string;
  description?: string;
  duties: string[];       // Duty names
}

/**
 * Menu item types
 */
export interface XppMenuItemInfo {
  name: string;
  model: string;
  sourcePath: string;
  label?: string;
  menuItemType: 'display' | 'action' | 'output';
  targetObject?: string;
  targetType?: string;    // Form / Class / Query / Report
  securityPrivilege?: string;
}

/**
 * Extension metadata types
 */
export interface XppExtensionInfo {
  name: string;
  model: string;
  sourcePath: string;
  extensionType: string;        // table-extension / class-extension / etc.
  baseObjectName: string;       // The object being extended
  addedFields?: string[];       // Field names added by this extension
  addedMethods?: string[];      // Method names added by this extension
  addedIndexes?: string[];      // Index names added by this extension
  cocMethods?: string[];        // Methods wrapped via CoC (call next)
  eventSubscriptions?: string[];// Events subscribed to via [SubscribesTo]
}
