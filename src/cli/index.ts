#!/usr/bin/env node
/**
 * d365fo-mcp — interactive management CLI for the D365 F&O MCP Server.
 *
 * Every operation is a plain subcommand (scriptable, CI-friendly); running
 * with no arguments opens an interactive menu, and any missing argument is
 * asked for with predefined choices. The instances/*.ps1 scripts remain as a
 * PowerShell fallback for the same flows.
 *
 *   d365fo-mcp                  interactive menu
 *   d365fo-mcp setup            first-time setup wizard (scenarios A–F)
 *   d365fo-mcp doctor           environment & installation health check
 *   d365fo-mcp start [name]     run the root server or an instance
 *   d365fo-mcp update [--yes]   git pull + npm install + build (+ bridge/index)
 *   d365fo-mcp index [name]     rebuild the metadata index (--all: all instances)
 *   d365fo-mcp instance …       add | list | run | rebuild | upgrade
 */
import { Command } from 'commander';
import { doctorCommand } from './commands/doctor.js';
import { indexCommand } from './commands/indexCmd.js';
import { instanceAddCommand, instanceListCommand, instanceUpgradeCommand } from './commands/instance.js';
import { setupCommand } from './commands/setup.js';
import { startCommand } from './commands/start.js';
import { updateCommand } from './commands/update.js';
import { askSelect, p } from './ui.js';
import { listInstances } from './instances.js';

const program = new Command();

program
  .name('d365fo-mcp')
  .description('Manage the D365 F&O MCP Server: setup, updates, instances, index builds')
  .version('1.0.0');

program.command('setup')
  .description('First-time setup wizard (deployment scenarios A–F from docs/SETUP.md)')
  .action(setupCommand);

program.command('doctor')
  .description('Check the environment and installation; prints a fix for every problem')
  .action(doctorCommand);

program.command('start')
  .argument('[instance]', "instance name, or 'root' for the repo-level .env")
  .description('Start the server in the foreground (HTTP mode)')
  .action(startCommand);

program.command('update')
  .option('-y, --yes', 'non-interactive: accept defaults, skip the reindex question')
  .description('Update the installation: git pull + npm install + build (+ bridge, index)')
  .action(updateCommand);

program.command('index')
  .argument('[instance]', "instance name, or 'root' for the repo-level .env")
  .option('--all', 'rebuild every instance')
  .option('-y, --yes', 'non-interactive: skip confirmation questions')
  .description('Rebuild the metadata index (extract + build database)')
  .action(indexCommand);

const instance = program.command('instance').description('Manage multi-instance setups (Scenario F)');
instance.command('add')
  .argument('[name]', 'instance name')
  .argument('[port]', 'HTTP port')
  .description('Create a new instance (folder + .env from the template)')
  .action(instanceAddCommand);
instance.command('list')
  .description('List instances with port, index size and pinned XPP config')
  .action(instanceListCommand);
instance.command('run')
  .argument('[name]', 'instance name')
  .description('Start an instance (alias of: d365fo-mcp start <name>)')
  .action(startCommand);
instance.command('rebuild')
  .argument('[name]', 'instance name')
  .option('--all', 'rebuild every instance')
  .description('Rebuild the index of an instance (alias of: d365fo-mcp index <name>)')
  .action((name: string | undefined, opts: { all?: boolean }) => indexCommand(name, opts));
instance.command('upgrade')
  .argument('[name]', 'instance name')
  .description('Repoint an instance at a new XPP config after a UDE upgrade, then rebuild')
  .action(instanceUpgradeCommand);

/** No arguments → interactive menu over the same commands. */
async function mainMenu(): Promise<void> {
  p.intro('d365fo-mcp — D365 F&O MCP Server management');
  const hasInstances = listInstances().length > 0;
  const action = await askSelect('What do you want to do?', [
    { value: 'setup', label: 'Setup', hint: 'first-time setup wizard' },
    { value: 'doctor', label: 'Doctor', hint: 'check environment & installation' },
    { value: 'start', label: 'Start server', hint: hasInstances ? 'root or an instance' : 'root server' },
    { value: 'update', label: 'Update', hint: 'git pull + install + build' },
    { value: 'index', label: 'Rebuild index', hint: 'extract metadata + build database' },
    { value: 'instance-add', label: 'Add instance', hint: 'new multi-instance environment' },
    ...(hasInstances ? [
      { value: 'instance-list', label: 'List instances' },
      { value: 'instance-upgrade', label: 'Upgrade instance', hint: 'repoint at a new XPP config' },
    ] : []),
  ]);
  switch (action) {
    case 'setup': return setupCommand();
    case 'doctor': return doctorCommand();
    case 'start': return startCommand(undefined);
    case 'update': return updateCommand({});
    case 'index': return indexCommand(undefined, {});
    case 'instance-add': return instanceAddCommand(undefined, undefined);
    case 'instance-list': return instanceListCommand();
    case 'instance-upgrade': return instanceUpgradeCommand(undefined);
  }
}

async function main(): Promise<void> {
  if (process.argv.length <= 2) {
    await mainMenu();
    return;
  }
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
