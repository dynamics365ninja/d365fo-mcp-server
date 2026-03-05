# All Available Tools

When you ask GitHub Copilot a question about D365FO code, it automatically calls one of these
41 tools to look up the answer or generate code. You do not need to name the tools yourself —
just ask in plain English.

---

## Quick Reference

### Search and Discovery (8 tools)

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **search** | Find any X++ symbol by name or keyword | "Find classes related to dimension posting" |
| **batch_search** | Search multiple things at once (3× faster) | "Find SalesTable, CustTable, and InventTable" |
| **search_extensions** | Search only in your custom/ISV code | "Find my custom extensions for CustTable" |
| **get_class_info** | Full class details: methods, source code, inheritance | "Show me everything about SalesFormLetter" |
| **get_table_info** | Full table schema: fields, indexes, relations | "Show me fields and relations on CustTable" |
| **get_enum_info** | All enum values with integer values and labels | "What values does SalesStatus have?" |
| **get_edt_info** | Extended Data Type definition: base type, labels, properties | "Show me EDT properties for CustAccount" |
| **code_completion** | List methods/fields on a class or table | "What methods start with 'calc' on SalesTable?" |

### Advanced Object Info (6 tools)

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **get_form_info** | Form structure: datasources, controls, methods | "Show me the datasources in SalesTable form" |
| **get_query_info** | Query structure: datasources, joins, ranges | "Analyze CustTransOpenQuery" |
| **get_view_info** | View/data entity: fields, relations, methods | "Show me GeneralJournalAccountEntryView" |
| **get_report_info** | AxReport structure: datasets, fields, designs, RDL summary | "Show me the dataset fields of InventValue report" |
| **get_method_signature** | Exact signature for CoC extensions | "Get signature of CustTable.validateWrite()" |
| **find_references** | Where is this class/method/field used? | "Where is DimensionAttributeValueSet used?" |

### Intelligent Code Generation (4 tools)

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **analyze_code_patterns** | Learn real patterns from your codebase | "Show me patterns for ledger journal creation" |
| **suggest_method_implementation** | Real examples of how similar methods are written | "How do others implement validateWrite()?" |
| **analyze_class_completeness** | Which standard methods is my class missing? | "Is MyHelper class complete?" |
| **get_api_usage_patterns** | How is a specific API typically initialized and used? | "How do I use LedgerJournalEngine?" |

### Smart Object Generation (3 tools)

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **generate_smart_table** | AI-driven table generation with pattern analysis | "Generate a transaction table with common fields" |
| **generate_smart_form** | AI-driven form generation with pattern analysis (SimpleList, DetailsMaster, ListPage, etc.) | "Create a SimpleList form for MyTable" |
| **suggest_edt** | Suggest EDT for field name using fuzzy matching | "What EDT should I use for CustomerAccount field?" |

### Pattern Analysis (3 tools)

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **get_table_patterns** | Analyze field/index patterns for table groups | "Show me common patterns in Transaction tables" |
| **get_form_patterns** | Analyze datasource/control patterns for forms | "Find forms using CustTable" |
| **generate_code** | Generate X++ boilerplate (class, batch job, CoC, etc.) | "Generate a batch job class for order processing" |

### File Operations (3 tools)

| Tool | Works where | What it does |
|------|------------|-------------|
| **generate_d365fo_xml** | Anywhere (cloud + local) | Returns XML content — Copilot then creates the file |
| **create_d365fo_file** | Local Windows VM only | Creates the physical file and adds it to the VS project |
| **modify_d365fo_file** | Local Windows VM only | Safely edits an existing file with automatic backup |

### Security & Extensions (9 tools)

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **get_security_artifact_info** | Full privilege/duty/role details with hierarchy chain | "Show me everything in the CustTableFullControl privilege" |
| **get_security_coverage_for_object** | Which roles have access to a form or table | "What roles can access the CustTable form?" |
| **get_menu_item_info** | Menu item target, type, and security privilege chain | "What form does the CustTable menu item open?" |
| **find_coc_extensions** | Which classes wrap a method with CoC | "Does CustTable.validateWrite have any CoC wrappers?" |
| **find_event_handlers** | All [SubscribesTo] handlers for table or class events | "Who handles the onInserted event of SalesLine?" |
| **get_table_extension_info** | All extensions of a table: added fields, indexes, methods | "What fields did ISV packages add to CustTable?" |
| **get_data_entity_info** | Data entity category, OData name, data sources, keys | "Show me CustCustomerV3Entity details" |
| **analyze_extension_points** | CoC-eligible methods, delegates, events — what can be extended | "What can I extend on SalesLine?" |
| **validate_object_naming** | Validate proposed extension/object names against D365FO conventions | "Is SalesTableExtension a valid extension class name?" |
| **verify_d365fo_project** | Verify objects exist on disk and are referenced in the .rnrproj file | "Check that all created files are in place" |

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
What does the AslInventByZone report look like — datasets and design?
Find reports related to fixed assets
```

---

### get_form_info

Parses form XML and returns all datasources (with their fields and methods), the control
hierarchy (buttons, grids, groups), and form-level methods.

**Examples:**
```
Show me the datasources in SalesTable form
List all buttons on the CustTable form
What methods does the SalesCreateOrder form have?
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

**Supported object types:** class, table, form, query, view, data-entity, enum, edt, **report**

**Requires:** MCP server running on a local Windows machine with file system access.

**Examples:**
```
Create a class MyHelper and add it to my project
Create a table extension for InventTable in my model
Create a class in the CustomExtensions package, Contoso Utilities model
Create the SSRS report XML for AslMyReport in my model
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

**Requires:** MCP server running on a local Windows machine with file system access.

**Examples:**
```
Add a method calculateDiscount() to MyCustomHelper
Add a field CreditStatus to MyCustomTable
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
    { "objectType": "table",            "objectName": "AslInventByZoneTmp" },
    { "objectType": "report",           "objectName": "AslInventByZone" },
    { "objectType": "menu-item-action", "objectName": "AslInventByZone" }
  ],
  "projectPath": "K:\\AosService\\PackagesLocalDirectory\\fm-mcp\\fm-mcp\\fm-mcp.rnrproj"
}
```

**Example output:**
```
## Verification Results — fm-mcp

| Object | Type | Disk | Project |
|--------|------|------|---------|
| AslInventByZoneTmp | table | ✅ `K:\...\AxTable\AslInventByZoneTmp.xml` | ✅ |
| AslInventByZone | report | ✅ ... | ✅ |
| AslInventByZone | menu-item-action | ❌ Missing — expected: `K:\...\AxMenuItemAction\AslInventByZone.xml` | ✅ |

### Summary
- Checked: 3   On disk ✅: 2   Missing from disk ❌: 1
- In project ✅: 3   Missing from project ❌: 0
```

---

## Tips

**You never need to name tools directly.** Just describe what you want:

- "Show me..." → uses get_class_info or get_table_info
- "Find..." → uses search or find_references
- "Create..." → uses analyze_code_patterns + generate_code + create_d365fo_file
- "Extend..." → uses get_method_signature + generate_code
- "Generate a table..." → uses get_table_patterns + generate_smart_table

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
