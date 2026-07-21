/**
 * `d365fo-mcp instance <add|list|run|rebuild|upgrade>` — multi-instance
 * management, the TS counterpart of instances/*.ps1 (Scenario F in SETUP.md).
 * Each instance owns a d365fo-mcp.json next to its data folder;
 * run/rebuild are thin aliases of `start`/`index` with an instance argument.
 */
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { settingByPath, settingsInSection } from '../../config/settings.js';
import { pinBridgeExe } from '../bridgePath.js';
import { createInstance, getInstance, listInstances, suggestPort } from '../instances.js';
import { mcpJsonNote, placementNote, stdioServer } from '../mcpJson.js';
import { selectXppConfig } from './config.js';
import { askAdvanced, askSetting, askSettings } from '../settingsPrompt.js';
import { openInstanceStore, readPath, readSetting, saveStore, writeSetting } from '../settingsStore.js';
import { instanceTarget } from '../target.js';
import { askConfirm, askSelect, askText, p } from '../ui.js';
import { listXppConfigs, XppConfig, xppConfigDir } from '../xppConfig.js';
import { rebuildIndex } from './indexCmd.js';

const dbPathSetting = settingByPath('index.dbPath')!;
const xppConfigNameSetting = settingByPath('environment.xppConfigName')!;
const envTypeSetting = settingByPath('environment.type')!;

function printInstances(): void {
  const instances = listInstances();
  if (instances.length === 0) {
    p.log.info('No instances yet — create one with: d365fo-mcp instance add');
    return;
  }
  const lines = instances.map(i => {
    const store = openInstanceStore(i.dir);
    const dbPath = readPath(store, dbPathSetting, resolve(i.dir, 'data', 'xpp-metadata.db'));
    const db = fs.existsSync(dbPath) ? `${(fs.statSync(dbPath).size / 1024 / 1024).toFixed(0)} MB` : 'no index';
    const cfg = readSetting(store, xppConfigNameSetting);
    return `${i.name.padEnd(20)} port ${String(i.port ?? '?').padEnd(6)} db ${db.padEnd(10)}${cfg ? ` [${cfg}]` : ''}`;
  });
  p.note(lines.join('\n'), `Instances (${instances.length})`);
}

export async function instanceListCommand(): Promise<void> {
  p.intro('d365fo-mcp instance list');
  printInstances();
  p.outro('');
}

export async function instanceAddCommand(name: string | undefined, portArg: string | undefined): Promise<void> {
  p.intro('d365fo-mcp instance add');
  const instances = listInstances();
  if (instances.length > 0) printInstances();

  const instanceName = name ?? await askText({
    message: 'Instance name',
    placeholder: 'e.g. alpha, projectX, client-prod',
    required: true,
  });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(instanceName)) {
    p.log.error(`'${instanceName}' is not a valid instance name (letters, digits, . _ - only).`);
    process.exitCode = 1;
    return;
  }
  if (getInstance(instanceName)) {
    p.log.error(`Instance '${instanceName}' already exists.`);
    process.exitCode = 1;
    return;
  }

  const suggested = suggestPort(instances);
  const port = portArg ? parseInt(portArg, 10) : parseInt(await askText({
    message: 'Port',
    initialValue: String(suggested),
    required: true,
  }), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    p.log.error(`Invalid port: ${portArg ?? port}`);
    process.exitCode = 1;
    return;
  }
  if (instances.some(i => i.port === port)) {
    if (!await askConfirm(`Port ${port} is already used by another instance. Continue anyway?`, false)) {
      p.cancel('Aborted.');
      return;
    }
  }

  const inst = createInstance(instanceName, port);
  p.log.success(`Instance created: ${inst.dir}`);

  // Same questions as the root wizard, scoped to this instance's config file.
  const store = openInstanceStore(inst.dir);
  // Instances share the one bridge binary this machine built, and need to be
  // told where it is for the same reason the root config does.
  pinBridgeExe(store);
  p.log.step('D365FO environment — where this instance reads its X++ packages');
  const envType = String(await askSetting(store, envTypeSetting, {
    initial: listXppConfigs().length > 0 ? 'ude' : 'traditional',
  }));
  if (envType === 'ude') {
    await selectXppConfig(store);
  } else {
    await askSetting(store, settingByPath('environment.packagePath')!, { required: true });
    await askSetting(store, settingByPath('environment.customModels')!, { required: true });
  }
  p.log.step('Workspace and naming');
  await askSetting(store, settingByPath('workspace.modelName')!);
  await askSetting(store, settingByPath('workspace.path')!);
  await askSettings(store, settingsInSection('naming', 'basic'));
  p.log.step('Metadata index');
  await askSettings(store, settingsInSection('index', 'basic'));
  await askAdvanced(store, ['environment', 'workspace', 'index', 'server', 'bridge', 'behavior']);
  saveStore(store);

  // Both ways to reach this instance: the IDE spawning it over stdio with its
  // own config, or an HTTP client on the port it was given.
  mcpJsonNote(
    {
      [`d365fo-${instanceName}`]: stdioServer(store),
      [`d365fo-${instanceName}-http`]: { url: `http://localhost:${port}/mcp/` },
    },
    `.mcp.json — keep the stdio entry OR the http one, not both`,
  );
  placementNote();

  p.note(
    `Config: ${store.configPath}\n\n` +
    `1. Build the index:  d365fo-mcp instance rebuild ${instanceName}\n` +
    `2. Start it:         d365fo-mcp instance run ${instanceName}   (only needed for the http entry)`,
    'Next steps',
  );
  p.outro('');
}

