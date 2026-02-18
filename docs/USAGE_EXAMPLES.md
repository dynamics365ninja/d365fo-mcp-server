# Usage Examples

Practical examples you can copy and paste directly into Copilot Chat.

## Table of Contents

- [Searching for Code](#searching-for-code)
- [Exploring Classes and Tables](#exploring-classes-and-tables)
- [Chain of Command Extensions](#chain-of-command-extensions)
- [Generating New Classes](#generating-new-classes)
- [Creating Files](#creating-files)
- [Where-Used Analysis](#where-used-analysis)
- [Batch Jobs](#batch-jobs)
- [Financial Dimensions](#financial-dimensions)
- [Ledger Journals](#ledger-journals)
- [Form Extensions](#form-extensions)

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
Find classes in the AslCore model
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
Generate the XML for a class MyHelper in the AslCore model
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
