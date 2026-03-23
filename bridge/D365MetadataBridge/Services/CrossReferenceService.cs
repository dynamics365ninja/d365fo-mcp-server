using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;
using D365MetadataBridge.Models;

namespace D365MetadataBridge.Services
{
    /// <summary>
    /// Provides cross-reference queries using the DYNAMICSXREFDB SQL database.
    /// This replaces the FTS5 text-search approach with real compiler-resolved references.
    /// </summary>
    public class CrossReferenceService
    {
        private readonly string _connectionString;

        public CrossReferenceService(string server, string database)
        {
            _connectionString = $"Server={server};Database={database};Integrated Security=True;TrustServerCertificate=True;";

            // Test the connection
            using (var conn = new SqlConnection(_connectionString))
            {
                conn.Open();
                Console.Error.WriteLine($"[CrossRefService] Connected to {server}\\{database}");
            }
        }

        /// <summary>
        /// Find all references to a given object path.
        /// Object paths follow the D365FO convention:
        ///   /Tables/CustTable
        ///   /Tables/CustTable/Fields/AccountNum
        ///   /Classes/SalesFormLetter/Methods/run
        /// </summary>
        public object FindReferences(string objectPath)
        {
            var references = new List<ReferenceInfoModel>();

            // Schema: Names(Id, Path, ProviderId, ModuleId), References(SourceId, TargetId, Kind, Line, Column)
            // Modules(Id, Module), Providers(Id, Provider)
            // Path format: /Classes/ClassName, /Tables/TableName, /Enums/EnumName, etc.
            // If user passes plain name (e.g. "CustTable"), try common prefixes

            var pathVariants = new List<string>();
            if (objectPath.StartsWith("/"))
            {
                pathVariants.Add(objectPath);
            }
            else
            {
                // Try common AOT path prefixes
                pathVariants.Add($"/Tables/{objectPath}");
                pathVariants.Add($"/Classes/{objectPath}");
                pathVariants.Add($"/Enums/{objectPath}");
                pathVariants.Add($"/Views/{objectPath}");
                pathVariants.Add($"/DataEntityViews/{objectPath}");
                pathVariants.Add($"/Queries/{objectPath}");
                pathVariants.Add($"/Forms/{objectPath}");
            }

            // Build parameterized IN clause
            var paramNames = new List<string>();
            for (int i = 0; i < pathVariants.Count; i++) paramNames.Add($"@P{i}");

            const string queryTemplate = @"
                SELECT TOP 500
                    src.Path AS SourcePath,
                    sm.Module AS SourceModule,
                    r.Kind,
                    r.Line,
                    r.[Column]
                FROM [References] r
                INNER JOIN dbo.Names tgt ON tgt.Id = r.TargetId
                INNER JOIN dbo.Names src ON src.Id = r.SourceId
                LEFT  JOIN dbo.Modules sm ON sm.Id = src.ModuleId
                WHERE tgt.Path IN ({0})
                ORDER BY src.Path, r.Line";

            var query = string.Format(queryTemplate, string.Join(",", paramNames));

            try
            {
                using (var conn = new SqlConnection(_connectionString))
                {
                    conn.Open();
                    using (var cmd = new SqlCommand(query, conn))
                    {
                        for (int i = 0; i < pathVariants.Count; i++)
                            cmd.Parameters.AddWithValue($"@P{i}", pathVariants[i]);
                        cmd.CommandTimeout = 30;

                        using (var reader = cmd.ExecuteReader())
                        {
                            while (reader.Read())
                            {
                                references.Add(new ReferenceInfoModel
                                {
                                    SourcePath = reader.GetString(0),
                                    SourceModule = reader.IsDBNull(1) ? null : reader.GetString(1),
                                    Kind = reader.IsDBNull(2) ? null : reader.GetByte(2).ToString(),
                                    Line = reader.IsDBNull(3) ? 0 : (int)reader.GetInt16(3),
                                    Column = reader.IsDBNull(4) ? 0 : (int)reader.GetInt16(4),
                                });
                            }
                        }
                    }
                }
            }
            catch (SqlException ex)
            {
                Console.Error.WriteLine($"[CrossRefService] SQL error: {ex.Message}");
                return FindReferencesViaApi(objectPath);
            }

