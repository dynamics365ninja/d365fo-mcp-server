# Optional AxDB SQL tool

`axdb_sql` gives the agent **read-only, live SQL access to AxDB on a development VM**, for debugging: inspect persisted data, confirm what X++ code wrote, diagnose why a record has a particular value. It is off by default, and until SQL is configured the tool is not published at all — an installation that does not use it pays nothing for it, not even catalogue space.

## Configure only if needed

Setup offers SQL only where it can work: a **classic AOSService VM** whose `AosService\WebRoot\web.config` names the database its own AOS uses (`DataAccess.DbServer` / `DataAccess.Database`). There, after the environment type, the wizard asks whether to enable SQL on that server and database — answering no (the default) leaves SQL disabled; yes pre-fills both answers. On UDE (no local AxDB reachable with Windows authentication), or when no AOS web.config sits beside the packages folder, setup does not ask and says how to configure it by hand. Instance setup follows the same rule.

Configure or change it explicitly at any time, on any machine:

```powershell
d365fo-mcp config sql
```

From a git checkout, use `npx tsx src/cli/index.ts config sql`. Restart MCP after changes.

The questions are:

1. Server or named instance, such as `localhost` or `localhost\DEV` (offered from web.config when found). Leaving it empty disables SQL and skips the rest.
2. Database, normally `AxDB` (offered from web.config when found).
3. Whether to trust the local SQL Server certificate. A developer VM's SQL Server presents a self-signed certificate, so the answer defaults to yes when the server is this machine (`.`, `localhost`, `(local)`, its name) and to no otherwise.

Authentication uses the **Windows account running the MCP/bridge process**. No SQL password or connection string is collected, stored or accepted in tool arguments. The connection is encrypted; certificate validation is only relaxed if selected in setup. Connections open on demand, not at startup.

Example saved configuration for a developer VM with a self-signed certificate:

```json
{
  "sql": {
    "enabled": true,
    "server": "localhost",
    "database": "AxDB",
    "trustServerCertificate": true
  }
}
```

Advanced settings: `commandTimeoutSeconds` (1–30, default 30), `maxRows` (1–1000, default 100). Environment equivalents are listed in [CONFIGURATION.md](CONFIGURATION.md). Each instance has its own SQL settings: an explicitly set shell variable overrides the config, but another installation's ambient `.env` SQL settings do not leak into an instance. A setting that does not resolve (a timeout out of range, a connection string where a server name belongs) makes the tool answer `SQL_CONFIG_INVALID` naming it.

## Build the updated bridge

SQL runs in the C# bridge, so it needs a bridge built from these sources on the Windows D365FO developer VM:

```powershell
npm run build
npm run bridge:build
dotnet build bridge/D365MetadataBridge -c Release
```

`bridge:build` verifies compilation in a scratch directory and refreshes the attestation; the final `dotnet build` updates the deployed binary (stop MCP first if that binary is locked), then restart MCP. ScriptDom is restored as a pinned NuGet dependency. An older bridge does not gain SQL support from a TypeScript-only build: the tool detects the missing capability and says how to rebuild it.

The tool is published in the `full` and `core` profiles, in the `full` and `write-only` server modes, once SQL is configured. It is excluded from `read-only` mode (Azure) because it needs the local bridge. Its calls run alongside metadata reads in the bridge, so a slow query does not hold them up.

## Why it cannot write

On a D365FO dev VM the Windows account running MCP is normally **sysadmin**, so SQL permissions restrict nothing. Two independent guards stand in their place:

1. **The statement.** Each request is parsed with ScriptDom and must be exactly one `SELECT`. DML, DDL, `EXEC`, dynamic SQL, transaction commands, cross-database or linked-server names, `OPENROWSET`/`OPENQUERY`, `SELECT INTO`, user `OUTPUT`, query/table hints, user-defined functions and types, application views, synonyms and external tables are refused — on the syntax tree, not by the first word.
2. **The connection.** Every operation runs inside a transaction that the service **always rolls back**; there is no code path that commits. Should a statement ever get past the policy, or the engine read it differently from ScriptDom, it still cannot leave a change behind.

