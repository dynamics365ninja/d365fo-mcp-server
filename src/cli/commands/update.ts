/**
 * `d365fo-mcp update [--yes]` — bring the installation to the latest release,
 * then optionally rebuild the C# bridge and the metadata index.
 *
 * How the code is refreshed depends on how it was installed: a checkout runs
 * the "Update" flow SETUP.md documents (git pull && npm install && npm run
 * build); an npm install reinstalls itself from the registry.
 */
import * as fs from 'node:fs';
import { installMode, isWindows, paths } from '../context.js';
import { runExe, runShell } from '../exec.js';
import { listInstances } from '../instances.js';
import { checkRelease } from '../npmRegistry.js';
import { instanceTarget, rootTarget } from '../target.js';
import { askConfirm, p, requireFullInstall } from '../ui.js';
import { rebuildIndex } from './indexCmd.js';

export async function updateCommand(opts: { yes?: boolean }): Promise<void> {
  p.intro('d365fo-mcp update');
  if (!requireFullInstall()) return;

  // Say up front what the update is moving towards. A checkout tracks a branch
  // rather than the registry, so there the comparison is informational only —
  // being "ahead" of the latest release is the normal state on main.
  const release = await checkRelease();
  if (release.latest === null) {
    p.log.warn(`Running ${release.current} — npm registry unreachable, so this update runs blind.`);
  } else if (release.behind) {
    p.log.step(`Running ${release.current}; latest published release is ${release.latest}.`);
  } else {
    p.log.success(`Running ${release.current} — already the latest published release.`);
    if (installMode === 'npm' && !opts.yes && !await askConfirm('Reinstall anyway?', false)) {
      p.outro('Nothing to update.');
      return;
    }
  }

  const steps: [string, () => Promise<number>][] = installMode === 'npm'
    ? [['npm install -g d365fo-mcp@latest', () => runShell('npm install -g d365fo-mcp@latest')]]
    : [
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
