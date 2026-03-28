# C# Metadata Bridge

> **The C# bridge is mandatory for the MCP server to function on Windows D365FO development VMs.**
> Without it, file creation (`create_d365fo_file`) and modification (`modify_d365fo_file`) will fail.
> Read-only tools fall back to SQLite, but all write operations require the bridge.

The bridge connects the Node.js MCP server to Microsoft's official D365FO Dev Tools API
(`IMetadataProvider`) and cross-reference database (`DYNAMICSXREFDB`) via a .NET Framework 4.8
child process. It provides live, always-current metadata access — reads and writes — using the
same API that Visual Studio uses internally.

For build instructions, see [SETUP.md § Building the C# Bridge](SETUP.md#building-the-c-bridge).
For architecture details, see [ARCHITECTURE.md § C# Bridge Architecture](ARCHITECTURE.md#c-bridge-architecture).

---

## How It Works

The bridge runs as a child process spawned by the Node.js server at startup. Communication
uses newline-delimited JSON-RPC over stdin/stdout.

Every tool handler follows a **bridge-first, fallback** pattern:

1. **Bridge available** → call `IMetadataProvider` via JSON-RPC → return result
2. **Bridge unavailable** → fall back to SQLite index + XML parser (read-only tools only)
3. **Write operations** → bridge is the **only** path — no fallback exists

---

## Read Endpoints

19 read endpoints (mapped through 12 `tryBridge*()` adapter functions in `bridgeAdapter.ts`) — return `null` when bridge is unavailable.

| Method | Parameters | Source |
|---|---|---|
| `readTable` | `tableName` | `IMetadataProvider.Tables` |
| `readClass` | `className` | `IMetadataProvider.Classes` |
| `readEnum` | `enumName` | `IMetadataProvider.Enums` |
| `readEdt` | `edtName` | `IMetadataProvider.Edts` |
| `readForm` | `formName` | `IMetadataProvider.Forms` |
| `readQuery` | `queryName` | `IMetadataProvider.Queries` |
| `readView` | `viewName` | `IMetadataProvider.Views` |
| `readDataEntity` | `entityName` | `IMetadataProvider.DataEntityViews` |
| `readReport` | `reportName` | `IMetadataProvider.Reports` |
| `getMethodSource` | `className`, `methodName` | `IMetadataProvider.Classes` |
| `searchObjects` | `query`, `type?`, `maxResults?` | `IMetadataProvider` (multi-type) |
| `listObjects` | `type` | `IMetadataProvider.*.GetPrimaryKeys()` |
| `findReferences` | `targetName` | `DYNAMICSXREFDB` |
| `findExtensionClasses` | `baseClassName` | `DYNAMICSXREFDB` |
| `findEventSubscribers` | `targetName`, `eventName?`, `handlerType?` | `DYNAMICSXREFDB` |
| `findApiUsageCallers` | `apiName`, `limit?` | `DYNAMICSXREFDB` |
| `readSecurityPrivilege` / `readSecurityDuty` / `readSecurityRole` | `name` | `IMetadataProvider` |
| `readMenuItem` | `name` | `IMetadataProvider` |
| `readTableExtensions` | `tableName` | `IMetadataProvider` |

All bridge-sourced output includes `_Source: C# bridge (IMetadataProvider)_` in the response.

---

## Write Endpoints

32 write adapters (`bridge*()` in `bridgeAdapter.ts`) — **no fallback**, bridge is required.

### Create Operations (18 object types)

All use `IMetaXxxProvider.Create()` via explicit interface cast.

| Object Type | API |
|---|---|
| class, class-extension | `IMetaClassProvider.Create()` |
| table, table-extension | `IMetaTableProvider.Create()` / `IMetaTableExtensionProvider.Create()` |
| enum, enum-extension | `IMetaEnumProvider.Create()` / `IMetaEnumExtensionProvider.Create()` |
| edt | `IMetaEdtProvider.Create()` |
| form, form-extension | `IMetaFormProvider.Create()` / `IMetaFormExtensionProvider.Create()` |
| query, view | `IMetaQueryProvider.Create()` / `IMetaViewProvider.Create()` |
| menu, menu-item (action/display/output) | `IMetaMenuProvider.Create()` / `IMetaMenuItemXxxProvider.Create()` |
| security-privilege, security-duty, security-role | `IMetaSecurityXxxProvider.Create()` |

### Modify Operations (25 operations, all bridged)

All use the Read → Modify → `IMetaXxxProvider.Update()` pattern.

| Operation | Supported Object Types |
|---|---|
| `add-method`, `remove-method` | class, table, form, query, view |
| `add-field`, `modify-field`, `rename-field`, `remove-field`, `replace-all-fields` | table, table-extension |
| `add-index`, `remove-index` | table, table-extension |
| `add-relation`, `remove-relation` | table, table-extension |
| `add-field-group`, `remove-field-group`, `add-field-to-field-group` | table, table-extension |
| `add-field-modification` | table-extension |
| `add-enum-value`, `modify-enum-value`, `remove-enum-value` | enum, enum-extension |
| `add-control`, `add-data-source` | form, form-extension |
| `set-property` | class, table, enum, edt, form, query, view, menu-items |
| `replace-code` | class, table, form, query, view |

### Other Operations

| Method | Purpose |
|---|---|
| `deleteObject` | `IMetaXxxProvider.Delete()` for class, table, enum, edt |
| `batchModify` | Multiple operations in one call |
| `getCapabilities` | Reports supported types + operations |
| `discoverFormPatterns` | Analyzes form design patterns |

---

## JSON-RPC Protocol

### Request

```json
{"id": "42", "method": "readTable", "params": {"tableName": "CustTable"}}
```

### Response (success)

```json
{"id": "42", "result": {"name": "CustTable", "label": "Customers", "fields": [...]}}
```

### Response (error)

```json
{"id": "42", "error": {"code": -32001, "message": "Object not found"}}
```

### Error Codes

| Code | Meaning |
|---|---|
| `-32601` | Unknown method |
| `-32602` | Invalid/missing parameters |
| `-32000` | Service not available |
| `-32001` | Object not found |
| `-32603` | Internal error |

### Special Messages

| Message | Direction | Purpose |
|---|---|---|
| `{"id":"ready","result":{...}}` | C# → Node | Initialization complete, reports `metadataAvailable` and `xrefAvailable` |
| `{"id":"N","method":"ping"}` | Node → C# | Health check, returns `"pong"` |

---

## Troubleshooting

### Bridge doesn't start

`ℹ️ C# bridge not available: ...` in server logs.

| Cause | Fix |
|---|---|
| Bridge not built | Run `dotnet build -c Release` in `bridge/D365MetadataBridge/` |
| Wrong `packagePath` | Fix `packagePath` in `.mcp.json` to point to `PackagesLocalDirectory` |
| Missing DLLs | Verify `{packagePath}/bin/` contains `Microsoft.Dynamics.AX.Metadata.*.dll` |
| Running on Linux/macOS | Expected — bridge is Windows-only, server uses SQLite fallback |

### `metadataAvailable: false`

D365FO is not deployed to `PackagesLocalDirectory`, or DLL version mismatch. Check bridge
stderr for `[ERROR]` messages.

### `xrefAvailable: false`

SQL Server is not running, `DYNAMICSXREFDB` does not exist, or auth failure. Bridge uses
Windows Integrated Authentication by default.

### Output shows SQLite data, not bridge data

Check if the result was served from cache (cache hit occurs before bridge check), or the
bridge returned `null` for that object. Bridge-sourced output always contains
`_Source: C# bridge_` marker.
