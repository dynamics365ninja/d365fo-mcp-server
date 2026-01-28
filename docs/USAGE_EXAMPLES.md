# D365FO MCP Server - Usage Examples

This guide provides practical examples of how to use the D365FO MCP Server with modern MCP clients like GitHub Copilot. With newer MCP extensions, you can interact naturally without needing to use command prefixes like `@xpp-completion`.

## Table of Contents

- [Search for X++ Classes or Tables](#search-for-x-classes-or-tables)
- [Get Detailed Class Information](#get-detailed-class-information)
- [Get Table Schema Information](#get-table-schema-information)
- [Search Custom Extensions Only](#search-custom-extensions-only)
- [Method and Field Completion](#method-and-field-completion)
- [Generate X++ Code Templates](#generate-x-code-templates)
- [Combined Queries](#combined-queries)
- [Code Review and Analysis](#code-review-and-analysis)
- [Extension Development](#extension-development)
- [Learning and Documentation](#learning-and-documentation)

## Search for X++ Classes or Tables

The MCP server provides fast full-text search across all X++ symbols in your D365FO environment.

### Examples:

```
Find the CustTable class and show me its structure
```

```
Search for all classes related to sales orders
```

```
What tables are available for inventory management?
```

```
Show me all classes that implement the SysOperationServiceController
```

```
Find enums related to payment methods
```

**What happens behind the scenes:** The server uses the `xpp_search` tool to perform FTS5-powered full-text search across classes, tables, enums, and other X++ elements.

---

## Get Detailed Class Information

Get comprehensive information about any X++ class including methods, inheritance, interfaces, and attributes.

### Examples:

```
Show me the methods available in the SalesOrderProcessor class
```

```
What does the CustVendTransPostingLog_RU class do and what methods does it have?
```

```
Get information about the FormLetterService class including inheritance
```

```
What interfaces does the WHSWorkExecute class implement?
```

```
Show me all protected and public methods in the InventMovement class
```

**What happens behind the scenes:** The server uses the `xpp_get_class` tool to retrieve detailed metadata including method signatures, parameters, return types, inheritance hierarchy, and implemented interfaces.

---

## Get Table Schema Information

Access detailed table schemas including fields, field groups, indexes, relations, and delete actions.

### Examples:

```
What are the fields and indexes in the CustTable?
```

```
Show me the schema for InventTable including all relations
```

```
What fields does the SalesTable have?
```

```
List all indexes on the VendTable and their fields
```

```
Show me the foreign key relations for PurchLine
```

**What happens behind the scenes:** The server uses the `xpp_get_table` tool to retrieve comprehensive table metadata including EDT types, mandatory fields, and relationship definitions.

---

## Search Custom Extensions Only

Filter search results to show only your custom ISV models and extensions, perfect for tracking your customizations.

### Examples:

```
Find all my custom ISV extensions related to invoicing
```

```
Search for custom tables with prefix ISV_ that relate to customers
```

```
List my custom modifications to the sales process
```

```
Show me all Custom_ prefixed classes in my extensions
```

```
What custom event handlers have I created for inventory?
```

**What happens behind the scenes:** The server uses the `xpp_search_extensions` tool with configurable prefixes (e.g., "ISV_", "Custom_") to filter results to only your custom models.

---

## Method and Field Completion

Get IntelliSense-style completions for methods and fields on classes and tables.

### Examples:

```
What methods can I call on a CustTable record?
```

```
Show me all available fields for the SalesLine table
```

```
What methods are available on the InventDim class that start with "find"?
```

```
List all parm methods on the SalesFormLetter class
```

```
What fields can I access on WHSWorkLine?
```

**What happens behind the scenes:** The server uses the `xpp_complete_method` tool to provide filtered method and field lists with optional prefix matching.

---

## Generate X++ Code Templates

Generate ready-to-use X++ code templates following D365FO best practices and patterns.

### Examples:

#### Runnable Class
```
Generate a runnable class template for a data migration job
```

#### Batch Job
```
Create a batch job skeleton for processing customer invoices
```

#### Form Event Handler
```
Generate a form event handler for the CustTable form
```

#### Data Entity
```
Create a data entity template for exporting sales orders
```

#### Basic Class
```
Generate a basic X++ class with standard structure
```

#### Service Class
```
Create a service class template for external integrations
```

**What happens behind the scenes:** The server uses the `xpp_generate_code` tool with predefined patterns for common X++ development scenarios.

**Available Patterns:**
- `class` - Basic X++ class with constructor
- `runnable` - Runnable class (extends RunBaseBatch)
- `batch-job` - Batch job with SysOperation framework
- `form-handler` - Form event handler class
- `data-entity` - Data entity with staging table
- `service` - Service class for integration

---

## Combined Queries

Combine multiple operations in a single conversation to streamline your development workflow.

### Examples:

```
Find the SalesFormLetter class and generate a similar class for my custom invoice processing
```

```
Show me the CustInvoiceJour table structure and create a data entity to expose it
```

```
Search for batch job examples and then generate a new batch job for my custom process
```

```
Analyze the InventMovement class design and create a similar class for my warehouse tracking
```

```
Find extension examples for PurchTable and show me how to add my custom fields
```

**What happens behind the scenes:** The server intelligently chains multiple tool calls (search → class info → code generation) to provide comprehensive responses.

---

## Code Review and Analysis

Get AI-powered code reviews based on D365FO best practices and design patterns.

### Examples:

```
Review this X++ code and suggest improvements based on D365FO best practices
```

```
Analyze this class and tell me if I'm following standard patterns
```

```
Is this the correct way to implement table extension methods?
```

```
Check if my batch job follows Microsoft's recommended patterns
```

```
Review my data entity implementation for performance issues
```

**What happens behind the scenes:** The server combines symbol search with X++ best practices knowledge to provide contextual code reviews.

---

## Extension Development

Get guidance and examples for extending standard D365FO functionality.

### Examples:

```
How do I extend the CustTable with a new field?
```

```
Show me examples of event handlers for the SalesTable
```

```
What's the best way to extend the PurchCreateFromSalesOrder class?
```

```
How do I chain of command on the InventMovement class?
```

```
Show me how to subscribe to the onValidateWrite event for VendTable
```

**What happens behind the scenes:** The server provides extension patterns and searches for relevant base class information to guide your implementation.

---

## Learning and Documentation

Use the MCP server as a learning tool to understand D365FO architecture and patterns.

### Examples:

```
Explain how the InventMovement class works
```

```
What design patterns are used in the SalesOrderProcessor class?
```

```
Show me examples of using the Query framework in X++
```

```
How does the dimension framework work in D365FO?
```

```
Explain the difference between CustTable and CustTableExt
```

**What happens behind the scenes:** The server combines class metadata with contextual knowledge to provide educational explanations.

---

## Key Features

### Natural Language Interface
- **No prefix needed** - Just ask naturally as you would with any AI assistant
- **Context-aware** - Understands D365FO terminology and concepts
- **Conversational** - Follow-up questions work seamlessly

### Automatic Tool Selection
- **Tools work automatically** - The MCP server handles tool selection behind the scenes
- **Intelligent routing** - Chooses the right combination of tools for your query
- **Optimized performance** - Uses caching and FTS5 indexing for fast responses

### Comprehensive Coverage
- **Full metadata access** - 500+ standard models indexed
- **Extension-focused** - Special support for ISV/custom model development
- **Code generation** - Ready-to-use templates following best practices

### Developer-Friendly
- **Combines tools** - Can search, analyze, and generate code in a single conversation
- **Real metadata** - Based on actual D365FO XML and code parsing
- **Always up-to-date** - Metadata extracted from your PackagesLocalDirectory

---

## Configuration

The MCP server requires minimal configuration. See your `.mcp.json` for connection details:

```json
{
  "servers": {
    "xpp-completion": {
      "url": "https://your-app.azurewebsites.net/mcp/",
      "description": "X++ Code Completion Server for D365 F&O"
    }
  }
}
```

For custom extensions, configure your `.env` file:

```env
# Custom Extensions Configuration
CUSTOM_MODELS=ISV_Module1,ISV_Module2
EXTENSION_PREFIX=ISV_
EXTRACT_MODE=all  # Options: 'all', 'standard', 'custom'
```

---

## Performance Tips

### Use Specific Queries
Instead of:
```
Find customer stuff
```

Use:
```
Find classes related to customer invoicing in the accounts receivable module
```

### Leverage Extension Search
For ISV development:
```
Search my ISV_ extensions for sales order customizations
```
This is much faster than searching all 500+ standard models.

### Use Code Generation
Instead of manually writing boilerplate:
```
Generate a batch job for updating customer credit limits
```

### Cache Benefits
Frequently accessed data is cached automatically:
- Symbol searches
- Class metadata
- Table schemas
- Code completions

---

## Troubleshooting

### No Results Found
- Check if metadata was extracted: `npm run extract-metadata`
- Verify database exists: Check `DB_PATH` in `.env`
- Try broader search terms

### Slow Responses
- Enable Redis caching: Set `REDIS_ENABLED=true`
- Check Azure App Service scaling
- Review rate limiting settings

### Extension Search Not Working
- Verify `CUSTOM_MODELS` in `.env`
- Check `EXTENSION_PREFIX` matches your naming
- Ensure `EXTRACT_MODE` includes your models

---

## Related Documentation

- [README.md](../README.md) - Main documentation and setup guide
- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture and design
- [CUSTOM_EXTENSIONS.md](CUSTOM_EXTENSIONS.md) - ISV extension configuration
- [PERFORMANCE.md](PERFORMANCE.md) - Performance optimization
- [TESTING.md](TESTING.md) - Testing guide
- [VISUAL_STUDIO_MCP_SETUP.md](VISUAL_STUDIO_MCP_SETUP.md) - Visual Studio integration

---

## Support

For issues, questions, or contributions:
- **GitHub Repository**: [dynamics365ninja/d365fo-mcp-server](https://github.com/dynamics365ninja/d365fo-mcp-server)
- **Report Issues**: [GitHub Issues](https://github.com/dynamics365ninja/d365fo-mcp-server/issues)
- **Discussions**: [GitHub Discussions](https://github.com/dynamics365ninja/d365fo-mcp-server/discussions)
