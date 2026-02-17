**🚨 CRITICAL INSTRUCTION - READ FIRST - HIGHEST PRIORITY 🚨**

**FILE CREATION RULE (ABSOLUTE, NO EXCEPTIONS):**

When creating ANY D365FO file (class, table, form, enum, query, view):

🔥 **ALWAYS use create_d365fo_file FIRST**
❌ **NEVER use generate_d365fo_xml as first choice**
❌ **NEVER use built-in create_file for D365FO objects**

**Workflow:**
1. ALWAYS call: create_d365fo_file(objectType, objectName, modelName, addToProject=true)
2. IF it fails with "requires file system access" → THEN use generate_d365fo_xml + create_file
3. OTHERWISE → DONE, file is created with UTF-8 BOM

**Why this matters:**
- create_d365fo_file: ✅ UTF-8 BOM, ✅ correct location, ✅ adds to VS project
- generate_d365fo_xml: ❌ returns TEXT only, requires manual file creation
- Built-in create_file: ❌ no UTF-8 BOM → encoding errors

═══════════════════════════════════════════════════════════════════════════════

**PATTERN DETECTION RULES (NO EXCEPTIONS):**

If the user's query contains **ANY** of these patterns:
- Dot notation: `vendTrans.Invoice`, `custTable.AccountNum`, `salesLine.Qty`, `*.SomethingElse`
- Table suffixes: `vendTrans`, `custTrans`, `*Trans`, `*Table`, `*Line`, `*Header`, `*Journal`
- Field names: `Invoice`, `Voucher`, `AccountNum`, `ItemId`, `Qty`, `RecId`
- D365FO terms: `X++`, `D365FO`, `AxClass`, `AxTable`, `validateWrite`

**THEN YOU MUST:**
- ✅ USE MCP tools: `search()`, `find_references()`, `get_class_info()`, `get_table_info()`
- ❌ **NEVER EVER** use: `code_search()`, `file_search()`, `grep_search()`, `create_file()` for D365FO

**EXPLICIT EXAMPLES:**
```
Query: "write function... use where vendTrans.Invoice is used"
Detection: ✅ vendTrans.Invoice = DOT NOTATION = D365FO!
Action: search("Invoice", type="field") + find_references("Invoice", "field")
FORBIDDEN: ❌ code_search("vendTrans.Invoice") - WILL HANG!

Query: "show me CustTable fields"
Detection: ✅ CustTable = TABLE SUFFIX *Table = D365FO!
Action: get_table_info("CustTable")
FORBIDDEN: ❌ code_search("CustTable") - WILL HANG!

Query: "create class MyHelper"
Detection: ✅ D365FO class creation!
Action: create_d365fo_file(objectType="class", objectName="MyHelper", modelName="...", addToProject=true)
FORBIDDEN: ❌ generate_d365fo_xml or create_file - ENCODING ERRORS!
```

**NO EXCEPTIONS. NO EXCUSES. THIS IS ABSOLUTE.**

═══════════════════════════════════════════════════════════════════════════════

# D365FO X++ Development — GitHub Copilot Instructions for Visual Studio 2022

> **🔴 ABSOLUTE REQUIREMENT: You MUST use MCP tools for ALL D365FO/X++ operations.**
> **Built-in IDE tools (code_search, file_search, grep_search, create_file) are FORBIDDEN for D365FO.**
>
> **Version:** 3.0 (Updated: February 2026)
> **IDE:** Visual Studio 2022 17.14+ with GitHub Copilot Agent Mode
> **Coverage:** 22 MCP Tools — search, object analysis, code generation, file operations, where-used analysis

---

# ⛔ IMMEDIATE ACTION REQUIRED — CHECK BEFORE EVERY RESPONSE ⛔

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  🚨 CRITICAL PRE-FLIGHT CHECK — EXECUTE BEFORE ANY TOOL CALL 🚨              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  QUESTION: Does the user's query contain ANY of these patterns?             │
│                                                                              │
│  ✓ Dot notation with PascalCase?     (vendTrans.Invoice, custTable.AccountNum) │
│  ✓ Table name suffixes?              (*Trans, *Table, *Line, *Header, *Journal) │
│  ✓ D365FO field names?                (Invoice, Voucher, AccountNum, ItemId, Qty) │
│  ✓ D365FO keywords?                   (X++, D365FO, AxClass, AxTable, validateWrite) │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  IF YES TO ANY → THIS IS D365FO!                                    │   │
│  │  ❌ DO NOT use: code_search, file_search, grep_search              │   │
│  │  ✅ USE ONLY: MCP tools (search, find_references, get_*_info)      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  IF NO → Safe to use built-in tools                                         │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

**EXAMPLES REQUIRING MCP TOOLS:**
```
❌ "write function... use where vendTrans.Invoice is used"  → USES: vendTrans.Invoice (D365FO!)
❌ "show me CustTable fields"                                → USES: CustTable (D365FO!)
❌ "find where validateWrite is called"                      → USES: validateWrite (D365FO!)
❌ "create class MyHelper extends SalesTable"                → USES: SalesTable (D365FO!)

✅ ALL ABOVE → USE MCP TOOLS ONLY
```

## QUICK DECISION FLOWCHART

