/**
 * Binary ISV model import.
 *
 * Step 1 (Windows, D365FO platform bin available):
 *   BinaryModelExtractor.exe --packages-path <PackagesLocalDirectory> --out <dumpDir> [--models A,B] [--languages en-US,cs|all]
 * Step 2 (any OS):
 *   npm run extract-binary-models -- <dumpDir> [--out <metadataDir>] [--force]
 *
 * Writes <metadataDir>/<Module>/... in the shapes `build-database` already indexes:
 *   - classes, class-extensions, tables, EDTs, enums from the dump JSON (signatures only; src/metadata/binaryModelImport.ts)
 *   - forms, queries, views, data entities, maps, menu items, security, extensions, services from the AOT XML
 *     the extractor serialized (`<dumpDir>/aot`), parsed by the stock `extract-metadata` unchanged
 *   - label texts under <Module>/AxLabelFile (indexed by build-database)
 * and records the model in the extract manifest as non-Microsoft (never mined for property stats).
 * Refuses to import a model whose references mostly do not resolve against the platform it was read with
 * (built for another application version) unless --force is given.
 */
import '../src/bootstrapEnv.js';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { log } from '../src/utils/terminalUi.js';
import {
  binaryIsvInfo,
  checkBinaryCompat,
  KERNEL_MODEL,
  convertBinaryModel,
  sourcePathFor,
  type BinaryModelDump,
} from '../src/metadata/binaryModelImport.js';
import {
  EXTRACT_MANIFEST_FILENAME,
  writeExtractManifest,
  readExtractedCustomModels,
} from '../src/utils/extractManifest.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dumpDir = process.argv
  .slice(2)
  .find(a => !a.startsWith('--') && process.argv[process.argv.indexOf(a) - 1] !== '--out');
const outDir = arg('--out') || process.env.METADATA_PATH || './extracted-metadata';
const force = process.argv.includes('--force');
if (!dumpDir) {
  log.err('usage: extract-binary-models <dumpDir> [--out <metadataDir>] [--force]');
  process.exit(2);
}

function writeJson(dir: string, name: string, data: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2));
}

function loadDumps(): BinaryModelDump[] {
  const dumps: BinaryModelDump[] = [];
  for (const f of fs.readdirSync(dumpDir!).filter(n => n.endsWith('.binary.json'))) {
    const dump = JSON.parse(fs.readFileSync(path.join(dumpDir!, f), 'utf-8').replace(/^﻿/, '')) as BinaryModelDump;
    // No ModelInfo = objects the provider serves from StaticMetadata (kernel classes), not an ISV model.
    if (!dump.ModelInfo?.Module) {
      log.detail(`skip ${f}: no module info (platform static metadata)`);
      continue;
    }
    dumps.push(dump);
  }
  return dumps;
}

/** Stock extract-metadata over the synthetic AOT tree: forms, queries, views, entities, maps, menu items, security... */
function runStockExtraction(modules: string[], aotRoot: string): void {
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
        D365FO_PACKAGE_PATH: aotRoot,
        METADATA_PATH: path.resolve(outDir),
        EXTRACT_MODE: 'custom',
        CUSTOM_MODELS: modules.join(','),
        DEV_ENVIRONMENT_TYPE: 'traditional',
        NO_COLOR: '1',
      },
    },
  );
  if (r.status !== 0) {
    log.err(r.stdout?.split('\n').slice(-30).join('\n'));
    log.err(r.stderr);
    throw new Error(`extract-metadata over the binary AOT tree failed (exit ${r.status})`);
  }
  const stats = (r.stdout ?? '').split('\n').filter(l => /^\s{2}[A-Z][A-Za-z ()]+\s+\d+\s*$/.test(l));
  for (const l of stats) log.detail(l.trim());
}

/** Stamp every stock-extracted object with the binary-ISV info and a binary-isv:// source path (no temp dump path leaks). */
function stampStockOutput(base: string, info: ReturnType<typeof binaryIsvInfo>): number {
  const folderToAx: Record<string, string> = {
    forms: 'AxForm',
    queries: 'AxQuery',
    views: 'AxView',
    maps: 'AxMap',
    services: 'AxService',
    'service-groups': 'AxServiceGroup',
    'security-privileges': 'AxSecurityPrivilege',
    'security-duties': 'AxSecurityDuty',
    'security-roles': 'AxSecurityRole',
    'menu-item-displays': 'AxMenuItemDisplay',
    'menu-item-actions': 'AxMenuItemAction',
    'menu-item-outputs': 'AxMenuItemOutput',
    'configuration-keys': 'AxConfigurationKey',
  };
  let n = 0;
  for (const folder of fs.readdirSync(base, { withFileTypes: true })) {
    if (
      !folder.isDirectory() ||
      ['classes', 'class-extensions', 'tables', 'edts', 'enums', 'AxLabelFile'].includes(folder.name)
    )
      continue;
    for (const f of fs.readdirSync(path.join(base, folder.name)).filter(x => x.endsWith('.json'))) {
      const file = path.join(base, folder.name, f);
      const obj = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      const name = path.basename(f, '.json');
      obj.sourcePath = sourcePathFor(info, folderToAx[folder.name] ?? folder.name, name);
      obj.binaryIsv = info;
      fs.writeFileSync(file, JSON.stringify(obj, null, 2));
      n++;
    }
  }
  return n;
}

