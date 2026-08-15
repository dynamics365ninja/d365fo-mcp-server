/**
 * ensureBpCatalogFresh (src/cli/commands/bpCatalog.ts) — regenerates a
 * target's BP moniker catalog only when its resolved D365FO version has
 * moved since the catalog was last stamped, including "never generated"
 * (first-time instance creation). Every other call must be a cheap no-op:
 * no subprocess, no write.
 *
 * Exercised against a traditional environment, where the version key is the
 * packages root's bin\ folder mtime — no XPP config fixture needed.
 * commandExists/runExe are injected directly (see BpCatalogDeps) rather than
 * mocked, so these tests never spawn a real process.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ensureBpCatalogFresh, type BpCatalogDeps } from '../../src/cli/commands/bpCatalog.js';
import { openStore } from '../../src/cli/settingsStore.js';
import { writeConfigFile } from '../../src/config/configFile.js';
import type { Target } from '../../src/cli/target.js';

let root: string;
let packagesPath: string;
let binDir: string;
let originalLocalAppData: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'bp-catalog-target-'));
  packagesPath = join(root, 'packages');
  binDir = join(packagesPath, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  originalLocalAppData = process.env.LOCALAPPDATA;
});

afterEach(() => {
  // The UDE case repoints LOCALAPPDATA at a fixture; the real one must not stay
  // shadowed for whatever runs next in this file.
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
  fs.rmSync(root, { recursive: true, force: true });
});

function makeTarget(): Target {
  const configDir = join(root, 'instance');
  fs.mkdirSync(configDir, { recursive: true });
  writeConfigFile(join(configDir, 'd365fo-mcp.json'), {
    environment: { type: 'traditional', packagePath: packagesPath },
  });
  const store = openStore(configDir, null);
  return { name: 'test', label: "instance 'test'", envFile: null, store, port: null };
}

/**
 * A UDE target pinned to a config whose JSON cannot be parsed, so
 * listXppConfigs() lists it (by design) with no frameworkDirectory.
 */
function makeUdeTargetWithUnreadableConfig(): Target {
  const xppDir = join(root, 'LocalAppData', 'Microsoft', 'Dynamics365', 'XPPConfig');
  fs.mkdirSync(xppDir, { recursive: true });
  fs.writeFileSync(join(xppDir, 'contoso___10.0.2500.7.json'), '{ not json', 'utf-8');
  process.env.LOCALAPPDATA = join(root, 'LocalAppData');

  const configDir = join(root, 'ude-instance');
  fs.mkdirSync(configDir, { recursive: true });
  writeConfigFile(join(configDir, 'd365fo-mcp.json'), {
    environment: { type: 'ude', xppConfigName: 'contoso___10.0.2500.7' },
  });
  const store = openStore(configDir, null);
  return { name: 'ude', label: "instance 'ude'", envFile: null, store, port: null };
}

/**
 * A UDE target whose pin names a config that is GONE — what a UDE upgrade
 * leaves behind, and the state `instance upgrade` exists to repair. Another
 * config is present, so the box is unmistakably UDE.
 *
 * environment.packagePath is set deliberately: it gives the traditional
 * fall-through something real to extract from, so the assertion fails on the
 * unguarded code instead of passing for the wrong reason on Linux, where
 * findPackagesRoot() returns nothing anyway.
 */
function makeUdeTargetWithVanishedPin(): Target {
  const xppDir = join(root, 'LocalAppData', 'Microsoft', 'Dynamics365', 'XPPConfig');
  fs.mkdirSync(xppDir, { recursive: true });
  fs.writeFileSync(
    join(xppDir, 'contoso___10.0.2600.9.json'),
    JSON.stringify({ FrameworkDirectory: packagesPath }),
    'utf-8',
  );
  process.env.LOCALAPPDATA = join(root, 'LocalAppData');

  const configDir = join(root, 'ude-stale');
  fs.mkdirSync(configDir, { recursive: true });
  writeConfigFile(join(configDir, 'd365fo-mcp.json'), {
    environment: { type: 'ude', xppConfigName: 'contoso___10.0.2428.63', packagePath: packagesPath },
  });
  const store = openStore(configDir, null);
  return { name: 'ude-stale', label: "instance 'ude-stale'", envFile: null, store, port: null };
}

