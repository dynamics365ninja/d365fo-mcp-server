# Standalone AxDB SQL service checks

This net48 console host compiles the production SQL policy, models and service directly, without Dynamics assemblies. It never connects to SQL unless explicitly configured for the disposable live fixture.

```powershell
dotnet restore tests/axdb-sql-host/AxDbSqlHost.csproj --configfile bridge/D365MetadataBridge/NuGet.config
dotnet build tests/axdb-sql-host/AxDbSqlHost.csproj --no-restore
& tests/axdb-sql-host/bin/Debug/net48/AxDbSqlHost.exe
```

The ordinary run checks AST allow/reject cases (every DML/DDL shape refused), preflight validation, disabled SQL, the absent write operation, the catalog allow-list, integrated encrypted connection defaults, exact bigint/decimal(38,s) serialization, explicit NULL, and parameter truncation/rounding rejection. It also runs production cell decoding against a strict forward-only reader double: text/binary short chunks, rowversion read as 8 bytes (the double refuses GetStream on it, as SqlClient does), Unicode, empty/NULL, mixed columns, exact limits, oversize rejection and cancellation. This double catches rereads but does not replace real SqlClient testing. The ordinary run prints SKIP for live coverage when not configured. It uses the installed .NET Framework runtime; SDK 7 can compile this host. The full metadata bridge still needs its normal D365 binaries and SDK supporting its C#12 setting.

## Read-only smoke test on the developer VM

After building the host, use this explicit mode to check the real SQL driver against AxDB with Windows authentication. It runs `status` and SELECTs of constants/parameters only, checks that statements run inside the rolled-back transaction (`@@TRANCOUNT = 1`) and that server-scoped catalog views are refused, and never reads business records or invokes the fixture. This mode allows AxDB as the database name and ignores `D365FO_SQL_TEST_ALLOW_MUTATION`.

```powershell
$env:D365FO_SQL_TEST_SERVER = '<your SQL server or instance>'
$env:D365FO_SQL_TEST_DATABASE = 'AxDB'
# Set only if your developer SQL certificate requires it:
# $env:D365FO_SQL_TEST_TRUST_CERTIFICATE = '1'
& tests/axdb-sql-host/bin/Debug/net48/AxDbSqlHost.exe --read-only
```

Checks cover real `status` strings, ordinary/MAX text and binary columns, empty/NULL/zero rows, adjacent numeric/text columns, exact decimal(38,8)/bigint values, long Unicode, and oversized cells. Legacy `text`/`ntext`/`image` and `rowversion` use physical columns in the separate mutating fixture below. The mode fails if no connection is configured; it cannot silently report an offline pass.

## Mutating fixture (separate disposable database)

Aliases and CTE references should use the same letter casing as their declaration. Validation preserves exact identifier spelling so distinct objects on case-sensitive databases are never skipped by case-folded alias matches or catalog-check deduplication.

Schema query offline coverage parses the catalog SQL and checks the default/primary-key projections and parameter tokens. Actual catalog values are verified only by the opt-in live fixture: its `Id` column must report primary-key membership and ordinal, while `Note` must report its physical default definition. A skipped fixture is not evidence that those live catalog lookups executed.

For live checks, provision an empty **disposable** SQL Server database whose name starts with `CodexAxDbFixture_`. The current Windows identity needs table creation and read/write privileges there: the fixture's own setup connection writes the test data, the service under test only reads it. Set these variables only for this test process:

```powershell
$env:D365FO_SQL_TEST_SERVER = '<fixture SQL Server>'
$env:D365FO_SQL_TEST_DATABASE = 'CodexAxDbFixture_local'
$env:D365FO_SQL_TEST_ALLOW_MUTATION = '1'
# Only for a fixture server using a locally trusted/self-signed certificate:
$env:D365FO_SQL_TEST_TRUST_CERTIFICATE = '1'
& tests/axdb-sql-host/bin/Debug/net48/AxDbSqlHost.exe
```

The host creates a uniquely named table and trigger inside that database and removes them in `finally`. It never creates/deletes databases and refuses database names outside the fixture prefix. Never configure it with a real AxDB. Live coverage includes commit, batch rollback on assertions and SQL errors, exact numeric round trips, schema inspection, row/byte limits, direct row counts with triggers, and a blocked-read timeout. Lost commit acknowledgement requires an external fault-injection SQL proxy and is not claimed as tested by this host.
