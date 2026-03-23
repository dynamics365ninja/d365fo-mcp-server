using System;
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
        private readonly CrossReferenceService? _xrefService;

        public RequestDispatcher(MetadataReadService? metadataService, CrossReferenceService? xrefService)
        {
            _metadataService = metadataService;
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

                    // === Info ===
                    case "getinfo":
                        return Task.FromResult(BridgeResponse.CreateSuccess(request.Id, new
                        {
                            version = "1.0.0",
                            metadataAvailable = _metadataService != null,
                            xrefAvailable = _xrefService != null,
                            capabilities = new[]
                            {
                                "ping", "readTable", "readClass", "readEnum", "readEdt",
                                "readForm", "readQuery", "readView", "readDataEntity",
                                "readReport", "getMethodSource", "searchObjects",
                                "listObjects", "findReferences", "getInfo"
                            }
                        }));

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
    }
}
