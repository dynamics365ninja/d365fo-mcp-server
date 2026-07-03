/**
 * `d365fo-mcp index [instance] [--all]` — rebuild the metadata index
 * (extract-metadata + build-database), the TS counterpart of
 * instances/rebuild-instance.ps1 minus the git-pull step (that lives in
 * `d365fo-mcp update`).
 */
import * as fs from 'node:fs';
import { isWindows, paths } from '../context.js';
import { missingVars } from '../envFile.js';
import { runNode } from '../exec.js';
import { listInstances } from '../instances.js';
import { instanceTarget, pickTarget, rootTarget, Target } from '../target.js';
import { askConfirm, askSelect, p } from '../ui.js';
import { normalizeXppConfigName } from '../xppConfig.js';

/** Warn about vars added to .env.example since this .env was created. */
function warnMissingSettings(envFile: string | null, label: string): boolean {
  if (!envFile || !fs.existsSync(envFile) || !fs.existsSync(paths.envExample)) return false;
  const missing = missingVars(
    fs.readFileSync(paths.envExample, 'utf8'),
    fs.readFileSync(envFile, 'utf8'),
  );
  if (missing.length === 0) return false;
  p.log.warn(`New settings in .env.example not present in ${label}:\n` +
    missing.map(m => `   ${m.name}=${m.value}`).join('\n'));
  return true;
}

/** Run extract + build-database for one target. Returns true on success. */
export async function rebuildIndex(target: Target): Promise<boolean> {
  const env = target.envFile ? { ENV_FILE: target.envFile } : undefined;

  if (isWindows && target.envFile) {
    const expanded = normalizeXppConfigName(target.envFile);
    if (expanded) p.log.info(`Expanded XPP_CONFIG_NAME: ${expanded.from} → ${expanded.to}`);
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
    // Interactive: offer "all instances" like rebuild-instance.ps1 does.
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

  const hasNewSettings = targets
    .map(t => warnMissingSettings(t.envFile, `${t.label} .env`))
    .some(Boolean);
  if (hasNewSettings && !opts.yes) {
    if (!await askConfirm('Some .env files are missing new settings (see above). Continue anyway?', false)) {
      p.cancel('Aborted — update the .env files first.');
      return;
    }
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