Catalog access is limited to the database-scoped views debugging needs: `sys.tables`, `columns`, `types`, `schemas`, `objects`, `indexes`, `index_columns`, `foreign_keys`, `foreign_key_columns`, `key_constraints`, `default_constraints`, `check_constraints`, `computed_columns`, `identity_columns`, `views`, `triggers` and `partitions`. The check is made on the object a name actually resolves to, so server-scoped views and DMVs (`sys.sql_logins`, `sys.server_principals`, `sys.dm_exec_sessions`) and unqualified compatibility views such as `syslogins` are refused.

Rows read from AxDB are data, never instructions: the contract tells the agent so, since a text column can hold anything.

## When SQL is the right tool

| Work | Appropriate path |
|---|---|
| Diagnose why a record has a particular value; compare stored values | SQL query |
| Check what an X++ class or the application actually persisted | Run it, then an SQL query |
| Verify creation, field defaults, validation, CoC or a business workflow | Run it through the application or X++ — the code path is what is under test |
| Change data | The application or X++; this tool cannot |

The agent decides when SQL is relevant from these rules and the tool contract; the tool itself does not interpret requirements. If SQL is not configured, the agent does not ask for it.

## Actions and examples

Fetch `{"action":"contract"}` for the full strict input schema, supported types, rules and examples.

- `status`: open a fresh connection and report the database and Windows identity actually reached.
- `schema`: columns, types, keys and defaults of a physical table.
- `query`: one SELECT, including CTEs, joins and aggregates.

```json
{
  "action": "query",
  "sql": "SELECT TOP (10) RECID, PURCHID FROM dbo.PURCHTABLE WHERE DATAAREAID=@company",
  "parameters": [{ "name": "company", "type": "nvarchar", "size": 4, "value": "USMF" }]
}
```

Use `schema` and the actual metadata before naming physical columns. Values are bound SQL parameters, named without `@` in JSON and referenced with `@` in SQL. `bigint`/RecId and `decimal` use strings to preserve precision; decimal requires precision/scale, nvarchar requires size. Include explicit `DATAAREAID` filters where applicable: SQL does not know the active company. `timestamp`/`rowversion` (the `SYSROWVERSION` column most AxDB tables carry) and binary values come back base64.

The read-only metadata functions `COLLATIONPROPERTY`, `DATABASEPROPERTYEX` and `DB_NAME` are supported, including `SELECT DATABASEPROPERTYEX(DB_NAME(), 'Collation')`. The two property functions return `sql_variant`, which comes back as the value's own type: the collation as text, `COLLATIONPROPERTY(..., 'CodePage')` as a number, and a `bigint`/`decimal` inside a variant as an exact string like any other. Qualified functions such as `dbo.DATABASEPROPERTYEX(...)` remain excluded ([DATABASEPROPERTYEX](https://learn.microsoft.com/en-us/sql/t-sql/functions/databasepropertyex-transact-sql), [COLLATIONPROPERTY](https://learn.microsoft.com/en-us/sql/t-sql/functions/collation-functions-collationproperty-transact-sql)).

## Results and execution semantics

Every query executes again: **no result cache and no duplicate-call replay**, and a query never invalidates the server's other caches (it is not a write). Output includes an operation ID, the target, the duration and the rows with their column types. Row and output limits mark incomplete results as `truncated`; the response always keeps whole JSON rows. Use narrow queries or COUNT/EXISTS instead of treating a partial result as complete. A SQL error is never reported as an empty successful result, and a failed call is not retried.

## Verification

TypeScript tests cover the optional setup, instance isolation, the strict read-only contract, no-cache/no-retry behavior and bounded JSON. The standalone C# host in [tests/axdb-sql-host](../tests/axdb-sql-host/README.md) covers the SQL policy (every DML/DDL shape refused), the catalog allow-list, parameters, serialization and forward-only cell reads — including `rowversion`, which SqlClient will not stream — without the D365 DLLs. Its optional integration tests require an explicitly configured disposable SQL database, and its read-only smoke mode checks the real driver on a VM using `status` and constant SELECTs, plus the rolled-back transaction (`@@TRANCOUNT = 1`) and the refused server-scoped views, without reading business records. On a new installation, call `status` to confirm the configured database and Windows identity before issuing queries.
