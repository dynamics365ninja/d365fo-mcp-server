# NuGet Configuration for D365FO Standard Metadata

This folder contains NuGet configuration files for downloading standard D365 Finance & Operations packages.

## Files

### latest.csproj
Project file that specifies which NuGet packages to download.

**Template:**
```xml
<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <Import Project="$(MSBuildExtensionsPath)\$(MSBuildToolsVersion)\Microsoft.Common.props" Condition="Exists('$(MSBuildExtensionsPath)\$(MSBuildToolsVersion)\Microsoft.Common.props')" />
  <ItemGroup>
      <!-- Application Modules -->
      <PackageReference Include="Microsoft.Dynamics.AX.Application1.DevALM.BuildXpp" Version="10.0.*" NoWarn="NU1701"/>
      <PackageReference Include="Microsoft.Dynamics.AX.Application2.DevALM.BuildXpp" Version="10.0.*" NoWarn="NU1701"/>
      <PackageReference Include="Microsoft.Dynamics.AX.ApplicationSuite.DevALM.BuildXpp" Version="10.0.*" NoWarn="NU1701"/>
      
      <!-- Platform -->
      <PackageReference Include="Microsoft.Dynamics.AX.Platform.DevALM.BuildXpp" Version="7.0.*" NoWarn="NU1701"/>
      
      <!-- Compiler Tools -->
      <PackageReference Include="Microsoft.Dynamics.AX.Platform.CompilerPackage" Version="7.0.*" NoWarn="NU1701"/>
  </ItemGroup>
  <Import Project="$(MSBuildToolsPath)\Microsoft.CSharp.targets" />
</Project>
```

### nuget.config
NuGet feed configuration and credentials.

**Template:**
```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <!-- Microsoft Official Feed -->
    <add key="dynamics365" value="https://pkgs.dev.azure.com/msazure/One/_packaging/Dynamics365PackageFeed/nuget/v3/index.json" />
    
    <!-- NuGet.org as fallback -->
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" />
  </packageSources>
  
  <packageSourceCredentials>
    <dynamics365>
      <!-- Credentials configured in Azure DevOps pipeline -->
      <add key="Username" value="AzureDevOps" />
      <add key="ClearTextPassword" value="%SYSTEM_ACCESSTOKEN%" />
    </dynamics365>
  </packageSourceCredentials>
</configuration>
```

## Setup Instructions

1. **Create the files** in this folder using the templates above
2. **Commit to repository**:
   ```bash
   git add nuget-config/
   git commit -m "Add NuGet configuration for standard metadata"
   git push
   ```

3. **Configure pipeline**: Import `.azure-pipelines/d365fo-mcp-data-standard-extract.yml`

4. **Run pipeline** to download and extract standard metadata

## Documentation

See [../docs/STANDARD_METADATA_NUGET.md](../docs/STANDARD_METADATA_NUGET.md) for complete setup guide.

## Version Updates

Update versions in `latest.csproj` when:
- Upgrading D365 major version (e.g., 10.0.x → 10.1.x)
- Applying hotfixes (pin to specific version)
- Testing new releases

## Security

- **Never commit** Personal Access Tokens (PAT) to repository
- Use Azure DevOps Variable Groups for secrets
- Keep `%SYSTEM_ACCESSTOKEN%` placeholder in nuget.config
