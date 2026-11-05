/**
 * What an update of the models we depend on does to OUR code.
 *
 *   npm run upgrade-impact -- --from <metadataDirOld> --to <metadataDirNew> --models <ours>
 *       [--ours <metadataDirWithOurSource>] [--deps <mask>] [--out report.md] [--json report.json]
 *
 * Platform update (Microsoft models of an old and a new PackagesLocalDirectory):
 *
 *   npm run upgrade-impact -- --platform-upgrade --from-pld <PLD> --to-pld <PLD> --ours <dir> --models <ours>
 *       [--kernel-from <dir> --kernel-to <dir>] [--cache <dir>] [--out report.md] [--json report.json]
 *
 * `--from` and `--to` are extracted-metadata directories (see diff-metadata) of the dependency models at
 * the two versions; `--models` selects our models, whose source is read from `--ours` (default: `--from`).
 * `--models` and `--deps` take comma-separated names and masks: `Contoso*`, `ContosoApp_*,Fabrikam*`, `*,!ContosoDemo*`; a
 * mask matches the module name or the display name. Dependencies selected on only one side are listed,
 * not compared. With `--platform-upgrade` the two directories are cut out of the PLDs: only the Microsoft
 * objects our models name, and what they inherit from or are typed with (see src/metadata/platformSlice.ts).
 * The Markdown report goes to `--out`, or to stdout when it is omitted; the exit code is 1 when anything
 * will not compile. See src/metadata/upgradeImpact.ts for what is checked and how findings are classified.
 */
import '../src/bootstrapEnv.js';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../src/utils/terminalUi.js';
import { XppSymbolIndex } from '../src/metadata/symbolIndex.js';
import { isExactSpec, listModelNames, selectModels, selectOnBothSides } from '../src/metadata/modelSelector.js';
import { collectTokens, slicePld } from '../src/metadata/platformSlice.js';
import { loadModelSnapshot } from '../src/metadata/versionDiff.js';
import { referenceFindings } from '../src/tools/analysis/upgradeImpactReferences.js';
import {
  analyzeImpact,
  buildDependencyIndex,
  hasName,
  mergeFindings,
  renderImpactMarkdown,
} from '../src/metadata/upgradeImpact.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const modelsSpec = arg('--models');
const depsSpec = arg('--deps') ?? '*';
const platformUpgrade = process.argv.includes('--platform-upgrade');
if (
  !modelsSpec ||
  (platformUpgrade ? !arg('--from-pld') || !arg('--to-pld') || !arg('--ours') : !arg('--from') || !arg('--to'))
) {
  log.err(
    'usage: upgrade-impact --from <dir> --to <dir> --models <mask> [--ours <dir>] [--deps <mask>] [--out report.md] [--json report.json]\n' +
      '       upgrade-impact --platform-upgrade --from-pld <PLD> --to-pld <PLD> --ours <dir> --models <mask> [--cache <dir>] [--out report.md]',
  );
  process.exit(2);
}
const outFile = arg('--out');
const jsonFile = arg('--json');
const timings: Record<string, number> = {};
const timed = async <T>(label: string, work: () => Promise<T> | T): Promise<T> => {
  const start = Date.now();
  const result = await work();
  timings[label] = (Date.now() - start) / 1000;
  return result;
};

// Our models: masks resolved against the directory that holds their source.
const oursDir = arg('--ours') ?? (arg('--from') as string);
const available = listModelNames(oursDir);
const oursModels = selectModels(modelsSpec, available);
if (oursModels.length === 0 || (isExactSpec(modelsSpec) && oursModels.length < modelsSpec.split(',').length)) {
  log.err(
    `--models ${modelsSpec}: found ${oursModels.join(', ') || 'nothing'} in ${oursDir} (it holds ${available.map(m => m.name).join(', ')})`,
  );
  process.exit(1);
}
const ours = oursModels.map(m => loadModelSnapshot(oursDir, m));
const emptyOurs = ours.filter(s => s.classes.length + s.tables.length === 0).map(s => s.model);
if (emptyOurs.length) {
  log.err(`no extracted classes or tables for: ${emptyOurs.join(', ')} (looked in ${oursDir})`);
  process.exit(1);
}