```
User Query
    │
    ├─ Contains: something.SomethingElse (PascalCase)?         → MCP TOOLS
    ├─ Contains: *Trans, *Table, *Line, *Header?               → MCP TOOLS  
    ├─ Contains: Invoice, Voucher, AccountNum, ItemId, Qty?    → MCP TOOLS
    ├─ Contains: X++, D365FO, AxClass, AxTable, validateWrite? → MCP TOOLS
    ├─ Mentions: "where X is used" with above patterns?        → MCP TOOLS
    │
    └─ None of above?                                           → Built-in tools OK
```

**IF IN DOUBT → USE MCP TOOLS! They are fast (<100ms) and never wrong.**

---

# 🚨 CRITICAL POLICY — READ FIRST 🚨

## Principle: MCP-ONLY for D365FO

> **🚨 If you see dot notation like `vendTrans.Invoice`, `custTable.AccountNum`, `salesLine.Qty` — this is D365FO!**
> **YOU MUST use MCP tools, NOT code_search/file_search/grep_search!**

**For ANY D365FO/X++ query, you MUST:**
1. ✅ **ALWAYS** use MCP tools FIRST — they query the ACTUAL D365FO environment in real-time
2. ❌ **NEVER** use built-in `code_search` — causes 5+ minute hangs on 500k+ symbol workspaces
3. ❌ **NEVER** use built-in `file_search` or `grep_search` for X++ objects — they don't understand D365FO metadata
4. ❌ **NEVER** use built-in `create_file` for AxClass/AxTable/AxForm/AxEnum — wrong XML structure (spaces vs TABS), wrong location
5. ❌ **NEVER** generate D365FO code without querying MCP tools first — training data is outdated

**Why This Matters:**
- MCP tools use an indexed SQLite database with FTS5 (584,799+ symbols, <100ms queries)
- Built-in tools scan the entire workspace file system → 5-10 minute hangs
- MCP tools understand X++ semantics (inheritance, EDT, relations, forms, queries)
- D365FO XML files require TABS for indentation — `create_file` uses spaces

**🚨 DETECTION EXAMPLES — These patterns REQUIRE MCP tools:**
```
❌ WRONG: code_search("vendTrans.Invoice") 
✅ RIGHT: search("Invoice", type="field") + find_references("Invoice", "field")

❌ WRONG: grep_search("CustTable") 
✅ RIGHT: search("CustTable", type="table") + get_table_info("CustTable")

❌ WRONG: file_search("**/SalesLine*")
✅ RIGHT: search("SalesLine", type="table") + search("SalesLine", type="class")
```

---

# 🎯 DETECTION: When Am I in D365FO Context?

> **🚨 CRITICAL: If you see dot notation like `vendTrans.Invoice`, `custTable.AccountNum`, `salesLine.Qty` — this is D365FO!**
> **YOU MUST use MCP tools, NOT code_search/file_search/grep_search!**

**Use MCP tools when you see ANY of these triggers:**

### 🔴 PRIMARY DETECTION PATTERNS (Most Common)

#### Dot Notation with PascalCase (D365FO Field Access)
**Pattern:** `variable.PascalCaseField` 
**Examples that MUST trigger MCP tools:**
- `vendTrans.Invoice` → VendTrans table, Invoice field
- `custTable.AccountNum` → CustTable table, AccountNum field  
- `salesLine.Qty` → SalesLine table, Qty field
- `inventTrans.Voucher` → InventTrans table, Voucher field
- ANY `something.SomethingElse` pattern with PascalCase

**⚠️ If user query contains ANY dot notation pattern → USE MCP TOOLS, NOT built-in search!**

#### Table Name Suffixes
- **Transaction tables**: `*Trans` (VendTrans, CustTrans, InventTrans, LedgerTrans, etc.)
- **Master tables**: `*Table` (CustTable, VendTable, SalesTable, PurchTable, etc.)
- **Line tables**: `*Line` (SalesLine, PurchLine, InventJournalLine, etc.)
- **Header tables**: `*Header` (SalesHeader, PurchHeader, etc.)
- **Journal tables**: `*Journal` (LedgerJournal, InventJournal, etc.)
- **Parameter tables**: `*Parameters`, `*Parm*`

### Additional Naming Patterns

- **Class suffixes**: `*Service`, `*Helper`, `*Contract`, `*Controller`, `*Builder`, `*Manager`, `*Engine`
- **Form suffixes**: `*Form`, `*Dialog`, `*Page`, `*Lookup`
- **Enum & Status**: `*Status`, `*Type`, `*Mode`, `*Blocked`

### Common D365FO Field Names
- **Document fields**: `Invoice`, `Voucher`, `DocumentNum`, `TransId`
- **Account fields**: `AccountNum`, `CustAccount`, `VendAccount`, `LedgerAccount`
- **Item fields**: `ItemId`, `ItemName`, `ItemGroupId`
- **Quantity & Amount**: `Qty`, `Amount`, `Price`, `LineAmount`, `TotalAmount`, `CurrencyCode`
- **Dates**: `TransDate`, `PostingDate`, `DueDate`, `DeliveryDate`, `AccountingDate`
- **System fields**: `RecId`, `DataAreaId`, `Partition`, `RecVersion`, `ModifiedBy`, `CreatedDateTime`
- **Reference fields**: `RefRecId`, `RefTableId`, `ParentRecId`

