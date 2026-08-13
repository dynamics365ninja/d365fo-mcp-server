/**
 * Keeps one target's BP-moniker catalog (src/knowledge/bpMonikers/) matching
 * its own pinned D365FO version, instead of every instance sharing the one
 * snapshot committed in catalog.generated.ts (see that module's docblock).
 *
 * Called as a step of rebuildIndex() (indexCmd.ts) — the one place already
 * reached by instance creation, upgrade, routine rebuild, `update`, and the
 * first-time setup wizard. Regeneration only actually runs when the stamped
 * version in the target's existing catalog file differs from what this
 * target resolves to now (or the file does not exist yet); every other call
 * is a cheap read-and-compare with no subprocess spawned.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { settingByPath } from '../../config/settings.js';
import { findPackagesRoot } from '../../utils/packagesRoot.js';
import { commandExists, runExe } from '../exec.js';
import { paths } from '../context.js';
import { readPath, readSetting, saveStore, writeSetting } from '../settingsStore.js';
import { Target } from '../target.js';
import { p } from '../ui.js';
import { resolvePinnedXppConfig } from '../xppConfig.js';

const bpCatalogPathSetting = settingByPath('index.bpCatalogPath')!;
const packagePathSetting = settingByPath('environment.packagePath')!;

interface ResolvedSource {
  /** Version key stamped into the catalog and compared on the next run. */
  versionKey: string;
  /** -PackagesPath argument for extract-bp-catalog.ps1. */
  packagesPath: string;
}

/** Where this target's real D365FO version + packages root come from. */
function resolveSource(target: Target): ResolvedSource | null {
  const xppConfig = resolvePinnedXppConfig(target.store);
  if (xppConfig) {
    return { versionKey: xppConfig.version, packagesPath: xppConfig.frameworkDirectory ?? '' };
  }
  // Traditional environment: no version string on disk anywhere, so the bin\
  // folder's mtime stands in for "has this install changed since we last
  // extracted" — good enough to catch a platform update, which is the only
  // thing that would actually change the moniker set.
  const packagesPath = readSetting(target.store, packagePathSetting) as string | undefined
    || findPackagesRoot()
    || undefined;
  if (!packagesPath) return null;
  // join(), not a hardcoded '\bin' — this path is only ever real on Windows in
  // production, but the test suite (and CI) exercises it on Linux too, where a
  // literal backslash is just another filename character, not a separator.
  const binDir = join(packagesPath, 'bin');
  try {
    return { versionKey: `mtime:${statSync(binDir).mtimeMs}`, packagesPath };
  } catch {
    return null;
  }
}

interface StampedCatalog {
  version?: string;
  packagesPath?: string;
}

/** The version this target's *existing* catalog file was stamped with, if any. */
function existingVersionKey(catalogPath: string): string | null {
  if (!existsSync(catalogPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(catalogPath, 'utf-8')) as StampedCatalog;
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Injectable for tests — real implementations by default. */
export interface BpCatalogDeps {
  commandExists: typeof commandExists;
  runExe: typeof runExe;
}

const defaultDeps: BpCatalogDeps = { commandExists, runExe };

/**
 * Regenerate this target's BP-moniker catalog when its resolved D365FO
 * version has moved since the catalog file was last stamped (including
 * "never generated" — covers first-time instance creation). A no-op on
 * every other rebuild. Never throws and never fails the caller's reindex —
 * a missing/stale BP catalog degrades one knowledge tool, not the server.
 */
export async function ensureBpCatalogFresh(target: Target, deps: BpCatalogDeps = defaultDeps): Promise<void> {
  const source = resolveSource(target);
  if (!source) {
    p.log.warn(`BP catalog: could not resolve a packages path for ${target.label} — skipped.`);
    return;
  }

  // The fallback below is only reached if bpCatalogPathSetting.default were
  // ever removed — readPath already resolves the documented default
  // ('./data/bp-moniker-catalog.json') against store.baseDir on its own.
  const catalogPath = readPath(target.store, bpCatalogPathSetting, resolve(target.store.baseDir, 'data', 'bp-moniker-catalog.json'));
  if (existingVersionKey(catalogPath) === source.versionKey) {
    p.log.info(`BP catalog up to date (${target.label}).`);
    return;
  }

  let shell = 'pwsh';
  if (!await deps.commandExists(shell)) {
    shell = 'powershell';
    if (!await deps.commandExists(shell)) {
      p.log.warn(`BP catalog: neither pwsh nor powershell is on PATH for ${target.label} — skipped, will retry next rebuild.`);
      return;
    }
  }

  p.log.step(`Refreshing BP moniker catalog (${target.label}, ${basename(source.packagesPath)})…`);
  const exitCode = await deps.runExe(shell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.extractBpCatalogScript,
    '-PackagesPath', source.packagesPath,
    '-OutFile', catalogPath,
    '-Version', source.versionKey,
  ]);
  if (exitCode !== 0) {
    p.log.warn(`BP catalog: extraction failed for ${target.label} (exit ${exitCode}) — keeping the previous catalog.`);
    return;
  }

  if (readSetting(target.store, bpCatalogPathSetting) === undefined) {
    writeSetting(target.store, bpCatalogPathSetting, catalogPath);
    saveStore(target.store);
  }
  p.log.success(`BP catalog refreshed (${target.label}).`);
}
