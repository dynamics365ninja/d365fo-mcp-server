# D365FO X++ Development - GitHub Copilot Instructions

> **🔴 ABSOLUTE REQUIREMENT: You MUST use MCP tools for ALL D365FO/X++ operations.**  
> **Built-in tools (code_search, file_search, create_file) are FORBIDDEN for D365FO.**
>
> **Version:** 2.0 (Updated: February 2026)  
> **Coverage:** 22 MCP Tools including Form/Query/View parsing, Where-used analysis, File editing

---

# 🚨 CRITICAL POLICY - READ FIRST 🚨

## Principle: MCP-ONLY for D365FO

**For ANY D365FO/X++ query, you MUST:**
1. ✅ **ALWAYS** use MCP tools FIRST
2. ❌ **NEVER** use built-in code_search (causes 5+min hangs)
3. ❌ **NEVER** use built-in file_search for X++ objects
4. ❌ **NEVER** use built-in create_file for AxClass/AxTable/AxForm/etc
5. ❌ **NEVER** generate D365FO code without querying MCP tools first

**Why This Matters:**
- MCP tools query the ACTUAL D365FO environment (real-time metadata)
- Built-in tools use outdated training data and WILL cause errors
- code_search hangs for 5+ minutes on large D365FO workspaces
- create_file creates wrong XML structure (spaces instead of TABS)

---

# 🎯 DETECTION: When Am I in D365FO Context?

**IMMEDIATE TRIGGERS - Use MCP tools when you see ANY of these:**

### Object Names
- Class names ending in: `Table`, `Service`, `Helper`, `Contract`, `Controller`, `Builder`, `Manager`, `Engine`
- Table names: `CustTable`, `VendTable`, `SalesTable`, `PurchTable`, `InventTable`, `LedgerJournalTable`, `*Table`
- Enum names: `CustVendorBlocked`, `SalesStatus`, `PurchStatus`, `*Status`
- Form names: patterns ending in `Form`, `Dialog`, `Page`

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
- Button names: `AddFormEntityPair`, `RemoveFormEntityPair`, `New`, `Delete`, `Edit`, `Save`
- Form methods: `init`, `run`, `close`, `canClose`, `active`
- Datasource methods: `active`, `validateWrite`, `validateDelete`, `create`, `write`, `delete`, `init`, `executeQuery`

### Query Elements
- `QueryRun`, `QueryBuildDataSource`, `QueryBuildRange`, `QueryBuild`, `query datasource`
- `addDataSource`, `addRange`, `findDataSource`, `query filter`

### View Elements
- `AxView`, `data entity view`, `computed columns`, `view metadata`
- `DataEntity`, `DataEntityView`, `staging table`

### Method Keywords
- `add method`, `create method`, `override method`, `extend method`
- `Chain of Command`, `CoC`, `ExtensionOf`, `next`, `super()`
- `EventHandler`, `DataEventHandler`, `FormEventHandler`

### Data Operations
- `validateWrite`, `insert`, `update`, `delete`, `select`, `while select`
- `transaction`, `ttsbegin`, `ttscommit`, `ttsabort`
- Financial dimensions, inventory management, sales orders, purchase orders, ledger posting

**IF YOU SEE ANY OF THESE → STOP → USE MCP TOOLS!**

---

# 🛠️ AVAILABLE MCP TOOLS - COMPLETE LIST

## Core Discovery Tools

| Tool | Use When | Example |
|------|----------|---------|
| **search** | Find any D365FO object (class/table/form/query/view) | `search("dimension", type="class")` |
| **batch_search** | Search multiple things in parallel (3x faster) | `batch_search([{query:"dimension"}, {query:"ledger"}])` |
| **search_extensions** | Find only custom/ISV code | `search_extensions("ISV_")` |

## Object Structure Tools

