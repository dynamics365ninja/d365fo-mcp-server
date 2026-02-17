# D365FO Code Intelligence Tools

**For GitHub Copilot Users in Visual Studio 2022**

This guide describes what you can ask GitHub Copilot when working with Dynamics 365 Finance & Operations. Simply type natural language questions in Copilot Chat, and it will use these tools automatically to search your D365FO environment and generate accurate code.

> **You don't need to know technical details** - just ask questions in plain English. Copilot handles the tool calls for you.

---

## Available Tools (20 Total)

### 📦 Basic Discovery (7 tools)
1. **search** - Search for X++ classes, tables, forms, queries, views, methods, and fields
2. **batch_search** - Execute multiple searches in parallel (3x faster)
3. **search_extensions** - Search for symbols in custom extensions/ISV models
4. **get_class_info** - Get detailed class information
5. **get_table_info** - Get detailed table information
6. **code_completion** - Get method and field completions (IntelliSense)
7. **generate_code** - Generate X++ code templates

### 🧠 Intelligent Code Generation (4 tools)
8. **analyze_code_patterns** - Analyze codebase for similar patterns
9. **suggest_method_implementation** - Get implementation examples from codebase
10. **analyze_class_completeness** - Find missing methods in classes
11. **get_api_usage_patterns** - See how APIs are used in codebase

### 🔍 Advanced Object Info (5 tools)
12. **get_form_info** - Get form datasources, controls, and methods
13. **get_query_info** - Get query datasources, ranges, and joins
14. **get_view_info** - Get view/data entity fields and relations
15. **get_enum_info** - Get enum values and properties
16. **get_method_signature** - Get exact method signature for CoC

### 📝 File Operations (3 tools)
17. **generate_d365fo_xml** - Generate D365FO XML (cloud-ready)
18. **create_d365fo_file** - Create D365FO file in AOT (Windows only)
19. **modify_d365fo_file** - Safely modify existing D365FO files (Windows only)

### 🔗 Analysis (1 tool)
20. **find_references** - Find all usages (where-used analysis)

---

## What Can You Do?