### Keywords & Technologies
- `X++`, `D365FO`, `D365`, `Dynamics 365`, `Finance & Operations`, `AX`, `Axapta`
- `AxClass`, `AxTable`, `AxForm`, `AxEnum`, `AxQuery`, `AxView`, `AxDataEntityView`, `EDT`
- `AOT`, `PackagesLocalDirectory`, `K:\AosService`

### Form Elements
- `button`, `control`, `FormDataSource`, `FormControl`, `ButtonControl`, `FormButtonControl`
- `FormGroupControl`, `FormGridControl`, `FormReferenceControl`, `FormTab`, `FormActionPane`
- `datasource`, `data source`, `main datasource`, `primary datasource`, `form datasource`
- `add method to datasource`, `override datasource method`, `form datasource active`
- `enable button`, `disable button`, `button enabled based on`, `control visibility`
- Form methods: `init`, `run`, `close`, `canClose`, `active`
- Datasource methods: `active`, `validateWrite`, `validateDelete`, `create`, `write`, `delete`, `init`, `executeQuery`

### Query, View, Enum Elements
- `QueryRun`, `QueryBuildDataSource`, `QueryBuildRange`, `addDataSource`, `addRange`, `findDataSource`
- `AxView`, `data entity view`, `computed columns`, `DataEntity`, `DataEntityView`, `staging table`
- Enum values, extensible enums, base enums

### Extension & Method Keywords
- `Chain of Command`, `CoC`, `ExtensionOf`, `next`, `super()`
- `EventHandler`, `DataEventHandler`, `FormEventHandler`, `FormDataSourceEventHandler`
- `add method`, `create method`, `override method`, `extend method`

### Data Operations
- `validateWrite`, `insert`, `update`, `delete`, `select`, `while select`
- `ttsbegin`, `ttscommit`, `ttsabort`
- Financial dimensions, inventory management, sales orders, purchase orders, ledger posting

**IF YOU SEE ANY OF THESE → STOP → USE MCP TOOLS!**

---

# 🛠️ AVAILABLE MCP TOOLS — COMPLETE REFERENCE (22 Tools)

## 1. Core Discovery Tools

### `search`
**Purpose:** Find any D365FO object across 584,799+ indexed symbols.
**Parameters:**
- `query` (string, required) — search term
- `type` (enum, optional, default: "all") — `class` | `table` | `form` | `field` | `method` | `enum` | `query` | `view` | `all`
- `limit` (number, optional, default: 20) — max results
- `includeWorkspace` (boolean, optional, default: false) — include local workspace files
- `workspacePath` (string, optional) — path to workspace for hybrid search

**When to use:** Finding objects by name or keyword, semantic search ("methods related to totals"), exploratory discovery.
**Response time:** <100ms (cached <10ms)

### `batch_search`
**Purpose:** Execute multiple independent searches in parallel (3x faster than sequential).
**Parameters:**
- `queries` (array of 1-10 objects, required) — each object has: `query`, `type`, `limit`, `workspacePath`, `includeWorkspace`

**When to use:** User asks about multiple unrelated things at once.

### `search_extensions`
**Purpose:** Find only custom/ISV code, excluding Microsoft standard objects.
**Parameters:**
- `query` (string, required) — search term
- `prefix` (string, optional) — extension prefix filter (e.g., "ISV_", "Custom_")
- `limit` (number, optional, default: 20)

**When to use:** User says "my", "custom", "our extensions", "ISV".

## 2. Object Structure Tools

### `get_class_info`
**Purpose:** Get complete class structure — methods with signatures, inheritance hierarchy, source code.
**Parameters:**
- `className` (string, required) — exact class name
- `includeWorkspace` (boolean, optional, default: false)
- `workspacePath` (string, optional)

**Returns:** Class declaration, extends/implements chain, all methods with visibility, return type, parameters, source code.

### `get_table_info`
**Purpose:** Get complete table schema — fields, indexes, relations, methods.
**Parameters:**
- `tableName` (string, required) — exact table name

**Returns:** Fields with types/EDT/mandatory, indexes (unique/clustered), relations with constraints, table methods.

### `get_form_info`
**Purpose:** Get form structure — datasources, controls (buttons, grids), methods.
**Parameters:**
- `formName` (string, required)
- `modelName` (string, optional) — auto-detected if not provided
- `includeControls` (boolean, optional, default: true)
- `includeDataSources` (boolean, optional, default: true)
- `includeMethods` (boolean, optional, default: true)
- `includeWorkspace` (boolean, optional, default: false)
- `workspacePath` (string, optional)

**Returns:** Datasource list (table, allowEdit/Create/Delete, fields, methods), control hierarchy, form-level methods.

### `get_query_info`
**Purpose:** Get query structure — datasources, ranges, joins, fields.
**Parameters:**
- `queryName` (string, required)
- `modelName` (string, optional)
- `includeRanges` (boolean, optional, default: true)
- `includeJoins` (boolean, optional, default: true)
- `includeFields` (boolean, optional, default: true)
- `includeWorkspace` (boolean, optional, default: false)
- `workspacePath` (string, optional)

**Returns:** Primary datasource, child datasources with joins, range definitions, field lists.

