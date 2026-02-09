# D365FO MCP Server - Usage Examples

Practical examples for X++ code completion and symbol lookup in Visual Studio Code with GitHub Copilot.

## Table of Contents

- [Code Completion (Primary Use Case)](#code-completion-primary-use-case)
- [Symbol Search](#symbol-search)
- [Class Information](#class-information)
- [Table Information](#table-information)
- [Extension Development](#extension-development)
- [Code Generation](#code-generation)
- [Pattern Analysis & Intelligent Code Generation](#pattern-analysis--intelligent-code-generation)
- [Configuration](#configuration)

---

## Code Completion (Primary Use Case)

The primary purpose of this MCP server is to provide intelligent code completion for X++ development. When you're writing code and need to know what methods or fields are available, just ask.

### Finding Methods on a Class

**Scenario:** You're working with `SalesTable` and need to find the right method to update totals.

```
What methods are available on SalesTable that relate to totals?
```

**Response includes:**
- `updateSalesOrderTotals()`
- `calcTotals()`
- `initFromSalesLine()`
- Method signatures and return types

---

### Getting Field Names for a Table

**Scenario:** Writing a query and need exact field names for `CustTable`.

```
List all fields on CustTable
```

**Response includes:**
- `AccountNum` (EDT: CustAccount, Mandatory: Yes)
- `CustGroup` (EDT: CustGroupId)
- `Currency` (EDT: CurrencyCode)
- All 200+ fields with types

---

### Finding Methods Starting with Specific Prefix

**Scenario:** You know there's a `find*` method but can't remember the exact name.

```
What methods on InventTable start with "find"?
```

**Response:**
- `find(ItemId _itemId, boolean _forUpdate = false)`
- `findByProduct(RecId _product)`
- `findRecId(RecId _recId)`
- `findByItemIdLegalEntity(...)`

---

### Discovering Available parm Methods

**Scenario:** Working with a class that uses the parm pattern.

```
Show me all parm methods on SalesFormLetter
```

**Response lists:**
- `parmCallerTable()`
- `parmDocumentStatus()`
- `parmVersioningUpdateType()`
- Parameter types and return types

---

### Finding Event Handler Methods

**Scenario:** Need to know what events you can subscribe to.

```
What events can I subscribe to on SalesTable?
```

**Response:**
- `onValidatingWrite`
- `onValidatedWrite`
- `onInserting`
- `onInserted`
- `onUpdating`
- `onUpdated`
- `onDeleting`
- `onDeleted`

---

## Symbol Search

Fast full-text search across all X++ symbols when you need to find classes, tables, or enums.

### Finding Classes by Functionality

**Scenario:** Need to find classes related to posting sales invoices.

```
Search for classes related to sales invoice posting
```

**Returns:**
- `SalesInvoiceJournalPost`
- `SalesInvoiceController`
- `CustInvoiceJour`
- Relevance-ranked results

---

### Finding Tables for a Module

**Scenario:** Exploring what tables exist for warehouse management.

```
Find all WHS tables for warehouse work
```

**Returns:**
- `WHSWorkTable`
- `WHSWorkLine`
- `WHSWorkInventTrans`
- `WHSContainerTable`

---

### Finding Enums

**Scenario:** Need the right enum for sales order status.

```
What enums are available for sales order status?
```

**Returns:**
- `SalesStatus`
- `SalesTableStatus`
- `DocumentStatus`
- Enum values for each

---

### Finding Data Entities

**Scenario:** Looking for existing data entities before creating a new one.

```
Search for data entities related to customers
```

**Returns:**
- `CustCustomerV3Entity`
- `CustCustomerGroupEntity`
- `CustCustomerBaseEntity`

---

## Class Information

Get detailed information about X++ classes including inheritance, interfaces, and all members.

### Understanding Class Hierarchy

**Scenario:** Before extending a class, you need to understand its inheritance.

```
Show me the inheritance hierarchy for SalesFormLetter
```

**Returns:**
```
SalesFormLetter
  └── FormLetter
        └── RunBase
              └── Object
```

---

### Finding Overridable Methods

**Scenario:** Need to know what methods you can override in an extension.

```
What protected methods can I override in InventMovement?
```

**Returns list of protected and public methods with signatures.**

---

### Understanding Class Interfaces

**Scenario:** Need to implement the same interface as another class.

```
What interfaces does WHSWorkExecuteDisplay implement?
```

**Returns:**
- `WHSWorkExecuteMode`
- `SysPackable`
- Interface method requirements

---

## Table Information

Access complete table metadata including fields, indexes, relations, and field groups.

### Getting Table Relations

**Scenario:** Understanding foreign keys before writing joins.

```
Show me all relations on SalesLine
```

**Returns:**
- `SalesTable` (SalesId → SalesId)
- `InventTable` (ItemId → ItemId)
- `InventDim` (InventDimId → InventDimId)
- Delete actions for each relation

---

### Finding Indexes

**Scenario:** Optimizing a query by using the right index.

```
What indexes exist on CustTrans?
```

**Returns:**
- `AccountIdx` (AccountNum, TransDate)
- `VoucherIdx` (Voucher, TransDate)
- `PaymModeIdx` (PaymMode, AccountNum)
- Unique/non-unique flags

---

### Understanding Field Groups

**Scenario:** Need to know what fields are in AutoReport or AutoLookup.

```
Show me the field groups on SalesTable
```

**Returns:**
- `AutoReport`: SalesId, CustAccount, SalesStatus...
- `AutoLookup`: SalesId, SalesName, CustAccount...
- `Overview`: All overview fields

---

## Extension Development

Guidance for extending standard D365FO functionality with Chain of Command or event handlers.

### Chain of Command Pattern

**Scenario:** Need to extend the `insert` method on `CustTable`.

```
How do I use Chain of Command to extend CustTable.insert()?
```

**Returns:**
```xpp
[ExtensionOf(tableStr(CustTable))]
final class CustTable_Extension
{
    public void insert()
    {
        // Pre-logic
        
        next insert();
        
        // Post-logic
    }
}
```

---

### Event Handler Pattern

**Scenario:** Need to react when a sales order is validated.

```
Show me how to create an event handler for SalesTable onValidatedWrite
```

**Returns:**
```xpp
public class SalesTable_EventHandler
{
    [DataEventHandler(tableStr(SalesTable), DataEventType::ValidatedWrite)]
    public static void SalesTable_onValidatedWrite(Common sender, DataEventArgs e)
    {
        SalesTable salesTable = sender as SalesTable;
        // Your logic here
    }
}
```

---

### Finding What to Extend

**Scenario:** Need to add custom logic to sales invoice posting.

```
What class should I extend to add custom logic during sales invoice posting?
```

**Returns:**
- `SalesInvoiceJournalPost` - Main posting class
- Key methods: `postLine()`, `postHeader()`
- Extension points available

---

## Code Generation

Generate X++ code templates following D365FO best practices.

### Runnable Class

```
Generate a runnable class for customer data cleanup
```

**Returns complete runnable class with:**
- `main()` method
- `run()` implementation
- Dialog parameters
- Info logging

---

### Batch Job with SysOperation

```
Create a batch job for processing open sales orders
```

**Returns:**
- Controller class
- Service class  
- Data contract class
- Batch job registration

---

### Data Entity

```
Generate a data entity for custom table MyCustomTable
```

**Returns:**
- Entity class structure
- Staging table template
- Field mappings
- Public entity name

---

### Form Extension

```
Create a form extension for CustTable form to add a new button
```

**Returns:**
- Form extension class
- Button event handler
- Menu item binding

---

## Pattern Analysis & Intelligent Code Generation

New intelligent tools that learn from your codebase to provide smart suggestions and pattern-based code generation.

### Analyzing Code Patterns

**Scenario:** You need to implement financial dimension handling but don't know which classes and patterns to use.

```
Analyze code patterns for financial dimensions
```

**Returns:**
- Common classes used together (DimensionAttributeValueSet, DimensionStorage, etc.)
- Typical dependencies and relationships
- Frequency analysis showing most-used patterns
- Example code snippets from your codebase

**MCP Tool:** `analyze_code_patterns`

```json
{
  "scenario": "financial dimensions",
  "classPattern": "Dimension",
  "limit": 5
}
```

---

### Getting Implementation Suggestions

**Scenario:** You're creating a helper class and need to implement a `validate()` method but aren't sure of the best approach.

```
Suggest implementation for validate method in my DimensionHelper class
```

**Returns:**
- Similar validate methods from your codebase
- Implementation patterns (error handling, parameter validation, etc.)
- Complete code examples with complexity analysis
- Context-specific suggestions based on method name pattern

**MCP Tool:** `suggest_method_implementation`

```json
{
  "className": "DimensionHelper",
  "methodName": "validate",
  "parameters": ["_dimension", "_value"]
}
```

**Common Method Patterns:**
- `validate*` - Returns boolean, includes error handling patterns
- `find*` - Query patterns with null checks
- `create*` - Initialization and insertion patterns
- `update*` - Modification patterns with ttsbegin/ttscommit
- `delete*` - Cleanup patterns with cascade logic
- `calculate*` - Mathematical operations with unit tests

---

### Analyzing Class Completeness

**Scenario:** You created a new `CustTableHelper` class and want to ensure it follows common patterns.

```
Analyze my CustTableHelper class for completeness
```

**Returns:**
- List of existing methods in your class
- Suggested missing methods based on similar Helper classes
- Importance ranking (🔴 Very common, 🟠 Common, 🟡 Somewhat common)
- Percentage of similar classes that implement each method

**MCP Tool:** `analyze_class_completeness`

```json
{
  "className": "CustTableHelper"
}
```

**Example Output:**
```
🔴 validate: Found in 85% of similar classes (17/20)
🟠 checkMandatoryFields: Found in 65% of similar classes (13/20)
🟡 copyToClipboard: Found in 35% of similar classes (7/20)
```

---

### Getting API Usage Patterns

**Scenario:** You need to use `DimensionAttributeValueSet` but don't know the correct initialization and method call sequence.

```
Show me how to use DimensionAttributeValueSet API
```

**Returns:**
- Common initialization patterns
- Typical method call sequences
- Complete working examples from your codebase
- Related APIs often used together
- Common parameters and their typical values
- Error handling patterns
- Best practices

**MCP Tool:** `get_api_usage_patterns`

```json
{
  "apiName": "DimensionAttributeValueSet",
  "context": "initialization"
}
```

**Example Output:**
```xpp
// Typical initialization
DimensionAttributeValueSet valueSet;
DimensionAttribute attribute;

attribute = DimensionAttribute::findByName('Department');
valueSet = DimensionAttributeValueSet::construct();

// Common method sequence
valueSet.addDimension(attribute, dimensionValue);
valueSet.save();
```

---

### Combining Intelligent Tools

**Workflow Example:** Creating a new posting service

1. **Analyze patterns:**
   ```
   Analyze code patterns for inventory posting
   ```
   → Identifies common classes like `InventMovement`, `InventUpd_*`, `TmpInventTransMark`

2. **Check completeness:**
   ```
   Analyze my InventPostingService class for completeness
   ```
   → Suggests missing methods: `validateBeforePost`, `createJournal`, `updateInventory`

3. **Get implementation:**
   ```
   Suggest implementation for validateBeforePost in InventPostingService
   ```
   → Shows similar validation methods with error handling patterns

4. **Learn API usage:**
   ```
   Show me how to use InventMovement API
   ```
   → Provides initialization patterns and method sequences

---

## Configuration

### MCP Client Setup (`.mcp.json`)

```json
{
  "servers": {
    "xpp-completion": {
      "url": "https://your-app.azurewebsites.net/mcp/",
      "description": "X++ Code Completion Server"
    }
  }
}
```

### Extension Prefix Configuration (`.env`)

```env
# Your custom model prefixes for filtering
EXTENSION_PREFIX=ISV_
CUSTOM_MODELS=ISV_Sales,ISV_Inventory

# Extraction mode
EXTRACT_MODE=custom
```

### Searching Custom Extensions Only

```
Search my custom ISV_ extensions for sales modifications
```

This filters results to only your custom models, useful when you have 500+ standard models indexed.

---

## Tips for Effective Use

### Be Specific
Instead of: `Find customer stuff`  
Use: `Find methods on CustTable for updating credit limit`

### Use Exact Names When Known
Instead of: `sales table class`  
Use: `SalesTable` or `SalesFormLetter`

### Combine Queries
```
Show me SalesTable relations and generate a query to join with CustTable
```

### Ask for Patterns
```
What's the standard pattern for implementing a number sequence in X++?
```

---

## Troubleshooting

### No Results
- Verify the metadata database exists
- Check if the symbol name is correct (X++ is case-insensitive but search may not be)
- Try broader search terms

### Missing Custom Models
- Verify `CUSTOM_MODELS` environment variable
- Check `EXTENSION_PREFIX` matches your naming convention
- Re-run extraction pipeline

### Slow Responses
- Enable Redis caching (`REDIS_ENABLED=true`)
- Check Azure App Service performance tier

---

## Related Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - System design
- [CUSTOM_EXTENSIONS.md](CUSTOM_EXTENSIONS.md) - ISV configuration
- [PIPELINES.md](PIPELINES.md) - Azure DevOps automation
- [SETUP.md](SETUP.md) - Installation guide
