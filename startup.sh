#!/bin/bash
# Azure App Service Startup Script

set -e

echo "Starting D365 F&O MCP Server..."
echo "  PORT:     ${PORT:-8080}"
echo "  NODE_ENV: ${NODE_ENV:-production}"
echo "  Node:     $(node --version)"

# Verify dist directory exists
if [ ! -d "dist" ]; then
  echo "Error: dist directory not found. Run 'npm run build' before deployment."
  exit 1
fi

# Verify node:sqlite is present. It is core since Node 24 (the `engines` floor),
# so this can only fail if App Service is running an older runtime than the
# linuxFxVersion in infrastructure/main.bicep declares.
if ! node -e "require('node:sqlite')" 2>/dev/null; then
  echo "FATAL: node:sqlite unavailable on Node $(node --version); Node 24+ required."
  echo "Check linuxFxVersion (NODE|24-lts) on the App Service."
  exit 1
fi

# Start the server (database download happens within the app if configured)
echo "Starting server..."
exec node dist/index.js