const dumps = loadDumps();
if (dumps.length === 0) {
  log.err('no model dumps found');
  process.exit(1);
}

// 1. Compatibility with the platform the models were read with.
let blocked = false;
for (const d of dumps) {
  const c = checkBinaryCompat(d);
  for (const m of c.messages) (c.level === 'ok' ? log.ok : c.level === 'warn' ? log.warn : log.err)(m);
  if (c.level === 'error' && !force) blocked = true;
}
if (blocked) {
  log.err('Refusing to import: re-extract with the platform build the ISV was compiled for, or pass --force.');
  process.exit(1);
}

// 2. Wipe, run the stock extraction for the AOT XML, then write the class/table/EDT/enum JSON.
fs.mkdirSync(outDir, { recursive: true });
const existingCustom = readExtractedCustomModels(outDir) ?? [];
const converted = dumps.map(d => ({ d, m: convertBinaryModel(d) }));
for (const { m } of converted) fs.rmSync(path.join(outDir, m.model), { recursive: true, force: true });

const aotRoot = path.resolve(dumpDir, 'aot');
const withAot = converted.map(x => x.m).filter(m => fs.existsSync(path.join(aotRoot, m.model)));
if (withAot.length) {
  // A model needs one of the marker folders to be walked at all; the class JSON is written by this script, not from XML.
  for (const m of withAot) fs.mkdirSync(path.join(aotRoot, m.model, m.model, 'AxClass'), { recursive: true });
  log.step('AOT objects (forms, queries, views, entities, maps, menu items, security) via extract-metadata');
  runStockExtraction(
    withAot.map(m => m.model),
    aotRoot,
  );
}

const models: string[] = [];
let classes = 0,
  methods = 0,
  tables = 0,
  edts = 0,
  enums = 0,
  stamped = 0,
  labels = 0;
for (const { d, m } of converted) {
  const base = path.join(outDir, m.model);
  for (const c of m.classes) writeJson(path.join(base, 'classes'), String(c.name), c);
  for (const c of m.classExtensions) writeJson(path.join(base, 'class-extensions'), c.name, c);
  for (const t of m.tables) writeJson(path.join(base, 'tables'), String(t.name), t);
  for (const e of m.edts) writeJson(path.join(base, 'edts'), String(e.name), e);
  for (const e of m.enums) writeJson(path.join(base, 'enums'), String(e.name), e);
  if (fs.existsSync(base)) stamped += stampStockOutput(base, m.info);
  // Label texts: build-database indexes <metadataDir>/<Module>/AxLabelFile/LabelResources/<lang>/*.label.txt
  const labelSrc = path.join(aotRoot, m.model, m.model, 'AxLabelFile');
  if (fs.existsSync(labelSrc)) {
    fs.cpSync(labelSrc, path.join(base, 'AxLabelFile'), { recursive: true });
    labels += Object.values(d.Labels ?? {}).reduce((a, b) => a + b, 0);
  }
  // The platform kernel (StaticMetadata) is Microsoft metadata, not a custom model.
  if (m.model !== KERNEL_MODEL) models.push(m.model);
  classes += m.classes.length;
  tables += m.tables.length;
  edts += m.edts.length;
  enums += m.enums.length;
  methods += m.classes.reduce((n, c) => n + (c.methods as unknown[]).length, 0);
  const coc = m.classExtensions.filter(c => (c.cocMethods ?? []).length).length;
  log.ok(
    `${m.model} (${m.info.vendor} ${m.info.version}): classes=${m.classes.length} extensions=${m.classExtensions.length} (CoC ${coc}) tables=${m.tables.length} edts=${m.edts.length} enums=${m.enums.length}`,
  );
}

// Record as non-Microsoft in the extract manifest (merge with what was there before the stock run rewrote it).
writeExtractManifest(outDir, {
  generatedAt: new Date().toISOString(),
  extractMode: 'all',
  environment: 'traditional',
  customModels: [...new Set([...existingCustom, ...models])],
});
log.ok(
  `done: ${models.length} model(s), ${classes} classes, ${methods} methods, ${tables} tables, ${edts} EDTs, ${enums} enums, ${stamped} AOT objects, ${labels} label texts -> ${path.resolve(outDir)} (${EXTRACT_MANIFEST_FILENAME} updated)`,
);
