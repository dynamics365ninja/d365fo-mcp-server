# All Available Tools

When you ask GitHub Copilot a question about D365FO code, it automatically calls one of these
54 tools to look up the answer or generate code. You do not need to name the tools yourself —
just ask in plain English.

> **C# Metadata Bridge (Windows D365FO VMs only):** On a Windows VM with D365FO installed,
> 20 tools automatically try the C# metadata bridge first — providing always-fresh,
> runtime-resolved metadata via `IMetadataProvider` and compiler-resolved cross-references
> via `DYNAMICSXREFDB`. If the bridge is unavailable (Azure, Linux, CI) or the object is
> not found, the tools transparently fall back to the SQLite database.
> Bridge-sourced results include a `_Source: C# bridge_` marker.
>
> **Cross-reference enrichment (P1-P5):** `find_references` returns categorized reference
> types (call/extends/field-access) and caller details. `find_coc_extensions` shows which
> methods each extension class wraps. `find_event_handlers` supports eventName/handlerType
> filtering. `get_api_usage_patterns` returns compiler-resolved callers grouped by class.
>
> **Write operations** are fully bridged: 18 create types and **all 25 modify operations**
> use `IMetadataProvider.Create()` / `Update()` as the sole write path.
> The bridge is required for all modify operations (no xml2js fallback).
> Complex create types (report, data-entity) remain in TypeScript XML generation.
> See [BRIDGE.md](BRIDGE.md) for details.

---

## Quick Reference

### Workspace Configuration (1 tool)

> ⚠️ **Local-only** — excluded from `read-only` (Azure) mode; available in `full` and `write-only` modes.
> Reports server config loaded from `.mcp.json`, detected D365FO projects from `D365FO_SOLUTIONS_PATH`,
> and stdio session info (MCP client name, roots). On Azure this would return irrelevant cloud-server
> state rather than your developer workspace — use the local companion for this tool.

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **get_workspace_info** | Verify model name, package path, project path — ⚠️ call this FIRST | "Check my workspace configuration" |

### Search and Discovery (8 tools)

> 🔌 Tools marked with **†** use the C# bridge as primary data source on Windows D365FO VMs.

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **search** † | Find any X++ symbol by name or keyword | "Find classes related to dimension posting" |
| **batch_search** | Search multiple things at once (3× faster) | "Find SalesTable, CustTable, and InventTable" |
| **search_extensions** | Search only in your custom/ISV code | "Find my custom extensions for CustTable" |
| **get_class_info** † | Full class details: methods, source code, inheritance | "Show me everything about SalesFormLetter" |
| **get_table_info** † | Full table schema: fields, indexes, relations | "Show me fields and relations on CustTable" |
| **get_enum_info** † | All enum values with integer values and labels | "What values does SalesStatus have?" |
| **get_edt_info** † | Extended Data Type definition: base type, labels, properties | "Show me EDT properties for CustAccount" |
| **code_completion** | List methods/fields on a class or table | "What methods start with 'calc' on SalesTable?" |

### Advanced Object Info (7 tools)

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **get_form_info** † | Form structure: datasources, controls, methods | "Show me the datasources in SalesTable form" |
| **get_query_info** † | Query structure: datasources, joins, ranges | "Analyze CustTransOpenQuery" |
| **get_view_info** † | View/data entity: fields, relations, methods | "Show me GeneralJournalAccountEntryView" |
| **get_report_info** † | AxReport structure: datasets, fields, designs, RDL summary | "Show me the dataset fields of InventValue report" |
| **get_method_signature** | Exact signature for CoC extensions | "Get signature of CustTable.validateWrite()" |
| **get_method_source** † | Full X++ source code of a method | "Show me the full implementation of SalesTable.validateWrite()" |
| **find_references** † | Where is this class/method/field used? | "Where is DimensionAttributeValueSet used?" |

### Intelligent Code Generation (6 tools)

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **get_xpp_knowledge** | Queryable X++ knowledge base — D365FO patterns, best practices, AX2012→D365FO migration | "How to create a batch job in D365FO?" |
| **get_d365fo_error_help** | Diagnose compiler errors, BP warnings, and runtime exceptions | "What does BPUpgradeCodeToday mean?" |
| **analyze_code_patterns** | Learn real patterns from your codebase | "Show me patterns for ledger journal creation" |
| **suggest_method_implementation** | Real examples of how similar methods are written | "How do others implement validateWrite()" |
| **analyze_class_completeness** | Which standard methods is my class missing? | "Is MyHelper class complete?" |
| **get_api_usage_patterns** † | How is a specific API typically initialized and used? (bridge-first: compiler-resolved callers) | "How do I use LedgerJournalEngine?" |

### Smart Object Generation (4 tools)

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **generate_smart_table** | AI-driven table generation with pattern analysis | "Generate a transaction table with common fields" |
| **generate_smart_form** | AI-driven form generation with pattern analysis (SimpleList, DetailsMaster, ListPage, etc.) | "Create a SimpleList form for MyTable" |
| **generate_smart_report** | AI-driven SSRS report generation — creates TmpTable + Contract + DP + Controller + AxReport in one call | "Create an SSRS report for inventory by zones" |
| **suggest_edt** | Suggest EDT for field name using fuzzy matching | "What EDT should I use for CustomerAccount field?" |

### Pattern Analysis (3 tools)

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **get_table_patterns** | Analyze field/index patterns for table groups | "Show me common patterns in Transaction tables" |
| **get_form_patterns** | Analyze datasource/control patterns for forms | "Find forms using CustTable" |
| **generate_code** | Generate X++ boilerplate (class, batch job, CoC, etc.) | "Generate a batch job class for order processing" |

### SDLC & Build Tools — LOCAL_TOOLS (7 tools)

