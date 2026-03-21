# D365 Finance & Operations X++ Development

<!-- NOTE: This file is the GitHub Copilot static instruction layer. It mirrors the rules from the
     `xpp_system_instructions` MCP prompt (src/prompts/systemInstructions.ts) which the server exposes
     for AI clients that request it via `/prompts/get`. If you update rules here, sync them there too. -->

This workspace contains D365FO code. **Always use the specialized MCP tools** — backed by a pre-indexed symbol database with 584,799+ D365FO objects. Built-in file/search tools do not understand X++ syntax or AOT structure and will produce incorrect results on `.xml`/`.xpp` files.

---

> ## 🚨 POWERSHELL / TERMINAL — ABSOLUTE PROHIBITION
>
> **PowerShell AND any terminal command WILL HANG in this workspace and block the entire session.**
>
 > This is a hard constraint that applies in **every** IDE (VS Code, Visual Studio 2022, 2026, or any other version).
>
> **NEVER, under any circumstances:**
> - Open Developer PowerShell (Visual Studio integrated terminal, any version)
> - Run any `run_in_terminal` / shell command
> - Use PowerShell as a fallback when an MCP tool is unavailable or returns an error
> - Use PowerShell to "work around" a tool limitation or error message
> - Claim that a required parameter is "missing from the schema" and use that as justification for PowerShell — **re-read the schema first**. Parameters like `fieldGroupName`, `fieldName`, `methodName`, `propertyPath` etc. are ALL present. If you think one is missing, you are mistaken.
>
> **If an MCP tool is missing, unavailable, or returns an error — STOP.**
> Tell the user exactly which tool failed and why. Do NOT silently fall back to a terminal.
>
> The correct response to a missing or broken tool is always one of:
> 1. Use a different MCP tool that achieves the same goal
> 2. STOP and ask the user how to proceed
>
> There is NO scenario in this workspace where opening a terminal or running a PowerShell command is acceptable.

---

> ## 🔌 MANDATORY FIRST CHECK — MCP SERVER + WORKSPACE CONFIGURATION
>
> **Before doing ANYTHING in this workspace, call `get_workspace_info()` with no arguments.**
>
> Read the response carefully:
>
> **Case 1 — tool call FAILS (MCP server not connected):**
> - STOP immediately. Tell the user:
>   > ⚠️ **MCP server is not connected.** The d365fo-mcp-tools must be running for safe D365FO development.
>   > Without it I cannot read the symbol database, detect the correct model name, or safely create/modify files.
>   >
>   > Options:
>   > - **Option A (recommended):** Start the MCP server (VS Code MCP panel → restart, or `npm start` in the server repo), then retry.
>   > - **Option B:** Continue with built-in tools only — no symbol index, no model auto-detection, file operations may corrupt your project.
>   >
>   > Which option do you prefer?
> - **Wait for the user's answer** — do NOT proceed until explicitly told to.
>
> **Case 1b — tool returns "not available in read-only mode" (Azure deployment):**
> - The MCP server IS connected, but it is running in **Azure read-only mode** — `get_workspace_info` is a local tool and is not available.
> - In this mode you have full search/analysis capability but **no model name auto-detection**.
> - Tell the user:
>   > ℹ️ **Connected to the Azure (read-only) MCP server.** `get_workspace_info` is unavailable in this mode.
>   > To use `create_d365fo_file` or `modify_d365fo_file`, I need to know the model name.
>   >
>   > Please provide the model name in one of these ways:
>   > 1. Tell me the model name now (e.g. "the model is ContosoExtensions").
>   > 2. Or configure `modelName` in your local `.mcp.json` and restart the local write-only MCP server.
> - **Wait for the user to provide the model name** — do NOT guess it or infer it from search results.
>
> **Case 2 — response contains `⛔ CONFIGURATION PROBLEM`:**
> - STOP immediately. The model name is a placeholder (`MyModel`, `MyPackage`, etc.).
> - Tell the user the exact message from the tool response.
> - **Wait for the user's answer** — do NOT proceed until explicitly told to.
>
> **Case 3 — response contains `✅ Configuration looks valid`:**
> - Note the model name from the response (e.g. `ContosoExtensions`, `ApplicationSuite`).
> - Use that model name for ALL subsequent `create_d365fo_file` / `create_label` / `modify_d365fo_file` calls.
> - Proceed normally.
>
> **If you detect `MyModel`, `MyPackage`, or any placeholder mid-task** (e.g. in a tool response, or because you were about to pass it as a parameter) — STOP and notify the user before continuing.