/** The value ensureBpCatalogFresh persisted into the instance config, if any. */
function readWrittenSetting(): unknown {
  const file = join(root, 'instance', 'd365fo-mcp.json');
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf-8')).index?.bpCatalogPath;
}

/** The catalog file this target's runs write to, once staging has moved it. */
function catalogFile(instanceDir = 'instance'): string {
  return join(root, instanceDir, 'data', 'bp-moniker-catalog.json');
}

/**
 * What a COMPLETE extraction looks like: both sources contributed (a canonical
 * moniker from an AxRuleSet, rule text from a DLL) and `sources` reports that
 * nothing was skipped. Measured shape — a healthy 214-model packages root
 * yields 144 BPRules.xml files and 25 rule DLLs with zero skips of either.
 */
function completeCatalog(version: string): string {
  return JSON.stringify({
    version,
    packagesPath,
    sources: { ruleSetFiles: 144, ruleSetFailures: 0, ruleDlls: 25, dllFailures: 0 },
    entries: [
      { moniker: 'BPErrorLabelIsText', message: 'Label is a text literal', description: null, canonical: true },
      { moniker: 'BPCheckNamingConventions', message: null, description: 'Naming', canonical: true },
    ],
  });
}

/**
 * Mirrors extract-bp-catalog.ps1's -OutFile branch: it creates the parent
 * directory itself (New-Item -Force) and always exits 0 — the script cannot
 * fail a run just because a scan came back partial, which is the whole reason
 * the caller has to inspect what was written.
 */
function writeExtraction(args: string[], body: (version: string) => string): number {
  const outFile = args[args.indexOf('-OutFile') + 1];
  fs.mkdirSync(join(outFile, '..'), { recursive: true });
  fs.writeFileSync(outFile, body(args[args.indexOf('-Version') + 1]), 'utf-8');
  return 0;
}

function fakeDeps(overrides: Partial<BpCatalogDeps> = {}): BpCatalogDeps {
  return {
    commandExists: async () => true,
    runExe: async (_cmd, args) => writeExtraction(args, completeCatalog),
    ...overrides,
  };
}

/** Deps whose extraction exits 0 but writes exactly `body`. */
function depsWriting(body: (version: string) => string): BpCatalogDeps {
  return { commandExists: async () => true, runExe: async (_cmd, args) => writeExtraction(args, body) };
}

