# How to Configure GitHub Copilot in Visual Studio 2022 to Use X++ MCP Tools

This guide explains how to configure GitHub Copilot in Visual Studio 2022 to use your X++ MCP tools for D365 Finance & Operations development.

## Solution: System Instructions Prompt

We've created a special MCP prompt called **`xpp_system_instructions`** that instructs GitHub Copilot how to properly use X++ tools during D365 F&O development.

## Requirements

| Component | Version | Notes |
|-----------|---------|-------|
| Visual Studio 2022 | 17.14+ | Required for MCP support |
| GitHub Copilot Extension | Latest | Enterprise or Individual subscription |
| GitHub Copilot Chat | Latest | Agent Mode enabled |
| D365 F&O Dev Tools | Latest | For X++ development |

## Setup

### Step 1: Enable MCP in GitHub Account

Navigate to **GitHub account settings** and enable Editor Preview Features:

👉 https://github.com/settings/copilot/features

> ⚠️ **Important:** Without this setting, MCP tools will not load in GitHub Copilot!

### Step 2: Enable MCP in Visual Studio 2022

1. Open **Tools** → **Options** → **GitHub** → **Copilot**
2. Check: ✅ *"Enable MCP server integration in agent mode"*
3. Click **OK**

### Step 3: Create `.mcp.json` Configuration

In the root folder of your D365 F&O solution, create a `.mcp.json` file:

```json
{
  "servers": {
    "d365fo-code-intelligence": {
      "url": "https://your-app.azurewebsites.net/mcp/",
      "description": "D365 F&O X++ Code Intelligence Server"
    }
  }
}
```

**Notes:**
- For **cloud deployment**: Use your Azure App Service URL
- For **local development**: Use `http://localhost:8080/mcp/`

#### Example for local development:

```json
{
  "servers": {
    "d365fo-xpp-local": {
      "url": "http://localhost:8080/mcp/",
      "description": "D365 F&O X++ Local Development Server"
    }
  }
}
```

### Step 4: Restart Visual Studio

Restart Visual Studio 2022 to load the new configuration.

### Step 5: Verify

1. Open **GitHub Copilot Chat** in Visual Studio
2. Enable **Agent Mode** (robot icon)
3. Type: `@workspace /tools`
4. You should see your X++ MCP tools in the list
## Using in Visual Studio 2022

### Automatic System Instructions

GitHub Copilot automatically loads system instructions when querying X++ MCP tools. No need to manually call the prompt.

### Example Queries in Copilot Chat

Simply ask questions in natural language:

```
💬 "Show me all methods on the InventTable class"

💬 "What fields does CustTable have?"

💬 "Generate a batch job class for processing sales orders"

💬 "Find all custom extensions in my ISV module"

💬 "Help me extend SalesTable validation"
```

GitHub Copilot automatically:
1. Recognizes this is a D365 F&O query
2. Uses the appropriate MCP tool (`get_class_info`, `get_table_info`, etc.)
3. Returns accurate information from your metadata
4. Generates code following D365 F&O best practices

## What System Instructions Do

System instructions tell GitHub Copilot:

### ✅ ALWAYS USE these X++ MCP tools when working with D365 F&O:

1. **`code_completion`** - for IntelliSense/autocomplete on classes and tables
2. **`get_class_info`** - for details about class structure, methods, inheritance
3. **`get_table_info`** - for table structure (fields, indexes, relations)
4. **`search`** - for searching symbols (classes, tables, methods, fields, enums)
5. **`search_extensions`** - for finding only custom/ISV code
6. **`generate_code`** - for generating X++ code templates

### ❌ DO NOT USE for D365 F&O:

- Built-in code completion
- Guessing method names or field names
- Generating code without verifying symbol existence

## Workflow Examples in Visual Studio 2022

### Example 1: Adding a Method to an Existing Class

**Developer in Copilot Chat:** "Add a method to CustTable to calculate total orders"

**GitHub Copilot will:**
```
1. get_class_info("CustTable") → Get class structure from AOT metadata
2. code_completion("CustTable") → Get available API methods
3. Generate Chain of Command extension class
4. Use proper X++ conventions and D365 F&O best practices
```

### Example 2: Writing Query Code

**Developer in Copilot Chat:** "Query all customers with balance > 1000"

**GitHub Copilot will:**
```
1. get_table_info("CustTable") → Get exact field names from AOT
2. search("balance", type="field") → Find exact field name
3. Check indexes for performance optimization
4. Generate optimized X++ query with correct field names
```

### Example 3: Extending Standard Code

**Developer in Copilot Chat:** "Extend SalesTable validation"

**GitHub Copilot will:**
```
1. get_class_info("SalesTable") → Find validation methods in metadata
2. code_completion("SalesTable", "validate") → Get exact method signatures
3. Generate Chain of Command extension class
4. Use proper X++ extension patterns for D365 F&O Cloud
```

## Supported Workflows

| Workflow | How It Helps |
|----------|------------|
| **Code Navigation** | Instantly find classes, methods, and tables without browsing AOT |
| **Code Completion** | Accurate method signatures and field names from your metadata |
| **Code Generation** | Generates boilerplate X++ code following D365 F&O best practices |
| **Code Review** | Analyzes existing code with full metadata context |
| **Learning** | Explores unfamiliar modules using natural language queries |
| **Extension Development** | Finds extension points and generates Chain of Command extensions |

