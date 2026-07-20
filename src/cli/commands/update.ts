/**
 * `d365fo-mcp update [--yes]` — pull the latest code, reinstall dependencies,
 * rebuild TypeScript, and optionally rebuild the C# bridge and the metadata
 * index (the "Update" flow SETUP.md documents as git pull && npm install &&
 * npm run build).
 */
import * as fs from 'node:fs';
import { isWindows, paths } from '../context.js';
import { runExe, runShell } from '../exec.js';
import { listInstances } from '../instances.js';
import { instanceTarget, rootTarget } from '../target.js';
import { askConfirm, p, requireGitCheckout } from '../ui.js';
import { rebuildIndex } from './indexCmd.js';

export async function updateCommand(opts: { yes?: boolean }): Promise<void> {
  p.intro('d365fo-mcp update');
  if (!requireGitCheckout()) return;

  const steps: [string, () => Promise<number>][] = [
    ['git pull', () => runExe('git', ['pull'])],
    ['npm install', () => runShell('npm install')],
    ['npm run build', () => runShell('npm run build')],
  ];
  for (const [label, run] of steps) {
    p.log.step(label);
    if (await run() !== 0) {
      p.log.error(`${label} failed — fix the error above and re-run.`);
      process.exitCode = 1;
      return;
    }
  }

  // Only rebuild the bridge if it was built before — a missing exe means this install never needed writes.
  if (isWindows && fs.existsSync(paths.bridgeExe)) {
    const rebuild = opts.yes || await askConfirm('Rebuild the C# bridge (recommended after a D365FO version upgrade)?');
    if (rebuild) {
      if (await runExe('dotnet', ['build', '-c', 'Release'], { cwd: paths.bridgeDir }) !== 0) {
        p.log.error('Bridge build failed — writes may use the previous bridge binary.');
        process.exitCode = 1;
        return;
      }
      p.log.success('C# bridge rebuilt.');
    }
  }

  if (!opts.yes && await askConfirm('Rebuild the metadata index too? (takes minutes to hours)', false)) {
    const instances = listInstances();
    const targets = instances.length > 0 ? instances.map(instanceTarget) : [rootTarget()];
    for (const target of targets) {
      if (!await rebuildIndex(target)) {
        process.exitCode = 1;
        return;
      }
    }
  }

  p.outro('Update complete.');
}
