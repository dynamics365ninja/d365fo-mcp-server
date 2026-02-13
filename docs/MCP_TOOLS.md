# MCP Tools for D365FO/X++

This document describes all available MCP server tools for working with D365 Finance & Operations and X++ code.

## 📚 Table of Contents

1. [Core Search Tools](#-core-search-tools)
2. [Detailed Object Information](#-detailed-object-information)
3. [Intelligent Code Generation](#-intelligent-code-generation)
4. [File Creation Tools](#-file-creation-tools)
5. [Workspace-Aware Features](#-workspace-aware-features)
6. [Code Generation Workflow](#-code-generation-workflow)

---

## 🔍 Core Search Tools

### `search`

**Purpose:** Search for X++ classes, tables, methods, fields, enums, and EDTs by name or keyword

**When to use:**
- Looking for specific classes like `CustTable`, `SalesLine`
- Need to find methods by name
- Discovering what objects are available in D365FO

**Parameters:**
- `query` (string) - search query (class name, method name, table name, etc.)
- `types` (array, optional) - filter by symbol type: `class`, `table`, `method`, `field`, `enum`, `edt`
- `limit` (number, optional) - maximum number of results (default: 20)

**Usage examples:**
```typescript
// Find all classes containing "dimension"
search("dimension", types=["class"], limit=10)

// Search tables with "sales" in name
search("sales", types=["table"])

// General search without filter
search("validate")
```

**Output:**
```
Found 10 matches:

[CLASS] DimensionAttributeValueSet
[CLASS] DimensionDefaultingService
[CLASS] DimensionHelper
...
```

---

### `batch_search` ⚡ NEW

**Purpose:** Execute multiple searches in parallel for faster exploration

**When to use:**
- Need to search multiple independent concepts (dimension + ledger + financial)
- Want to speed up exploratory phase (3x faster than sequential searches)
- User says "find X and Y and Z"

**Parameters:**
- `queries` (array) - array of search queries, each with its own parameters:
  - `query` (string) - search text
  - `type` (string, optional) - type filter
  - `limit` (number, optional) - max results

**Usage example:**
```typescript
batch_search({
  queries: [
    { query: "dimension", type: "class", limit: 5 },
    { query: "helper", type: "class", limit: 5 },
    { query: "validation", type: "class", limit: 5 }
  ]
})
```

**Advantage:** One HTTP request instead of three → 67% faster, ~50ms total vs ~150ms

---

### `search_extensions`

**Purpose:** Search only in custom/ISV modules (custom extensions)

**When to use:**
- Want to filter only custom extensions
- Need to distinguish Microsoft code from custom code
- Looking for classes with specific prefix (ISV_, Custom_, Asl)

**Parameters:**
- `query` (string) - search query
- `prefix` (string, optional) - extension prefix filter
- `limit` (number, optional) - maximum number of results (default: 20)

**Usage example:**
```typescript
// Find all custom classes containing "helper"
search_extensions("helper", prefix="ISV_")

// Search all Asl extensions
search_extensions("dimension", prefix="Asl")
```

---

## 📋 Detailed Object Information

### `get_class_info` 🔹

**Purpose:** Get complete information about an X++ class including source code of all methods

**What it returns:**
- Class declaration (abstract, final, modifiers)
- Inheritance (extends, implements)
- List of all methods including source code
- Method visibility (public/private/protected/internal)
- Documentation (summary, parameters)
- Model and file path

**Parameters:**
- `className` (string) - name of the X++ class
- `includeWorkspace` (boolean, optional) - search in user's workspace first (default: false)
- `workspacePath` (string, optional) - path to workspace project

**Usage example:**
```typescript
// Basic usage
get_class_info("DimensionAttributeValueSet")

// Workspace-aware search (prefers local files)
get_class_info("MyCustomHelper", 
  includeWorkspace=true, 
  workspacePath="C:\\D365\\MyProject")
```

**Output:**

# Class: DimensionAttributeValueSet

**Model:** ApplicationPlatform  
**Extends:** Object  
**Implements:** -

## Declaration
```xpp
public class DimensionAttributeValueSet extends Object
```

## Methods (15)

### public DimensionAttribute getDimensionAttribute()
- Returns the dimension attribute

```xpp
public DimensionAttribute getDimensionAttribute()
{
    return dimensionAttribute;
}
```
...

**🔹 Special features:**
- **Workspace-aware**: Can search in user's local workspace before external metadata
- XML parsing of local files for immediate access to local code

---

### `get_table_info`

**Purpose:** Get complete structure of an X++ table

**What it returns:**
- List of all fields (name, type, EDT, mandatory, label)
- Indexes (primary, clustered, unique)
- Relations/Foreign keys
- Table methods
- Table Group, Label, System Fields

**Parameters:**
- `tableName` (string) - name of the X++ table

**Usage example:**
```typescript
get_table_info("SalesTable")
get_table_info("CustTable")
```

**Output:**

# Table: SalesTable

**Model:** ApplicationSuite  
**Label:** Sales orders  
**Table Group:** Main  
**Primary Index:** SalesIdx  
**Clustered Index:** SalesIdx

## Fields (85)

| Name | Type | EDT | Mandatory | Label |
|------|------|-----|-----------|-------|
| SalesId | String | SalesId | Yes | Sales order |
| CustAccount | String | CustAccount | Yes | Customer account |
| SalesStatus | Enum | SalesStatus | Yes | Status |
...

## Indexes (12)

- **SalesIdx**: [SalesId] (unique) (clustered)
- **CustIdx**: [CustAccount, SalesId]
...

## Relations (8)

- **CustTable** → CustTable (CustAccount = AccountNum)
...

## Methods (45)

- `void insert()`
- `void update()`
- `boolean validateWrite()`
...

---

### `code_completion` 🔍

**Purpose:** IntelliSense-style completion – shows all methods and fields available on a class/table

**When to use:**
- Discovering what methods are available on an object
- Need to find method signature
- Looking for table fields with specific prefix

**Parameters:**
- `className` (string) - name of class or table
- `prefix` (string, optional) - filter by prefix (default: "" = all members)
- `includeWorkspace` (boolean, optional) - include workspace files (default: false)
- `workspacePath` (string, optional) - path to workspace

**Usage example:**
```typescript
// Show all class methods
code_completion(className="SalesTable")

// Find methods starting with "calc"
code_completion(className="SalesTable", prefix="calc")

// Workspace-aware completion
code_completion(
  className="MyCustomTable", 
  includeWorkspace=true,
  workspacePath="C:\\D365\\MyProject"
)
```

**Output:**
```json
[
  {
    "label": "calcTotalAmount",
    "kind": "method",
    "detail": "public Amount calcTotalAmount()",
    "documentation": "Calculates the total sales amount"
  },
  {
    "label": "calcTax",
    "kind": "method",
    "detail": "public TaxAmount calcTax()",
    "documentation": "Calculates tax for the order"
  }
]
```

**Special features:**
- Works for both classes and tables
- Supports workspace-first search
- Empty prefix returns ALL available members

---

## ⚡ Intelligent Code Generation

### `analyze_code_patterns` 🔴 MANDATORY FIRST STEP

**Purpose:** Analyze existing patterns in codebase BEFORE generating any code

**⚠️ CRITICAL: This tool MUST be called before generating any X++ code!**

**Why it's MANDATORY:**
- Discovers which D365FO classes and methods are commonly used together in the project
- Identifies frequent dependencies and APIs
- Finds examples of similar implementations from real code
- Prevents using generic patterns instead of actual D365FO code from the project
- Learns from YOUR codebase, not from generic examples

**Parameters:**
- `scenario` (string) - scenario or domain to analyze (e.g., "dimension", "validation", "customer")
- `classPattern` (string, optional) - filter by class name pattern (e.g., "Helper", "Service")
- `limit` (number, optional) - maximum number of classes to analyze (default: 20)

**Usage example:**
```typescript
// Discover how to work with dimensions in the project
analyze_code_patterns("financial dimensions", classPattern="Helper")

// Find patterns for validation
analyze_code_patterns("validation")

// Analyze customer-related classes
analyze_code_patterns("customer", limit=30)
```

**What it returns:**

# Code Pattern Analysis: financial dimensions

**Total Matching Classes:** 15

## Detected Patterns

- **Helper**: 8 classes  
  Examples: DimensionHelper, DimensionAttributeHelper, DimensionDefaultingHelper
- **Service**: 5 classes  
  Examples: DimensionService, DimensionDefaultingService
- **Manager**: 2 classes  
  Examples: DimensionManager

## Common Methods (Top 10)

- **getDimensionAttribute**: found in 12 classes
- **validateDimension**: found in 10 classes
- **createDefaultDimension**: found in 8 classes
- ...

## Common Dependencies

- **DimensionAttributeValueSet**: used by 14 classes
- **DimensionAttribute**: used by 12 classes
- **DefaultDimensionView**: used by 10 classes
- ...

## Example Classes

- DimensionAttributeValueSetHelper
- DimensionDefaultingService
- DimensionHelper
- ...

**When to use:**
- ✅ Before creating any new class
- ✅ Before implementing new functionality
- ✅ When you need to discover which D365FO APIs to use
- ✅ When you want to follow team conventions

---

### `generate_code` ⚡ MANDATORY FOR CODE CREATION

**Purpose:** Generate production-ready X++ code following D365FO best practices and patterns

**⚠️ CRITICAL: NEVER generate X++ code manually – ALWAYS use this tool!**

**Why it's mandatory:**
- Ensures correct D365FO patterns (naming conventions, structure)
- Generates complete skeleton with correct modifiers (public/private/internal/final)
- Includes proper summary documentation
- Implements best practices (ttsbegin/ttscommit for DML operations)
- Prevents errors in names and signatures

**Supported patterns:**
- `class` - basic class
- `runnable` - runnable class with main() method
- `form-handler` - form extension ([ExtensionOf])
- `data-entity` - data entity with find(), exist()
- `batch-job` - batch job (SysOperationServiceController)
- `coc-extension` - Chain of Command extension
- `event-handler` - event handler with DataEventHandler/PostHandlerFor
- `service-class` - service class with SysOperationServiceBase

**Parameters:**
- `pattern` (enum) - pattern type to generate
- `name` (string) - name for the generated element
- `options` (object, optional) - additional options:
  - `baseClass` (string) - parent class for inheritance
  - `tableName` (string) - table name for data entity
  - `formName` (string) - form name for form handler

**Usage examples:**

```typescript
// Basic class
generate_code(
  pattern="class", 
  name="MyDimensionHelper"
)

// Runnable class
generate_code(
  pattern="runnable",
  name="MyDataProcessor"
)

// Form extension
generate_code(
  pattern="form-handler",
  name="SalesTable",
  options={formName: "SalesTable"}
)

// Data entity
generate_code(
  pattern="data-entity",
  name="CustomSales",
  options={tableName: "CustomSalesTable"}
)

// Batch job
generate_code(
  pattern="batch-job",
  name="MyBatchProcessor"
)

// CoC Extension
generate_code(
  pattern="coc-extension",
  name="SalesTableExtension",
  options={baseClass: "SalesTable"}
)

// Event handler
generate_code(
  pattern="event-handler",
  name="CustTableEvent",
  options={tableName: "CustTable"}
)
```

**Output example (runnable):**
```xpp
/// <summary>
/// Runnable class MyDataProcessor
/// </summary>
internal final class MyDataProcessor
{
    /// <summary>
    /// Main entry point for the runnable class
    /// </summary>
    /// <param name="_args">Arguments passed to the class</param>
    public static void main(Args _args)
    {
        MyDataProcessor instance = new MyDataProcessor();
        instance.run();
    }

    /// <summary>
    /// Executes the business logic
    /// </summary>
    public void run()
    {
        // TODO: Implement business logic
        info("MyDataProcessor executed successfully");
    }
}
```

---

### `suggest_method_implementation`

**Purpose:** Suggest method body implementation based on similar methods in the codebase

**When to use:**
- Need to implement methods like validate(), find(), create()
- Want to see how similar methods are implemented in the project
- Looking for the right pattern for specific method type

**Parameters:**
- `className` (string) - name of class containing the method
- `methodName` (string) - name of method to suggest implementation for
- `parameters` (array, optional) - method parameters [{name, type}]
- `returnType` (string, optional) - return type (default: "void")

**Usage example:**
```typescript
// Suggest validate method implementation
suggest_method_implementation(
  className="MyHelper",
  methodName="validate",
  parameters=[{name: "record", type: "Common"}],
  returnType="boolean"
)

// Suggest create method
suggest_method_implementation(
  className="MyManager",
  methodName="createRecord",
  returnType="RecId"
)
```

**What it does:**
1. Finds similar methods by name across the entire codebase
2. Shows their implementation with source code
3. Analyzes complexity and used tags
4. Suggests pattern based on real code

**Output:**

# Method Implementation Suggestions

**Class:** MyHelper
**Method:** boolean validate(Common record)

## Similar Methods Found

### 1. DimensionHelper.validateDimension

**Signature:** `boolean validateDimension(Common _record)`  
**Complexity:** Medium  
**Tags:** validation, dimension, check

**Implementation Preview:**

```xpp
boolean validateDimension(Common _record)
{
    boolean isValid = true;
    
    if (!_record)
    {
        isValid = false;
        error("Record cannot be null");
    }
    
    // Additional validation logic
    
    return isValid;
}
```

### 2. SalesTableHelper.validateRecord
...

## Suggested Implementation Pattern

```xpp
public boolean validate(Common _record)
{
    boolean isValid = true;
    
    // Add validation logic here
    
    return isValid;
}
```

---

### `analyze_class_completeness`

**Purpose:** Check if class is missing common methods based on codebase patterns

**When to use:**
- After creating a new class
- Want to ensure class follows team conventions
- Looking for methods that are often missing in similar classes

**Parameters:**
- `className` (string) - name of class to analyze

**Usage example:**
```typescript
analyze_class_completeness("MyCustomHelper")
```

**What it does:**
1. Finds class pattern type (Helper, Service, Manager, etc.)
2. Compares with similar classes in codebase
3. Identifies common methods that are missing
4. Shows frequency of occurrence for each method

**Output:**

# Class Completeness Analysis: MyCustomHelper

**Model:** MyModel  
**Pattern Type:** Helper  
**Existing Methods:** 3

## Implemented Methods

- `void init()`
- `boolean validate()`
- `void run()`

## Suggested Missing Methods

Based on analysis of similar Helper classes:

- **find**: Found in 85% of similar classes (17/20)
- **exist**: Found in 75% of similar classes (15/20)
- **create**: Found in 70% of similar classes (14/20)
- **delete**: Found in 60% of similar classes (12/20)
- **update**: Found in 55% of similar classes (11/20)

**Recommendation:** Consider implementing these methods to follow common patterns in your codebase.

---

### `get_api_usage_patterns`

**Purpose:** Discover how a specific API or class is used throughout the codebase

**When to use:**
- Need to use D365FO API but unsure how to initialize it
- Looking for correct method call sequence
- Want to see real usage examples from the project

**Parameters:**
- `className` (string) - name of class/API to get usage patterns for

**Usage example:**
```typescript
get_api_usage_patterns("DimensionAttributeValueSet")
get_api_usage_patterns("NumberSeq")
```

**What it returns:**
- Usage count in codebase
- Most common method calls (sorted by frequency)
- Common initialization patterns (code snippets)
- List of classes where API is used
- Recommended usage flow

**Output:**

# API Usage Patterns: DimensionAttributeValueSet

**Usage Count:** 142 places in codebase

## Most Common Method Calls

- **getDimensionAttribute**: called 89 times
- **validateValue**: called 67 times
- **setValue**: called 54 times
- **getValue**: called 51 times
- **save**: called 45 times

## Common Initialization Patterns

### Pattern 1

```xpp
DimensionAttributeValueSet dimAttrValueSet;
DimensionAttribute dimAttr;

dimAttr = DimensionAttribute::findByName("Department");
dimAttrValueSet = new DimensionAttributeValueSet();
dimAttrValueSet.parmDimensionAttribute(dimAttr);
```

### Pattern 2

```xpp
DimensionAttributeValueSet dimAttrValueSet;

dimAttrValueSet = DimensionAttributeValueSet::find(recId);
if (dimAttrValueSet)
{
    dimAttrValueSet.setValue("Value");
    dimAttrValueSet.save();
}
```

## Used In Classes

- DimensionDefaultingService
- DimensionHelper
- LedgerDimensionFacade
- FinancialDimensionManager
- ...

## Usage Recommendation

Based on codebase analysis, the typical usage flow is:
1. Initialize DimensionAttributeValueSet
2. Call getDimensionAttribute()
3. Call setValue()
4. Call validateValue()
5. Call save()

---

## � File Creation Tools

### `create_d365fo_file`

**Purpose:** Creates physical D365FO XML files in the correct AOT package structure

**When to use:**
- Need to create new X++ class, table, enum, form, or other D365FO object
- Want to generate complete XML metadata file in proper location
- Creating objects outside of Visual Studio (e.g., from scripts, automation)
- Need proper XML structure for version control

**What it does:**
- Generates complete XML metadata file with proper D365FO structure
- Saves file to correct location: `K:\AosService\PackagesLocalDirectory\ModelName\ModelName\AxClass\ObjectName.xml`
- Creates directory structure if it doesn't exist
- Validates file doesn't already exist to prevent accidental overwriting
- Returns file path for adding to Visual Studio project

**Parameters:**
- `objectType` (enum, **required**) - type of D365FO object:
  - `class` - AxClass file
  - `table` - AxTable file
  - `enum` - AxEnum file
  - `form` - AxForm file
  - `query` - AxQuery file
  - `view` - AxView file
  - `data-entity` - AxDataEntityView file
- `objectName` (string, **required**) - name of the object (e.g., "MyHelperClass", "MyCustomTable")
- `modelName` (string, **required**) - model name (e.g., "CustomCore", "ApplicationSuite")
- `packagePath` (string, optional) - base package path (default: `K:\AosService\PackagesLocalDirectory`)
- `sourceCode` (string, optional) - X++ source code for classes (class declaration, methods)
- `properties` (object, optional) - additional properties:
  - For classes: `extends`, `implements`, `isFinal`, `isAbstract`
  - For tables: `label`, `tableGroup`, `titleField1`, `titleField2`, `extends` (default: "common"), `configurationKey`, `primaryIndex`, `cacheLookup` (default: "NotInTOS")
  - For enums: `label`, `useEnumValue`
  - For forms: `caption`, `formTemplate` (default: "DetailsPage"), `pattern` (default: "DetailsTransaction"), `style` (default: "DetailsFormTransaction"), `dataSource`, `interactionClass`, `extends` (default: "FormRun"), `classDeclaration`
  - For data entities: `label`, `publicEntityName`, `publicCollectionName`
- `addToProject` (boolean, optional) - automatically add file to Visual Studio project (default: false)
- `projectPath` (string, optional) - path to .rnrproj file (required if `addToProject` is true)

**Usage examples:**

```typescript
// Create a simple class
create_d365fo_file(
  objectType="class",
  objectName="MyHelperClass",
  modelName="CustomCore"
)

// Create class with source code and properties
create_d365fo_file(
  objectType="class",
  objectName="MyDimensionHelper",
  modelName="CustomCore",
  sourceCode=`public class MyDimensionHelper extends RunBaseBatch
{
    public void run()
    {
        // TODO: Implement
    }
}`,
  properties={
    extends: "RunBaseBatch",
    isFinal: true
  }
)

// Create a table
create_d365fo_file(
  objectType="table",
  objectName="MyCustomTable",
  modelName="CustomCore",
  properties={
    label: "My Custom Table",
    tableGroup: "Transaction",
    titleField1: "Name",
    titleField2: "Description",
    extends: "common",              // Base class (default: "common")
    configurationKey: "LogisticsBasic",  // Optional configuration key
    primaryIndex: "NameIdx",        // Sets PrimaryIndex, ClusteredIndex, ReplacementKey
    cacheLookup: "Found"            // Cache lookup setting (default: "NotInTOS")
  }
)

// Create an enum
create_d365fo_file(
  objectType="enum",
  objectName="MyStatusEnum",
  modelName="CustomCore",
  properties={
    label: "My Status",
    useEnumValue: false
  }
)

// Create a form
create_d365fo_file(
  objectType="form",
  objectName="MyCustomForm",
  modelName="CustomCore",
  properties={
    caption: "@MyLabel:CustomForm",
    formTemplate: "DetailsPage",       // DetailsPage, SimpleList, ListPage, etc.
    pattern: "DetailsTransaction",      // Form pattern
    style: "DetailsFormTransaction",    // Form style
    dataSource: "MyTable",              // Primary data source
    interactionClass: "MyFormInteraction", // Optional interaction class
    extends: "FormRun"                  // Base class (default: FormRun)
  }
)

// Create a data entity
create_d365fo_file(
  objectType="data-entity",
  objectName="MyDataEntity",
  modelName="CustomCore",
  properties={
    label: "My Data Entity",
    publicEntityName: "MyEntity",
    publicCollectionName: "MyEntities"
  }
)

// Create with custom package path
create_d365fo_file(
  objectType="class",
  objectName="MyClass",
  modelName="CustomCore",
  packagePath="C:\\AOSService\\PackagesLocalDirectory"
)

// 🆕 Automatically add to Visual Studio project
create_d365fo_file(
  objectType="class",
  objectName="MyHelper",
  modelName="CustomCore",
  addToProject=true,
  projectPath="K:\\MyProjects\\CustomCore\\CustomCore.rnrproj"
)

// 🆕 Full example with project integration
create_d365fo_file(
  objectType="class",
  objectName="MyDimensionHelper",
  modelName="CustomCore",
  sourceCode=`public class MyDimensionHelper
{
    public void validate()
    {
        // TODO
    }
}`,
  properties={
    extends: "RunBaseBatch",
    isFinal: true
  },
  addToProject=true,
  projectPath="K:\\AOSService\\PackagesLocalDirectory\\CustomCore\\CustomCore.rnrproj"
)
```

**Output example (without project integration):**

```
✅ Successfully created D365FO class file:

📁 Path: K:\AosService\PackagesLocalDirectory\CustomCore\CustomCore\AxClass\MyHelperClass.xml
📄 Object: MyHelperClass
📦 Model: CustomCore
🔧 Type: AxClass

Next steps:
1. Add the file to your Visual Studio project (.rnrproj)
2. Build the project to synchronize the object
3. Refresh AOT in Visual Studio to see the new object

File content preview:
```xml
<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>MyHelperClass</Name>
  <SourceCode>
    <Declaration><![CDATA[
public class MyHelperClass
{
}
    ]]></Declaration>
    <Methods />
  </SourceCode>
</AxClass>
```
```

**Output example (with project integration - addToProject=true):**

```
✅ Successfully created D365FO class file:

📁 Path: K:\AosService\PackagesLocalDirectory\CustomCore\CustomCore\AxClass\MyHelperClass.xml
📄 Object: MyHelperClass
📦 Model: CustomCore
🔧 Type: AxClass

✅ Successfully added to Visual Studio project:
📋 Project: K:\AOSService\PackagesLocalDirectory\CustomCore\CustomCore.rnrproj

Next steps:
1. Reload project in Visual Studio (or close/reopen solution)
2. Build the project to synchronize the object
3. Refresh AOT in Visual Studio to see the new object

File content preview:
```xml
<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>MyHelperClass</Name>
  <SourceCode>
    <Declaration><![CDATA[
public class MyHelperClass
{
}
    ]]></Declaration>
    <Methods />
  </SourceCode>
</AxClass>
```
```

**Table XML structure example (based on real D365FO tables):**

When creating a table with:
```typescript
create_d365fo_file(
  objectType="table",
  objectName="MyCustomTable",
  modelName="CustomCore",
  properties={
    label: "My Custom Table",
    tableGroup: "Transaction",
    titleField1: "RecId",
    primaryIndex: "RecIdIdx",
    cacheLookup: "Found"
  }
)
```

The generated XML includes:
```xml
<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>MyCustomTable</Name>
	<SourceCode>
		<Declaration><![CDATA[
public class MyCustomTable extends common
{
}
]]></Declaration>
		<Methods />
	</SourceCode>
	<Label>My Custom Table</Label>
	<TableGroup>Transaction</TableGroup>
	<TitleField1>RecId</TitleField1>
	<TitleField2></TitleField2>
	<CacheLookup>Found</CacheLookup>
	<PrimaryIndex>RecIdIdx</PrimaryIndex>
	<ClusteredIndex>RecIdIdx</ClusteredIndex>
	<ReplacementKey>RecIdIdx</ReplacementKey>
	<CreatedBy>Yes</CreatedBy>
	<CreatedDateTime>Yes</CreatedDateTime>
	<ModifiedBy>Yes</ModifiedBy>
	<ModifiedDateTime>Yes</ModifiedDateTime>
	<DeleteActions />
	<FieldGroups />
	<Fields />
	<Indexes />
	<Mappings />
	<Relations />
	<StateMachines />
</AxTable>
```

**Form XML structure example (based on real D365FO forms):**

When creating a form with:
```typescript
create_d365fo_file(
  objectType="form",
  objectName="MyCustomForm",
  modelName="CustomCore",
  properties={
    caption: "@MyModule:CustomForm",
    formTemplate: "DetailsPage",
    pattern: "DetailsTransaction",
    dataSource: "MyTable",
    interactionClass: "MyFormInteraction"
  }
)
```

The generated XML includes:
```xml
<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
	<Name>MyCustomForm</Name>
	<SourceCode>
		<Methods xmlns="">
			<Method>
				<Name>classDeclaration</Name>
				<Source><![CDATA[
[Form]
public class MyCustomForm extends FormRun
{
}
]]></Source>
			</Method>
		</Methods>
	</SourceCode>
	<FormTemplate>DetailsPage</FormTemplate>
	<InteractionClass>MyFormInteraction</InteractionClass>
	<DataSources />
	<Design>
		<Caption xmlns="">@MyModule:CustomForm</Caption>
		<DataSource xmlns="">MyTable</DataSource>
		<Pattern xmlns="">DetailsTransaction</Pattern>
		<Style xmlns="">DetailsFormTransaction</Style>
		<Controls xmlns="" />
	</Design>
	<Parts />
</AxForm>
```

**File Structure Created:**

```
K:\AosService\PackagesLocalDirectory\
└── CustomCore\
    └── CustomCore\
        ├── AxClass\
        │   └── MyHelperClass.xml  ← Created here
        ├── AxTable\
        │   └── MyCustomTable.xml
        ├── AxEnum\
        │   └── MyStatusEnum.xml
        └── AxForm\
            └── MyForm.xml
```

**Next Steps After File Creation:**

### Without Project Integration (addToProject=false)

1. **Add to Visual Studio Project**
   - Right-click project in Solution Explorer
   - Add → Existing Item
   - Navigate to created XML file
   - Select and add

2. **Build Project**
   - Build → Build Solution (Ctrl+Shift+B)
   - This synchronizes the object to the database

3. **Refresh AOT**
   - View → Application Explorer
   - Right-click → Refresh
   - New object should appear

### With Project Integration (addToProject=true)

1. **Reload Project in Visual Studio**
   - Close and reopen solution, OR
   - Right-click project → Unload Project
   - Right-click again → Reload Project

2. **Verify File Was Added**
   - Check Solution Explorer
   - File should appear in appropriate folder (Classes\, Tables\, etc.)

3. **Build Project**
   - Build → Build Solution (Ctrl+Shift+B)
   - This synchronizes the object to the database

4. **Refresh AOT**
   - View → Application Explorer
   - Right-click → Refresh
   - New object should appear

**Error Handling:**

If file already exists:
```
⚠️ File already exists: K:\...\MyHelperClass.xml

Please choose a different name or delete the existing file first.
```

**Difference from `generate_code`:**

| Tool | Purpose | Output |
|------|---------|--------|
| `generate_code` | Generate X++ code snippet | Returns text code only |
| `create_d365fo_file` | Create physical XML file | Creates actual file on disk |

**Best Practice Workflow:**

```typescript
// Step 1: Generate code structure
code = generate_code(pattern="class", name="MyHelper")

// Step 2: Create physical XML file with generated code
create_d365fo_file(
  objectType="class",
  objectName="MyHelper",
  modelName="CustomCore",
  sourceCode=code
)
```

---

## �🔹 Workspace-Aware Features

Some tools support searching in user's local workspace with priority over external metadata.

### What are Workspace-Aware Features?

**Workspace-aware** tools can:
- Search in user's local X++ files (*.xml)
- Parse XML metadata directly from workspace
- Prefer local files over external database
- Show current state of code in user's project

### Supported Tools

| Tool | Workspace Support | Description |
|---------|-------------------|--------|
| `search` | ✅ Yes | Searches workspace + external metadata |
| `get_class_info` | ✅ Yes | Prefers local files over AOT |
| `code_completion` | ✅ Yes | Shows methods from local XML files |
| `get_table_info` | ❌ No | External metadata only |

### How to Use Workspace-Aware Search

**Parameters:**
- `includeWorkspace` (boolean) - enable workspace-aware search
- `workspacePath` (string) - absolute path to D365FO workspace project

**Example:**
```typescript
// Standard search (external metadata only)
get_class_info("MyClass")

// Workspace-aware search (local + external)
get_class_info(
  "MyClass",
  includeWorkspace=true,
  workspacePath="C:\\Users\\MyUser\\D365\\MyProject"
)
```

### Result Markers

Results are marked by source:

- 🔹 = **Workspace file** (user's local project)
- 📦 = **External metadata** (from central database)

### Advantages of Workspace-Aware Search

1. **Local code priority**: See current state of your code
2. **Faster iteration**: Immediate access to local changes
3. **Real implementations**: Not cached versions, but actual code
4. **Deduplication**: Workspace files have priority, external duplicates are ignored

### XML Parsing

MCP server can parse these X++ XML files:
- AxClass - classes with methods
- AxTable - tables with fields and methods
- AxForm - forms
- AxDataEntity - data entities

**What is extracted:**
- Methods (name, return type, parameters, visibility)
- Fields (name, type, label, mandatory)
- Documentation (summary tags)
- Relationships and indexes

---

## 🎯 Code Generation Workflow

### ✅ CORRECT APPROACH

When user says: **"Create a helper class for working with financial dimensions"**

```typescript
// Step 1: MANDATORY - Analyze existing patterns
analyze_code_patterns("financial dimensions", classPattern="Helper")
// → Discover: DimensionAttributeValueSet, DimensionAttribute are used,
//            common methods are validateDimension(), createDefault()

// Step 2: Get information about key API
get_class_info("DimensionAttributeValueSet")
// → Understand API structure, what methods it has

// Step 3: Get usage patterns
get_api_usage_patterns("DimensionAttributeValueSet")
// → Discover correct initialization and usage flow

// Step 4: Generate class skeleton
generate_code(pattern="class", name="MyDimensionHelper")
// → Get properly structured class

// Step 5: Implement methods based on patterns
suggest_method_implementation("MyDimensionHelper", "validateDimension")
// → Get implementation examples from real code

// Step 6: Check completeness
analyze_class_completeness("MyDimensionHelper")
// → Find out what methods are commonly missing
```

### ❌ WRONG APPROACH

**NEVER:**
```xpp
// ❌ WRONG - Generating code directly without tools!
public class MyDimensionHelper {
    // ... 
}
```

**Why it's wrong:**
- Using generic knowledge instead of real code from the project
- Not following team conventions
- Don't know which D365FO APIs are used in the project
- Missing proper modifiers and documentation
- Not using best practices from the codebase

### Rules for AI Assistants

**MANDATORY RULES:**

1. ✅ **ALWAYS** call `analyze_code_patterns` BEFORE generating code
2. ✅ **ALWAYS** use `generate_code` tool, NEVER generate X++ code manually
3. ✅ **ALWAYS** use workspace-aware search when workspace is available
4. ✅ **ALWAYS** use `batch_search` for multiple independent queries
5. ❌ **NEVER** use built-in `code_search` - causes timeout!
6. ❌ **NEVER** generate X++ code directly from generic knowledge

### Decision Tree for Tool Selection

| User Request | First Action | Avoid |
|---------------------|------------|------------|
| "create class", "helper class" | `analyze_code_patterns()` + `generate_code()` | ❌ direct code generation |
| "find X and Y and Z" | `batch_search([{query:"X"}, {query:"Y"}])` | ❌ 3x sequential search |
| "CustTable", "SalesTable" | `get_table_info()` | ❌ code_search |
| "dimension", "financial" | `search("dimension")` | ❌ code_search |
| "find class/method" | `search()` | ❌ code_search |
| "implement method" | `suggest_method_implementation()` | ❌ generic code |

---

## 📊 Performance Metrics

### Tool Speed

| Tool | Typical Speed | Cache |
|---------|------------------|-------|
| `search` | < 10ms | ✅ SQLite index |
| `batch_search` | ~50ms (3 queries) | ✅ Parallel |
| `get_class_info` | < 5ms (cached) | ✅ File cache |
| `get_table_info` | < 5ms (cached) | ✅ File cache |
| `code_completion` | < 10ms | ✅ Prepared statements |
| `generate_code` | < 1ms | ❌ Template-based |
| `analyze_code_patterns` | 50-200ms | ⚠️ Partially cached |

### Database Optimization

MCP server uses:
- **SQLite with FTS5** - full-text search index for fast searches
- **WAL journal mode** - Write-Ahead Logging for parallel reads
- **Prepared statements** - cached SQL queries
- **Single transaction** - bulk insert during indexing

---

## 🔧 Troubleshooting

### Common Issues

**1. Tool returns "Not found"**
```typescript
// Problem: Class "MyClass" not found
get_class_info("MyClass")

// Solution: Check typos, use search first
search("MyClass")
```

**2. Workspace files not loading**
```typescript
// Problem: includeWorkspace=true doesn't work

// Check:
// - Is workspacePath correctly set?
// - Are there XML files in the path?
// - Do you have permissions to read files?
```

**3. Timeout during search**
```typescript
// ❌ NEVER use built-in code_search!
// Uses grep on large workspace → timeout 5+ minutes

// ✅ Instead:
search("myQuery")  // MCP tool - SQL index, < 10ms
```

**4. Missing methods in completion**
```typescript
// Problem: code_completion returns empty list

// Possible causes:
// - Class has no public methods
// - Wrong class name (typo)
// - Class not in index

// Solution: Check if class exists
search("MyClass", types=["class"])
```

---

## 📚 Additional Resources

- [README.md](../README.md) - Main documentation with workspace-aware features
- [USAGE_EXAMPLES.md](./USAGE_EXAMPLES.md) - More usage examples
- [SYSTEM_INSTRUCTIONS.md](./SYSTEM_INSTRUCTIONS.md) - Instructions for AI orchestrator
- [ARCHITECTURE.md](./ARCHITECTURE.md) - MCP server architecture

---

**Last updated:** February 12, 2026
