/**
 * API changes between two versions of the same models.
 *
 *   npm run diff-metadata -- <metadataDirFrom> <metadataDirTo> [--models <mask>] [--json out.json] [--examples 5]
 *
 * Both directories are extracted-metadata outputs (`extract-metadata`, or `extract-binary-models` for
 * models shipped without source). `--models` takes names and masks (`Contoso*,!ContosoDemo*`). Models selected in both are compared; the others are listed.
 * See src/metadata/versionDiff.ts for what counts as a change.
 */
import '../src/bootstrapEnv.js';
import * as fs from 'fs';
import { listModelNames, selectOnBothSides } from '../src/metadata/modelSelector.js';
import { log } from '../src/utils/terminalUi.js';
import { diffSnapshots, isEmptyDiff, loadModelSnapshot, type ModelDiff } from '../src/metadata/versionDiff.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const valueFlags = new Set(['--models', '--json', '--examples']);
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !valueFlags.has(all[i - 1]));
const [fromDir, toDir] = positional;
if (!fromDir || !toDir) {
  log.err('usage: diff-metadata <metadataDirFrom> <metadataDirTo> [--models <mask>] [--json out.json] [--examples N]');
  process.exit(2);
}
const jsonOut = arg('--json');
const examples = Number(arg('--examples') ?? 5);

const sides = selectOnBothSides(arg('--models'), listModelNames(fromDir), listModelNames(toDir));
const models = sides.both;
for (const m of sides.onlyInTo) log.info(`${m}: only in ${toDir}`);
for (const m of sides.onlyInFrom) log.info(`${m}: only in ${fromDir}`);
if (models.length === 0) {
  log.err('no model is present in both directories');
  process.exit(1);
}

const diffs: ModelDiff[] = models.map(m => diffSnapshots(loadModelSnapshot(fromDir, m), loadModelSnapshot(toDir, m)));

const count = (xs: unknown[]): string => String(xs.length);
for (const d of diffs) {
  if (isEmptyDiff(d)) {
    log.ok(`${d.model}: no API changes`);
    continue;
  }
  log.step(d.model);
  const line = (label: string, xs: unknown[]): void => {
    if (xs.length) log.detail(`${label}: ${count(xs)}`);
  };
  line('classes added', d.classesAdded);
  line('classes removed', d.classesRemoved);
  line('class headers changed', d.classesChanged);
  line('methods added', d.methodsAdded);
  line('methods removed', d.methodsRemoved);
  line('method signatures changed', d.methodsChanged);
  line('newly obsolete', d.newlyObsolete);
  line('tables added', d.tablesAdded);
  line('tables removed', d.tablesRemoved);
  line('fields added', d.fieldsAdded);
  line('fields removed', d.fieldsRemoved);
  line('fields changed', d.fieldsChanged);
  line('EDTs added', d.edtsAdded);
  line('EDTs removed', d.edtsRemoved);
  line('EDTs changed', d.edtsChanged);
  line('enums added', d.enumsAdded);
  line('enums removed', d.enumsRemoved);
  line('enum values added', d.enumValuesAdded);
  line('enum values removed', d.enumValuesRemoved);
  for (const c of d.methodsChanged.slice(0, examples)) {
    log.detail(`~ ${c.class}.${c.method}`);
    log.detail(`    - ${c.before}`);
    log.detail(`    + ${c.after}`);
  }
}

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(diffs, null, 2));
