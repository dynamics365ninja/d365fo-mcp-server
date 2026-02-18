# D365FO X++ Development — GitHub Copilot Instructions
> **IDE:** Visual Studio 2022 17.14+ | **MCP Server:** d365fo-mcp-server v2.0 | **Tools:** 20 MCP tools | **Auto-detection:** .rnrproj workspace scan

---

## ⚡ GOLDEN RULE — READ BEFORE EVERY RESPONSE

```
Is the query about code development in a D365FO workspace?
         │
         ▼
    ALWAYS use MCP tools.
    NEVER use: semantic_search, code_search, file_search, grep_search,
               read_file (on D365FO XML), create_file for D365FO objects.
```

**This applies even when the query contains no explicit D365FO keyword.**
Any request to generate / search / analyze code in a D365FO project = MCP tools.

### 🚀 WHY MCP TOOLS ARE MANDATORY — NOT OPTIONAL

| Dimension | VS Built-in / semantic_search | MCP Tools |
|-----------|-------------------------------|-----------|
| **Speed** | 5–30 min scan of 500 k+ XML files | <50 ms pre-built SQLite index |
| **Coverage** | Only files in current workspace | Full D365FO platform + all custom models |
| **X++ semantics** | None — raw text/file search | Typed: class / table / method / field / enum |
| **Code quality** | Generates code from training data (may be outdated) | Generates code from REAL patterns in current codebase |
| **Method signatures** | Guessed (causes compilation errors) | Exact modifiers + parameters extracted from XML |
| **Impact analysis** | `grep_search` — misses cross-XML references | `find_references` — traces all callers across models |
| **Create files** | Wrong path, wrong encoding, spaces instead of TABs | Correct AOT path, UTF-8 BOM, TAB indentation, adds to .rnrproj |

**The MCP server holds a pre-indexed SQLite database of 500 000+ D365FO symbols.**
No built-in VS Code tool can match its speed or semantic depth for X++ development.

---

## 🔍 D365FO CONTEXT DETECTION

### English patterns (direct detection)
| Pattern | Example | Action |
|---------|---------|--------|
| Dot notation with PascalCase | `vendTrans.Invoice`, `custTable.AccountNum` | → MCP tools |
| Table suffix | `*Trans`, `*Table`, `*Line`, `*Header`, `*Journal` | → MCP tools |
| Field names | `Invoice`, `Voucher`, `AccountNum`, `ItemId`, `RecId` | → MCP tools |
| Keywords | `X++`, `D365FO`, `AxClass`, `AxTable`, `validateWrite` | → MCP tools |

### ⚠️ Non-English terms — same rules, different language
If the user writes in any language other than English, map domain terms to D365FO equivalents:

| Term (any language) | D365FO equivalent | Action |
|---------------------|-------------------|--------|
| journal / ledger journal / deník / žurnál | Journal (`LedgerJournal`, `InventJournal`) | → MCP tools |
| header / heading / hlavička / záhlaví | Header / Table | → MCP tools |
| line / item / row / řádek / položka / riadok | Line (`SalesLine`, `PurchLine`) | → MCP tools |
| transaction / transakce / transakcia | Trans (`LedgerTrans`, `InventTrans`) | → MCP tools |
| voucher / document / doklad / účetní doklad | Voucher | → MCP tools |
| account / posting / ledger / účet / účtování / zaúčtování | Account / Ledger | → MCP tools |
| customer / zákazník / odběratel / odberateľ | Customer / `CustTable` | → MCP tools |
| vendor / supplier / dodavatel / dodávateľ | Vendor / `VendTable` | → MCP tools |
| inventory / stock / sklad / pohyb skladu | Inventory / `InventTrans` | → MCP tools |
| batch job / dávková úloha / dávkové zpracování | Batch job | → MCP tools |
| extension / override / rozšíření / rozšírenie | Extension / CoC | → MCP tools |
| form / dialog / formulář / formulár | Form / `AxForm` | → MCP tools |
| purchase order / nákupní objednávka / NO | PurchTable / PurchLine | → MCP tools |
| sales order / prodejní objednávka / PO | SalesTable / SalesLine | → MCP tools |
| fixed asset / dlouhodobý majetek / DM | AssetTable / AssetTrans | → MCP tools |
| dimension / finanční dimenze | LedgerDimension / DimensionAttributeValue | → MCP tools |
| number sequence / číselná řada | NumberSeq / NumberSequenceTable | → MCP tools |
| workflow / schvalovací tok | Workflow | → MCP tools |
| data entity / datová entita | Data entity (`*Entity`) | → MCP tools |

