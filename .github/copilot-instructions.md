# D365 Finance & Operations X++ Development

This workspace contains Dynamics 365 Finance & Operations (D365FO) code. When working with X++ code, classes, tables, forms, enums, or any D365FO metadata, **always use the specialized MCP tools** described below. These tools provide access to a pre-indexed symbol database with 584,799+ D365FO objects.

## Critical Rules for Tool Usage

### Built-in Tools vs. MCP Tools

The following built-in tools **MUST NOT** be used on D365FO metadata files (.xml, .xpp):

| Built-in Tool ❌ | Use MCP Tool Instead ✅ | Why |
|-----------------|------------------------|-----|
| `code_search` | `search()` or `batch_search()` | Built-in tool cannot parse 500K+ XML files; MCP has pre-indexed symbols |
| `file_search` | `search()` with type filter | D365FO objects are not in workspace; symbols are in external database |
| `get_symbols_by_name` | `search()` or specific tools like `get_class_info()` | MCP tools understand D365FO object hierarchy and inheritance |
| `get_file` | `get_class_info()`, `get_table_info()`, `get_form_info()`, etc. | Source code is embedded in metadata; MCP tools extract it correctly |
| `edit_file` | `modify_d365fo_file()` | Editing XML manually breaks structure; MCP tool validates and backs up |
| `create_file` | `create_d365fo_file()` with optional `generate_d365fo_xml()` first | D365FO files require specific XML schema and AOT structure |
| `apply_patch` | `modify_d365fo_file()` | Patches on XML corrupt metadata; use structured operations instead |

### Non-Negotiable Rules

1. **NEVER call `get_file`, `read_file`, or `code_search`** on D365FO files (.xml, .xpp)
   - These files are not in the workspace or are unparseable
   - Always fails with path errors or returns malformed XML

2. **NEVER call `get_file` or `read_file` AFTER an MCP tool**
   - MCP result is complete and final
   - If the result seems incomplete, call the MCP tool again with different parameters

3. **NEVER use `edit_file`, `replace_string_in_file`, or `multi_replace_string_in_file`** on D365FO files
   - **ONLY `modify_d365fo_file()` is allowed** for editing .xml metadata
   - These tools break XML indentation, lack X++ syntax validation, and can corrupt metadata

4. **NEVER guess method signatures**
   - Always call `get_method_signature(className, methodName)` before creating Chain of Command (CoC) extensions
   - Incorrect signatures cause compilation errors

5. **NEVER call `create_file` for D365FO objects**
   - **ONLY use `create_d365fo_file()`** for creating D365FO files (classes, tables, forms, enums, etc.)
   - Optional: call `generate_d365fo_xml()` first to get XML content, then pass it to `create_d365fo_file()`
   - `create_file` will corrupt D365FO metadata and break project integration

6. **Use specific tools for specific object types**
   - For forms: use `get_form_info()`, not `search(type="form")`
   - For queries: use `get_query_info()`, not `search(type="query")`
   - For views/data entities: use `get_view_info()`, not `search(type="view")`

7. **Use correct parameter names**
   - `find_references(targetName=...)` — NOT `symbolName`
   - `get_api_usage_patterns(apiName=...)` — NOT `className`

8. **Use valid code generation patterns**
   - Valid: `class`, `runnable`, `form-handler`, `data-entity`, `batch-job`, `table-extension`
   - Invalid: `coc-extension`, `event-handler`, `service-class` (these do not exist)

9. **ALWAYS search for labels before creating new ones**
   - Call `search_labels(text)` first — reusing existing labels avoids duplication and translation costs
   - When a suitable label exists, use its reference `@LabelFileId:LabelId` directly
   - Only call `create_label()` when no suitable label is found
   - **NEVER edit .label.txt files directly** — use `create_label()` which inserts alphabetically and updates the index

## Available MCP Tools

### 🔍 Search and Discovery (8 tools)

