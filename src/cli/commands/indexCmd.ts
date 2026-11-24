/**
 * `d365fo-mcp index [instance] [--all]` — rebuild the metadata index
 * (extract-metadata + build-database), the TS counterpart of
 * instances/rebuild-instance.ps1 minus the git-pull step (that lives in
 * `d365fo-mcp update`). With binary ISV models configured, their dump and
 * import run between the two (src/cli/binaryIsv.ts); `--binary-only` runs just
 * that and a build-database scoped to those models.
 */
import { binaryIsvConfig, importBinaryIsvModels } from '../binaryIsv.js';
import { ensureBpCatalogFresh } from './bpCatalog.js';
import { dataRoot, installMode, isWindows, paths } from '../context.js';
import { runNode } from '../exec.js';
import { listInstances } from '../instances.js';
import { instanceTarget, pickTarget, rootTarget, targetEnv, Target } from '../target.js';
import { askSelect, p, requireFullInstall } from '../ui.js';
import { isXppConfigStale, normalizeXppConfigName, xppConfigDir } from '../xppConfig.js';
import { readSetting, readSettingOrDefault } from '../settingsStore.js';
import { settingByPath } from '../../config/settings.js';

/**
 * Why `target` must not be reindexed now, or null when it may.
 *
 * A pinned XPP config whose file is gone (Visual Studio keeps old configs, but
 * a cleanup after a UDE update may delete them, or the environment was removed)
 * makes extract-metadata find no UDE config. A full
 * rebuild then clears the database before anything shows that nothing was
 * extracted, and replaces a working index with an empty one. `start` and
 * `doctor` already warn about this pin; a rebuild is where it destroys data,
 * so here it is a refusal, not a question.
 *
 * Not gated on Windows: isXppConfigStale() is false wherever there is no
 * XPPConfig folder, and that keeps the check testable on any platform.
 */
export function staleXppConfigRefusal(target: Target): string | null {
  if (!isXppConfigStale(target.store)) return null;
  const configName = readSetting(target.store, settingByPath('environment.xppConfigName')!);
  const fix = target.instance
    ? `d365fo-mcp instance upgrade ${target.name}`
    : 'd365fo-mcp setup (pick an existing XPP config)';
  return `Pinned XPP config '${configName}' does not match any file in ${xppConfigDir()}.\n` +
    `   Rebuilding now would index nothing and replace the current index of ${target.label}, ` +
    'so nothing was changed.\n' +
    `   Point it at an existing config first: ${fix}`;
}

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

export interface RebuildOptions {
  /** Skip extract-metadata: re-import the binary ISV models and index only them. */
  binaryOnly?: boolean;
  /** Import binary ISV models whose references mostly do not resolve (the import's --force). */
  forceBinary?: boolean;
}

function listValue(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return items.map(m => String(m).trim()).filter(Boolean);
}

/**
 * The environment build-database needs once binary ISV models were imported.
 *
 * A `custom` build rebuilds only the models CUSTOM_MODELS names, and binary
 * models are not in that list (they are no source models), so they are added
 * to it; without a CUSTOM_MODELS the build scopes itself from the extract
 * manifest, which the import already extended. A `--binary-only` run is a
 * custom build of exactly the imported models. A full build indexes the whole
 * folder and needs nothing.
 */
export function buildEnvAfterBinaryImport(
  env: Record<string, string> | undefined,
  extractMode: string,
  customModels: string[],
  imported: string[],
  binaryOnly: boolean,
): Record<string, string> | undefined {
  if (binaryOnly) return { ...env, EXTRACT_MODE: 'custom', CUSTOM_MODELS: imported.join(',') };
  if (extractMode !== 'custom' || customModels.length === 0 || imported.length === 0) return env;
  return { ...env, CUSTOM_MODELS: [...new Set([...customModels, ...imported])].join(',') };
}

