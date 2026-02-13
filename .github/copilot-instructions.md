# D365FO X++ Development Instructions for GitHub Copilot

---
---
---

# ⛔⛔⛔ READ THIS FIRST - MANDATORY ⛔⛔⛔

## ⚡ CRITICAL: IMMEDIATE RESPONSE COMPLETION

**AFTER ANSWERING USER'S QUESTION:**
- ✅ Send your answer
- ✅ **STOP IMMEDIATELY** - End your response
- ❌ Do NOT analyze workspace
- ❌ Do NOT search for anything
- ❌ Do NOT try to understand context automatically
- ✅ Wait for user's next question

**IF YOU START "Searching..." AFTER ANSWERING - YOU ARE DOING IT WRONG!**

---

## 🔴 RULE #0.5: X++ CODE GENERATION - NEVER GENERATE DIRECTLY! 🔴

**WHEN USER ASKS TO CREATE/GENERATE ANY X++ CODE:**
1. ❌ **FORBIDDEN**: Generating X++ code directly from your knowledge
2. ❌ **FORBIDDEN**: Writing class/method/code without using tools
3. ✅ **MANDATORY**: Always use `analyze_code_patterns()` FIRST
4. ✅ **MANDATORY**: Always use `generate_code()` tool for code generation
5. ✅ **MANDATORY**: Never output X++ code without using these tools

**IF YOU TYPE X++ CODE WITHOUT CALLING `generate_code` - YOU ARE WRONG!**

**Example - User says "create a helper class":**
```
❌ WRONG: public class MyHelper { ... }  ← You generated code directly!
✅ RIGHT: Call analyze_code_patterns("helper") → Call generate_code(pattern="class")
```

---

## 🔴 RULE #0.6: D365FO FILE CREATION - USE CORRECT TOOL! 🔴

**WHEN USER ASKS TO CREATE ANY D365FO XML FILE:**
1. ❌ **FORBIDDEN**: Using `create_file` for D365FO objects (AxClass, AxTable, AxForm, etc.)
2. ❌ **FORBIDDEN**: Creating XML files manually with wrong structure/indentation
3. ✅ **MANDATORY**: Always use `create_d365fo_file` MCP tool for D365FO objects
4. ✅ **MANDATORY**: The tool ensures correct XML structure, TABS indentation, and proper AOT location

