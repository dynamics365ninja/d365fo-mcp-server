# Automatic Workspace Detection

When you open a D365FO project in Visual Studio 2022 or VS Code, the MCP server automatically
figures out which model you are working in — **no manual configuration required**.

---

## How It Works

1. GitHub Copilot passes the current workspace folder path to the MCP server with every tool call.
2. The server searches that folder (up to 5 levels deep) for any `.rnrproj` file.
3. It reads the `<Model>` element from the project file to get your model name.
4. All file operations (create, modify) use that model automatically.

```
Open project in Visual Studio 2022
           ↓
GitHub Copilot passes workspace path to MCP server
           ↓
Server finds MyProject.rnrproj
           ↓
Model name extracted: "AslCore"
           ↓
New files created in K:\AosService\PackagesLocalDirectory\AslCore\...
```

---

## What You Need to Do

**Nothing** — if your project is open in Visual Studio, detection is automatic.

The only thing that helps is having a `workspacePath` in your `.mcp.json` pointing to your
custom model folder. That enables the workspace-aware search (searching your local files
alongside the standard D365FO metadata). It does **not** affect file creation paths —
those come from the `.rnrproj` auto-detection.

---

## When to Add Manual Configuration

Add explicit paths to `.mcp.json` only in these situations:

| Situation | What to add |
|-----------|------------|
| Multiple D365FO projects in one solution | `projectPath` pointing to the right `.rnrproj` |
| Non-standard PackagesLocalDirectory location | `packagePath` with the correct base path |
| Running the server outside a Visual Studio workspace | `workspacePath` and/or `solutionPath` |

Minimal override example:
```json
{
  "servers": {
    "d365fo-code-intelligence": {
      "url": "http://localhost:8080/mcp/"
    },
    "context": {
      "projectPath": "K:\\VSProjects\\MySolution\\MyProject\\MyProject.rnrproj"
    }
  }
}
```

---

## Priority Order

When the server needs the model name for file creation:

| Priority | Source | Notes |
|----------|--------|-------|
| 1st | Tool call argument | Highest — explicit `projectPath` passed in the tool call |
| 2nd | `.mcp.json` projectPath | Explicit path in config file |
| 3rd | Auto-detection from workspace | Searches for `.rnrproj` in active workspace |
| 4th | `.mcp.json` solutionPath | Searches inside the configured solution folder |
| 5th | modelName parameter as-is | Last resort — may be wrong if it is a placeholder |

---

## Troubleshooting

**Files end up in a Microsoft standard model**
GitHub Copilot did not provide the workspace path (can happen in certain VS 2022 configurations).
Add `projectPath` to your `.mcp.json` as shown above.

**"modelName appears to be a placeholder" warning**
The server detected a suspicious model name like `"auto"` or `"YourModel"`.
This means none of the first four detection methods worked. Check that:
- Your solution is open in Visual Studio with the correct project loaded
- The `.mcp.json` is in the solution root (next to the `.sln` file)
