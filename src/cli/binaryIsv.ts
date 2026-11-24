/**
 * Binary ISV models in the CLI (docs/BINARY_ISV_MODELS.md).
 *
 * An ISV that ships a model as compiled output only (bin\*.dll, no AxClass/
 * AxTable XML) is invisible to extract-metadata. The repo has had the two tools
 * that index it signatures-only — BinaryModelExtractor (C#, Windows) and the
 * extract-binary-models import — but only as manual steps from a checkout, and
 * a full rebuild (`extractMode: all`) wiped what they wrote. Here they become a
 * step of `d365fo-mcp index`, configured by two settings:
 *
 *   index.binaryIsvModels   — masks of the models to dump from the packages path
 *   index.binaryIsvDumpPath — a dump made elsewhere, imported as it is
 *
 * The step runs after extract-metadata and before build-database, which is the
 * only order in which a full rebuild keeps the models.
 */
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { settingByPath, type Setting } from '../config/settings.js';
import { hashBridgeSources } from './bridgeSources.js';
import { installMode, isWindows, paths, repoRoot } from './context.js';
import { commandExists, runExe, runNode } from './exec.js';
import { readPath, readSetting, readSettingOrDefault, writeSetting, type SettingsStore } from './settingsStore.js';
import { targetEnv, type Target } from './target.js';
import { askMultiSelect, p } from './ui.js';

const setting = (path: string): Setting => {
  const found = settingByPath(path);
  if (!found) throw new Error(`Unknown setting: ${path}`);
  return found;
};

/** Package subfolders that never hold object XML, skipped by the source probe. */
const NON_MODEL_DIRS = new Set([
  'bin', 'descriptor', 'resources', 'xppmetadata', 'reports', 'webcontent', 'additionalfiles', 'bpextensions',
]);

/** A compiled module assembly: `Dynamics.AX.<Module>.dll` (or a .netmodule of one). */
const MODULE_ASSEMBLY = /^Dynamics\.AX\..+\.(dll|netmodule)$/i;

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

/**
 * Packages under `packagesPath` that ship compiled output and no object XML.
 *
 * A package is binary-only when its bin\ holds a module assembly and none of
 * its model folders contains an `Ax*` object folder. bin\ is looked at first
 * because it is the cheap test that rules out the folders that are no package
 * at all; the model folders are walked only for what passes it.
 */
export interface BinaryOnlyPackage {
  name: string;
  /** `<Publisher>` of the package's model descriptor, '' when unreadable. */
  publisher: string;
}

/** Publisher named by the first model descriptor of a package that has one. */
function descriptorPublisher(pkgDir: string): string {
  const dir = join(pkgDir, 'Descriptor');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.xml'));
  } catch {
    return '';
  }
  for (const f of files) {
    try {
      const m = /<Publisher>([^<]*)<\/Publisher>/.exec(fs.readFileSync(join(dir, f), 'utf-8'));
      if (m?.[1]?.trim()) return m[1].trim();
    } catch {
      // next descriptor
    }
  }
  return '';
}

