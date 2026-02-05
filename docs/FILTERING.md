# Filtering Search Results by Object Type

## Overview

The server now supports filtering search results by object type, which corresponds to the original directories in PackagesLocalDirectory:

| `type` Parameter | Corresponding Directory | Description |
|-----------------|------------------------|-------------|
| `class` | `AxClass` | X++ classes |
| `table` | `AxTable` | X++ tables |
| `enum` | `AxEnum` | Enumeration types |
| `field` | - | Table fields |
| `method` | - | Class methods |
| `all` | All | No filtering (default) |

## Using the `search` Tool

### Basic Search (without filter)

```json
{
  "name": "search",
  "arguments": {
    "query": "Customer"
  }
}
```

Returns all symbols containing "Customer" - classes, tables, methods, fields, etc.

### Search Only in Classes (AxClass)

```json
{
  "name": "search",
  "arguments": {
    "query": "Customer",
    "type": "class"
  }
}
```

Returns only classes whose name contains "Customer".

### Search Only in Tables (AxTable)

```json
{
  "name": "search",
  "arguments": {
    "query": "Cust",
    "type": "table"
  }
}
```

Returns only tables whose name contains "Cust" (e.g., CustTable, CustTrans, etc.).

### Search Only in Enums (AxEnum)

```json
{
  "name": "search",
  "arguments": {
    "query": "Status",
    "type": "enum"
  }
}
```

Returns only enumerations containing "Status".

### Search Only in Methods

```json
{
  "name": "search",
  "arguments": {
    "query": "validate",
    "type": "method",
    "limit": 50
  }
}
```

Returns only methods with names containing "validate", maximum 50 results.

## Practical Examples

### Example 1: Find All Customer-Related Classes

**Query:**
```json
{
  "name": "search",
  "arguments": {
    "query": "Cust",
    "type": "class",
    "limit": 20
  }
}
```

**Result:**
```
Found 15 matches:

[CLASS] CustTable
[CLASS] CustVendTransOpen
[CLASS] CustParameters
[CLASS] CustCollectionLetterJour
...
```

### Example 2: Find All Validation Methods in the System

**Query:**
```json
{
  "name": "search",
  "arguments": {
    "query": "validate",
    "type": "method",
    "limit": 30
  }
}
```

**Result:**
```
Found 28 matches:

[METHOD] CustTable.validateField - boolean validateField(FieldId fieldId)
[METHOD] VendTable.validateWrite - boolean validateWrite()
[METHOD] SalesTable.validateDelete - boolean validateDelete()
...
```

### Example 3: Find All Fields Containing "Amount"

**Query:**
```json
{
  "name": "search",
  "arguments": {
    "query": "Amount",
    "type": "field",
    "limit": 40
  }
}
```

**Result:**
```
Found 35 matches:

[FIELD] SalesLine.LineAmount - Real
[FIELD] SalesLine.TaxAmount - TaxAmount
[FIELD] CustTrans.AmountCur - AmountCur
...
```

## Benefits of Filtering

1. **Faster Search** - Smaller result set enables faster processing
2. **More Accurate Results** - Type filtering eliminates irrelevant results
3. **Better Clarity** - Easier to navigate through results
4. **Targeted Search** - When you know what you're looking for (class, table, method), you can specify it directly

## Caching

Search results are cached in Redis (if configured). Each combination of `query`, `type`, and `limit` has its own cache key, so different filters don't return incorrect data from cache.

Example cache keys:
- `xpp:search:Customer:all:20` - all types
- `xpp:search:Customer:class:20` - only classes
- `xpp:search:Customer:table:20` - only tables

## Implementation Notes

- Filtering occurs at the SQL query level in the SQLite database
- Uses FTS5 (Full-Text Search) for fast searching
- Index is created during metadata import using the `build-database` script
- Metadata is extracted from `PackagesLocalDirectory/[Model]/AxClass`, `AxTable`, `AxEnum`, etc.