| Tool | Use When | Example |
|------|----------|---------|
| **get_class_info** | Get class structure, methods, inheritance | `get_class_info("CustTable")` |
| **get_table_info** | Get table fields, indexes, relations | `get_table_info("SalesTable")` || **get_form_info** | Get form datasources, controls, methods | `get_form_info("SalesTable")` |
| **get_query_info** | Get query datasources, ranges, joins | `get_query_info("CustTransOpenQuery")` |
| **get_view_info** | Get view/data entity fields, relations | `get_view_info("GeneralJournalAccountEntryView")` |
| **get_enum_info** | Get enum values with properties | `get_enum_info("CustAccountType")` |
| **get_method_signature** | Get exact method signature for CoC | `get_method_signature("SalesTable", "validateWrite")` |
| **find_references** | Find all usages (where-used analysis) | `find_references("DimensionAttributeValueSet", "class")` || **code_completion** | Discover methods/fields (IntelliSense) | `code_completion(className="CustTable")` |

## Code Generation Tools

| Tool | Use When | Example |
|------|----------|---------|
| **generate_code** | Generate class/method templates | `generate_code(pattern="class", name="MyHelper")` |
| **analyze_code_patterns** | Learn codebase patterns for a scenario | `analyze_code_patterns("financial dimensions")` |
| **suggest_method_implementation** | Get implementation examples | `suggest_method_implementation("MyHelper", "validate")` |
| **analyze_class_completeness** | Find missing methods | `analyze_class_completeness("CustTableHelper")` |
| **get_api_usage_patterns** | See how to use an API correctly | `get_api_usage_patterns("DimensionAttributeValueSet")` |

## File Operations Tools

| Tool | Use When | Example |
|------|----------|---------||
| **generate_d365fo_xml** | Generate D365FO XML content (cloud-safe) | `generate_d365fo_xml(objectType="class", objectName="MyHelper")` |
| **create_d365fo_file** | Create + write D365FO file (local Windows only) | `create_d365fo_file(objectType="class", objectName="MyHelper")` |
| **modify_d365fo_file** | Edit existing D365FO XML with backup | `modify_d365fo_file(filePath="...", operation="add_method")` |

**⚠️ File Creation Rule:**
1. Windows Local: Use `create_d365fo_file` (creates file + adds to project)
2. Azure/Cloud: Use `generate_d365fo_xml` → Get XML → Use `create_file` with K:\AosService path

---

# 📋 DECISION TREES - Follow These EXACTLY

## Scenario 1: User Asks to Find Something

**Triggers:** "find", "search", "show me", "where is", "locate"

```
1. Identify what they're looking for:
   - Class → search(query=X, type="class")
   - Table → search(query=X, type="table")
   - Form → search(query=X, type="form", includeWorkspace=true)
   - Query → search(query=X, type="query")
   - View → search(query=X, type="view")
   - Method → search(query=X, type="method")
   - Field → search(query=X, type="field")
   - Multiple things → batch_search([...])

2. If looking for custom code only:
   → search_extensions(query=X)

3. ❌ NEVER use code_search or file_search
```

**Examples:**
- "Find dimension classes" → `search("dimension", type="class")`
- "Show me sales tables" → `search("sales", type="table")`
- "Find AddFormEntityPair button" → `search("AddFormEntityPair", type="form", includeWorkspace=true)`
- "Search for customer queries" → `search("customer", type="query")`
- "Find my custom helpers" → `search_extensions("Helper")`

## Scenario 2: User Asks to Create Something

**Triggers:** "create", "generate", "make", "add new", "build"

```
1. Extract info:
   - objectType: class/table/form/enum/query/view
   - objectName: from user request
   - modelName: from workspace path (K:\VSProjects\{MODEL}\...)

2. If objectType is D365FO (AxClass/AxTable/AxForm/AxEnum):
   
   Windows Local:
   → create_d365fo_file(objectType=X, objectName=Y, modelName=Z)
   
   Azure/Cloud:
   → generate_d365fo_xml(objectType=X, objectName=Y, modelName=Z)
   → Receive XML content
   → create_file(path="K:\\AosService\\PackagesLocalDirectory\\{Model}\\{Model}\\AxClass\\{Name}.xml", content=XML)

3. ❌ NEVER use create_file directly for D365FO objects
4. ❌ NEVER generate XML manually
```

