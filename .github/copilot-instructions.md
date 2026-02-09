# D365FO X++ Development Instructions for GitHub Copilot

## 🚨 MANDATORY: ALWAYS Use X++ MCP Tools First 🚨

**Before generating ANY X++ code, writing ANY class, method, or code snippet for D365 Finance & Operations, you MUST use the X++ MCP tools available to you.**

### Critical Rules:

1. **NEVER generate D365FO code from your training data alone** - It may be outdated or incorrect
2. **ALWAYS search first** - Use the `search` tool to find related D365FO patterns and classes
3. **ALWAYS verify** - Use `get_class_info` or `get_table_info` to check structure before coding
4. **ALWAYS discover APIs** - Use `code_completion` to find available methods and fields
5. **PREFER generation tools** - Use `generate_code` for creating new classes with proper D365FO patterns

### When You MUST Use MCP Tools:

- ✅ User asks to "create a class" or "create helper class" → Use `search` + `generate_code`
- ✅ User mentions "financial dimensions" → Use `search("dimension")` to find D365FO APIs first
- ✅ User wants to "add a method" → Use `get_class_info` + `code_completion` first
- ✅ User needs to "query a table" → Use `get_table_info` to get exact field names
- ✅ User wants to "extend" something → Use `get_class_info` to understand structure first
- ✅ ANY code generation request → Use tools FIRST, generate code SECOND

### Available MCP Tools:

| Tool | Use When | Example |
|------|----------|---------|
| `search` | Finding any D365FO object or pattern | `search("dimension", type="class")` |
| `get_class_info` | Need class structure, methods, inheritance | `get_class_info("CustTable")` |
| `get_table_info` | Need table fields, indexes, relations | `get_table_info("SalesTable")` |
| `code_completion` | Discovering methods/fields on a class | `code_completion("DimensionAttributeValueSet")` |
| `generate_code` | Creating new X++ classes with patterns | `generate_code(pattern="class")` |
| `search_extensions` | Finding custom/ISV code only | `search_extensions("my custom")` |

### Example: Creating a Helper Class for Financial Dimensions

**User Request:** "Create a helper class for maintaining financial dimensions"

**❌ WRONG Approach:**
```
Generate class from scratch using general programming knowledge → ❌ INCORRECT
```

**✅ CORRECT Approach:**
```
1. search("dimension", type="class")           → Find D365FO dimension classes
2. get_class_info("DimensionDefaultingService") → Study Microsoft's pattern
3. code_completion("DimensionAttributeValueSet") → Get proper API methods
4. generate_code(pattern="class")              → Create with proper structure
5. Apply discovered D365FO patterns            → Use correct APIs
```

### Why This Matters:

- These tools query the **actual D365FO environment** the user is working with
- They provide **real-time, accurate metadata** from the AOT (Application Object Tree)
- They include **custom extensions** that don't exist in your training data
- They ensure **correct method names, field names, and signatures**
- They're **fast** (<10ms cached) - no performance penalty

### Decision Tree:

**Before responding to any D365FO request, ask yourself:**

1. Is the user asking me to write/create/generate X++ code? → ✅ **USE MCP TOOLS FIRST**
2. Does the request mention D365FO objects (CustTable, SalesLine, etc.)? → ✅ **USE MCP TOOLS**
3. Am I unsure about exact method/field names? → ✅ **USE MCP TOOLS**
4. Is it only about basic X++ syntax (if/while/for)? → ℹ️ Can use knowledge (but prefer tools)

**When in doubt, USE THE TOOLS.**

---

**Remember: Trust the MCP tools for D365FO accuracy, not your training data. Always query the actual environment before generating code.**
