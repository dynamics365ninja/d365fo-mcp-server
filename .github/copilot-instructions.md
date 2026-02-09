# D365FO X++ Development Instructions for GitHub Copilot

## 🚨 MANDATORY: ALWAYS Use X++ MCP Tools First 🚨

**Before generating ANY X++ code, writing ANY class, method, or code snippet for D365 Finance & Operations, you MUST use the X++ MCP tools available to you.**

### 🚫 FORBIDDEN: Do NOT Use These Tools for X++ Code

**NEVER use these built-in Copilot tools when working with D365FO/X++ code:**
- ❌ `semantic_search` - Slow, file-based search (use MCP `search` instead)
- ❌ `grep_search` - Text-only search (use MCP `search` instead)  
- ❌ `file_search` - No X++ awareness (use MCP `search` instead)

**WHY:** Your MCP `search` tool is 100x faster (indexed SQL database) and X++-aware (understands AOT structure, inheritance, relations).

### Critical Rules:

1. **NEVER generate D365FO code from your training data alone** - It may be outdated or incorrect
2. **ALWAYS use MCP `search` tool** - NOT semantic_search, NOT grep_search - Use the X++ MCP `search` tool
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
| `code_completion` | Discovering methods/fields on a class | `code_completion("DimensionAttributeValueSet")` |
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