export function findBinaryOnlyPackages(packagesPath: string): BinaryOnlyPackage[] {
  const found: BinaryOnlyPackage[] = [];
  for (const pkg of listDirs(packagesPath)) {
    if (NON_MODEL_DIRS.has(pkg.toLowerCase())) continue;
    const pkgDir = join(packagesPath, pkg);
    let assemblies: string[];
    try {
      assemblies = fs.readdirSync(join(pkgDir, 'bin')).filter(f => MODULE_ASSEMBLY.test(f));
    } catch {
      continue;
    }
    if (assemblies.length === 0) continue;
    const hasSource = listDirs(pkgDir)
      .filter(sub => !NON_MODEL_DIRS.has(sub.toLowerCase()))
      .some(sub => listDirs(join(pkgDir, sub)).some(d => /^Ax[A-Z]/.test(d)));
    if (!hasSource) found.push({ name: pkg, publisher: descriptorPublisher(pkgDir) });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Microsoft's own compiled-only packages are platform, not ISV: offered, never preselected. */
export function isMicrosoftPublisher(publisher: string): boolean {
  return /^Microsoft\b/i.test(publisher);
}

/** What the target asks for: models to dump here, or a dump made elsewhere. */
export interface BinaryIsvConfig {
  models: string[];
  dumpPath: string | null;
}

export function binaryIsvConfig(target: Target): BinaryIsvConfig | null {
  // The real environment outranks the config file, as it does for every script.
  const raw = process.env.BINARY_ISV_MODELS ?? readSetting(target.store, setting('index.binaryIsvModels'));
  const models = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [])
    .map(m => String(m).trim())
    .filter(Boolean);
  const dumpSetting = setting('index.binaryIsvDumpPath');
  const envDump = process.env.BINARY_ISV_DUMP_PATH?.trim();
  const dumpPath = envDump
    ? resolve(envDump)
    : readSetting(target.store, dumpSetting) ? readPath(target.store, dumpSetting, '') : null;
  if (models.length === 0 && !dumpPath) return null;
  return { models, dumpPath };
}

/** Stamp written next to the extractor: what it was compiled from, and against. */
const EXTRACTOR_STAMP = 'BinaryModelExtractor.stamp.json';

interface ExtractorStamp {
  sourceHash: string;
  /** Size and mtime of the platform's metadata assembly the build referenced. */
  platform: string;
}

function platformFingerprint(binPath: string): string {
  try {
    const st = fs.statSync(join(binPath, 'Microsoft.Dynamics.AX.Metadata.dll'));
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return '';
  }
}

/**
 * Whether the extractor must be (re)built before it can read `binPath`.
 *
 * Two reasons beyond "missing": an update changed its sources, or the platform
 * was upgraded under it. The second matters as much as for the bridge — every
 * platform build stamps assembly version 7.0.0.0, so an extractor compiled for
 * another build loads without complaint and fails later.
 */
export function extractorNeedsBuild(binPath: string, exe: string = paths.binaryExtractorExe): boolean {
  if (!fs.existsSync(exe)) return true;
  try {
    const stamp = JSON.parse(fs.readFileSync(join(resolve(exe, '..'), EXTRACTOR_STAMP), 'utf-8')) as ExtractorStamp;
    return stamp.sourceHash !== hashBridgeSources(paths.binaryExtractorDir, repoRoot) ||
      stamp.platform !== platformFingerprint(binPath);
  } catch {
    return true;
  }
}

/** The command that builds the extractor for this installation, for messages. */
export function extractorBuildCommand(binPath: string): string {
  return `dotnet build "${paths.binaryExtractorProject}" -c Release -p:D365BinPath="${binPath}" -o "${paths.binaryExtractorOutDir}"`;
}

async function ensureExtractor(binPath: string): Promise<boolean> {
  if (!extractorNeedsBuild(binPath)) return true;
  if (!await commandExists('dotnet')) {
    p.log.warn(
      'The .NET SDK is not on PATH, so BinaryModelExtractor cannot be built.\n' +
      '   Install it from https://dotnet.microsoft.com/download (the SDK, not just the runtime).',
    );
    return false;
  }
  p.log.step('Building BinaryModelExtractor (once per platform build)…');
  const code = await runExe('dotnet', [
    'build', paths.binaryExtractorProject, '-c', 'Release', `-p:D365BinPath=${binPath}`, '-o', paths.binaryExtractorOutDir,
  ], { cwd: paths.binaryExtractorDir });
  if (code !== 0) {
    p.log.error(`BinaryModelExtractor build failed. Command:\n   ${extractorBuildCommand(binPath)}`);
    return false;
  }
  const stamp: ExtractorStamp = {
    sourceHash: hashBridgeSources(paths.binaryExtractorDir, repoRoot),
    platform: platformFingerprint(binPath),
  };
  fs.writeFileSync(join(paths.binaryExtractorOutDir, EXTRACTOR_STAMP), JSON.stringify(stamp, null, 2));
  return true;
}

/** Where the target keeps its own dump: beside its config and index, never in the package. */
export function binaryDumpDir(target: Target, dataDir: string): string {
  return resolve(target.instance?.dir ?? dataDir, 'binary-isv-dump');
}

function labelLanguagesArg(target: Target): string {
  const raw = readSettingOrDefault(target.store, setting('index.labelLanguages'));
  const list = Array.isArray(raw) ? raw.map(String) : String(raw ?? 'en-US').split(',');
  return list.some(l => l.trim().toLowerCase() === 'all') ? 'all' : list.map(l => l.trim()).filter(Boolean).join(',');
}

export interface BinaryIsvResult {
  ok: boolean;
  /** Module names the import wrote, for scoping a custom build-database run. */
  models: string[];
  /** Why nothing was imported, when ok is false. */
  reason?: string;
}

/**
 * Dump (unless a prepared dump is configured) and import the binary ISV models
 * of `target` into its METADATA_PATH.
 */
export async function importBinaryIsvModels(
  target: Target,
  config: BinaryIsvConfig,
  opts: { dataDir: string; cwd: string; force?: boolean },
): Promise<BinaryIsvResult> {
  let dumpDir = config.dumpPath;
  if (!dumpDir) {
    if (!isWindows) {
      return { ok: false, models: [], reason: 'BinaryModelExtractor runs on Windows only — set index.binaryIsvDumpPath to a dump made on a Windows machine' };
    }
    const pkgRaw = readSetting(target.store, setting('environment.packagePath'));
    if (typeof pkgRaw !== 'string' || !pkgRaw) {
      return { ok: false, models: [], reason: 'environment.packagePath is not set (UDE: set index.binaryIsvDumpPath to a dump made with BinaryModelExtractor)' };
    }
    const packagesPath = resolve(pkgRaw);
    const binPath = join(packagesPath, 'bin');
    if (!fs.existsSync(join(binPath, 'Microsoft.Dynamics.AX.Metadata.dll'))) {
      return { ok: false, models: [], reason: `${binPath} has no platform assemblies to read the models with` };
    }
    if (!await ensureExtractor(binPath)) {
      return { ok: false, models: [], reason: 'BinaryModelExtractor could not be built' };
    }
    dumpDir = binaryDumpDir(target, opts.dataDir);
    // A fresh dump every time: a model dropped from the masks must not linger.
    fs.rmSync(dumpDir, { recursive: true, force: true });
    p.log.step(`Dumping binary ISV models (${config.models.join(', ')})…`);
    const code = await runExe(paths.binaryExtractorExe, [
      '--packages-path', packagesPath, '--out', dumpDir, '--models', config.models.join(','),
      '--languages', labelLanguagesArg(target),
    ], { cwd: opts.cwd });
    if (code !== 0) return { ok: false, models: [], reason: `BinaryModelExtractor exited with ${code}` };
  } else if (!fs.existsSync(dumpDir)) {
    return { ok: false, models: [], reason: `index.binaryIsvDumpPath ${dumpDir} does not exist` };
  }

  const report = join(opts.cwd, '.binary-isv-import.json');
  fs.rmSync(report, { force: true });
  p.log.step('Importing binary ISV models (signatures only)…');
  const script = installMode === 'git'
    ? ['--import', 'tsx/esm', paths.binaryImportScript]
    : [paths.binaryImportScriptDist];
  const args = [...script, dumpDir, '--report', report, ...(opts.force ? ['--force'] : [])];
  const code = await runNode(args, { cwd: opts.cwd, env: targetEnv(target) });
  if (code !== 0) {
    return { ok: false, models: [], reason: `the import exited with ${code}${opts.force ? '' : ' (a platform mismatch is overridden with --force-binary)'}` };
  }
  let models: string[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(report, 'utf-8')) as { models?: unknown };
    if (Array.isArray(parsed.models)) models = parsed.models.filter((m): m is string => typeof m === 'string');
  } catch {
    // An import that exits 0 always writes the report; without it, scope nothing.
  } finally {
    fs.rmSync(report, { force: true });
  }
  return { ok: true, models };
}

