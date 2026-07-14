/**
 * `d365fo-mcp setup` — first-time setup wizard.
 *
 * Walks through the deployment scenarios documented in docs/SETUP.md
 * (A azure client · B hybrid · C local HTTP · D UDE · E local stdio ·
 * F multi-instance), runs the install/build/index steps for the chosen one,
 * and prints the .mcp.json block to paste into the MCP client config.
 */
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { isWindows, paths, repoRoot } from '../context.js';
import { readEnvValue, writeEnvValue } from '../envFile.js';
import { runExe, runShell } from '../exec.js';
import { rootTarget } from '../target.js';
import { askConfirm, askSelect, askText, p } from '../ui.js';
import { listXppConfigs } from '../xppConfig.js';
import { rebuildIndex } from './indexCmd.js';
import { instanceAddCommand } from './instance.js';

type Scenario = 'hybrid' | 'local-http' | 'ude' | 'local-stdio' | 'multi';

const distEntryWin = () => resolve(repoRoot, 'dist', 'index.js');

function mcpJsonNote(servers: Record<string, unknown>, title = '.mcp.json'): void {
  p.note(JSON.stringify({ servers }, null, 2), title);
}

function placementNote(): void {
  p.note(
    'Place the block above in:\n' +
    '  %USERPROFILE%\\.mcp.json          — all solutions (recommended)\n' +
    '  next to the .sln                 — that solution only\n\n' +
    'Also copy .github\\copilot-instructions.md into a parent of your\n' +
    'solution folders (mandatory for Copilot — see docs/SETUP.md).\n' +
    'Restart Visual Studio after editing .mcp.json.',
    'Where it goes',
  );
}

/** npm install + npm run build, skipping steps that are already done. */
async function ensureInstalledAndBuilt(): Promise<boolean> {
  if (!fs.existsSync(resolve(repoRoot, 'node_modules'))) {
    p.log.step('Installing dependencies (npm install)…');
    if (await runShell('npm install') !== 0) { p.log.error('npm install failed.'); return false; }
  } else {
    p.log.success('Dependencies already installed.');
  }
  if (!fs.existsSync(paths.distEntry) || await askConfirm('dist/ already exists — rebuild TypeScript anyway?', false)) {
    p.log.step('Building TypeScript (npm run build)…');
    if (await runShell('npm run build') !== 0) { p.log.error('Build failed.'); return false; }
  }
  return true;
}

/** Build the C# bridge — the only write path; Windows D365FO VMs only. */
async function maybeBuildBridge(scenario: Scenario): Promise<boolean> {
  if (!isWindows) {
    p.log.info('C# bridge skipped — it only builds on Windows D365FO VMs (writes stay unavailable here).');
    return true;
  }
  if (fs.existsSync(paths.bridgeExe) && !await askConfirm('C# bridge already built — rebuild it?', false)) {
    return true;
  }
  if (!await askConfirm('Build the C# bridge? (required for creating/modifying files)')) {
    p.log.warn('Skipped — the server will run read-only until you build it.');
    return true;
  }
  const args = ['build', '-c', 'Release'];
  if (scenario === 'ude') {
    const binPath = await askText({
      message: 'UDE: path to the FrameworkDirectory\\bin folder (Enter to let MSBuild auto-detect)',
      placeholder: 'C:\\Users\\...\\PackagesLocalDirectory\\bin',
    });
    if (binPath) args.push(`-p:D365BinPath=${binPath}`);
  }
  p.log.step('Building C# bridge (dotnet build -c Release)…');
  if (await runExe('dotnet', args, { cwd: paths.bridgeDir }) !== 0) {
    p.log.error('Bridge build failed — check .NET Framework 4.8 Dev Pack and the NuGet feed (docs/SETUP.md).');
    return false;
  }
  p.log.success('C# bridge built.');
  return true;
}