| Tool | Replaces Built-in | Description | Example Usage |
|------|-------------------|-------------|---------------|
| `search(query, type?)` | `code_search`, `file_search`, `get_symbols_by_name` | Searches 584,799+ pre-indexed D365FO symbols by name or keyword. Supports type filters: class, table, method, field, enum, edt, form, query | "Find classes that handle dimension posting" |
| `batch_search(queries[])` | Multiple `code_search` calls | Executes multiple searches in parallel (3× faster than sequential). Use when you need information about several unrelated objects | "Find SalesTable, CustTable, and InventTable" |
| `search_extensions(query)` | `code_search` with ISV filter | Searches only custom/ISV code, filtering out 500K+ Microsoft standard objects | "Find my custom extensions for CustTable" |
| `get_class_info(className)` | `get_file` + `get_symbols_by_name` | Returns complete class definition: all methods with signatures and source code, inheritance chain (extends/implements), and attributes | "Show me everything about SalesFormLetter" |
| `get_table_info(tableName)` | `get_file` + `get_symbols_by_name` | Returns full table schema: all fields with EDT/data types (with explicit EDT marker when present), indexes (including primary key), foreign key relations, and methods | "Show me fields and relations on CustTable" |
| `get_enum_info(enumName)` | `get_symbols_by_name` | Returns all enum values with their integer values and labels. **Note:** For Extended Data Types (EDT), use `get_edt_info()` instead | "What values does SalesStatus have?" |
| `get_edt_info(edtName, modelName?)` | `get_symbols_by_name` | Returns complete EDT definition: base type (Extends), enum type, reference table, string/number constraints, labels, help text, and all EDT properties. **Use this for all EDT queries, not get_enum_info** | "Show me EDT properties for CustAccount" |
| `code_completion(symbolName)` | None (new capability) | Lists available methods and fields on a class or table, with IntelliSense-like filtering | "What methods start with 'calc' on SalesTable?" |

### 🏷️ Label Management (3 tools)

| Tool | Description | Example Usage |
|------|-------------|---------------|
| `search_labels(query, language?, model?, labelFileId?)` | Full-text search across all indexed AxLabelFile labels. Searches by ID, text and comment. Returns `@LabelFileId:LabelId` reference syntax. **Call this FIRST before create_label!** | `search_labels("customer name", model="AslCore")` |
| `get_label_info(labelId?, labelFileId?, model?)` | Get all language translations for a label ID, or list available AxLabelFile IDs in a model. Shows ready-to-use X++ and XML snippets. | `get_label_info("ACFeature", model="AslCore")` |
| `create_label(labelId, labelFileId, model, translations[])` | Add a new label to all language .label.txt files in a custom model. Inserts alphabetically. Optionally creates AxLabelFile structure from scratch. Updates the MCP index. | `create_label("MyField", "AslCore", "AslCore", [{language:"en-US", text:"My field"}, {language:"cs", text:"Moje pole"}])` |

### 📊 Advanced Object Information (5 tools)

| Tool | Replaces Built-in | Description | Example Usage |
|------|-------------------|-------------|---------------|
| `get_form_info(formName)` | `get_file` | Parses form XML and returns datasource structure (fields, methods), control hierarchy (buttons, grids, groups), and form-level methods | "Show me datasources in SalesTable form" |
| `get_query_info(queryName)` | `get_file` | Returns query structure: all datasources, joins, field lists, and range definitions | "Analyze CustTransOpenQuery" |
| `get_view_info(viewName)` | `get_file` | Returns view/data entity structure: fields (mapped and computed), relations, primary key, computed columns, and methods. Works for both AxView and AxDataEntityView objects. **Use for data entities** | "Show me GeneralJournalAccountEntryView or CustomerV3Entity" |
| `get_method_signature(className, methodName)` | `get_symbols_by_name` | Extracts exact method signature including modifiers, return type, and parameters with default values. **Essential before Chain of Command extensions** | "Get signature of CustTable.validateWrite()" |
| `find_references(targetName, targetType?)` | None (new capability) | Performs where-used analysis across entire codebase. Works for classes, methods, tables, fields, and enums | "Where is DimensionAttributeValueSet used?" |

### 🧠 Intelligent Code Generation (4 tools)

| Tool | Replaces Built-in | Description | Example Usage |
|------|-------------------|-------------|---------------|
| `analyze_code_patterns(scenario)` | None (new capability) | Analyzes your actual codebase to find most common classes, methods, and dependencies used in a scenario. **Call this before generating code** | "Analyze patterns for ledger journal creation" |
| `suggest_method_implementation(className, methodName)` | None (new capability) | Finds real examples of how similar methods are implemented in your codebase | "How do others implement validateWrite()?" |
| `analyze_class_completeness(className)` | None (new capability) | Checks which standard methods (validateWrite, insert, update, delete, etc.) your class is missing | "Is MyHelper class complete?" |
| `get_api_usage_patterns(apiName)` | None (new capability) | Shows how a specific API/class is typically initialized and used in your codebase, including common method call sequences | "How do I correctly use LedgerJournalEngine?" |
| `generate_code(pattern, name, ...)` | None | Generates X++ boilerplate for common patterns: `class`, `runnable`, `form-handler`, `data-entity`, `batch-job`, `table-extension` | "Generate a batch job for order processing" |