> ##  MANDATORY RULE — EDITING D365FO FILES
>
> **After analysis, you MUST use `modify_d365fo_file()` to apply any changes.**
>
>  **NEVER** edit D365FO objects with built-in tools:
> - `replace_string_in_file` / `multi_replace_string_in_file` / `edit_file` / `apply_patch`
> - PowerShell / Developer PowerShell scripts (`Set-Content`, `Add-Content`, any shell-based file write)
> - `create_file` on an existing object
>
>  **ALWAYS** use:
> - `modify_d365fo_file()` — edit existing classes, tables, EDTs, forms, enums:
>   - Methods: `add-method`, `remove-method`, `replace-code` (surgical in-place code replacement)
>   - Fields: `add-field`, `modify-field`, `rename-field`, `replace-all-fields`, `remove-field` (table + table-extension)
>   - Indexes: `add-index`, `remove-index` (table + table-extension)
>   - Relations: `add-relation`, `remove-relation` (table + table-extension)
>   - Field groups: `add-field-group`, `remove-field-group`, `add-field-to-field-group` (table + table-extension)
>   - Table-extension: `add-field-modification` (override base-table field label/mandatory)
>   - Form-extension: `add-control`, `add-data-source`
>   - Any object: `modify-property`
> - `create_d365fo_file()` — create new objects
>
> **⛔ NEVER use `create_d365fo_file` with `overwrite=true` to add fields, field groups, indexes, or any incremental change to an existing object.**
> This is always wrong — it replaces the entire file and will silently drop all other existing content.
> The ONLY legitimate use of `overwrite=true` is when deliberately replacing the complete XML of an object (e.g. after a bulk field rewrite via `replace-all-fields`).
>
> Common triggers of this wrong reasoning — and the correct fix:
> ```
> "The file is too large/complex to overwrite"   → ❌ NEVER overwrite for incremental changes
>                                                  ✅ Use modify_d365fo_file with the correct operation
>
> "I need to add a field group"                  → ❌ NOT create_d365fo_file overwrite=true
>                                                  ✅ modify_d365fo_file operation="add-field-group"
>
> "I'll read the file with PowerShell first"     → ❌ PowerShell is FORBIDDEN
>                                                  ✅ get_table_info() to read, modify_d365fo_file() to write
>
> "The parameter fieldGroupName seems missing"   → ❌ Do NOT fall back to PowerShell or overwrite
>                                                  ✅ Re-read the schema — fieldGroupName IS present
> ```
>
> **⛔ NEVER enter the "escalating workarounds" spiral. Stop at step 1:**
> When a modify/add operation is needed on an existing D365FO object, the ONE correct action is:
> `modify_d365fo_file(operation="add-field-group" | "add-field" | "add-method" | …)`
>
> If you find yourself thinking any of the following, you are wrong — STOP and call `modify_d365fo_file` instead:
> ```
> WRONG SPIRAL (each step is MORE wrong than the last):
>
>  Step 1 (wrong):  "I'll use replace_string_in_file to patch the XML"
>  Step 2 (worse):  "replace failed / file length decreased — I'll try a different approach"
>  Step 3 (worse):  "I'll read the file with PowerShell first, then overwrite"
>  Step 4 (worse):  "Terminal returns no output — I'll add Write-Output explicitly"
>  Step 5 (worst):  "I'll use create_d365fo_file with overwrite=true"
>
> CORRECT (always, immediately, at step 0):
>   modify_d365fo_file(objectType="table", objectName="MyTable",
>     operation="add-field-group",
>     fieldGroupName="MyGroup",
>     fields=["Field1", "Field2"])
> ```
> The existence of a workaround does NOT make it acceptable. Every step of the spiral above is forbidden.
> If `modify_d365fo_file` itself returns an error, STOP and report it to the user — do NOT try PowerShell.
>
> **modify-property covers ALL table/EDT/class-level properties — NEVER use PowerShell for these:**
> ```
> TableGroup     → modify-property  propertyPath="TableGroup"    propertyValue="Group"
> TitleField1/2  → modify-property  propertyPath="TitleField1"   propertyValue="ItemId"
> TableType      → modify-property  propertyPath="TableType"     propertyValue="TempDB"
> CacheLookup    → modify-property  propertyPath="CacheLookup"   propertyValue="Found"
> SaveDataPerCo  → modify-property  propertyPath="SaveDataPerCompany" propertyValue="No"
> EDT Extends    → modify-property  objectType="edt"  propertyPath="Extends" propertyValue="WHSZoneId"
> Class Extends  → modify-property  objectType="class" propertyPath="Extends" propertyValue="BaseClass"
> Label/HelpText → modify-property  propertyPath="Label" propertyValue="@MyModel:MyLabel"
> ```
>
> **⚠️ TableGroup vs TableType — CRITICAL DISTINCTION:**
> ```
> TableGroup  = business role of the table (system enum TableGroup, source: MSDN).
>   Valid values and meanings:
>     Miscellaneous   — DEFAULT for new tables; does not fit any other category (e.g. TableExpImpDef)
>     Main            — principal master table for a central business object, static base data
>                       (e.g. CustTable, VendTable)
>     Transaction     — transaction/journal data, typically not edited directly
>                       (e.g. CustTrans, VendTrans)
>     Parameter       — setup/parameter data for a Main table, usually 1 record per company
>                       (e.g. CustParameters, VendParameters)
>     Group           — categorisation for a Main table, one-to-many: Group → Main
>                       (e.g. CustGroup, VendGroup)
>     WorksheetHeader — worksheet header that categorises WorksheetLine rows
>                       one-to-many: WorksheetHeader → WorksheetLine (e.g. SalesTable)
>     WorksheetLine   — lines to be validated and turned into transactions;
>                       may be deleted without affecting system stability (e.g. SalesLine)
>     Reference       — shared reference/lookup data across modules
>     Framework       — internal Microsoft framework/infrastructure tables
>   ⛔ NEVER use "TempDB" or "InMemory" as a TableGroup value — those are TableType values!
>
> TableType   = storage type of the table (source: MSDN).
>   Valid values: RegularTable (default, omit from XML) | TempDB | InMemory
>     RegularTable — DEFAULT. Permanent table stored in the main database. Omit from XML entirely.
>     TempDB       — Temporary table in SQL Server TempDB. Dropped when no longer used by the current
>                    method. Joins and set operations are EFFICIENT. Use for SSRS report tmp tables
>                    and session-scoped data.
>     InMemory     — Temporary ISAM file on the AOS/client tier. SQL Server has no connection to it.
>                    Joins and set operations are usually INEFFICIENT. Equivalent to the old
>                    "Temporary" property from AX 2009.
>
> For a new TempDB table:
>   generate_smart_table(tableType="TempDB", tableGroup="Main", ...)   ← CORRECT
>   generate_smart_table(tableGroup="TempDB", ...)                     ← ❌ WRONG
> ```
>
> **Table-extension properties (objectType="table-extension") — stored in `<PropertyModifications>`, NEVER use PowerShell:**
> ```
> Label             → modify-property  objectType="table-extension"  propertyPath="Label"             propertyValue="@MyModel:MyLabel"
> HelpText          → modify-property  objectType="table-extension"  propertyPath="HelpText"           propertyValue="@MyModel:MyHelpText"
> TableGroup        → modify-property  objectType="table-extension"  propertyPath="TableGroup"         propertyValue="Group"
> CacheLookup       → modify-property  objectType="table-extension"  propertyPath="CacheLookup"        propertyValue="Found"
> TitleField1/2     → modify-property  objectType="table-extension"  propertyPath="TitleField1"        propertyValue="ItemId"
> ClusteredIndex    → modify-property  objectType="table-extension"  propertyPath="ClusteredIndex"     propertyValue="MyIdx"
> PrimaryIndex      → modify-property  objectType="table-extension"  propertyPath="PrimaryIndex"       propertyValue="MyIdx"
> SaveDataPerCompany→ modify-property  objectType="table-extension"  propertyPath="SaveDataPerCompany" propertyValue="No"
> TableType         → modify-property  objectType="table-extension"  propertyPath="TableType"          propertyValue="TempDB"
> SystemTable       → modify-property  objectType="table-extension"  propertyPath="SystemTable"        propertyValue="Yes"
> ModifiedDateTime  → modify-property  objectType="table-extension"  propertyPath="ModifiedDateTime"   propertyValue="Yes"
> CreatedDateTime   → modify-property  objectType="table-extension"  propertyPath="CreatedDateTime"    propertyValue="Yes"
> ModifiedBy        → modify-property  objectType="table-extension"  propertyPath="ModifiedBy"         propertyValue="Yes"
> CreatedBy         → modify-property  objectType="table-extension"  propertyPath="CreatedBy"          propertyValue="Yes"
> CountryRegionCode → modify-property  objectType="table-extension"  propertyPath="CountryRegionCodes" propertyValue="CZ,SK"
> ```
>
> **Field rename / bulk field rewrite — NEVER use PowerShell for these:**
> ```
> Rename one field   → rename-field        fieldName="OldName"  fieldNewName="NewName"
>                      (also fixes index DataField refs and TitleField1/2 automatically)
>                      repair-only mode: if field was already renamed (e.g. by replace-all-fields),
>                      pass the OLD corrupted name → only index refs are fixed, Fields block untouched
>
> Rewrite ALL fields → replace-all-fields  fields=[{name,edt?,type?,mandatory?,label?}, ...]
>                      (use when field names contain spaces or are otherwise corrupted)
>
> Overwrite whole    → create_d365fo_file  xmlContent="<full XML>"  overwrite=true
> object XML           (use when the entire XML needs replacing)
> ```
>
> **Pattern:**
> ```
> 1. get_class_info("MyClass")                       analyze (compact=true by default)
> 2. get_method_source(class, method)               to read the full body
>    get_method_signature(class, method)            only if you need exact signature for CoC
> 3. modify_d365fo_file(..., dryRun=true)            preview — shows unified diff, NO write
>    (show the diff to the user and ask for confirmation if the change is non-trivial)
> 4. modify_d365fo_file(...)                         apply (omit dryRun, or set dryRun=false)
>    NOT: replace_string_in_file                       FORBIDDEN
>    NOT: PowerShell / Developer PowerShell script     FORBIDDEN
> ```
>
> **`dryRun` usage rules:**
> - Pass `dryRun=true` when the change affects multiple lines or a public API — always show the preview first.
> - For trivial single-line changes (e.g. modify-property with a known value) `dryRun` is optional.
> - Copilot must **never** apply the change automatically after a dry-run — wait for user confirmation.