The following tools empower Copilot to trigger X++ compilation, testing, and db syncing:

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **update_symbol_index** | Re-indexes a file after creation/modification, or **cleans up stale entries** when a file is deleted — removes symbols + labels from SQLite, invalidates Redis cache, and refreshes the C# bridge | "Update the index for the new class I just created" |
| **build_d365fo_project** | Triggers an MSBuild process on the project to catch compiler errors | "Build my project and show me the errors" |
| **trigger_db_sync** | Runs a database sync for the given table or the whole model | "Sync the database to reflect my table changes" |
| **run_bp_check** | Runs the best practice linter on the code | "Run best practice checks on my latest changes" |
| **run_systest_class** | Invokes D365FO SysTest framework against a specific test class | "Run the unit tests in MyTestClass" |
| **review_workspace_changes** | Fetches uncommitted X++ git diff and formats it for AI code review | "Review my uncommitted changes against D365 best practices" |
| **undo_last_modification** | Reverts (tracked) or deletes (untracked) a file via git, then **cleans up the symbol index** — removes stale SQLite entries, invalidates Redis cache, refreshes bridge, and re-indexes the restored file for reverts | "Undo the changes I just made to CustTable.xml" |

### File Operations — LOCAL_TOOLS (4 tools)

> The following tools access the **local Windows VM filesystem** (K:\ drive paths in
> `PackagesLocalDirectory` or `.rnrproj` project files) and are therefore excluded from
> the Azure `read-only` deployment. In the hybrid setup they run on the local companion
> (`MCP_SERVER_MODE=write-only`). They also skip the DB loading wait — no symbol database needed.

| Tool | Works where | What it does |
|------|------------|-------------|
| **generate_d365fo_xml** | Anywhere (cloud + local) | Returns XML content — Copilot then creates the file |
| **create_d365fo_file** | Local Windows VM only | Creates the physical file and adds it to the VS project |
| **modify_d365fo_file** | Local Windows VM only | Safely edits an existing file with automatic backup |
| **verify_d365fo_project** | Local Windows VM only | Reads `.rnrproj` on K:\ to verify objects exist on disk and are referenced in the project file |

### Security & Extensions (10 tools)

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **get_security_artifact_info** | Full privilege/duty/role details with hierarchy chain | "Show me everything in the CustTableFullControl privilege" |
| **get_security_coverage_for_object** | Which roles have access to a form or table | "What roles can access the CustTable form?" |
| **get_menu_item_info** | Menu item target, type, and security privilege chain | "What form does the CustTable menu item open?" |
| **find_coc_extensions** † | Which classes wrap a method with CoC — shows wrapped methods per extension | "Does CustTable.validateWrite have any CoC wrappers?" |
| **find_event_handlers** † | All event handlers with type classification and event filtering | "Who handles the onInserted event of SalesLine?" |
| **get_table_extension_info** | All extensions of a table: added fields, indexes, methods | "What fields did ISV packages add to CustTable?" |
| **get_data_entity_info** † | Data entity category, OData name, data sources, keys | "Show me CustCustomerV3Entity details" |
| **analyze_extension_points** † | CoC-eligible methods, delegates, events — what can be extended (bridge enrichment for existing extensions) | "What can I extend on SalesLine?" |
| **recommend_extension_strategy** | Recommends the best extensibility mechanism for a scenario — prevents wrong choices (CoC vs event vs Business Event vs data entity) | "Should I use CoC or Business Event to notify an external system?" |
| **validate_object_naming** | Validate proposed extension/object names against D365FO conventions | "Is SalesTableExtension a valid extension class name?" |

### Label Management (4 tools)

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **search_labels** | Full-text search across all AxLabelFile labels | "Find a label for 'customer account'" |
| **get_label_info** | All translations for a label ID, or list label files | "Show all translations of MyFeature in MyModel" |
| **create_label** | Add a new label to all language files in a model | "Create label MyNewField in MyModel" |
| **rename_label** | Rename a label ID in .label.txt, X++ source and XML metadata | "Rename label OldName to NewName in MyModel" |

---

## Tool Details

### search

Searches all 584 799+ D365FO symbols. Understands type filters so you can narrow results.

**Supported types:** class, table, method, field, enum, edt, form, query, view, report

**Examples:**
```
Find classes related to sales invoice posting
Search for tables used in customer management
Find methods that calculate tax
Find fields named Invoice across all tables
Find EDT for ItemId
```

---

### batch_search

Runs multiple searches in a single call — about 3× faster than asking one by one.
Use it when you need information about several unrelated things at once.

**Examples:**
```
Find SalesTable, CustTable, and LedgerJournalTrans at the same time
Search for dimension classes, ledger services, and posting controllers
```

---

### search_extensions

Same as **search** but filters to only your custom/ISV code. Use this when you want to
avoid noise from the 500 000+ standard Microsoft symbols.

**Examples:**
```
Find all my ISV_ classes
Show me custom extensions for CustTable
Search for MyModel helper classes
```

---

### get_class_info

Returns the complete class definition: every method with its full signature and source code,
the inheritance chain (extends/implements), and any attributes.

**Examples:**
```
Show me all methods on CustTable
What does the SalesFormLetter class do?
Show me the full source of DimensionAttributeValueSet
```

---

### get_table_info

Returns the full table schema: every field with its data type and EDT, all indexes (including
which is the primary key), and every foreign key relation.

**Examples:**
```
What fields does SalesLine have?
Show me all relations on InventTable
What is the primary key of CustTable?
```

---

### get_enum_info

Returns all values of an enum with their integer values and labels. Use this for enums only.
For Extended Data Types (EDT), use **get_edt_info** instead.

**Examples:**
```
What values does SalesStatus have?
Show me all NoYes enum values
List values of InventTransType
```

---

### get_edt_info

Returns the complete Extended Data Type (EDT) definition including base type (Extends), enum type,
reference table, string/number constraints, labels, and all EDT properties from AxEdt metadata.

**Use this when you need:**
- Base type inheritance chain (which EDT extends which)
- Reference table and relation type
- String size, display length, number of decimals
- Label, help text, and form help references
- Configuration keys and other EDT properties

**Examples:**
```
Show me EDT properties for CustAccount
What is the base type of ItemId?
Show me the reference table for RecId EDT
What is the string size of Name EDT?
```

---

### get_method_signature

