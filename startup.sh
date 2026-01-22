#!/bin/bash
# Azure App Service Startup Script

set -e

echo "🚀 Starting D365 F&O MCP Server..."
echo "   PORT: ${PORT:-8080}"
echo "   NODE_ENV: ${NODE_ENV:-production}"

# Verify dist directory exists
if [ ! -d "dist" ]; then
  echo "❌ Error: dist directory not found"
  echo "   Run 'npm run build' before deployment"
  exit 1
fi

# Start the server (database download happens within the app if configured)
echo "🎯 Starting server..."
exec node dist/index.js
