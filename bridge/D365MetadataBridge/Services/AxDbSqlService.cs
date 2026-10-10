using System;
using System.Collections.Generic;
using System.Data;
using System.Data.Common;
using System.Data.SqlClient;
using System.Data.SqlTypes;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using D365MetadataBridge.Models;

namespace D365MetadataBridge.Services
{
    /// <summary>
    /// Lazy, fresh, read-only SQL debug operations. No connection on construction and no retry of any operation.
    ///
    /// Two independent guards stand between a request and a write, because on a D365FO dev VM the
    /// account running MCP is normally sysadmin, so SQL permissions restrict nothing:
    ///  1. <see cref="AxDbSqlPolicy"/> admits exactly one SELECT, checked on the ScriptDom syntax tree;
    ///  2. every operation runs inside a transaction that is ALWAYS rolled back. A statement the policy
    ///     should have refused, or a parse the engine reads differently from ScriptDom, can still not
    ///     leave a change behind: there is no path in this class that commits.
    /// Catalog access is limited to an allow-list of database-scoped sys views (<see cref="CatalogViews"/>),
    /// so server-level secrets such as sys.sql_logins stay out of reach.
    /// </summary>
    public sealed class AxDbSqlService
    {
        public const int ResponseByteLimit = 256 * 1024;

        /// <summary>
        /// The sys catalog views a query may read: what debugging a table needs (its columns, keys,
        /// indexes, constraints, triggers, row counts) and nothing server-scoped. Checked against the
        /// object the name actually RESOLVES to, so an unqualified compatibility view such as
        /// `syslogins` (which resolves into sys) is refused too.
        /// </summary>
        internal static readonly HashSet<string> CatalogViews = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "tables", "columns", "types", "schemas", "objects", "indexes", "index_columns",
            "foreign_keys", "foreign_key_columns", "key_constraints", "default_constraints",
            "check_constraints", "computed_columns", "identity_columns", "views", "triggers", "partitions",
        };
        private const string SchemaSql = @"SELECT c.column_id AS ordinal, c.name AS name, t.name AS type,
c.max_length AS maxLength, c.precision AS precision, c.scale AS scale, c.is_nullable AS isNullable,
c.is_identity AS isIdentity, c.is_computed AS isComputed, dc.definition AS defaultDefinition,
CONVERT(bit, CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END) AS isPrimaryKey,
pk.key_ordinal AS primaryKeyOrdinal
FROM sys.columns c JOIN sys.types t ON c.user_type_id=t.user_type_id
JOIN sys.objects o ON c.object_id=o.object_id JOIN sys.schemas s ON o.schema_id=s.schema_id
LEFT JOIN sys.default_constraints dc ON c.default_object_id=dc.object_id
LEFT JOIN (
    SELECT ic.object_id, ic.column_id, ic.key_ordinal
    FROM sys.index_columns ic JOIN sys.indexes i ON ic.object_id=i.object_id AND ic.index_id=i.index_id
    WHERE i.is_primary_key=1 AND ic.key_ordinal>0
) pk ON c.object_id=pk.object_id AND c.column_id=pk.column_id
WHERE s.name=@schema AND o.name=@table ORDER BY c.column_id";
        private static readonly JsonSerializerOptions Json = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
        private readonly AxDbSqlOptions options;
        public bool Enabled => options.Enabled;

        public AxDbSqlService(AxDbSqlOptions options) { this.options = options; }