## Available MCP Tools

Complete list of tools available in GitHub Copilot:

| Tool | Description | Example Usage |
|------|-------------|---------------|
| `search` | Search X++ classes, tables, methods, fields | "Find all classes with 'Sales' in name" |
| `search_extensions` | Search only custom/ISV extensions | "Show my custom extensions" |
| `get_class_info` | Detailed info about a class including methods | "What methods does CustTable have?" |
| `get_table_info` | Detailed info about a table, fields, indexes | "Show CustTable structure" |
| `code_completion` | IntelliSense for methods and fields | "What can I call on SalesLine?" |
| `generate_code` | Generate X++ templates | "Generate batch job template" |

## Available Prompts

List of all available prompts for code review and best practices:

```bash
# Show all prompts (from terminal or PowerShell)
curl http://localhost:8080/prompts/list
```

Available prompts:
- **`xpp_system_instructions`** - System instructions for GitHub Copilot (automatically used)
- **`xpp_code_review`** - Review X++ code for best practices
- **`xpp_explain_class`** - Detailed explanation of an X++ class

## Testing in Visual Studio

### Test 1: Verify Tools Loading

1. Open GitHub Copilot Chat
2. Enable Agent Mode
3. Type: `@workspace /tools`
4. Verify you see: `search`, `get_class_info`, `get_table_info`, etc.

### Test 2: Test Functionality

In Copilot Chat, try:

```
What methods are available on InventTable class?
```

Copilot should:
1. Call `get_class_info("InventTable")`
2. Return list of methods from your metadata
3. Display method signatures and descriptions

### Test 3: Code Generation

In Copilot Chat, try:

```
Generate a runnable class that queries CustTable for customers with CreditMax > 10000
```

Copilot should:
1. Call `get_table_info("CustTable")` to get field names
2. Call `generate_code` for batch job template
3. Generate complete X++ code with correct field names

## Troubleshooting

### Tools Not Loading

**Problem:** MCP tools are not visible in Copilot Chat

**Solution:**
1. Verify **Editor Preview Features** are enabled on GitHub
2. Check **Tools → Options → GitHub → Copilot** in VS 2022
3. Verify `.mcp.json` file syntax (use JSON validator)
4. Restart Visual Studio completely (close all windows)

### MCP Server Not Responding

**Problem:** Tools are visible but not returning data

**Solution:**
1. For **local**: Verify server is running (`npm run dev`)
2. For **cloud**: Check that Azure App Service is running
3. Check network connectivity and firewall
4. Check server logs for errors

### Copilot Not Using Tools Automatically

**Problem:** Copilot generates code but doesn't use MCP tools

**Solution:**
1. Explicitly ask: "Use get_class_info to check CustTable methods"
2. Use Agent Mode (@workspace) for better tool detection
3. Restart conversation in Copilot Chat
4. Verify system instructions prompt exists (`xpp_system_instructions`)

### Empty Results from Tools

**Problem:** Tools return empty results or "not found"

**Solution:**
1. Verify you have downloaded metadata: `npm run build-database`
2. Check Redis cache connection (if using)
3. Try broader search with `type='all'`
4. Check spelling of object name (case-sensitive)

## Optimization for ISV/Partner Scenarios

If you're developing custom extensions or working as an ISV partner:

### Configure Custom Models

In the MCP server `.env` file:

```env
# Custom Extensions (ISV scenarios)
CUSTOM_MODELS=ISV_YourCompany,Custom_Module1,Custom_Module2
EXTENSION_PREFIX=ISV_,CUS_
```

### Using search_extensions

To search only your custom code:

```
💬 "Find all my custom ISV extensions for CustTable"
```

Copilot will use `search_extensions` instead of `search`, so you won't see standard Microsoft objects.

## Performance Tips

1. **First query is slower** (~50ms) - subsequent ones are cached (<10ms)
2. **Redis cache** - Enable for production for best performance
3. **Batch queries** - Copilot can call multiple tools at once
4. **Metadata sync** - Regularly update metadata from PackagesLocalDirectory

## Security

### Cloud Deployment (Azure)

- Use **Azure App Service** with authentication
- Enable **Managed Identity** for Blob Storage
- Set **IP restrictions** if needed
- Use **Azure Cache for Redis** with SSL

### On-Premise Deployment

- Restrict access to **internal network only**
- Use **reverse proxy** (nginx/IIS) with authentication
- Regular **metadata backups**

## Related Documentation

- [SETUP.md](./SETUP.md) - Initial MCP server setup
- [USAGE_EXAMPLES.md](./USAGE_EXAMPLES.md) - Usage examples for tools
- [TESTING.md](./TESTING.md) - MCP server testing
- [CUSTOM_EXTENSIONS.md](./CUSTOM_EXTENSIONS.md) - ISV extension configuration
- [PERFORMANCE.md](./PERFORMANCE.md) - Performance optimization
- [README.md](../README.md) - Main documentation

## Summary

✅ **MCP server + GitHub Copilot + Visual Studio 2022 = Powerful X++ development**

System instructions automatically guide GitHub Copilot to use your X++ MCP tools, providing:
- 🎯 **Accurate code completion** from real-time metadata
- ⚡ **Fast search** across 500k+ symbols
- 🔧 **D365 F&O best practices** when generating code
- 🚀 **More productive development** without browsing AOT