### DEFAULT rule for coding requests
If the user asks to **create, write, or generate code/methods/classes** in a D365FO workspace
→ **ALWAYS use MCP tools**, even without detecting any explicit pattern above.

---

## 🛠️ TOOL REFERENCE — EXACT PARAMETERS FROM SOURCE

> ⚠️ Only parameters listed here actually exist. Do NOT invent or add parameters not shown below.

### Discovery

```
search(query, type?, limit?)
  query:  string  [REQUIRED]
  type:   "class" | "table" | "field" | "method" | "enum" | "all"  [default: "all"]
  limit:  number  [default: 20]

  WHEN TO USE:
  → Primary tool for finding ANY D365FO object by name or keyword (<50ms)
  → Use for semantic queries: "classes related to posting", "validation methods"
  → Use type filter to narrow results: type="table" for tables, type="method" for methods
  → Prefer over batch_search when searching for a single thing
  ⚠️ type="form", type="query", type="view" do NOT exist — use get_form_info/get_query_info/get_view_info instead

batch_search(queries[])
  queries: array (1–10 items) of:
    query:            string   [REQUIRED]
    type:             "class" | "table" | "field" | "method" | "enum" | "all"  [default: "all"]
    limit:            number   [default: 10]
    workspacePath:    string   [optional]
    includeWorkspace: boolean  [default: false]

  WHEN TO USE:
  → User asks about 2+ unrelated objects simultaneously — 3× faster than sequential search()
  → Exploring a domain from multiple angles at once (table + class + method)
  → Never use sequential search() when batch_search() can do it in one call

search_extensions(query, prefix?, limit?)
  query:  string  [REQUIRED]
  prefix: string  [optional — e.g. "ISV_", "Custom_"]
  limit:  number  [default: 20]

  WHEN TO USE:
  → User says "my code", "our extension", "custom", "ISV" — searches ONLY non-Microsoft objects
  → Finding ISV-specific classes without noise from 500k+ standard symbols
  → Use prefix to filter by naming convention (e.g. prefix="ACME_")
```

### Object structure

```
get_class_info(className)
  className: string  [REQUIRED]

  WHEN TO USE:
  → Need full class details: all methods with signatures, inheritance chain, source code
  → Before generating CoC extension — understand what the class contains
  → Before suggest_method_implementation — understand existing method patterns
  → Returns: method list with visibility/return type/parameters, extends/implements chain

get_table_info(tableName)
  tableName: string  [REQUIRED]

  WHEN TO USE:
  → Need full table schema: field types, EDT, mandatory flags, indexes, relations
  → Before writing select statements — verify field names and types
  → Before creating table extension — understand existing structure
  → Returns: all fields with types, unique/clustered indexes, foreign key relations

get_form_info(formName, includeWorkspace?, workspacePath?)
  formName:         string   [REQUIRED]
  includeWorkspace: boolean  [default: false]
  workspacePath:    string   [optional]

  WHEN TO USE:
  → Working with form customization, buttons, datasources, controls
  → Before adding datasource method or enabling/disabling controls
  → Returns: datasource list, control hierarchy (buttons/grids/tabs), form methods

get_query_info(queryName, includeWorkspace?, workspacePath?)
  queryName:        string   [REQUIRED]
  includeWorkspace: boolean  [default: false]
  workspacePath:    string   [optional]

  WHEN TO USE:
  → Need to understand or extend an existing AOT query
  → Returns: datasource joins, range definitions, field selections

get_view_info(viewName, includeWorkspace?, workspacePath?)
  viewName:         string   [REQUIRED]
  includeWorkspace: boolean  [default: false]
  workspacePath:    string   [optional]

  WHEN TO USE:
  → Working with views or data entities
  → Returns: mapped fields, computed columns, relations, view methods

get_enum_info(enumName)
  enumName: string  [REQUIRED]

  WHEN TO USE:
  → Need enum values before writing switch/if statements or comparisons
  → Returns: all enum values with integer values and labels

get_method_signature(className, methodName)
  className:  string  [REQUIRED]
  methodName: string  [REQUIRED]

  WHEN TO USE:
  → MANDATORY before creating any CoC extension — never guess the signature
  → Wrong signature = compilation error, always use this tool
  → Returns: exact modifiers, return type, parameters with types and defaults, ready-to-use CoC template

code_completion(className, prefix?, includeWorkspace?, workspacePath?)
  className:        string   [REQUIRED — validation error without it!]
  prefix:           string   [default: ""]
  includeWorkspace: boolean  [default: false]
  workspacePath:    string   [optional]

  WHEN TO USE:
  → Need methods/fields starting with a specific prefix: code_completion(className="CustTable", prefix="find")
  → IntelliSense-style filtering by name prefix only
  ⚠️ NOT for semantic search ("methods that calculate totals") — use search() for that
  ⚠️ className is REQUIRED — omitting it causes a validation error
```

