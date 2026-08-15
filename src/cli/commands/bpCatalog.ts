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
 *
 * Two things this module will not do, both because the result would be
 * self-perpetuating — whatever it stamps with the current version key is what
 * every later rebuild treats as up to date: extract from an install that is
 * not this target's (resolveSource), and accept an extraction that only
 * partially read the one that is (verifyExtraction).
 */
import { existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { settingByPath } from '../../config/settings.js';
import { findPackagesRoot } from '../../utils/packagesRoot.js';
import { commandExists, runExe } from '../exec.js';
import { paths } from '../context.js';
import { readPath, readSetting, saveStore, writeSetting } from '../settingsStore.js';
import { Target } from '../target.js';
import { p } from '../ui.js';
import { isUdeTarget, resolvePinnedXppConfig } from '../xppConfig.js';

const bpCatalogPathSetting = settingByPath('index.bpCatalogPath')!;
const packagePathSetting = settingByPath('environment.packagePath')!;

interface ResolvedSource {
  /** Version key stamped into the catalog and compared on the next run. */
  versionKey: string;
  /** -PackagesPath argument for extract-bp-catalog.ps1. */
  packagesPath: string;
}

/**
 * Relative on purpose — instance path settings stay portable so an instance
 * folder can be renamed or moved (see configBaseDir in config/configFile.ts).
 */
const DEFAULT_CATALOG_RELATIVE = './data/bp-moniker-catalog.json';

/** Where this target's real D365FO version + packages root come from. */
function resolveSource(target: Target): ResolvedSource | null {
  const xppConfig = resolvePinnedXppConfig(target.store);
  if (xppConfig) {
    // No frameworkDirectory means the config JSON could not be read —
    // listXppConfigs() keeps those entries deliberately. Passing '' would not
    // be "use the default", it would hand the script an empty -PackagesPath,
    // whose own fallback auto-detects the NEWEST PackagesLocalDirectory on the
    // box; the result then gets stamped with THIS target's version and treated
    // as current. A catalog from the wrong install is worse than no catalog.
    if (!xppConfig.frameworkDirectory) return null;
    return { versionKey: xppConfig.version, packagesPath: xppConfig.frameworkDirectory };
  }
  // A null from resolvePinnedXppConfig does NOT mean "traditional". It also
  // covers a UDE target whose pin names a config that is gone — the
  // stale-after-UDE-upgrade state `instance upgrade` exists to fix — and that
  // function returns null there *deliberately*, rather than substituting a
  // different environment. Falling through to the box-wide scan below would
  // undo exactly that: findPackagesRoot() ranks every <drive>:\AosService\
  // PackagesLocalDirectory on the machine and hands back the most plausible
  // one, which on a mixed box is some other install entirely. Its catalog
  // would then be stamped with this target's key and treated as current —
  // the same "catalog from the wrong install" the branch above refuses.
  if (isUdeTarget(target.store)) return null;
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
  /** Extraction coverage reported by the script — see verifyExtraction. */
  sources?: { ruleSetFiles?: number; ruleSetFailures?: number; ruleDlls?: number; dllFailures?: number };
  entries?: unknown;
}

/** The version this target's *existing* catalog file was stamped with, if any. */
function existingVersionKey(catalogPath: string): string | null {
  if (!existsSync(catalogPath)) return null;
  try {
    // Strip a leading BOM before parsing: the script writes BOM-less UTF-8, but
    // a catalog left behind by an older copy of it (or hand-edited in a Windows
    // editor) still carries one, and JSON.parse throws on it. Throwing here is
    // not visible — it just reads as "no catalog yet" and re-runs the whole scan.
    const parsed = JSON.parse(readFileSync(catalogPath, 'utf-8').replace(/^\uFEFF/, '')) as StampedCatalog;
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

interface CatalogEntry {
  message?: string | null;
  description?: string | null;
  canonical?: boolean;
}

/**
 * Why a freshly extracted catalog must not be trusted as this target's current
 * one — or null when it looks like a complete extraction.
 *
 * Exit code 0 does not mean "complete". Both of the script's scans are
 * best-effort on purpose (`-ErrorAction SilentlyContinue`, a per-file catch on
 * BPRules.xml, a per-DLL catch on assembly load), so a run that could read half
 * the models, or none of the rule DLLs, still finishes and exits 0. Stamping
 * that result is worse than not regenerating at all: the stamp matches on every
 * later rebuild, so it is never retried, and loadCatalog() only rejects an
 * exactly-empty override — a merely truncated one REPLACES the compiled
 * snapshot, and bp_moniker starts answering "not in the extracted catalog" for
 * monikers that are real.
 *
 * The failure counts are the script's own (`sources`), not a guess: measured
 * against a real 214-model PackagesLocalDirectory, a healthy box skips zero of
 * its 144 BPRules.xml files and zero of its 25 rule DLLs, so any skip at all is
 * signal. The content checks below stand in for that on a catalog produced by
 * an older copy of the script, which carries no `sources` block.
 */
function verifyExtraction(catalogPath: string): string | null {
  let parsed: StampedCatalog;
  try {
    // Same BOM strip as existingVersionKey — a catalog an older copy of the
    // script produced under PowerShell 5.1 carries one, and this must reject a
    // partial extraction, not a readable-but-BOM'd one.
    parsed = JSON.parse(readFileSync(catalogPath, 'utf-8').replace(/^\uFEFF/, '')) as StampedCatalog;
  } catch (err) {
    return `it could not be read back (${(err as Error).message})`;
  }
  if (!Array.isArray(parsed.entries)) return 'it carries no entries array';

  const { ruleSetFailures = 0, dllFailures = 0, ruleSetFiles = 0, ruleDlls = 0 } = parsed.sources ?? {};
  if (ruleSetFailures > 0 || dllFailures > 0) {
    return `the extraction skipped ${ruleSetFailures} of ${ruleSetFiles} BPRules.xml files and ${dllFailures} of ${ruleDlls} rule DLLs`;
  }

  const entries = parsed.entries as CatalogEntry[];
  if (entries.length === 0) return 'it contains no monikers at all';
  // Either source failing wholesale leaves a catalog that still looks populated
  // but has lost the half that answers a question: no canonical name means no
  // AxRuleSet was read, so `validate` cannot confirm anything; no rule text
  // means no DLL yielded resources, so `search` matches nothing.
  if (!entries.some(e => e.canonical)) return 'not one of its monikers came from an AxRuleSet/BPRules.xml';
  if (!entries.some(e => e.message || e.description)) return 'not one of its monikers carries rule text';
  return null;
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
    p.log.warn(isUdeTarget(target.store)
      ? `BP catalog: could not resolve ${target.label}'s own D365FO install (its XPP config is missing or unreadable) — skipped rather than extracting from another install on this box. \`d365fo-mcp instance upgrade\` repoints a pin left behind by a UDE upgrade.`
      : `BP catalog: could not resolve a packages path for ${target.label} — skipped.`);
    return;
  }

  // The setting carries no registry default (see settings.ts for why), so this
  // fallback is the normal path until the first successful extraction writes
  // the value below.
  const catalogPath = readPath(target.store, bpCatalogPathSetting, resolve(target.store.baseDir, DEFAULT_CATALOG_RELATIVE));
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
  // Extract beside the real catalog, not over it. The script writes its output
  // in one go with no staging of its own, so pointing it straight at the live
  // file means a partial run destroys a good catalog before anything can judge
  // it — and the caller cannot put it back. The move below is the only thing
  // that makes this target's catalog change.
  const stagedPath = `${catalogPath}.new`;
  const exitCode = await deps.runExe(shell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.extractBpCatalogScript,
    '-PackagesPath', source.packagesPath,
    '-OutFile', stagedPath,
    '-Version', source.versionKey,
  ]);
  if (exitCode !== 0) {
    rmSync(stagedPath, { force: true });
    p.log.warn(`BP catalog: extraction failed for ${target.label} (exit ${exitCode}) — keeping the previous catalog.`);
    return;
  }

  const problem = verifyExtraction(stagedPath);
  if (problem) {
    // Discarded rather than stamped: the file carries this target's current
    // version key, so keeping it would make every later rebuild a no-op and
    // freeze a half-read catalog in place. Dropping it leaves the previous
    // catalog (or the compiled snapshot) in service and the version key stale,
    // which is exactly what makes the next rebuild try again.
    rmSync(stagedPath, { force: true });
    p.log.warn(`BP catalog: discarded the extraction for ${target.label} — ${problem}. Keeping the previous catalog; the next rebuild will retry.`);
    return;
  }
  renameSync(stagedPath, catalogPath);

  // Write the RELATIVE literal, not the resolved catalogPath: an absolute path
  // baked into the instance config survives neither a folder rename nor a move,
  // and toEnvRecord() resolves a relative one against store.baseDir on its way
  // into BP_CATALOG_PATH anyway. This write is also what turns the override on
  // at all — the setting has no registry default.
  if (readSetting(target.store, bpCatalogPathSetting) === undefined) {
    writeSetting(target.store, bpCatalogPathSetting, DEFAULT_CATALOG_RELATIVE);
    saveStore(target.store);
  }
  p.log.success(`BP catalog refreshed (${target.label}).`);
}