            return new { objectPath, count = references.Count, references };
        }

        /// <summary>
        /// Fallback: Use the MS XReference provider API directly.
        /// This requires the Xlnt DLLs and a valid cross-reference database.
        /// </summary>
        private object FindReferencesViaApi(string objectPath)
        {
            try
            {
                // Try using the Xlnt XReference API
                // This is wrapped in a separate method to avoid assembly loading issues
                // if the Xlnt DLLs are not available
                return FindReferencesViaXlntApi(objectPath);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[CrossRefService] XRef API also failed: {ex.Message}");
                return new
                {
                    objectPath,
                    count = 0,
                    references = new List<ReferenceInfoModel>(),
                    error = $"Cross-reference query failed. SQL error and XRef API unavailable: {ex.Message}"
                };
            }
        }

        private object FindReferencesViaXlntApi(string objectPath)
        {
            // Lazy-load the Xlnt assemblies to avoid TypeLoadException if DLLs are missing
            // The actual implementation uses:
            //   ICrossReferenceProvider xrefProvider = CrossReferenceProviderFactory
            //       .CreateSqlCrossReferenceProvider(server, database);
            //   var refs = xrefProvider.FindReferences("", objectPath, CrossReferenceKind.Any);

            // For Phase 1, return a stub
            return new
            {
                objectPath,
                count = 0,
                references = new List<ReferenceInfoModel>(),
                note = "XRef API integration pending — use SQL direct query for now"
            };
        }

        /// <summary>
        /// Discover the actual schema of the DYNAMICSXREFDB for debugging.
        /// </summary>
        public object GetSchemaInfo()
        {
            var tables = new List<object>();

            using (var conn = new SqlConnection(_connectionString))
            {
                conn.Open();
                // Get tables
                var tableNames = new List<string>();
                using (var cmd = new SqlCommand(
                    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
                    conn))
                {
                    using (var reader = cmd.ExecuteReader())
                    {
                        while (reader.Read()) tableNames.Add(reader.GetString(0));
                    }
                }

                // Get columns for each table
                foreach (var tbl in tableNames)
                {
                    var cols = new List<string>();
                    using (var cmd = new SqlCommand(
                        $"SELECT COLUMN_NAME + ' (' + DATA_TYPE + ')' FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @T ORDER BY ORDINAL_POSITION",
                        conn))
                    {
                        cmd.Parameters.AddWithValue("@T", tbl);
                        using (var reader = cmd.ExecuteReader())
                        {
                            while (reader.Read()) cols.Add(reader.GetString(0));
                        }
                    }
                    tables.Add(new { table = tbl, columns = cols });
                }
            }

            return new { database = "DYNAMICSXREFDB", tables };
        }

        /// <summary>
        /// Sample rows from a table for debugging.
        /// </summary>
        public object SampleRows(string tableName)
        {
            // Sanitize table name (only allow alphanumeric and underscore)
            if (!System.Text.RegularExpressions.Regex.IsMatch(tableName, @"^[a-zA-Z_]\w*$"))
                throw new ArgumentException("Invalid table name");

            var rows = new List<Dictionary<string, object?>>();

            using (var conn = new SqlConnection(_connectionString))
            {
                conn.Open();
                using (var cmd = new SqlCommand($"SELECT TOP 10 * FROM [{tableName}]", conn))
                {
                    using (var reader = cmd.ExecuteReader())
                    {
                        while (reader.Read())
                        {
                            var row = new Dictionary<string, object?>();
                            for (int i = 0; i < reader.FieldCount; i++)
                            {
                                row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i)?.ToString();
                            }
                            rows.Add(row);
                        }
                    }
                }
            }

            return new { tableName, count = rows.Count, rows };
        }
    }
}