Extracts the exact signature of a method including modifiers, return type, and all parameters
with their default values. Essential before writing a Chain of Command extension — using the
wrong signature always causes a compilation error.

**Examples:**
```
Get the signature of SalesTable.validateWrite()
What parameters does InventTable.initFromTable() take?
```

---

### get_method_source

Returns the complete X++ source code of a method — the full implementation including all
conditions, loops, transaction handling, and error logic. Use this when the signature alone is
not enough and you need to understand what the method actually does.

The database stores the full body alongside the snippet, so no file I/O is needed at query time.
Falls back to the extracted JSON metadata when the database was built before this feature was added.

**Examples:**
```
Show me the full implementation of SalesTable.validateWrite()
What does InventUpd_Reservation.updateReservation() actually do?
Show me the posting logic in SalesInvoiceJournalPost.run()
```

---

### find_references

Performs a where-used search across the entire codebase. Works for classes, methods, tables,
fields, and enums.

**Examples:**
```
Where is DimensionAttributeValueSet used?
Find all callers of CustTable.validateWrite()
Which classes reference the SalesLine.RemainSalesPhysical field?
```

---

### get_query_info

Returns the complete query structure: all datasources, joins, field lists, and range definitions.

**Examples:**
```
Analyze CustTransOpenQuery
Show me joins in LedgerJournalTrans query
What ranges does InventOnHand query have?
```

---

### get_view_info

Returns view or data entity structure including fields (mapped and computed), relations,
primary key, and methods. Works for both AxView and AxDataEntityView objects.

**Examples:**
```
Show me GeneralJournalAccountEntryView structure
List fields and relations on CustomerV3Entity
What is the primary key of VendorV2Entity?
```

---

### get_report_info

Reads an AxReport XML file from disk and returns structured information about its contents.
Use this **instead of PowerShell `Get-Content`** when studying an existing SSRS report before
creating a similar one or extending it.

Reports are indexed as type `report` in the symbol database, so you can also find them
with `search(query, type: 'report')`.

**Parameters:**
- `reportName` — AxReport object name without `.xml` extension (required)
- `modelName` — model name; auto-detected from `.mcp.json` if omitted
- `includeFields` — include per-dataset field list (default: `true`)
- `includeRdl` — include full embedded RDL XML (default: `false`; can be large)

**Returns:**
- Report name, model, file path
- DataMethods and EmbeddedImages presence
- For each **DataSet**: name, `DataSourceType`, query (`SELECT * FROM DP.TmpTable`),
  field names + aliases + data types, field groups
- For each **Design**: name, caption, linked DataSet, style, whether RDL is present
- Optional RDL summary (element counts, Tablix/Chart count, ReportParameters, language)
  or the full RDL XML when `includeRdl: true`

**Examples:**
```
Show me the dataset fields of the InventValue report
What does the ContosoInventByZone report look like — datasets and design?
Find reports related to fixed assets
```

---

### get_form_info

Parses form XML and returns all datasources (with their fields and methods), the control
hierarchy (buttons, grids, groups), and form-level methods.

When you need to find the **exact name** of a tab, group, or field to use in a form extension,
pass `searchControl` with a case-insensitive substring (e.g. `searchControl="General"`).
The tool returns matching controls with their full path, parent name, and children — so you
know exactly where to place new controls without resorting to PowerShell.

> ❌ **Never use PowerShell `Get-Content` / `Select-String` to search form XML.**
> ✅ **Always use `get_form_info(formName, searchControl="...")` instead.**

**Parameters:**
- `formName` — form name (required)
- `searchControl` — substring to find controls by name; returns path + parent + children
- `includeControls` / `includeDataSources` / `includeMethods` — toggle sections (default: all on)

**Examples:**
```
Show me the datasources in SalesTable form
Find the exact name of the General tab in CustTable form
What controls are inside the LineView tab of SalesTable?
List all buttons on the CustTable form
What methods does the SalesCreateOrder form have?
```

---

### get_d365fo_error_help

Diagnoses D365FO X++ compiler errors, BP warnings, and runtime exceptions. Returns a
plain-language explanation plus a corrective action — no symbol-index access needed, so
it works in both Azure read-only and local modes.

**When to call:** Whenever the compiler Output window, Error List, or runtime infolog shows
an unfamiliar error. Rule 22 in `copilot-instructions.md` mandates calling this tool
**before guessing a fix.**

**Parameters:**
| Parameter | Required | Description |
|-----------|----------|-------------|
| `errorText` | Yes | Full error text — paste from Error List, Output window, or infolog |
| `errorCode` | No | Error code prefix, e.g. `CSUV1`, `SYS10028`, `BPError` — improves matching |
| `context` | No | X++ code snippet where the error occurs — produces a more targeted suggestion |

**Covered error families:** CSUV\*/CSU\*, SYS\*, BP\* warnings, TTS-level errors,
OCC (UpdateConflict), type-cast errors, "must call next", "not valid metadata element", and more.

**Examples:**
```
get_d365fo_error_help(errorText="CSUV1 The field CustAccount cannot be assigned", errorCode="CSUV1")
get_d365fo_error_help(errorText="BPUpgradeCodeToday")
get_d365fo_error_help(errorText="TTS level is not 0", context="ttsbegin; ... ttscommit;")
```

---

### get_xpp_knowledge

Queryable knowledge base of D365FO X++ patterns, best practices, and AX2012→D365FO migration
guidance. Returns distilled, verified patterns with code examples. Call BEFORE generating code
to avoid deprecated APIs and AX2012 anti-patterns.

**Parameters:**
| Parameter | Required | Description |
|-----------|----------|-------------|
| `topic` | Yes | Topic to query — e.g. "batch job", "ttsbegin", "RunBase vs SysOperation", "CoC", "temp tables" |
| `format` | No | `concise` (default) = quick reference, `detailed` = full explanation with code examples |

**Topics covered:** batch jobs, transactions, queries, CoC/extensions, event handlers, security,
data entities, temp tables, number sequences, form patterns, set-based operations, error handling,
labels, SSRS reports, deprecated APIs, performance, testing.