### `get_view_info`
**Purpose:** Get view/data entity structure — mapped fields, computed columns, relations.
**Parameters:**
- `viewName` (string, required)
- `modelName` (string, optional)
- `includeFields` (boolean, optional, default: true)
- `includeRelations` (boolean, optional, default: true)
- `includeMethods` (boolean, optional, default: true)
- `includeWorkspace` (boolean, optional, default: false)
- `workspacePath` (string, optional)

**Returns:** Mapped vs computed fields, relation definitions, view methods.

### `get_enum_info`
**Purpose:** Get enum values with labels, or EDT properties.
**Parameters:**
- `enumName` (string, required)
- `modelName` (string, optional)
- `includeLabels` (boolean, optional, default: true)
- `includeWorkspace` (boolean, optional, default: false)
- `workspacePath` (string, optional)

**Returns:** Enum values (name, integer value, label), extensible flag, or EDT base type and properties.

### `get_method_signature`
**Purpose:** Get exact method signature for Chain of Command (CoC) extensions.
**Parameters:**
- `className` (string, required) — class containing the method
- `methodName` (string, required) — method name
- `modelName` (string, optional)
- `includeWorkspace` (boolean, optional, default: false)
- `workspacePath` (string, optional)

**Returns:** Modifiers, return type, parameters with types and defaults, ready-to-use CoC template.

### `code_completion`
**Purpose:** IntelliSense-style method/field discovery with prefix filtering.
**Parameters:**
- `className` (string, **REQUIRED**) — class or table name
- `prefix` (string, optional, default: "") — filter by prefix
- `includeWorkspace` (boolean, optional, default: false)
- `workspacePath` (string, optional)

**⚠️ CRITICAL:** `className` is REQUIRED. Without it, the tool fails with validation error.
**When to use:** Prefix-based filtering ("methods starting with calc"). For semantic search ("methods related to totals"), use `search` instead.

### `find_references`
**Purpose:** Where-used analysis — find all usages of a symbol across the codebase.
**Parameters:**
- `symbolName` (string, required) — name of the symbol
- `symbolType` (enum, optional) — `method` | `class` | `table` | `field` | `enum`
- `scope` (enum, optional, default: "all") — `all` | `workspace` | `standard` | `custom`
- `limit` (number, optional, default: 50)
- `includeContext` (boolean, optional, default: true) — include surrounding code

**Returns:** File paths, line numbers, code context, reference type (call, extends, implements, field-access, instantiation, type-reference).

## 3. Intelligent Code Generation Tools

### `analyze_code_patterns`
**Purpose:** Discover real D365FO patterns from the codebase for a given scenario.
**Parameters:**
- `scenario` (string, required) — domain to analyze (e.g., "financial dimensions", "validation", "customer")
- `classPattern` (string, optional) — class name pattern filter (e.g., "Helper", "Service")
- `limit` (number, optional, default: 20)

**Returns:** Detected patterns with counts, common methods with frequency, common dependencies.
**🔴 MANDATORY:** Use this BEFORE any code generation to learn actual codebase patterns.

### `suggest_method_implementation`
**Purpose:** Get real implementation examples from the codebase for a specific method.
**Parameters:**
- `className` (string, required)
- `methodName` (string, required)
- `parameters` (array of {name, type}, optional)
- `returnType` (string, optional, default: "void")

**Returns:** Similar methods from codebase with complexity analysis and implementation patterns.

### `analyze_class_completeness`
**Purpose:** Find commonly missing methods by comparing with similar classes.
**Parameters:**
- `className` (string, required)

**Returns:** Existing methods, suggested missing methods with importance ranking (🔴 Very common, 🟠 Common, 🟡 Somewhat common).

### `get_api_usage_patterns`
**Purpose:** See how a D365FO API/class is used in the codebase — initialization, method sequences, error handling.
**Parameters:**
- `className` (string, required) — API class name

**Returns:** Common initialization patterns, typical method call sequences, real code examples.

### `generate_code`
**Purpose:** Generate X++ code templates following D365FO patterns.
**Parameters:**
- `pattern` (enum, required) — `class` | `runnable` | `form-handler` | `data-entity` | `batch-job` | `coc-extension` | `event-handler` | `service-class`
- `name` (string, required)
- `options` (object, optional) — `baseClass`, `tableName`, `formName`

**🔴 MANDATORY:** NEVER generate X++ code without using this tool. Always use `analyze_code_patterns` first.

## 4. File Operations Tools

### `generate_d365fo_xml`
**Purpose:** Generate D365FO XML content with correct structure (TABS indentation, proper namespaces). Does NOT write to disk — returns XML as text.
**Parameters:**
- `objectType` (enum, required) — `class` | `table` | `enum` | `form` | `query` | `view` | `data-entity`
- `objectName` (string, required)
- `modelName` (string, required)
- `sourceCode` (string, optional) — X++ source code
- `properties` (object, optional) — extends, implements, label, etc.

**When to use:** When MCP server runs in Azure/cloud (no file system access). Get XML → use client-side `create_file` to save.

### `create_d365fo_file`
**Purpose:** Create physical D365FO XML file in correct AOT location + optionally add to VS project.
**Parameters:**
- `objectType` (enum, required) — `class` | `table` | `enum` | `form` | `query` | `view` | `data-entity`
- `objectName` (string, required)
- `modelName` (string, required) — extract from workspace path, NEVER ask user
- `packagePath` (string, optional, default: "K:\\AosService\\PackagesLocalDirectory")
- `sourceCode` (string, optional) — X++ source code
- `properties` (object, optional)
- `addToProject` (boolean, optional, default: false) — add to .rnrproj automatically
- `projectPath` (string, optional) — path to .rnrproj
- `solutionPath` (string, optional) — VS solution directory for auto-detection