> ## ⚡ TOKEN BUDGET — READ BEFORE EVERY CALL
>
> - `get_class_info` returns **signatures only** by default (`compact=true`) — do NOT pass `compact=false` unless you need to read a body
> - **NEVER call `get_class_info` more than 2× per turn** — use `get_method_source(class, method)` for individual method bodies (full source); use `get_method_signature(class, method)` only when you need the exact signature for CoC
> - `search_extensions` can return large results — use at most once per turn

---

## START HERE

For any D365FO request, **start with MCP tools — never** `code_search`, `grep_search`, `semantic_search`, `get_file`, `read_file` on .xml/.xpp.

| Request | MCP Tools |
|---------|-----------|
| Fix bug / review | `get_class_info` → `suggest_method_implementation` → `find_references` |
| Refactor / improve | See **Refactoring Workflow** section below |
| Find best practice | `analyze_code_patterns` → `get_api_usage_patterns` |
| Optimize query | `get_table_info` → `analyze_code_patterns` |
| Where is X used? | `find_references(targetName)` |
| How does X work? | `get_class_info` / `get_table_info` / `get_form_info` / `get_report_info` |
| How to implement X? (pattern) | `get_xpp_knowledge("batch job")` → `analyze_code_patterns` |
| What can I extend on X? | `analyze_extension_points(objectName)` |
| Who already extends method X via CoC? | `find_coc_extensions(className, methodName)` |
| Who handles events for table X? | `find_event_handlers(targetTable)` |
| What fields/methods did extensions add to table X? | `get_table_extension_info(tableName)` |
| What security covers form/table/menu item X? | `get_security_coverage_for_object(objectName)` |
| What does privilege/duty/role X contain? | `get_security_artifact_info(name)` |
| What does menu item X open? Security chain? | `get_menu_item_info(name)` |
| Create SSRS report | `generate_smart_report` or `generate_code(pattern="ssrs-report-full")` → See **SSRS Report Workflow** section below |
| Create CoC extension | See **CoC / Extension Workflows** section below |
| Create workspace form | `generate_smart_form(name, formPattern="Workspace")` |
| Diagnose X++ error | `get_d365fo_error_help(errorText, errorCode?)` |
| What is the exact tab/group/control name in form X? | `get_form_info(formName, searchControl="General")` |
## Critical Rules

### Forbidden built-in tools on D365FO files

|  Built-in |  MCP Tool |
|-------------|------------|
| `code_search`, `file_search`, `grep_search` | `search()`, `batch_search()` |
| `get_file`, `read_file` on .xml/.xpp | `get_class_info()`, `get_table_info()`, `get_form_info()`, `get_report_info()` |
| `edit_file`, `apply_patch`, `replace_string_in_file` | `modify_d365fo_file()` |
| `create_file` for D365FO objects | `create_d365fo_file()` |
  | PowerShell / Developer PowerShell `run_in_terminal` or scripts to edit files | **FORBIDDEN. ALWAYS USE MCP TOOLS INSTEAD! PowerShell hangs in this workspace.** |
| PowerShell / Developer PowerShell `ls`, `Test-Path`, `Get-Item` to check D365FO files | `verify_d365fo_project()` |
| PowerShell / Developer PowerShell `Get-Content` / `Select-String` to find tab/control names in form XML | `get_form_info(formName, searchControl="General")` |
| PowerShell / Developer PowerShell / `run_in_terminal` to run BP check (xppbp.exe) | `run_bp_check()` — auto-detects model and packagePath from .mcp.json |
| PowerShell / Developer PowerShell / `run_in_terminal` to compile/build the project | `build_d365fo_project()` — auto-detects projectPath from .mcp.json |
| PowerShell / Developer PowerShell / `run_in_terminal` to run DB sync (SyncEngine.exe) | `trigger_db_sync()` |
| PowerShell / Developer PowerShell / `run_in_terminal` to run unit tests | `run_systest_class()` |

