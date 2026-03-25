using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;
using System.Linq;
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

        // ============================================================
        // Path parsing helpers
        // ============================================================

        /// <summary>
        /// Parse a DYNAMICSXREFDB path like "/Classes/SalesFormLetter/Methods/run"
        /// into (objectType, objectName, segment, segmentName).
        /// </summary>
        private static (string objectType, string objectName, string? segment, string? segmentName) ParsePath(string path)
        {
            // Paths: /Classes/X, /Classes/X/Methods/Y, /Tables/X, /Tables/X/Fields/Y
            var parts = path.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
            string objectType = parts.Length >= 1 ? parts[0] : "";
            string objectName = parts.Length >= 2 ? parts[1] : "";
            string? segment = parts.Length >= 3 ? parts[2] : null;
            string? segmentName = parts.Length >= 4 ? parts[3] : null;
            return (objectType, objectName, segment, segmentName);
        }

        /// <summary>
        /// Categorize a reference based on the xref Kind value and path context.
        /// Kind: 1=Read/Reference, 2=DerivedFrom/Extends, 3+ = other
        /// </summary>
        private static string CategorizeReference(byte? kind, string sourcePath, string targetPath)
        {
            if (kind == 2) return "extends";

            // Check if source is referencing a field
            if (targetPath.Contains("/Fields/")) return "field-access";

            // Check if source path suggests instantiation (heuristic: method referencing a class, not a method)
            var (_, _, targetSeg, _) = ParsePath(targetPath);
            if (targetSeg == null || targetSeg == "")
            {
                // Target is a class/table itself (not a method/field) — could be type-reference or instantiation
                return "type-reference";
            }

            if (targetSeg == "Methods") return "call";

            return "reference";
        }

        // ============================================================
        // P1: FindReferences — enriched with referenceType + caller parsing
        // ============================================================

        /// <summary>
        /// Find all references to a given object path.
        /// Enriched: returns referenceType (call/extends/field-access/type-reference)
        /// and callerClass/callerMethod parsed from the source path.
        /// </summary>
        public object FindReferences(string objectPath)
        {
            var references = new List<ReferenceInfoModel>();

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

            // Also add sub-paths (methods, fields) so we catch method-level references
            var extraPaths = new List<string>();
            foreach (var p in pathVariants)
            {
                extraPaths.Add(p + "/%"); // LIKE pattern for children
            }

            // Build parameterized query with IN + LIKE
            var paramNames = new List<string>();
            var allParams = new List<(string name, string value)>();
            for (int i = 0; i < pathVariants.Count; i++)
            {
                paramNames.Add($"@P{i}");
                allParams.Add(($"@P{i}", pathVariants[i]));
            }
            var likeConditions = new List<string>();
            for (int i = 0; i < extraPaths.Count; i++)
            {
                var pname = $"@L{i}";
                likeConditions.Add($"tgt.Path LIKE {pname}");
                allParams.Add((pname, extraPaths[i]));
            }

            var whereClause = $"tgt.Path IN ({string.Join(",", paramNames)})";
            if (likeConditions.Count > 0)
                whereClause += $" OR {string.Join(" OR ", likeConditions)}";

            var query = $@"
                SELECT TOP 500
                    src.Path AS SourcePath,
                    tgt.Path AS TargetPath,
                    sm.Module AS SourceModule,
                    r.Kind,
                    r.Line,
                    r.[Column]
                FROM [References] r
                INNER JOIN dbo.Names tgt ON tgt.Id = r.TargetId
                INNER JOIN dbo.Names src ON src.Id = r.SourceId
                LEFT  JOIN dbo.Modules sm ON sm.Id = src.ModuleId
                WHERE ({whereClause})
                ORDER BY src.Path, r.Line";

            try
            {
                using (var conn = new SqlConnection(_connectionString))
                {
                    conn.Open();
                    using (var cmd = new SqlCommand(query, conn))
                    {
                        foreach (var (name, value) in allParams)
                            cmd.Parameters.AddWithValue(name, value);
                        cmd.CommandTimeout = 30;

                        using (var reader = cmd.ExecuteReader())
                        {
                            while (reader.Read())
                            {
                                var sourcePath = reader.GetString(0);
                                var targetPath = reader.GetString(1);
                                byte? kindByte = reader.IsDBNull(3) ? (byte?)null : reader.GetByte(3);

                                var (srcType, srcObj, srcSeg, srcSegName) = ParsePath(sourcePath);

                                references.Add(new ReferenceInfoModel
                                {
                                    SourcePath = sourcePath,
                                    SourceModule = reader.IsDBNull(2) ? null : reader.GetString(2),
                                    Kind = kindByte?.ToString(),
                                    Line = reader.IsDBNull(4) ? 0 : (int)reader.GetInt16(4),
                                    Column = reader.IsDBNull(5) ? 0 : (int)reader.GetInt16(5),
                                    ReferenceType = CategorizeReference(kindByte, sourcePath, targetPath),
                                    CallerClass = srcObj,
                                    CallerMethod = srcSeg == "Methods" ? srcSegName : null,
                                });
                            }
                        }
                    }
                }
            }
            catch (SqlException ex)
            {
                Console.Error.WriteLine($"[CrossRefService] SQL error: {ex.Message}");
                return new { objectPath, count = 0, references = new List<ReferenceInfoModel>(), error = ex.Message };
            }

            return new { objectPath, count = references.Count, references };
        }

        // ============================================================
        // P3: FindExtensionClasses — enriched with method-level CoC detail
        // ============================================================

        /// <summary>
        /// Find classes that extend (CoC) a given base class. Enriched: returns
        /// which specific methods each extension class wraps via CoC, by querying
        /// the Names table for method-level paths under each extension class.
        /// </summary>
        public object FindExtensionClasses(string baseClassName)
        {
            var extensionClassNames = new Dictionary<string, string?>(); // className → module

            try
            {
                using (var conn = new SqlConnection(_connectionString))
                {
                    conn.Open();

                    // Step 1: Find extension classes via xref (Kind=2 DerivedFrom + naming convention)
                    var sql = @"
                        SELECT DISTINCT src.Path, m.Module
                        FROM [References] r
                        JOIN [Names] src ON r.SourceId = src.Id
                        JOIN [Names] tgt ON r.TargetId = tgt.Id
                        LEFT JOIN [Modules] m ON src.ModuleId = m.Id
                        WHERE (
                            tgt.Path LIKE @TargetClass
                            OR tgt.Path LIKE @TargetClassMethod
                        )
                        AND (
                            r.Kind = 2
                            OR src.Path LIKE @ExtensionPattern
                        )
                        AND src.Path LIKE '/Classes/%'
                        ORDER BY src.Path";

                    using (var cmd = new SqlCommand(sql, conn))
                    {
                        cmd.Parameters.AddWithValue("@TargetClass", $"/Classes/{baseClassName}");
                        cmd.Parameters.AddWithValue("@TargetClassMethod", $"/Classes/{baseClassName}/%");
                        cmd.Parameters.AddWithValue("@ExtensionPattern", "%_Extension%");

                        using (var reader = cmd.ExecuteReader())
                        {
                            while (reader.Read())
                            {
                                var path = reader.GetString(0);
                                var parts = path.Split('/');
                                var className = parts.Length >= 3 ? parts[2] : path;
                                var module = reader.IsDBNull(1) ? null : reader.GetString(1);

                                if (!extensionClassNames.ContainsKey(className))
                                    extensionClassNames[className] = module;
                            }
                        }
                    }

                    // Step 2: For each extension class, find which methods reference the base class methods
                    // This identifies which methods are actually wrapped via CoC
                    var results = new List<ExtensionClassDetailModel>();

                    foreach (var kvp in extensionClassNames)
                    {
                        var extClassName = kvp.Key;
                        var module = kvp.Value;

                        // Query: find method-level Names entries under this extension class
                        // that reference methods of the base class
                        var methodSql = @"
                            SELECT DISTINCT tgt.Path
                            FROM [References] r
                            JOIN [Names] src ON r.SourceId = src.Id
                            JOIN [Names] tgt ON r.TargetId = tgt.Id
                            WHERE src.Path LIKE @ExtClassMethods
                            AND tgt.Path LIKE @BaseClassMethods";

                        var wrappedMethods = new List<string>();

                        using (var cmd2 = new SqlCommand(methodSql, conn))
                        {
                            cmd2.Parameters.AddWithValue("@ExtClassMethods", $"/Classes/{extClassName}/Methods/%");
                            cmd2.Parameters.AddWithValue("@BaseClassMethods", $"/Classes/{baseClassName}/Methods/%");

                            using (var reader2 = cmd2.ExecuteReader())
                            {
                                while (reader2.Read())
                                {
                                    var tgtPath = reader2.GetString(0);
                                    var tgtParts = tgtPath.Split('/');
                                    if (tgtParts.Length >= 5)
                                    {
                                        var methodName = tgtParts[4];
                                        if (!wrappedMethods.Contains(methodName))
                                            wrappedMethods.Add(methodName);
                                    }
                                }
                            }
                        }

                        results.Add(new ExtensionClassDetailModel
                        {
                            ClassName = extClassName,
                            Module = module,
                            WrappedMethods = wrappedMethods,
                        });
                    }

                    return new
                    {
                        baseClassName,
                        count = results.Count,
                        extensions = results,
                        _source = "C# bridge (DYNAMICSXREFDB)"
                    };
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WARN] FindExtensionClasses({baseClassName}): {ex.Message}");
                return new
                {
                    baseClassName,
                    count = 0,
                    extensions = new List<ExtensionClassDetailModel>(),
                    error = ex.Message,
                    _source = "C# bridge (DYNAMICSXREFDB)"
                };
            }
        }

        // ============================================================
        // P4: FindEventSubscribers — enriched with event type filtering
        // ============================================================

        /// <summary>
        /// Find event handler / subscriber classes for a given target object.
        /// Enriched: supports optional eventName and handlerType filtering.
        /// Returns individual method entries with eventName and handlerType classification.
        /// </summary>
        public object FindEventSubscribers(string targetName, string? eventNameFilter = null, string? handlerTypeFilter = null)
        {
            var results = new List<EventSubscriberDetailModel>();

            try
            {
                using (var conn = new SqlConnection(_connectionString))
                {
                    conn.Open();

                    // Query: find all references TO the target from classes with event-related patterns
                    // Broader than before: include ALL referencing classes, not just *EventHandler named ones
                    var sql = @"
                        SELECT DISTINCT src.Path, m.Module
                        FROM [References] r
                        JOIN [Names] src ON r.SourceId = src.Id
                        JOIN [Names] tgt ON r.TargetId = tgt.Id
                        LEFT JOIN [Modules] m ON src.ModuleId = m.Id
                        WHERE (
                            tgt.Path LIKE @TargetTable
                            OR tgt.Path LIKE @TargetTablePath
                            OR tgt.Path LIKE @TargetClass
                            OR tgt.Path LIKE @TargetClassPath
                        )
                        AND src.Path LIKE '/Classes/%'
                        AND (
                            src.Path LIKE '%EventHandler%'
                            OR src.Path LIKE '%_Handler%'
                            OR src.Path LIKE '%Events%'
                            OR src.Path LIKE '%_Extension%'
                        )
                        ORDER BY src.Path";

                    using (var cmd = new SqlCommand(sql, conn))
                    {
                        cmd.Parameters.AddWithValue("@TargetTable", $"/Tables/{targetName}");
                        cmd.Parameters.AddWithValue("@TargetTablePath", $"/Tables/{targetName}/%");
                        cmd.Parameters.AddWithValue("@TargetClass", $"/Classes/{targetName}");
                        cmd.Parameters.AddWithValue("@TargetClassPath", $"/Classes/{targetName}/%");

                        using (var reader = cmd.ExecuteReader())
                        {
                            while (reader.Read())
                            {
                                var path = reader.GetString(0);
                                var parts = path.Split('/');
                                var className = parts.Length >= 3 ? parts[2] : path;
                                var methodName = parts.Length >= 5 ? parts[4] : null;
                                var module = reader.IsDBNull(1) ? null : reader.GetString(1);

                                // Classify handler type based on naming conventions
                                var handlerType = ClassifyHandlerType(className, methodName, path);
                                var eventName = ExtractEventName(methodName, className, targetName);

                                // Apply filters
                                if (eventNameFilter != null && eventName != null
                                    && !string.Equals(eventName, eventNameFilter, StringComparison.OrdinalIgnoreCase))
                                    continue;
                                if (handlerTypeFilter != null && handlerTypeFilter != "all"
                                    && !string.Equals(handlerType, handlerTypeFilter, StringComparison.OrdinalIgnoreCase))
                                    continue;

                                results.Add(new EventSubscriberDetailModel
                                {
                                    ClassName = className,
                                    Module = module,
                                    MethodName = methodName,
                                    EventName = eventName,
                                    HandlerType = handlerType,
                                });
                            }
                        }
                    }
                }

                // Deduplicate by class+method
                var distinct = results
                    .GroupBy(r => $"{r.ClassName}.{r.MethodName}")
                    .Select(g => g.First())
                    .ToList();

                return new
                {
                    targetName,
                    count = distinct.Count,
                    handlers = distinct,
                    _source = "C# bridge (DYNAMICSXREFDB)"
                };
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[WARN] FindEventSubscribers({targetName}): {ex.Message}");
                return new { targetName, count = 0, handlers = results, error = ex.Message, _source = "C# bridge (DYNAMICSXREFDB)" };
            }
        }

        /// <summary>Classify handler type based on naming conventions.</summary>
        private static string ClassifyHandlerType(string className, string? methodName, string path)
        {
            var combined = $"{className}.{methodName}".ToLowerInvariant();
            if (combined.Contains("dataevent") || combined.Contains("oninserted") ||
                combined.Contains("onupdated") || combined.Contains("ondeleted") ||
                combined.Contains("onvalidated") || combined.Contains("oninit"))
                return "dataEvent";
            if (combined.Contains("pre_") || combined.Contains("_pre"))
                return "pre";
            if (combined.Contains("post_") || combined.Contains("_post"))
                return "post";
            if (combined.Contains("delegate"))
                return "delegate";
            return "static"; // default for SubscribesTo handlers
        }

        /// <summary>Extract event name from method/class naming patterns.</summary>
        private static string? ExtractEventName(string? methodName, string className, string targetName)
        {
            if (methodName == null) return null;

            // Common patterns: onInserted_handler, onValidatedWrite_handler, etc.
            var lower = methodName.ToLowerInvariant();
            var standardEvents = new[] { "oninserted", "onupdated", "ondeleted",
                "onvalidatedwrite", "onvalidatedinsert", "onvalidateddelete",
                "oninitialized", "oninitvalue" };

            foreach (var ev in standardEvents)
            {
                if (lower.Contains(ev))
                    return ev.Substring(0, 1).ToUpper() + ev.Substring(1); // Capitalize
            }

            return methodName;
        }

        // ============================================================
        // P5: FindApiUsageCallers — callers of an API via References
        // ============================================================

        /// <summary>
        /// Find all callers of a given API class/method via cross-reference database.
        /// Groups results by caller class for pattern analysis.
        /// </summary>
        public object FindApiUsageCallers(string apiName, int limit = 200)
        {
            var callers = new List<ApiUsageCallerModel>();

            var pathVariants = new List<string>();
            if (apiName.StartsWith("/"))
            {
                pathVariants.Add(apiName);
            }
            else
            {
                pathVariants.Add($"/Classes/{apiName}");
                pathVariants.Add($"/Classes/{apiName}/%");
                pathVariants.Add($"/Tables/{apiName}");
                pathVariants.Add($"/Tables/{apiName}/%");
            }

            // Build WHERE clause
            var conditions = new List<string>();
            var allParams = new List<(string name, string value)>();
            for (int i = 0; i < pathVariants.Count; i++)
            {
                var pname = $"@T{i}";
                if (pathVariants[i].Contains("%"))
                    conditions.Add($"tgt.Path LIKE {pname}");
                else
                    conditions.Add($"tgt.Path = {pname}");
                allParams.Add((pname, pathVariants[i]));
            }

            var query = $@"
                SELECT TOP {limit}
                    src.Path AS SourcePath,
                    sm.Module AS SourceModule,
                    r.Kind,
                    r.Line
                FROM [References] r
                INNER JOIN dbo.Names tgt ON tgt.Id = r.TargetId
                INNER JOIN dbo.Names src ON src.Id = r.SourceId
                LEFT  JOIN dbo.Modules sm ON sm.Id = src.ModuleId
                WHERE ({string.Join(" OR ", conditions)})
                AND src.Path LIKE '/Classes/%'
                ORDER BY sm.Module, src.Path, r.Line";

            try
            {
                using (var conn = new SqlConnection(_connectionString))
                {
                    conn.Open();
                    using (var cmd = new SqlCommand(query, conn))
                    {
                        foreach (var (name, value) in allParams)
                            cmd.Parameters.AddWithValue(name, value);
                        cmd.CommandTimeout = 30;

                        using (var reader = cmd.ExecuteReader())
                        {
                            while (reader.Read())
                            {
                                var sourcePath = reader.GetString(0);
                                var (_, callerClass, seg, segName) = ParsePath(sourcePath);

                                callers.Add(new ApiUsageCallerModel
                                {
                                    CallerClass = callerClass,
                                    CallerMethod = seg == "Methods" ? segName : null,
                                    Module = reader.IsDBNull(1) ? null : reader.GetString(1),
                                    Kind = reader.IsDBNull(2) ? null : reader.GetByte(2).ToString(),
                                    Line = reader.IsDBNull(3) ? 0 : (int)reader.GetInt16(3),
                                });
                            }
                        }
                    }
                }
            }
            catch (SqlException ex)
            {
                Console.Error.WriteLine($"[CrossRefService] FindApiUsageCallers SQL error: {ex.Message}");
                return new { apiName, count = 0, callers = new List<ApiUsageCallerModel>(), error = ex.Message, _source = "C# bridge (DYNAMICSXREFDB)" };
            }

            // Group by caller class for pattern summary
            var byClass = callers
                .GroupBy(c => c.CallerClass)
                .Select(g => new
                {
                    callerClass = g.Key,
                    module = g.First().Module,
                    methods = g.Where(c => c.CallerMethod != null)
                               .Select(c => c.CallerMethod!)
                               .Distinct()
                               .ToList(),
                    callCount = g.Count()
                })
                .OrderByDescending(x => x.callCount)
                .ToList();

            return new
            {
                apiName,
                totalCallers = callers.Count,
                uniqueClasses = byClass.Count,
                callersByClass = byClass,
                callers,
                _source = "C# bridge (DYNAMICSXREFDB)"
            };
        }

        // ============================================================
        // Schema / Debug helpers
        // ============================================================

        /// <summary>
        /// Discover the actual schema of the DYNAMICSXREFDB for debugging.
        /// </summary>
        public object GetSchemaInfo()
        {
            var tables = new List<object>();

            using (var conn = new SqlConnection(_connectionString))
            {
                conn.Open();
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