### Code analysis and generation

```
analyze_code_patterns(scenario, classPattern?, limit?)
  scenario:     string  [REQUIRED — describe the domain, e.g. "ledger journal creation"]
  classPattern: string  [optional — filter by class name pattern, e.g. "Helper", "Service"]
  limit:        number  [default: 5]

  WHEN TO USE:
  → MANDATORY first step before generating ANY X++ code
  → Discovers real patterns from the actual codebase — prevents outdated/wrong code
  → Returns: detected patterns with frequency, common methods, common dependencies
  → Example: analyze_code_patterns("sales order posting") before writing posting logic

suggest_method_implementation(className, methodName, parameters?)
  className:  string  [REQUIRED]
  methodName: string  [REQUIRED]
  parameters: string  [optional — plain string describing params, NOT an array]

  WHEN TO USE:
  → Need concrete implementation examples for a specific method
  → After get_class_info — pick a method and get real examples from codebase
  → Returns: similar method implementations with complexity analysis

analyze_class_completeness(className)
  className: string  [REQUIRED]

  WHEN TO USE:
  → After creating a new class — check what standard methods are typically expected
  → Returns: missing methods ranked by frequency (🔴 Very common → 🟡 Somewhat common)

get_api_usage_patterns(apiName, context?)
  apiName: string  [REQUIRED — NOT className!]
  context: string  [optional — e.g. "initialization", "posting", "validation"]

  WHEN TO USE:
  → Need to know HOW a specific API class is typically used in practice
  → Returns: initialization patterns, typical method call sequences, real code examples
  ⚠️ Parameter is apiName, NOT className — using className causes a validation error

generate_code(pattern, name)
  pattern: "class" | "runnable" | "form-handler" | "data-entity" | "batch-job" | "table-extension"  [REQUIRED]
  name:    string  [REQUIRED]

  WHEN TO USE:
  → Generating boilerplate X++ structure after analyze_code_patterns has been called
  → pattern="class"           — standard X++ class (base for CoC extensions too)
  → pattern="runnable"        — class with main() for direct execution / one-off scripts
  → pattern="form-handler"    — [ExtensionOf(formStr(...))] with init() / close() / datasource events
  → pattern="data-entity"     — data entity class with find() / exist() / validateWrite()
  → pattern="batch-job"       — SysOperationServiceController + Service class with process()
  → pattern="table-extension" — [ExtensionOf(tableStr(...))] with validateWrite() / modifiedField()
  ⚠️ Only these 6 patterns exist — "coc-extension", "event-handler", "service-class" do NOT exist
  ⚠️ Always call analyze_code_patterns first — never generate code without real codebase context
```

### File operations and references

