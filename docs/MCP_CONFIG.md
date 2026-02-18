# MCP Configuration (.mcp.json)

The `.mcp.json` file tells the MCP server where your D365FO project lives. Without it the
server still works, but file creation may land in the wrong model.

---

## Minimal Configuration

Place this file in the root of your Visual Studio solution (next to the `.sln` file):

```json
{
  "servers": {
    "d365fo-code-intelligence": {
      "url": "https://your-server.azurewebsites.net/mcp/"
    },
    "context": {
      "workspacePath": "K:\\AosService\\PackagesLocalDirectory\\YourModel"
    }
  }
}
```

That is all most users need. The server will:
- Automatically find your `.rnrproj` file in the open workspace
- Extract the correct model name from it
- Write any new files to the right location under PackagesLocalDirectory

---

## All Configuration Options

```json
{
  "servers": {
    "d365fo-code-intelligence": {
      "url": "https://your-server.azurewebsites.net/mcp/"
    },
    "context": {
      "workspacePath":  "K:\\AosService\\PackagesLocalDirectory\\YourModel",
      "packagePath":    "K:\\AosService\\PackagesLocalDirectory",
      "projectPath":    "K:\\VSProjects\\MySolution\\MyProject\\MyProject.rnrproj",
      "solutionPath":   "K:\\VSProjects\\MySolution"
    }
  }
}
```

| Property | Required | What it does |
|----------|----------|-------------|
| `workspacePath` | Recommended | Root folder of your custom D365FO model. Enables workspace-aware search. |
| `packagePath` | Optional | Base PackagesLocalDirectory path. Auto-extracted from `workspacePath` if not set. |
| `projectPath` | Optional | Full path to your `.rnrproj` file. Usually auto-detected by GitHub Copilot. |
| `solutionPath` | Optional | Visual Studio solution folder. Used when `projectPath` is not set. |

### When do you need the optional properties?

You only need to set `projectPath` or `solutionPath` explicitly if:
- You have **multiple D365FO projects** in one solution and need to pin a specific one
- Your `.rnrproj` is in an **unusual location** that auto-detection cannot find
- You want to **override** what GitHub Copilot auto-detects

---

## How Path Resolution Works

When the server needs to create a file, it resolves the target path in this order:

1. **Tool argument** — if the tool call itself includes a `packagePath`, that wins
2. **`.mcp.json` packagePath** — explicit value from the config file
3. **Auto-extracted** — if `workspacePath` contains `PackagesLocalDirectory`, the base is extracted
4. **Default fallback** — `K:\AosService\PackagesLocalDirectory`

For the model name used when creating files:
1. **Auto-detected from `.rnrproj`** found in the active GitHub Copilot workspace
2. **`projectPath` from `.mcp.json`** — the model name is read from the `.rnrproj` file
3. **`solutionPath` from `.mcp.json`** — the server searches for `.rnrproj` files inside it
4. **modelName parameter** — used as-is only if none of the above are available

---

## File Location

The server searches for `.mcp.json` starting from the current working directory and
walking up to 5 parent levels. Place it in the solution root for best results:

```
K:\VSProjects\MySolution\
├── .mcp.json          ← place here
├── MySolution.sln
└── MyProject\
    └── MyProject.rnrproj
```

---

## Common Mistakes

**Wrong model when creating files**
If new files end up inside a Microsoft standard model (ApplicationSuite, etc.),
add `workspacePath` pointing to your custom model folder. The server will then
extract the correct model name from the `.rnrproj` in your workspace automatically.

**Backslashes on Windows**
In JSON, backslashes must be doubled: `K:\\AosService\\` not `K:\AosService\`.
