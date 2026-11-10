/**
 * What -EncodedCommand carries: reads stdin and runs the deploy program it contains, with the
 * request. The program itself does not go on the command line, whose 32,767-character limit it
 * would otherwise run into. Like -EncodedCommand, a script block is not subject to execution
 * policy, and nothing is written to disk.
 */
export const UDE_DEPLOY_LOADER = `
$ProgressPreference = 'SilentlyContinue'
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
& ([scriptblock]::Create($in.script)) $in.request
`;

/**
 * The Windows PowerShell 5.1 program that deploys built X++ packages to a UDE environment.
 *
 * It drives Microsoft.PowerPlatform.VSShared.Util.dll from Power Platform Tools for Visual
 * Studio — the library Visual Studio itself deploys with — the way Visual Studio's own
 * "Deploy" does. Power Platform Tools is a documented UDE prerequisite, so the library is there
 * on every UDE machine. Its API is public but UNDOCUMENTED, read from the assemblies with ildasm,
 * and may change with any update of the extension: the program checks every member it uses
 * before anything is uploaded, and reports a missing one as a `contract` error. The documented
 * alternative is `pac package deploy --package <TemplatePackage.dll>` from the Power Platform CLI,
 * at the cost of a PAC dependency (not a UDE prerequisite) and PAC's own sign-in profiles.
 *
 * Steps, as PipelineOperation.PerformDeployOperation does them, with two differences:
 *   - the package type and sync kind are set on each module definition (PerformDeployOperation
 *     always sends a Release package with a full sync, ~20 min even for a tiny model);
 *   - the connection is a CrmServiceClient over an OrganizationWebProxyClient carrying the
 *     server's own Dataverse token, so there is no second sign-in. Early-bound types must be on
 *     (useStrongTypes): the upload creates an early-bound msprov_fnopackage row.
 *
 * Why it has to be compiled C#: the library's async code runs on thread-pool threads, where a
 * PowerShell script block (as an AssemblyResolve handler or a status callback) has no runspace
 * and crashes the process. So both are C#, and status lines are written by C# directly.
 *
 * A constant program: it and its inputs travel as JSON on stdin (see UDE_DEPLOY_LOADER), nothing
 * is interpolated into this source, and the token appears nowhere but in memory. Output: one JSON
 * object per line, {type: 'status'|'module'|'tools'|'contract'|'error'|'done', message}.
 *
 * Kept free of `${` and backticks: this is a JS template literal.
 */
