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

### Traditional

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

### UDE (Unified Developer Experience)

For UDE environments using Power Platform Tools in VS2022, the server supports dual metadata
roots — one for your custom code and one for Microsoft standard packages:

```json
{
  "servers": {
    "d365fo-code-intelligence": {
      "url": "https://your-server.azurewebsites.net/mcp/"
    },
    "context": {
      "workspacePath":  "C:\\CustomXppCode\\YourPackage\\YourModel",
      "customPackagesPath":    "C:\\CustomXppCode",
      "microsoftPackagesPath": "C:\\Users\\...\\Dynamics365\\10.0.2428.63\\PackagesLocalDirectory",
      "devEnvironmentType":    "auto"
    }
  }
}
```

In most UDE setups you do not need to set these manually — the server reads your XPP config
files from `%LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\` and detects the paths automatically.

`workspacePath` is optional in UDE. It enables hybrid search (finding local files not yet indexed)
and project auto-detection (locating `.rnrproj` files). It does not control where files are created —
that is determined by `customPackagesPath` and `microsoftPackagesPath`.

### All Properties

| Property | Required | What it does |
|----------|----------|-------------|
| `workspacePath` | Recommended | Root folder of your custom D365FO model. Enables workspace-aware search. |
| `packagePath` | Optional | Base PackagesLocalDirectory path. Auto-extracted from `workspacePath` if not set. |
| `customPackagesPath` | Optional | UDE: Custom X++ code root (from XPP config `ModelStoreFolder`). |
| `microsoftPackagesPath` | Optional | UDE: Microsoft X++ root (from XPP config `FrameworkDirectory`). |
| `devEnvironmentType` | Optional | `auto` (default), `traditional`, or `ude`. Controls path resolution behavior. |
| `projectPath` | Optional | Full path to your `.rnrproj` file. Usually auto-detected by GitHub Copilot. |
| `solutionPath` | Optional | Visual Studio solution folder. Used when `projectPath` is not set. |

### When do you need the optional properties?

You only need to set `projectPath` or `solutionPath` explicitly if:
- You have **multiple D365FO projects** in one solution and need to pin a specific one
- Your `.rnrproj` is in an **unusual location** that auto-detection cannot find
- You want to **override** what GitHub Copilot auto-detects

You only need to set `customPackagesPath` or `microsoftPackagesPath` if:
- You are using UDE and the **auto-detection from XPP config files** is not working
- You want to **override** the paths discovered from `%LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\`

---

## How Path Resolution Works

When the server needs to create a file, it resolves the target path in this order:

**Traditional mode:**

1. **Tool argument** — if the tool call itself includes a `packagePath`, that wins
2. **`.mcp.json` packagePath** — explicit value from the config file
3. **Auto-extracted** — if `workspacePath` contains `PackagesLocalDirectory`, the base is extracted
4. **Default fallback** — `K:\AosService\PackagesLocalDirectory`

**UDE mode:**

1. **`.mcp.json` context** — `customPackagesPath` / `microsoftPackagesPath`
2. **XPP config auto-detection** — reads `ModelStoreFolder` and `FrameworkDirectory` from the config file selected by `XPP_CONFIG_NAME` (or the newest) in `%LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\`
3. **Fallback** — existing `PACKAGES_PATH` env var or `packagePath` from `.mcp.json`

In D365FO, a package can contain multiple models (e.g., package "CustomExtensions" may contain
models "Contoso Utilities" and "Contoso Reporting"). When the package name differs from the model
name, you can pass `packageName` explicitly to any file creation tool. In UDE mode, the server
also auto-resolves package names by reading descriptor XML files. In traditional mode, it defaults
to assuming package name equals model name.

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
---

## Hybrid Setup (Azure + Local)

When the MCP server is deployed to Azure, `create_d365fo_file`, `modify_d365fo_file`, and
`create_label` cannot write to the local Windows VM file system. The **hybrid setup** solves
this by running two servers simultaneously:

| Instance | Runs on | `MCP_SERVER_MODE` | Tools |
|----------|---------|-------------------|-------|
| `d365fo-azure` | Azure App Service | `read-only` | All 25 search & analysis tools |
| `d365fo-local` | Windows VM (stdio) | `write-only` | `create_d365fo_file`, `modify_d365fo_file`, `create_label` |

GitHub Copilot connects to both servers at the same time and selects the right one automatically.

### .mcp.json for hybrid setup

```json
{
  "servers": {
    "d365fo-azure": {
      "url": "https://your-server.azurewebsites.net/mcp/"
    },
    "d365fo-local": {
      "command": "node",
      "args": ["K:\\d365fo-mcp-server\\dist\\index.js", "--stdio"],
      "env": {
        "MCP_SERVER_MODE": "write-only",
        "DB_PATH": "K:\\d365fo-mcp-server\\data\\xpp-metadata.db"
      }
    },
    "context": {
      "projectPath": "K:\\VSProjects\\MySolution\\MyProject\\MyProject.rnrproj"
    }
  }
}
```

### How it works

1. `d365fo-azure` starts with `MCP_SERVER_MODE=read-only` → only exposes search/analysis tools
2. `d365fo-local` starts with `MCP_SERVER_MODE=write-only` → only exposes file-operation tools
3. GitHub Copilot aggregates both tool lists — from Copilot's perspective it sees all 28 tools
4. When Copilot calls `create_d365fo_file`, it goes to the local server which has K:\ access
5. When Copilot calls `search`, it goes to the Azure server with the full metadata database

> **Note:** The local server in `write-only` mode still needs access to the metadata database
> (for path resolution and model detection), but it doesn't need Redis or Azure Blob Storage.

### Azure App Service settings for read-only mode

In your Azure App Service configuration, add:

```
MCP_SERVER_MODE=read-only
```

This ensures write tools are never advertised over the public URL, even if someone calls them directly.