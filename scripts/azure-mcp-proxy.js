#!/usr/bin/env node
/**
 * STDIO to HTTP MCP Proxy
 * Forwards MCP requests from stdio to Azure HTTP endpoint
 */

const AZURE_ENDPOINT = process.env.AZURE_MCP_ENDPOINT || 'https://d365fo-mcp-server.azurewebsites.net/mcp';

let sessionId = null;
let buffer = '';

// Read from stdin (MCP client requests)
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  
  // Try to parse complete JSON-RPC messages
  const lines = buffer.split('\n');
  buffer = lines.pop() || ''; // Keep incomplete line in buffer
  
  for (const line of lines) {
    if (!line.trim()) continue;
    
    try {
      const request = JSON.parse(line);
      
      // Forward to Azure HTTP endpoint
      const response = await fetch(AZURE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
        },
        body: JSON.stringify(request)
      });
      
      // Extract session ID from response
      const newSessionId = response.headers.get('Mcp-Session-Id');
      if (newSessionId) {
        sessionId = newSessionId;
      }
      
      const result = await response.json();
      
      // Write response to stdout (back to MCP client)
      process.stdout.write(JSON.stringify(result) + '\n');
      
    } catch (error) {
      console.error('Proxy error:', error);
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: `Proxy error: ${error.message}`
        },
        id: null
      }) + '\n');
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});

console.error(`🔄 MCP Proxy started: stdio → ${AZURE_ENDPOINT}`);