        public async Task<Dictionary<string, object?>> Handle(string method, JsonElement? input)
        {
            var watch = Stopwatch.StartNew();
            var result = new Dictionary<string, object?>
            {
                ["operationId"] = Guid.NewGuid().ToString("D"), ["server"] = options.Server,
                ["database"] = options.Database, ["durationMs"] = 0L, ["success"] = false
            };
            SqlConnection? connection = null;
            using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(45)))
            {
                try
                {
                    if (!Enabled) throw new AxDbFailure("AXDB_UNAVAILABLE", "AxDB SQL is disabled. Configure D365FO_SQL_ENABLED and D365FO_SQL_SERVER, then restart the server with an updated bridge.");
                    var request = input.HasValue ? JsonSerializer.Deserialize<AxDbSqlRequest>(input.Value.GetRawText(), Json) : new AxDbSqlRequest();
                    if (request == null) throw new ArgumentException("SQL request must be an object.");
                    var normalized = method.ToLowerInvariant();
                    if (normalized != "axdbstatus" && normalized != "axdbschema" && normalized != "axdbquery")
                        throw new ArgumentException("Unknown AxDB SQL operation.");
                    PlannedStatement? planned = normalized == "axdbquery" ? Plan(request) : null;
                    if (normalized == "axdbschema")
                    {
                        if (string.IsNullOrWhiteSpace(request.Table) || request.Table.Length > 128 || string.IsNullOrWhiteSpace(request.Schema) || request.Schema.Length > 128)
                            throw new ArgumentException("schema and table must be non-empty identifiers of at most 128 characters.");
                    }
                    var maxRows = request.MaxRows ?? options.MaxRows;
                    if (maxRows < 1 || maxRows > 1000) throw new ArgumentException("maxRows must be 1..1000.");
                    connection = new SqlConnection(options.ConnectionString());
                    await connection.OpenAsync(deadline.Token).ConfigureAwait(false);
                    // Second guard: everything below runs in a transaction that is only ever rolled back.
                    using (var init = Command(connection, "SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SET XACT_ABORT ON; SET NOCOUNT ON; SET LOCK_TIMEOUT 30000; BEGIN TRANSACTION;", watch))
                        await init.ExecuteNonQueryAsync(deadline.Token).ConfigureAwait(false);
                    if (normalized == "axdbstatus")
                    {
                        using (var command = Command(connection, "SELECT DB_NAME() AS databaseName, SUSER_SNAME() AS loginName, CONVERT(nvarchar(128), SERVERPROPERTY('ServerName')) AS serverName", watch))
                            await Read(command, result, 1, deadline.Token).ConfigureAwait(false);
                        result["available"] = true; result["readOnly"] = true;
                        result["timeoutSeconds"] = options.TimeoutSeconds; result["maxRows"] = options.MaxRows;
                    }
                    else if (normalized == "axdbschema")
                    {
                        await CheckTables(connection, new[] { new AxDbTableReference { Schema = request.Schema, Table = request.Table } }, watch, deadline.Token).ConfigureAwait(false);
                        using (var command = Command(connection, SchemaSql, watch))
                        {
                            command.Parameters.Add("@schema", SqlDbType.NVarChar, 128).Value = request.Schema;
                            command.Parameters.Add("@table", SqlDbType.NVarChar, 128).Value = request.Table;
                            await Read(command, result, 1000, deadline.Token).ConfigureAwait(false);
                        }
                    }
                    else
                    {
                        await CheckTables(connection, planned!.Tables, watch, deadline.Token).ConfigureAwait(false);
                        using (var command = Command(connection, request.Sql, watch))
                        {
                            command.Parameters.AddRange(planned.Parameters);
                            await Read(command, result, maxRows, deadline.Token).ConfigureAwait(false);
                        }
                    }
                    result["success"] = true;
                }
                catch (Exception exception)
                {
                    var code = FailureCode(exception, deadline.IsCancellationRequested);
                    var message = exception.Message;
                    if (message.Length > 2048) message = message.Substring(0, 2048);
                    result["error"] = new { code, message };
                    // A failed read returns no partial dataset, including oversized column metadata.
                    result.Remove("columns"); result.Remove("rows"); result.Remove("truncated");
                    if (normalizedStatus(method)) result["available"] = false;
                }
                finally
                {
                    // Roll back whatever the transaction holds, then close. Disposing the connection
                    // without a commit rolls back too; the explicit rollback just does not wait for it.
                    if (connection != null && connection.State == ConnectionState.Open)
                    {
                        try
                        {
                            using (var rollback = new SqlCommand("IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;", connection) { CommandTimeout = 5 })
                                await rollback.ExecuteNonQueryAsync().ConfigureAwait(false);
                        }
                        catch { }
                    }
                    // No transparent retries, reconnects or operation replay.
                    try { connection?.Dispose(); } catch { }
                    result["durationMs"] = watch.ElapsedMilliseconds;
                }
            }
            return result;
        }

        private static bool normalizedStatus(string method) => string.Equals(method, "axdbStatus", StringComparison.OrdinalIgnoreCase);

        internal static string FailureCode(Exception exception, bool deadlineCancelled)
        {
            if (deadlineCancelled) return "AXDB_TIMEOUT";
            // SqlSequentialStream/TextReader wrap provider failures in IOException.
            while (exception is IOException && exception.InnerException != null) exception = exception.InnerException;
            return exception is AxDbFailure failure ? failure.Code :
                exception is OperationCanceledException || (exception is SqlException sql && sql.Number == -2) ? "AXDB_TIMEOUT" :
                exception is SqlException ? "AXDB_SQL_ERROR" : "AXDB_INVALID_REQUEST";
        }

        private PlannedStatement Plan(AxDbSqlRequest request)
        {
            var tables = AxDbSqlPolicy.Validate(request.Sql);
            var parameters = (request.Parameters ?? new List<AxDbSqlParameter>()).Select(p => p.ToSqlParameter()).ToArray();
            if (parameters.Length > 200 || parameters.Select(p => p.ParameterName).Distinct(StringComparer.OrdinalIgnoreCase).Count() != parameters.Length)
                throw new ArgumentException("At most 200 parameters with distinct names are supported.");
            return new PlannedStatement { Request = request, Tables = tables, Parameters = parameters };
        }

        private SqlCommand Command(SqlConnection connection, string sql, Stopwatch watch)
        {
            var remaining = 45 - watch.Elapsed.TotalSeconds;
            if (remaining <= 0) throw new OperationCanceledException("AxDB SQL operation exceeded its 45-second budget.");
            return new SqlCommand(sql, connection) { CommandTimeout = Math.Max(1, Math.Min(options.TimeoutSeconds, (int)Math.Ceiling(remaining))) };
        }

        private async Task CheckTables(SqlConnection connection, IEnumerable<AxDbTableReference> tables, Stopwatch watch, CancellationToken token)
        {
            foreach (var table in tables.GroupBy(t => t.Schema + "\0" + t.Table, StringComparer.Ordinal).Select(g => g.First()))
            {
                using (var command = Command(connection, @"SELECT o.type, o.is_ms_shipped,
CASE WHEN EXISTS (SELECT 1 FROM sys.external_tables e WHERE e.object_id=o.object_id) THEN 1 ELSE 0 END AS externalTable, s.name, o.name
FROM sys.all_objects o JOIN sys.schemas s ON o.schema_id=s.schema_id
WHERE (@schema='' AND o.object_id=OBJECT_ID(QUOTENAME(@table))) OR (s.name=@schema AND o.name=@table)", watch))
                {
                    command.Parameters.Add("@schema", SqlDbType.NVarChar, 128).Value = table.Schema;
                    command.Parameters.Add("@table", SqlDbType.NVarChar, 128).Value = table.Table;
                    using (var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false))
                    {
                        if (!await reader.ReadAsync(token).ConfigureAwait(false)) throw new ArgumentException("Local table not found or not visible: " + table.Schema + "." + table.Table);
                        var type = reader.GetString(0).Trim();
                        var catalog = reader.GetString(3).Equals("sys", StringComparison.OrdinalIgnoreCase) && reader.GetBoolean(1) && type == "V";
                        if (catalog && !CatalogViews.Contains(reader.GetString(4)))
                            throw new ArgumentException("sys." + reader.GetString(4) + " is not readable here. Catalog views allowed for debugging: sys." + string.Join(", sys.", CatalogViews.OrderBy(v => v, StringComparer.Ordinal)) + ".");
                        if (reader.GetInt32(2) != 0 || !(type == "U" || catalog))
                            throw new ArgumentException("Only local base tables and the allowed sys catalog views are supported; views, synonyms and external tables are rejected: " + table.Schema + "." + table.Table);
                    }
                }
            }
        }

        private static async Task Read(SqlCommand command, Dictionary<string, object?> result, int maxRows, CancellationToken token)
        {
            var rows = new List<Dictionary<string, object?>>();
            var columns = new List<object>();
            result["columns"] = columns; result["rows"] = rows; result["truncated"] = false;
            // Keep cancellation active during synchronous bounded stream reads too.
            using (token.Register(() => { try { command.Cancel(); } catch (InvalidOperationException) { } }))
            using (var reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, token).ConfigureAwait(false))
            {
                var names = new HashSet<string>(StringComparer.Ordinal);
                for (var i = 0; i < reader.FieldCount; i++)
                {
                    if (!names.Add(reader.GetName(i))) throw new ArgumentException("Duplicate result column names are unsupported; give columns unique aliases.");
                    columns.Add(new { name = reader.GetName(i), type = reader.GetDataTypeName(i) });
                }
                if (JsonSerializer.SerializeToUtf8Bytes(result, Json).Length > ResponseByteLimit - 4096)
                    throw new ArgumentException("Result column metadata exceeds the response budget.");
                while (await reader.ReadAsync(token).ConfigureAwait(false))
                {
                    if (rows.Count == maxRows) { result["truncated"] = true; break; }
                    var row = new Dictionary<string, object?>();
                    for (var i = 0; i < reader.FieldCount; i++) row[reader.GetName(i)] = Cell(reader, i, token);
                    rows.Add(row);
                    if (JsonSerializer.SerializeToUtf8Bytes(result, Json).Length > ResponseByteLimit - 4096)
                    { rows.RemoveAt(rows.Count - 1); result["truncated"] = true; break; }
                }
            }
        }

        public static object? ExactValue(object value)
        {
            if (value == DBNull.Value || value is INullable nullable && nullable.IsNull) return null;
            if (value is SqlDecimal decimalValue) return decimalValue.ToString();
            if (value is long number) return number.ToString(CultureInfo.InvariantCulture);
            if (value is decimal fixedNumber) return fixedNumber.ToString(CultureInfo.InvariantCulture);
            if (value is DateTime time) return time.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff", CultureInfo.InvariantCulture);
            if (value is DateTimeOffset offset) return offset.ToString("o", CultureInfo.InvariantCulture);
            if (value is TimeSpan span) return span.ToString("c", CultureInfo.InvariantCulture);
            if (value is Guid guid) return guid.ToString("D");
            if (value is byte[] binary) return Convert.ToBase64String(binary);
            if (value is double floating && (double.IsInfinity(floating) || double.IsNaN(floating))) throw new ArgumentException("Non-finite SQL value is unsupported.");
            if (value is string || value is bool || value is byte || value is short || value is int || value is double || value is float) return value;
            throw new ArgumentException("Unsupported result type: " + value.GetType().Name);
        }

        internal static object? Cell(DbDataReader reader, int ordinal, CancellationToken token = default)
        {
            token.ThrowIfCancellationRequested();
            if (reader.IsDBNull(ordinal)) return null;
            var type = reader.GetDataTypeName(ordinal).ToLowerInvariant();
            // Avoid overflowing CLR decimal for SQL decimal(38,s).
            if (type == "decimal" || type == "numeric") return ExactValue(reader.GetProviderSpecificValue(ordinal));
            if (type == "nvarchar" || type == "varchar" || type == "nchar" || type == "char" || type == "ntext" || type == "text")
            {
                // Never probe length then call GetValue: SequentialAccess forbids rereading
                // a streamed column. GetTextReader also avoids buffering legacy text/ntext.
                using (var stream = reader.GetTextReader(ordinal))
                {
                    var value = new StringBuilder();
                    var buffer = new char[4096];
                    while (true)
                    {
                        token.ThrowIfCancellationRequested();
                        var count = stream.Read(buffer, 0, Math.Min(buffer.Length, ResponseByteLimit / 2 - value.Length + 1));
                        token.ThrowIfCancellationRequested();
                        if (count == 0) return value.ToString();
                        if (value.Length + count > ResponseByteLimit / 2) throw new AxDbFailure("AXDB_CELL_TOO_LARGE", "One SQL cell exceeds the response budget; select a smaller substring.");
                        value.Append(buffer, 0, count);
                    }
                }
            }
            // timestamp/rowversion is always 8 bytes, and SqlClient refuses GetStream on it
            // ("Invalid attempt to GetStream on column 'SYSROWVERSION'") — the column almost every
            // AxDB table carries, so SELECT * failed on all of them.
            if (type == "timestamp" || type == "rowversion")
            {
                var version = new byte[8];
                var read = 0;
                while (read < version.Length)
                {
                    var count = (int)reader.GetBytes(ordinal, read, version, read, version.Length - read);
                    if (count == 0) break;
                    read += count;
                }
                return Convert.ToBase64String(version, 0, read);
            }
            if (type == "varbinary" || type == "binary" || type == "image")
            {
                using (var stream = reader.GetStream(ordinal))
                using (var value = new MemoryStream())
                {
                    var buffer = new byte[4096];
                    while (true)
                    {
                        token.ThrowIfCancellationRequested();
                        var count = stream.Read(buffer, 0, (int)Math.Min(buffer.Length, ResponseByteLimit / 2 - value.Length + 1));
                        token.ThrowIfCancellationRequested();
                        if (count == 0) return Convert.ToBase64String(value.ToArray());
                        if (value.Length + count > ResponseByteLimit / 2) throw new AxDbFailure("AXDB_CELL_TOO_LARGE", "One binary SQL cell exceeds the response budget.");
                        value.Write(buffer, 0, count);
                    }
                }
            }
            // DATABASEPROPERTYEX, COLLATIONPROPERTY and SERVERPROPERTY return sql_variant; the value
            // inside has a concrete base type. The provider-specific value keeps it exact (SqlDecimal
            // holds decimal(38,s), which GetValue would overflow into a CLR decimal).
            if (type == "sql_variant") return VariantValue(reader.GetProviderSpecificValue(ordinal));
            if (!ScalarTypes.Contains(type)) throw new ArgumentException("Unsupported SQL result type: " + type + "; explicitly convert it to a supported scalar type.");
            return ExactValue(reader.GetValue(ordinal));
        }

        internal static object? VariantValue(object value)
        {
            switch (value)
            {
                case INullable nullable when nullable.IsNull: return null;
                case SqlString text: return text.Value;
                case SqlInt64 number: return ExactValue(number.Value);
                case SqlInt32 number: return number.Value;
                case SqlInt16 number: return number.Value;
                case SqlByte number: return number.Value;
                case SqlBoolean flag: return flag.Value;
                case SqlDouble floating: return ExactValue(floating.Value);
                case SqlSingle floating: return ExactValue(floating.Value);
                case SqlMoney money: return ExactValue(money.Value);
                case SqlDateTime time: return ExactValue(time.Value);
                case SqlGuid guid: return ExactValue(guid.Value);
                case SqlBinary binary: return ExactValue(binary.Value);
                // SqlDecimal, and the types SqlClient returns unwrapped (datetime2/date/time/datetimeoffset).
                default: return ExactValue(value);
            }
        }

        private static readonly HashSet<string> ScalarTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "bigint", "int", "smallint", "tinyint", "bit", "money", "smallmoney", "float", "real",
            "date", "datetime", "smalldatetime", "datetime2", "datetimeoffset", "time", "uniqueidentifier",
            "nvarchar", "varchar", "nchar", "char", "ntext", "text", "varbinary", "binary", "image", "timestamp", "rowversion"
        };

        private sealed class PlannedStatement
        {
            public AxDbSqlRequest Request { get; set; } = null!;
            public IReadOnlyList<AxDbTableReference> Tables { get; set; } = null!;
            public SqlParameter[] Parameters { get; set; } = null!;
        }
        private sealed class AxDbFailure : Exception
        {
            public string Code { get; }
            public AxDbFailure(string code, string message) : base(message) { Code = code; }
        }
    }
}
