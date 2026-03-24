using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using D365MetadataBridge.Services;

namespace D365MetadataBridge.Protocol
{
    /// <summary>
    /// Routes incoming requests to the appropriate service method.
    /// </summary>
    public class RequestDispatcher
    {
        private readonly MetadataReadService? _metadataService;
        private readonly MetadataWriteService? _writeService;
        private readonly CrossReferenceService? _xrefService;

        public RequestDispatcher(MetadataReadService? metadataService, MetadataWriteService? writeService, CrossReferenceService? xrefService)
        {
            _metadataService = metadataService;
            _writeService = writeService;
            _xrefService = xrefService;
        }

        public Task<BridgeResponse> Dispatch(BridgeRequest request)
        {
            try
            {
                switch (request.Method.ToLowerInvariant())
                {
                    // === Health ===
                    case "ping":
                        return Task.FromResult(BridgeResponse.CreateSuccess(request.Id, "pong"));

                    // === Metadata Read ===
                    case "readtable":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("tableName")
                                ?? throw new ArgumentException("Missing parameter: tableName");
                            return _metadataService!.ReadTable(name);
                        });

                    case "readclass":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("className")
                                ?? throw new ArgumentException("Missing parameter: className");
                            return _metadataService!.ReadClass(name);
                        });

                    case "readenum":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("enumName")
                                ?? throw new ArgumentException("Missing parameter: enumName");
                            return _metadataService!.ReadEnum(name);
                        });

                    case "readedt":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("edtName")
                                ?? throw new ArgumentException("Missing parameter: edtName");
                            return _metadataService!.ReadEdt(name);
                        });

                    case "readform":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("formName")
                                ?? throw new ArgumentException("Missing parameter: formName");
                            return _metadataService!.ReadForm(name);
                        });

                    case "readquery":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("queryName")
                                ?? throw new ArgumentException("Missing parameter: queryName");
                            return _metadataService!.ReadQuery(name);
                        });

                    case "readview":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("viewName")
                                ?? throw new ArgumentException("Missing parameter: viewName");
                            return _metadataService!.ReadView(name);
                        });

                    case "readdataentity":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("entityName")
                                ?? throw new ArgumentException("Missing parameter: entityName");
                            return _metadataService!.ReadDataEntity(name);
                        });

                    case "readreport":
                        return HandleMetadata(request, () =>
                        {
                            var name = request.GetStringParam("reportName")
                                ?? throw new ArgumentException("Missing parameter: reportName");
                            return _metadataService!.ReadReport(name);
                        });

                    case "getmethodsource":
                        return HandleMetadata(request, () =>
                        {
                            var className = request.GetStringParam("className")
                                ?? throw new ArgumentException("Missing parameter: className");
                            var methodName = request.GetStringParam("methodName")
                                ?? throw new ArgumentException("Missing parameter: methodName");
                            return _metadataService!.GetMethodSource(className, methodName);
                        });

                    // === Search ===
                    case "searchobjects":
                        return HandleMetadata(request, () =>
                        {
                            var type = request.GetStringParam("type") ?? "all";
                            var query = request.GetStringParam("query")
                                ?? throw new ArgumentException("Missing parameter: query");
                            var maxResults = request.GetIntParam("maxResults") ?? 50;
                            return _metadataService!.SearchObjects(type, query, maxResults);
                        });

                    case "listobjects":
                        return HandleMetadata(request, () =>
                        {
                            var type = request.GetStringParam("type")
                                ?? throw new ArgumentException("Missing parameter: type");
                            return _metadataService!.ListObjects(type);
                        });

                    // === Cross-References ===
                    case "findreferences":
                        return HandleXref(request, () =>
                        {
                            var objectPath = request.GetStringParam("objectPath")
                                ?? request.GetStringParam("targetName")
                                ?? throw new ArgumentException("Missing parameter: objectPath or targetName");
                            return _xrefService!.FindReferences(objectPath);
                        });

                    case "getxrefschema":
                        return HandleXref(request, () =>
                        {
                            return _xrefService!.GetSchemaInfo();
                        });

                    case "samplexrefrows":
                        return HandleXref(request, () =>
                        {
                            var tableName = request.GetStringParam("tableName") ?? "References";
                            return _xrefService!.SampleRows(tableName);
                        });

                    // === Delete ===
                    case "deleteobject":
                        return HandleMetadata(request, () =>
                        {
                            var objectType = request.GetStringParam("objectType")
                                ?? throw new ArgumentException("Missing parameter: objectType");
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing parameter: objectName");
                            return _metadataService!.DeleteObject(objectType, objectName);
                        });

                    // === Capabilities ===
                    case "getcapabilities":
                        return HandleMetadata(request, () =>
                        {
                            return _metadataService!.GetCapabilities();
                        });

                    // === Form Pattern Discovery ===
                    case "discoverformpatterns":
                        return HandleMetadata(request, () =>
                        {
                            return _metadataService!.DiscoverFormPatterns();
                        });

                    // === Info ===
                    case "getinfo":
                        return Task.FromResult(BridgeResponse.CreateSuccess(request.Id, new
                        {
                            version = "1.0.0",
                            metadataAvailable = _metadataService != null,
                            xrefAvailable = _xrefService != null,
                            writeAvailable = _writeService != null,
                            capabilities = new[]
                            {
                                "ping", "readTable", "readClass", "readEnum", "readEdt",
                                "readForm", "readQuery", "readView", "readDataEntity",
                                "readReport", "getMethodSource", "searchObjects",
                                "listObjects", "findReferences", "getInfo",
                                "validateObject", "resolveObjectInfo", "refreshProvider",
                                "createObject", "addMethod", "addField",
                                "setProperty", "replaceCode",
                                "deleteObject", "getCapabilities", "discoverFormPatterns"
                            }
                        }));

                    // === Write-support (validate / resolve / refresh) ===
                    case "validateobject":
                        return HandleMetadata(request, () =>
                        {
                            var objectType = request.GetStringParam("objectType")
                                ?? throw new ArgumentException("Missing parameter: objectType");
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing parameter: objectName");
                            return _metadataService!.ValidateObject(objectType, objectName);
                        });

                    case "resolveobjectinfo":
                        return HandleMetadata(request, () =>
                        {
                            var objectType = request.GetStringParam("objectType")
                                ?? throw new ArgumentException("Missing parameter: objectType");
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing parameter: objectName");
                            return _metadataService!.ResolveObjectInfo(objectType, objectName);
                        });

                    case "refreshprovider":
                        return HandleMetadata(request, () =>
                        {
                            return _metadataService!.RefreshProvider();
                        });

                    // === Write Operations (via MetadataWriteService) ===
                    case "createobject":
                        return HandleWrite(request, () =>
                        {
                            var objectType = request.GetStringParam("objectType")
                                ?? throw new ArgumentException("Missing: objectType");
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var modelName = request.GetStringParam("modelName")
                                ?? throw new ArgumentException("Missing: modelName");

                            switch (objectType.ToLowerInvariant())
                            {
                                case "class":
                                case "class-extension":
                                    return _writeService!.CreateClass(objectName, modelName,
                                        request.GetStringParam("declaration"),
                                        request.GetParam<System.Collections.Generic.List<WriteMethodParam>>("methods"),
                                        request.GetDictParam("properties"));

                                case "table":
                                    return _writeService!.CreateTable(objectName, modelName,
                                        request.GetParam<System.Collections.Generic.List<WriteFieldParam>>("fields"),
                                        request.GetParam<System.Collections.Generic.List<WriteFieldGroupParam>>("fieldGroups"),
                                        request.GetParam<System.Collections.Generic.List<WriteIndexParam>>("indexes"),
                                        request.GetParam<System.Collections.Generic.List<WriteRelationParam>>("relations"),
                                        request.GetParam<System.Collections.Generic.List<WriteMethodParam>>("methods"),
                                        request.GetDictParam("properties"));

                                case "enum":
                                    return _writeService!.CreateEnum(objectName, modelName,
                                        request.GetParam<System.Collections.Generic.List<WriteEnumValueParam>>("values"),
                                        request.GetDictParam("properties"));

                                case "edt":
                                    return _writeService!.CreateEdt(objectName, modelName,
                                        request.GetDictParam("properties"));

                                case "query":
                                    return _writeService!.CreateQuery(objectName, modelName,
                                        request.GetDictParam("properties"));

                                case "view":
                                    return _writeService!.CreateView(objectName, modelName,
                                        request.GetParam<System.Collections.Generic.List<WriteFieldParam>>("fields"),
                                        request.GetDictParam("properties"));

                                case "menu-item-action":
                                    return _writeService!.CreateMenuItemAction(objectName, modelName,
                                        request.GetDictParam("properties"));

                                case "menu-item-display":
                                    return _writeService!.CreateMenuItemDisplay(objectName, modelName,
                                        request.GetDictParam("properties"));

                                case "menu-item-output":
                                    return _writeService!.CreateMenuItemOutput(objectName, modelName,
                                        request.GetDictParam("properties"));

                                case "security-privilege":
                                    return _writeService!.CreateSecurityPrivilege(objectName, modelName,
                                        request.GetDictParam("properties"));

                                case "security-duty":
                                    return _writeService!.CreateSecurityDuty(objectName, modelName,
                                        request.GetDictParam("properties"));

                                case "security-role":
                                    return _writeService!.CreateSecurityRole(objectName, modelName,
                                        request.GetDictParam("properties"));

                                default:
                                    throw new ArgumentException($"createObject not supported for '{objectType}' via bridge — use XML fallback");
                            }
                        });

                    case "addmethod":
                        return HandleWrite(request, () =>
                        {
                            var objectType = request.GetStringParam("objectType")
                                ?? throw new ArgumentException("Missing: objectType");
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var methodName = request.GetStringParam("methodName")
                                ?? throw new ArgumentException("Missing: methodName");
                            var source = request.GetStringParam("sourceCode")
                                ?? throw new ArgumentException("Missing: sourceCode");
                            return _writeService!.AddMethod(objectType, objectName, methodName, source);
                        });

                    case "addfield":
                        return HandleWrite(request, () =>
                        {
                            var tableName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var fieldName = request.GetStringParam("fieldName")
                                ?? throw new ArgumentException("Missing: fieldName");
                            return _writeService!.AddField(tableName, fieldName,
                                request.GetStringParam("fieldType") ?? "String",
                                request.GetStringParam("edt"),
                                request.GetBoolParam("mandatory") ?? false,
                                request.GetStringParam("label"));
                        });

                    case "setproperty":
                        return HandleWrite(request, () =>
                        {
                            var objectType = request.GetStringParam("objectType")
                                ?? throw new ArgumentException("Missing: objectType");
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var propertyPath = request.GetStringParam("propertyPath")
                                ?? throw new ArgumentException("Missing: propertyPath");
                            var propertyValue = request.GetStringParam("propertyValue")
                                ?? throw new ArgumentException("Missing: propertyValue");
                            return _writeService!.SetProperty(objectType, objectName, propertyPath, propertyValue);
                        });

                    case "replacecode":
                        return HandleWrite(request, () =>
                        {
                            var objectType = request.GetStringParam("objectType")
                                ?? throw new ArgumentException("Missing: objectType");
                            var objectName = request.GetStringParam("objectName")
                                ?? throw new ArgumentException("Missing: objectName");
                            var oldCode = request.GetStringParam("oldCode")
                                ?? throw new ArgumentException("Missing: oldCode");
                            var newCode = request.GetStringParam("newCode")
                                ?? throw new ArgumentException("Missing: newCode");
                            return _writeService!.ReplaceCode(objectType, objectName,
                                request.GetStringParam("methodName"), oldCode, newCode);
                        });

                    // === Batch Modify (multiple operations in one call) ===
                    case "batchmodify":
                        return HandleBatchModify(request);

                    default:
                        return Task.FromResult(
                            BridgeResponse.CreateError(request.Id, -32601, $"Unknown method: {request.Method}"));
                }
            }
            catch (Exception ex)
            {
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32603, $"Dispatch error: {ex.Message}"));
            }
        }

        private Task<BridgeResponse> HandleMetadata(BridgeRequest request, Func<object?> handler)
        {
            if (_metadataService == null)
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32000, "Metadata service not available"));

            try
            {
                var result = handler();
                if (result == null)
                    return Task.FromResult(
                        BridgeResponse.CreateError(request.Id, -32001, "Object not found"));

                return Task.FromResult(BridgeResponse.CreateSuccess(request.Id, result));
            }
            catch (ArgumentException ex)
            {
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32602, ex.Message));
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[ERROR] {request.Method}: {ex.Message}\n{ex.StackTrace}");
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32603, $"Error in {request.Method}: {ex.Message}"));
            }
        }

        private Task<BridgeResponse> HandleWrite(BridgeRequest request, Func<object?> handler)
        {
            if (_writeService == null)
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32000, "Write service not available"));

            try
            {
                var result = handler();
                if (result == null)
                    return Task.FromResult(
                        BridgeResponse.CreateError(request.Id, -32001, "Write operation returned null"));

                return Task.FromResult(BridgeResponse.CreateSuccess(request.Id, result));
            }
            catch (ArgumentException ex)
            {
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32602, ex.Message));
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[ERROR] {request.Method}: {ex.Message}\n{ex.StackTrace}");
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32603, $"Error in {request.Method}: {ex.Message}"));
            }
        }

        private Task<BridgeResponse> HandleXref(BridgeRequest request, Func<object?> handler)
        {
            if (_xrefService == null)
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32000,
                        "Cross-reference service not available (DYNAMICSXREFDB not configured)"));

            try
            {
                var result = handler();
                return Task.FromResult(BridgeResponse.CreateSuccess(request.Id, result ?? new object()));
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[ERROR] {request.Method}: {ex.Message}\n{ex.StackTrace}");
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32603, $"Error in {request.Method}: {ex.Message}"));
            }
        }

        /// <summary>
        /// Handles batch modification: multiple write operations on one object in a single call.
        /// Each operation is executed independently — failures don't stop subsequent operations.
        /// </summary>
        private Task<BridgeResponse> HandleBatchModify(BridgeRequest request)
        {
            if (_writeService == null)
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32000, "Write service not available"));

            try
            {
                var objectType = request.GetStringParam("objectType")
                    ?? throw new ArgumentException("Missing: objectType");
                var objectName = request.GetStringParam("objectName")
                    ?? throw new ArgumentException("Missing: objectName");
                var operations = request.GetParam<System.Collections.Generic.List<D365MetadataBridge.Models.BatchOperationRequest>>("operations")
                    ?? throw new ArgumentException("Missing: operations array");

                var batchResult = new D365MetadataBridge.Models.BatchOperationResult
                {
                    ObjectType = objectType,
                    ObjectName = objectName,
                    TotalOperations = operations.Count,
                };

                foreach (var op in operations)
                {
                    var sw = System.Diagnostics.Stopwatch.StartNew();
                    var itemResult = new D365MetadataBridge.Models.BatchOperationItemResult
                    {
                        Operation = op.Operation,
                    };

                    try
                    {
                        object? writeResult = null;
                        var p = op.Params ?? new Dictionary<string, object>();

                        // Extract string helper
                        string? S(string key) => p.TryGetValue(key, out var v) ? v?.ToString() : null;
                        bool? B(string key) => p.TryGetValue(key, out var v) && v != null ? Convert.ToBoolean(v) : null;

                        switch (op.Operation.ToLowerInvariant())
                        {
                            case "addmethod":
                            case "add-method":
                                writeResult = _writeService.AddMethod(objectType, objectName,
                                    S("methodName") ?? throw new ArgumentException("Missing: methodName"),
                                    S("sourceCode") ?? throw new ArgumentException("Missing: sourceCode"));
                                break;

                            case "addfield":
                            case "add-field":
                                writeResult = _writeService.AddField(objectName,
                                    S("fieldName") ?? throw new ArgumentException("Missing: fieldName"),
                                    S("fieldType") ?? "String",
                                    S("edt"),
                                    B("mandatory") ?? false,
                                    S("label"));
                                break;

                            case "setproperty":
                            case "set-property":
                            case "modify-property":
                                writeResult = _writeService.SetProperty(objectType, objectName,
                                    S("propertyPath") ?? throw new ArgumentException("Missing: propertyPath"),
                                    S("propertyValue") ?? throw new ArgumentException("Missing: propertyValue"));
                                break;

                            case "replacecode":
                            case "replace-code":
                                writeResult = _writeService.ReplaceCode(objectType, objectName,
                                    S("methodName"),
                                    S("oldCode") ?? throw new ArgumentException("Missing: oldCode"),
                                    S("newCode") ?? throw new ArgumentException("Missing: newCode"));
                                break;

                            default:
                                throw new ArgumentException($"Unsupported batch operation: {op.Operation}");
                        }

                        itemResult.Success = true;
                        batchResult.SuccessCount++;
                    }
                    catch (Exception ex)
                    {
                        itemResult.Success = false;
                        itemResult.Error = ex.Message;
                        batchResult.FailureCount++;
                        Console.Error.WriteLine($"[BATCH] Operation '{op.Operation}' failed: {ex.Message}");
                    }

                    sw.Stop();
                    itemResult.ElapsedMs = sw.ElapsedMilliseconds;
                    batchResult.Operations.Add(itemResult);
                }

                return Task.FromResult(BridgeResponse.CreateSuccess(request.Id, batchResult));
            }
            catch (ArgumentException ex)
            {
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32602, ex.Message));
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[ERROR] batchModify: {ex.Message}\n{ex.StackTrace}");
                return Task.FromResult(
                    BridgeResponse.CreateError(request.Id, -32603, $"Error in batchModify: {ex.Message}"));
            }
        }
    }
}