/** Run extract + build-database for one target. Returns true on success. */
export async function rebuildIndex(target: Target, opts: RebuildOptions = {}): Promise<boolean> {
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

  const refusal = staleXppConfigRefusal(target);
  if (refusal) {
    p.log.error(refusal);
    return false;
  }

  // The real environment outranks the config file in every script, so it does here too.
  const extractMode = process.env.EXTRACT_MODE || String(readSettingOrDefault(target.store, settingByPath('index.extractMode')!));
  const binary = binaryIsvConfig(target);
  if (opts.binaryOnly && !binary) {
    p.log.error(`--binary-only: ${target.label} has no binary ISV models configured (index.binaryIsvModels or index.binaryIsvDumpPath).`);
    return false;
  }
  if (binary && extractMode === 'standard' && !opts.binaryOnly) {
    p.log.info('Binary ISV models skipped — extractMode "standard" indexes Microsoft models only.');
  }
  const runBinary = binary !== null && (opts.binaryOnly || extractMode !== 'standard');
  const total = opts.binaryOnly ? 2 : runBinary ? 3 : 2;
  let step = 0;
  const stepLabel = (what: string) => `[${++step}/${total}] ${what} (${target.label})…`;

  if (!opts.binaryOnly) {
    p.log.step(stepLabel('Extracting metadata'));
    if (await runNode(scriptArgs(paths.extractScript, paths.extractScriptDist), { cwd, env }) !== 0) {
      p.log.error(`Metadata extraction failed for ${target.label}`);
      return false;
    }
  }

  let buildEnv = env;
  if (runBinary && binary) {
    p.log.step(stepLabel('Binary ISV models'));
    const result = await importBinaryIsvModels(target, binary, { dataDir: dataRoot(), cwd, force: opts.forceBinary });
    if (!result.ok || (opts.binaryOnly && result.models.length === 0)) {
      const reason = result.reason ?? 'the dump held no ISV model';
      if (opts.binaryOnly) {
        p.log.error(`Binary ISV models not imported for ${target.label}: ${reason}.`);
        return false;
      }
      // The extraction behind this took up to two hours and is good; losing it
      // over the ISV step would be worse than an index without the ISV.
      p.log.warn(
        `Binary ISV models not imported: ${reason}.\n` +
        `   The index is built without them. Fix that, then run: d365fo-mcp index ${target.name} --binary-only`,
      );
    } else {
      p.log.success(`Imported ${result.models.length} binary ISV model(s): ${result.models.join(', ')}`);
      const customModels = listValue(process.env.CUSTOM_MODELS ?? readSetting(target.store, settingByPath('environment.customModels')!));
      buildEnv = buildEnvAfterBinaryImport(env, extractMode, customModels, result.models, opts.binaryOnly === true);
    }
  }

  p.log.step(stepLabel('Building database'));
  if (await runNode(['--max-old-space-size=6144', ...scriptArgs(paths.buildDbScript, paths.buildDbScriptDist)], { cwd, env: buildEnv }) !== 0) {
    p.log.error(`Database build failed for ${target.label}`);
    return false;
  }

  p.log.success(`Index rebuilt: ${target.label}`);

  // Best-effort: a stale/missing BP catalog degrades one knowledge tool, not
  // the metadata index rebuild that just succeeded above.
  await ensureBpCatalogFresh(target);
  return true;
}

export async function indexCommand(
  instanceName: string | undefined,
  opts: { all?: boolean; yes?: boolean; binaryOnly?: boolean; forceBinary?: boolean },
): Promise<void> {
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
    if (!await rebuildIndex(target, { binaryOnly: opts.binaryOnly, forceBinary: opts.forceBinary })) failed.push(target.name);
  }

  if (failed.length > 0) {
    p.outro(`Completed with errors. Failed: ${failed.join(', ')}`);
    process.exitCode = 1;
  } else {
    p.outro(targets.length > 1 ? `All ${targets.length} indexes rebuilt.` : 'Done.');
  }
}
