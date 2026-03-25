/**
 * End-to-end stdio transport test.
 *
 * Spawns the MCP server as a subprocess (write-only mode, no DB needed),
 * performs the full MCP handshake, injects a fake workspace root and then
 * calls get_workspace_info to verify project/workspace detection.
 *
 * Usage:
 *   npx tsx scripts/test-stdio.ts
 *   npx tsx scripts/test-stdio.ts --path "K:\repos\Contoso\src\d365fo\projects\ContosoCore\ContosoCore.rnrproj"
 *   npx tsx scripts/test-stdio.ts --workspace "K:\repos\Contoso\src\d365fo\projects"
 *
 * Options:
 *   --path        Path to a .rnrproj file OR a workspace folder.
 *                 When a .rnrproj file is given, the script automatically uses
 *                 the solution folder (two levels up) as the root — which is
 *                 exactly what VS 2022 sends via roots/list.
 *   --workspace   Alias for --path (workspace folder or .rnrproj file).
 *   --switch      After first get_workspace_info, send roots/list_changed with
 *                 a second path to test solution-switch detection.
 *                 Accepts a .rnrproj file or a workspace folder.
 *                 e.g. --switch "K:\repos\Contoso\src\d365fo\projects\ContosoFinCZ\..."
 */

import { Client }               from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath }         from 'url';
import { dirname, resolve, extname } from 'path';

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name: string): string | null {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

/**
 * VS 2022 sends workspace roots in roots/list as FOLDER paths, not .rnrproj files.
 *
 * When the user passes a .rnrproj path for convenience, we return the immediate
 * parent directory (the project folder).  This gives the most specific folder
 * that still contains the relevant project, regardless of nesting depth:
 *
 *   build/Solutions/ContosoCore/ContosoCore.rnrproj        → build/Solutions/ContosoCore/
 *   projects/ContosoCore - FM/ContosoCore - FM/ContosoCore.rnrproj → projects/ContosoCore - FM/ContosoCore - FM/
 *
 * Note: VS 2022 may send the solution folder (one level higher) for multi-project
 * solutions.  The server handles that case via name-match detection and git branch
 * heuristics.  For test purposes the project folder is always unambiguous.
 */
function resolveToFolder(p: string): string {
  if (extname(p).toLowerCase() !== '.rnrproj') return p;
  // Return immediate parent — the project folder containing the .rnrproj
  return resolve(p, '..');
}

const testPath      = getArg('--path') ?? getArg('--workspace');
const switchPath    = getArg('--switch');

// Default: use D365FO_SOLUTIONS_PATH from env or a generic fallback
const primaryRoot: string = resolveToFolder(
  testPath ??
  process.env.D365FO_SOLUTIONS_PATH ??
  'K:\\repos\\ASL\\src\\d365fo\\projects'
);

// Convert Windows path → file:// URI so it matches what VS 2022 sends
function toFileUri(p: string): string {
  // already a URI?
  if (p.startsWith('file://')) return p;
  return 'file:///' + p.replace(/\\/g, '/');
}

// ── Current roots state (shared between transport and test logic) ─────────────
let currentRoots: string[] = [primaryRoot];

// ── Server entry point ────────────────────────────────────────────────────────
const __dir     = dirname(fileURLToPath(import.meta.url));
const serverJs  = resolve(__dir, '../dist/index.js');
const serverEnv = {
  // Inherit everything so DB_PATH etc. from the real .env are picked up
  ...process.env as Record<string, string>,
  // write-only: fast startup, no 1.5 GB DB load needed
  MCP_SERVER_MODE: 'write-only',
  // Keep debug output readable
  DEBUG_LOGGING: 'false',
};

console.log('─'.repeat(70));
console.log('🧪 D365FO MCP stdio transport test');
console.log(`   Server  : ${serverJs}`);
console.log(`   Root(s) : ${currentRoots.join(', ')}`);
if (switchPath) console.log(`   Switch  : ${switchPath}`);
console.log('─'.repeat(70));

// ── Transport + Client ────────────────────────────────────────────────────────
const transport = new StdioClientTransport({
  command: 'node',
  args:    [serverJs],
  env:     serverEnv,
  stderr:  'pipe',   // capture server stderr for display
});

// Forward server stderr to our stderr so we can see what the server logs
transport.stderr?.on('data', (chunk: Buffer) => {
  process.stderr.write(chunk);
});

const client = new Client(
  { name: 'test-stdio-client', version: '1.0.0' },
  {
    capabilities: {
      roots: { listChanged: true },   // tell server we support solution-switching
    },
  }
);

// The server sends roots/list as a REQUEST to the client right after initialized.
// We must respond with the current roots — same as VS 2022 does.
client.setRequestHandler(ListRootsRequestSchema, async () => ({
  roots: currentRoots.map(p => ({ uri: toFileUri(p), name: p })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
function printSection(title: string, text: string): void {
  console.log('\n' + '═'.repeat(70));
  console.log(`  ${title}`);
  console.log('═'.repeat(70));
  // Highlight key lines
  text.split('\n').forEach(line => {
    if (line.startsWith('✅') || line.startsWith('⛔') || line.startsWith('⚠️') ||
        line.includes('Model name') || line.includes('Project path') ||
        line.includes('Workspace') || line.includes('Client name') ||
        line.includes('Roots (last') || line.includes('roots/list_changed') ||
        line.startsWith('▶')) {
      console.log('\x1b[33m' + line + '\x1b[0m');   // yellow highlight
    } else {
      console.log(line);
    }
  });
}

async function callGetWorkspaceInfo(): Promise<string> {
  const result = await client.callTool({ name: 'get_workspace_info', arguments: {} });
  const text = (result.content as Array<{ type: string; text: string }>)
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
  return text;
}

// Give the server ~300 ms after connection so roots/list exchange settles
function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────────
try {
  process.stdout.write('⏳ Connecting…\n');
  await client.connect(transport);
  console.log('✅ Connected (MCP handshake complete)');

  // Wait for the server's InitializedNotification handler to fire and
  // the roots/list exchange to complete before calling any tool.
  await wait(500);

  // ── First call ────────────────────────────────────────────────────────────
  process.stdout.write('⏳ Calling get_workspace_info…\n');
  const info1 = await callGetWorkspaceInfo();
  printSection('get_workspace_info — initial state', info1);

  // ── Solution switch simulation ────────────────────────────────────────────
  if (switchPath) {
    const switchFolder = resolveToFolder(switchPath);
    console.log(`\n🔄 Simulating solution switch → ${switchFolder}`);
    currentRoots = [switchFolder];

    // Send the notification VS 2022 sends when user opens a different solution
    await client.sendRootsListChanged();
    console.log('   roots/list_changed notification sent');

    // Wait for server to re-request roots/list and re-run detection
    await wait(1500);

    process.stdout.write('⏳ Calling get_workspace_info after switch…\n');
    const info2 = await callGetWorkspaceInfo();
    printSection('get_workspace_info — after solution switch', info2);
  }

  console.log('\n✅ Test complete.\n');
  await client.close();
  process.exit(0);
} catch (err) {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
}
