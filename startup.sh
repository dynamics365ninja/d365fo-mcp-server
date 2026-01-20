#!/bin/bash
# Azure App Service Startup Script
# This script runs when the container starts

echo "🚀 Starting X++ MCP Server..."

# Download database from Azure Blob Storage if configured
if [ -n "$AZURE_STORAGE_CONNECTION_STRING" ]; then
  echo "📥 Downloading database from Azure Blob Storage..."
  node -e "
    import('./dist/database/download.js').then(m => 
      m.initializeDatabase().catch(err => {
        console.error('Failed to initialize database:', err);
        process.exit(1);
      })
    );
  "
else
  echo "ℹ️  No Azure Storage configured, using local database"
fi

# Start the server
echo "🎯 Starting MCP server..."
exec node dist/index.js
