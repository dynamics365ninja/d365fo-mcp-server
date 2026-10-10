using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.SqlServer.TransactSql.ScriptDom;

namespace D365MetadataBridge.Services
{
    public sealed class AxDbTableReference
    {
        public string Schema { get; set; } = "dbo";
        public string Table { get; set; } = "";
    }

    /// <summary>
    /// Conservative AST validation: exactly one SELECT. This is the FIRST guard, not the only one —
    /// on a dev VM the MCP account is normally sysadmin, so SQL permissions restrict nothing, and
    /// AxDbSqlService runs every statement in a transaction it always rolls back (the second guard).
    /// </summary>
    public static class AxDbSqlPolicy
    {
        private static readonly HashSet<string> Functions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "COUNT", "COUNT_BIG", "SUM", "AVG", "MIN", "MAX", "ABS", "ROUND", "CEILING", "FLOOR",
            "LEN", "DATALENGTH", "LOWER", "UPPER", "LTRIM", "RTRIM", "TRIM", "LEFT", "RIGHT", "SUBSTRING",
            "REPLACE", "CONCAT", "CONCAT_WS", "CHARINDEX", "PATINDEX", "ISNULL", "NULLIF", "COALESCE",
            "GETDATE", "GETUTCDATE", "SYSDATETIME", "SYSUTCDATETIME", "DATEADD", "DATEDIFF", "DATEDIFF_BIG",
            "DATEPART", "DATENAME", "YEAR", "MONTH", "DAY", "EOMONTH", "ROW_NUMBER", "RANK", "DENSE_RANK",
            "LAG", "LEAD", "FIRST_VALUE", "LAST_VALUE", "STRING_AGG", "STDEV", "STDEVP", "VAR", "VARP",
            "COLLATIONPROPERTY", "DATABASEPROPERTYEX", "DB_NAME"
        };

        public static IReadOnlyList<AxDbTableReference> Validate(string sql)
        {
            if (string.IsNullOrWhiteSpace(sql) || sql.Length > 65536)
                throw new ArgumentException("SQL must contain 1..65536 characters.");
            var parser = new TSql160Parser(true);
            var script = (TSqlScript)parser.Parse(new StringReader(sql), out var errors);
            if (errors.Count != 0) throw new ArgumentException("Invalid SQL: " + errors[0].Message);
            if (script.Batches.Count != 1 || script.Batches[0].Statements.Count != 1)
                throw new ArgumentException("Exactly one SQL statement is required per item; batches are not allowed.");
            var statement = script.Batches[0].Statements[0];
            if (!(statement is SelectStatement))
                throw new ArgumentException("Only SELECT is allowed.");

            var nodes = Walk(statement).ToList();
            // Exact spelling is conservative across both case-sensitive and case-insensitive database collations.
            // A case-folded match could hide a distinct physical table on a case-sensitive database.
            var ctes = new HashSet<string>(nodes.OfType<CommonTableExpression>().Select(c => c.ExpressionName.Value), StringComparer.Ordinal);
            var tables = new List<AxDbTableReference>();
            foreach (var node in nodes)
            {
                var kind = node.GetType().Name;
                if (node is TSqlStatement nested && nested != statement)
                    throw new ArgumentException("Nested SQL statements are not supported.");
                if (node is SelectStatement select && select.Into != null)
                    throw new ArgumentException("SELECT INTO is not allowed.");
                if (kind == "OutputClause" || kind == "OutputIntoClause" || kind == "ExecuteInsertSource" ||
                    kind == "NextValueForExpression" || kind == "SelectSetVariable" || kind.EndsWith("ForClause", StringComparison.Ordinal) ||
                    node is TableHint || node is OptimizerHint || node is UserDataTypeReference)
                    throw new ArgumentException("Unsupported SQL construct: " + kind + ".");
                if (node is FunctionCall function && (function.CallTarget != null || !Functions.Contains(function.FunctionName.Value)))
                    throw new ArgumentException("Only supported built-in SQL functions are allowed.");
                if (kind == "UserDefinedTypeCallTarget" || kind == "MultiPartIdentifierCallTarget")
                    throw new ArgumentException("User-defined methods are not allowed.");
                if (node is TableReference && !(node is NamedTableReference || node is QueryDerivedTable ||
                    node is QualifiedJoin || node is UnqualifiedJoin || node is JoinParenthesisTableReference || node is InlineDerivedTable))
                    throw new ArgumentException("Unsupported table source: " + kind + ".");
                if (node is NamedTableReference table)
                {
                    var name = table.SchemaObject;
                    if (name.Identifiers.Count > 2 || name.Identifiers.Count == 0 || name.BaseIdentifier.Value.StartsWith("#", StringComparison.Ordinal))
                        throw new ArgumentException("Only local database tables and CTEs are allowed.");
                    if (name.Identifiers.Count == 1 && ctes.Contains(name.BaseIdentifier.Value)) continue;
                    // Empty schema means SQL's normal default-schema resolution, not an assumed dbo object.
                    tables.Add(new AxDbTableReference { Schema = name.SchemaIdentifier?.Value ?? "", Table = name.BaseIdentifier.Value });
                }
            }
            return tables;
        }

        // Reflection walks only AST children, not tokens/parents. This also sees constructs nested in expressions/CTEs.
        private static IEnumerable<TSqlFragment> Walk(TSqlFragment root)
        {
            yield return root;
            foreach (var property in root.GetType().GetProperties())
            {
                if (property.GetIndexParameters().Length != 0 || property.Name == "ScriptTokenStream") continue;
                if (typeof(TSqlFragment).IsAssignableFrom(property.PropertyType))
                {
                    if (property.GetValue(root) is TSqlFragment child)
                        foreach (var node in Walk(child)) yield return node;
                }
                else if (property.PropertyType.IsGenericType && typeof(IEnumerable).IsAssignableFrom(property.PropertyType) &&
                    typeof(TSqlFragment).IsAssignableFrom(property.PropertyType.GetGenericArguments()[0]))
                {
                    if (property.GetValue(root) is IEnumerable children)
                        foreach (TSqlFragment child in children)
                            foreach (var node in Walk(child)) yield return node;
                }
            }
        }
    }
}