### 📝 File & Metadata Operations (3 tools)

| Tool | Replaces Built-in | Description | When to Use |
|------|-------------------|-------------|-------------|
| `generate_d365fo_xml(objectType, objectName, ...)` | None | Returns D365FO XML content as text. Use with `create_d365fo_file()` for file creation, or alone for inspection/review | Get XML content before creating file, or inspect XML structure |
| `create_d365fo_file(objectType, objectName, modelName, projectPath?, solutionPath?, addToProject?)` | `create_file` | **ONLY tool for creating D365FO files.** Creates physical file in correct AOT location and optionally adds to Visual Studio project. ⚠️ ALWAYS provide `projectPath` (path to `.rnrproj`) or `solutionPath` — tool auto-extracts correct ModelName from the project file. Without them the `modelName` parameter is used AS-IS, which may create files in a Microsoft standard model! | Creating ANY D365FO object (class, table, form, enum, etc.) |
| `modify_d365fo_file(objectType, objectName, operation, ...)` | `edit_file`, `apply_patch`, `replace_string_in_file` | Safely edits D365FO XML with automatic backup (.bak), validation, and rollback on error. Supports: add-method, remove-method, add-field, remove-field, modify-property | Local Windows VM with K:\ drive access |

## Common Workflows

### Creating a New D365FO Object

**Best Practice Workflow:**
1. Call `analyze_code_patterns("description of what you're building")` — learn from existing patterns
2. Call `generate_code(pattern, name)` or get related examples
3. **ALWAYS call `create_d365fo_file(objectType, objectName, modelName, addToProject=true)`** — creates file and adds to project
   - The tool auto-detects the correct model from `.rnrproj` in the workspace
   - Works in all environments (local, cloud, Azure)
   - Optional: call `generate_d365fo_xml()` first, then pass XML to `create_d365fo_file()`
   - **NEVER use `create_file()` for D365FO objects - always use `create_d365fo_file()`**

> ⚠️ **CRITICAL — `projectPath` or `solutionPath` MUST be provided** when calling `create_d365fo_file`:
> - GitHub Copilot **automatically passes the active workspace path** to the MCP server — the server extracts `projectPath` from it by scanning for `.rnrproj` files. **You typically don't need to specify `projectPath` explicitly.**
> - The server also scans well-known dev directories (`K:\VSProjects`, `C:\VSProjects`, etc.) as a fallback.
> - If auto-detection still fails: add `projectPath` to `.mcp.json` (see **📁 File Paths and Model Name** section below).
> - **WITHOUT any resolved `projectPath`**: the tool uses `modelName` AS-IS → file may be created in a **Microsoft standard model** (e.g. `ApplicationSuite`) instead of your custom model!

**Example:**
```
Step 1: analyze_code_patterns("sales order helper class")
Step 2: generate_code(pattern="class", name="MySalesHelper")
Step 3: create_d365fo_file(objectType="class", objectName="MySalesHelper",
          modelName="any",       ← doesn't matter, auto-corrected from .rnrproj
          projectPath="K:\VSProjects\MySolution\MyProject\MyProject.rnrproj",
          addToProject=true)
```

**❌ Wrong — missing `projectPath`:**
```
create_d365fo_file(objectType="class", objectName="MySalesHelper",
  modelName="ApplicationSuite")   ← ❌ No projectPath → file lands in Microsoft's model!
```

**✅ Correct — `projectPath` provided:**
```
create_d365fo_file(objectType="class", objectName="MySalesHelper",
  modelName="whatever",           ← ignored, auto-corrected
  projectPath="K:\VSProjects\MySolution\MyProject\MyProject.rnrproj",
  addToProject=true)
→ Tool reads MyProject.rnrproj → extracts ModelName (e.g. "AslCore")
→ File created at K:\AosService\PackagesLocalDirectory\AslCore\AslCore\AxClass\MySalesHelper.xml ✅
→ Added to MyProject.rnrproj ✅
```

### Editing an Existing D365FO Object

⚠️ **CRITICAL: Use ONLY `modify_d365fo_file()` for editing D365FO XML files**

