/**
 * `d365fo-mcp instance <add|list|run|rebuild|upgrade>` — multi-instance
 * management, the TS counterpart of instances/*.ps1 (Scenario F in SETUP.md).
 * run/rebuild are thin aliases of `start`/`index` with an instance argument.
 */
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { readEnvValue, writeEnvValue } from '../envFile.js';
import { createInstance, getInstance, listInstances, suggestPort } from '../instances.js';
import { instanceTarget } from '../target.js';
import { askConfirm, askSelect, askText, p } from '../ui.js';
import { listXppConfigs, XppConfig, xppConfigDir } from '../xppConfig.js';
import { rebuildIndex } from './indexCmd.js';

function printInstances(): void {
  const instances = listInstances();
  if (instances.length === 0) {
    p.log.info('No instances yet — create one with: d365fo-mcp instance add');
    return;
  }
  const lines = instances.map(i => {
    const dbPath = resolve(i.dir, readEnvValue(i.envFile, 'DB_PATH') ?? './data/xpp-metadata.db');
    const db = fs.existsSync(dbPath) ? `${(fs.statSync(dbPath).size / 1024 / 1024).toFixed(0)} MB` : 'no index';
    const cfg = readEnvValue(i.envFile, 'XPP_CONFIG_NAME');
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
  p.note(
    `1. Edit ${inst.envFile}\n` +
    '   — set XPP_CONFIG_NAME (or run: d365fo-mcp instance upgrade ' + instanceName + '),\n' +
    '     EXTENSION_PREFIX and D365FO_MODEL_NAME\n' +
    `2. Build the index:  d365fo-mcp instance rebuild ${instanceName}\n` +
    `3. Start it:         d365fo-mcp instance run ${instanceName}`,
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
      instances.map(i => ({
        value: i.name,
        label: i.name,
        hint: `port ${i.port ?? '?'}${readEnvValue(i.envFile, 'XPP_CONFIG_NAME') ? ` · ${readEnvValue(i.envFile, 'XPP_CONFIG_NAME')}` : ''}`,
      })),
    );
    inst = getInstance(picked)!;
  }

  const currentConfig = readEnvValue(inst.envFile, 'XPP_CONFIG_NAME');
  p.log.info(`Current XPP_CONFIG_NAME: ${currentConfig ?? '(not set)'}`);

  const selected = await pickXppConfig(currentConfig);
  if (!selected) {
    process.exitCode = 1;
    return;
  }

  if (currentConfig === selected.fullName) {
    p.log.warn('XPP_CONFIG_NAME is unchanged.');
    if (!await askConfirm('Rebuild anyway?', false)) {
      p.cancel('Aborted.');
      return;
    }
  } else {
    p.log.info(`was: ${currentConfig ?? '(not set)'}\n   now: ${selected.fullName}`);
    if (!await askConfirm('Write this to the instance .env and rebuild?')) {
      p.cancel('Aborted.');
      return;
    }
    writeEnvValue(inst.envFile, 'XPP_CONFIG_NAME', selected.fullName);
    p.log.success(`Updated ${inst.envFile}`);
  }

  if (!await rebuildIndex(instanceTarget(inst))) {
    process.exitCode = 1;
    return;
  }
  p.outro('Upgrade complete.');
}
