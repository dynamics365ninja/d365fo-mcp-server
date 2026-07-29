// Azure Infrastructure for X++ MCP Server
// Deploy via Azure Portal: Bicep → Deploy → select this file and fill in parameters

// Resource group name convention: d365fo-mcp-server-<customer_name>
// App name is derived from the resource group name — no need to set it separately.
var appName = resourceGroup().name

// Portal one-click deploy passes an empty location when the user does not pick
// one, so resolve the fallback here rather than in the parameter default.
@description('Azure region for resources. Leave empty to inherit the resource group location.')
param location string = ''

var resolvedLocation = empty(location) ? resourceGroup().location : location

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

// Required — no default. A blank key disables authentication entirely, and this
// App Service is reachable on the public internet, so the deployment must fail
// rather than silently publish the indexed X++ source to anonymous callers.
@description('API key for authenticating MCP requests. Clients must send it as X-Api-Key (or Authorization: Bearer). Generate a strong random value, e.g. `openssl rand -hex 32`.')
@secure()
@minLength(32)
param apiKey string

var appServicePlanName = '${appName}-plan'
var appServiceName = appName
var storageAccountName = replace(appName, '-', '')
// B-tier uses 'Basic', P-tier uses 'PremiumV3'
var appServiceTier = startsWith(appServiceSku, 'B') ? 'Basic' : 'PremiumV3'

// Storage Account for SQLite databases
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: resolvedLocation
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
  location: resolvedLocation
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

// App Service (Web App)
resource appService 'Microsoft.Web/sites@2023-01-01' = {
  name: appServiceName
  location: resolvedLocation
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
          value: 'database/xpp-metadata.db'
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
          value: 'false'
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~24'
        }
        {
          name: 'WEBSITES_PORT'
          value: '8080'
        }
        {
          name: 'API_KEY'
          value: apiKey
        }
      ]
    }
  }
}

// Outputs
output appServiceUrl string = 'https://${appService.properties.defaultHostName}'
output mcpEndpoint string = 'https://${appService.properties.defaultHostName}/mcp'
output storageAccountName string = storageAccount.name
output metadataContainerName string = metadataContainer.name
output packagesContainerName string = packagesContainer.name
