// Azure Infrastructure for X++ MCP Server
// Deploy via Azure Portal: Bicep → Deploy → select this file and fill in parameters

// Resource group name convention: d365fo-mcp-server-<customer_name>
// App name is derived from the resource group name — no need to set it separately.
var appName = resourceGroup().name

@description('Azure region for resources')
param location string = resourceGroup().location

@description('App Service Plan SKU — B3 recommended (4 vCPU / 7 GB RAM); B1/B2 for dev/test')
@allowed([
  'B1'
  'B2'
  'B3'
  'P0v3'
  'P1v3'
  'P2v3'
])
param appServiceSku string = 'B3'

@description('Node.js version')
param nodeVersion string = '24-lts'

@description('Storage account SKU')
@allowed([
  'Standard_LRS'
  'Standard_GRS'
])
param storageSku string = 'Standard_LRS'

@description('Comma-separated label languages to index. Each language adds ~125 MB. Examples: en-US,cs,de  or  en-US')
param labelLanguages string = 'en-US,cs,sk,de'

var appServicePlanName = 'asp-${appName}'
var appServiceName = 'app-${appName}-${uniqueString(resourceGroup().id)}'
var storageAccountName = 'st${replace(appName, '-', '')}${uniqueString(resourceGroup().id)}'
// B-tier uses 'Basic', P-tier uses 'PremiumV3'
var appServiceTier = startsWith(appServiceSku, 'B') ? 'Basic' : 'PremiumV3'

// Storage Account for SQLite databases
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: storageSku
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

// Container for built metadata databases (xpp-metadata.db, xpp-metadata-labels.db)
resource metadataContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'xpp-metadata'
  properties: {
    publicAccess: 'None'
  }
}

// Container for raw PackagesLocalDirectory.zip — used by the standard-model CI pipeline
resource packagesContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'packages'
  properties: {
    publicAccess: 'None'
  }
}

// App Service Plan (Linux)
resource appServicePlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: appServicePlanName
  location: location
  sku: {
    name: appServiceSku
    tier: appServiceTier
    capacity: 1
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

// Application Insights
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${appName}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    Request_Source: 'rest'
  }
}

// App Service (Web App)
resource appService 'Microsoft.Web/sites@2023-01-01' = {
  name: appServiceName
  location: location
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|${nodeVersion}'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      appCommandLine: 'bash startup.sh'
      appSettings: [
        {
          name: 'NODE_ENV'
          value: 'production'
        }
        {
          name: 'MCP_SERVER_MODE'
          value: 'read-only'
        }
        {
          name: 'AZURE_STORAGE_CONNECTION_STRING'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
        }
        {
          name: 'BLOB_CONTAINER_NAME'
          value: 'xpp-metadata'
        }
        {
          name: 'BLOB_DATABASE_NAME'
          value: 'databases/xpp-metadata-latest.db'
        }
        {
          name: 'DB_PATH'
          value: '/tmp/xpp-metadata.db'
        }
        {
          name: 'LABELS_DB_PATH'
          value: '/tmp/xpp-metadata-labels.db'
        }
        {
          name: 'LABEL_LANGUAGES'
          value: labelLanguages
        }
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~24'
        }
      ]
    }
  }
}

// Grant App Service managed identity access to Storage Account
resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, appService.id, 'StorageBlobDataContributor')
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe') // Storage Blob Data Contributor
    principalId: appService.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Outputs
output appServiceUrl string = 'https://${appService.properties.defaultHostName}'
output mcpEndpoint string = 'https://${appService.properties.defaultHostName}/mcp'
output storageAccountName string = storageAccount.name
output metadataContainerName string = metadataContainer.name
output packagesContainerName string = packagesContainer.name
output appInsightsInstrumentationKey string = appInsights.properties.InstrumentationKey
