using System;
using System.Data.SqlClient;
using System.IO;
using System.Linq;
using System.Reflection;
using D365MetadataBridge.Services;

internal static class StreamErrorChecks
{
    public static void Run()
    {
        Check(new IOException("Stream read failed", SqlFailure(-2)), false, "AXDB_TIMEOUT");
        Check(new IOException("Stream read failed", SqlFailure(1205)), false, "AXDB_SQL_ERROR");
        Check(new IOException("Cancelled by command.Cancel"), true, "AXDB_TIMEOUT");
        Check(new OperationCanceledException(), false, "AXDB_TIMEOUT");
        Check(SqlFailure(-2), false, "AXDB_TIMEOUT");
        Check(SqlFailure(1205), false, "AXDB_SQL_ERROR");
        Check(new ArgumentException("Invalid input"), false, "AXDB_INVALID_REQUEST");
        Console.WriteLine("PASS: wrapped SQL stream timeouts/errors and deadline cancellation classification");
    }
    private static void Check(Exception error, bool deadline, string expected)
    {
        var actual = AxDbSqlService.FailureCode(error, deadline);
        if (actual != expected) throw new Exception("FAIL: stream error expected " + expected + ", got " + actual);
    }
    // SqlException has no public constructor. Build actual provider errors for classification only.
    private static SqlException SqlFailure(int number)
    {
        var constructor = typeof(SqlError).GetConstructors(BindingFlags.NonPublic | BindingFlags.Instance)
            .First(c => c.GetParameters().Length >= 7 && c.GetParameters()[0].ParameterType == typeof(int));
        var arguments = constructor.GetParameters().Select((p, i) => i == 0 ? (object)number :
            p.ParameterType == typeof(string) ? "test" : p.ParameterType.IsValueType ? Activator.CreateInstance(p.ParameterType) : null).ToArray();
        var collection = (SqlErrorCollection)Activator.CreateInstance(typeof(SqlErrorCollection), true)!;
        typeof(SqlErrorCollection).GetMethod("Add", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(collection, new[] { constructor.Invoke(arguments) });
        return (SqlException)typeof(SqlException).GetMethod("CreateException", BindingFlags.Static | BindingFlags.NonPublic,
            null, new[] { typeof(SqlErrorCollection), typeof(string) }, null)!.Invoke(null, new object[] { collection, "test" })!;
    }
}
