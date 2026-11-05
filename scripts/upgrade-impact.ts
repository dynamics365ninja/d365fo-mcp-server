/**
 * What an update of the models we depend on does to OUR code.
 *
 *   npm run upgrade-impact -- --from <metadataDirOld> --to <metadataDirNew> --models <ours>
 *       [--ours <metadataDirWithOurSource>] [--deps A,B] [--out report.md] [--json report.json]
 *
 * `--from` and `--to` are extracted-metadata directories (see diff-metadata) of the dependency
 * models at the two versions; `--models` names our models, whose source is read from `--ours`
 * (default: `--from`). Models present in only one of the two directories are listed, not compared.
 * The Markdown report goes to `--out`, or to stdout when it is omitted.
 * See src/metadata/upgradeImpact.ts for what is checked and how findings are classified.
 */
import '../src/bootstrapEnv.js';
import * as fs from 'fs';
import { log } from '../src/utils/terminalUi.js';
import { referenceFindings } from '../src/tools/analysis/upgradeImpactReferences.js';
import { XppSymbolIndex } from '../src/metadata/symbolIndex.js';
import { listModels, loadModelSnapshot } from '../src/metadata/versionDiff.js';
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

const list = (name: string): string[] | undefined =>
  arg(name)
    ?.split(',')
    .map(m => m.trim())
    .filter(Boolean);

const fromDir = arg('--from');
const toDir = arg('--to');
const oursModels = list('--models');
if (!fromDir || !toDir || !oursModels?.length) {
  log.err(
    'usage: upgrade-impact --from <dir> --to <dir> --models <ours> [--ours <dir>] [--deps A,B] [--out report.md] [--json report.json]',
  );
  process.exit(2);
}
const oursDir = arg('--ours') ?? fromDir;
const wantedDeps = list('--deps');
const outFile = arg('--out');
const jsonFile = arg('--json');

const ours = oursModels.map(m => loadModelSnapshot(oursDir, m));
const emptyOurs = ours.filter(s => s.classes.length + s.tables.length === 0).map(s => s.model);
if (emptyOurs.length) {
  log.err(`no extracted classes or tables for: ${emptyOurs.join(', ')} (looked in ${oursDir})`);
  process.exit(1);
}

const isDep = (m: string): boolean => !oursModels.includes(m) && (!wantedDeps || wantedDeps.includes(m));
const inFrom = listModels(fromDir).filter(isDep);
const inTo = listModels(toDir).filter(isDep);
const depModels = inFrom.filter(m => inTo.includes(m)).sort();
if (depModels.length === 0) {
  log.err('no dependency model is present in both directories');
  process.exit(1);
}

let report = analyzeImpact({
  from: fromDir,
  to: toDir,
  fromDeps: depModels.map(m => loadModelSnapshot(fromDir, m)),
  toDeps: depModels.map(m => loadModelSnapshot(toDir, m)),
  ours,
  notCompared: { onlyInFrom: inFrom.filter(m => !inTo.includes(m)), onlyInTo: inTo.filter(m => !inFrom.includes(m)) },
});

// Reference layer: the same resolver validate_code(mode="references") uses, against both versions.
const quiet = { onProgress: () => {} };
const oldIndex = new XppSymbolIndex(':memory:', ':memory:');
const newIndex = new XppSymbolIndex(':memory:', ':memory:');
await oldIndex.indexMetadataDirectory(fromDir, depModels, quiet);
await newIndex.indexMetadataDirectory(toDir, depModels, quiet);
for (const index of [oldIndex, newIndex]) await index.indexMetadataDirectory(oursDir, oursModels, quiet);
const before = buildDependencyIndex(depModels.map(m => loadModelSnapshot(fromDir, m)));
report = mergeFindings(
  report,
  referenceFindings(ours, oldIndex, newIndex, name => hasName(before, name)),
);

const markdown = renderImpactMarkdown(report);
if (outFile) fs.writeFileSync(outFile, markdown);
else process.stdout.write(`${markdown}\n`);
if (jsonFile) fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2));
if (outFile)
  log.ok(`${report.totals.error} error(s), ${report.totals.behaviour} behaviour, ${report.totals.warning} warning(s)`);
process.exit(report.totals.error > 0 ? 1 : 0);