**When to use:** Creating ANY D365FO object. Creates file at correct path: `{packagePath}/{model}/{model}/AxClass/{name}.xml`
**⚠️ Works only when MCP server runs on local Windows with K:\ drive access.**

### `modify_d365fo_file`
**Purpose:** Safely edit existing D365FO XML files with automatic backup and validation.
**Parameters:**
- `objectType` (enum, required) — `class` | `table` | `form` | `enum` | `query` | `view`
- `objectName` (string, required)
- `operation` (enum, required) — `add-method` | `add-field` | `modify-property` | `remove-method` | `remove-field`
- For `add-method`: `methodName`, `methodCode`, `methodModifiers`, `methodReturnType`, `methodParameters`
- For `add-field` (tables): `fieldName`, `fieldType`, `fieldMandatory`, `fieldLabel`
- For `modify-property`: `propertyPath`, `propertyValue`
- `createBackup` (boolean, optional, default: true)
- `modelName` (string, optional)
- `workspacePath` (string, optional)

**When to use:** Adding methods/fields to existing D365FO objects with safe atomic operations.
**⚠️ Works only when MCP server has file system access (local Windows). For Azure/cloud, use `replace_string_in_file` instead.**

---

# 📋 DECISION TREES — Follow These EXACTLY

## Scenario 1: User Asks to Find Something

**Triggers:** "find", "search", "show me", "where is", "locate", "najdi", "hledej"

```
🛑 STOP: Check user query for D365FO patterns (dot notation, table suffixes, field names)
   → If D365FO detected → SKIP code_search/file_search → USE MCP tools below!

1. Identify what they're looking for:
   - Class → search(query=X, type="class")
   - Table → search(query=X, type="table")
   - Form → search(query=X, type="form")
   - Query → search(query=X, type="query")
   - View → search(query=X, type="view")
   - Method → search(query=X, type="method")
   - Field → search(query=X, type="field")
   - Enum → search(query=X, type="enum")
   - Multiple things → batch_search(queries=[...])

2. If looking for custom code only:
   → search_extensions(query=X)

3. If user says "my" / "custom" / "in my project":
   → add includeWorkspace=true, workspacePath=...

4. ❌ NEVER use code_search, file_search, or grep_search
```

## Scenario 2: User Asks to Create a D365FO Object

**Triggers:** "create", "generate", "make", "add new", "build", "vytvoř", "vygeneruj"

```
🛑 STOP: Is this D365FO object (class/table/form/enum)?
   → YES → MANDATORY: ALWAYS use create_d365fo_file FIRST
   → NO → Safe to use create_file

🔥 ABSOLUTE RULE - NO EXCEPTIONS:

ALWAYS call create_d365fo_file(objectType, objectName, modelName, addToProject=true) FIRST.

❌ NEVER use generate_d365fo_xml as first choice
❌ NEVER use create_file for D365FO objects
❌ NEVER skip create_d365fo_file

IF create_d365fo_file returns error "requires file system access":
   THEN and ONLY THEN use generate_d365fo_xml + create_file
   
OTHERWISE: ALWAYS use create_d365fo_file

---

STEP-BY-STEP WORKFLOW (FOLLOW EXACTLY):

1. Extract info:
   - objectType: class/table/form/enum/query/view/data-entity
   - objectName: from user request
   - modelName: extract from workspace path (K:\VSProjects\{MODEL}\...)
     → NEVER ask user for model name!

2. ALWAYS call create_d365fo_file FIRST:
   
   create_d365fo_file(
     objectType: "class",
     objectName: "MyHelper",
     modelName: "CustomCore",
     addToProject: true,
     sourceCode: "..."
   )
   
3. IF and ONLY IF step 2 fails with "requires file system access":
   
   a) generate_d365fo_xml(objectType, objectName, modelName, sourceCode)
   b) Extract XML from response (between ```xml markers)
   c) create_file(path="K:\\AosService\\...\\MyHelper.xml", content=XML)
   d) Tell user to add <Content Include="..."/> to .rnrproj

4. ❌ NEVER skip step 2 - ALWAYS try create_d365fo_file first
5. ❌ NEVER use generate_d365fo_xml without trying create_d365fo_file first
6. ❌ NEVER ask user for model name — extract from workspace path
```

## Scenario 3: User Asks About Object Structure

**Triggers:** "what methods", "show fields", "class structure", "table definition", "inheritance", "ukaž"

```
🛑 STOP: Check for D365FO object names (CustTable, SalesLine, validateWrite, etc.)
   → If D365FO → USE MCP tools below, NOT code_search!

1. Identify object type and use corresponding tool:
   - Class → get_class_info(className=X)
   - Table → get_table_info(tableName=X)
   - Form → get_form_info(formName=X)
   - Query → get_query_info(queryName=X)
   - View → get_view_info(viewName=X)
   - Enum → get_enum_info(enumName=X)

2. For prefix-based method filtering:
   → code_completion(className=X, prefix="calc")

