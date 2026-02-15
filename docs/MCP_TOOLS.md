# D365FO Code Intelligence Tools

**For GitHub Copilot Users in Visual Studio 2022**

This guide describes what you can ask GitHub Copilot when working with Dynamics 365 Finance & Operations. Simply type natural language questions in Copilot Chat, and it will use these tools automatically to search your D365FO environment and generate accurate code.

> **You don't need to know technical details** - just ask questions in plain English. Copilot handles the tool calls for you.

---

## What Can You Do?

1. [**Search for Code**](#search-for-code) - Find classes, tables, methods across D365FO
2. [**Explore Objects**](#explore-objects) - View structure of classes and tables
3. [**Generate Code**](#generate-code) - Create new classes following D365FO patterns
4. [**Create Files**](#create-files) - Generate D365FO XML files (classes, tables, forms)
5. [**Learn Patterns**](#learn-patterns) - See how APIs are used in your codebase

---

## Search for Code

### Find Classes and Tables

**Ask Copilot:**
- "Find all classes related to dimensions"
- "Show me tables for customer management"
- "Search for methods that calculate tax"
- "Find enums for sales status"

**What happens:** Copilot searches through 500,000+ D365FO symbols instantly and shows you matching classes, tables, methods, or fields.

**Examples:**
```
Q: "Find all classes containing 'dimension' in their name"
A: Shows: DimensionAttributeValueSet, DimensionDefaultingService, DimensionHelper...

Q: "Search for tables related to sales orders"
A: Shows: SalesTable, SalesLine, SalesFormLetter...

Q: "Find methods for validating customer credit"
A: Shows: CustTable.validateCreditLimit(), CreditManagement.checkCredit()...
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