**Supported Operations:**
- `add-method` — Add new method to class/table
- `remove-method` — Delete method
- `add-field` — Add field to table
- `remove-field` — Delete field from table  
- `modify-property` — Change XML property value

**Example:**
```xpp
// Add a method to a class
modify_d365fo_file(
  objectType='class',
  objectName='MyClass',
  operation='add-method',
  methodName='calculateDiscount',
  methodCode='public real calculateDiscount(real amount) { return amount * 0.1; }'
)
```

### Creating a Chain of Command Extension

**Workflow:**
1. Call `get_class_info(className)` — understand the class structure
2. Call `get_method_signature(className, methodName)` — **REQUIRED: get exact signature**
3. Call `suggest_method_implementation(className, methodName)` — see real examples
4. Call `generate_code(pattern="class", name="YourExtensionClassName")` with extension pattern
5. **Call `create_d365fo_file()` only** — optionally use `generate_d365fo_xml()` + `create_d365fo_file()`

**Why get_method_signature is required:**
- Incorrect signatures cause compilation errors
- Parameter types, default values, and modifiers must match exactly
- Return type must be identical

**Example:**
```
Step 1: get_class_info("CustTable")
Step 2: get_method_signature("CustTable", "validateWrite")
     → Returns: "public boolean validateWrite(boolean _insertMode)"
Step 3: suggest_method_implementation("CustTable", "validateWrite")
Step 4: Create extension with exact signature from step 2
```

### Implementing or Completing a Method

**Recommended Workflow:**
1. `get_class_info(className)` — get full class with all methods
2. `get_method_signature(className, methodName)` — exact signature
3. Identify dependencies — call `get_class_info()` / `get_table_info()` for any referenced types
4. `analyze_code_patterns("method purpose")` — find real patterns from codebase
5. `suggest_method_implementation(className, methodName)` — see concrete examples
6. Generate implementation based on patterns and examples
7. `modify_d365fo_file()` or `create_d365fo_file()` to save changes

### Finding Information About Objects

**Quick Reference:**

| What You Need | Tool to Use |
|---------------|-------------|
| "Does a class named X exist?" | `search("X", type="class")` |
| "Show me all methods on class X" | `get_class_info("X")` |
| "What fields does table X have?" | `get_table_info("X")` |
| "What are the enum values for X?" | `get_enum_info("X")` |
| "What are the EDT properties for X?" | `get_edt_info("X")` |
| "Where is class/method X used?" | `find_references("X")` |
| "Find multiple objects at once" | `batch_search([{query: "CustTable"}, {query: "SalesTable"}])` |
| "Find only my custom code" | `search_extensions("MyPrefix")` |
| "What datasources does form X have?" | `get_form_info("X")` |
| "What is the structure of data entity X?" | `get_view_info("X")` |
| "How is API X typically used?" | `get_api_usage_patterns("X")` |
| "Find label for text X" | `search_labels("X")` |
| "Get all translations for label X" | `get_label_info("X")` |
| "What label files exist in model X?" | `get_label_info(model="X")` |

### Working with Labels (AxLabelFile)

**Workflow for using an existing label:**
```
Step 1: search_labels("your text", language="en-US")
     → Returns matching labels with @LabelFileId:LabelId syntax
Step 2: get_label_info("ACFeature", model="AslCore")
     → Verify all required languages are present
Step 3: Use @AslCore:ACFeature in X++ code or metadata XML
```

**Workflow for creating a new label:**
```
Step 1: search_labels("your text") — REQUIRED: check existing labels first!
Step 2: get_label_info(model="AslCore") — list available label files in model
Step 3: create_label(
          labelId="MyNewField",
          labelFileId="AslCore",
          model="AslCore",
          translations=[
            {language:"en-US", text:"My new field"},
            {language:"cs",    text:"Moje nové pole"},
            {language:"de",    text:"Mein neues Feld"},
            {language:"sk",    text:"Moje nové pole"}
          ],
          defaultComment="Description for developers"
        )
Step 4: Use @AslCore:MyNewField in code or XML
```

**Label reference syntax:**
- In X++ code: `literalStr("@AslCore:MyLabel")` or `"@AslCore:MyLabel"` in string fields
- In metadata XML: `<Label>@AslCore:MyLabel</Label>`
- In field properties: `<HelpText>@AslCore:MyLabelHelp</HelpText>`

## Best Practices

### 📁 File Paths and Model Name