**Examples:**
```
How to create a batch job in D365FO?
What replaced RunBase in D365FO?
Show me transaction handling patterns (detailed)
Is today() deprecated? What should I use instead?
How does CoC work? Show code examples
```

---

### analyze_code_patterns

Analyzes your actual codebase to find the most common classes, methods, and dependencies
used in a given scenario. Use this before generating code to make sure Copilot follows
your team's real patterns, not generic templates.

**Examples:**
```
Analyze patterns for ledger journal creation
What are the common patterns for helper classes in my code?
Show me patterns for financial dimension handling
```

---

### get_api_usage_patterns

Shows how a specific API class or method is actually used in your codebase: typical
initialization code, common method call sequences, and related APIs.

> **Bridge-first (P5):** When the C# bridge is connected, this tool queries
> `DYNAMICSXREFDB` for compiler-resolved callers of the API, grouped by class with
> method list and call count. Falls back to SQLite pattern analysis when the bridge
> is unavailable.

**Examples:**
```
How do I correctly use DimensionAttributeValueSet?
Show me how LedgerJournalEngine is typically initialized
How is InventDim used in my code?
```

---

### generate_code

Generates X++ boilerplate code for common patterns. Always call analyze_code_patterns first
so the generated code matches your environment.

**Supported patterns:**

| Pattern | Use it for |
|---------|-----------|
| `class` | Standard X++ class (also the base for CoC extensions) |
| `runnable` | Class with `main()` for direct execution or one-off scripts |
| `form-handler` | Form extension with `init()`, `close()`, and datasource events |
| `data-entity` | Data entity guidance (entities are AxDataEntityView XML, not classes) |
| `batch-job` | SysOperationServiceController + service class with `process()` |
| `table-extension` | Table extension with `validateWrite()`, `modifiedField()` |
| `sysoperation` | Full SysOperation scaffold: DataContract + Controller + Service |
| `event-handler` | Event handler class with `[DataEventHandler]` for standard table events |
| `security-privilege` | Security privilege XML (View + Maintain pair) |
| `menu-item` | Menu item XML (display, action, or output) |
| `class-extension` | `[ExtensionOf(classStr(...))]` CoC extension class skeleton |
| `table-extension` | `[ExtensionOf(tableStr(...))]` with `validateWrite`, `insert`, `update` |
| `form-handler` | `[ExtensionOf(formStr(...))]` wrapping form-level methods (`init`, `close`) |
| `form-datasource-extension` | `[ExtensionOf(formDataSourceStr(Form, DS))]` wrapping data source methods (`init`, `executeQuery`, `active`, `write`, `validateWrite`). Pass `name`=FormName, `baseName`=DataSourceName. |
| `form-control-extension` | `[ExtensionOf(formControlStr(Form, Control))]` wrapping control methods (`modified`, `validate`, `lookup`). Pass `name`=FormName, `baseName`=ControlName (use `get_form_info` to find the exact name). |
| `map-extension` | `[ExtensionOf(mapStr(...))]` for X++ maps (`InventItemOrdered`, `LogisticsPostalAddress`, …) |
| `ssrs-report-full` | Generates DataContract + DP + Controller trio for an SSRS report |
| `lookup-form` | `SysTableLookup` static method boilerplate |
| `dialog-box` | Dialog class with `prompt()`, `parmDate()`, `parmDescription()` |
| `dimension-controller` | `DimensionDefaultingController::constructInTabWithValues` with `datasourceActive()`, `formClosing()` |
| `number-seq-handler` | `NumberSeqFormHandler::newForm` + CoC on `NumberSeqApplicationModule.loadModule()` + CompanyInfo extension with numRef method |
| `display-menu-controller` | `MenuFunction::main(Args)` routing controller with `canRun()` |
| `data-entity-staging` | `copyCustomStagingToTarget()`, `DMFTransferStatus`, `UpdateConflict` retry loop |
| `service-class-ais` | CRUD AIF/AIS service class + `DataContract` with `[SysEntryPointAttribute]` |

**Examples:**
```
Generate a batch job class for inventory reconciliation
Create a table extension for InventTable
Generate a data entity for customer master data
```

---

### create_d365fo_file

Creates a physical D365FO XML file in the correct AOT location on a local Windows VM.
The server reads your `.rnrproj` to determine the model name automatically — so the file
always ends up in your custom model, not a Microsoft standard model.

Optionally adds the file to your Visual Studio project in one step.

When the package name differs from the model name, pass `packageName` explicitly
(e.g., `CustomExtensions`). In UDE environments, the server resolves it automatically
from descriptor XML files. In traditional environments, it defaults to the model name.

**Supported object types:**

| Type | AOT folder | Notes |
|------|-----------|-------|
| `class` | `AxClass` | Regular X++ class |
| `class-extension` | `AxClass` | `[ExtensionOf(classStr(...))] final class` skeleton |
| `table` | `AxTable` | Regular table |
| `table-extension` | `AxTableExtension` | |
| `form` | `AxForm` | |
| `form-extension` | `AxFormExtension` | |
| `query` | `AxQuery` | |
| `view` | `AxView` | |
| `data-entity` | `AxDataEntityView` | |
| `data-entity-extension` | `AxDataEntityViewExtension` | |
| `enum` | `AxEnum` | |
| `enum-extension` | `AxEnumExtension` | |
| `edt` | `AxEdt` | |
| `edt-extension` | `AxEdtExtension` | |
| `report` | `AxReport` | SSRS report XML; requires UTF-8 BOM — use this tool, never `create_file` |
| `menu-item-display` | `AxMenuItemDisplay` | |
| `menu-item-action` | `AxMenuItemAction` | |
| `menu-item-output` | `AxMenuItemOutput` | |
| `menu-item-display-extension` | `AxMenuItemDisplayExtension` | |
| `menu-item-action-extension` | `AxMenuItemActionExtension` | |
| `menu-item-output-extension` | `AxMenuItemOutputExtension` | |
| `menu` | `AxMenu` | |
| `menu-extension` | `AxMenuExtension` | |
| `security-privilege` | `AxSecurityPrivilege` | NEVER use for duties/roles |
| `security-duty` | `AxSecurityDuty` | |
| `security-role` | `AxSecurityRole` | |
| `business-event` | `AxClass` | Generates `BusinessEventsBase` class + companion `BusinessEventsContract` |
| `tile` | `AxTile` | AxTile XML (TileType, MenuItemName, Size, RefreshFrequency) |
| `kpi` | `AxKPI` | AxKPI XML (Measure, MeasureDimension, Goal, GoalType) |