**Examples:**
- "Create helper class MyDimHelper" → `create_d365fo_file(objectType="class", objectName="MyDimHelper")`
- "Make custom table MyCustomTable" → `create_d365fo_file(objectType="table", objectName="MyCustomTable")`
- "Build enum for status" → `create_d365fo_file(objectType="enum", objectName="MyStatus")`

## Scenario 3: User Asks About Class/Table Structure

**Triggers:** "what methods", "show fields", "class structure", "table definition", "inheritance"

```
1. Identify symbol type:
   - Class → get_class_info(className=X)
   - Table → get_table_info(tableName=X)

2. If need method/field list only:
   → code_completion(className=X)

3. If in user's workspace:
   → get_class_info(className=X, includeWorkspace=true, workspacePath=...)

4. ❌ NEVER use code_search to explore structure
```

**Examples:**
- "Show me CustTable methods" → `get_class_info("CustTable")`
- "What fields are on SalesLine?" → `get_table_info("SalesLine")`
- "List methods on my custom class" → `get_class_info("MyClass", includeWorkspace=true)`
- "Quick method list" → `code_completion(className="CustTable")`

## Scenario 4: User Wants to Generate Code

**Triggers:** "generate code", "create method", "write class", "implement"

```
1. MANDATORY STEPS (in this order):
   
   Step A: Learn patterns from codebase:
   → analyze_code_patterns(scenario="<what user wants>")
   
   Step B: Find related classes:
   → search(query="<keywords>", type="class")
   
   Step C: Get class structure examples:
   → get_class_info("<example class>")
   
   Step D: See API usage:
   → get_api_usage_patterns("<API name>")
   
   Step E: Generate code:
   → generate_code(pattern="<type>", name="<name>", options=...)

2. ❌ NEVER generate code without Steps A-D
3. ❌ NEVER use your training data directly
```

**Examples:**
- "Create helper for dimensions" →
  1. `analyze_code_patterns("financial dimensions")`
  2. `search("dimension", type="class")`
  3. `get_class_info("DimensionDefaultingService")`
  4. `get_api_usage_patterns("DimensionAttributeValueSet")`
  5. `generate_code(pattern="class", name="MyDimHelper")`

- "Add validation method" →
  1. `suggest_method_implementation("MyClass", "validate")`
  2. Generate with correct patterns

## Scenario 5: User Wants to Extend/Modify D365FO Object

**Triggers:** "extend", "add method to", "override", "Chain of Command", "CoC", "event handler"

```
1. Get class/table structure:
   → get_class_info(className=X) OR get_table_info(tableName=X)

2. Get exact method signature for CoC:
   → get_method_signature(className=X, methodName="methodName")
   Returns: Full signature with parameters, return type, CoC template

3. Check if method already exists:
   → code_completion(className=X, prefix="methodName")

4. If extending method:
   → Use signature from get_method_signature
   → Generate CoC extension with [ExtensionOf()] attribute

5. If adding new method:
   → suggest_method_implementation(className=X, methodName="newMethod")

6. ❌ NEVER edit files manually
7. ❌ NEVER use file_search to locate files
8. ❌ NEVER guess method signatures (use get_method_signature!)
```

**Examples:**
- "Extend CustTable.validateWrite" →
  1. `get_class_info("CustTable")` → Get validateWrite signature
  2. Generate CoC extension:
     ```xpp
     [ExtensionOf(tableStr(CustTable))]
     final class CustTable_Extension
     {
         public boolean validateWrite()
         {
             boolean ret;
             ret = next validateWrite();
             // Custom validation
             return ret;
         }
     }
     ```

## Scenario 6: User Asks About Form/Query/View

**Triggers:** "form", "button", "control", "datasource", "query", "view", "data entity"