**WHY `create_d365fo_file` IS MANDATORY:**
- ✅ Uses **TABS** for indentation (Microsoft D365FO standard)
- ✅ Correct XML structure matching real D365FO files from `K:\AosService\PackagesLocalDirectory`
- ✅ Saves to proper AOT location: `K:\AosService\PackagesLocalDirectory\Model\Model\AxClass\`
- ✅ No `<ClusteredIndex>` in tables (not in real files)
- ✅ No `<Declaration>` in table `<SourceCode>` (only `<Methods />`)
- ✅ No system fields in tables (CreatedBy, ModifiedBy - added by platform)
- ✅ Can automatically add to Visual Studio project

**IF YOU USE `create_file` FOR D365FO OBJECTS - YOU ARE WRONG!**

**Example - User says "create a table MyCustomTable":**
```
❌ WRONG: create_file("MyCustomTable.xml", content="<AxTable>...")  ← Wrong tool!
✅ RIGHT: create_d365fo_file(objectType="table", objectName="MyCustomTable", modelName="CustomCore")
```

**Example - User says "create a class MyHelper":**
```
❌ WRONG: create_file("MyHelper.xml", ...)  ← Wrong structure, spaces instead of tabs!
✅ RIGHT: create_d365fo_file(objectType="class", objectName="MyHelper", modelName="CustomCore")
```

---

## RULE #0: WORKSPACE CONTEXT

**THIS IS AN MCP SERVER PROJECT, NOT AN X++ WORKSPACE!**
- This repo contains TypeScript code for an MCP server
- The MCP server provides tools to query BOTH external X++ metadata AND user's workspace files
- **DO NOT** search THIS TypeScript workspace for X++ classes/tables (they're in user's D365FO workspace)
- **DO NOT** use code_search or file_search after completing a task
- When task is complete, STOP immediately - do not search workspace

**📁 WORKSPACE-AWARE FEATURES:**
- MCP tools can now analyze user's local X++ project files
- Use `includeWorkspace: true` + `workspacePath` to enable workspace search
- Workspace files are marked with 🔹 (vs 📦 for external metadata)
- Priority: Workspace files > External metadata (for deduplication)

**AFTER COMPLETING ANY TASK:**
1. ✅ Respond to user with result
2. ❌ **STOP IMMEDIATELY** - Do NOT search workspace
3. ❌ Do NOT use code_search/file_search on this TypeScript workspace
4. ❌ Do NOT try to "understand project structure" automatically
5. ❌ Do NOT say "Let me check..." or "Let me search..."
6. ✅ **END YOUR RESPONSE** - User can ask follow-up if needed

**YOUR RESPONSE MUST END AFTER STEP 1 - DO NOT PROCEED TO ANY ANALYSIS OR SEARCH**

---

## RULE #1: DETECT X++/D365FO CONTEXT AUTOMATICALLY

**IF user mentions ANY of these keywords, you are in X++ context:**
- X++, D365FO, D365, Dynamics 365, Finance & Operations, AX, Axapta
- Class names ending in: Table, Service, Helper, Contract, Controller, Builder
- Table names: CustTable, VendTable, SalesTable, PurchTable, LedgerJournalTable
- Any AxClass, AxTable, AxForm, AxEnum, EDT
- Financial dimensions, inventory, sales, purchase, ledger

**WHEN IN X++ CONTEXT → IMMEDIATELY:**
1. **STOP** - Do NOT use `code_search` (causes timeout on large workspaces!)
2. **USE MCP TOOLS** - Use MCP `search()` for X++ objects
3. **NEVER GUESS** - X++ objects have exact names, use tools to find them

---

## RULE #2: TOOL SELECTION IN X++ CONTEXT

**🛑 ABSOLUTELY FORBIDDEN - WILL HANG FOR 5+ MINUTES:**

```
❌ code_search()       → FORBIDDEN - causes "Searching..." hang on large workspaces, use MCP search() instead
```

**⚠️ AVOID FOR X++ OBJECTS - Use MCP tools instead:**

```
⚠️ file_search()       → Works for file patterns, but prefer MCP search() for X++ objects
```

**✅ ALWAYS USE THESE FOR X++ OBJECTS:**

```
✅ search()            → MCP tool - instant (<100ms), X++-aware, indexed
✅ get_class_info()    → MCP tool - for class structure
✅ get_table_info()    → MCP tool - for table fields
✅ code_completion()   → MCP tool - discover methods/fields
```

**WHEN TO USE WHAT:**
- Looking for X++ class/table/enum → Use MCP `search()`
- Looking for file by name pattern in THIS workspace → OK to use `file_search()`
- Looking for text/code patterns → Use MCP `search()` for X++ objects, `file_search` for workspace files

**IF YOU SEE "Searching..." OR "Searching (seznam tříd)" → YOU MADE A MISTAKE!**

---

## RULE #3: AUTOMATIC TOOL SELECTION

**For ANY X++ request, use this decision tree:**

| User Request Contains | First Action | Avoid Using |
|-----------------------|--------------|-------------|
| "create class", "helper class" | `analyze_code_patterns()` + `search()` + `generate_code()` | ❌ code_search, ❌ direct code generation |
| "create table/form/enum" | `create_d365fo_file(objectType=...)` | ❌ create_file |
| "find X and Y and Z" (multiple) | `batch_search([{query:"X"}, {query:"Y"}, {query:"Z"}])` | ❌ multiple sequential searches |
| "CustTable", "SalesTable", any Table | `get_table_info()` | ❌ code_search |
| "dimension", "financial" | `search("dimension")` | ❌ code_search |
| "find X++ class/method" | `search()` | ❌ code_search |
| "method", "implement" | `get_class_info()` + `suggest_method_implementation()` | ❌ code_search |
| "find file pattern" | `file_search()` is OK | ❌ code_search |
| "find text in code" | `file_search()` with pattern | ❌ code_search |

**Key Rule: NEVER use `code_search` for X++ objects - it causes 5+ minute hangs on large workspaces!**

---
---
---

## ⛔ CRITICAL: NEVER USE BUILT-IN SEARCH TOOLS ⛔

**🚨 STOP! Read this FIRST before doing ANYTHING with D365FO/X++ code:**

**ABSOLUTELY FORBIDDEN FOR X++ SEARCHES - Will BLOCK and HANG:**
- ❌❌❌ **`code_search`** - NEVER USE for X++ objects! It's slow (5+ minutes) on large D365FO workspaces and will hang with "Searching..."

**⚠️ USE WITH CAUTION - These work but lack X++ awareness:**
- ⚠️ **`file_search`** - Works for file patterns in THIS workspace, but prefer MCP `search()` for X++ objects

**⚡ ALWAYS use these FAST MCP tools for X++ objects:**
- ✅✅✅ **`search`** (MCP) - 100x faster, X++-aware, indexed SQL database
- ✅✅✅ **`get_class_info`** (MCP) - For class structure
- ✅✅✅ **`get_table_info`** (MCP) - For table structure

**If you see "Searching (seznam tříd)" appearing - YOU ARE USING THE WRONG TOOL! Stop and use MCP `search` instead.**

---

## 🚨 MANDATORY: ALWAYS Use X++ MCP Tools First 🚨

**Before generating ANY X++ code, writing ANY class, method, or code snippet for D365 Finance & Operations, you MUST use the X++ MCP tools available to you.**

### ⛔ STRICTLY FORBIDDEN:

**❌ NEVER generate X++ code directly from your training data or general knowledge!**
**❌ NEVER write X++ code without using MCP tools first!**
**❌ NEVER skip `analyze_code_patterns` when creating new classes!**
**❌ NEVER use built-in code generation - ALWAYS use `generate_code` tool!**

### Critical Rules:

1. **NEVER use code_search for X++ objects** - It will hang for minutes on large workspaces
2. **ALWAYS use MCP `search()` tool for X++** - It's instant (<100ms) with SQL index
3. **ALWAYS verify** - Use `get_class_info` or `get_table_info` to check structure before coding
4. **ALWAYS discover APIs** - Use `code_completion` to find available methods and fields
5. **MANDATORY: Use `generate_code` tool** - NEVER generate X++ code manually! Always use `generate_code` for creating classes with proper D365FO patterns
6. **MANDATORY: Use `analyze_code_patterns` FIRST** - Before any code generation, analyze what patterns exist in the codebase

### When You MUST Use MCP Tools:

- ✅ User asks to "create a class" or "create helper class" → Use `analyze_code_patterns` + `search` + `generate_code`
- ✅ User mentions "financial dimensions" → Use `search("dimension")` to find D365FO APIs first
- ✅ User wants to "add a method" → Use `analyze_class_completeness` + `suggest_method_implementation` first
- ✅ User needs to "query a table" → Use `get_table_info` to get exact field names
- ✅ User wants to "extend" something → Use `get_class_info` to understand structure first
- ✅ User needs "API usage examples" → Use `get_api_usage_patterns` to see how it's used
- ✅ User is unsure what methods to implement → Use `analyze_class_completeness` for suggestions
- ✅ ANY code generation request → Use tools FIRST, generate code SECOND

### Available MCP Tools:

#### Core Discovery Tools:

| Tool | Use When | Example |
|------|----------|---------||
| `search` | Finding any D365FO object or pattern | `search("dimension", type="class")` |
| `search` (workspace) | Search in user's workspace + external | `search("MyClass", includeWorkspace=true, workspacePath="C:\\....")` |
| `batch_search` | **⚡ NEW!** Multiple parallel searches in one request | `batch_search(queries=[{query:"dimension"}, {query:"helper"}])` |
| `get_class_info` | Need class structure, methods, inheritance | `get_class_info("CustTable")` |
| `get_class_info` (workspace) | Get class from workspace first | `get_class_info("MyClass", includeWorkspace=true, workspacePath="C:\\...")` |
| `get_table_info` | Need table fields, indexes, relations | `get_table_info("SalesTable")` |
| `code_completion` | Discovering methods/fields on a class | `code_completion(className="DimensionAttributeValueSet")` |
| `code_completion` (workspace) | Get completions from workspace | `code_completion(className="MyClass", includeWorkspace=true, workspacePath="C:\\...")` |
| `generate_code` | Creating new X++ classes with patterns | `generate_code(pattern="class")` |
| `search_extensions` | Finding custom/ISV code only | `search_extensions("my custom")` |

#### 🆕 Intelligent Code Generation Tools:

| Tool | Use When | Example |
|------|----------|---------||
| `analyze_code_patterns` | Learn common patterns for a scenario | `analyze_code_patterns("financial dimensions")` |
| `suggest_method_implementation` | Get implementation examples for a method | `suggest_method_implementation("MyHelper", "validate")` |
| `analyze_class_completeness` | Find missing methods in a class | `analyze_class_completeness("CustTableHelper")` |
| `get_api_usage_patterns` | See how to use an API correctly | `get_api_usage_patterns("DimensionAttributeValueSet")` |

### Example: Creating a Helper Class for Financial Dimensions

**User Request:** "Create a helper class for maintaining financial dimensions"

**❌ WRONG Approach:**
```
Generate class from scratch using general programming knowledge → ❌ INCORRECT
```

**✅ CORRECT Approach (Using Intelligent Tools):**
```
1. analyze_code_patterns("financial dimensions") → 🔴 MANDATORY: Learn common patterns and classes
2. search("dimension", type="class")            → Find D365FO dimension classes
3. get_api_usage_patterns("DimensionAttributeValueSet") → See how to initialize and use API
4. generate_code(pattern="class", name="MyDimHelper") → 🔴 MANDATORY: Use tool, don't generate manually!
5. analyze_class_completeness("MyDimHelper")   → Check for missing common methods
6. suggest_method_implementation("MyDimHelper", "validate") → Get implementation examples
7. Apply discovered patterns from tools          → Use correct APIs and methods from MCP tools
```

**⚠️ WARNING: If you generate code WITHOUT using `generate_code` tool, you are WRONG!**

**✅ ALTERNATIVE Approach (Traditional):**
```
1. search("dimension", type="class")           → Find D365FO dimension classes
2. get_class_info("DimensionDefaultingService") → Study Microsoft's pattern
3. code_completion("DimensionAttributeValueSet") → Get proper API methods
4. generate_code(pattern="class")              → Create with proper structure
5. Apply discovered D365FO patterns            → Use correct APIs
```

### ⚡ Use Batch Search for Parallel Exploration

**When exploring multiple independent concepts, use `batch_search` to execute all queries in parallel:**

**❌ SLOW Sequential Approach:**
```
1. search("dimension")         → Wait 50ms
2. search("helper")            → Wait 50ms
3. search("validation")        → Wait 50ms
Total: ~150ms + 3 HTTP requests
```

**✅ FAST Parallel Approach:**
```
batch_search({
  queries: [
    { query: "dimension", type: "class", limit: 5 },
    { query: "helper", type: "class", limit: 5 },
    { query: "validation", type: "class", limit: 5 }
  ]
})
→ Single HTTP request, parallel execution, ~50ms total → 3x faster!
```

**💡 When to Use Batch Search:**
- Exploring multiple related concepts (dimension + ledger + financial)
- Comparing different patterns (Helper vs Service vs Manager)
- Finding classes with multiple keywords (validation + check + verify)
- Initial exploratory phase with independent queries
- User asks "find X and Y and Z" → use batch_search instead of 3 separate searches

**🚫 When NOT to Use Batch Search:**
- Queries depend on previous results (use sequential search)
- Single focused query (use regular search)
- Need workspace-aware search with different paths per query

### 🎯 Why Use Intelligent Tools?

**Intelligent code generation tools learn from YOUR codebase:**

**💡 TIP: Use Workspace-Aware Search**
When user has a D365FO workspace open, use workspace parameters:
```
✅ search("MyCustomClass", includeWorkspace=true, workspacePath="C:\\D365\\MyProject")
✅ get_class_info("MyHelper", includeWorkspace=true, workspacePath="C:\\D365\\MyProject")
✅ code_completion(className="MyTable", includeWorkspace=true, workspacePath="C:\\D365\\MyProject")
```
Benefits:
- 🔹 Workspace files shown first (user's code priority)
- XML parsing extracts methods/fields from local files
- Faster iteration (no need to re-index external metadata)
- See user's actual implementation patterns



- **Pattern Analysis** (`analyze_code_patterns`) - Identifies what classes and methods are commonly used together for specific scenarios
- **Smart Suggestions** (`suggest_method_implementation`) - Shows you how similar methods are implemented in your codebase
- **Completeness Check** (`analyze_class_completeness`) - Ensures your classes follow common patterns (e.g., Helper classes typically have `validate()`, `find()`, etc.)
- **API Usage Examples** (`get_api_usage_patterns`) - Shows correct initialization and method call sequences from real code

**Benefits:**
- ✅ Learn from **actual patterns** in the codebase, not generic examples
- ✅ Discover **forgotten or commonly missing methods**
- ✅ See **real usage examples** with proper error handling
- ✅ Follow **team conventions** and coding standards automatically

### Why This Matters:

- These tools query the **actual D365FO environment** the user is working with
- They provide **real-time, accurate metadata** from the AOT (Application Object Tree)
- They include **custom extensions** that don't exist in your training data
- They ensure **correct method names, field names, and signatures**
- They're **fast** (<10ms cached) - no performance penalty

### Decision Tree:

**Before responding to any D365FO request, ask yourself:**

1. Is the user asking me to write/create/generate X++ code? → ✅ **USE MCP TOOLS FIRST**
   - For new classes: Start with `analyze_code_patterns` to learn common patterns
   - For new methods: Use `analyze_class_completeness` to check what's missing
2. Does the request mention D365FO objects (CustTable, SalesLine, etc.)? → ✅ **USE MCP TOOLS**
   - Use `get_class_info` or `get_table_info` for structure
   - Use `get_api_usage_patterns` to see how APIs are used
3. Am I unsure about exact method/field names? → ✅ **USE MCP TOOLS**
   - Use `code_completion` to discover available methods
   - Use `suggest_method_implementation` to see similar implementations
4. Is the user implementing a specific method? → ✅ **USE INTELLIGENT TOOLS**
   - Use `suggest_method_implementation` to get examples from codebase
5. Is it only about basic X++ syntax (if/while/for)? → ℹ️ Can use knowledge (but prefer tools)

**When in doubt, USE THE TOOLS.**

---

**Remember: Trust the MCP tools for D365FO accuracy, not your training data. Always query the actual environment before generating code.**