**Requires:** MCP server running on a local Windows machine with file system access.

**Examples:**
```
Create a class MyHelper and add it to my project
Create a table extension for InventTable in my model
Create a class in the CustomExtensions package, Contoso Utilities model
Create the SSRS report XML for ContosoMyReport in my model
```

---

### generate_d365fo_xml

Returns the D365FO XML content as text. Works everywhere — Azure, local, any OS.
Copilot then writes the content to a file using VS Code's file tools.

Supports the same object types as `create_d365fo_file`: class, table, form, query, view,
data-entity, enum, edt, **report**.

Use this when the MCP server is hosted in Azure and does not have local file system access.

---

### modify_d365fo_file

Edits an existing D365FO XML file safely:

1. Creates a backup (`.bak`) before touching anything
2. Makes the change (add/edit/remove a method or field)
3. Validates that the XML is still well-formed
4. Rolls back from the backup if anything goes wrong

Supports `packageName` parameter for when the package name differs from the model name.
In UDE environments this is auto-resolved; in traditional environments it defaults to
the model name.

**Supported operations:**

| Operation | Applies to | Description |
|-----------|-----------|-------------|
| `add-method` | class, table, form, extension | Add a new method (or CoC method). Pass full X++ source via `sourceCode`. |
| `remove-method` | class, table | Remove a method by name. |
| `replace-code` | class, table | Surgical in-place replacement: `oldCode` → `newCode` inside a method body or classDeclaration. |
| `add-display-method` | table, table-extension | Add a `display` method with `[SysClientCacheDataMethodAttribute(true)]`. |
| `add-table-method` | table, table-extension | Generate canonical boilerplate for `find`/`exist`/`findByRecId`/`validateWrite`/`validateDelete`/`initValue`. |
| `add-field` | table, table-extension | Add a field. |
| `modify-field` | table, table-extension | Change EDT, mandatory, or label of an existing field. |
| `rename-field` | table | Rename a field (also fixes index DataField refs and TitleField1/2 automatically). |
| `replace-all-fields` | table | Atomically rewrite ALL fields (use when field names are corrupted or have spaces). |
| `remove-field` | table, table-extension | Remove a field by name. |
| `add-field-modification` | table-extension | Override a base-table field's label or mandatory setting. |
| `add-index` / `remove-index` | table, table-extension | Manage table indexes. |
| `add-relation` / `remove-relation` | table, table-extension | Manage table relations. |
| `add-field-group` | table, table-extension | Add a field group. |
| `remove-field-group` | table, table-extension | Remove a field group. |
| `add-field-to-field-group` | table, table-extension | Add a field to an existing field group. |
| `add-data-source` | form, form-extension | Add a data source. |
| `add-control` | form-extension | Add a UI control to a tab/group (with optional positioning). |
| `add-enum-value` | enum, enum-extension | Add a new enum value. |
| `modify-enum-value` | enum | Change label or value of an existing enum entry. |
| `remove-enum-value` | enum | Remove an enum value. |
| `add-menu-item-to-menu` | menu, menu-extension | Add a typed menu item entry (display/action/output). |
| `modify-property` | any | Change any object-level property (TableGroup, TitleField1, TableType, Extends, Label, …). |

**Requires:** MCP server running on a local Windows machine with file system access.

**Examples:**
```
Add a method calculateDiscount() to MyCustomHelper
Add a field CreditStatus to MyCustomTable
Add a find() method to MyTable
Add a display method getCustomerName() returning CustName to MyTable
Add a menu item ContosoMyForm to the ContosoMenu extension
```

---

### search_labels

Performs full-text search across all indexed AxLabelFile labels. Searches label IDs, text
content, and developer comments simultaneously. Returns labels in ranked order with ready-to-use
`@LabelFileId:LabelId` reference syntax.

> **Always call this before `create_label`** — reusing an existing label avoids duplication
> and saves translation effort.

**Parameters:**
- `query` — text to search for (required)
- `language` — filter by locale, e.g. `en-US` (default: `en-US`)
- `model` — restrict to one model, e.g. `MyModel`
- `labelFileId` — restrict to one label file ID
- `limit` — max results (default: 30)

**Examples:**
```
Find a label for the text "customer account"
Search for labels about "batch" in the MyModel model
Find labels matching "vendor" in English
```

---

### get_label_info

Has two modes depending on whether you pass a label ID:

**Mode A — list label files** (no `labelId`): Shows all AxLabelFile IDs available in a
model, the languages they contain, and how many labels each file has.

**Mode B — show translations** (with `labelId`): Shows all language translations for a
specific label, including the developer comment, and generates ready-to-use X++ and XML
code snippets.

**Examples:**
```
What label files does the MyModel model have?
Show me all translations of label MyFeature in MyModel
Show me the X++ snippet for label BatchGroup
```

---

### create_label

Adds a new label to every language `.label.txt` file in a model. Inserts the entry
alphabetically (as required by the D365FO label file format), creates the AxLabelFile XML
descriptors if the model doesn't have any yet, and updates the MCP index so the new label
is immediately searchable.

> **Always call `search_labels` first** to verify the label doesn't already exist.

**Parameters:**
- `labelId` — new label ID, e.g. `MyNewField` (required)
- `labelFileId` — target label file, e.g. `MyModel` (required)
- `model` — model name, e.g. `MyModel` (required)
- `translations` — array of `{ language, text }` objects (required); provide all supported
  languages