/** Interactive XPP config picker; returns null when none are available. */
async function pickXppConfig(currentConfig: string | null): Promise<XppConfig | null> {
  const configs = listXppConfigs();
  if (configs.length === 0) {
    const dir = xppConfigDir();
    p.log.error(`No XPP config files found${dir ? ` in ${dir}` : ''}.\n` +
      '   This directory is created by Power Platform Tools in VS2022 (Windows only).');
    return null;
  }
  const fullName = await askSelect(
    'Select the XPP config',
    configs.map((cfg, i) => ({
      value: cfg.fullName,
      label: `${cfg.name}  v${cfg.version}${i === 0 ? ' (newest)' : ''}${cfg.fullName === currentConfig || cfg.name === currentConfig ? ' (current)' : ''}`,
      hint: cfg.modelStoreFolder,
    })),
    configs[0].fullName,
  );
  return configs.find(cfg => cfg.fullName === fullName)!;
}

export async function instanceUpgradeCommand(name: string | undefined): Promise<void> {
  p.intro('d365fo-mcp instance upgrade');
  const instances = listInstances();
  if (instances.length === 0) {
    p.log.error('No instances found. Create one with: d365fo-mcp instance add');
    process.exitCode = 1;
    return;
  }

  let inst = name ? getInstance(name) : undefined;
  if (name && !inst) {
    p.log.error(`Instance '${name}' not found.`);
    process.exitCode = 1;
    return;
  }
  if (!inst) {
    const picked = await askSelect(
      'Which instance do you want to repoint?',
      instances.map(i => {
        const cfg = readSetting(openInstanceStore(i.dir), xppConfigNameSetting);
        return { value: i.name, label: i.name, hint: `port ${i.port ?? '?'}${cfg ? ` · ${cfg}` : ''}` };
      }),
    );
    inst = getInstance(picked)!;
  }

  const store = openInstanceStore(inst.dir);
  const currentValue = readSetting(store, xppConfigNameSetting);
  const currentConfig = typeof currentValue === 'string' && currentValue ? currentValue : null;
  p.log.info(`Current XPP config: ${currentConfig ?? '(not set)'}`);

  const selected = await pickXppConfig(currentConfig);
  if (!selected) {
    process.exitCode = 1;
    return;
  }

  if (currentConfig === selected.fullName) {
    p.log.warn('The pinned XPP config is unchanged.');
    if (!await askConfirm('Rebuild anyway?', false)) {
      p.cancel('Aborted.');
      return;
    }
  } else {
    p.log.info(`was: ${currentConfig ?? '(not set)'}\n   now: ${selected.fullName}`);
    if (!await askConfirm('Write this to the instance config and rebuild?')) {
      p.cancel('Aborted.');
      return;
    }
    writeSetting(store, xppConfigNameSetting, selected.fullName);
    saveStore(store);
    p.log.success(`Updated ${store.configPath}`);
  }

  if (!await rebuildIndex(instanceTarget(inst))) {
    process.exitCode = 1;
    return;
  }
  p.outro('Upgrade complete.');
}
