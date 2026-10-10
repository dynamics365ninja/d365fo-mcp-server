using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using D365MetadataBridge.Models;
using D365MetadataBridge.Services;

// Explicit opt-in, real SqlClient reads only. Uses constants, never business tables or DDL/DML.
internal static class ReadOnlySmoke
{
    public static void Run()
    {
        var server = Environment.GetEnvironmentVariable("D365FO_SQL_TEST_SERVER");
        var database = Environment.GetEnvironmentVariable("D365FO_SQL_TEST_DATABASE");
        if (string.IsNullOrWhiteSpace(server) || string.IsNullOrWhiteSpace(database))
            throw new ArgumentException("--read-only requires D365FO_SQL_TEST_SERVER and D365FO_SQL_TEST_DATABASE.");
        var service = new AxDbSqlService(new AxDbSqlOptions { Server = server!, Database = database!,
            TrustCertificate = Environment.GetEnvironmentVariable("D365FO_SQL_TEST_TRUST_CERTIFICATE") == "1" });
        var status = Call(service, "status", new { });
        RequireSuccess(status);
        var identity = Rows(status).Single();
        if (!Equals(identity["databaseName"], database) || string.IsNullOrWhiteSpace(identity["loginName"] as string) || string.IsNullOrWhiteSpace(identity["serverName"] as string))
            throw new Exception("SQL status did not return the requested database and identity");
        Console.WriteLine("PASS: real SQL status (database/login/server text)");

        // The second guard: every statement runs inside a transaction the service only ever rolls back.
        Equal(Query(service, "SELECT @@TRANCOUNT AS t").Single()["t"], 1);
        foreach (var secret in new[] { "SELECT name FROM sys.sql_logins", "SELECT name FROM syslogins", "SELECT name FROM sys.server_principals" })
        {
            var refused = Call(service, "query", new { sql = secret });
            if (Equals(refused["success"], true)) throw new Exception("Server-scoped catalog view was readable: " + secret);
        }
        Console.WriteLine("PASS: statements run inside a rolled-back transaction; server-scoped catalog views refused");

        foreach (var type in new[] { "varchar(40)", "nvarchar(40)", "char(2)", "nchar(2)", "varchar(max)", "nvarchar(max)" })
        {
            var row = Query(service, "SELECT 7 AS beforeValue, CAST('ok' AS " + type + ") AS value, 8 AS afterValue").Single();
            Equal(row["value"], "ok"); Equal(row["beforeValue"], 7); Equal(row["afterValue"], 8);
        }
        foreach (var type in new[] { "varbinary(20)", "binary(2)", "varbinary(max)" })
        {
            var row = Query(service, "SELECT CAST(0x00FF AS " + type + ") AS value, N'after' AS afterValue").Single();
            Equal(row["value"], "AP8="); Equal(row["afterValue"], "after");
        }
        var empty = Query(service, "SELECT CAST('' AS varchar(10)) AS a, CAST(N'' AS nvarchar(max)) AS b, CAST(0x AS varbinary(max)) AS c, CAST(NULL AS nvarchar(max)) AS d, CAST(NULL AS varbinary(max)) AS e").Single();
        Equal(empty["a"], ""); Equal(empty["b"], ""); Equal(empty["c"], ""); Equal(empty["d"], null); Equal(empty["e"], null);
        if (Query(service, "SELECT CAST(N'unused' AS nvarchar(20)) AS value WHERE 1=0").Count != 0) throw new Exception("Empty query returned data");
        var exact = Query(service, "SELECT CAST(9223372036854775807 AS bigint) AS id, CAST(123456789012345678901234567890.12345678 AS decimal(38,8)) AS amount").Single();
        Equal(exact["id"], "9223372036854775807"); Equal(exact["amount"], "123456789012345678901234567890.12345678");
        var variant = Query(service, "SELECT 7 AS beforeValue, DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS collation, COLLATIONPROPERTY('Latin1_General_100_CI_AS', 'CodePage') AS codePage, " +
            "CAST(CAST(123456789012345678901234567890.12345678 AS decimal(38,8)) AS sql_variant) AS amount, CAST(CAST(9223372036854775807 AS bigint) AS sql_variant) AS id, CAST(NULL AS sql_variant) AS missing, 8 AS afterValue").Single();
        if (string.IsNullOrWhiteSpace(variant["collation"] as string)) throw new Exception("DATABASEPROPERTYEX did not return the collation as text");
        Equal(variant["codePage"], 1252); Equal(variant["amount"], "123456789012345678901234567890.12345678"); Equal(variant["id"], "9223372036854775807");
        Equal(variant["missing"], null); Equal(variant["beforeValue"], 7); Equal(variant["afterValue"], 8);
        Console.WriteLine("PASS: real SQL sql_variant from DATABASEPROPERTYEX/COLLATIONPROPERTY, exact decimal38/bigint inside a variant, NULL variant");
        var text = string.Concat(Enumerable.Repeat("à界😀", 3000));
        var parameters = new[] { new { name = "text", type = "nvarchar", size = -1, value = text } };
        var longResult = Call(service, "query", new { sql = "SELECT @text AS value, CONVERT(varbinary(max),@text) AS bytes, 9 AS afterValue", parameters });
        RequireSuccess(longResult);
        var longRow = Rows(longResult).Single();
        Equal(longRow["value"], text); Equal(longRow["bytes"], Convert.ToBase64String(Encoding.Unicode.GetBytes(text))); Equal(longRow["afterValue"], 9);
        foreach (var sql in new[] { "SELECT @text+@text+@text AS value", "SELECT CONVERT(varbinary(max),@text+@text+@text) AS value" })
        {
            var oversized = Call(service, "query", new { sql, parameters = new[] { new { name = "text", type = "nvarchar", size = -1, value = new string('x', 65536) } } });
            Equal(oversized["success"], false);
            if (!JsonSerializer.Serialize(oversized).Contains("AXDB_CELL_TOO_LARGE") || oversized.ContainsKey("rows")) throw new Exception("Oversized cell did not fail cleanly");
        }
        Console.WriteLine("PASS: real SQL text/binary types, mixed columns, empty/NULL/zero rows, decimal38/RecId, Unicode chunks and oversized cells");
    }
    private static Dictionary<string, object?> Call(AxDbSqlService service, string action, object value) => service.Handle("axdb" + action, JsonSerializer.SerializeToElement(value)).GetAwaiter().GetResult();
    private static List<Dictionary<string, object?>> Rows(Dictionary<string, object?> result) => (List<Dictionary<string, object?>>)result["rows"]!;
    private static void RequireSuccess(Dictionary<string, object?> result)
    { if (!Equals(result["success"], true)) throw new Exception(JsonSerializer.Serialize(result)); }
    private static List<Dictionary<string, object?>> Query(AxDbSqlService service, string sql)
    { var result = Call(service, "query", new { sql }); RequireSuccess(result); return Rows(result); }
    private static void Equal(object? actual, object? expected)
    { if (!Equals(actual, expected)) throw new Exception("Unexpected SQL smoke result"); }
}