```
find_references(targetName, targetType?, limit?)
  targetName: string  [REQUIRED — NOT symbolName!]
  targetType: "class" | "method" | "field" | "table" | "enum" | "all"  [NOT symbolType!]
  limit:      number  [default: 50]

  WHEN TO USE:
  → Impact analysis before modifying anything — "who uses this class/method/field?"
  → Finding all places where a field is accessed (e.g. targetName="Invoice", targetType="field")
  → Returns: file paths, line numbers, code context, reference type (call/extends/implements/field-access)
  ⚠️ Parameters are targetName and targetType — NOT symbolName/symbolType (causes validation error)

create_d365fo_file(objectType, objectName, modelName, packagePath?,
                   sourceCode?, properties?, addToProject?, projectPath?, solutionPath?)
  objectType:   "class" | "table" | "enum" | "form" | "query" | "view" | "data-entity"  [REQUIRED]
  objectName:   string   [REQUIRED]
  modelName:    string   [REQUIRED — but will be auto-corrected from .rnrproj if projectPath/solutionPath provided]
  packagePath:  string   [default: "K:\AosService\PackagesLocalDirectory"]
  sourceCode:   string   [optional — X++ source to embed in the file]
  properties:   object   [optional — extends, implements, label, etc.]
  addToProject: boolean  [default: false — set true to auto-add to .rnrproj]
  projectPath:  string   [⚠️ CRITICAL — path to .rnrproj file]
  solutionPath: string   [⚠️ CRITICAL — path to VS solution directory]

  WHEN TO USE:
  → 🔥 ALWAYS use this FIRST when creating any D365FO object (class/table/form/enum/query/view)
  → Runs on local Windows D365FO VM with K:\ drive access
  → Creates file at correct AOT path with UTF-8 BOM and TAB indentation
  → Automatically adds to Visual Studio project when addToProject=true
  → IMPORTANT: If projectPath or solutionPath is provided, the tool will automatically extract
    the correct ModelName from the .rnrproj file, ensuring the file is created in the correct
    PackagesLocalDirectory location (not in the project/solution folder)
  ⚠️ CRITICAL: ALWAYS provide projectPath or solutionPath to avoid creating files in WRONG MODEL!
  ⚠️ WITHOUT projectPath/solutionPath: Tool uses modelName AS-IS → May create in Microsoft model!
  ⚠️ If it returns "requires file system access" → fall back to generate_d365fo_xml

generate_d365fo_xml(objectType, objectName, modelName, sourceCode?, properties?)
  objectType: "class" | "table" | "enum" | "form" | "query" | "view" | "data-entity"  [REQUIRED]
  objectName: string  [REQUIRED]
  modelName:  string  [REQUIRED]
  sourceCode: string  [optional]
  properties: object  [optional]

  WHEN TO USE:
  → ⚠️ FALLBACK ONLY — use ONLY when create_d365fo_file returns "requires file system access"
  → Typical scenario: MCP server deployed on Azure/Linux without access to K:\ drive
  → Returns XML as text — must be manually saved via create_file with UTF-8 BOM
  ⚠️ Never use as first choice — always try create_d365fo_file first

modify_d365fo_file(objectType, objectName, operation, ...)
  objectType:       "class" | "table" | "form" | "enum" | "query" | "view"  [REQUIRED]
  objectName:       string  [REQUIRED]
  operation:        "add-method" | "add-field" | "modify-property" | "remove-method" | "remove-field"  [REQUIRED]
  methodName:       string   [for add-method, remove-method]
  methodCode:       string   [for add-method — full X++ method body]
  methodModifiers:  string   [for add-method — e.g. "public static"]
  methodReturnType: string   [for add-method — e.g. "void", "str", "boolean"]
  methodParameters: string   [for add-method — e.g. "str _param1, int _param2"]
  fieldName:        string   [for add-field, remove-field]
  fieldType:        string   [for add-field — EDT or base type]
  fieldMandatory:   boolean  [for add-field]
  fieldLabel:       string   [for add-field]
  propertyPath:     string   [for modify-property — e.g. "Table1.Visible"]
  propertyValue:    string   [for modify-property]
  createBackup:     boolean  [default: true — always keep backup]
  modelName:        string   [optional — auto-detected from file system]
  workspacePath:    string   [optional]

  WHEN TO USE:
  → Modifying an EXISTING D365FO object — adding method, adding field, changing property
  → Safer than manual XML editing — validates XML after change and creates .bak backup
  → Use instead of PowerShell or manual file editing
  ⚠️ Works ONLY on local Windows with K:\ drive access — not available on Azure/Linux
  ⚠️ For Azure/cloud: use replace_string_in_file instead (preserving TAB indentation)
```