/** Create/complete the root .env interactively. Returns the configured port. */
async function configureRootEnv(scenario: Scenario): Promise<number> {
  if (!fs.existsSync(paths.rootEnv)) {
    fs.copyFileSync(paths.envExample, paths.rootEnv);
    p.log.success('Created .env from .env.example');
  } else {
    p.log.info('.env already exists — the wizard only overwrites the keys you answer below.');
  }

  const envType = scenario === 'ude' ? 'ude' : await askSelect('Development environment type', [
    { value: 'auto', label: 'auto', hint: 'detect UDE when XPP configs exist (default)' },
    { value: 'traditional', label: 'traditional', hint: 'classic AOSService VM' },
    { value: 'ude', label: 'ude', hint: 'Unified Developer Experience / Power Platform Tools' },
  ], 'auto');
  writeEnvValue(paths.rootEnv, 'D365FO_DEV_ENVIRONMENT_TYPE', envType);

  if (envType === 'traditional') {
    writeEnvValue(paths.rootEnv, 'D365FO_PACKAGE_PATH', await askText({
      message: 'Packages root (PackagesLocalDirectory)',
      initialValue: readEnvValue(paths.rootEnv, 'D365FO_PACKAGE_PATH') ?? 'C:\\AOSService\\PackagesLocalDirectory',
      required: true,
    }));
    writeEnvValue(paths.rootEnv, 'CUSTOM_MODELS', await askText({
      message: 'Custom model names (comma-separated; VS → Dynamics 365 → Model Management)',
      initialValue: readEnvValue(paths.rootEnv, 'CUSTOM_MODELS') ?? '',
      required: true,
    }));
  } else {
    // UDE/auto: pin an XPP config when any exist; otherwise the server
    // auto-detects the newest one at runtime.
    const configs = listXppConfigs();
    if (configs.length > 0) {
      const pick = await askSelect('XPP config to pin (from %LOCALAPPDATA%\\...\\XPPConfig)', [
        { value: '', label: '(auto — always use the newest)' },
        ...configs.map((cfg, i) => ({ value: cfg.fullName, label: `${cfg.name}  v${cfg.version}${i === 0 ? ' (newest)' : ''}`, hint: cfg.modelStoreFolder })),
      ], '');
      if (pick) writeEnvValue(paths.rootEnv, 'XPP_CONFIG_NAME', pick);
    }
  }

  const prefix = await askText({
    message: 'Extension prefix for your custom objects (e.g. ASP, CTSO)',
    initialValue: readEnvValue(paths.rootEnv, 'EXTENSION_PREFIX') ?? '',
    required: true,
  });
  writeEnvValue(paths.rootEnv, 'EXTENSION_PREFIX', prefix);

  let port = 8080;
  if (scenario === 'local-http') {
    port = parseInt(await askText({
      message: 'HTTP port',
      initialValue: readEnvValue(paths.rootEnv, 'PORT') ?? '8080',
      required: true,
    }), 10);
    writeEnvValue(paths.rootEnv, 'PORT', String(port));
  }
  p.log.success('.env updated.');
  return port;
}

async function maybeBuildIndex(): Promise<boolean> {
  if (!await askConfirm('Build the metadata index now? (custom models: minutes; EXTRACT_MODE=all: 1–2 h)')) {
    p.log.warn('Skipped — run `d365fo-mcp index` before first use.');
    return true;
  }
  return rebuildIndex(rootTarget());
}

