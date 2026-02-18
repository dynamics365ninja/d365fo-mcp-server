# All Available Tools

When you ask GitHub Copilot a question about D365FO code, it automatically calls one of these
20 tools to look up the answer or generate code. You do not need to name the tools yourself —
just ask in plain English.

---

## Quick Reference

### Search and Discovery (7 tools)

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **search** | Find any X++ symbol by name or keyword | "Find classes related to dimension posting" |
| **batch_search** | Search multiple things at once (3× faster) | "Find SalesTable, CustTable, and InventTable" |
| **search_extensions** | Search only in your custom/ISV code | "Find my custom extensions for CustTable" |
| **get_class_info** | Full class details: methods, source code, inheritance | "Show me everything about SalesFormLetter" |
| **get_table_info** | Full table schema: fields, indexes, relations | "Show me fields and relations on CustTable" |
| **get_enum_info** | All enum values with integer values and labels | "What values does SalesStatus have?" |
| **code_completion** | List methods/fields on a class or table | "What methods start with 'calc' on SalesTable?" |

### Advanced Object Info (5 tools)

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **get_form_info** | Form structure: datasources, controls, methods | "Show me the datasources in SalesTable form" |
| **get_query_info** | Query structure: datasources, joins, ranges | "Analyze CustTransOpenQuery" |
| **get_view_info** | View/data entity: fields, relations, methods | "Show me GeneralJournalAccountEntryView" |
| **get_method_signature** | Exact signature for CoC extensions | "Get signature of CustTable.validateWrite()" |
| **find_references** | Where is this class/method/field used? | "Where is DimensionAttributeValueSet used?" |

### Intelligent Code Generation (4 tools)

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **analyze_code_patterns** | Learn real patterns from your codebase | "Show me patterns for ledger journal creation" |
| **suggest_method_implementation** | Real examples of how similar methods are written | "How do others implement validateWrite()?" |
| **analyze_class_completeness** | Which standard methods is my class missing? | "Is MyHelper class complete?" |
| **get_api_usage_patterns** | How is a specific API typically initialized and used? | "How do I use LedgerJournalEngine?" |

### File Operations (3 tools)

| Tool | Works where | What it does |
|------|------------|-------------|
| **generate_d365fo_xml** | Anywhere (cloud + local) | Returns XML content — Copilot then creates the file |
| **create_d365fo_file** | Local Windows VM only | Creates the physical file and adds it to the VS project |
| **modify_d365fo_file** | Local Windows VM only | Safely edits an existing file with automatic backup |

### Analysis (1 tool)

| Tool | What it does | Example prompt |
|------|-------------|---------------|
| **generate_code** | Generate X++ boilerplate (class, batch job, CoC, etc.) | "Generate a batch job class for order processing" |

---

## Tool Details

### search

Searches all 584 799+ D365FO symbols. Understands type filters so you can narrow results.

**Supported types:** class, table, method, field, enum

**Examples:**
```
Find classes related to sales invoice posting
Search for tables used in customer management
Find methods that calculate tax
Find fields named Invoice across all tables
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
Search for AslCore helper classes
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
| `data-entity` | Data entity class with `find()`, `exist()`, `validateWrite()` |
| `batch-job` | SysOperationServiceController + service class with `process()` |
| `table-extension` | Table extension with `validateWrite()`, `modifiedField()` |

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

**Requires:** MCP server running on a local Windows machine with K:\ drive access.

**Examples:**
```
Create a class MyHelper and add it to my project
Create a table extension for InventTable in my model
```

---

### generate_d365fo_xml

Returns the D365FO XML content as text. Works everywhere — Azure, local, any OS.
Copilot then writes the content to a file using VS Code's file tools.

Use this when the MCP server is hosted in Azure and does not have local file system access.

---

### modify_d365fo_file

Edits an existing D365FO XML file safely:
1. Creates a backup (`.bak`) before touching anything
2. Makes the change (add/edit/remove a method or field)
3. Validates that the XML is still well-formed
4. Rolls back from the backup if anything goes wrong

**Requires:** MCP server running on a local Windows machine with K:\ drive access.

**Examples:**
```
Add a method calculateDiscount() to MyCustomHelper
Add a field CreditStatus to MyCustomTable
```

---

## Tips

**You never need to name tools directly.** Just describe what you want:

- "Show me..." → uses get_class_info or get_table_info
- "Find..." → uses search or find_references
- "Create..." → uses analyze_code_patterns + generate_code + create_d365fo_file
- "Extend..." → uses get_method_signature + generate_code

**Be specific for best results:**
- Vague: "Find customer stuff"
- Better: "Find methods on CustTable for updating the credit limit"

**For CoC extensions, always get the signature first:**
```
Get the signature of CustTable.validateWrite()
Now create a CoC extension that adds credit limit validation
```