export const UDE_DEPLOY_POWERSHELL = String.raw`
param($request)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Text;

// Plumbing, compiled before any library loads: resolves the library's dependencies and
// writes the output lines. C#, because both run on the library's thread-pool threads.
public static class D365UdeDeployHost
{
    private static string[] dirs;
    private static readonly object gate = new object();

    // Resolves dependencies from the extension folder, then PackagesLocalDirectory\bin.
    public static void RegisterResolver(string[] directories)
    {
        dirs = directories;
        AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
        {
            string name = new AssemblyName(e.Name).Name;
            if (name.EndsWith(".resources", StringComparison.OrdinalIgnoreCase)) return null;
            foreach (string dir in dirs)
            {
                string path = Path.Combine(dir, name + ".dll");
                if (File.Exists(path)) return Assembly.LoadFrom(path);
            }
            return null;
        };
    }
    // A JSON string literal (by hand: no assembly references needed).
    public static string Quote(string value)
    {
        var sb = new StringBuilder("\"");
        foreach (char c in value ?? "")
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }
    // One {"type","message"} line; locked, as status arrives from several threads.
    public static void Emit(string type, string message)
    {
        lock (gate)
        {
            Console.Out.WriteLine("{\"type\":" + Quote(type) + ",\"message\":" + Quote(message) + "}");
            Console.Out.Flush();
        }
    }
}
'@

function Send-Line([string]$type, [string]$message) { [D365UdeDeployHost]::Emit($type, $message) }

try {
    # The newest copy of the library across the Visual Studio installations.
    $util = $request.extensionDirs |
        ForEach-Object { Join-Path $_ 'Microsoft.PowerPlatform.VSShared.Util.dll' } |
        Where-Object { Test-Path -LiteralPath $_ } |
        ForEach-Object { Get-Item -LiteralPath $_ } |
        Sort-Object { [version]$_.VersionInfo.FileVersion } -Descending |
        Select-Object -First 1
    if (-not $util) {
        Send-Line 'error' 'Power Platform Tools for Visual Studio was not found (no Microsoft.PowerPlatform.VSShared.Util.dll in the Visual Studio extension folders).'
        exit 2
    }
    $extensionDir = $util.DirectoryName
    $pld = $request.packagesLocalDirectory
    [D365UdeDeployHost]::RegisterResolver([string[]]@($extensionDir, (Join-Path $pld 'bin')))
    Send-Line 'tools' ($util.VersionInfo.FileVersion + ' ' + $extensionDir)

    # Contract check: every member the deployment uses, before anything is uploaded.
    $load = @{}
    foreach ($n in 'Microsoft.PowerPlatform.VSShared.Util', 'Microsoft.Dynamics.VSExtension.Shared', 'Microsoft.Xrm.Tooling.Connector', 'Microsoft.Xrm.Sdk') {
        $load[$n] = [Reflection.Assembly]::LoadFrom((Join-Path $extensionDir ($n + '.dll')))
    }
    $missing = New-Object System.Collections.Generic.List[string]
    function Get-T([string]$assembly, [string]$name) {
        $t = $load[$assembly].GetType($name, $false)
        if (-not $t) { $missing.Add($name) }
        $t
    }
    $pipeline = Get-T 'Microsoft.PowerPlatform.VSShared.Util' 'Microsoft.PowerPlatform.VSShared.Util.PipelineOperation'
    $opBase = Get-T 'Microsoft.PowerPlatform.VSShared.Util' 'Microsoft.PowerPlatform.VSShared.Util.OperationBase'
    $statusDelegate = Get-T 'Microsoft.PowerPlatform.VSShared.Util' 'Microsoft.PowerPlatform.VSShared.Util.OperationBaseCommon+StatusDelegate'
    $moduleDef = Get-T 'Microsoft.Dynamics.VSExtension.Shared' 'Microsoft.Dynamics.VSExtension.Shared.FnoModuleDefinition'
    $dbSync = Get-T 'Microsoft.Dynamics.VSExtension.Shared' 'Microsoft.Dynamics.VSExtension.Shared.DBSync'
    $crm = Get-T 'Microsoft.Xrm.Tooling.Connector' 'Microsoft.Xrm.Tooling.Connector.CrmServiceClient'
    $proxy = Get-T 'Microsoft.Xrm.Sdk' 'Microsoft.Xrm.Sdk.WebServiceClient.OrganizationWebProxyClient'
    if ($missing.Count -eq 0) {
        $s = [string]; $g = [guid]; $d = [datetime]
        $enumS = [System.Collections.Generic.IEnumerable[string]]
        $dict = [System.Collections.Generic.IDictionary[string, object]].GetGenericTypeDefinition().MakeGenericType([string], $moduleDef)
        $taskOf = [System.Threading.Tasks.Task[object]].GetGenericTypeDefinition()
        $prepares = $taskOf.MakeGenericType([System.Collections.Generic.Dictionary[string, object]].GetGenericTypeDefinition().MakeGenericType([string], $moduleDef))
        # Everything D365UdeDeployer compiles against, down to the types it assigns and the
        # setters it calls: a change anywhere here would otherwise surface as a csc error.
        function Test-Prop($t, $n, $pt, [bool]$set) { $p = $t.GetProperty($n); $p -and $p.PropertyType -eq $pt -and (-not $set -or $p.CanWrite) }
        function Test-Ret($mi, $rt) { $mi -and $rt.IsAssignableFrom($mi.ReturnType) }
        $invoke = $statusDelegate.GetMethod('Invoke')
        $module = $moduleDef.GetProperty('Module')
        $checks = @(
            @('PipelineOperation()', $pipeline.GetConstructor([type[]]@())),
            @('PipelineOperation.PrepareDeploymentPackage', (Test-Ret ($pipeline.GetMethod('PrepareDeploymentPackage', [type[]]@($s, $s, $s, $s, $enumS))) $prepares)),
            @('PipelineOperation.earliestBuildTime', ($pipeline.GetField('earliestBuildTime').FieldType -eq $d)),
            @('OperationBase(CrmServiceClient, string, StatusDelegate)', $opBase.GetConstructor([type[]]@($crm, $s, $statusDelegate))),
            @('OperationBase.DeploymentPreCheck', (Test-Ret ($opBase.GetMethod('DeploymentPreCheck', [type[]]@($g, $d))) ($taskOf.MakeGenericType($s)))),
            @('OperationBase.DeployFinOpsPackage', (Test-Ret ($opBase.GetMethod('DeployFinOpsPackage', [type[]]@($dict, $d))) ([System.Threading.Tasks.Task]))),
            @('StatusDelegate(string)', ($invoke.ReturnType -eq [void] -and @($invoke.GetParameters()).Count -eq 1 -and $invoke.GetParameters()[0].ParameterType -eq $s)),
            @('FnoModuleDefinition.PackageType', (Test-Prop $moduleDef 'PackageType' $s $true)),
            @('FnoModuleDefinition.DBSync', (Test-Prop $moduleDef 'DBSync' $dbSync $true)),
            @('FnoModuleDefinition.CorrelationID', (Test-Prop $moduleDef 'CorrelationID' $g $false)),
            @('FnoModuleDefinition.Module.Name', ($module -and (Test-Prop ($module.PropertyType) 'Name' $s $false))),
            @('DBSync()', $dbSync.GetConstructor([type[]]@())),
            @('DBSync.SyncKind', (Test-Prop $dbSync 'SyncKind' $s $true)),
            @('DBSync.Arguments', (Test-Prop $dbSync 'Arguments' $s $true)),
            @('CrmServiceClient(OrganizationWebProxyClient)', $crm.GetConstructor([type[]]@($proxy))),
            @('CrmServiceClient.IsReady', (Test-Prop $crm 'IsReady' ([bool]) $false)),
            @('CrmServiceClient.LastCrmError', (Test-Prop $crm 'LastCrmError' $s $false)),
            @('OrganizationWebProxyClient(Uri, bool)', $proxy.GetConstructor([type[]]@([uri], [bool]))),
            @('OrganizationWebProxyClient.HeaderToken', (Test-Prop $proxy 'HeaderToken' $s $true))
        )
        foreach ($c in $checks) { if (-not $c[1]) { $missing.Add($c[0]) } }
    }
    if ($missing.Count -gt 0) {
        Send-Line 'contract' ($util.VersionInfo.FileVersion + ': ' + ($missing -join ', '))
        exit 3
    }

    $references = @($load.Values | ForEach-Object { $_.Location }) + 'System.Core', 'System.ServiceModel', 'System.Runtime.Serialization'
    Add-Type -ReferencedAssemblies $references -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Dynamics.VSExtension.Shared;
using Microsoft.PowerPlatform.VSShared.Util;
using Microsoft.Xrm.Sdk.WebServiceClient;
using Microsoft.Xrm.Tooling.Connector;

// The deployment: PerformDeployOperation's steps, with our package type, sync kind and token.
// Compiled only after the contract check, which explains a changed library better than csc.
public static class D365UdeDeployer
{
    // emit is D365UdeDeployHost.Emit, which this in-memory compile cannot reference.
    public static void Deploy(string modulesDir, string orgUrl, string token, string platformVersion, string appVersion, string packageType, string syncKind, Action<string, string> emit)
    {
        var pipeline = new PipelineOperation();
        Dictionary<string, FnoModuleDefinition> modules = pipeline
            .PrepareDeploymentPackage(modulesDir, platformVersion, appVersion, "Pipeline", null)
            .GetAwaiter().GetResult();
        if (modules == null || modules.Count == 0) throw new InvalidOperationException("No module to deploy in " + modulesDir);
        foreach (FnoModuleDefinition module in modules.Values)
        {
            module.PackageType = packageType;
            if (module.DBSync == null) module.DBSync = new DBSync();
            module.DBSync.SyncKind = syncKind;
            module.DBSync.Arguments = "";
            emit("module", module.Module.Name);
        }

        var proxy = new OrganizationWebProxyClient(new Uri(orgUrl + "/XRMServices/2011/Organization.svc/web?SdkClientVersion=9.2.49.0"), true);
        proxy.HeaderToken = token;
        var client = new CrmServiceClient(proxy);
        if (!client.IsReady) throw new InvalidOperationException("Cannot connect to " + orgUrl + ": " + client.LastCrmError);

        var service = new OperationBase(client, "Pipeline", new OperationBaseCommon.StatusDelegate(message => emit("status", message)));
        Guid correlationId = modules.Values.First().CorrelationID;
        string preCheck = service.DeploymentPreCheck(correlationId, pipeline.earliestBuildTime).GetAwaiter().GetResult();
        if (!string.IsNullOrEmpty(preCheck)) throw new InvalidOperationException("The environment refused the deployment: " + preCheck);
        service.DeployFinOpsPackage(modules, pipeline.earliestBuildTime).GetAwaiter().GetResult();
    }
}
'@

    # Same version sources as Visual Studio.
    $platformVersion = (Get-Item -LiteralPath (Join-Path $pld 'bin\Microsoft.Dynamics.AX.Metadata.dll')).VersionInfo.FileVersion
    $appVersion = (Get-Item -LiteralPath (Join-Path $pld 'ApplicationCommon\bin\Dynamics.AX.ApplicationCommon.dll')).VersionInfo.FileVersion
    Send-Line 'status' ('Platform ' + $platformVersion + ', application ' + $appVersion)
    # A delegate over the compiled method, never a script block: it is called on thread-pool threads.
    $emit = [Delegate]::CreateDelegate([Action[string, string]], [D365UdeDeployHost].GetMethod('Emit'))
    [D365UdeDeployer]::Deploy($request.modulesDir, $request.orgUrl, $request.token, $platformVersion, $appVersion, $request.packageType, $request.syncKind, $emit)
    Send-Line 'done' ''
}
catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    Send-Line 'error' $e.Message
    exit 1
}
`;
