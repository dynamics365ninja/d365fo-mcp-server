using System;
using System.Collections.Generic;
using System.Data.SqlClient;
using System.Linq;
using System.Text.Json;
using D365MetadataBridge.Models;
using D365MetadataBridge.Services;

internal static class LiveFixture
{
    public static void Run()
    {
        var server = Environment.GetEnvironmentVariable("D365FO_SQL_TEST_SERVER");
        var database = Environment.GetEnvironmentVariable("D365FO_SQL_TEST_DATABASE");
        if (string.IsNullOrWhiteSpace(server) || string.IsNullOrWhiteSpace(database))
        { Console.WriteLine("SKIP: live SQL fixture (explicit D365FO_SQL_TEST_SERVER and D365FO_SQL_TEST_DATABASE are unset)"); return; }
        if (!database.StartsWith("CodexAxDbFixture_", StringComparison.Ordinal) || Environment.GetEnvironmentVariable("D365FO_SQL_TEST_ALLOW_MUTATION") != "1")
            throw new Exception("Live tests require a disposable database named CodexAxDbFixture_* and D365FO_SQL_TEST_ALLOW_MUTATION=1. Never point this host at AxDB.");
        var options = new AxDbSqlOptions { Server = server!, Database = database!, TrustCertificate = Environment.GetEnvironmentVariable("D365FO_SQL_TEST_TRUST_CERTIFICATE") == "1", TimeoutSeconds = 2 };
        var service = new AxDbSqlService(options);
        var table = "AxDbTest_" + Guid.NewGuid().ToString("N");
        // The fixture's own setup connection writes; the service under test only reads.
        using (var setup = new SqlConnection(options.ConnectionString()))
        {
            setup.Open();
            Admin(setup, "CREATE TABLE dbo.[" + table + "] (Id bigint NOT NULL PRIMARY KEY, Amount decimal(38,8), Note nvarchar(max) DEFAULT (N'fixture default'), LegacyText text, LegacyNText ntext, LegacyBinary image, SYSROWVERSION rowversion);");
            try
            {
                var status = Call(service, "status", new { }); Require(status, "success", true); Require(status, "readOnly", true);
                var schema = Call(service, "schema", new { table, schema = "dbo" }); Require(schema, "success", true);
                var schemaRows = (List<Dictionary<string, object?>>)schema["rows"]!;
                var idColumn = schemaRows.Single(column => Equals(column["name"], "Id"));
                var noteColumn = schemaRows.Single(column => Equals(column["name"], "Note"));
                Require(idColumn, "isPrimaryKey", true);
                if (Convert.ToInt32(idColumn["primaryKeyOrdinal"]) != 1) throw new Exception("Live schema did not report the primary-key column ordinal");
                Require(noteColumn, "isPrimaryKey", false);
                if (!(noteColumn["defaultDefinition"] is string definition) || !definition.Contains("fixture default")) throw new Exception("Live schema did not report the physical default definition");

                Admin(setup, "INSERT dbo.[" + table + "] (Id,Amount,Note,LegacyText,LegacyNText,LegacyBinary) VALUES (9223372036854775807, 123456789012345678901234567890.12345678, N'before', 'legacy', N'caffè 界', 0x00FF)");
                var query = Call(service, "query", new { sql = "SELECT Id,Amount,Note FROM dbo.[" + table + "]" });
                Require(query, "success", true);
                var rows = (List<Dictionary<string, object?>>)query["rows"]!;
                if (!Equals(rows[0]["Id"], "9223372036854775807") || !Equals(rows[0]["Amount"], "123456789012345678901234567890.12345678")) throw new Exception("Live precision loss");
                var legacy = Call(service, "query", new { sql = "SELECT LegacyText,LegacyNText,LegacyBinary,SYSROWVERSION,Id FROM dbo.[" + table + "]" });
                Require(legacy, "success", true);
                var legacyRow = ((List<Dictionary<string, object?>>)legacy["rows"]!)[0];
                Require(legacyRow, "LegacyText", "legacy"); Require(legacyRow, "LegacyNText", "caffè 界"); Require(legacyRow, "LegacyBinary", "AP8=");
                Require(legacyRow, "Id", "9223372036854775807");
                if (Convert.FromBase64String((string)legacyRow["SYSROWVERSION"]!).Length != 8) throw new Exception("Invalid rowversion decoding");
                // SELECT * on a table carrying SYSROWVERSION, the shape of almost every AxDB table.
                var star = Call(service, "query", new { sql = "SELECT * FROM dbo.[" + table + "]" });
                Require(star, "success", true);

                // The second guard: statements run inside a transaction that is always rolled back.
                var tran = Call(service, "query", new { sql = "SELECT @@TRANCOUNT AS t" });
                Require(((List<Dictionary<string, object?>>)tran["rows"]!)[0], "t", 1);
                foreach (var secret in new[] { "SELECT name FROM sys.sql_logins", "SELECT name FROM syslogins", "SELECT name FROM sys.server_principals" })
                    Require(Call(service, "query", new { sql = secret }), "success", false);
                Require(Call(service, "query", new { sql = "SELECT TOP (1) name FROM sys.tables" }), "success", true);
                Require(Call(service, "execute", new { statements = new[] { new { sql = "DELETE dbo.[" + table + "]" } } }), "success", false);
                Require(Call(service, "query", new { sql = "DELETE dbo.[" + table + "]" }), "success", false);
                var still = Call(service, "query", new { sql = "SELECT COUNT(*) AS n FROM dbo.[" + table + "]" });
                Require(((List<Dictionary<string, object?>>)still["rows"]!)[0], "n", 1);

                var duplicates = Call(service, "query", new { sql = "SELECT Id,Id FROM dbo.[" + table + "]" }); Require(duplicates, "success", false);
                var cap = Call(service, "query", new { sql = "SELECT 1 AS n UNION ALL SELECT 2", maxRows = 1 }); Require(cap, "truncated", true);
                var bytes = Call(service, "query", new { sql = "SELECT REPLICATE(N'界',4000) AS text FROM sys.objects" });
                // REPLICATE is deliberately outside the built-in allowlist; byte cap uses materialized fixture data instead.
                Require(bytes, "success", false);
                Admin(setup, "UPDATE dbo.[" + table + "] SET Note=REPLICATE(CAST(N'界' AS nvarchar(max)),30000)");
                var byteCap = Call(service, "query", new { sql = "SELECT a.Note FROM dbo.[" + table + "] a CROSS JOIN sys.objects b", maxRows = 1000 });
                Require(byteCap, "success", true); Require(byteCap, "truncated", true);
                if (JsonSerializer.SerializeToUtf8Bytes(byteCap).Length > AxDbSqlService.ResponseByteLimit) throw new Exception("Response byte limit exceeded");
                using (var blocking = setup.BeginTransaction())
                {
                    using (var command = new SqlCommand("UPDATE dbo.[" + table + "] SET Note='blocked'", setup, blocking)) command.ExecuteNonQuery();
                    var timeout = Call(service, "query", new { sql = "SELECT Note FROM dbo.[" + table + "]" });
                    Require(timeout, "success", false);
                    if (!JsonSerializer.Serialize(timeout).Contains("AXDB_TIMEOUT")) throw new Exception("Expected bounded SQL timeout");
                    blocking.Rollback();
                }
                Console.WriteLine("PASS: live fixture reads, rowversion and SELECT *, rolled-back transaction, catalog allow-list, writes refused, precision, schema, row/byte caps, timeout");
            }
            finally { Admin(setup, "DROP TABLE dbo.[" + table + "];"); }
        }
    }

    private static Dictionary<string, object?> Call(AxDbSqlService service, string action, object value) => service.Handle("axdb" + action, JsonSerializer.SerializeToElement(value)).GetAwaiter().GetResult();
    private static void Admin(SqlConnection connection, string sql) { using (var command = new SqlCommand(sql, connection) { CommandTimeout = 10 }) command.ExecuteNonQuery(); }
    private static void Require(Dictionary<string, object?> result, string key, object expected)
    {
        if (!result.TryGetValue(key, out var actual) || !Equals(actual, expected)) throw new Exception("Fixture assertion " + key + " expected " + expected + ": " + JsonSerializer.Serialize(result));
    }
}
