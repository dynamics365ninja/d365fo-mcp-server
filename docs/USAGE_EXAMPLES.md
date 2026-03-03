# Usage Examples

Practical examples you can copy and paste directly into Copilot Chat.

## Table of Contents

- [Searching for Code](#searching-for-code)
- [Exploring Classes and Tables](#exploring-classes-and-tables)
- [Chain of Command Extensions](#chain-of-command-extensions)
- [Generating New Classes](#generating-new-classes)
- [Creating Files](#creating-files)
- [Where-Used Analysis](#where-used-analysis)
- [Batch Jobs (SysOperation)](#batch-jobs-sysoperation)
- [Financial Dimensions](#financial-dimensions)
- [Ledger Journals](#ledger-journals)
- [Form Extensions](#form-extensions)
- [Working with Labels](#working-with-labels)
- [Security and Extensions](#security-and-extensions)

---

## Searching for Code

### Find a class by name or concept
```
Find all classes related to sales invoice posting
```
Returns: SalesInvoiceJournalPost, SalesInvoiceController, CustInvoiceJour...

### Find classes, tables, and methods at once
```
Find the SalesTable class, SalesLine table, and any helper classes for sales processing
```
Runs three searches in parallel and combines the results.

### Search only your custom code
```
Find my custom extensions for CustTable
Show me all ISV_ helper classes
Find classes in the MyModel model
```

### Find a method across all classes
```
Find all validateWrite methods in the codebase
Search for methods that handle credit limit validation
```

---

## Exploring Classes and Tables

### View all methods on a class
```
Show me all methods on CustTable
What methods does SalesFormLetter have?
```

Returns each method with its full signature and a brief description.

### View table fields and relations
```
Show me the fields and relations on SalesLine
What is the primary key of CustTable?
List all foreign keys on InventTable
```

### Explore a form's structure
```
Show me the datasources and buttons in the SalesTable form
What methods does the CustTable form override?
```

### Look up enum values
```
What values does SalesStatus have?
Show me all values in CustAccountType enum
```

Returns each value with its integer value and label.

### Find methods by prefix (IntelliSense-style)
```
What methods on SalesTable start with "calc"?
Show me all "find" methods on CustTable
List methods starting with "init" on InventTable
```

---

## Chain of Command Extensions

### Get the exact method signature first
```
Get the signature of CustTable.validateWrite()
```

Returns the exact signature you must match:
```xpp
public boolean validateWrite()
```

### Create the extension
```
Create a CoC extension for CustTable.validateWrite() that checks credit limit
```

Copilot will:
1. Call `get_method_signature` to get the exact signature
2. Analyze similar validation patterns in your code
3. Generate the complete extension class with `[ExtensionOf(tableStr(CustTable))]`

### Table extension with modifiedField
```
Create a table extension for SalesLine that overrides modifiedField for the ItemId field
```

---

## Generating New Classes

### Helper class
```
Create a helper class for validating vendor transactions
```

Copilot will:
1. Analyze helper class patterns in your codebase
2. Find similar helper classes (e.g., CustHelper, VendHelper)
3. Generate a new class following your team's style

### Service class
```
Create a service class for processing inventory adjustments
```

### Class with custom logic
```
Analyze patterns for customer credit management, then create a helper class
that validates credit limits and blocks orders when the limit is exceeded
```

---

## Creating Files

### Create a class and add it to the project (local VM)
```
Create a class MyInventoryHelper and add it to my Visual Studio project
```

The server automatically:
- Detects the model from your open `.rnrproj`
- Creates the XML in the correct AOT path
- Adds the file to the project

### Create a table extension (local VM)
```
Create a table extension for InventTable with a custom field VendorCategory
```

### Generate XML only (Azure/cloud server)
```
Generate the XML for a class MyHelper in the MyModel model
```

Returns the XML content. Copilot then creates the file in your workspace.

---

## Where-Used Analysis

### Find all usages of a class
```
Where is DimensionAttributeValueSet used in the codebase?
```

Returns file paths, method names, and code snippets for each usage.

### Find all callers of a method
```
Find all places where CustTable.validateWrite() is called
Which classes call SalesTable.insert()?
```

### Find usages of a field
```
Where is SalesLine.RemainSalesPhysical accessed?
Find all references to CustTable.CreditLimit
```

---

## Batch Jobs

### Generate a complete batch job
```
Create a batch job that processes all open customer invoices older than 30 days
and sends them to a collection agency
```

Copilot will:
1. Analyze batch job patterns in your codebase
2. Generate a controller class (SysOperationServiceController)
3. Generate a service class with the `process()` method
4. Include standard patterns: error handling, progress reporting, ttsbegin/ttscommit

### Based on existing patterns
```
Analyze batch job patterns in my code, then create a batch job for
recalculating inventory costs
```

---

## Financial Dimensions

### Understand how dimensions work
```
How is DimensionAttributeValueSet typically initialized and used?
Show me how financial dimensions are stored on ledger transactions
```

### Generate dimension handling code
```
Analyze dimension handling patterns in my code, then create a helper
method that copies default dimensions from CustTable to a ledger journal line
```

---

## Ledger Journals

### Understand the structure
```
Show me the structure of LedgerJournalTable and LedgerJournalTrans
How is LedgerJournalCheckPost used in the codebase?
```

### Generate journal creation code
```
Analyze ledger journal creation patterns, then create methods to:
1. Create a general ledger journal header
2. Add one journal line with an account and offset account
3. Post the journal
```

---

## Form Extensions

### Understand the form first
```
Show me the structure of the SalesTable form: datasources, buttons, and methods
```

### Create a form extension
```
Create a form extension for SalesTable that adds a custom button
called "Send to approval" and shows a message when clicked
```

### Add a datasource method
```
Show me the SalesTable form datasource methods, then create an
extension that overrides the active() method to filter records
```

---

## Common Questions

**Do I need to say which tool to use?**
No. Just describe what you want and Copilot picks the right tool automatically.

**How fast are the searches?**
Under 50 ms for most queries. The database has 584 799+ symbols fully indexed.

**Can I search only my own code?**
Yes. Say "search my custom extensions" or "find ISV_ classes" and the search will
exclude all standard Microsoft symbols.

**Does file creation work when the server is on Azure?**
The server generates the XML content and Copilot creates the file using VS Code's
file tools. Full automation (write + add to project) requires the server running locally.

**What if Copilot generates the wrong model name?**
Add a `workspacePath` to your `.mcp.json` or check that your solution is open
in Visual Studio. See [WORKSPACE_DETECTION.md](WORKSPACE_DETECTION.md).

---

## Working with Labels

### Find an existing label before creating a new one

Always search first — reusing an existing label avoids duplication and saves translation effort.

```
Find a label for the text "customer account" in MyModel
```

Copilot will:
1. Call `search_labels` with full-text search across label IDs, text, and comments
2. Return matching labels with their `@LabelFileId:LabelId` reference
3. Show the label text and a ready-to-use X++ snippet

```
Search for labels about "invoice" in the MyModel model
Find all labels matching "vendor" in English
```

### View all translations for a label

```
Show me all translations of label MyFeature in MyModel
```

Copilot will:
1. Call `get_label_info` with the label ID
2. Return translations in every indexed language (en-US, cs, de, sk…)
3. Show the developer comment and generate X++ / XML usage snippets:
   - X++: `literalStr("@MyModel:MyFeature")`
   - XML: `<Label>@MyModel:MyFeature</Label>`

### List all label files in a model

```
What label files does the MyModel model have?
List all AxLabelFile IDs available in MyModel
```

Copilot will call `get_label_info` without a label ID and return a table of
file IDs, supported languages, and label counts.

### Create a new label with all language translations

```
Create a new label MyNewField in the MyModel model with the text:
- en-US: "Customer account number"
- cs: "Číslo účtu zákazníka"
- de: "Kundenkontaktsnummer"
- sk: "Číslo účtu zákazníka"
```

Copilot will:
1. Call `search_labels` first to confirm the label doesn't already exist
2. Call `create_label` with the translations for all supported languages
3. Insert the label alphabetically into every `.label.txt` file
4. Update the MCP index so the new label is immediately searchable
5. Return the ready-to-use reference: `@MyModel:MyNewField`

### Rename an existing label ID

Use this when you want to rename a label ID (e.g. after a refactoring) while keeping all translations
and automatically updating every reference in X++ source and XML metadata.

```
Rename label OldFeatureName to NewFeatureName in MyModel
Rename label @MyModel:InvoiceTotal to @MyModel:InvoiceAmountTotal
```

Copilot will:
1. Call `search_labels` to confirm `OldFeatureName` exists in `MyModel`
2. Confirm `NewFeatureName` is not already taken (to avoid collisions)
3. Rename the entry in every `.label.txt` file (all languages) in `MyModel`
4. Replace every `@MyModel:OldFeatureName` reference in `.xpp` and `.xml` files
5. Update the MCP index so the new ID is immediately searchable
6. Return a summary: files modified, references replaced

**Dry-run first** — safe to preview before applying:

```
Preview renaming label OldFeatureName to NewFeatureName in MyModel (dry run)
```

Copilot will report how many references would be replaced without writing any files.

### Use a label in X++ code and metadata

After searching for or creating a label:

```
How do I use label @MyModel:MyNewField in X++ code?
Generate the metadata XML property for @MyModel:MyNewField
```

In X++ source code:
```xpp
str labelText = literalStr("@MyModel:MyNewField");
```

In metadata XML (field property):
```xml
<Label>@MyModel:MyNewField</Label>
<HelpText>@MyModel:MyNewFieldHelp</HelpText>
```

### Check a label in a specific language

```
Find the Czech translation of label BatchGroup in MyModel
Search for labels containing "dávk" in Czech (cs) language
```

Use the `language` parameter in `search_labels` to restrict results to a
specific locale.

---

## Security and Extensions

### Trace the security chain for a form

```
What roles have access to the CustTable form?
```

Copilot calls `get_security_coverage_for_object` and returns the complete chain:
form → menu items → privileges → duties → roles. No AOT browsing required.

```
Who has access to the SalesTable form?
Which roles can open the VendTable form?
```

### Inspect a security privilege

```
Show me everything in the CustTableFullControl privilege
What entry points does the CustTableView privilege require?
```

Copilot calls `get_security_artifact_info` with `artifactType: privilege` and returns
the privilege label, every entry point name, object type, and access level granted.

### Trace a duty and its privileges

```
Show me the full privilege chain for the CustTableMaintain duty
Which privileges are in the AccountsPayableInquire duty?
```

With `includeChain: true` (the default), Copilot walks: Duty → Privileges → EntryPoints
and returns the full three-level breakdown in one response.

### Check what CoC extensions already exist

Before you write a new Chain of Command extension, check whether the method is already
wrapped — avoids duplicating logic or breaking existing wrappers.

```
Does CustTable.validateWrite have any CoC extensions?
Are there any CoC wrappers for SalesFormLetter.run()?
```

Copilot calls `find_coc_extensions` and lists every extension class that wraps the method,
which model it belongs to, and whether it calls `next`.

### Find event handlers for a table

```
Who handles the onInserted event of SalesLine?
Are there any event handlers subscribed to CustTable events?
```

Copilot calls `find_event_handlers` and lists all `[SubscribesTo]` static methods
for the table, grouped by event name (onInserted, onUpdated, onValidatedWrite, …).

### See what a table extension adds

```
What extra fields has any ISV added to CustTable?
Show me all extensions of the InventTable table
```

Copilot calls `get_table_extension_info` and returns each extension's model, added fields,
added indexes, and added methods — plus an effective schema that merges base + extensions.

### Inspect a data entity

```
Show me the CustCustomerV3Entity data entity
Is CustCustomerV3Entity available via OData?
What tables does SalesOrderHeaderV2Entity read from?
```

Copilot calls `get_data_entity_info` and returns: entity category, `PublicEntityName` (OData
resource name), whether OData and DMF are enabled, data sources, field-to-table mapping,
and entity keys.

### Discover what you can extend on an object

Before writing an extension you want to know: which methods are CoC-eligible, which are
blocked with `final`, and whether any events are already subscribed.

```
What can I extend on SalesLine?
What CoC-eligible methods does SalesFormLetter have?
Are any methods on CustTable blocked from CoC?
```

Copilot calls `analyze_extension_points`, returns a categorised list: CoC-eligible, final
(blocked), delegate hooks, table events, and any already-extended points.

### Validate an extension name before you create it

```
Is SalesTableExtension a valid name for a class extension of SalesTable?
Validate the name SalesTable.WHSExtension as a table extension
Is MyOrderTableMaintain a valid security privilege name?
```

Copilot calls `validate_object_naming`, checks D365FO naming conventions
(e.g. `{Base}{Prefix}_Extension` for class extensions, `{Base}.{Prefix}Extension` for AOT
extensions), detects conflicts against the 584K+ symbol index, and suggests the correct name.

### Create a SysOperation batch job

```
Create a SysOperation batch job for nightly invoice calculation
Generate a SysOperation DataContract + Controller + Service for vendor aging report processing
```

Copilot calls `generate_code` with `pattern: sysoperation` and produces all three classes:
`DataContract`, `Controller`, and `Service` — ready to paste into Visual Studio.

### Create event handlers for a table

```
Create an event handler class for SalesLine that handles onInserted and onValidatedWrite
Generate a [SubscribesTo] event handler for CustTable.onInserted
```

Copilot calls `generate_code` with `pattern: event-handler` and generates a static handler
class with correctly typed sender arguments and `delegateStr()` references.
