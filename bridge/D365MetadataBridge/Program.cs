using System;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using D365MetadataBridge.Protocol;
using D365MetadataBridge.Services;

namespace D365MetadataBridge
{
    /// <summary>
    /// D365 Finance &amp; Operations Metadata Bridge
    /// 
    /// Provides access to D365FO metadata via Microsoft's official Dev Tools APIs
    /// (IMetadataProvider, ICrossReferenceProvider) over a stdin/stdout JSON protocol.
    /// 
    /// This bridge is spawned by the Node.js MCP server as a child process.
    /// All JSON messages are newline-delimited on stdout.
    /// All diagnostic/log messages go to stderr (never stdout).
    /// </summary>
    static class Program
    {
        private static string _packagesPath = @"K:\AosService\PackagesLocalDirectory";
        private static string? _binPath = null; // Explicit bin path (UDE: microsoftPackagesPath/bin)
        private static string _xrefServer = "localhost";
        private static string _xrefDatabase = "DYNAMICSXREFDB";
        private static readonly TextWriter Log = Console.Error;

        static async Task<int> Main(string[] args)
        {
            // Parse command-line arguments
            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--packages-path" when i + 1 < args.Length:
                        _packagesPath = args[++i];
                        break;
                    case "--bin-path" when i + 1 < args.Length:
                        _binPath = args[++i];
                        break;
                    case "--xref-server" when i + 1 < args.Length:
                        _xrefServer = args[++i];
                        break;
                    case "--xref-database" when i + 1 < args.Length:
                        _xrefDatabase = args[++i];
                        break;
                    case "--help":
                        PrintUsage();
                        return 0;
                }
            }

            // Setup assembly resolution for D365FO DLLs.
            // Traditional: {packagesPath}/bin
            // UDE: --bin-path points to microsoftPackagesPath/bin (MS framework DLLs)
            //      while --packages-path points to the custom packages root for metadata.
            var primaryBinPath = _binPath ?? Path.Combine(_packagesPath, "bin");
            if (!Directory.Exists(primaryBinPath))
            {
                Log.WriteLine($"[FATAL] D365FO bin path not found: {primaryBinPath}");
                return 1;
            }

            // In UDE mode both bin directories may contain needed DLLs
            var fallbackBinPath = _binPath != null ? Path.Combine(_packagesPath, "bin") : null;
            SetupAssemblyResolution(primaryBinPath, fallbackBinPath);
            Log.WriteLine($"[INFO] Assembly resolution configured for: {primaryBinPath}");
            if (fallbackBinPath != null && Directory.Exists(fallbackBinPath))
                Log.WriteLine($"[INFO] Additional assembly search path: {fallbackBinPath}");

            // Initialize services
            MetadataReadService? metadataService = null;
            CrossReferenceService? xrefService = null;

            try
            {
                Log.WriteLine($"[INFO] Initializing MetadataProvider from: {_packagesPath}");
                metadataService = new MetadataReadService(_packagesPath);
                Log.WriteLine("[INFO] MetadataProvider initialized successfully");
            }
            catch (Exception ex)
            {
                Log.WriteLine($"[ERROR] Failed to initialize MetadataProvider: {ex.Message}");
                Log.WriteLine($"[ERROR] Stack: {ex.StackTrace}");
                // Continue — we'll report errors for metadata calls but xref might still work
            }

            try
            {
                Log.WriteLine($"[INFO] Initializing CrossReferenceProvider: {_xrefServer}\\{_xrefDatabase}");
                xrefService = new CrossReferenceService(_xrefServer, _xrefDatabase);
                Log.WriteLine("[INFO] CrossReferenceProvider initialized successfully");
            }
            catch (Exception ex)
            {
                Log.WriteLine($"[WARN] Failed to initialize CrossReferenceProvider: {ex.Message}");
                // Non-fatal — cross-references are optional
            }

            // Create write service (shares the same provider as read service)
            MetadataWriteService? writeService = null;
            if (metadataService != null)
            {
                try
                {
                    writeService = new MetadataWriteService(metadataService.Provider, _packagesPath);
                    // Keep write service provider in sync when read service refreshes
                    metadataService.OnProviderRefreshed = (newProvider) => writeService.UpdateProvider(newProvider);
                    Log.WriteLine("[INFO] MetadataWriteService initialized");
                }
                catch (Exception ex)
                {
                    Log.WriteLine($"[WARN] Failed to initialize MetadataWriteService: {ex.Message}");
                }
            }

            // Create request dispatcher
            var dispatcher = new RequestDispatcher(metadataService, writeService, xrefService);