- `defaultComment` — developer comment added to each translation
- `packageName` — package name for label file location; auto-resolved from model if omitted
- `packagePath` — override base path (default: auto-detected from environment)
- `createLabelFileIfMissing` — create AxLabelFile structure from scratch if needed
- `updateIndex` — immediately update the MCP index (default: `true`)

**Label reference syntax after creation:**
- In X++ code: `literalStr("@MyModel:MyNewField")`
- In metadata XML: `<Label>@MyModel:MyNewField</Label>`

**Examples:**
```
Create label MyNewField in the MyModel model with translations for en-US, cs, de, and sk
Add a new label CustomerAccountNumber with English text "Customer account number"
```

---

### rename_label

Renames a label ID everywhere it is used across the model — a single command that handles
all three locations atomically:

1. **`.label.txt` files** — the label entry is renamed in every language variant
2. **X++ source files (`.xpp`)** — all `@LabelFileId:OldId` references are replaced
3. **XML metadata files** — all `<Label>`, `<HelpText>`, `<Caption>`, etc. properties
   that reference the old label ID are updated
4. **MCP SQLite index** — updated so the new ID is immediately searchable

> ⚠️ **Always run with `dryRun=true` first** to preview the full impact before writing
> any files.

**Parameters:**
- `oldLabelId` — current label ID (required)
- `newLabelId` — new label ID, alphanumeric (required)
- `labelFileId` — label file that owns the label, e.g. `MyModel` (required)
- `model` — model name (required)
- `packageName` — package name; auto-resolved if omitted
- `packagePath` — override base path; auto-detected if omitted
- `searchPaths` — additional directories to scan for X++ / XML references
- `dryRun` — preview mode, no files written (default: `false`)
- `updateIndex` — update MCP index after rename (default: `true`)

**Examples:**
```
Rename label OldFieldName to NewFieldName in label file MyModel, model MyModel (dry run first)
Rename label MyOldCaption to MyNewCaption in MyModel
```

---

### get_table_patterns

Analyzes common field types, index patterns, and relation structures for D365FO table groups.
Helps understand table design patterns before creating new tables.

**Parameters:**
- `tableGroup` — table group to analyze (Main, Transaction, Parameter, Group, Reference,
  Miscellaneous, WorksheetHeader, WorksheetLine)
- `similarTo` — alternative: find tables with similar structure to a specific table name
- `limit` — max examples to return (default: 10)

**Examples:**
```
Show me common field patterns in Transaction tables
Find tables similar to CustTable
What indexes are typical in Parameter tables?
```

**Returns:**
- Common field names and their EDTs
- Typical index configurations (unique, clustered, etc.)
- Common relation patterns to other tables
- Table group characteristics and recommendations

---

### get_form_patterns

Analyzes common datasource configurations, control hierarchies, and D365FO form patterns.
Helps understand form design patterns before creating new forms.

**Parameters:**
- `formPattern` — D365FO form pattern to analyze (DetailsTransaction, ListPage, SimpleList,
  SimpleListDetails, Dialog, DropDialog, FormPart, Lookup)
- `dataSource` — alternative: find forms that use a specific table
- `similarTo` — alternative: find forms with similar structure to a specific form name
- `limit` — max examples to return (default: 10)

**Examples:**
```
Analyze SimpleList form patterns
Find all forms using CustTable as datasource
Show me forms similar to SalesTableListPage
What controls are typical in ListPage forms?
```

**Returns:**
- Datasource configurations (allow edit/create/delete settings)
- Common control hierarchies (grids, buttons, groups)
- Form pattern characteristics and recommendations
- Typical field selections in grids

---

### suggest_edt

Suggests Extended Data Types (EDT) for a field name using fuzzy matching and pattern analysis.
Analyzes indexed EDT metadata to recommend appropriate EDTs based on field name patterns.

**Use this BEFORE creating table fields** to ensure you reuse existing EDTs instead of
creating primitive types.

**Parameters:**
- `fieldName` — field name to suggest EDT for (required), e.g. "CustomerAccount", "OrderAmount"
- `context` — optional context to improve suggestions, e.g. "sales order", "ledger journal"
- `limit` — max suggestions to return (default: 5)

**Examples:**
```
What EDT should I use for field CustomerAccount?
Suggest EDT for OrderAmount in sales order context
What EDT matches TransDate field name?
```

**Returns:**
- Confidence-ranked EDT suggestions (1.0 = exact match, 0.8+ = high confidence)
- EDT properties: base type, enum type, reference table, label
- Reason for each suggestion (exact match, fuzzy match, pattern match)
- String constraints (size, display length) or numeric properties

---

### generate_smart_table

AI-driven table generation with intelligent field/index/relation suggestions based on
indexed metadata patterns. Generates complete AxTable XML ready for file creation.

**Strategies:**
1. **Copy structure** — copyFrom an existing table
2. **Pattern analysis** — analyze tableGroup patterns and generateCommonFields
3. **Field hints** — provide fieldsHint and let tool suggest EDTs
4. **Combine strategies** — use multiple approaches for comprehensive generation

**Parameters:**
- `name` — table name (required), e.g. "MyOrderTable"
- `label` — optional label for the table
- `tableGroup` — table group (Main, Transaction, Parameter, etc.)
- `copyFrom` — optional: copy structure from existing table name
- `fieldsHint` — optional: comma-separated field hints (e.g. "RecId, Name, Amount")
- `generateCommonFields` — if true, auto-generate common fields based on table group
- `modelName` — model name (auto-detected from projectPath)
- `projectPath` — path to .rnrproj file for model extraction
- `solutionPath` — path to solution directory (alternative to projectPath)

**Examples:**
```
Generate a transaction table with common fields like RecId, CreatedBy, ModifiedBy
Create a table copying structure from CustTable
Generate MyOrderTable with fields: OrderId, CustomerAccount, OrderAmount
```

**Returns:**
- Complete AxTable XML with:
  - Suggested fields with appropriate EDTs
  - Recommended indexes (primary key, alternate keys)
  - Suggested relations to related tables
  - Table group properties and configuration

---

### generate_smart_form