export async function setupCommand(): Promise<void> {
  p.intro('d365fo-mcp setup — first-time setup');

  const scenario = await askSelect<Scenario>('How will this developer machine use the MCP server? (docs/SETUP.md)', [
    { value: 'local-stdio', label: 'E — Local stdio ★', hint: 'single developer on a D365FO VM; VS launches the server' },
    { value: 'hybrid', label: 'B — Hybrid ★', hint: 'Azure serves the shared index; local companion handles writes' },
    { value: 'local-http', label: 'C — Local HTTP', hint: 'several clients on this machine share one server on a port' },
    { value: 'ude', label: 'D — UDE', hint: 'Unified Developer Experience / Power Platform Tools' },
    { value: 'multi', label: 'F — Multi-instance', hint: 'several D365FO clients on one machine, one instance each' },
  ]);

  // All scenarios need the local clone installed and built
  if (!await ensureInstalledAndBuilt()) { process.exitCode = 1; return; }
  if (!await maybeBuildBridge(scenario)) { process.exitCode = 1; return; }

  if (scenario === 'hybrid') {
    const url = await askText({ message: 'Azure server URL', placeholder: 'https://your-server.azurewebsites.net/mcp/', required: true });
    const solutionsPath = await askText({ message: 'Folder scanned for .rnrproj solutions (D365FO_SOLUTIONS_PATH)', placeholder: 'K:\\repos\\MySolution\\projects', required: true });
    const workspacePath = await askText({ message: 'Two-level workspace path …\\PackagesLocalDirectory\\<Package>\\<Model> (D365FO_WORKSPACE_PATH)', placeholder: 'K:\\AosService\\PackagesLocalDirectory\\YourPackage\\YourModel', required: true });
    mcpJsonNote({
      'd365fo-azure': { url },
      'd365fo-local': {
        command: 'node',
        args: [distEntryWin()],
        env: { MCP_SERVER_MODE: 'write-only', D365FO_SOLUTIONS_PATH: solutionsPath, D365FO_WORKSPACE_PATH: workspacePath },
      },
    });
    placementNote();
    p.outro('Hybrid setup complete — no local index needed (Azure serves the search).');
    return;
  }

  if (scenario === 'multi') {
    p.log.info('Each D365FO client gets its own instance (own .env, database and port).');
    await instanceAddCommand(undefined, undefined);
    return;
  }

  // C / D / E: local index setups
  const port = await configureRootEnv(scenario);
  if (!await maybeBuildIndex()) { process.exitCode = 1; return; }

  if (scenario === 'local-http') {
    mcpJsonNote({ 'd365fo-mcp-tools': { url: `http://localhost:${port}/mcp/` } });
    placementNote();
    p.outro('Done. Start the server with: d365fo-mcp start');
    return;
  }

  if (scenario === 'ude') {
    const modelName = await askText({ message: 'Model name for code generation (D365FO_MODEL_NAME)', required: true });
    const workspacePath = await askText({
      message: 'Two-level workspace path …\\PackagesLocalDirectory\\<Package>\\<Model> (D365FO_WORKSPACE_PATH)',
      placeholder: 'K:\\AosService\\PackagesLocalDirectory\\YourPackage\\YourModel',
      required: true,
    });
    mcpJsonNote({
      'd365fo-mcp-tools': {
        command: 'node',
        args: [distEntryWin()],
        env: { D365FO_MODEL_NAME: modelName, D365FO_DEV_ENVIRONMENT_TYPE: 'ude', D365FO_WORKSPACE_PATH: workspacePath },
      },
    });
    placementNote();
    p.outro('Done. VS spawns the server automatically — no manual start needed.');
    return;
  }

  // E — local stdio
  const solutionsPath = await askText({
    message: 'Folder scanned for .rnrproj solutions (D365FO_SOLUTIONS_PATH; Enter to skip)',
    placeholder: 'K:\\repos\\MySolution\\projects',
  });
  const workspacePath = await askText({
    message: 'Two-level workspace path …\\PackagesLocalDirectory\\<Package>\\<Model> (D365FO_WORKSPACE_PATH)',
    placeholder: 'K:\\AosService\\PackagesLocalDirectory\\YourPackage\\YourModel',
    required: true,
  });
  const env: Record<string, string> = {
    DB_PATH: paths.defaultDb,
    LABELS_DB_PATH: paths.defaultLabelsDb,
    D365FO_WORKSPACE_PATH: workspacePath,
  };
  if (solutionsPath) env.D365FO_SOLUTIONS_PATH = solutionsPath;
  mcpJsonNote({ 'd365fo-mcp-tools': { command: 'node', args: [distEntryWin()], env } });
  placementNote();
  p.outro('Done. VS spawns the server automatically — no manual start needed.');
}