---

## 📋 WORKFLOW FOR COMMON SCENARIOS

### Scenario A: Finding an object
**Trigger:** "find", "search", "show me", "where is", "locate"

```
1. search(query=X, type="class|table|method|field|enum")
   or batch_search() for multiple things at once
2. For custom code only: search_extensions(query=X)
3. ❌ NEVER: code_search, file_search, grep_search
```

### Scenario B: Generating code
**Trigger:** "create", "write", "generate", "implement", "build"

```
1. analyze_code_patterns(scenario="<keywords from query>")
2. search(query="<relevant class/table>", type="class|table")
3. get_class_info() or get_table_info() to study structure
4. get_api_usage_patterns(apiName="<main API>")
5. generate_code(pattern="<type>", name="<n>")
6. create_d365fo_file(...) to save
```

### Scenario C: Creating a D365FO object (class, table, form...)
**Trigger:** "create class", "new table", "create form/enum/query"

```
1. ⚠️ IMPORTANT: GitHub Copilot automatically detects active workspace path
   → projectPath and solutionPath are usually auto-detected from workspace
   → You typically DON'T need to specify them explicitly
   → Only specify if you need to override auto-detection
   
2. create_d365fo_file(
     objectType: "class|table|form|enum|query|view|data-entity",
     objectName: "<n>",
     modelName: "<any value — will be auto-corrected from .rnrproj>",
     addToProject: true,
     sourceCode: "<X++ code>"
   )
   
   The tool will:
   ✅ Use projectPath from GitHub Copilot workspace (auto-detected)
   ✅ OR use projectPath/solutionPath from .mcp.json config (if workspace detection fails)
   ✅ Extract correct ModelName from .rnrproj file
   ✅ Create file in correct custom model (not Microsoft model)
   
3. ONLY if step 2 returns "requires file system access":
   → generate_d365fo_xml() → then create_file() with resulting XML
```

### Scenario D: Object structure
**Trigger:** "what methods does X have", "show fields", "class structure", "table definition"

```
Class   → get_class_info(className)
Table   → get_table_info(tableName)
Form    → get_form_info(formName)
Query   → get_query_info(queryName)
View    → get_view_info(viewName)
Enum    → get_enum_info(enumName)
```

### Scenario E: Chain of Command (CoC) extension
**Trigger:** "extend", "override", "Chain of Command", "CoC", "ExtensionOf", "event handler"

```
1. get_method_signature(className, methodName)  ← MANDATORY, never guess
2. get_class_info(className) for context
3. search_extensions(query=className) for existing extensions
4. generate_code(pattern="class", name="X_Extension") → use as CoC template
5. create_d365fo_file(objectType="class", objectName="X_Extension", ...)
```

### Scenario F: Where-used analysis
**Trigger:** "where is this used", "who calls", "find references"

```
find_references(targetName=X, targetType="class|method|field|table|enum")
❌ NEVER: code_search or grep_search
❌ NEVER: find_references(symbolName=...) — wrong parameter name!
```

### Scenario G: Form / Query / View modifications
**Trigger:** "add button", "enable control", "datasource method", "form extension"

```
1. get_form_info(formName) → understand structure, datasources, controls
2. Generate extension code (event-based preferred)
3. Edit XML: modify_d365fo_file (local Windows) or replace_string_in_file
   ❌ NEVER use PowerShell to edit XML
```

### Scenario H: Code Completion / IntelliSense
**Trigger:** "what methods does X have", "autocomplete", "available fields", writing X++ in chat