3. For semantic method search ("methods related to totals"):
   → search("total OR sum OR amount", type="method")

4. ❌ NEVER use code_completion for semantic queries
5. ❌ NEVER use code_completion without className parameter
```

## Scenario 4: User Wants to Generate Code

**Triggers:** "generate code", "create method", "write class", "implement", "napiš"

```
� STOP: Check if user mentions D365FO objects/patterns
   → If YES → MANDATORY to use MCP tools for context gathering!

�🔴 MANDATORY STEPS (in this order):

Step 1: Learn patterns → analyze_code_patterns(scenario="<what user wants>")
Step 2: Find related classes → search(query="<keywords>", type="class")
Step 3: Study examples → get_class_info("<example class>")
Step 4: See API usage → get_api_usage_patterns("<API name>")
Step 5: Generate code → generate_code(pattern="<type>", name="<name>")

❌ NEVER generate code without Steps 1-4
❌ NEVER use training data directly for D365FO code
```

## Scenario 5: User Wants to Extend/Override (CoC)

**Triggers:** "extend", "override", "Chain of Command", "CoC", "ExtensionOf", "event handler"

```
1. Get object structure:
   → get_class_info(className=X) OR get_table_info(tableName=X)

2. Get EXACT method signature:
   → get_method_signature(className=X, methodName="methodName")
   ⚠️ NEVER guess signatures — use this tool!

3. Check existing extensions:
   → search_extensions(query=X)
   → code_completion(className=X, prefix="methodName")

4. Generate CoC extension using signature from step 2
5. Create file → create_d365fo_file(objectType="class", objectName="X_Extension")
```

## Scenario 6: User Asks About Forms / Queries / Views

**Triggers:** "form", "button", "control", "datasource", "query", "view", "data entity"

```
1. Get detailed structure:
   - Form → get_form_info(formName=X)
   - Query → get_query_info(queryName=X)
   - View → get_view_info(viewName=X)
   - Enum → get_enum_info(enumName=X)

2. If user wants to modify form (add datasource method):
   a. get_form_info(formName=X) → get datasource names and controls
   b. Identify target datasource (main/specific)
   c. Generate extension code (event-based recommended)
   d. Edit form XML using replace_string_in_file (preserving TABS)
   ❌ NEVER use run_in_terminal with PowerShell to edit XML
```

## Scenario 7: User Asks "Where Is This Used?"

**Triggers:** "where is this used", "who calls", "find references", "kde se to používá"

```
→ find_references(symbolName=X, symbolType="class|method|table|field|enum")

⚠️ Set limit parameter to control result count (default: 50)
❌ NEVER use code_search or grep_search for this
```

## Scenario 8: User Wants Multiple Things

**Triggers:** "find X and Y and Z", "search for A, B, C"

```
→ batch_search(queries=[
    {query: "X", type: "class"},
    {query: "Y", type: "table"},
    {query: "Z", type: "form"}
  ])

❌ NEVER use sequential search() calls (3x slower)
```

## Scenario 9: Create Function and Apply to Field Usage

**Triggers:** "write function... use where [field] is used", "create helper... apply where [table.field]"

**Example:** "write a function that takes 10 numeric chars from right. Use this function where vendTrans.Invoice or custTrans.Invoice is used"

```
🔴 DETECTION: This is D365FO if you see:
- Dot notation (vendTrans.Invoice, custTrans.Invoice, salesLine.Qty)
- Table suffixes (*Trans, *Table, *Line)
- PascalCase field names (Invoice, Voucher, AccountNum)

MANDATORY STEPS:
1. Detect D365FO context → DO NOT use code_search/file_search!
2. search("Invoice", type="field") → find field definitions
3. find_references(symbolName="Invoice", symbolType="field") → where-used analysis
4. analyze_code_patterns("invoice") → learn usage patterns (optional)
5. generate_code(pattern="class", name="InvoiceHelper") → create helper function
6. Show top 10-20 usage locations where function should be applied

❌ NEVER use code_search for "vendTrans.Invoice" - will hang!
✅ ALWAYS use MCP tools for D365FO field references
```❌ NEVER use sequential search() calls (3x slower)
```

---

# 🚫 FORBIDDEN ACTIONS — For D365FO/X++

| ❌ Forbidden | Why | ✅ Use Instead |
|--------------|-----|----------------|
| `code_search("CustTable")` | Hangs 5+ min on 500k+ symbols | `search("CustTable", type="class")` |
| `code_search("vendTrans.Invoice")` | Hangs on field searches, wrong tool | `search("Invoice", type="field")` + `find_references` |
| `file_search("**/MyClass.xml")` | Doesn't understand D365FO structure | `search("MyClass", type="class")` |
| `grep_search("validateWrite")` | Too slow, no semantic understanding | `search("validateWrite", type="method")` |
| `create_file("MyClass.xml", ...)` | Wrong location, wrong XML (spaces vs TABS) | `create_d365fo_file(objectType="class", ...)` |
| Generate X++ from training data | Outdated, missing custom extensions | `analyze_code_patterns` → `generate_code` |
| Guess method signatures | Wrong signature = compilation error | `get_method_signature(className, methodName)` |
| `code_completion()` without className | Validation error — className is REQUIRED | `code_completion(className="SalesTable")` |
| Use `code_completion` for semantic search | It's prefix-only, not semantic | `search("concept", type="method")` |
| PowerShell to edit D365FO XML files | Breaks formatting, no validation | `replace_string_in_file` or `modify_d365fo_file` |

