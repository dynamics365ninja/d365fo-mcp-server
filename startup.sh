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

# Rebuild better-sqlite3 if it was compiled for a different Node.js version.
# NODE_MODULE_VERSION is stamped into the binary at compile time and must match
# the running Node.js version exactly. A version drift (e.g. deploy with Node 22,
# run with Node 24) causes ERR_DLOPEN_FAILED / "Module did not self-register".
EXPECTED_NMV=$(node -e "process.stdout.write(String(process.versions.modules))")
ADDON="node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [ -f "$ADDON" ]; then
  ACTUAL_NMV=$(node -e "
    try {
      const b = require('fs').readFileSync('$ADDON');
      const idx = b.indexOf('NODE_MODULE_VERSION');
      const m = b.slice(idx, idx + 40).toString().match(/NODE_MODULE_VERSION (\\d+)/);
      process.stdout.write(m ? m[1] : '0');
    } catch(e) { process.stdout.write('0'); }
  ")
  if [ "$ACTUAL_NMV" != "$EXPECTED_NMV" ]; then
    echo "Rebuilding better-sqlite3 (binary NMV=$ACTUAL_NMV, runtime NMV=$EXPECTED_NMV)..."
    npm rebuild better-sqlite3
    echo "Rebuild complete."
  fi
else
  echo "better-sqlite3 binary not found, running npm rebuild..."
  npm rebuild better-sqlite3
fi

# Start the server (database download happens within the app if configured)
echo "Starting server..."
exec node dist/index.js
