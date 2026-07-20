/**
 * `d365fo-mcp index [instance] [--all]` — rebuild the metadata index
 * (extract-metadata + build-database), the TS counterpart of
 * instances/rebuild-instance.ps1 minus the git-pull step (that lives in
 * `d365fo-mcp update`).
 */
import { isWindows, paths } from '../context.js';
import { runNode } from '../exec.js';
import { listInstances } from '../instances.js';
import { instanceTarget, pickTarget, rootTarget, targetEnv, Target } from '../target.js';
import { askSelect, p, requireGitCheckout } from '../ui.js';
import { normalizeXppConfigName } from '../xppConfig.js';

/** Run extract + build-database for one target. Returns true on success. */
export async function rebuildIndex(target: Target): Promise<boolean> {
  const env = targetEnv(target);

  if (isWindows) {
    const expanded = normalizeXppConfigName(target.store);
    if (expanded) p.log.info(`Expanded XPP config name: ${expanded.from} → ${expanded.to}`);
  }

  p.log.step(`[1/2] Extracting metadata (${target.label})…`);
  if (await runNode(['--import', 'tsx/esm', paths.extractScript], { env }) !== 0) {
    p.log.error(`Metadata extraction failed for ${target.label}`);
    return false;
  }

  p.log.step(`[2/2] Building database (${target.label})…`);
  if (await runNode(['--max-old-space-size=6144', '--import', 'tsx/esm', paths.buildDbScript], { env }) !== 0) {
    p.log.error(`Database build failed for ${target.label}`);
    return false;
  }

  p.log.success(`Index rebuilt: ${target.label}`);
  return true;
}

export async function indexCommand(instanceName: string | undefined, opts: { all?: boolean; yes?: boolean }): Promise<void> {
  p.intro('d365fo-mcp index');
  if (!requireGitCheckout()) return;

  let targets: Target[];
  if (opts.all) {
    const instances = listInstances();
    if (instances.length === 0) {
      p.log.error('--all: no instances found under instances/.');
      process.exitCode = 1;
      return;
    }
    targets = instances.map(instanceTarget);
  } else if (!instanceName && opts.yes) {
    // Fully non-interactive: no name + --yes targets the root server.
    targets = [rootTarget()];
  } else if (!instanceName && listInstances().length > 0) {
    // Interactive: offer "all instances" as a choice alongside a single target.
    const choice = await askSelect('Rebuild which index?', [
      { value: '__pick__', label: 'Choose a single target…' },
      { value: '__all__', label: 'All instances' },
    ]);
    targets = choice === '__all__'
      ? listInstances().map(instanceTarget)
      : [await pickTarget(undefined, 'Which target?')];
  } else {
    targets = [await pickTarget(instanceName, 'Which target?')];
  }

  const failed: string[] = [];
  for (const target of targets) {
    if (!await rebuildIndex(target)) failed.push(target.name);
  }

  if (failed.length > 0) {
    p.outro(`Completed with errors. Failed: ${failed.join(', ')}`);
    process.exitCode = 1;
  } else {
    p.outro(targets.length > 1 ? `All ${targets.length} indexes rebuilt.` : 'Done.');
  }
}
