# Workspace-Aware Search Documentation

This document describes the new workspace-aware features that allow MCP tools to analyze both external D365FO metadata and local project files.

## Overview

The MCP server now supports **hybrid search** that combines:
1. **External D365FO metadata** - Standard PackagesLocalDirectory symbols (584K+ symbols)
2. **Workspace files** - Your local project X++ files
3. **Open files context** - Files currently open in your IDE (via client API)

## Architecture

```
┌─────────────────────────────────────────┐
│         MCP Client (VS Code/VS)         │
│  - Provides workspacePath parameter     │
│  - Can attach open files as context     │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│           MCP HTTP Server               │
│  ┌─────────────────────────────────┐  │
│  │     Hybrid Search Engine        │  │
│  │  - WorkspaceScanner             │  │
│  │  - HybridSearch                 │  │
│  │  - SymbolIndex (SQLite)         │  │
│  └─────────────────────────────────┘  │
└──────────────────┬──────────────────────┘
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
┌──────────────┐    ┌──────────────────┐
│ External DB   │    │ Workspace Files  │
│ (584K symbols)│    │ (Your project)   │
└──────────────┘    └──────────────────┘
```

## New Features

### 1. Workspace-Aware Search

The `search` tool now accepts optional parameters for workspace context:

```typescript
{
  query: "CustTable",
  type: "class",
  includeWorkspace: true,
  workspacePath: "C:\\MyD365Project"
}
```

**Example Output:**
```
Found 3 matches (1 workspace, 2 external):

🔹 WORKSPACE [CLASS] MyCustTableExtension (C:\MyD365Project\AxClass\MyCustTableExtension.xml)
📦 EXTERNAL [CLASS] CustTable - Customer table
📦 EXTERNAL [CLASS] CustTableMap - Customer table map

💡 Workspace-aware search includes both your local project files and D365FO external metadata.
```

### 2. Workspace Resources

New MCP resources expose workspace context:

- `workspace://stats` - Get statistics about workspace files
- `workspace://files` - List all X++ files in workspace

### 3. Deduplication & Prioritization

The hybrid search engine:
- **Deduplicates** results (prefers workspace version over external)
- **Ranks by relevance** using fuzzy matching
- **Combines** both sources seamlessly

## Components

### WorkspaceScanner

Scans local filesystem for X++ files:

```typescript
class WorkspaceScanner {
  scanWorkspace(path: string): Promise<WorkspaceFile[]>
  searchInWorkspace(path: string, query: string): Promise<WorkspaceFile[]>
  getWorkspaceStats(path: string): Promise<Stats>
}
```

**Features:**
- Automatic type detection (AxClass, AxTable, AxForm, AxEnum)
- Glob-based file discovery
- 5-minute caching
- Ignores node_modules, bin, obj, .git

### HybridSearch

Combines external and workspace results:

```typescript
class HybridSearch {
  search(query: string, options): Promise<HybridSearchResult[]>
  searchPatterns(scenario: string, workspacePath: string): Promise<Results>
}
```

**Features:**
- Relevance scoring (exact match=100, starts with=80, contains=50)
- Levenshtein distance for fuzzy matching
- Source tagging (external vs workspace)
- Smart deduplication

## Usage Examples

### Example 1: Search with Workspace Context

```json
{
  "name": "search",
  "arguments": {
    "query": "dimension",
    "type": "class",
    "includeWorkspace": true,
    "workspacePath": "C:\\AOSService\\MyCustomModel"
  }
}
```

**Benefits:**
- Finds your custom dimension classes in the project
- Still includes all standard D365FO dimension classes
- Clearly marks which results are from your project vs standard

### Example 2: Pattern Analysis with Workspace

```json
{
  "name": "analyze_code_patterns",
  "arguments": {
    "scenario": "financial dimensions",
    "workspacePath": "C:\\AOSService\\MyCustomModel"
  }
}
```

**Benefits:**
- Analyzes how YOUR project uses dimension APIs
- Not just generic D365FO patterns
- Real examples from your codebase

### Example 3: Workspace Stats

```json
{
  "name": "read_resource",
  "arguments": {
    "uri": "workspace://stats",
    "workspacePath": "C:\\AOSService\\MyCustomModel"
  }
}
```

**Returns:**
```json
{
  "totalFiles": 45,
  "classes": 32,
  "tables": 8,
  "forms": 3,
  "enums": 2
}
```

## Configuration

### Client-Side (VS Code Extension)

The client should provide workspace path in tool requests:

```typescript
// In VS Code extension
const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
const workspacePath = workspaceFolder?.uri.fsPath;

// Pass to MCP tool
await mcpClient.callTool("search", {
  query: "MyClass",
  includeWorkspace: true,
  workspacePath: workspacePath
});
```

### Server-Side

No additional configuration needed. Workspace features are enabled automatically when `workspacePath` is provided.

## Performance Considerations

### Caching Strategy
- **Workspace scan**: Cached for 5 minutes
- **Search results**: Cached per query+workspace combination
- **File content**: On-demand loading

### Scalability
- Workspace scan is lazy (only when requested)
- Glob-based discovery is fast (<100ms for typical projects)
- Results are deduplicated server-side

### Limitations
- Workspace path must be provided by client
- No automatic filesystem watching (manual refresh needed)
- Large workspaces (>1000 files) may be slower

## Security

### Path Validation
- Workspace paths are not validated (trust client)
- File reading is restricted to `.xml` files
- No execution of code from workspace

### Recommendations
- Client should validate workspace paths
- Only pass trusted workspace locations
- Consider sandboxing in production environments

## Future Enhancements

### Planned Features
1. **File watching** - Auto-refresh on file changes
2. **Incremental indexing** - Full-text search on workspace files
3. **Symbol extraction** - Parse workspace files into symbol index
4. **Context API** - Better support for open files/active editor
5. **Multi-workspace** - Support for multiple workspace roots

### API Extensions
- `workspace://open-files` resource
- `workspace://active-file` resource
- `get_workspace_class_info` tool (workspace-specific)
- `compare_with_standard` tool (workspace vs PackagesLocalDirectory)

## Migration Guide

### Updating Existing Tools

To add workspace support to an existing tool:

1. **Add parameters to schema:**
```typescript
const MyToolSchema = z.object({
  // ... existing params
  workspacePath: z.string().optional(),
  includeWorkspace: z.boolean().optional().default(false),
});
```

2. **Access workspace scanner:**
```typescript
export async function myTool(request: CallToolRequest, context: XppServerContext) {
  const { workspaceScanner, hybridSearch } = context;
  
  if (args.includeWorkspace && args.workspacePath) {
    // Use workspace features
    const files = await workspaceScanner.scanWorkspace(args.workspacePath);
  }
}
```

3. **Update tool description:**
```typescript
{
  name: 'my_tool',
  description: 'Does something. Supports workspace-aware search when workspacePath is provided.',
  inputSchema: MyToolSchema
}
```

## Troubleshooting

### "Workspace path not provided"
- Client must explicitly pass `workspacePath` parameter
- Check VS Code/VS extension configuration

### "No workspace files found"
- Verify workspace path is correct
- Ensure X++ files exist in workspace (*.xml)
- Check that files are not in excluded directories

### "Results only show external metadata"
- Ensure `includeWorkspace: true` is set
- Verify `workspacePath` is provided and valid

## See Also

- [Architecture Documentation](./ARCHITECTURE.md)
- [Tool Definitions](../src/tools/xppTools.ts)
- [Workspace Scanner Implementation](../src/workspace/workspaceScanner.ts)
- [Hybrid Search Implementation](../src/workspace/hybridSearch.ts)
