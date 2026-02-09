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

## RULE #0: WORKSPACE CONTEXT

**THIS IS AN MCP SERVER PROJECT, NOT AN X++ WORKSPACE!**
- This repo contains TypeScript code for an MCP server
- The MCP server provides tools to query EXTERNAL X++ metadata
- **DO NOT** search this workspace for X++ classes/tables
- **DO NOT** use semantic_search, code_search, or file_search after completing a task
- When task is complete, STOP immediately - do not search workspace

**AFTER COMPLETING ANY TASK:**
1. ✅ Respond to user with result
2. ❌ **STOP IMMEDIATELY** - Do NOT search workspace
3. ❌ Do NOT use semantic_search/code_search/file_search
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
1. **STOP** - Do NOT use `semantic_search` or `code_search` (causes timeout!)
2. **USE MCP TOOLS** - Use MCP `search()` for X++ objects
3. **NEVER GUESS** - X++ objects have exact names, use tools to find them

---

## RULE #2: TOOL SELECTION IN X++ CONTEXT

**🛑 ABSOLUTELY FORBIDDEN - WILL HANG FOR 5+ MINUTES:**

```
❌ semantic_search()   → FORBIDDEN - causes "Searching..." hang, use MCP search() instead
❌ code_search()       → FORBIDDEN - likely same issue as semantic_search
```

**⚠️ AVOID FOR X++ OBJECTS - Use MCP tools instead:**

```
⚠️ grep_search()       → Works, but no X++ awareness, prefer MCP search()
⚠️ file_search()       → Works for files, but prefer MCP search() for X++ objects
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
- Looking for file by name pattern → OK to use `file_search()`
- Looking for text in workspace → OK to use `grep_search()`
- Semantic/natural language search → **NEVER!** Use MCP `search()` instead

**IF YOU SEE "Searching..." OR "Searching (seznam tříd)" → YOU MADE A MISTAKE!**

---

## RULE #3: AUTOMATIC TOOL SELECTION

**For ANY X++ request, use this decision tree:**

| User Request Contains | First Action | Avoid Using |
|-----------------------|--------------|-------------|
| "create class", "helper class" | `analyze_code_patterns()` + `search()` | ❌ semantic_search |
| "CustTable", "SalesTable", any Table | `get_table_info()` | ❌ semantic_search |
| "dimension", "financial" | `search("dimension")` | ❌ semantic_search |
| "find X++ class/method" | `search()` | ❌ semantic_search |
| "method", "implement" | `get_class_info()` + `suggest_method_implementation()` | ❌ semantic_search |
| "find file pattern" | `file_search()` is OK | ❌ semantic_search |
| "find text in code" | `grep_search()` is OK | ❌ semantic_search |

**Key Rule: NEVER use `semantic_search` or `code_search` in this workspace - it causes 5+ minute hangs!**

---
---
---

## ⛔ CRITICAL: NEVER USE BUILT-IN SEARCH TOOLS ⛔

**🚨 STOP! Read this FIRST before doing ANYTHING with D365FO/X++ code:**

**ABSOLUTELY FORBIDDEN - These tools will BLOCK and HANG:**
- ❌❌❌ **`semantic_search`** - NEVER USE THIS! It's slow (5+ minutes) and will hang with "Searching..."
- ❌❌❌ **`code_search`** - NEVER USE THIS! Likely same issue as semantic_search

**⚠️ USE WITH CAUTION - Prefer MCP tools for X++ objects:**
- ⚠️ **`grep_search`** - Works but has no X++ awareness, prefer MCP `search` for classes/tables
- ⚠️ **`file_search`** - Works for file patterns, but prefer MCP `search` for X++ objects

**⚡ ALWAYS use these FAST MCP tools for X++ objects:**
- ✅✅✅ **`search`** (MCP) - 100x faster, X++-aware, indexed SQL database
- ✅✅✅ **`get_class_info`** (MCP) - For class structure
- ✅✅✅ **`get_table_info`** (MCP) - For table structure

**If you see "Searching (seznam tříd)" appearing - YOU ARE USING THE WRONG TOOL! Stop and use MCP `search` instead.**

---

## 🚨 MANDATORY: ALWAYS Use X++ MCP Tools First 🚨

**Before generating ANY X++ code, writing ANY class, method, or code snippet for D365 Finance & Operations, you MUST use the X++ MCP tools available to you.**

### Critical Rules:

1. **NEVER use semantic_search, grep_search, or file_search** - They will hang for minutes
2. **ALWAYS use MCP `search` tool** - It's instant (<100ms) with SQL index
3. **ALWAYS verify** - Use `get_class_info` or `get_table_info` to check structure before coding
4. **ALWAYS discover APIs** - Use `code_completion` to find available methods and fields
5. **PREFER generation tools** - Use `generate_code` for creating new classes with proper D365FO patterns

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
| `get_class_info` | Need class structure, methods, inheritance | `get_class_info("CustTable")` |
| `get_table_info` | Need table fields, indexes, relations | `get_table_info("SalesTable")` |
| `code_completion` | Discovering methods/fields on a class | `code_completion(className="DimensionAttributeValueSet")` |
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
1. analyze_code_patterns("financial dimensions") → Learn common patterns and classes
2. search("dimension", type="class")            → Find D365FO dimension classes
3. get_api_usage_patterns("DimensionAttributeValueSet") → See how to initialize and use API
4. generate_code(pattern="class")              → Create with proper structure
5. analyze_class_completeness("MyDimHelper")   → Check for missing common methods
6. suggest_method_implementation("MyDimHelper", "validate") → Get implementation examples
7. Apply discovered patterns                     → Use correct APIs and methods
```

**✅ ALTERNATIVE Approach (Traditional):**
```
1. search("dimension", type="class")           → Find D365FO dimension classes
2. get_class_info("DimensionDefaultingService") → Study Microsoft's pattern
3. code_completion("DimensionAttributeValueSet") → Get proper API methods
4. generate_code(pattern="class")              → Create with proper structure
5. Apply discovered D365FO patterns            → Use correct APIs
```

### 🎯 Why Use Intelligent Tools?

**Intelligent code generation tools learn from YOUR codebase:**

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
