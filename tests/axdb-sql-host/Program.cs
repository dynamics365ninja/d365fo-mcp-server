using System;
using System.Reflection;
using System.Collections.Generic;
using System.Data.SqlClient;
using System.Data.SqlTypes;
using System.Text.Json;
using System.Globalization;
using System.Threading;
using System.IO;
using System.Linq;
using Microsoft.SqlServer.TransactSql.ScriptDom;
using D365MetadataBridge.Models;
using D365MetadataBridge.Services;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--read-only") { ReadOnlySmoke.Run(); return 0; }
        if (args.Length != 0) throw new ArgumentException("Use no arguments for offline/fixture checks, or --read-only for SQL reader smoke checks.");
        var policy = Assembly.GetExecutingAssembly().GetType("D365MetadataBridge.Services.AxDbSqlPolicy");
        if (policy == null) { Console.Error.WriteLine("FAIL: SELECT policy must be implemented before SQL is enabled."); return 1; }
        var validate = policy.GetMethod("Validate", BindingFlags.Public | BindingFlags.Static)!;
        var failures = new List<string>();
        foreach (var sql in new[] {
            "SELECT COLLATIONPROPERTY('Latin1_General_100_CI_AS', 'CodePage')",
            "SELECT DATABASEPROPERTYEX('AxDB', 'Collation')",
            "SELECT DATABASEPROPERTYEX(DB_NAME(), 'Collation')",
            "SELECT collationproperty(@collation, @property), databasepropertyex(DB_NAME(), @property)"
        }) Check(sql, true);
        foreach (var sql in new[] {
            "SELECT dbo.COLLATIONPROPERTY('x', 'y')",
            "SELECT [dbo].[DATABASEPROPERTYEX]('x', 'y')",
            "SELECT dbo.DB_NAME()",
            "SELECT DATABASEPROPERTYEX_CUSTOM('x', 'y')"
        }) Check(sql, false);
        foreach (var sql in new[] { "SELECT * FROM dbo.CustTable", "WITH c AS (SELECT RECID FROM dbo.CustTable) SELECT COUNT(*) FROM c", "SELECT a.RECID FROM dbo.CustTable a JOIN dbo.Other b ON a.RECID=b.RECID", "SELECT 'EXEC DELETE INTO OPENROWSET' AS literal", "SELECT @@TRANCOUNT AS t" })
            Check(sql, true);
        foreach (var sql in new[] { "SELECT * INTO dbo.Other FROM dbo.CustTable", "DELETE dbo.CustTable", "SELECT 1; DELETE dbo.CustTable", "EXEC('SELECT 1')", "SELECT * FROM OtherDb.dbo.CustTable", "SELECT * FROM [server].[db].[dbo].[t]", "SELECT * FROM OPENQUERY(Remote, 'SELECT 1')", "SELECT * FROM OPENROWSET('x','y','z')", "SELECT dbo.CustomFunction()", "SELECT NEXT VALUE FOR dbo.Sequence", "SELECT @x = RECID FROM dbo.CustTable", "SELECT * FROM dbo.FunctionTable()", "SELECT 1 FOR XML AUTO", "SELECT * FROM #temp", "SELECT * FROM dbo.CustTable WITH (NOLOCK)", "SELECT CAST('x' AS dbo.CustomType)", "SELECT * FROM dbo.T OPTION (MAXDOP 0)", "SELECT * FROM OPENDATASOURCE('SQLNCLI','x').db.dbo.T", "SELECT * FROM (SELECT * FROM Other.dbo.T) x", "WITH c AS (SELECT dbo.CustomFunction() AS v) SELECT v FROM c", "SELECT [dbo].[CustomFunction]()" })
            Check(sql, false);
        // Read-only: every data modification is refused, whatever its shape.
        foreach (var sql in new[] { "INSERT dbo.T (x) VALUES (@x)", "UPDATE dbo.T SET x=@x", "DELETE dbo.T", "UPDATE t SET x=1 FROM dbo.T t JOIN dbo.U u ON t.id=u.id", "UPDATE dbo.T SET x=1; DELETE dbo.T", "MERGE dbo.T USING dbo.U ON 1=1 WHEN MATCHED THEN DELETE;", "BEGIN TRAN; DELETE dbo.T; COMMIT", "COMMIT", "ROLLBACK", "UPDATE dbo.T SET x=1 OUTPUT inserted.x", "TRUNCATE TABLE dbo.T", "INSERT dbo.T EXEC dbo.P", "UPDATE Other.dbo.T SET x=1", "CREATE TABLE dbo.X (a int)" }) Check(sql, false);
        foreach (var failure in failures) Console.Error.WriteLine(failure);
        if (failures.Count > 0) return 1;
        Console.WriteLine("PASS: SQL AST policy cases");
        Assert(AxDbSqlPolicy.Validate("SELECT * FROM CustTable")[0].Schema == "", "unqualified tables must resolve against SQL default schema instead of assuming dbo");
        if (Assembly.GetExecutingAssembly().GetType("D365MetadataBridge.Services.AxDbSqlService") == null)
        { Console.Error.WriteLine("FAIL: SQL service must expose structured unavailable results without connecting."); return 1; }
        var unavailable = new AxDbSqlService(new AxDbSqlOptions()).Handle("axdbQuery", null).GetAwaiter().GetResult();
        Assert((bool)unavailable["success"]! == false && JsonSerializer.Serialize(unavailable).Contains("AXDB_UNAVAILABLE"), "disabled SQL must fail without connecting");
        var guarded = new AxDbSqlService(new AxDbSqlOptions { Server = "invalid.never-connect.test" });
        var execute = guarded.Handle("axdbExecute", null).GetAwaiter().GetResult();
        Assert(JsonSerializer.Serialize(execute).Contains("Unknown AxDB SQL operation"), "there is no write operation: execute must fail before connecting");
        var invalidQuery = guarded.Handle("axdbQuery", Parse("{\"sql\":\"DELETE dbo.T\"}")).GetAwaiter().GetResult();
        Assert(JsonSerializer.Serialize(invalidQuery).Contains("AXDB_INVALID_REQUEST"), "invalid query must fail before connecting");
        var builder = new SqlConnectionStringBuilder(new AxDbSqlOptions { Server = "db", Database = "fixture" }.ConnectionString());
        Assert(builder.Encrypt && builder.IntegratedSecurity && !builder.TrustServerCertificate && builder.ConnectTimeout == 30, "secure integrated connection defaults");
        Assert(builder.ConnectRetryCount == 0, "SQL driver transparent connection recovery must be disabled");
        var bigint = Parameter("{\"name\":\"id\",\"type\":\"bigint\",\"value\":\"9223372036854775807\"}").ToSqlParameter();
        Assert((long)bigint.Value == long.MaxValue, "bigint exact input");
        Assert((string)AxDbSqlService.ExactValue(long.MaxValue)! == "9223372036854775807", "bigint exact output");
        var largeDecimal = "123456789012345678901234567890.12345678";
        var number = Parameter("{\"name\":\"n\",\"type\":\"decimal\",\"precision\":38,\"scale\":8,\"value\":\"" + largeDecimal + "\"}").ToSqlParameter();
        Assert((string)AxDbSqlService.ExactValue((SqlDecimal)number.Value)! == largeDecimal, "decimal38 exact round trip");
        var culture = Thread.CurrentThread.CurrentCulture;
        Thread.CurrentThread.CurrentCulture = CultureInfo.GetCultureInfo("it-IT");
        try { Assert((string)AxDbSqlService.ExactValue((SqlDecimal)number.Value)! == largeDecimal, "decimal38 culture-independent output"); }
        finally { Thread.CurrentThread.CurrentCulture = culture; }
        // sql_variant (DATABASEPROPERTYEX, COLLATIONPROPERTY) unwraps to its base type's usual shape.
        Assert((string)AxDbSqlService.VariantValue(new SqlString("SQL_Latin1_General_CP1_CI_AS"))! == "SQL_Latin1_General_CP1_CI_AS", "sql_variant text");
        Assert((int)AxDbSqlService.VariantValue(new SqlInt32(1252))! == 1252, "sql_variant int");
        Assert((string)AxDbSqlService.VariantValue(new SqlInt64(long.MaxValue))! == "9223372036854775807", "sql_variant bigint exact");
        Assert((string)AxDbSqlService.VariantValue((SqlDecimal)number.Value)! == largeDecimal, "sql_variant decimal38 exact");
        Assert((string)AxDbSqlService.VariantValue(new SqlBinary(new byte[] { 0, 255 }))! == "AP8=", "sql_variant binary");
        Assert(AxDbSqlService.VariantValue(SqlString.Null) == null && AxDbSqlService.VariantValue(SqlInt32.Null) == null, "sql_variant NULL base value");
        Reject(() => Parameter("{\"name\":\"n\",\"type\":\"decimal\",\"precision\":4,\"scale\":1,\"value\":\"1.25\"}").ToSqlParameter(), "decimal rounding rejected");
        Reject(() => Parameter("{\"name\":\"n\",\"type\":\"nvarchar\",\"size\":2,\"value\":\"abc\"}").ToSqlParameter(), "nvarchar truncation rejected");
        Reject(() => Parameter("{\"name\":\"n\",\"type\":\"bigint\",\"value\":9007199254740993}").ToSqlParameter(), "numeric bigint rejected");
        Reject(() => Parameter("{\"name\":\"n\",\"type\":\"decimal\",\"precision\":5,\"scale\":2,\"value\":12.34}").ToSqlParameter(), "numeric decimal rejected");
        Reject(() => Parameter("{\"name\":\"n\",\"type\":\"nvarchar\",\"size\":2}").ToSqlParameter(), "missing value rejected");
        Assert(Parameter("{\"name\":\"n\",\"type\":\"int\",\"value\":null}").ToSqlParameter().Value == DBNull.Value, "explicit SQL null");
        foreach (var view in new[] { "tables", "columns", "indexes", "index_columns", "foreign_keys", "key_constraints", "default_constraints", "partitions" })
            Assert(AxDbSqlService.CatalogViews.Contains(view), "catalog view allowed for debugging: sys." + view);
        foreach (var view in new[] { "sql_logins", "server_principals", "dm_exec_sessions", "syslogins", "database_principals", "credentials", "configurations", "servers" })
            Assert(!AxDbSqlService.CatalogViews.Contains(view), "server-scoped or secret-bearing view must stay out: sys." + view);
        Console.WriteLine("PASS: disabled service, preflight, secure connection, catalog allow-list, parameter fidelity and serialization");
        var schemaQuery = typeof(AxDbSqlService).GetField("SchemaSql", BindingFlags.Static | BindingFlags.NonPublic)?.GetRawConstantValue() as string;
        Assert(schemaQuery != null, "schema query must expose catalog defaults and primary-key membership");
        var schemaAst = (TSqlScript)new TSql160Parser(true).Parse(new StringReader(schemaQuery!), out var schemaErrors);
        Assert(schemaErrors.Count == 0, "schema catalog SQL must parse");
        var schemaSelect = (QuerySpecification)((SelectStatement)schemaAst.Batches[0].Statements[0]).QueryExpression;
        var schemaColumns = schemaSelect.SelectElements.OfType<SelectScalarExpression>().Select(column => column.ColumnName?.Value).ToArray();
        Assert(new[] { "defaultDefinition", "isPrimaryKey", "primaryKeyOrdinal" }.All(schemaColumns.Contains), "schema exposes default and primary-key columns");
        Assert(schemaAst.ScriptTokenStream.Count(token => token.Text == "@schema") == 1 && schemaAst.ScriptTokenStream.Count(token => token.Text == "@table") == 1, "schema catalog filtering stays parameterized");
        Console.WriteLine("PASS: schema catalog query parses with parameterized filtering and default/primary-key projections");
        SequentialCellChecks.Run();
        StreamErrorChecks.Run();
        LiveFixture.Run();
        return 0;

        void Check(string sql, bool allow)
        {
            bool accepted;
            try { validate.Invoke(null, new object[] { sql }); accepted = true; }
            catch (TargetInvocationException e) when (e.InnerException is ArgumentException) { accepted = false; }
            if (accepted != allow) failures.Add("FAIL: " + (allow ? "rejected " : "accepted ") + sql);
        }
    }

    private static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement.Clone();
    private static AxDbSqlParameter Parameter(string json) => JsonSerializer.Deserialize<AxDbSqlParameter>(json, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase })!;
    private static void Assert(bool value, string message) { if (!value) throw new Exception("FAIL: " + message); }
    private static void Reject(Action action, string message)
    {
        try { action(); } catch (ArgumentException) { return; }
        throw new Exception("FAIL: " + message);
    }
}