            // Send ready signal
            var readyResponse = new BridgeResponse
            {
                Id = "ready",
                Result = JsonSerializer.SerializeToElement(new
                {
                    version = "1.0.0",
                    status = "ready",
                    packagesPath = _packagesPath,
                    metadataAvailable = metadataService != null,
                    xrefAvailable = xrefService != null
                })
            };
            await WriteResponse(readyResponse);

            Log.WriteLine("[INFO] Bridge ready, entering stdin/stdout loop");

            // Enter stdin/stdout loop
            return await RunStdioLoop(dispatcher);
        }

        private static async Task<int> RunStdioLoop(RequestDispatcher dispatcher)
        {
            var reader = new StreamReader(Console.OpenStandardInput());

            string? line;
            while ((line = await reader.ReadLineAsync()) != null)
            {
                if (string.IsNullOrWhiteSpace(line))
                    continue;

                BridgeResponse response;
                try
                {
                    var request = JsonSerializer.Deserialize<BridgeRequest>(line, JsonOptions.Default);
                    if (request == null || string.IsNullOrEmpty(request.Method))
                    {
                        response = BridgeResponse.CreateError("?", -32600, "Invalid request");
                    }
                    else
                    {
                        Log.WriteLine($"[DEBUG] → {request.Method} (id={request.Id})");
                        response = await dispatcher.Dispatch(request);
                        Log.WriteLine($"[DEBUG] ← {request.Method} OK (id={request.Id})");
                    }
                }
                catch (JsonException ex)
                {
                    Log.WriteLine($"[ERROR] JSON parse error: {ex.Message}");
                    response = BridgeResponse.CreateError("?", -32700, $"Parse error: {ex.Message}");
                }
                catch (Exception ex)
                {
                    Log.WriteLine($"[ERROR] Unhandled: {ex.Message}\n{ex.StackTrace}");
                    response = BridgeResponse.CreateError("?", -32603, $"Internal error: {ex.Message}");
                }

                await WriteResponse(response);
            }

            Log.WriteLine("[INFO] stdin closed, bridge exiting");
            return 0;
        }

        private static async Task WriteResponse(BridgeResponse response)
        {
            var json = JsonSerializer.Serialize(response, JsonOptions.Default);
            var stdout = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };
            await stdout.WriteLineAsync(json);
            await stdout.FlushAsync();
        }

        private static void SetupAssemblyResolution(string primaryBinPath, string? fallbackBinPath = null)
        {
            AppDomain.CurrentDomain.AssemblyResolve += (sender, args) =>
            {
                var assemblyName = new AssemblyName(args.Name);
                var dllName = assemblyName.Name + ".dll";

                // Search primary bin path first, then fallback (UDE: both MS + custom)
                foreach (var searchPath in new[] { primaryBinPath, fallbackBinPath })
                {
                    if (searchPath == null || !Directory.Exists(searchPath)) continue;
                    var dllPath = Path.Combine(searchPath, dllName);
                    if (File.Exists(dllPath))
                    {
                        Log.WriteLine($"[ASSEMBLY] Resolving {assemblyName.Name} from {dllPath}");
                        try
                        {
                            return Assembly.LoadFrom(dllPath);
                        }
                        catch (Exception ex)
                        {
                            Log.WriteLine($"[ASSEMBLY] Failed to load {dllPath}: {ex.Message}");
                        }
                    }
                }
                return null;
            };
        }

        private static void PrintUsage()
        {
            Console.Error.WriteLine(@"
D365 Metadata Bridge — stdin/stdout JSON protocol for D365FO metadata access

Usage:
  D365MetadataBridge.exe [options]

Options:
  --packages-path <path>   Path to PackagesLocalDirectory (default: K:\AosService\PackagesLocalDirectory)
  --bin-path <path>        Explicit DLL directory (UDE: microsoftPackagesPath\bin). If omitted, uses {packages-path}\bin.
  --xref-server <server>   SQL Server for cross-reference DB (default: localhost)
  --xref-database <db>     Cross-reference database name (default: DYNAMICSXREFDB)
  --help                   Show this help

Protocol:
  Send JSON requests as single lines to stdin:
    {""id"":""1"",""method"":""ping"",""params"":{}}
  
  Receive JSON responses on stdout (one per line):
    {""id"":""1"",""result"":""pong""}

Methods:
  ping                              Health check
  readTable     {tableName}         Read table metadata (fields, indexes, relations)
  readClass     {className}         Read class metadata (methods, declaration)
  readEnum      {enumName}          Read enum metadata (values)
  readEdt       {edtName}           Read EDT metadata (base type, properties)
  readForm      {formName}          Read form metadata (datasources, controls)
  searchObjects {type, query}       Search for objects by name pattern
  findReferences {objectPath}       Find cross-references (requires DYNAMICSXREFDB)
");
        }
    }
}