describe('ensureBpCatalogFresh', () => {
  it('regenerates when no catalog exists yet (first-time creation)', async () => {
    const target = makeTarget();
    let calls = 0;
    await ensureBpCatalogFresh(target, fakeDeps({ runExe: async (...runArgs) => { calls++; return fakeDeps().runExe(...runArgs); } }));
    expect(calls).toBe(1);
    expect(fs.existsSync(join(root, 'instance', 'data', 'bp-moniker-catalog.json'))).toBe(true);
  });

  it('is a no-op on a second call when the version has not changed', async () => {
    const target = makeTarget();
    await ensureBpCatalogFresh(target, fakeDeps());

    let calls = 0;
    await ensureBpCatalogFresh(target, fakeDeps({ runExe: async (...runArgs) => { calls++; return fakeDeps().runExe(...runArgs); } }));
    expect(calls).toBe(0);
  });

  it('regenerates again once the packages root changes (bin\\ mtime moves)', async () => {
    const target = makeTarget();
    await ensureBpCatalogFresh(target, fakeDeps());

    // Simulate a platform update: something inside bin\ changes, moving its mtime.
    fs.writeFileSync(join(binDir, 'xppc.exe'), 'x');
    fs.utimesSync(binDir, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));

    let calls = 0;
    await ensureBpCatalogFresh(target, fakeDeps({ runExe: async (...runArgs) => { calls++; return fakeDeps().runExe(...runArgs); } }));
    expect(calls).toBe(1);
  });

  it('skips without throwing when neither pwsh nor powershell is on PATH', async () => {
    const target = makeTarget();
    let calls = 0;
    await ensureBpCatalogFresh(target, fakeDeps({
      commandExists: async () => false,
      runExe: async (...runArgs) => { calls++; return fakeDeps().runExe(...runArgs); },
    }));
    expect(calls).toBe(0);
    expect(fs.existsSync(join(root, 'instance', 'data', 'bp-moniker-catalog.json'))).toBe(false);
  });

  it('keeps the previous catalog and does not write the setting when extraction fails', async () => {
    const target = makeTarget();
    await ensureBpCatalogFresh(target, fakeDeps({ runExe: async () => 1 }));
    expect(fs.existsSync(join(root, 'instance', 'data', 'bp-moniker-catalog.json'))).toBe(false);
    expect(readWrittenSetting()).toBeUndefined();
  });

  it('records the catalog as a portable RELATIVE path, not the resolved absolute one', async () => {
    // index.bpCatalogPath has no registry default, so this write is what turns
    // the per-instance override on — and an absolute path baked into the
    // instance config would not survive the folder being renamed or moved,
    // which is the whole point of resolving path settings against baseDir.
    const target = makeTarget();
    await ensureBpCatalogFresh(target, fakeDeps());

    expect(readWrittenSetting()).toBe('./data/bp-moniker-catalog.json');
  });

  it('skips a UDE target whose pinned config carries no FrameworkDirectory', async () => {
    // listXppConfigs() deliberately keeps a config whose JSON could not be
    // read, so frameworkDirectory can legitimately be undefined. Passing '' on
    // to the script is not "use the default": its own -PackagesPath fallback
    // auto-detects the NEWEST PackagesLocalDirectory on the box, and the result
    // would then be stamped with this target's version and treated as current.
    const target = makeUdeTargetWithUnreadableConfig();
    let calls = 0;
    await ensureBpCatalogFresh(target, fakeDeps({ runExe: async (...runArgs) => { calls++; return fakeDeps().runExe(...runArgs); } }));

    expect(calls).toBe(0);
  });

  it('skips a UDE target whose pin is gone instead of extracting from another install on the box', async () => {
    // resolvePinnedXppConfig returns null for three different reasons, and only
    // one of them ("this is a traditional install") makes the box-wide packages
    // scan the right answer. A pin left dangling by a UDE upgrade is another,
    // and falling through there hands back whichever PackagesLocalDirectory
    // findPackagesRoot() ranks highest — then stamps its catalog with THIS
    // target's version key, so it is never revisited. That is the same
    // wrong-install swap the empty-FrameworkDirectory branch already refuses.
    const target = makeUdeTargetWithVanishedPin();
    let calls = 0;
    await ensureBpCatalogFresh(target, fakeDeps({ runExe: async (...runArgs) => { calls++; return fakeDeps().runExe(...runArgs); } }));

    expect(calls).toBe(0);
    expect(fs.existsSync(catalogFile('ude-stale'))).toBe(false);
  });
});

/**
 * Exit code 0 does not mean the extraction was complete. Both of the script's
 * scans are best-effort (-ErrorAction SilentlyContinue, a per-file catch on
 * BPRules.xml, a per-DLL catch on assembly load), so a run that reached only
 * part of the install still finishes and exits 0. Accepting one of those is
 * worse than not regenerating at all: it is written with the current version
 * key, so every later rebuild sees a match and never retries, and
 * loadCatalog() rejects only an exactly-EMPTY override — a merely truncated
 * catalog replaces the compiled snapshot outright and bp_moniker starts
 * answering "not in the extracted catalog" for monikers that are real.
 */