/**
 * The setup question: offer the compiled-only packages found in the packages
 * path and record the chosen ones in index.binaryIsvModels.
 *
 * Asked only when there is something to answer — a packages path holding such
 * packages, or a value already configured — so the wizard stays as short as it
 * was for the machines (most of them) that have no binary ISV. Masks already in
 * the setting that do not name a found package (`ContosoIsv*`, a model
 * imported from a prepared dump) are kept as they are.
 */
export async function askBinaryIsvModels(store: SettingsStore): Promise<void> {
  if (!isWindows) return;
  const s = setting('index.binaryIsvModels');
  const raw = readSetting(store, s);
  const current = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [])
    .map(m => String(m).trim())
    .filter(Boolean);
  const pkgRaw = readSetting(store, setting('environment.packagePath'));
  const found = typeof pkgRaw === 'string' && pkgRaw ? findBinaryOnlyPackages(resolve(pkgRaw)) : [];
  if (found.length === 0) {
    if (current.length > 0) p.log.info(`Binary ISV models (signatures only): ${current.join(', ')}`);
    return;
  }
  const lower = new Set(current.map(c => c.toLowerCase()));
  const initial = found
    .filter(f => lower.has(f.name.toLowerCase()) || (current.length === 0 && !isMicrosoftPublisher(f.publisher)))
    .map(f => f.name);
  const picked = await askMultiSelect(
    `${found.length} package(s) ship compiled output only, without X++ source. Index them signatures-only?\n` +
    '  Their classes, tables, forms, security and labels become searchable; method bodies stay unknown ' +
    '(docs/BINARY_ISV_MODELS.md). Needs the .NET SDK.',
    found.map(f => ({ value: f.name, label: f.name, hint: f.publisher || undefined })),
    initial,
  );
  const foundLower = new Set(found.map(f => f.name.toLowerCase()));
  const kept = current.filter(c => !foundLower.has(c.toLowerCase()));
  const value = [...kept, ...picked];
  writeSetting(store, s, value.length > 0 ? value : undefined);
}