AI-driven form generation with intelligent datasource/control suggestions based on
indexed metadata patterns. Generates complete AxForm XML ready for file creation.

**Strategies:**
1. **Copy structure** — copyFrom an existing form
2. **Auto-generate** — provide dataSource table and generateControls for automatic grid
3. **Pattern-based** — specify formPattern and let tool apply standard structure
4. **Combine strategies** — use multiple approaches for comprehensive generation

**Parameters:**
- `name` — form name (required), e.g. "MyOrderForm"
- `label` — optional label for the form
- `caption` — optional caption/title
- `dataSource` — optional: table name for primary datasource (auto-generates grid)
- `formPattern` — optional: form pattern (SimpleList, SimpleListDetails, DetailsMaster, DetailsTransaction, Dialog, TableOfContents, Lookup, ListPage)
- `copyFrom` — optional: copy structure from existing form name
- `generateControls` — if true, auto-generate grid controls for datasource fields
- `modelName` — model name (auto-detected from projectPath)
- `projectPath` — path to .rnrproj file for model extraction
- `solutionPath` — path to solution directory (alternative to projectPath)

**Examples:**
```
Generate a SimpleList form for MyOrderTable with auto-generated grid
Create a form copying structure from CustTableListPage
Generate MyOrderForm with datasource and controls for displaying orders
```

**Returns:**
- Complete AxForm XML with:
  - Datasource configuration (table, allow edit/create/delete)
  - Control hierarchy (grids, buttons, groups)
  - Form pattern application (SimpleList, SimpleListDetails, DetailsMaster, DetailsTransaction, Dialog, TableOfContents, Lookup, ListPage)
  - Common action buttons (New, Delete, Refresh)

---

### generate_smart_report

AI-driven SSRS report generation that creates up to **5 D365FO objects in a single call**:

1. **TmpTable** (AxTable, TableType=TempDB) — report data storage
2. **Contract class** (DataContractAttribute) — dialog parameters with `[DataMemberAttribute]` parm methods
3. **DP class** (SrsReportDataProviderBase) — `processReport()` + `get<TmpTable>()` getter
4. **Controller class** (SrsReportRunController) — `main(Args)` entry point + `prePromptModifyContract()`
5. **AxReport XML + RDL** — dataset bound to DP/TmpTable, detail tablix, hidden AX system parameters

**Strategies:**
1. **Field hints** — `fieldsHint` with comma-separated field names; EDTs auto-suggested from names
2. **Structured fields** — `fields` array with explicit `edt` and `.NET dataType` per field
3. **Copy structure** — `copyFrom` reads the existing report's TmpTable fields from the symbol index
4. **Contract parameters** — `contractParams` generates complete parm methods with `SysOperationLabelAttribute`

**Parameters:**
- `name` — base report name WITHOUT model prefix (required), e.g. `"InventByZones"`
- `caption` — human-readable title (e.g. `"Inventory by Zones"`)
- `fieldsHint` — comma-separated field names (e.g. `"ItemId, ItemName, Qty, Zone"`)
- `fields` — structured field specs `[{name, edt?, dataType?, label?}]`
- `contractParams` — dialog parameters `[{name, type?, label?, mandatory?}]`
- `generateController` — whether to generate a Controller class (default: `true`)
- `designStyle` — `"SimpleList"` (default) or `"GroupedWithTotals"`
- `copyFrom` — copy field structure from an existing report name
- `modelName` — model name (auto-detected from projectPath)
- `projectPath` — path to `.rnrproj` file
- `solutionPath` — path to solution directory

**Examples:**
```
Create an SSRS report for inventory by zones with fields ItemId, ItemName, Qty, Zone
Generate a customer balance report with FromDate and ToDate dialog parameters
Create a SalesReport copying fields from SalesInvoice report
```

**Returns (Azure/Linux):**
- Up to 5 XML/source blocks — one per object
- Mandatory next step: call `create_d365fo_file` for **each** block in order
- ⛔ NEVER skip any of the create calls — all objects are required for the report to build

**Returns (Windows VM):**
- Files written directly to disk + added to VS project
- ⛔ DO NOT call `create_d365fo_file` — task is already complete

**Object naming convention:**
| Object | Name pattern | Example |
|--------|-------------|--------|
| TmpTable | `{FinalName}Tmp` | `ContosoInventByZonesTmp` |
| Contract | `{FinalName}Contract` | `ContosoInventByZonesContract` |
| DP class | `{FinalName}DP` | `ContosoInventByZonesDP` |
| Controller | `{FinalName}Controller` | `ContosoInventByZonesController` |
| Report | `{FinalName}` | `ContosoInventByZones` |

---

### verify_d365fo_project

Verifies that D365FO objects exist on disk at the correct AOT path and are referenced in the Visual Studio project file. Use this instead of PowerShell after `create_d365fo_file` to confirm that files were created and registered correctly.

**Parameters:**
- `objects` (required): Array of `{ objectType, objectName }` pairs to check
- `projectPath` (optional): Absolute path to `.rnrproj` — required for project-reference check
- `modelName` (optional): Model name — auto-detected from `mcp.json` if omitted
- `packageName` / `packagePath` (optional): Override auto-resolved package location

**Returns:** Markdown table with ✅/❌ for each object on disk presence and project inclusion, plus a summary.

**Example:**
```json
{
  "objects": [
    { "objectType": "table",            "objectName": "ContosoInventByZoneTmp" },
    { "objectType": "report",           "objectName": "ContosoInventByZone" },
    { "objectType": "menu-item-action", "objectName": "ContosoInventByZone" }
  ],
  "projectPath": "K:\\AosService\\PackagesLocalDirectory\\fm-mcp\\fm-mcp\\fm-mcp.rnrproj"
}
```

**Example output:**
```
## Verification Results — fm-mcp

| Object | Type | Disk | Project |
|--------|------|------|---------|
| ContosoInventByZoneTmp | table | ✅ `K:\...\AxTable\ContosoInventByZoneTmp.xml` | ✅ |
| ContosoInventByZone | report | ✅ ... | ✅ |
| ContosoInventByZone | menu-item-action | ❌ Missing — expected: `K:\...\AxMenuItemAction\ContosoInventByZone.xml` | ✅ |

### Summary
- Checked: 3   On disk ✅: 2   Missing from disk ❌: 1
- In project ✅: 3   Missing from project ❌: 0
```

