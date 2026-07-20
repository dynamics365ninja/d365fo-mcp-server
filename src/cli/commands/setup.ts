/**
 * `d365fo-mcp setup` — first-time setup wizard.
 *
 * Walks through the deployment scenarios documented in docs/SETUP.md
 * (A azure client · B hybrid · C local HTTP · D UDE · E local stdio ·
 * F multi-instance), asks only the settings that scenario actually needs
 * (each with its description, from src/config/settings.ts), and writes the
 * answers to config/d365fo-mcp.json — the user never edits .env by hand.
 * Secrets go to config/secrets.json; an existing .env is imported first so a
 * returning user is not asked for what they already configured.
 */
import * as fs from 'node:fs';
import { relative, resolve } from 'node:path';
import { isWindows, paths, repoRoot } from '../context.js';
import type { SectionId } from '../../config/settings.js';
import { settingByPath, settingsInSection } from '../../config/settings.js';
import { runExe, runShell } from '../exec.js';
import { mcpJsonNote, placementNote, stdioServer } from '../mcpJson.js';
import { askAdvanced, askSecrets, askSetting, askSettings } from '../settingsPrompt.js';
import { migrateLegacyEnv, openStore, readSetting, saveStore, writeSetting, type SettingsStore } from '../settingsStore.js';
import { rootTarget } from '../target.js';
import { askConfirm, askSelect, askText, p, requireGitCheckout } from '../ui.js';
import { listXppConfigs } from '../xppConfig.js';
import { rebuildIndex } from './indexCmd.js';
import { instanceAddCommand } from './instance.js';

type Scenario = 'hybrid' | 'local-http' | 'ude' | 'local-stdio' | 'multi';