```
❌ NEVER rely on VS IntelliSense descriptions or guess method names

1. code_completion(className="CustTable")           — all methods and fields
2. code_completion(className="CustTable", prefix="find") — only members starting with "find"
3. search(query="find", type="method") after code_completion — for semantic search

When to use each:
  code_completion — you know the class, need exact member list (like pressing . in IDE)
  search          — you know the concept, need to find relevant classes/methods
```

### Scenario I: Reading existing D365FO object structure
**Trigger:** "show me the code", "how is X implemented", "what does class Y contain"

```
❌ NEVER use read_file on D365FO XML files — XML is verbose and hard to parse
❌ NEVER use semantic_search for D365FO objects

→ get_class_info(className)   — full source code + all method signatures
→ get_table_info(tableName)   — all fields, indexes, relations, methods
→ get_form_info(formName)     — datasources, controls, methods
→ get_enum_info(enumName)     — all enum values with integer values
```

---

## 🔧 EXAMPLES

### Example 1: Query without explicit D365FO keywords
```
User: "Create methods that will create a general ledger journal header
       and add one transaction line to it."

Detection:
✅ "general ledger journal" → LedgerJournal context
✅ "header"                 → LedgerJournalTable
✅ "transaction"            → LedgerJournalTrans
✅ Code generation in D365FO workspace → MCP tools REQUIRED

Workflow:
1. analyze_code_patterns("ledger journal creation")
2. batch_search(queries=[
     {query: "LedgerJournal",         type: "table"},
     {query: "LedgerJournalTrans",     type: "table"},
     {query: "LedgerJournalCheckPost", type: "class"}
   ])
3. get_table_info("LedgerJournalTable")
4. get_table_info("LedgerJournalTrans")
5. get_api_usage_patterns(apiName="LedgerJournalCheckPost")
6. generate_code(pattern="class", name="LedgerJournalHelper")
7. create_d365fo_file(objectType="class", objectName="LedgerJournalHelper",
     modelName="any", projectPath="<from context>", addToProject=true)
```

### Example 1b: ❌ WRONG - Creating file WITHOUT projectPath/solutionPath
```
User: "Create methods that will create a general ledger journal"

❌ WRONG Workflow:
1. analyze_code_patterns("ledger journal creation")
2. generate_code(pattern="class", name="LedgerJournalHelper")
3. create_d365fo_file(objectType="class", objectName="LedgerJournalHelper",
     modelName="ApplicationSuite")  ← ❌ NO projectPath/solutionPath!
     
Result: File created at K:\...\ApplicationSuite\ApplicationSuite\AxClass\...
        ❌ ApplicationSuite is Microsoft's model → WRONG!

✅ CORRECT Workflow:
1-6. Same as above
7. create_d365fo_file(objectType="class", objectName="LedgerJournalHelper",
     modelName="MyCustomModel",  ← doesn't matter, will be auto-corrected
     projectPath="K:\VSProjects\MySolution\MyProject\MyProject.rnrproj",
     addToProject=true)
     
Result: Tool reads MyProject.rnrproj → extracts actual ModelName (e.g., "AslCore")
        → File created at K:\...\AslCore\AslCore\AxClass\LedgerJournalHelper.xml ✅
```

### Example 2: Dot notation (direct detection)
```
User: "Where is vendTrans.Invoice used?"

Detection: ✅ vendTrans.Invoice = dot notation + PascalCase = D365FO!

Workflow:
find_references(targetName="Invoice", targetType="field")
❌ NEVER: code_search("vendTrans.Invoice") → 5+ minute hang!
❌ NEVER: find_references(symbolName="Invoice") → wrong parameter!
```

### Example 3: CoC extension
```
User: "Add validation to CustTable.validateWrite to check credit limit."

Detection: ✅ CustTable, validateWrite = D365FO

Workflow:
1. get_method_signature("CustTable", "validateWrite")
2. suggest_method_implementation("CustTable", "validateWrite")
3. code_completion(className="CustTable", prefix="credit")
4. generate_code(pattern="class", name="CustTable_Extension_CreditLimit")
5. create_d365fo_file(objectType="class", objectName="CustTable_Extension_CreditLimit", ...)
```