describe('ensureBpCatalogFresh — partial extractions', () => {
  it('discards a run that skipped part of the install, despite exit 0', async () => {
    const target = makeTarget();
    await ensureBpCatalogFresh(target, depsWriting(version => JSON.stringify({
      version,
      sources: { ruleSetFiles: 144, ruleSetFailures: 71, ruleDlls: 25, dllFailures: 0 },
      entries: [{ moniker: 'BPErrorLabelIsText', message: 'Label is a text literal', description: null, canonical: true }],
    })));

    expect(fs.existsSync(catalogFile())).toBe(false);
    expect(readWrittenSetting()).toBeUndefined();
  });

  it('discards a run where no AxRuleSet was read at all', async () => {
    // Entries, but every one of them came from a rule DLL's resource strings.
    // `canonical` is the only field that answers "is this a BP rule", so a
    // catalog without a single canonical moniker cannot confirm anything.
    const target = makeTarget();
    await ensureBpCatalogFresh(target, depsWriting(version => JSON.stringify({
      version,
      sources: { ruleSetFiles: 0, ruleSetFailures: 0, ruleDlls: 25, dllFailures: 0 },
      entries: [{ moniker: 'DECSomeToolMessage', message: 'Not a BP rule', description: null, canonical: false }],
    })));

    expect(fs.existsSync(catalogFile())).toBe(false);
    expect(readWrittenSetting()).toBeUndefined();
  });

  it('discards a run where no rule DLL yielded any text', async () => {
    // The mirror image: canonical names survived, but `search` matches on rule
    // text and there is none, so every search would come back empty.
    const target = makeTarget();
    await ensureBpCatalogFresh(target, depsWriting(version => JSON.stringify({
      version,
      sources: { ruleSetFiles: 144, ruleSetFailures: 0, ruleDlls: 0, dllFailures: 0 },
      entries: [{ moniker: 'BPErrorLabelIsText', message: null, description: null, canonical: true }],
    })));

    expect(fs.existsSync(catalogFile())).toBe(false);
    expect(readWrittenSetting()).toBeUndefined();
  });

  it('discards an empty run instead of stamping it as this version', async () => {
    // Reachable from a successful run: a packages root with a bin\ folder but
    // no AxRuleSet and no rule DLLs exits 0 with zero entries. Stamping it made
    // the emptiness permanent — the version matched forever after.
    const target = makeTarget();
    await ensureBpCatalogFresh(target, depsWriting(version => JSON.stringify({ version, entries: [] })));

    expect(fs.existsSync(catalogFile())).toBe(false);
    expect(readWrittenSetting()).toBeUndefined();
  });

  it('leaves the previous good catalog in place, unstamped, so the next rebuild retries', async () => {
    const target = makeTarget();
    await ensureBpCatalogFresh(target, fakeDeps());
    const good = fs.readFileSync(catalogFile(), 'utf-8');

    // A platform update moves bin\'s mtime, so the next call really does run.
    fs.writeFileSync(join(binDir, 'xppc.exe'), 'x');
    fs.utimesSync(binDir, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    await ensureBpCatalogFresh(target, depsWriting(version => JSON.stringify({
      version,
      sources: { ruleSetFiles: 144, ruleSetFailures: 3, ruleDlls: 25, dllFailures: 1 },
      entries: [{ moniker: 'BPErrorLabelIsText', message: 'Label is a text literal', description: null, canonical: true }],
    })));

    // Untouched, still carrying the OLD version key — which is precisely what
    // makes the following call extract again rather than report "up to date".
    expect(fs.readFileSync(catalogFile(), 'utf-8')).toBe(good);
    expect(fs.readdirSync(join(root, 'instance', 'data'))).toEqual(['bp-moniker-catalog.json']);

    let calls = 0;
    await ensureBpCatalogFresh(target, fakeDeps({ runExe: async (...runArgs) => { calls++; return fakeDeps().runExe(...runArgs); } }));
    expect(calls).toBe(1);
    expect(fs.readFileSync(catalogFile(), 'utf-8')).not.toBe(good);
  });
});