> ### ⚠️ SDLC Tools — NEVER fall back to PowerShell / Developer PowerShell or review_workspace_changes
>
> `run_bp_check`, `build_d365fo_project`, `trigger_db_sync`, and `run_systest_class` call the real D365FO CLI binaries (xppbp.exe, MSBuild, SyncEngine.exe).
> - All parameters are **optional** — model name and packagePath are auto-detected from `.mcp.json`.
> - If `run_bp_check` returns an error about a missing binary, it means `packagePath` in `.mcp.json` is wrong — fix the config, do NOT switch to PowerShell / Developer PowerShell or `review_workspace_changes`.
> - `review_workspace_changes` is for **git diff code review only** — NOT a substitute for BP check, and NOT for verifying that `modify_d365fo_file` succeeded.
> - After `modify_d365fo_file` or `create_d365fo_file`, always call `update_symbol_index(filePath)` first, then `get_class_info` or `get_method_source` to confirm the change landed. Never use `review_workspace_changes` as a verification step.

> ### ⚠️ CRITICAL — `get_form_info` WORKS for ALL D365FO forms
>
> `get_form_info` can read BOTH standard Microsoft forms (CustTable, SalesTable, …) **and** custom model forms.
>
> **NEVER say or assume "form metadata is not available through MCP".**
>
> If `get_form_info` returns a ⚠️ warning saying the file could not be read from disk, the response
> already contains a ready-to-use retry command with `filePath=` filled in. Copy it and retry — DO NOT fall back to PowerShell.
>
> ```
> ✅ CORRECT:  get_form_info(formName="CustTable", searchControl="General")
> ✅ RETRY:    get_form_info(formName="CustTable", filePath="K:\\AOSService\\...\\AxForm\\CustTable.xml", searchControl="General")
> ❌ FORBIDDEN: PowerShell Get-Content / read_file on form XML
> ```

### Non-Negotiable Rules

0. **ALWAYS** call `get_workspace_info()` at the start of every session (see **MANDATORY FIRST CHECK** above). If it fails OR returns `⛔ CONFIGURATION PROBLEM` — **STOP and inform the user** before proceeding. If it returns a "not available in read-only mode" error, follow **Case 1b** and ask the user for the model name explicitly. Never infer the model name from label file names or search results.
1. **NEVER** use built-in file/edit tools on D365FO .xml or .xpp files
2. **NEVER** guess method signatures — call `get_method_signature(className, methodName)` before CoC extensions
3. **NEVER** use `create_file` for D365FO objects — use `create_d365fo_file()`
4. **NEVER** call `create_d365fo_file` without `projectPath` or `solutionPath` — model auto-detected from `.rnrproj`; without it file may land in Microsoft standard model!
5. **NEVER** edit `.label.txt` files directly — use `create_label()`; always run `search_labels()` first
6. **ALWAYS** pass `fieldsHint` when user describes table fields — without it table will be INCOMPLETE
7. **ALWAYS** pass `primaryKeyFields` for composite PKs (2+ fields)
8. **ALWAYS** pass `methods=["find","exist"]` to `generate_smart_table()` when user requests those methods — never add them via `modify_d365fo_file` afterwards
9. **NEVER** include model prefix in `name` param of `generate_smart_table`/`generate_smart_form` — prefix is applied automatically (causes double-prefix)
10. **NEVER** use `get_enum_info()` for EDTs — use `get_edt_info()` instead
11. **NEVER** infer the target model from search results or object names — the `model` field in search/get_table_info results is the SOURCE model of that existing object, NOT where you should create new objects. The target model for ALL create/modify operations is ALWAYS from `.mcp.json` (projectPath/modelName). Example of WRONG reasoning: task involves a report → search returns objects from "ContosoReports" → ❌ DO NOT use "ContosoReports". Use the configured model.
12. **NEVER** create AxReport XML with `create_file` or PowerShell — ALWAYS use `create_d365fo_file(objectType="report", xmlContent=<full XML>, addToProject=true)`. SSRS reports require UTF-8 BOM and correct AOT path which only `create_d365fo_file` guarantees.
13. **NEVER** use `objectType="security-privilege"` for duties or roles — each security type maps to a DIFFERENT AOT folder:
    - `security-privilege` → `AxSecurityPrivilege`
    - `security-duty`      → `AxSecurityDuty`      ← using privilege here = WRONG FOLDER
    - `security-role`      → `AxSecurityRole`
    All three are supported by `create_d365fo_file`. Never use PowerShell to move a file to the correct folder.
14. **ALWAYS** put class member variable declarations **inside** the class `{ }` body in `sourceCode` — they become `<Declaration>` in the AxClass XML. Variables placed **outside** the `{}` are NOT part of the declaration and will be lost.
15. **NEVER** use `today()` — it is deprecated (BPUpgradeCodeToday). Use `DateTimeUtil::getToday(DateTimeUtil::getUserPreferredTimeZone())` instead, everywhere: default parameter values, date comparisons, queries.
    **NEVER call any function directly in a WHERE condition of a select statement** — assign the result to a local variable first, then use that variable in WHERE. Example:
    ```xpp
    // ❌ WRONG
    while select table where table.Date == DateTimeUtil::getToday(...)
    // ✅ CORRECT
    date today = DateTimeUtil::getToday(DateTimeUtil::getUserPreferredTimeZone());
    while select table where table.Date == today
    ```
