# D365FO MCP Server - Usage Examples

Practical examples for X++ code completion and symbol lookup in Visual Studio Code with GitHub Copilot.

## Table of Contents

- [Code Completion](#code-completion)
- [Symbol Search](#symbol-search)
- [Class & Table Information](#class--table-information)
- [Extension Development](#extension-development)
- [Code Generation](#code-generation)
- [Pattern Analysis & Intelligent Code Generation](#pattern-analysis--intelligent-code-generation)
- [Configuration](#configuration)

---

## Code Completion

The primary purpose of this MCP server is to provide intelligent code completion for X++ development.

### Finding Methods on a Class

**Scenario:** You're working with `SalesTable` and need to find the right method.

```
What methods are available on SalesTable that relate to totals?
```

**Returns:** `updateSalesOrderTotals()`, `calcTotals()`, `initFromSalesLine()` with signatures and return types.

---

### Getting Field Names for a Table

**Scenario:** Writing a query and need exact field names.

```
List all fields on CustTable
```

**Returns:** All 200+ fields with types (e.g., `AccountNum` (EDT: CustAccount, Mandatory: Yes))

---

## Symbol Search

Fast full-text search across all X++ symbols.

### Finding Classes by Functionality

**Scenario:** Need to find classes related to posting sales invoices.

```
Search for classes related to sales invoice posting
```

**Returns:** `SalesInvoiceJournalPost`, `SalesInvoiceController`, `CustInvoiceJour` (relevance-ranked)

---

## Class & Table Information

### Understanding Class Hierarchy

**Scenario:** Before extending a class, you need to understand its inheritance.

```
Show me the inheritance hierarchy for SalesFormLetter
```

**Returns:**
```
SalesFormLetter → FormLetter → RunBase → Object
```

---

### Getting Table Relations

**Scenario:** Understanding foreign keys before writing joins.

```
Show me all relations on SalesLine
```

**Returns:** Relations to `SalesTable`, `InventTable`, `InventDim` with delete actions

---

## Extension Development

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

## Code Generation

### Runnable Class

```
Generate a runnable class for customer data cleanup
```

**Returns:** Complete runnable class with `main()`, `run()`, dialog parameters, and info logging.

---

### Batch Job with SysOperation

```
Create a batch job for processing open sales orders
```

**Returns:** Controller class, Service class, Data contract class, and Batch job registration.

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

---

### Getting Implementation Suggestions

**Scenario:** You're creating a helper class and need to implement a `validate()` method.

```
Suggest implementation for validate method in my DimensionHelper class
```

**Returns:**
- Similar validate methods from your codebase
- Implementation patterns (error handling, parameter validation, etc.)
- Complete code examples with complexity analysis

**Common Method Patterns:**
- `validate*` - Returns boolean, includes error handling
- `find*` - Query patterns with null checks
- `create*` - Initialization and insertion patterns with tts
- `update*` - Modification patterns with ttsbegin/ttscommit
- `delete*` - Cleanup patterns with cascade logic

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

**Example Output:**
```
🔴 validate: Found in 85% of similar classes (17/20)
🟠 checkMandatoryFields: Found in 65% of similar classes (13/20)
🟡 copyToClipboard: Found in 35% of similar classes (7/20)
```

---

### Getting API Usage Patterns

**Scenario:** You need to use `DimensionAttributeValueSet` but don't know the correct initialization sequence.

```
Show me how to use DimensionAttributeValueSet API
```

**Returns:**
- Common initialization patterns
- Typical method call sequences
- Complete working examples from your codebase
- Related APIs often used together

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

### Combining Intelligent Tools - Complete Workflow

**Example:** Creating a new posting service

1. **Analyze patterns:** `Analyze code patterns for inventory posting`  
   → Identifies `InventMovement`, `InventUpd_*`, `TmpInventTransMark`

2. **Check completeness:** `Analyze my InventPostingService class for completeness`  
   → Suggests: `validateBeforePost`, `createJournal`, `updateInventory`

3. **Get implementation:** `Suggest implementation for validateBeforePost`  
   → Shows similar validation methods with error handling

4. **Learn API usage:** `Show me how to use InventMovement API`  
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
EXTRACT_MODE=custom
```

### Searching Custom Extensions Only

```
Search my custom ISV_ extensions for sales modifications
```

Filters results to only your custom models - useful when you have 500+ standard models indexed.

---

## Tips for Effective Use

### Be Specific
- ❌ `Find customer stuff`  
- ✅ `Find methods on CustTable for updating credit limit`

### Use Exact Names When Known
- ❌ `sales table class`  
- ✅ `SalesTable` or `SalesFormLetter`

### Combine Queries
```
Show me SalesTable relations and generate a query to join with CustTable
```

---

## Related Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) - System design
- [CUSTOM_EXTENSIONS.md](CUSTOM_EXTENSIONS.md) - ISV configuration
- [SETUP.md](SETUP.md) - Installation guide