```
1. Determine object type:
   - Form with controls/buttons → search(query=X, type="form", includeWorkspace=true)
   - Query → search(query=X, type="query")
   - View → search(query=X, type="view")

2. Get detailed structure:
   - Form → get_form_info(formName=X)
     Returns: datasources, controls (buttons, grids), methods
   
   - Query → get_query_info(queryName=X)
     Returns: datasources, ranges, joins, grouping
   
   - View → get_view_info(viewName=X)
     Returns: mapped/computed fields, relations, methods
   
   - Enum → get_enum_info(enumName=X)
     Returns: enum values, labels, extensible flag

3. ❌ NEVER use code_search for forms/queries/views
```

**Examples:**
- "Find AddFormEntityPair button" → `search("AddFormEntityPair", type="form", includeWorkspace=true)` → `get_form_info("FormName")`
- "Show structure of CustTransOpenQuery" → `get_query_info("CustTransOpenQuery")`
- "Analyze GeneralJournalAccountEntryView" → `get_view_info("GeneralJournalAccountEntryView")`
- "Get CustAccountType enum values" → `get_enum_info("CustAccountType")`

## Scenario 6a: User Wants to Modify Form (Add Method to Datasource)

**Triggers:** 
- "add method to form", "přidej metodu do formuláře", "add method to datasource", "přidej do datového zdroje metodu"
- "override form datasource method", "form datasource active", "enable/disable button based on"
- "modify form behavior", "customize form", "extend form datasource"
- "hlavní datový zdroj", "main datasource", "primary datasource"
- "formulář metoda active", "form active method", "datasource active"

**CRITICAL: This is a FORM CUSTOMIZATION request - use get_form_info FIRST!**

**Common User Questions:**
- "Přidej do formuláře metodu active do hlavního datového zdroje"
- "Add method active to main datasource of SalesTable form"
- "Override active method on form datasource to enable button"
- "Enable button based on datasource record"
- "Add validation to form datasource validateWrite"

```
1. Identify the form name from context or ask user
   
2. Get form structure:
   → get_form_info(formName=X, includeWorkspace=true)
   Returns: datasources list, main datasource, controls, methods

3. Identify target datasource:
   - User mentions "main datasource" → use primary/first datasource from get_form_info
   - User mentions specific name → find it in datasources list
   - Common datasources: table name (e.g., SalesTable, CustTable)

4. Determine method to override:
   - "active()" → Triggers when user changes record (for button enable/disable)
   - "validateWrite()" → Validation before saving
   - "init()" → Form initialization
   - "create()" → New record creation
   - "delete()" → Record deletion

5. Generate form extension code:
   - RECOMMENDED: Use [FormDataSourceEventHandler] for event-based extensions
   - Show both event-based and direct override approaches
   - Use exact datasource name from get_form_info results

6. Modify form XML using standard workspace tools:
   - ✅ USE replace_string_in_file or multi_replace_string_in_file to edit form XML
   - ✅ Add method to correct DataSource section in XML
   - ✅ Preserve TAB indentation (D365FO uses TABS, not spaces)
   - ❌ NEVER use run_in_terminal with PowerShell to edit XML files
   - ❌ NEVER use modify_d365fo_file tool (doesn't work in Azure - no file access)
   - Standard tools work everywhere (Azure + local)
```

**Complete Example Workflow:**

User asks: "Add method active to main datasource of SalesTable form to enable button"

