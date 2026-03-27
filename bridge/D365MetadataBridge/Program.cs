using System;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading.Tasks;
using D365MetadataBridge.Protocol;

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
    /// 
    /// IMPORTANT: Main() must NOT reference any D365FO-dependent types
    /// (MetadataReadService, MetadataWriteService, CrossReferenceService) even as
    /// local variables.  The CLR JIT-compiles the entire async state machine for
    /// Main before the first instruction executes — which means it tries to load
    /// Microsoft.Dynamics.AX.Metadata.dll before SetupAssemblyResolution has been
    /// called.  All D365FO-dependent code lives in RunBridge(), which is marked
    /// [MethodImpl(NoInlining)] so the JIT defers its compilation until after
    /// the AssemblyResolve handler is registered.
    /// </summary>
    static class Program
    {
        private static string _packagesPath = @"K:\AosService\PackagesLocalDirectory";
        private static string? _binPath = null; // Explicit bin path (UDE: microsoftPackagesPath/bin)
        private static string _xrefServer = "localhost";
        private static string _xrefDatabase = "DYNAMICSXREFDB";
        private static string? _logFile = null;
        private static readonly TextWriter Log = Console.Error;

        static async Task<int> Main(string[] args)
        {
            // Parse command-line arguments — NO D365FO type references allowed here!
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
                    case "--log-file" when i + 1 < args.Length:
                        _logFile = args[++i];
                        break;
                    case "--help":
                        PrintUsage();
                        return 0;
                }
            }

            // Setup file-based logging (tee stderr → file) BEFORE anything else runs.
            // Configured via --log-file <path> or bridgeLogFile in .mcp.json.
            if (_logFile != null)
            {
                try
                {
                    var logDir = Path.GetDirectoryName(_logFile);
                    if (!string.IsNullOrEmpty(logDir) && !Directory.Exists(logDir))
                        Directory.CreateDirectory(logDir);

                    var fileWriter = new StreamWriter(_logFile, append: true) { AutoFlush = true };
                    var teeWriter = new TeeTextWriter(Console.Error, fileWriter);
                    Console.SetError(teeWriter);
                    Console.Error.WriteLine($"\n{new string('─', 72)}");
                    Console.Error.WriteLine($"[Bridge] Log started at {DateTime.Now:O}  pid={System.Diagnostics.Process.GetCurrentProcess().Id}");
                    Console.Error.WriteLine(new string('─', 72));
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[WARN] Cannot open log file {_logFile}: {ex.Message}");
                }
            }

            // Setup assembly resolution for D365FO DLLs BEFORE any D365FO type is touched.
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

            // Delegate to RunBridge — a separate method whose JIT compilation is
            // deferred (NoInlining) until AFTER AssemblyResolve is registered.
            return await RunBridge();
        }

        /// <summary>
        /// All D365FO-dependent code lives here so the JIT doesn't try to resolve
        /// Microsoft.Dynamics.AX.Metadata types during Main's state machine compilation.
        /// </summary>
        [MethodImpl(MethodImplOptions.NoInlining)]
        private static async Task<int> RunBridge()
        {
            // Late-import: Services namespace references D365FO assemblies
            var metadataService = InitMetadataService();
            var xrefService = InitCrossReferenceService();

            // Create write service (shares the same provider as read service)
            Services.MetadataWriteService? writeService = null;
            if (metadataService != null)
            {
                try
                {
                    writeService = new Services.MetadataWriteService(metadataService.Provider, _packagesPath);
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

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static Services.MetadataReadService? InitMetadataService()
        {
            try
            {
                Log.WriteLine($"[INFO] Initializing MetadataProvider from: {_packagesPath}");
                var svc = new Services.MetadataReadService(_packagesPath);
                Log.WriteLine("[INFO] MetadataProvider initialized successfully");
                return svc;
            }
            catch (Exception ex)
            {
                Log.WriteLine($"[ERROR] Failed to initialize MetadataProvider: {ex.Message}");
                Log.WriteLine($"[ERROR] Stack: {ex.StackTrace}");
                return null;
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static Services.CrossReferenceService? InitCrossReferenceService()
        {
            try
            {
                Log.WriteLine($"[INFO] Initializing CrossReferenceProvider: {_xrefServer}\\{_xrefDatabase}");
                var svc = new Services.CrossReferenceService(_xrefServer, _xrefDatabase);
                Log.WriteLine("[INFO] CrossReferenceProvider initialized successfully");
                return svc;
            }
            catch (Exception ex)
            {
                Log.WriteLine($"[WARN] Failed to initialize CrossReferenceProvider: {ex.Message}");
                return null;
            }
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

        /// <summary>
        /// TextWriter that writes to two underlying writers simultaneously (tee).
        /// Used to mirror Console.Error to both the original stderr pipe AND a log file.
        /// </summary>
        private sealed class TeeTextWriter : TextWriter
        {
            private readonly TextWriter _primary;
            private readonly TextWriter _secondary;

            public TeeTextWriter(TextWriter primary, TextWriter secondary)
            {
                _primary = primary;
                _secondary = secondary;
            }

            public override System.Text.Encoding Encoding => _primary.Encoding;

            public override void Write(char value)
            {
                _primary.Write(value);
                _secondary.Write(value);
            }

            public override void Write(string? value)
            {
                _primary.Write(value);
                _secondary.Write(value);
            }

            public override void WriteLine(string? value)
            {
                _primary.WriteLine(value);
                _secondary.WriteLine(value);
            }

            public override void Flush()
            {
                _primary.Flush();
                _secondary.Flush();
            }

            protected override void Dispose(bool disposing)
            {
                if (disposing)
                {
                    _secondary.Flush();
                    _secondary.Dispose();
                }
                base.Dispose(disposing);
            }
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
  --log-file <path>        Write all diagnostic logs to this file (append mode)
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
