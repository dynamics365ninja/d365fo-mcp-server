// Azure Infrastructure for X++ MCP Server
// Deploy: az deployment group create --resource-group <rg-name> --template-file main.bicep

@description('Name of the application (used for resource naming)')
param appName string = 'xpp-mcp'

@description('Azure region for resources')
param location string = resourceGroup().location

@description('App Service Plan SKU')
@allowed([
  'P0v3'
  'P1v3'
  'P2v3'
])
param appServiceSku string = 'P0v3'

@description('Node.js version')
param nodeVersion string = '22-lts'

@description('Storage account SKU')
@allowed([
  'Standard_LRS'
  'Standard_GRS'
])
param storageSku string = 'Standard_LRS'

var appServicePlanName = 'asp-${appName}'
var appServiceName = 'app-${appName}-${uniqueString(resourceGroup().id)}'
var storageAccountName = 'st${replace(appName, '-', '')}${uniqueString(resourceGroup().id)}'

// Storage Account for SQLite database
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

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'xpp-metadata'
  properties: {
    publicAccess: 'None'
  }
}

// App Service Plan
resource appServicePlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: appServicePlanName
  location: location
  sku: {
    name: appServiceSku
    tier: 'PremiumV3'
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
      appSettings: [
        {
          name: 'PORT'
          value: '8080'
        }
        {
          name: 'NODE_ENV'
          value: 'production'
        }
        {
          name: 'DB_PATH'
          value: '/tmp/xpp-metadata.db'
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
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~20'
        }
      ]
      appCommandLine: 'bash startup.sh'
    }
  }
}

// Grant App Service access to Storage Account
resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, appService.id, 'StorageBlobDataContributor')
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe') // Storage Blob Data Contributor
    principalId: appService.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Application Insights (optional)
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${appName}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    Request_Source: 'rest'
  }
}

// Outputs
output appServiceUrl string = 'https://${appService.properties.defaultHostName}'
output mcpEndpoint string = 'https://${appService.properties.defaultHostName}/mcp'
output storageAccountName string = storageAccount.name
output containerName string = container.name
output appInsightsInstrumentationKey string = appInsights.properties.InstrumentationKey