1. [**Search for Code**](#search-for-code) - Find classes, tables, methods across D365FO
2. [**Explore Objects**](#explore-objects) - View structure of classes and tables
3. [**Generate Code**](#generate-code) - Create new classes following D365FO patterns
4. [**Create Files**](#create-files) - Generate D365FO XML files (classes, tables, forms)
5. [**Learn Patterns**](#learn-patterns) - See how APIs are used in your codebase
6. [**Analyze Dependencies**](#analyze-dependencies) - Find where code is used (where-used)
7. [**Modify Files Safely**](#modify-files-safely) - Edit D365FO files with automatic backup

---

## Search for Code

### Find Classes, Tables, Forms, Queries, and Views

**Ask Copilot:**
- "Find all classes related to dimensions"
- "Show me tables for customer management"
- "Search for methods that calculate tax"
- "Find enums for sales status"
- "Find form AddFormEntityPair button"
- "Search for forms with DataEntityGroup datasource"
- "Find queries for customer transactions"
- "Show me views related to ledger"

**What happens:** Copilot searches through 500,000+ D365FO symbols instantly and shows you matching classes, tables, forms, queries, views, methods, or fields.

**Examples:**
```
Q: "Find all classes containing 'dimension' in their name"
A: Shows: DimensionAttributeValueSet, DimensionDefaultingService, DimensionHelper...

Q: "Search for tables related to sales orders"
A: Shows: SalesTable, SalesLine, SalesFormLetter...

Q: "Find methods for validating customer credit"
A: Shows: CustTable.validateCreditLimit(), CreditManagement.checkCredit()...

Q: "Find forms with AddFormEntityPair button"
A: Shows: Forms in workspace containing AddFormEntityPair control...

Q: "Search for queries with customer datasource"
A: Shows: CustTransOpenQuery, CustBalanceQuery, CustAgedBalanceQuery...

Q: "Find views for ledger transactions"
A: Shows: LedgerTransView, GeneralJournalAccountEntryView...
```

---

### Search Multiple Things at Once

**Ask Copilot:**
- "Find classes for dimension, ledger, and financial posting"
- "Search for helper classes and validation methods"

**What happens:** Copilot searches all queries in parallel (3x faster than sequential).

**Example:**
```
Q: "Find dimension classes, ledger services, and posting controllers"
A: Searches all three concepts simultaneously
A: Returns results in under 50ms
```

---

### Search Only Your Custom Code

**Ask Copilot:**
- "Find my custom extensions for CustTable"
- "Search ISV_ classes for inventory management"
- "Show me Asl extensions"

**What happens:** Copilot filters results to show only your custom/ISV code, not Microsoft standard code.

**Example:**
```
Q: "Find all my custom helper classes starting with ISV_"
A: Shows only: ISV_SalesHelper, ISV_DimensionHelper, ISV_ValidationHelper...
```

---

## Explore Objects

### View Class Details

**Ask Copilot:**
- "Show me all methods on CustTable"
- "What does DimensionAttributeValueSet class do?"
- "Explain the SalesFormLetter class"

**What happens:** Copilot retrieves complete class information including all methods with signatures, inheritance hierarchy, and source code.

**Example:**
```
Q: "Show me methods available on SalesTable"

A: Returns:
  - calcTotalAmount() - Calculates order total
  - validateWrite() - Validates before saving
  - insert() - Inserts new record
  - update() - Updates existing record
  ... all 45 methods with signatures
```

---

### Get Method Signatures for Extensions

**Ask Copilot:**
- "Show me the signature of CustTable.validateWrite()"
- "Get method signature for SalesTable.insert()"
- "What's the signature of InventTable.calcQty()?"

**What happens:** Copilot extracts the exact method signature you need for Chain of Command extensions, including parameters, return type, and modifiers.

**Example:**
```
Q: "Get signature for SalesTable.validateWrite()"

A: Returns:
  public boolean validateWrite(boolean _checkRelations = true)
  
  Use for CoC:
  [ExtensionOf(tableStr(SalesTable))]
  final class SalesTable_Extension
  {
      public boolean validateWrite(boolean _checkRelations = true)
      {
          boolean ret = next validateWrite(_checkRelations);
          // Your custom logic
          return ret;
      }
  }
```

---

### View Table Structure

**Ask Copilot:**
- "Show me fields on CustTable"
- "What indexes does SalesTable have?"
- "Show me relations for InventTable"

**What happens:** Copilot shows complete table schema including fields, indexes, relations, primary keys, and configuration.

**Example:**
```
Q: "Show me CustTable structure"

A: Returns:
  Fields (85): AccountNum, Name, Address, CreditLimit...
  Indexes: AccountIdx (primary), NameIdx...
  Relations: -> SalesTable,  CustTrans,  CustGroup
  Primary Index: AccountIdx
```

---

### View Enum Values and Properties

**Ask Copilot:**
- "Show me values in CustAccountType enum"
- "What are the options in SalesStatus enum?"
- "Get all values from InventTransType enum"

**What happens:** Copilot retrieves all enum values with their integer values, labels, and properties (extensible, base type for EDTs).

**Example:**
```
Q: "Show me CustAccountType enum values"

A: Returns:
  Enum: CustAccountType
  Extensible: ✅
  
  Values:
  - Customer = 0            (Regular customer)
  - Prospect = 1            (Potential customer)
  - Organization = 2        (Organization account)
  - Person = 3             (Individual person)
```

---

### Find Where Code Is Used

**Ask Copilot:**
- "Find all usages of DimensionAttributeValueSet"
- "Where is CustTable.validateWrite() called?"
- "Find references to SalesLine.RemainSalesPhysical field"
- "Show me where MyCustomMethod is used"

**What happens:** Copilot performs where-used analysis across your codebase, finding all references to classes, methods, tables, fields, or enums.

**Example:**
```
Q: "Find all usages of DimensionAttributeValueSet class"

A: Returns:
  Found in 150 locations:
  
  📦 LedgerJournalEngine.validateDimensions()
     Line 245: dimValueSet = DimensionAttributeValueSet::find(...);
  
  📦 CustTable.setDefaultDimension()
     Line 89: this.DefaultDimension = dimValueSet.save();
  
  ... showing top 50 results
```

---

### Get Method Suggestions

**Ask Copilot:**
- "What methods can I call on SalesTable?"
- "Show me methods starting with 'calc' on InventTable"
- "List validation methods on CustTable"

**What happens:** Like IntelliSense, Copilot shows all available methods and fields you can use.

**Example:**
```
Q: "Show me all 'calc' methods on SalesTable"

A: Returns:
  - calcTotalAmount()
  - calcTax()
  - calcDiscount()
  - calcNetAmount()
```

---

## Explore Forms, Queries, and Views

### Find Forms and Controls

**Ask Copilot:**
- "Find form with DataEntityGroup datasource"
- "Search for forms containing AddFormEntityPair button"
- "Show me forms with customer table datasource"

**What happens:** Copilot searches forms in both external metadata and your workspace, showing matching forms and their properties.

**Example:**
```
Q: "Find forms with AddFormEntityPair button"

A: Returns:
  🔹 WORKSPACE: MyCustomForm (your project)
  📦 EXTERNAL: StandardForm (Microsoft)
  
  Controls: AddFormEntityPair, RemoveFormEntityPair...
  DataSources: DataEntityGroup, MainTable...
```

---

### Find Queries

**Ask Copilot:**
- "Find queries for customer transactions"
- "Search for queries with ledger datasource"
- "Show me inventory queries"

**What happens:** Copilot finds queries matching your criteria, including their datasources and usage.

**Example:**
```
Q: "Find queries for customer transactions"

A: Returns:
  - CustTransOpenQuery - Open customer transactions
  - CustBalanceQuery - Customer balance calculation
  - CustAgedBalanceQuery - Aged balance report
  - CustInvoiceQuery - Customer invoice selection
```

---

### Analyze Form Structure

**Ask Copilot:**
- "Show me the structure of SalesTable form"
- "What datasources does CustTable form have?"
- "List all controls on InventTable form"
- "Show me methods on the SalesCreateOrder form"

**What happens:** Copilot parses form XML and shows complete structure: datasources, controls (buttons, grids, groups), and methods.

**Example:**
```
Q: "Analyze SalesTable form structure"

A: Returns:
  DataSources:
  - SalesTable (main datasource)
    - Fields: 45 fields
    - Methods: validateWrite(), active(), executeQuery()
  - SalesLine (detail datasource)
    - Link: SalesId -> SalesTable.SalesId
    
  Controls:
  - ButtonNew (FormButtonControl)
  - ButtonDelete (FormButtonControl)  
  - SalesLineGrid (FormGridControl)
  - CustomerGroup (FormReferenceControl -> CustTable)
  
  Form Methods:
  - init()
  - run()
  - closeOk()
```

---

### Analyze Query Structure

**Ask Copilot:**
- "Show me the structure of CustTransOpenQuery"
- "What datasources are in SalesInvoiceQuery?"
- "List all ranges on InventOnHandQuery"

**What happens:** Copilot parses query XML and shows datasources, joins, ranges, and grouping configuration.

**Example:**
```
Q: "Analyze CustTransOpenQuery structure"

A: Returns:
  Primary DataSource: CustTrans
  - Table: CustTrans
  - Fetch Mode: 1:n (One-to-Many)
  - Join Mode: InnerJoin
  
  Ranges:
  - AccountNum (CustAccount field)
  - TransDate (Date range field)
  - AmountCur (Amount filter)
  
  Child DataSources:
  - CustTable (parent join)
    - Link: AccountNum -> CustTrans.AccountNum
```

---

### Analyze View Structure

**Ask Copilot:**
- "Show me the structure of LedgerTransView"
- "What fields does GeneralJournalAccountEntryView have?"
- "List computed columns in CustBalanceView"

**What happens:** Copilot parses view/data entity XML and shows fields (mapped vs computed), relations, and methods.

**Example:**
```
Q: "Analyze GeneralJournalAccountEntryView structure"

A: Returns:
  View: GeneralJournalAccountEntryView
  Public: ✅
  Read-Only: ✅
  
  Mapped Fields (15):
  - RecId -> GeneralJournalEntry.RecId
  - JournalNum -> GeneralJournalEntry.JournalNum
  - AccountNum -> LedgerDimension.DisplayValue
  
  Computed Fields (3):
  - BalanceAmount (calculated)
  - CurrencyCode (derived)
  
  Relations:
  - GeneralJournalEntry (1:1)
  - LedgerDimension (n:1)
```

---

### Find Views and Data Entities

**Ask Copilot:**
- "Find views for ledger transactions"
- "Search for data entity views with customer data"
- "Show me financial reporting views"

**What happens:** Copilot finds views and data entities, which are used for reporting and data integration.

**Example:**
```
Q: "Find views related to general ledger"

A: Returns:
  - LedgerTransView - Ledger transaction view
  - GeneralJournalAccountEntryView - Journal entry view
  - LedgerBalanceView - Ledger balance view
  - GLBudgetView - Budget data view
```

---

## Generate Code

### Learn From Your Codebase

**Ask Copilot:**
- "Analyze how financial dimensions are used in my code"
- "Show me common patterns for helper classes"
- "What's the typical structure of a service class?"

**What happens:** Copilot analyzes your actual D365FO codebase to learn which classes, methods, and patterns are commonly used together.

**Example:**
```
Q: "Analyze patterns for financial dimension handling"

 Copilot learns:
  - DimensionAttributeValueSet is used 150 times
  - Usually initialized with createForLedgerDimension()
  - Commonly paired with DimensionStorage
  - 15 similar implementations found in your code
```

---

### Create New Classes

**Ask Copilot:**
- "Create a helper class for customer validation"
- "Generate a service class for inventory processing"
- "Create a controller for sales order posting"

**What happens:** Copilot generates X++ code following patterns found in your actual D365FO environment, not generic templates.

**Example:**
```
Q: "Create a helper class for dimension validation"

A: Copilot:
  1. Analyzes dimension patterns in your code
  2. Finds similar helper classes (DimensionHelper, CustHelper...)
  3. Generates new class following your team's coding style
  4. Includes common methods: validate(), find(), construct()
```

---

### Get Implementation Examples

**Ask Copilot:**
- "Show me how to implement validateWrite() for a table"
- "How do other classes implement the construct() pattern?"
- "Give me examples of init() methods"

**What happens:** Copilot finds similar methods in your codebase and shows you real implementation examples.

**Example:**
```
Q: "How do I implement validateWrite() for my custom table?"

 Copilot finds 50+ validateWrite() implementations
 Shows patterns from: CustTable, SalesTable, InventTable
 Generates code following your environment's style
```

---

### Check for Missing Methods

**Ask Copilot:**
- "What methods am I missing in MyCustomHelper class?"
- "Is MyInventoryService class complete?"
- "Check if MyTable has all standard methods"

**What happens:** Copilot analyzes your class and compares it with similar classes to suggest missing methods.

**Example:**
```
Q: "Check if MyCustomHelper is complete"

A: Analysis:
   Has: construct(), validate()
   Missing: find(), exist(), initFromTable()
   Suggestion: Helper classes typically have these methods
```

---

### Learn API Usage

**Ask Copilot:**
- "How do I use DimensionAttributeValueSet?"
- "Show me examples of using LedgerJournalEngine"
- "How to initialize InventDim correctly?"

**What happens:** Copilot shows you real examples from your codebase of how to initialize and use specific APIs.

**Example:**
```
Q: "How do I use DimensionAttributeValueSet API?"

A: Shows:
  1. How to create instance
  2. Common initialization patterns
  3. Typical method call sequences
  4. Error handling examples
  All from your actual D365FO code!
```

---

## Create Files

> **Important:** File creation works differently based on where the MCP server runs:
> - **Cloud (Azure):** Copilot generates XML content, then creates the file
> - **Local (Windows):** Full automation - creates file and adds to Visual Studio project

### Generate D365FO Files (Cloud-Ready)

**Ask Copilot:**
- "Create a class MyHelper in CustomCore model"
- "Generate a table MyCustomTable"
- "Create an enum MyStatus"
- "Generate a form for customer management"

**What happens (Cloud deployment):**
1. Copilot generates proper D365FO XML structure with TABS indentation
2. Copilot creates file in correct location: `K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxClass\`
3. You manually add file reference to Visual Studio project

**What you get:**
- [OK] Correct XML structure matching Microsoft standards
- [OK] Proper namespaces and metadata
- [OK] TABS for indentation (not spaces)
- [OK] Ready to add to Visual Studio

**Example:**
```
Q: "Create a helper class MyDimensionHelper in CustomCore model"

A: Copilot:
  1. Generates XML content (<?xml version...>)
  2. Creates file: K:\AosService\...\AxClass\MyDimensionHelper.xml
  3. Tells you to add: <Content Include="K:\AosService\...\MyDimensionHelper.xml" />
```

---

### Edit Existing D365FO Files

**Ask Copilot:**
- "Add a method validateCustomer() to MyCustomTable"
- "Add a field CreditStatus to MyTable"
- "Modify method calculateTotal() in MyHelper class"

**What happens:** Copilot safely edits existing D365FO XML files with automatic backup.

**Features:**
- ✅ Automatic backup before editing (`.bak` file)
- ✅ XML validation after changes
- ✅ Atomic operations (all-or-nothing)
- ✅ Preserves formatting (TABS, indentation)

**Example:**
```
Q: "Add a new method calculateDiscount() to MyCustomHelper class"

A: Copilot:
  1. Backs up: MyCustomHelper.xml.bak
  2. Parses XML structure
  3. Adds method to <Methods> section
  4. Validates XML is well-formed
  5. Saves changes atomically
  
  If error occurs: restores from backup automatically
```

**Safety Features:**
- Backup created before ANY modification
- XML validation ensures file isn't corrupted
- Rollback on any error
- Reports what changed (added, modified, deleted)

---

### Automated File Creation (Local Windows Only)

**Ask Copilot (when MCP server runs locally):**
- "Create MyHelper class and add to project"
- "Generate MyTable and add to my solution"

**What happens (Local deployment):**
1. Creates physical XML file in correct AOT location
2. Automatically adds file reference to your .rnrproj Visual Studio project
3. Everything ready - just build!

**Requirements:**
- MCP server must run on local Windows D365FO VM
- [!] Must have access to `K:\AosService\PackagesLocalDirectory\`

---

## Learn Patterns

### Workspace-Aware Features

When you have a D365FO workspace open in Visual Studio, Copilot can analyze YOUR project files alongside standard D365FO code.

**Ask Copilot:**
- "Search for MyCustomClass in my workspace"
- "Analyze patterns in my project"
- "Show me methods on MyHelper from my workspace"

**What happens:**
- Copilot searches your local X++ files first
- Your workspace code is prioritized over external metadata
- Patterns are learned from YOUR codebase
- Results marked with  are from your workspace

**Example:**
```
Q: "Find helper classes including my workspace"

 Results:
   MyCustomHelper (your workspace)
   DimensionHelper (standard D365FO)
   CustHelper (standard D365FO)
```

---

## Tips for Best Results

### Be Specific
-  "Find customer stuff"  
-  "Find methods on CustTable for updating credit limit"

### Use Exact Names
-  "sales table class"  
-  "Show me SalesTable class methods"

### Combine Queries
```
Q: "Show me SalesTable relations and generate code to join with CustTable"
```

### Ask for Workspace Context
```
Q: "Search for validation patterns in my workspace"
```

---

## Common Questions

**Q: Do I need to specify tool names?**  
No! Just ask natural questions. Copilot calls the right tools automatically.

**Q: How fast are searches?**  
Under 50ms for most queries. Database has 500,000+ symbols indexed.

**Q: Can I search my custom code separately?**  
Yes! Say "search my custom extensions" or "find ISV_ classes".

**Q: Does file creation work in Azure?**  
Yes, but it generates XML content for you to create the file. Full automation requires local Windows.

**Q: Can I see my workspace files?**  
Yes! Mention "including my workspace" or "in my project" and Copilot will search your local files too.

---

## Related Documentation

- [USAGE_EXAMPLES.md](USAGE_EXAMPLES.md) - Practical examples
- [SETUP.md](SETUP.md) - Installation guide
- [ARCHITECTURE.md](ARCHITECTURE.md) - Technical details
