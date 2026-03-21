---
name: D365FO MCP Server — IDE context
description: Target IDE is Visual Studio 2022 (not VS Code). GitHub Copilot is the VS 2022 Copilot integration, not the VS Code extension.
type: project
---

Target IDE is **Visual Studio 2022** (user also mentioned "2026", likely meaning the next VS version or a typo).

**Why:** D365FO development runs entirely on Windows in VS 2022 — the MCP server, Copilot instructions, and all tooling are consumed from within VS 2022's GitHub Copilot chat/agent.

**How to apply:**
- Copilot-instructions.md is for VS 2022 Copilot, not VS Code Copilot.
- "Agent mode" refers to VS 2022 Copilot agent mode (GA in VS 2022 17.13+).
- VS 2022 shows proposed code changes inline with a diff overlay when Copilot edits files directly; MCP bypasses this because writes go directly to disk.
- VS Code–specific APIs (workspace edits, extension host) are NOT available.