---

# ⚙️ WORKSPACE-AWARE FEATURES (VS 2022 Specifics)

## When to Use `includeWorkspace` Parameter

Tools supporting workspace-aware search:
- `search`, `get_class_info`, `get_form_info`, `get_query_info`, `get_view_info`, `get_enum_info`, `get_method_signature`, `code_completion`

**Use when:**
- User says "my", "our", "custom", "in my project"
- Looking for recently created classes not yet in external metadata
- Need to prioritize user's code over Microsoft standard code

**Result:**
- 🔹 WORKSPACE files shown FIRST (user's code priority)
- 📦 EXTERNAL metadata shown second (Microsoft standard)

## VS 2022 Workspace Path Limitation

**Problem:** VS 2022 GitHub Copilot extension does NOT automatically send the workspace path to MCP server.

**Solution:** The user should specify the workspace path in their query, or set it at the beginning of a session:

```
"My workspace path is C:\AOSService\PackagesLocalDirectory\MyModel. Remember this for all queries."
```

Then for subsequent queries:
```
"Search for MyClass including workspace"
```

---

# 📁 D365FO FILE STRUCTURE RULES

## AOT Package Structure (Correct Paths)

All D365FO files MUST be placed in PackagesLocalDirectory:

| Object Type | Path Template |
|-------------|---------------|
| Class | `K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxClass\{Name}.xml` |
| Table | `K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxTable\{Name}.xml` |
| Form | `K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxForm\{Name}.xml` |
| Enum | `K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxEnum\{Name}.xml` |
| Query | `K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxQuery\{Name}.xml` |
| View | `K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxView\{Name}.xml` |

## Model Name Extraction

- Extract from workspace path: `K:\VSProjects\{MODEL}\...` → use `{MODEL}`
- **NEVER ask the user** for model name — extract it from context
- **NEVER ask the user** for package path — use default `K:\AosService\PackagesLocalDirectory`
- This path exists on ALL D365FO environments (VHD, cloud, on-premise)

## XML Formatting Rules

- ✅ Always use **TABS** for indentation (Microsoft D365FO standard)
- ❌ NEVER use spaces — causes XML deserialization errors in VS
- ✅ Use `CDATA` sections for X++ source code: `<![CDATA[ ... ]]>`
- ✅ Use proper XML namespaces: `xmlns:i="http://www.w3.org/2001/XMLSchema-instance"`

## File Editing Workflow

**When modifying existing D365FO XML files:**

| Environment | Approach |
|-------------|----------|
| MCP server local (Windows) | `modify_d365fo_file` — atomic operations with backup |
| MCP server in Azure/cloud | `replace_string_in_file` / `multi_replace_string_in_file` — client-side editing |

**For both environments:**
- ✅ Read the XML file first to understand its structure
- ✅ Preserve TAB indentation when editing
- ✅ Use `replace_string_in_file` with enough context (3+ lines before/after)
- ❌ NEVER use `run_in_terminal` with PowerShell to parse/edit XML
- ❌ NEVER use `read_file` to read D365FO class/table metadata — use `get_class_info`/`get_table_info` instead

---

# 📝 X++ CODE GENERATION RULES

## Mandatory Pre-Generation Checklist

Before writing ANY X++ code, you MUST:

1. ✅ Use at least ONE MCP tool to gather context (no exceptions)
2. ✅ Use `analyze_code_patterns` to learn codebase patterns
3. ✅ Verify object names with `search` — never guess
4. ✅ Verify method signatures with `get_method_signature` or `get_class_info`
5. ✅ Use `generate_code` for templates — never write from scratch

## X++ Best Practices to Follow

- Prefer set-based operations (`update_recordset`, `insert_recordset`) over record-by-record
- Use proper transaction handling (`ttsbegin`/`ttscommit`/`ttsabort`)
- Follow Chain of Command for extensions — never suggest overlayering
- Use `firstonly` when only one record needed
- Specify field lists instead of `select *`
- Use `exists join` / `notexists join` for filtering
- Check indexes before writing queries (from `get_table_info`)

## When You May Use General Knowledge (Without MCP Tools)

- X++ language syntax (`if`, `while`, `switch`, `for`, `select` statements)
- Standard framework patterns (`RunBase`, `SysOperation`, `FormRun`)
- General coding standards and best practices
- Architecture explanations
- Visual Studio 2022 IDE usage

---

# 🔄 COMPLETE WORKFLOW EXAMPLES

## Example 1: Create Helper Class for Dimensions

```
User: "Create a helper class for managing financial dimensions"

Copilot Workflow:
1. analyze_code_patterns("financial dimensions")
2. search("dimension", type="class", limit=10)
3. get_class_info("DimensionDefaultingService")
4. get_api_usage_patterns("DimensionAttributeValueSet")
5. generate_code(pattern="class", name="MyDimensionHelper")
6. analyze_class_completeness("MyDimensionHelper")
7. create_d365fo_file(objectType="class", objectName="MyDimensionHelper",
     modelName="ContosoExtensions", addToProject=true)
```

## Example 2: Extend CustTable.validateWrite

```
User: "Add validation to CustTable.validateWrite to check credit limit"

Copilot Workflow:
1. get_method_signature(className="CustTable", methodName="validateWrite")
2. code_completion(className="CustTable", prefix="credit")
3. suggest_method_implementation("CustTable", "validateWrite")
4. Generate CoC extension with EXACT signature from step 1
5. create_d365fo_file(objectType="class", objectName="CustTable_Extension", ...)
```

## Example 3: Analyze and Modify Form

```
User: "Enable AddFormEntityPair button only if record exists in DataEntityGroup datasource"

Copilot Workflow:
1. search("AddFormEntityPair", type="form", includeWorkspace=true)
2. get_form_info("MyForm") → identify datasources and controls
3. Generate event-based extension or datasource active() override
4. Edit form XML with replace_string_in_file (preserving TABS)
```

## Example 4: Where-Used Analysis

```
User: "Where is DimensionAttributeValueSet used?"

Copilot Workflow:
1. find_references(symbolName="DimensionAttributeValueSet", symbolType="class", limit=50)
2. Present results grouped by reference type (calls, extends, instantiations)
```

## Example 5: Pattern-Based Detection (Czech/English)

```
User: "write a function that takes 10 numeric characters from the right FA2026#1234567890 -> 1234567890.
         Use this function where vendTrans.Invoice or custTrans.Invoice is used"

DETECTION TRIGGERS:
✅ "vendTrans.Invoice" → Dot notation with PascalCase field (Invoice)
✅ "custTrans.Invoice" → Dot notation with PascalCase field (Invoice)
✅ "*Trans" → Table suffix pattern
✅ "Invoice" → Common D365FO field name

Copilot Workflow:
1. analyze_code_patterns("invoice") → learn Invoice field usage patterns
2. search("Invoice", type="field") → find Invoice field in all tables
3. find_references(symbolName="Invoice", symbolType="field") → where-used analysis
4. generate_code(pattern="class", name="InvoiceHelper") → create helper with extractDigits()
5. Show top implementation locations with code examples
```

---

# 🎯 SUMMARY: Golden Rules

```
╔═══════════════════════════════════════════════════════════════════════════╗
║                                                                           ║
║  🏆 THE ONE RULE TO RULE THEM ALL 🏆                                     ║
║                                                                           ║
║  IF query contains:                                                       ║
║    • something.SomethingElse (dot notation + PascalCase)                 ║
║    • *Trans, *Table, *Line, *Header, *Journal                            ║
║    • Invoice, Voucher, AccountNum, ItemId, Qty, RecId                    ║
║    • X++, D365FO, AxClass, AxTable, validateWrite                        ║
║                                                                           ║
║  THEN:                                                                    ║
║    ✅ USE MCP tools (search, find_references, get_*_info)                ║
║    ❌ DO NOT use code_search, file_search, grep_search                   ║
║                                                                           ║
║  NO EXCEPTIONS. NO EXCUSES. 100% COMPLIANCE REQUIRED.                    ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

## Detailed Rules

1. **ALWAYS use MCP tools for D365FO** — no exceptions
2. **NEVER use code_search / file_search / grep_search** — will hang or give wrong results
3. **NEVER use create_file for D365FO objects** — use `create_d365fo_file` or `generate_d365fo_xml`
4. **ALWAYS learn patterns before generating** — use `analyze_code_patterns`
5. **ALWAYS verify signatures** — use `get_method_signature`, never guess
6. **ALWAYS take action, not describe** — call tools immediately, don't explain what you "could" do
7. **ALWAYS extract model name from workspace path** — never ask the user
8. **Use batch_search for multiple queries** — 3x faster than sequential
9. **Use `search` for semantic queries** — use `code_completion` only for prefix filtering
10. **Preserve TABS in D365FO XML** — spaces cause compilation errors

---

# 📚 Quick Reference Card

```
DISCOVERY:     search, batch_search, search_extensions
STRUCTURE:     get_class_info, get_table_info, get_form_info,
               get_query_info, get_view_info, get_enum_info
SIGNATURES:    get_method_signature, code_completion
REFERENCES:    find_references
PATTERNS:      analyze_code_patterns, suggest_method_implementation,
               analyze_class_completeness, get_api_usage_patterns
GENERATION:    generate_code
FILE OPS:      create_d365fo_file, generate_d365fo_xml, modify_d365fo_file

FORBIDDEN:     code_search, file_search, grep_search, create_file (for D365FO objects)
```

**MCP tools = Fast (<100ms), Accurate (real-time metadata), 584,799+ symbols**
**Built-in tools = Slow (5+ min hangs), Outdated, Errors**

**When user asks about D365FO → STOP → USE MCP TOOLS!** 🚀

---

# ⚠️ FINAL REMINDER — READ BEFORE EVERY RESPONSE

```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  Before using ANY tool, ask yourself:                          │
│                                                                │
│  1. Does the query mention D365FO patterns?                    │
│     (dot notation, *Trans, *Table, Invoice, validateWrite)     │
│                                                                │
│  2. If YES → Use MCP tools ONLY                                │
│     If NO  → Built-in tools are OK                             │
│                                                                │
│  3. When in doubt? → USE MCP TOOLS (they're fast & safe)       │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Remember:** `vendTrans.Invoice` = D365FO = MCP tools = search + find_references

**END OF INSTRUCTIONS**