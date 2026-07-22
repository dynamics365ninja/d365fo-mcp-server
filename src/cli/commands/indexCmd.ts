/**
 * `d365fo-mcp index [instance] [--all]` — rebuild the metadata index
 * (extract-metadata + build-database), the TS counterpart of
 * instances/rebuild-instance.ps1 minus the git-pull step (that lives in
 * `d365fo-mcp update`).
 */
import { dataRoot, installMode, isWindows, paths } from '../context.js';
import { runNode } from '../exec.js';
import { listInstances } from '../instances.js';
import { instanceTarget, pickTarget, rootTarget, targetEnv, Target } from '../target.js';
import { askSelect, p, requireFullInstall } from '../ui.js';
import { normalizeXppConfigName } from '../xppConfig.js';

/**
 * Node arguments that run one index script.
 *
 * A checkout runs the TypeScript through tsx; an npm install has neither the
 * sources nor tsx and runs the esbuild bundle instead. The bundle sits one
 * level deeper than the sources, so its `loadEnv(import.meta.url)` would look
 * for dist/.env — harmless, because `targetEnv` names the config explicitly
 * whenever one exists, and before that there is nothing to find either way.
 */
function scriptArgs(tsSource: string, bundle: string): string[] {
  return installMode === 'git' ? ['--import', 'tsx/esm', tsSource] : [bundle];
}

/** Run extract + build-database for one target. Returns true on success. */
export async function rebuildIndex(target: Target): Promise<boolean> {
  const env = targetEnv(target);
  // Run from the target's own directory, not the package: the index scripts
  // fall back to relative literals ('./data/xpp-metadata.db') whenever a
  // setting is absent AND no config file exists to anchor it, and the default
  // cwd of runNode is repoRoot — which for an npm install is the package npm
  // replaces on every update, on whatever drive npm happens to live on.
  const cwd = target.instance?.dir ?? dataRoot();

  if (isWindows) {
    const expanded = normalizeXppConfigName(target.store);
    if (expanded) p.log.info(`Expanded XPP config name: ${expanded.from} → ${expanded.to}`);
  }

  p.log.step(`[1/2] Extracting metadata (${target.label})…`);
  if (await runNode(scriptArgs(paths.extractScript, paths.extractScriptDist), { cwd, env }) !== 0) {
    p.log.error(`Metadata extraction failed for ${target.label}`);
    return false;
  }

  p.log.step(`[2/2] Building database (${target.label})…`);
  if (await runNode(['--max-old-space-size=6144', ...scriptArgs(paths.buildDbScript, paths.buildDbScriptDist)], { cwd, env }) !== 0) {
    p.log.error(`Database build failed for ${target.label}`);
    return false;
  }

  p.log.success(`Index rebuilt: ${target.label}`);
  return true;
}

export async function indexCommand(instanceName: string | undefined, opts: { all?: boolean; yes?: boolean }): Promise<void> {
  p.intro('d365fo-mcp index');
  if (!requireFullInstall()) return;

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
