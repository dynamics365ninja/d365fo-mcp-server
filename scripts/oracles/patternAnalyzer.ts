/**
 * The form pattern ORACLE: the platform's own PatternAnalyzer, the code the X++
 * compiler runs to validate a form against its pattern.
 *
 * Our validator (src/validation/platformPatternMatcher.ts) re-implements that
 * engine in TypeScript so it runs anywhere, including Linux CI. This script is how
 * the re-implementation is held to the original:
 *
 *   npx tsx scripts/oracles/patternAnalyzer.ts verdicts
 *       Run the engine over tests/fixtures/formPatterns/*.xml and write
 *       tests/fixtures/formPatterns/platform-verdicts.json. The unit test
 *       tests/validation/platformPatternMatcher.test.ts asserts our validator
 *       agrees with every verdict in that file, so CI checks against the engine
 *       without needing a D365FO install.
 *
 *   npx tsx scripts/oracles/patternAnalyzer.ts analyze [--store <root>] [Form ...]
 *       JSONL verdicts for forms in a metadata store (default: PackagesLocalDirectory).
 *
 *   npx tsx scripts/oracles/patternAnalyzer.ts defaults
 *       Metamodel default values of every property a pattern definition names,
 *       per control type (used by scripts/capture-form-pattern-definitions.ts).
 *
 * Windows only: it compiles PatternAnalyzerProbe.cs with the .NET Framework csc
 * that ships with Windows, against the DLLs in PackagesLocalDirectory/bin. It
 * reads those DLLs and never writes anywhere under PackagesLocalDirectory.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
export const FIXTURE_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'formPatterns');
export const VERDICTS_FILE = path.join(FIXTURE_DIR, 'platform-verdicts.json');

export function packagesRoot(): string {
  if (process.env.PACKAGES_ROOT) return process.env.PACKAGES_ROOT;
  const current = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Dynamics365', 'Current', 'PackagesLocalDirectory');
  if (fs.existsSync(current)) return current;
  return 'K:/AosService/PackagesLocalDirectory';
}

const REFERENCES = [
  'Microsoft.Dynamics.AX.Metadata.dll',
  'Microsoft.Dynamics.AX.Metadata.Core.dll',
  'Microsoft.Dynamics.AX.Metadata.Patterns.dll',
  'Microsoft.Dynamics.AX.Metadata.Storage.dll',
];

/** Compile the probe once per process into the temp folder; returns the exe path. */
export function buildProbe(root = packagesRoot()): string {
  const bin = path.join(root, 'bin');
  const windir = process.env.WINDIR ?? 'C:\\Windows';
  const csc = path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!fs.existsSync(csc)) throw new Error(`csc.exe not found at ${csc} (this oracle needs Windows)`);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pattern-analyzer-probe-'));
  const exe = path.join(outDir, 'PatternAnalyzerProbe.exe');
  execFileSync(csc, [
    '-nologo', '-nowarn:1701,1702', `-out:${exe}`,
    ...REFERENCES.map((r) => `-r:${path.join(bin, r)}`),
    path.join(HERE, 'patternAnalyzer', 'PatternAnalyzerProbe.cs'),
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  return exe;
}

export interface Verdict {
  form: string;
  path: string;
  pattern: string;
  version: string;
  resolved: string | null;
  /** null = the platform has no definition for this name and version */
  ok: boolean | null;
  detail: string;
}

export function analyze(exe: string, store: string, forms: string[], root = packagesRoot()): Verdict[] {
  const out = execFileSync(exe, ['analyze', path.join(root, 'bin'), store, ...forms], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 512,
  });
  return out.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Verdict);
}

export function defaults(exe: string, properties: string[], root = packagesRoot()): Record<string, Record<string, string>> {
  const out = execFileSync(exe, ['defaults', path.join(root, 'bin'), properties.join(',')], { encoding: 'utf8' });
  return JSON.parse(out);
}

const DESCRIPTOR = `<?xml version="1.0" encoding="utf-8"?>
<AxModelInfo xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Customization>Allow</Customization>
  <DisplayName>FormPatternFixtures</DisplayName>
  <Id>896000001</Id>
  <Layer>14</Layer>
  <ModelModule>FormPatternFixtures</ModelModule>
  <ModuleReferences xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays" />
  <Name>FormPatternFixtures</Name>
  <Publisher>d365fo-mcp-server tests</Publisher>
  <VersionBuild>0</VersionBuild>
  <VersionMajor>1</VersionMajor>
  <VersionMinor>0</VersionMinor>
  <VersionRevision>0</VersionRevision>
</AxModelInfo>
`;

/** Lay the fixture forms out as a one-model metadata store in a temp folder. */
export function fixtureStore(): { store: string; forms: string[] } {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'form-pattern-fixtures-'));
  const pkg = path.join(store, 'FormPatternFixtures');
  fs.mkdirSync(path.join(pkg, 'Descriptor'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'FormPatternFixtures', 'AxForm'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'Descriptor', 'FormPatternFixtures.xml'), DESCRIPTOR);
  const forms: string[] = [];
  for (const f of fs.readdirSync(FIXTURE_DIR).filter((n) => n.endsWith('.xml')).sort()) {
    fs.copyFileSync(path.join(FIXTURE_DIR, f), path.join(pkg, 'FormPatternFixtures', 'AxForm', f));
    forms.push(f.replace(/\.xml$/, ''));
  }
  return { store, forms };
}

function main(): void {
  const [mode, ...rest] = process.argv.slice(2);
  const root = packagesRoot();
  if (mode === 'verdicts') {
    const exe = buildProbe(root);
    const { store, forms } = fixtureStore();
    const verdicts = analyze(exe, store, forms, root).map((v) => ({
      form: v.form, path: v.path, pattern: v.pattern, version: v.version, ok: v.ok, detail: v.detail,
    }));
    fs.rmSync(store, { recursive: true, force: true });
    const missing = forms.filter((f) => !verdicts.some((v) => v.form === f));
    if (missing.length > 0) throw new Error(`The engine returned nothing for: ${missing.join(', ')}`);
    const dll = path.join(root, 'bin', 'Microsoft.Dynamics.AX.Metadata.Patterns.dll');
    const dllVersion = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', `(Get-Item '${dll.replace(/'/g, "''")}').VersionInfo.FileVersion`,
    ], { encoding: 'utf8' }).trim();
    fs.writeFileSync(VERDICTS_FILE, JSON.stringify({
      source: `PatternAnalyzer in Microsoft.Dynamics.AX.Metadata.Patterns.dll ${dllVersion}`,
      note: 'Generated by scripts/oracles/patternAnalyzer.ts verdicts. ok=null means the platform has no definition for that pattern name and version.',
      verdicts,
    }, null, 2) + '\n');
    console.log(`Wrote ${verdicts.length} verdicts for ${forms.length} fixture forms to ${path.relative(REPO_ROOT, VERDICTS_FILE)}`);
    return;
  }
  if (mode === 'analyze') {
    let store = root;
    const forms: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--store') store = rest[++i];
      else forms.push(rest[i]);
    }
    const exe = buildProbe(root);
    for (const v of analyze(exe, store, forms, root)) console.log(JSON.stringify(v));
    return;
  }
  if (mode === 'defaults') {
    const exe = buildProbe(root);
    console.log(JSON.stringify(defaults(exe, rest.length ? rest : ['Width', 'Height'], root), null, 1));
    return;
  }
  console.error('usage: patternAnalyzer.ts verdicts | analyze [--store <root>] [Form ...] | defaults [Prop ...]');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