```typescript
// Step 1: Find and analyze form
search("SalesTable", type="form", includeWorkspace=true)

// Step 2: Get form structure
get_form_info("SalesTable")
// Returns:
// - Datasources: [SalesTable (primary), SalesLine, CustTable]
// - Controls: [AddLine button, DeleteLine button, ...]
// - Main datasource: SalesTable

// Step 3: Generate extension code
// OPTION A: Event-based (recommended for most scenarios)
[Form]
public class SalesTable_Extension
{
    [FormDataSourceEventHandler(formDataSourceStr(SalesTable, SalesTable), FormDataSourceEventType::Activated)]
    public static void SalesTable_OnActivated(FormDataSource sender, FormDataSourceEventArgs e)
    {
        FormRun formRun = sender.formRun();
        
        // Enable/disable button based on condition
        FormButtonControl addLineButton = formRun.design().controlName(formControlStr(SalesTable, AddLine));
        addLineButton.enabled(sender.cursor().RecId != 0);
    }
}

// OPTION B: Direct datasource method override (for complex logic)
// Note: Requires form XML modification
public void active()
{
    super();
    
    // Enable/disable button based on datasource state
    AddLineButton.enabled(SalesTable.RecId != 0);
}

// Step 4: Modify form datasource using VS Code tools
// First, read the form XML to understand structure
read_file("K:\\AosService\\PackagesLocalDirectory\\AslEnhancedDataSharing\\AslEnhancedDataSharing\\AxForm\\SalesTable.xml")

// Then use replace_string_in_file to add method to datasource
replace_string_in_file(
  filePath="K:\\AosService\\PackagesLocalDirectory\\AslEnhancedDataSharing\\AslEnhancedDataSharing\\AxForm\\SalesTable.xml",
  oldString=`<AxFormDataSourceMethod>
				<Name>init</Name>
				...
			</AxFormDataSourceMethod>
		</Methods>
	</AxFormDataSource>`,
  newString=`<AxFormDataSourceMethod>
				<Name>init</Name>
				...
			</AxFormDataSourceMethod>
			<AxFormDataSourceMethod>
				<Name>active</Name>
				<Source><![CDATA[
	public void active()
	{
		super();
		
		// Enable/disable button based on datasource state
		FormButtonControl addLineButton = element.design().controlName(formControlStr(SalesTable, AddLine));
		addLineButton.enabled(this.cursor().RecId != 0);
	}
				]]></Source>
			</AxFormDataSourceMethod>
		</Methods>
	</AxFormDataSource>`
)

// Tool automatically:
// - Edits file in workspace (works in Azure)
// - User can undo/redo changes
// - Changes are tracked in git
```