AOT path structure on the local Windows VM:
```
K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxClass\{Name}.xml
K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxTable\{Name}.xml
K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxForm\{Name}.xml
K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxEnum\{Name}.xml
K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxQuery\{Name}.xml
K:\AosService\PackagesLocalDirectory\{Model}\{Model}\AxView\{Name}.xml
```

**ModelName is automatically extracted from the `.rnrproj` file** (`PropertyGroup/ModelName`)

| Situation | Result |
|-----------|--------|
| `projectPath` or `solutionPath` provided | ✅ Tool reads correct `ModelName` from `.rnrproj` |
| Neither provided, `modelName="ApplicationSuite"` | ❌ File created in Microsoft's standard model — WRONG! |
| Neither provided, `modelName="AslCore"` | ✅ Only if value happens to match actual model name |

**Rules:**
- ✅ **ALWAYS provide `projectPath` or `solutionPath`** when calling `create_d365fo_file`
- ❌ **NEVER ask the user for `modelName`** — pass any value, it will be auto-corrected from `.rnrproj`
- ❌ **NEVER manually extract `modelName` from workspace path** — workspace path ≠ AOT path
- ❌ **NEVER call `create_d365fo_file(modelName="ApplicationSuite", ...)`** without `projectPath`/`solutionPath`!
- `ApplicationSuite` is a **Microsoft standard model** — never add custom code there!

**`.mcp.json` configuration** (fallback when GitHub Copilot auto-detection is unavailable):
```json
{
  "servers": {
    "context": {
      "projectPath": "K:\\VSProjects\\MySolution\\MyProject\\MyProject.rnrproj",
      "solutionPath": "K:\\VSProjects\\MySolution",
      "packagePath": "K:\\AosService\\PackagesLocalDirectory"
    }
  }
}
```
⚠️ This file must be placed **in the MCP server directory** (next to `package.json`), NOT in the VS solution folder — the MCP server process reads it from its own working directory.

**XML formatting rules:**
- ✅ TABs for indentation (Microsoft D365FO standard — not spaces!)
- ❌ NEVER spaces — causes XML deserialization errors in Visual Studio
- ✅ CDATA for X++ source code: `<![CDATA[ ... ]]>`

### ✅ DO:
- Use MCP tools for ALL D365FO metadata operations
- Call `get_method_signature()` before creating CoC extensions
- Call `analyze_code_patterns()` before generating new code
- Use `batch_search()` when you need multiple objects
- Use `search_extensions()` to filter out Microsoft standard code
- Use `modify_d365fo_file()` with automatic backups for safe editing
- Be specific in search queries (include context like "sales", "ledger", "inventory")
- **Use `get_edt_info()` for Extended Data Types** — `get_enum_info()` is for enums only
- **Call `search_labels()` before `create_label()`** — always reuse existing labels when possible
- Provide translations for ALL languages the model supports when calling `create_label()`

### ❌ DON'T:
- Never use built-in file tools (`get_file`, `edit_file`, etc.) on .xml or .xpp files
- Never guess method signatures — always look them up
- Never use `replace_string_in_file` on D365FO XML — it corrupts metadata
- **Never create D365FO files with generic `create_file` — ONLY use `create_d365fo_file()`**
- **Never combine `generate_d365fo_xml()` + `create_file()` — use `generate_d365fo_xml()` + `create_d365fo_file()` instead**
- **Never call `create_d365fo_file()` without `projectPath` or `solutionPath`** — without them `modelName` is used AS-IS and the file may end up in a Microsoft standard model!
- **Never use `get_enum_info()` for EDT** — it only works for enums; use `get_edt_info()` for Extended Data Types
- Don't use vague search terms — be specific about what you're looking for
- Don't call `search()` after you already have the complete object from `get_class_info()`
- **Never edit .label.txt files with `edit_file` or `replace_string_in_file`** — use `create_label()` which maintains sort order and updates the index
- Never create a label without first calling `search_labels()` — duplicate labels waste translation effort

## Why MCP Tools Are Required

1. **Scale**: 584,799+ objects cannot be searched with standard tools
2. **Format**: D365FO metadata is complex XML not parseable by generic tools
3. **Location**: Objects are not in workspace — they're in external AOT/PackagesLocalDirectory
4. **Performance**: Pre-indexed database provides instant results
5. **Safety**: Built-in validation, backup, and rollback for modifications
6. **Context**: Tools understand X++ language semantics, inheritance, and D365FO patterns