const setting = (path: string) => {
  const found = settingByPath(path);
  if (!found) throw new Error(`Unknown setting: ${path}`); // registry typo — fail loudly at first use
  return found;
};

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
  if (fs.existsSync(paths.bridgeExe)) {
    if (!await askConfirm('C# bridge already built — rebuild it?', false)) {
      return true;
    }
    // user confirmed rebuild — skip the second confirmation
  } else if (!await askConfirm('Build the C# bridge? (required for creating/modifying files)')) {
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

/** Open the root store and fold an existing .env into it. */
function openRootStore(): SettingsStore {
  const store = openStore(repoRoot, paths.rootEnv);
  const migrated = migrateLegacyEnv(store);
  if (migrated.length > 0) {
    p.log.success(
      `Imported ${migrated.length} setting(s) from the existing .env: ${migrated.map(s => s.env).join(', ')}\n` +
      '   .env is left in place and still read as a fallback — the JSON config now wins.',
    );
  }
  return store;
}

/** D365FO environment: type, then the paths/models that type needs. */
async function configureEnvironment(store: SettingsStore, scenario: Scenario): Promise<'traditional' | 'ude'> {
  p.log.step('D365FO environment — where the X++ packages live');

  let envType: string;
  if (scenario === 'ude') {
    envType = 'ude';
    writeSetting(store, setting('environment.type'), 'ude');
  } else {
    // Preselect what this machine looks like: XPP config files are what
    // distinguishes a UDE box from a classic AOSService VM.
    envType = String(await askSetting(store, setting('environment.type'), {
      initial: listXppConfigs().length > 0 ? 'ude' : 'traditional',
    }));
  }

  if (envType === 'ude') {
    // Pin an XPP config when any exist; otherwise the server auto-detects the
    // newest one at runtime, which is the right behaviour on a single-env box.
    const configs = listXppConfigs();
    if (configs.length > 0) {
      const s = setting('environment.xppConfigName');
      const pick = await askSelect(
        `${s.label}\n  ${s.description}`,
        [
          { value: '', label: '(auto — always use the newest)' },
          ...configs.map((cfg, i) => ({
            value: cfg.fullName,
            label: `${cfg.name}  v${cfg.version}${i === 0 ? ' (newest)' : ''}`,
            hint: cfg.modelStoreFolder,
          })),
        ],
        String(readSetting(store, s) ?? ''),
      );
      writeSetting(store, s, pick || undefined);
    } else {
      p.log.info('No XPP configs found — the server will auto-detect at runtime.');
    }
    return 'ude';
  }

  await askSetting(store, setting('environment.packagePath'), { required: true });
  await askSetting(store, setting('environment.customModels'), { required: true });
  return 'traditional';
}

/** Model/paths the write tools target. Auto-detection covers what is left empty. */
async function configureWorkspace(store: SettingsStore, scenario: Scenario): Promise<void> {
  p.log.step('Workspace — which model the server writes to (leave empty to auto-detect from the IDE)');
  await askSetting(store, setting('workspace.modelName'));
  await askSetting(store, setting('workspace.path'), { required: scenario === 'hybrid' || scenario === 'ude' });
  await askSetting(store, setting('workspace.solutionsPath'));
}

async function configureNaming(store: SettingsStore): Promise<void> {
  p.log.step('Naming convention — applied to every generated object');
  await askSettings(store, settingsInSection('naming', 'basic'));
}

async function configureIndex(store: SettingsStore): Promise<void> {
  p.log.step('Metadata index — what gets extracted and how long the build takes');
  await askSetting(store, setting('index.extractMode'));
  const includeLabels = await askSetting(store, setting('index.includeLabels'));
  if (includeLabels) await askSetting(store, setting('index.labelLanguages'));
}

async function maybeBuildIndex(): Promise<boolean> {
  if (!await askConfirm('Build the metadata index now? (custom models: minutes; full index: 1–2 h)')) {
    p.log.warn('Skipped — run `d365fo-mcp index` before first use.');
    return true;
  }
  return rebuildIndex(rootTarget());
}

export function savedNote(store: SettingsStore): void {
  const rel = relative(repoRoot, store.configPath) || store.configPath;
  const lines = [`Settings written to ${rel}`];
  if (fs.existsSync(store.secretsPath)) {
    lines.push(`Secrets written to ${relative(repoRoot, store.secretsPath)} (git-ignored, owner-only)`);
  }
  lines.push('', 'Edit it by re-running `d365fo-mcp setup` or by hand — it is plain JSON.');
  p.note(lines.join('\n'), 'Configuration');
}

export async function setupCommand(): Promise<void> {
  p.intro('d365fo-mcp setup — first-time setup');
  if (!requireGitCheckout()) return;

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

  if (scenario === 'multi') {
    p.log.info('Each D365FO client gets its own instance (own config, database and port).');
    await instanceAddCommand(undefined, undefined);
    return;
  }

  const store = openRootStore();

  if (scenario === 'hybrid') {
    // The Azure half is configured through App Service settings; this wizard
    // only sets up the local write-only companion.
    writeSetting(store, setting('server.mode'), 'write-only');
    const url = await askText({ message: 'Azure server URL', placeholder: 'https://your-server.azurewebsites.net/mcp/', required: true });
    await configureEnvironment(store, scenario);
    await configureWorkspace(store, scenario);
    await configureNaming(store);
    await askSecrets(store, ['behavior']);
    await askAdvanced(store, ['environment', 'workspace', 'naming', 'bridge', 'behavior', 'server']);
    saveStore(store);
    savedNote(store);

    mcpJsonNote({
      'd365fo-azure': { url },
      'd365fo-local': stdioServer(store),
    });
    placementNote();
    p.outro('Hybrid setup complete — no local index needed (Azure serves the search).');
    return;
  }

  // C / D / E: local index setups
  writeSetting(store, setting('server.mode'), 'full');
  await configureEnvironment(store, scenario);
  await configureWorkspace(store, scenario);
  await configureNaming(store);
  await configureIndex(store);

  let port = Number(readSetting(store, setting('server.port')) ?? 8080);
  if (scenario === 'local-http') {
    port = Number(await askSetting(store, setting('server.port'), { required: true }) ?? port);
    await askSecrets(store, ['server']);
  }

  const advancedSections: SectionId[] = ['environment', 'workspace', 'naming', 'index', 'server', 'bridge', 'behavior'];
  await askAdvanced(store, advancedSections);
  saveStore(store);
  savedNote(store);

  if (!await maybeBuildIndex()) { process.exitCode = 1; return; }

  if (scenario === 'local-http') {
    mcpJsonNote({ 'd365fo-mcp-tools': { url: `http://localhost:${port}/mcp/` } });
    placementNote();
    p.outro('Done. Start the server with: d365fo-mcp start');
    return;
  }

  // D / E — the IDE spawns dist/index.js itself and is pointed at the config
  // file; every other setting comes from there.
  mcpJsonNote({ 'd365fo-mcp-tools': stdioServer(store) });
  placementNote();
  p.outro('Done. VS spawns the server automatically — no manual start needed.');
}