### Example 4: Parallel search for multiple objects
```
User: "Show me the structure of SalesTable and SalesLine and find helper classes for sales."

Workflow:
batch_search(queries=[
  {query: "SalesTable", type: "table"},
  {query: "SalesLine",  type: "table"},
  {query: "Sales",      type: "class", limit: 10}
])
❌ NOT three sequential search() calls — 3× slower
```

### Example 5: API usage patterns
```
User: "How is DimensionAttributeValueSet typically used?"

Workflow:
get_api_usage_patterns(apiName="DimensionAttributeValueSet")
❌ NEVER: get_api_usage_patterns(className="DimensionAttributeValueSet") → wrong parameter!
```

### Example 6: Code completion while writing X++
```
User: "I'm writing code that works with InventTrans. What find methods are available?"

Detection: ✅ InventTrans = D365FO table → MCP tools

Workflow:
1. code_completion(className="InventTrans", prefix="find")
   → Returns: findByVoucher, findByInventTransId, findSumQty, ...
2. get_table_info("InventTrans") if field names are also needed

❌ NEVER: semantic_search("InventTrans find methods") → misses most symbols
❌ NEVER: grep_search("InventTrans.find") → 5+ minute scan
```

### Example 7: Table extension
```
User: "Create a table extension for InventTable to add a custom field."

Detection: ✅ InventTable, table extension = D365FO

Workflow:
1. get_table_info("InventTable") → check existing fields, avoid name conflicts
2. generate_code(pattern="table-extension", name="InventTable")
3. create_d365fo_file(
     objectType="table", objectName="InventTable.Extension",
     modelName="auto", addToProject=true)
```

---

## 🚫 FORBIDDEN ACTIONS

| ❌ Forbidden | Reason | ✅ Use instead |
|-------------|--------|----------------|
| `semantic_search("CustTable methods")` | Searches workspace files — misses 99% of D365FO symbols | `search("CustTable", type="class")` |
| `code_search("CustTable")` | 5+ min hang on 500k+ XML files | `search("CustTable", type="table")` |
| `grep_search("validateWrite")` | Slow text scan, no semantic understanding | `search("validateWrite", type="method")` |
| `file_search("**/MyClass.xml")` | Doesn't understand D365FO structure | `search("MyClass", type="class")` |
| `read_file` on D365FO XML files | XML is 1000+ lines, hard to parse manually | `get_class_info()` / `get_table_info()` / etc. |
| `create_file("MyClass.xml")` | Wrong path, no UTF-8 BOM, spaces not TABs | `create_d365fo_file(...)` |
| Guessing method signatures | Compilation error guaranteed | `get_method_signature(className, methodName)` |
| `code_completion()` without className | Validation error — className is required | `code_completion(className="SalesTable")` |
| `code_completion` for semantic search | Prefix-only filter, not semantic | `search("totals", type="method")` |
| `find_references(symbolName=...)` | ❌ WRONG parameter — causes validation error | `find_references(targetName=...)` |
| `find_references(symbolType=...)` | ❌ WRONG parameter — causes validation error | `find_references(targetType=...)` |
| `get_api_usage_patterns(className=...)` | ❌ WRONG parameter — causes validation error | `get_api_usage_patterns(apiName=...)` |
| `generate_code(pattern="coc-extension")` | ❌ Does not exist — causes validation error | `generate_code(pattern="class")` + CoC template |
| `generate_code(pattern="event-handler")` | ❌ Does not exist — causes validation error | `generate_code(pattern="form-handler")` |
| `generate_code(pattern="service-class")` | ❌ Does not exist — causes validation error | `generate_code(pattern="class")` |
| `search(type="form")` | ❌ Not in registered enum | `get_form_info(formName)` |
| `search(type="query")` | ❌ Not in registered enum | `get_query_info(queryName)` |
| `search(type="view")` | ❌ Not in registered enum | `get_view_info(viewName)` |
| PowerShell to edit D365FO XML | Breaks TAB formatting, no XML validation | `modify_d365fo_file` or `replace_string_in_file` |

---

## � AUTO-DETECTION OF D365FO WORKSPACE

The MCP server **automatically detects** the active D365FO project from the workspace:

```
Detection priority:
  1. workspacePath parameter passed explicitly
  2. Current working directory (process.cwd())
  3. WORKSPACE_PATH environment variable

For each candidate path:
  → Scans recursively (max depth 5) for *.rnrproj files
  → Extracts <Model> / <ModelName> from .rnrproj
  → Returns: projectPath, modelName, solutionPath
```

**Impact on `create_d365fo_file`:**
- When Copilot has a workspace open, the tool auto-reads the ModelName from .rnrproj
- You can pass `modelName="any"` — it will be overridden with the correct detected model
- The detected model is automatically registered as a custom model in the classifier

```
Workspace has K:\VSProjects\MySolution\MyProject\MyProject.rnrproj
  with <Model>AslCore</Model>

create_d365fo_file(objectType="class", objectName="MyHelper", modelName="ignored")
  → AUTO-DETECTS: modelName="AslCore"
  → CREATES: K:\AosService\PackagesLocalDirectory\AslCore\AslCore\AxClass\MyHelper.xml
```

---

## �📁 FILE PATHS AND MODEL NAME

```
K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxClass\{Name}.xml
K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxTable\{Name}.xml
K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxForm\{Name}.xml
K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxEnum\{Name}.xml
K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxQuery\{Name}.xml
K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxView\{Name}.xml
```

**ModelName:** Automatically extracted from .rnrproj file (PropertyGroup/ModelName)
- ✅ **ALWAYS provide `projectPath` or `solutionPath`** when calling `create_d365fo_file`
- ❌ **WITHOUT projectPath/solutionPath:** Tool uses `modelName` parameter AS-IS → WRONG MODEL!
  - Example: `modelName="ApplicationSuite"` without projectPath → Creates in Microsoft's ApplicationSuite model!
  - ApplicationSuite is a STANDARD Microsoft model → NEVER add custom code there!
- When using `create_d365fo_file` with `projectPath` or `solutionPath`, the tool automatically
  reads the correct ModelName from the Visual Studio project file
- This ensures files are created in the correct PackagesLocalDirectory location
- The workspace path (e.g., `K:\VSProjects\SolutionName\ProjectName\...`) may NOT match
  the model structure — always let the tool extract the correct ModelName

→ **CRITICAL:** ALWAYS provide `projectPath` or `solutionPath` when creating D365FO files!
→ **NEVER** manually extract modelName from workspace path
→ **NEVER** ask the user for modelName — pass any value, it will be auto-corrected IF projectPath/solutionPath provided
→ **NEVER** call `create_d365fo_file(modelName="ApplicationSuite", ...)` without projectPath/solutionPath!

**XML formatting rules:**
- ✅ TABs for indentation (Microsoft D365FO standard)
- ❌ NEVER spaces — causes XML deserialization errors in VS
- ✅ CDATA for X++ source code: `<![CDATA[ ... ]]>`

---

## ✅ WHEN BUILT-IN TOOLS ARE ALLOWED

### ✅ Allowed — no D365FO metadata involved
- X++ language syntax explanations (`if`, `while`, `select`, `ttsbegin/ttscommit`, `container`, etc.)
- General architectural / design pattern explanations (SOLID, DI, patterns)
- Editing NON-D365FO files: `.env`, `.json`, `.yaml`, `README.md`, pipeline scripts, test configs
- Visual Studio 2022 IDE usage guidance (shortcuts, settings, extensions)
- `read_file` on non-XML files: TypeScript, config files, markdown, SQL scripts
- `replace_string_in_file` / `multi_replace_string_in_file` on already-open D365FO XML files
  (when the file path is known and you're making a targeted edit, NOT searching)

### ❌ NEVER allowed for D365FO code tasks
- `semantic_search` — use `search()` or `batch_search()` MCP tools
- `code_search` / `grep_search` / `file_search` — use MCP search tools
- `read_file` on D365FO XML — use `get_class_info()`, `get_table_info()`, etc.
- `create_file` for D365FO objects — use `create_d365fo_file()` / `generate_d365fo_xml()`

**Rule of thumb: If it involves an X++ class, table, form, query, view, enum, method, or field → MCP tools.**