16. **NEVER** use hardcoded text strings in `Info()`, `warning()`, `error()`, dialog captions, or field labels — always use label references `@ModelName:LabelId`. Call `search_labels()` first, then `create_label()` if needed. (BPErrorLabelIsText)
17. **NEVER** nest `while select` inside another `while select` — use `join` in a single select, or pre-load into `Map`/temp table. Nested data-access loops trigger BPCheckNestedLoopinCode.
18. **ALWAYS** call `create_label()` for every new label ID before referencing it in code — uncreated labels cause BPErrorUnknownLabel at build time.
19. **ALWAYS** write meaningful `/// <summary>` doc comments on every public/protected class and method — the text must describe what the code does, not just echo the name. `/// MyClass class.` or `/// run.` is NEVER acceptable (BPXmlDocNoDocumentationComments).
20. **NEVER** pass `tableGroup="TempDB"` or `tableGroup="InMemory"` to `generate_smart_table` — `TempDB`/`InMemory` are **TableType** values, not **TableGroup** values. For a TempDB table use `tableType="TempDB"` and keep `tableGroup="Main"` (or another valid group). Valid `TableGroup` values (system enum TableGroup, source: MSDN): `Miscellaneous` (default for new tables) | `Main` | `Transaction` | `Parameter` | `Group` | `WorksheetHeader` | `WorksheetLine` | `Reference` | `Framework`.
21. **NEVER** use PowerShell / `run_in_terminal` to run BP checks, builds, or DB sync — ALWAYS use `run_bp_check()`, `build_d365fo_project()`, `trigger_db_sync()`, `run_systest_class()`. All parameters (model, packagePath, projectPath) are **optional** and auto-detected from `.mcp.json`. If one of these tools returns an error about a missing binary or path, inform the user to fix `.mcp.json` — do NOT fall back to PowerShell. Do NOT use `review_workspace_changes` as a substitute for `run_bp_check` — they serve different purposes.
22. **ALWAYS** call `get_d365fo_error_help(errorText, errorCode?)` when the user pastes a D365FO compiler or runtime error. Do NOT guess the fix — X++ error semantics often differ from C# and the tool provides verified step-by-step fixes.
23. **When creating a CoC class extension file** use `create_d365fo_file(objectType="class-extension", objectName="{TargetClass}{Prefix}_Extension", ...)` — this generates the correct `[ExtensionOf(classStr(...))]` + `final class` skeleton in the AxClass XML.
24. **Available `generate_code` patterns** include: `batch-job`, `sysoperation`, `table-extension`, `class-extension`, `event-handler`, `security-privilege`, `menu-item`, `data-entity`, `ssrs-report-full` (generates DataContract + DP + Controller), `lookup-form` (SysTableLookup static method), `form-handler` (`[ExtensionOf(formStr(...))]` — pass `name`=FormName), `form-datasource-extension` (`[ExtensionOf(formDataSourceStr(Form, DS))]` — pass `name`=FormName + `baseName`=DataSourceName), `form-control-extension` (`[ExtensionOf(formControlStr(Form, Control))]` — pass `name`=FormName + `baseName`=ControlName; use `get_form_info` to find the exact control name first), `map-extension` (`[ExtensionOf(mapStr(...))]`), `dialog-box`, `dimension-controller`, `number-seq-handler`, `display-menu-controller`, `data-entity-staging`, `service-class-ais`.
25. **Available `generate_smart_form` patterns** include: `SimpleList`, `SimpleListDetails`, `DetailsMaster`, `DetailsTransaction`, `Dialog`, `TableOfContents`, `Lookup`, `ListPage`, `Workspace` (operational workspace with panorama sections and KPI tile area).
26. **NEVER** call a method or API marked with `[SysObsolete]` (or `[Obsolete]` in C# interop). The attribute message almost always names the replacement — read it and use that replacement instead. If you encounter an obsolete symbol while reading existing code with `get_method_source` or in `analyze_code_patterns` output, verify the replacement before generating any call to it. Common examples:
    - `today()` → `DateTimeUtil::getToday(DateTimeUtil::getUserPreferredTimeZone())`
    - `SysQuery::findOrCreateRange()` → `SysQuery::findOrCreateRange()` still valid but many helpers around it changed — check the attribute
    - When `get_method_source` or `search` returns a method body containing `[SysObsolete(...)]` on it, do NOT generate calls to that method. Use the replacement stated in the attribute string.

### AxClass sourceCode Format — Member Variables in Declaration

D365FO AxClass XML separates a class into two blocks:
- **`<Declaration>`** — class header + ALL member variable declarations (inside the outer `{ }`)
- **`<Methods>`** — one `<Method>` entry per method defined **after** the class `{ }` closing brace

When passing `sourceCode` to `create_d365fo_file` or `generate_d365fo_xml` for a class, use this exact layout:

```xpp
// ✅ CORRECT — variables inside class {}
[DataContractAttribute]
public class MyClass extends MyBase
{
    int globalPackageNumber;
    Qty totalExportedOrderUnitQty, totalExportedInventUnitQty;
}

public int globalPackageNumber(int _v = globalPackageNumber)
{
    globalPackageNumber = _v;
    return globalPackageNumber;
}
```

Common mistakes that break the resulting AxClass XML:
```xpp
// ❌ WRONG — variables after class {}, will be lost from <Declaration>
public class MyClass
{
}
int globalPackageNumber;          // ← gets dropped!
public void myMethod() { ... }
```

```xpp
// ❌ WRONG — no class {} at all, everything treated as one method
public class MyClass
public void myMethod() { ... }
```

### generate_smart_table / generate_smart_form — TWO success cases

**Case A — Azure/Linux** (response contains `ℹ MCP server is running on Azure/Linux`):
- Tool returned XML → call `create_d365fo_file(xmlContent="<XML>", addToProject=true)` immediately → STOP
- ❌ NEVER use `create_file`, PowerShell, or `modify_d365fo_file` instead

**Case B — Windows direct-write** (response contains `✅ DO NOT call create_d365fo_file`):
- File already written to disk → STOP, tell user to reload VS project
- ❌ NEVER call `create_d365fo_file` again

### ⚠️ NEVER bypass create_d365fo_file to "work around" prefix handling

The `create_d365fo_file` tool derives the object name prefix from the `modelName` parameter — it is NOT hardcoded to any value (not "Contoso", not anything else). If modelName is "ContosoExt", the prefix is "ContosoExt".
- Pass the base name WITHOUT prefix: `objectName="InventoryByZones"`, `modelName="ContosoExt"` → tool creates `ContosoExtInventoryByZones`
- Double-prefix is prevented automatically: `objectName="ContosoExtInventoryByZones"` + `modelName="ContosoExt"` → tool detects prefix already present → uses name as-is
- ❌ NEVER write XML files directly with `create_file` or PowerShell because you think the prefix logic is wrong
- ❌ NEVER edit .rnrproj manually — `create_d365fo_file` with `addToProject=true` handles it

---

## Refactoring Workflow

When the user asks to **refactor**, **improve**, **clean up**, **optimize**, or **review** an existing class or method — NEVER use `read_file`, `get_file`, `code_search`, or `edit_file`. Use only MCP tools.

```
1. Read class structure:   get_class_info("ClassName")
                           → returns all method signatures, inheritance, model
                           → compact=true (default) — signatures only, fast
                           → compact=false — only if you need to read bodies

2. Find completeness gaps: analyze_class_completeness("ClassName")
                           → reports missing standard methods (find, exist, etc.)
                           → flags methods that should be static, etc.

3. Find real patterns:     analyze_code_patterns("scenario")
                           → e.g. "validation", "query pattern", "error handling"
                           → shows how standard D365FO code solves the same problem

4. Read specific bodies:   get_method_source("ClassName", "methodName")
                           → use for EACH method you intend to change
                           → returns the FULL source code (not just the signature)
                           → NEVER guess the body from the signature
                           → ⚠️ ONLY call for methods you already saw listed in step 1.
                              NEVER infer names from D365FO conventions (parm*, find, exist, …)
                              — the method may not exist on this class.

5. Find usages:            find_references("ClassName")  or  find_references("methodName")
                           → verify that renaming/changing a method won't break callers
                           → call BEFORE removing or renaming anything

6. Apply changes:          modify_d365fo_file(objectType="class", objectName="ClassName",
                             operation="add-method" / "remove-method" / "replace-code", sourceCode="...")

   **Preview first (dry-run):**
   ```
   modify_d365fo_file(objectType="class", objectName="MyClass",
     operation="replace-code", ..., dryRun=true)
   ```
   → Returns a unified diff showing exactly what will change — file is NOT written.
   → Show the diff to the user and ask for confirmation before applying.
   → Call again WITHOUT dryRun (or dryRun=false) to apply.

   Replace one code snippet inside a method (surgical, preserves surrounding code):
   ```
   modify_d365fo_file(objectType="class", objectName="MyClass",
     operation="replace-code",
     methodName="run",        ← optional: scope to one method
     oldCode="return false;",
     newCode="return true;")
   ```
   – If `methodName` is omitted the tool searches ALL Source/Declaration blocks in order.
   – Works for classDeclaration too: pass `methodName="classDeclaration"`.
   – ❌ NEVER use `replace_string_in_file` on .xml/.xpp — use `replace-code` instead.
                           ❌ NEVER use edit_file, apply_patch, replace_string_in_file
```

**Rules for refactoring:**
- ALWAYS read the full class first with `get_class_info` — never assume you know the current structure
- ALWAYS call `get_method_signature` for every method you plan to change — don't edit blindly
- ALWAYS call `find_references` before renaming a public method — it may be called from other classes/forms
- NEVER delete a method without checking `find_references` first
- Labels: if you rename or add `Info()`/`warning()`/`error()` messages, use `search_labels()` + `create_label()`
- Doc comments: every changed public/protected method MUST have a meaningful `/// <summary>`

---

## CoC / Extension Workflows

### Chain of Command (CoC) extension

```
1. Discover extension points:  analyze_extension_points("TargetClass")
                               → shows CoC-eligible methods, delegates, data events

2. Read exact method + template: get_method_signature("TargetClass", "targetMethod",
                                   includeCocTemplate: true)
                                 → returns method body AND a ready-to-use CoC skeleton

3. Create extension class:     create_d365fo_file(objectType="class",
                                 objectName="TargetClass_Extension", ...)

4. Add CoC method:             modify_d365fo_file(objectType="class",
                                 objectName="TargetClass_Extension",
                                 operation="add-method", sourceCode="<CoC skeleton>")
```

### Table extension

```
1. Check existing extensions:  get_table_extension_info("TargetTable")
                               → shows already-added fields, indexes, methods from all models

2. Check extension points:     analyze_extension_points("TargetTable")
                               → shows data events available for subscription

3. Generate boilerplate:       generate_code("table-extension", "TargetTable_Extension",
                                 "TargetTable")

4. Create extension file:      create_d365fo_file(objectType="table-extension",
                                 objectName="TargetTable.PrefixExtension", addToProject=true)

5. Add fields/methods/etc:     modify_d365fo_file(objectType="table-extension",
                                 objectName="TargetTable.PrefixExtension",
                                 operation="add-field" / "add-method" /
                                           "add-index" / "add-relation" /
                                           "add-field-group" / "add-field-to-field-group" /
                                           "add-field-modification", ...)
```

### Form extension

```
1. Find exact control names:   get_form_info("TargetForm", searchControl="General")
                               → returns matching controls with full hierarchy path and parent names
                               ❌ NEVER use PowerShell Get-Content or grep on form XML

2. Create extension file:      create_d365fo_file(objectType="form-extension",
                                 objectName="TargetForm.MyExtension", addToProject=true)
                               → creates the AxFormExtension XML (empty — controls/overrides added next)

3. Add field control to tab:   modify_d365fo_file(objectType="form-extension",
                                 objectName="TargetForm.MyExtension",
                                 operation="add-control",
                                 controlName="MyCustPriorityTier",
                                 parentControl="TabGeneral",
                                 controlDataSource="CustTable",
                                 controlDataField="MyCustPriorityTier",
                                 controlType="String")
                               ❌ NEVER use PowerShell to edit form extension XML to add controls

   Optional positioning:        positionType="AfterItem", previousSibling="ExistingControlName"
   Control types:               String (default), Integer, Real, CheckBox (NoYes/bool),
                                ComboBox (enum), Date, DateTime, Int64, Group, Button

4. Add display/override method: modify_d365fo_file(objectType="form-extension",
                                 objectName="TargetForm.MyExtension",
                                 operation="add-method", sourceCode="...")
```

**Form extension class (CoC for form methods):**
```
4. Create extension class:     create_d365fo_file(objectType="class",
                                 objectName="TargetForm_Extension", ...)

5. Add form method CoC:        get_method_signature("FormRun subclass OR form", "methodName",
                                 includeCocTemplate: true)
                               → use returned CoC skeleton

6. Apply:                      modify_d365fo_file(objectType="class",
                                 objectName="TargetFormMy_Extension",
                                 operation="add-method", sourceCode="<CoC skeleton>")
```

**Key rules for form extensions:**
- The form extension XML file (`TargetForm.MyExtension`) holds metadata modifications (tab/control moves, visibility overrides, new controls)
- The form extension CLASS (`TargetFormMy_Extension`) holds logic CoC (`[ExtensionOf(formStr(TargetForm))]`)
- ALWAYS look up the exact control name with `get_form_info(searchControl="...")` BEFORE writing the extension
- ❌ NEVER modify the original form — ALWAYS create/modify the extension file

### Event handler (DataEventHandler / SubscribesTo)

```
1. Check existing handlers:    find_event_handlers("TargetTable")
                               → shows all event handlers across models

2. Check available events:     analyze_extension_points("TargetTable")
                               → shows data events and custom delegates

3. Create handler class:       create_d365fo_file(objectType="class",
                                 objectName="TargetTableEventHandler", ...)

4a. Standard data events:      modify_d365fo_file(operation="add-method",
      (onInserted, etc.)         sourceCode="[DataEventHandler(tableStr(TargetTable),
                                   DataEventType::Inserted)]
                                 public static void onInserted_handler(
                                   Common _sender, DataEventArgs _e) { ... }")

4b. Custom delegates:          modify_d365fo_file(operation="add-method",
                                 sourceCode="[SubscribesTo(tableStr(TargetTable),
                                   delegateStr(TargetTable, myCustomDelegate))]
                                 public static void myCustomDelegate_handler(...) { ... }")
```

**Rule:** Standard table events (onInserted, onUpdated, onDeleted, onValidatedWrite, etc.)
use `[DataEventHandler]` — NOT `[SubscribesTo + delegateStr]`. The `delegateStr` form
is only for **custom delegates** defined with the `delegate` keyword.

---

## SSRS Report Workflow (report / sestava / výkaz)

### ✅ PREFERRED: One-shot generation with `generate_smart_report`

Generates all 5 D365FO objects (TmpTable, Contract, DP, Controller, Report) in a single call:

```
generate_smart_report(
  name="InventByZones",
  fieldsHint="ItemId, ItemName, Qty, Zone",
  caption="Inventory by Zones",
  contractParams=[{name:"FromDate", type:"TransDate"}, {name:"ToDate", type:"TransDate"}]
)
```

**Rules for `generate_smart_report`:**
- ⛔ NEVER pass model prefix in `name` — prefix applied automatically
- ⛔ NEVER call without `fieldsHint`, `fields`, or `copyFrom` — no fields = ❌ error returned
- ✅ On Azure/Linux: tool returns XML blocks → call `create_d365fo_file` for each object in order
- ✅ On Windows (VM): tool writes all files directly → DO NOT call `create_d365fo_file`
- ✅ Use `copyFrom="ExistingReport"` to copy field structure from an existing report's TmpTable

### Manual approach (when fine-grained control is needed)

An SSRS report in D365FO consists of **5 objects** — create them in this order:

```
1. TmpTable     objectType="table"   TableType=TempDB   (holds report rows)
2. Contract     objectType="class"   data contract with parms (dialog fields)
3. DP class     objectType="class"   extends SrsReportDataProviderBase, fills TmpTable
4. Controller   objectType="class"   extends SrsReportRunController (optional, for menu item)
5. Report       objectType="report"  AxReport XML with DataSet + Design (RDL)
```

**Step-by-step for the AxReport file (manual):**
```
a) Study existing similar report:    get_report_info("InventValue")   ← ALWAYS use this, NEVER PowerShell Get-Content
b) Generate skeleton:                generate_d365fo_xml(objectType="report", objectName="MyReport",
                                       properties={ dpClassName, tmpTableName, datasetName,
                                                    caption, style, fields[], rdlContent })
c) Save to disk:                     create_d365fo_file(objectType="report", objectName="MyReport",
                                       xmlContent=<full XML>, addToProject=true)
```

**Key rules for reports:**
- `DataSourceType` must be `ReportDataProvider`
- `Query` field format: `SELECT * FROM {DPClassName}.{TmpTableName}`
- RDL design goes inside `<Designs><AxReportDesign><Text>…</Text></AxReportDesign></Designs>`
- ❌ NEVER use `create_file` for the .xml — it breaks AOT (wrong encoding, no project entry)
- ❌ NEVER use PowerShell `Get-Content` to read report XML — use `get_report_info()` instead
- ✅ Pass full assembled XML via `xmlContent` parameter of `create_d365fo_file`

---

## Available MCP Tools

### Workspace Configuration
| Tool | Use for |
|------|------|
| `get_workspace_info()` | **ALWAYS call first.** Returns model name, package path, project path, **EXTENSION_PREFIX** value, and effective object prefix. Flags placeholder names, warns if EXTENSION_PREFIX is missing, and shows auto-detected real model from `.rnrproj`. |

### Search & Discovery
| Tool | Use for |
|------|---------|
| `search(query, type?)` | Find any D365FO symbol (class, table, method, field, enum, edt, form, query, report) |
| `batch_search(queries[])` | Multiple searches in parallel |
| `search_extensions(query)` | Custom/ISV code only |
| `get_class_info(className, compact?, methodOffset?)` | Class signatures (`compact=true` default, 15/page). Set `compact=false` + `methodOffset` only to read bodies |
| `get_table_info(tableName)` | Fields, indexes, relations, methods |
| `get_enum_info(enumName)` | Enum values (NOT for EDTs) |
| `get_edt_info(edtName)` | EDT definition, base type, constraints |
| `code_completion(symbolName)` | IntelliSense-like method/field listing |

### Object Info
| Tool | Use for |
|------|----------|
| `get_form_info(formName, searchControl?)` | Datasources, controls, methods. Pass `searchControl="General"` to find tab/group exact names for form extensions — **NEVER** use PowerShell for this |
| `get_query_info(queryName)` | Datasources, joins, ranges |
| `get_view_info(viewName)` | View / data entity structure |
| `get_data_entity_info(entityName)` | Data entity: category, OData settings, datasources, keys, field mappings |
| `get_report_info(reportName)` | **Read AxReport structure** — datasets, fields, designs, RDL summary. Use INSTEAD of PowerShell Get-Content |
| `get_method_source(className, methodName)` | **Full X++ source code** — use when you need to understand what the method does (complete business logic, conditions, loops) |
| `get_method_signature(className, methodName, includeCocTemplate?)` | **Exact signature** — required before CoC. Pass `includeCocTemplate: true` only when writing a CoC extension |
| `find_references(targetName, targetType?)` | Where-used analysis |

### Security & Extensions
| Tool | Use for |
|------|---------|
| `analyze_extension_points(objectName, showExistingExtensions?)` | What CoC methods, delegates, and data events does an object expose? Start here before any extension work |
| `get_table_extension_info(tableName)` | All extensions of a table across all models: added fields, indexes, methods |
| `find_coc_extensions(className, methodName?)` | Which extension classes use CoC to wrap a given class/method? |
| `find_event_handlers(targetTable)` | All `[SubscribesTo]` event handler methods for a table or class |
| `get_security_artifact_info(name)` | Privilege/Duty/Role: contained entries, full hierarchy chain |
| `get_security_coverage_for_object(objectName, objectType?)` | Which roles, duties, and privileges grant access to a form, table, or menu item? |
| `get_menu_item_info(name, itemType?)` | Menu item target object, type, and full security privilege chain |
| `validate_object_naming(proposedName, objectType)` | Validate extension/object name against D365FO naming conventions before creating |

### Code Generation & Analysis
| Tool | Use for |
|------|---------|
| `get_xpp_knowledge(topic, format?)` | **Queryable X++ knowledge base** — D365FO patterns, best practices, AX2012→D365FO migration. Call BEFORE generating code to avoid deprecated APIs. Topics: batch jobs, transactions, CoC, queries, set-based ops, security, data entities, temp tables, SSRS reports, number sequences, labels, form patterns, error handling, testing. `format="detailed"` includes code examples. |
| `analyze_code_patterns(scenario)` | Find patterns before generating code |
| `suggest_method_implementation(className, methodName)` | Real implementation examples |
| `analyze_class_completeness(className)` | Missing standard methods |
| `get_api_usage_patterns(apiName)` | Typical initialization & usage |
| `generate_code(pattern, name)` | Boilerplate: `class`, `runnable`, `form-handler`, `data-entity`, `batch-job`, `table-extension`, `sysoperation`, `event-handler` |

### Smart Object Generation
| Tool | Use for |
|------|---------|
| `get_table_patterns(tableGroup?, similarTo?)` | Analyze patterns before creating table |
| `get_form_patterns(formPattern?, tableName?)` | Analyze patterns before creating form |
| `suggest_edt(fieldName, context?)` | Suggest correct EDT for field |
| `generate_smart_table(name, fieldsHint?, primaryKeyFields?, methods?, ...)` | AI table generation |
| `generate_smart_form(name, dataSource?, formPattern?, ...)` | AI form generation (patterns: SimpleList, SimpleListDetails, DetailsMaster, DetailsTransaction, Dialog, TableOfContents, Lookup, ListPage) |
| `generate_smart_report(name, fieldsHint?, contractParams?, copyFrom?, ...)` | AI SSRS report generation — creates TmpTable + Contract + DP + Controller + AxReport in one call |

### File Operations
| Tool | Use for |
|------|---------|
| `generate_d365fo_xml(objectType, objectName)` | Preview XML before creating (supports: class, table, enum, form, query, view, data-entity, report) |
| `create_d365fo_file(objectType, objectName, modelName, projectPath?, xmlContent?, addToProject?, overwrite?)` | Create new D365FO file — or overwrite existing with `overwrite=true` + `xmlContent` |
| `modify_d365fo_file(objectType, objectName, operation, ...)` | Edit existing: methods (add/remove), fields (add/modify/rename/replace-all/remove), indexes (add/remove), relations (add/remove), field-groups (add/remove/add-field-to), add-field-modification, add-data-source, add-control, modify-property |
| `verify_d365fo_project(objects, projectPath?, modelName?)` | Verify objects exist on disk and in .rnrproj — use INSTEAD OF PowerShell after `create_d365fo_file` |

### SDLC & Build Tools
| Tool | Use for |
|------|---------|
| `update_symbol_index(filePath)` | **Call after every `modify_d365fo_file` AND `create_d365fo_file`** so that `get_class_info`, `get_method_source`, and `search` return fresh results. Without this, the index is stale and lookups for newly-added methods will return ❌ not found. |
| `build_d365fo_project(projectPath)` | Run MSBuild compilation locally to capture errors. |
| `trigger_db_sync(modelName, tableName?)` | Run a database sync for the current model. |
| `run_bp_check(projectPath, targetFilter?)` | Run Microsoft Best Practices (xppbp.exe) analysis. |
| `run_systest_class(className, modelName?)` | Execute unit testing using SysTestRunner.exe |

### Code Review & Source Control
| Tool | Use for |
|------|---------|
| `review_workspace_changes(directoryPath)` | **Code review only** (git diff → BP check). ❌ NOT for verifying that a `modify_d365fo_file` call succeeded — use `update_symbol_index` + `get_class_info` for that. If the diff is truncated, do NOT use built-in tools to read more — they are forbidden on .xml/.xpp. |
| `undo_last_modification(filePath)` | Safely checkout HEAD or delete specifically created untracked files when a code implementation was incorrectly generated. |


### Labels
| Tool | Use for |
|------|---------|
| `search_labels(query)` | **Always call first** before creating labels |
| `get_label_info(labelId?, model?)` | Get translations, list label files |
| `create_label(labelId, labelFileId, model, translations[])` | Create new label |
| `rename_label(oldLabelId, newLabelId, labelFileId, model)` | Rename label ID in .label.txt, X++ source, and XML metadata |

> **Label ID naming — NO prefix!**
> Label IDs describe the **meaning of the text**, not the owning object or model.
> ✅ CORRECT: `CustomerName`, `InvoiceDate`, `ErrorAmountNegative`, `FieldAccountNum`
> ❌ WRONG (prefixed like an object): `AslCoreCustomerName`, `ContosoExtInvoiceDate`
> The label *file* (e.g. `@AslCore:CustomerName`) already identifies the owning model — the ID itself needs no prefix.

> **Label file creation:** When calling `create_label` for the first time in a model (label file does not exist yet), **always** pass `createLabelFileIfMissing: true`. Without it the tool returns an error. Pass translations for all required languages (e.g. `en-US`, `cs`, `de`) — the tool creates the directory structure and XML descriptors for each language automatically. If you provide a translation for a language that does not yet have a folder (e.g. cs), set `createLabelFileIfMissing: true` so the folder and descriptor are created.

## File Paths & Model Name

AOT path: `C:\AOSService\PackagesLocalDirectory\{Model}\{Model}\Ax{Type}\{Name}.xml`

- Always provide `projectPath` in `create_d365fo_file` — auto-extracts `ModelName` from `.rnrproj`
- Without `projectPath`: `modelName` used AS-IS — risk of landing in Microsoft standard model!

`.mcp.json` in **MCP server directory** (next to `package.json`):
```json
{
  "servers": {
    "context": {
      "modelName": "MyModel",
      "packagePath": "C:\\AOSService\\PackagesLocalDirectory",
      "projectPath": "C:\\repos\\MySolution\\MyProject\\MyProject.rnrproj"
    }
  }
}
```

XML formatting: TABs for indentation (never spaces); CDATA for X++ source: `<![CDATA[ ... ]]>`