---

### update_symbol_index

Re-indexes a D365FO XML file in the SQLite symbol database. Since `create_d365fo_file`
and `modify_d365fo_file` now **auto-invalidate** the Redis cache and refresh the C# bridge
provider, this tool is no longer required after those operations. It remains useful for
edge cases — files modified outside MCP tools (manual edits, `git pull`, external scripts).

**Handles three scenarios:**

| Scenario | What happens |
|----------|-------------|
| **File exists** (created/modified) | Re-parses the XML file, updates all symbol entries in SQLite (symbols + labels), and **invalidates Redis cache** for all affected objects |
| **File deleted** | Removes all stale symbol and label entries from SQLite, clears Redis cache entries (`xpp:class:*`, `xpp:table:*`, `xpp:method-sig:*`, `xpp:search:*`), and refreshes the C# bridge provider |
| **File not in index** | Indexes the file for the first time |

> **Why this matters:** Without cache invalidation, Redis would continue serving stale data
> (e.g. a deleted class appearing as "found") until the 1-hour TTL expired. This tool now
> clears all relevant cache entries immediately.

**Parameters:**
- `filePath` — absolute path to the D365FO XML file (required)
- `objectType` — object type hint: `class`, `table`, `enum`, `edt`, etc. (optional)

**Returns:**
- `✅ Indexed N symbol(s)` — file was (re-)indexed, Redis cache invalidated
- `🗑️ File deleted — cleaned up N symbol(s) + M label(s)` — stale entries removed

**Examples:**
```
Update the index for the new class I just created
Re-index SalesTable after adding a field
The index still shows a label I deleted — force re-index
```

---

### undo_last_modification

Reverts or deletes an uncommitted D365FO file change via git, then performs **full index
cleanup** to ensure the MCP symbol database reflects the actual state on disk.

**For tracked files** (modified, existing in git):
1. Runs `git checkout HEAD -- <file>` to restore the last committed version
2. Removes stale symbol/label entries from SQLite
3. Invalidates Redis cache for all affected objects
4. Refreshes the C# bridge provider
5. Re-indexes the restored file to reflect its reverted content

**For untracked files** (newly created, not in git):
1. Deletes the file from disk (`fs.unlinkSync`)
2. Removes stale symbol/label entries from SQLite
3. Invalidates Redis cache entries
4. Refreshes the C# bridge

> **Why this matters:** Previously, undoing a file creation left the symbol index believing
> the objects still existed — Copilot would report classes and labels as valid even after
> they were removed. Now the entire cleanup chain runs automatically.

**Parameters:**
- `filePath` — absolute path to the D365FO XML file to undo (required)

**Returns:**
- Success message with details about the revert/delete and index cleanup
- Error message if the file is not in a git repository or has no changes

**Examples:**
```
Undo the changes I just made to CustTable.xml
Revert the new class I just created — it was wrong
Delete the untracked label file and clean up the index
```

---

### review_workspace_changes

Fetches all uncommitted X++ changes via `git diff HEAD` from a local repository and formats
them as a clean diff for AI-based code review against D365FO best practices.

> ⚠️ **LOCAL_TOOLS only** — requires a local Windows machine with the repository checked out.
> This tool is NOT a substitute for `run_bp_check` — it performs AI-driven diff analysis,
> while `run_bp_check` runs the real Microsoft xppbp.exe linter.

**Parameters:**
- `directoryPath` — absolute path to the local git repository (required)

**Returns:**
- Formatted git diff of uncommitted changes ready for AI code review
- Empty message if there are no uncommitted changes

**Examples:**
```
Review my uncommitted changes against D365 best practices
Check the git diff in K:\repos\MyProject for code quality issues
```

---

### get_workspace_info

Returns the currently configured model name, package path, project path, and environment type.
Explicitly flags whether the model name looks like a placeholder (`MyModel`, `MyPackage`, etc.).

When a placeholder is detected, the tool auto-reads the `.rnrproj` file and shows the real
auto-detected model name as a concrete fix suggestion.

> ⚠️ **Always call this at the start of every D365FO session.** If it reports a placeholder,
> stop and fix `.mcp.json` before creating any files — without the correct model name, new
> objects will land in the wrong model.

**Takes no parameters.**

**Returns:**
- Model name (from `.mcp.json`) and whether it is a placeholder
- Package path and project path
- Environment type (`ude`, `traditional`, or `azure`)
- If placeholder: the real model name auto-detected from `.rnrproj` + exact fix instruction

**Example:**
```
Check my D365FO workspace configuration
What model am I working in?
```

---

## Tips

**You never need to name tools directly.** Just describe what you want:

- "Show me..." → uses get_class_info or get_table_info
- "Find..." → uses search or find_references
- "Create..." → uses analyze_code_patterns + generate_code + create_d365fo_file
- "Extend..." → uses get_method_signature + generate_code
- "Generate a table..." → uses get_table_patterns + generate_smart_table
- "Generate a form..." → uses get_form_patterns + generate_smart_form
- "Create an SSRS report..." → uses get_report_info + generate_smart_report

**Be specific for best results:**
- Vague: "Find customer stuff"
- Better: "Find methods on CustTable for updating the credit limit"

**For CoC extensions, always get the signature first:**
```
Get the signature of CustTable.validateWrite()
Now create a CoC extension that adds credit limit validation
```

**For creating tables/forms, analyze patterns first:**
```
Show me common patterns in Transaction tables
Now generate a transaction table with those patterns
```

**Be specific for best results:**
- Vague: "Find customer stuff"
- Better: "Find methods on CustTable for updating the credit limit"

**For CoC extensions, always get the signature first:**
```
Get the signature of CustTable.validateWrite()
Now create a CoC extension that adds credit limit validation
```