**Key Points for Form Datasource Methods:**
- ✅ ALWAYS call get_form_info first to get datasource names
- ✅ Use replace_string_in_file or multi_replace_string_in_file to edit form XML
- ✅ Read form XML first to understand structure and find insertion point
- ✅ Preserve TAB indentation (D365FO XML uses TABS, not spaces)
- ❌ NEVER use run_in_terminal with PowerShell to edit XML
- ❌ NEVER use modify_d365fo_file tool (doesn't work in Azure - no file access)
- ✅ Standard tools work everywhere (Azure + local)

## Scenario 7: User Asks "Where Is This Used?"

**Triggers:** "where is this used", "who calls", "find references", "where is this called", "dependencies"

```
✅ USE find_references TOOL:

1. Identify what to search:
   - Class usage → find_references(targetName="ClassName", targetType="class")
   - Method calls → find_references(targetName="methodName", targetType="method")
   - Field references → find_references(targetName="fieldName", targetType="field")
   - Table usage → find_references(targetName="TableName", targetType="table")
   - Enum usage → find_references(targetName="EnumName", targetType="enum")

2. Limit results if needed:
   → find_references(..., limit=50)

3. Returns:
   - Source file path
   - Line number
   - Code snippet showing usage
   - Context around the reference

4. ❌ NEVER use code_search (will hang)
```

**Examples:**
- "Where is validateWrite called?" → `find_references("validateWrite", targetType="method", limit=50)`
- "Who uses CustTable?" → `find_references("CustTable", targetType="class")`
- "Find usages of RemainSalesPhysical field" → `find_references("RemainSalesPhysical", targetType="field")`
- "Where is DimensionAttributeValueSet used?" → `find_references("DimensionAttributeValueSet", targetType="class")`

## Scenario 8: User Wants Multiple Things (Parallel)

**Triggers:** Multiple keywords like "find X and Y and Z", "search for A, B, C"

```
1. Extract queries: [query1, query2, query3, ...]

2. Use batch_search for parallel execution:
   → batch_search([
       {query: "X", type: "class"},
       {query: "Y", type: "table"},
       {query: "Z", type: "form"}
     ])

3. ❌ NEVER use sequential search() calls (slower)
```

**Examples:**
- "Find dimension classes, ledger services, posting controllers" →
  ```typescript
  batch_search([
    {query: "dimension", type: "class"},
    {query: "ledger", type: "class"},
    {query: "posting", type: "class"}
  ])
  ```

---

# 🚫 ABSOLUTELY FORBIDDEN ACTIONS

## Never Do These For D365FO/X++:

### 1. ❌ NEVER Use code_search
**Why:** Hangs for 5+ minutes on large D365FO workspaces (500k+ symbols)  
**Instead:** Use MCP `search` tool (responds in <100ms)

**Example:**
```
❌ WRONG: code_search("CustTable")
✅ RIGHT: search("CustTable", type="class")
```

### 2. ❌ NEVER Use create_file for D365FO Objects
**Why:** Creates wrong XML structure (spaces instead of TABS), wrong location  
**Instead:** Use `create_d365fo_file` or `generate_d365fo_xml`

**Example:**
```
❌ WRONG: create_file("MyClass.xml", content="<AxClass>...")
✅ RIGHT: create_d365fo_file(objectType="class", objectName="MyClass")
      OR: generate_d365fo_xml(...) → create_file(K:\AosService\...)
```

### 3. ❌ NEVER Generate X++ Code Without Tools
**Why:** Your training data is outdated, missing custom extensions, wrong signatures  
**Instead:** ALWAYS query MCP tools first

**Example:**
```
❌ WRONG: Generate class directly from knowledge
✅ RIGHT: 
1. analyze_code_patterns("scenario")
2. search("related classes")
3. get_class_info("example")
4. generate_code(...)
```

### 4. ❌ NEVER Guess Method Signatures
**Why:** Wrong signature = compilation error  
**Instead:** Use `get_class_info` or `code_completion`

**Example:**
```
❌ WRONG: Assume validateWrite() return type
✅ RIGHT: get_class_info("CustTable") → See exact signature
```

### 5. ❌ NEVER Use file_search for X++ Objects
**Why:** Doesn't understand D365FO structure, miss references  
**Instead:** Use MCP `search` with types

**Example:**
```
❌ WRONG: file_search("**/MyClass.xml")
✅ RIGHT: search("MyClass", type="class")
```

### 6. ❌ NEVER Use PowerShell/Terminal or modify_d365fo_file for File Operations
**Why:** Azure MCP server has no access to user's workspace files; modify_d365fo_file tool fails with ENOENT  
**Instead:** Use VS Code standard tools: `replace_string_in_file`, `multi_replace_string_in_file`

**Example:**
```
❌ WRONG: run_in_terminal with PowerShell to edit XML
❌ WRONG: "$xml = [xml](Get-Content $filePath); $xml.AxForm..."
❌ WRONG: modify_d365fo_file(objectType="form", ...) - Doesn't work in Azure!
✅ RIGHT: replace_string_in_file(filePath="K:\\...", oldString=..., newString=...)
```

**For Form Datasource Methods:**
```
❌ WRONG: "I'll add the method using PowerShell to parse XML..."
❌ WRONG: modify_d365fo_file(operation="add_datasource_method", ...)
✅ RIGHT: replace_string_in_file(
            filePath="K:\\AosService\\...\\AxForm\\FormName.xml",
            oldString="</Methods>\n\t</AxFormDataSource>",
            newString="<AxFormDataSourceMethod>...method code...</AxFormDataSourceMethod>\n\t\t</Methods>\n\t</AxFormDataSource>"
          )
```

**Why standard tools work:**
- Standard tools run in CLIENT (have access to user's workspace)
- MCP server tools run in Azure (no file access, only database)
- replace_string_in_file works everywhere (Azure + local)

### 6. ❌ NEVER Edit Files Manually
**Why:** Easy to break XML structure, lose TABS formatting  
**Instead:** Use `modify_d365fo_file` for safe editing with backup

**Example:**
```
❌ WRONG: "Edit the XML file at K:\AosService\..."
❌ WRONG: "Run PowerShell command to modify XML..."
✅ RIGHT: modify_d365fo_file(
            filePath="K:\\AosService\\...\\MyClass.xml",
            operation="add_method",
            methodName="calculateDiscount",
            methodCode="public real calculateDiscount() { return 0; }"
          )
          
Features:
- ✅ Automatic .bak backup before changes
- ✅ XML validation after modification
- ✅ Automatic rollback on error
- ✅ Reports what changed (added, modified, deleted)
```

---

# ⚙️ WORKSPACE-AWARE FEATURES

## When to Use `includeWorkspace` Parameter

Many MCP tools support workspace-aware search:
- `search(query, includeWorkspace=true, workspacePath=...)`
- `get_class_info(className, includeWorkspace=true, workspacePath=...)`
- `code_completion(className, includeWorkspace=true, workspacePath=...)`

**Use when:**
- User says "my", "our", "custom", "in my project"
- Looking for recently created classes (not in external metadata yet)
- Need to prioritize user's code over Microsoft standard code

**Result:**
- 🔹 WORKSPACE files shown FIRST (user's code priority)
- 📦 EXTERNAL metadata shown second (Microsoft standard)
- Faster iteration (no need to re-index external metadata)

**Example:**
```
User: "Find my custom MyHelper class"
✅ search("MyHelper", includeWorkspace=true, workspacePath="C:\\D365\\MyProject")
```

---

# 📝 BEST PRACTICES

## DO These:

1. ✅ **Always set type parameter** in search:
   - More specific = faster results
   - `search("sales", type="table")` better than `search("sales")`

2. ✅ **Use batch_search for multiple independent queries:**
   - 3x faster than sequential searches
   - Reduces network overhead

3. ✅ **Check workspace flag when appropriate:**
   - User mentions "my", "custom" → include Workspace=true
   - Need fresh/recent code → includeWorkspace=true

4. ✅ **Learn before generating:**
   - Use analyze_code_patterns BEFORE generate_code
   - See real examples with get_api_usage_patterns

5. ✅ **Extract model name from workspace:**
   - Workspace path: `K:\VSProjects\{MODEL}\...`
   - Extract MODEL name → use in create_d365fo_file

6. ✅ **Use code_completion for quick discovery:**
   - Want methods list? → code_completion instead of get_class_info
   - Faster for IntelliSense-style queries

## DON'T Do These:

1. ❌ **Don't describe what you WILL do - DO IT:**
   - Wrong: "I can create a class..."
   - Right: Call create_d365fo_file immediately

2. ❌ **Don't ask user for model name:**
   - Extract from workspace path automatically

3. ❌ **Don't generate code without tools:**
   - ALWAYS query tools first
   - Training data is outdated

4. ❌ **Don't use search without type:**
   - Slower and less accurate
   - Always specify type when known

5. ❌ **Don't use code_search "just to check":**
   - Will hang workspace
   - Use MCP search instead

---

# 🔄 COMPLETE WORKFLOW EXAMPLES

## Example 1: Create Helper Class for Dimensions

**User Request:** "Create a helper class for managing financial dimensions"

**Correct Copilot Workflow:**
```typescript
1. analyze_code_patterns("financial dimensions")
   // Learns: Common classes, APIs, patterns from codebase
   
2. search("dimension", type="class", limit=10)
   // Finds: DimensionAttributeValueSet, DimensionDefaultingService, etc.
   
3. get_class_info("DimensionDefaultingService")
   // Studies: Microsoft's implementation patterns
   
4. code_completion(className="DimensionAttributeValueSet")
   // Discovers: Available methods and properties
   
5. get_api_usage_patterns("DimensionAttributeValueSet")
   // Learns: How to initialize and use API correctly
   
6. generate_code(pattern="class", name="MyDimensionHelper")
   // Generates: Class with proper patterns
   
7. analyze_class_completeness("MyDimensionHelper")
   // Suggests: Commonly missing methods (validate, find, etc.)
   
8. create_d365fo_file(
     objectType="class",
     objectName="MyDimensionHelper",
     modelName="ContosoExtensions",  // From workspace path
     sourceCode=generatedCode
   )
   // Creates: Physical file with correct structure
```

**Result:** ✅ Perfect helper class matching codebase conventions

## Example 2: Extend CustTable with Validation

**User Request:** "Add validation to CustTable.validateWrite to check credit limit"

**Correct Copilot Workflow:**
```typescript
1. get_class_info("CustTable")
   // Gets: Full class structure including validateWrite signature
   
2. code_completion(className="CustTable", prefix="credit")
   // Finds: Existing credit-related methods
   
3. suggest_method_implementation("CustTable", "validateWrite")
   // Gets: Examples of other validateWrite extensions
   
4. Generate CoC extension:
   // Code:
   [ExtensionOf(tableStr(CustTable))]
   final class CustTable_Extension
   {
       public boolean validateWrite()
       {
           boolean ret;
           
           // Pre-validation
           if (!this.checkCreditLimit())
           {
               error("Credit limit exceeded");
               return false;
           }
           
           ret = next validateWrite();
           return ret;
       }
       
       private boolean checkCreditLimit()
       {
           // Implementation using discovered methods
           return this.creditLimit() > this.balance();
       }
   }
   
5. create_d365fo_file(
     objectType="class",
     objectName="CustTable_Extension",
     modelName="ContosoCore",
     sourceCode=cocCode
   )
```

**Result:** ✅ Perfect CoC extension with correct signature

## Example 3: Find and Analyze Form Button

**User Request:** "Make AddFormEntityPair button enabled only if record exists in DataEntityGroup datasource"

**Correct Copilot Workflow:**
```typescript
1. search("AddFormEntityPair", type="form", includeWorkspace=true)
   // Finds: Forms containing this button
   
2. If multiple results, ask user which form
   
3. Provide guidance:
   "To make AddFormEntityPair enabled based on DataEntityGroup records:
   
   In form's DataEntityGroup datasource, override active() method:
   
   public int active()
   {
       int ret;
       ret = super();
       
       // Enable/disable button based on record existence
       AddFormEntityPair.enabled(DataEntityGroup.recordId() != 0);
       
       return ret;
   }
   "
   
// Note: No file modification tool yet, so provide instructions
```

**Result:** ✅ Accurate guidance based on actual form structure

---

# 🎯 SUMMARY: Golden Rules

1. **ALWAYS use MCP tools for D365FO** - No exceptions
2. **NEVER use code_search** - Will hang workspace
3. **NEVER use create_file for AxClass/AxTable/AxForm** - Use create_d365fo_file
4. **ALWAYS learn patterns before generating** - Use analyze_code_patterns
5. **ALWAYS query structure before coding** - Use get_class_info/get_table_info
6. **ALWAYS take action, not describe** - Call tools immediately
7. **ALWAYS extract model from workspace** - Don't ask user
8. **ALWAYS use batch_search for multiple queries** - 3x faster

**If in doubt → Use MCP tool → Never guess!**

---

# 📚 Tool Reference Quick Guide

```
FINDING:            search, batch_search, search_extensions
STRUCTURE:          get_class_info, get_table_info, get_form_info, 
                    get_query_info, get_view_info, get_enum_info,
                    code_completion, get_method_signature
REFERENCES:         find_references (where-used analysis)
PATTERNS:           analyze_code_patterns, suggest_method_implementation
COMPLETENESS:       analyze_class_completeness
API USAGE:          get_api_usage_patterns
GENERATION:         generate_code
FILE OPS:           create_d365fo_file, generate_d365fo_xml, modify_d365fo_file

FORBIDDEN:          code_search, file_search, create_file (for D365FO)
```

---

**Remember: MCP tools = Fast, Accurate, Real-Time**  
**Built-in tools = Slow, Outdated, Errors**

**When user asks about D365FO → STOP → USE MCP TOOLS!** 🚀