/** Stock extract-metadata over a sliced packages tree (mode `all`: the cache directory is ours alone). */
function extractStock(packagesRoot: string, outDir: string): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', path.join(repoRoot, 'scripts', 'extract-metadata.ts')],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        D365FO_PACKAGE_PATH: packagesRoot,
        METADATA_PATH: outDir,
        EXTRACT_MODE: 'all',
        DEV_ENVIRONMENT_TYPE: 'traditional',
        NO_COLOR: '1',
      },
    },
  );
  if (r.status !== 0) {
    log.err(r.stdout?.split('\n').slice(-30).join('\n'));
    log.err(r.stderr);
    throw new Error(`extract-metadata over ${packagesRoot} failed (exit ${r.status})`);
  }
}

let fromDir = arg('--from') as string;
let toDir = arg('--to') as string;
let fromLabel = fromDir;
let toLabel = toDir;
if (platformUpgrade) {
  const fromPld = arg('--from-pld') as string;
  const toPld = arg('--to-pld') as string;
  const cache = arg('--cache') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-impact-'));
  const tokens = await timed('tokens', () => collectTokens(oursDir, oursModels));
  const skip = new Set(oursModels.map(m => m.toLowerCase()));
  for (const [side, pld] of [
    ['from', fromPld],
    ['to', toPld],
  ] as const) {
    const root = path.join(cache, `pld-${side}`);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(cache, side), { recursive: true, force: true });
    const slice = await timed(`slice ${side}`, () => slicePld(pld, tokens, root, skip));
    log.detail(`${side}: ${slice.files} objects (${slice.matched} named by our code) in ${slice.models.length} models`);
    await timed(`extract ${side}`, () => extractStock(root, path.join(cache, side)));
    // The platform kernel (Common, xRecord, Object, ...) has no XML in a PLD: it comes from `BinaryModelExtractor --kernel`.
    const kernelDir = arg(`--kernel-${side}`);
    if (kernelDir) fs.cpSync(path.join(kernelDir, 'Kernel'), path.join(cache, side, 'Kernel'), { recursive: true });
    else
      log.warn(
        `no --kernel-${side}: methods inherited from Common/xRecord/Object cannot be resolved, such findings are only listed as affected`,
      );
  }
  fromDir = path.join(cache, 'from');
  toDir = path.join(cache, 'to');
  fromLabel = fromPld;
  toLabel = toPld;
}

const sides = selectOnBothSides(depsSpec, listModelNames(fromDir), listModelNames(toDir), oursModels);
if (sides.both.length === 0) {
  log.err(`--deps ${depsSpec}: no dependency model is selected in both ${fromDir} and ${toDir}`);
  process.exit(1);
}

let report = await timed('analysis', () =>
  analyzeImpact({
    from: fromLabel,
    to: toLabel,
    fromDeps: sides.both.map(m => loadModelSnapshot(fromDir, m)),
    toDeps: sides.both.map(m => loadModelSnapshot(toDir, m)),
    ours,
    notCompared: { onlyInFrom: sides.onlyInFrom, onlyInTo: sides.onlyInTo },
  }),
);

// Reference layer: the same resolver validate_code(mode="references") uses, against both versions.
report = await timed('references', async () => {
  const quiet = { onProgress: () => {} };
  const oldIndex = new XppSymbolIndex(':memory:', ':memory:');
  const newIndex = new XppSymbolIndex(':memory:', ':memory:');
  await oldIndex.indexMetadataDirectory(fromDir, sides.both, quiet);
  await newIndex.indexMetadataDirectory(toDir, sides.both, quiet);
  for (const index of [oldIndex, newIndex]) await index.indexMetadataDirectory(oursDir, oursModels, quiet);
  const before = buildDependencyIndex(sides.both.map(m => loadModelSnapshot(fromDir, m)));
  return mergeFindings(
    report,
    referenceFindings(ours, oldIndex, newIndex, name => hasName(before, name)),
  );
});
report.selection = { models: modelsSpec, deps: depsSpec, depsSides: sides };
report.timings = timings;

const markdown = renderImpactMarkdown(report);
if (outFile) fs.writeFileSync(outFile, markdown);
else process.stdout.write(`${markdown}\n`);
if (jsonFile) fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2));
if (outFile)
  log.ok(`${report.totals.error} error(s), ${report.totals.behaviour} behaviour, ${report.totals.warning} warning(s)`);
process.exit(report.totals.error > 0 ? 1 : 0);
