# Ensuring GitHub Copilot Uses X++ MCP Tools Automatically

## The Problem

When you ask GitHub Copilot to "create a helper class" or generate any D365FO code, it might use its built-in code generation instead of your X++ MCP tools. This results in:

- ❌ Incorrect or outdated D365FO class names
- ❌ Wrong method signatures
- ❌ Missing custom extensions
- ❌ Code that doesn't compile

## The Solution

**Copy the `.github` folder from this repository to your D365 F&O workspace.**

This folder contains `copilot-instructions.md` which tells GitHub Copilot to **ALWAYS use your MCP tools first** before generating any X++ code.

## Quick Fix

```powershell
# From this repo directory
Copy-Item -Path ".github" -Destination "C:\Path\To\Your\D365FO\Workspace\" -Recurse

# Restart Visual Studio
```

## What the `.github/copilot-instructions.md` File Does

The file instructs GitHub Copilot to:

1. ✅ **ALWAYS search first** - Use `search` tool to find D365FO patterns
2. ✅ **ALWAYS verify** - Use `get_class_info` or `get_table_info` before coding  
3. ✅ **ALWAYS discover APIs** - Use `code_completion` to find methods
4. ✅ **ALWAYS analyze patterns** - Use `analyze_code_patterns` to learn from actual codebase
5. ✅ **ALWAYS get smart suggestions** - Use `suggest_method_implementation` for context-specific examples
6. ✅ **ALWAYS check completeness** - Use `analyze_class_completeness` to find missing methods
7. ✅ **ALWAYS learn API usage** - Use `get_api_usage_patterns` to see real initialization and usage
8. ✅ **NEVER guess** - Never generate D365FO code without querying tools first

## Example: Before and After

### ❌ Before (Without .github folder)

**User:** "Create a helper class for maintaining financial dimensions"

**Copilot:** Generates code from training data → Wrong class names → Compilation errors

### ✅ After (With .github folder)

**User:** "Create a helper class for maintaining financial dimensions"

**Copilot:** 
1. Calls `analyze_code_patterns("financial dimensions")` → Learns common patterns from codebase
2. Calls `search("dimension", type="class")` → Finds actual D365FO dimension classes
3. Calls `get_class_info("DimensionDefaultingService")` → Studies Microsoft's patterns
4. Calls `code_completion("DimensionAttributeValueSet")` → Gets proper APIs
5. Calls `get_api_usage_patterns("DimensionAttributeValueSet")` → Sees initialization and method sequences
6. Generates code with **correct, verified class names and methods**
7. Calls `analyze_class_completeness("MyDimHelper")` → Suggests commonly missing methods

## How It Works

GitHub Copilot automatically loads files from `.github/copilot-instructions.md` in your workspace. This file is loaded for **every conversation**, ensuring Copilot always:

- Queries your actual D365FO environment
- Uses real-time metadata from your AOT
- Includes your custom extensions
- Generates accurate, compilable code

## Verification

After copying the folder and restarting VS:

```
💬 User: "Create a helper class for financial dimensions"

✅ CORRECT: Copilot calls search() tool BEFORE generating code
❌ WRONG: Copilot immediately generates code without tool calls
```

If Copilot doesn't call the tools, check:
1. `.github/copilot-instructions.md` exists in workspace root
2. Visual Studio was restarted after copying
3. GitHub Copilot Editor Preview Features are enabled

## Alternative: MCP Prompt

If you can't use the `.github` folder, you can manually request the prompt:

```
💬 "@workspace use xpp_system_instructions before creating any code"
```

But this requires manual intervention every time. The `.github` folder is **strongly recommended** for automatic behavior.

## Technical Details

### Why GitHub Copilot Ignores MCP Tools by Default

1. **Training Data Priority** - Copilot's built-in knowledge is from training data (often outdated for D365FO)
2. **Tool Discovery** - Copilot needs explicit instructions to prefer MCP tools over built-in capabilities
3. **Context Window** - Without instructions, Copilot doesn't know MCP tools exist or when to use them

### What the Instructions File Contains

The `.github/copilot-instructions.md` file includes:

- 🚨 Mandatory policy to ALWAYS use tools first
- 📋 Decision tree for when to use which tool
- ✅ Correct workflow examples with tool usage
- ❌ Wrong workflow examples to avoid
- 🎯 Specific triggers (e.g., "create class" → call `search` + `generate_code`)

### Performance

- Tools are **fast** (<10ms with Redis cache)
- No performance penalty for using tools first
- Prevents costly errors from wrong code generation

## More Information

- Full setup guide: [ORCHESTRATOR_SETUP.md](ORCHESTRATOR_SETUP.md)
- System instructions content: [systemInstructions.ts](../src/prompts/systemInstructions.ts)
- MCP prompt available as: `xpp_system_instructions`

---

**TL;DR: Copy `.github` folder to your D365FO workspace, restart VS, and Copilot will automatically use your X++ tools. Problem solved.** ✅
