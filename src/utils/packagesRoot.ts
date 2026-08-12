/**
 * Where PackagesLocalDirectory lives — discovered, not guessed.
 *
 * Every D365FO VM image puts AosService on a different volume: the classic
 * downloadable VHD uses C:, cloud-hosted environments use K:, and newer images
 * ship it on J: (or whatever letter the data disk happened to get). Hardcoding
 * a candidate list means every new image is a bug report (#769), so instead we
 * enumerate the drive letters that actually exist on the machine and keep the
 * ones that hold `<drive>:\AosService\PackagesLocalDirectory`.
 *
 * Results are ranked so the first hit is the most plausible packages root:
 * a directory that looks like a real PLD (has `bin`) beats a non-empty one,
 * which beats an empty stub — on UDE boxes C:\AosService\PackagesLocalDirectory
 * frequently exists and is empty, and picking it over the populated volume is
 * exactly the failure this ranking prevents.
 *
 * The scan is cheap (one existsSync per drive letter, one readdir per hit) and
 * cached for the process lifetime; drives do not appear mid-session.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Last-resort literal used in messages and as a "clearly wrong path" sentinel
 * when nothing was found. Callers get a plain 'not found' pointing at a real
 * D365FO location rather than an empty string.
 */
export const FALLBACK_PACKAGES_ROOT = 'C:\\AosService\\PackagesLocalDirectory';

/**
 * Tie-break order for equally plausible hits, preserving the priority the
 * hardcoded lists used before the scan existed. Any other drive letter that
 * turns up is appended in alphabetical order.
 */
const PREFERRED_DRIVES = ['C', 'K', 'J', 'I'];

/**
 * A: and B: are skipped deliberately — they are floppy letters, and probing
 * them on a machine that still exposes a floppy controller stalls for seconds.
 */
const SCANNED_DRIVES = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** Filesystem seam so the scan can be tested off Windows. */
export interface ProbeIo {
  platform: NodeJS.Platform;
  isDirectory(target: string): boolean;
  readDir(target: string): string[];
}

const realIo: ProbeIo = {
  // Read through to process.platform on every access rather than snapshotting it
  // at import time — a frozen copy makes the scan ignore a platform override, so
  // the "not on Windows" path can only be exercised on a non-Windows machine and
  // the corresponding test silently passes on CI while failing on a real VM.
  get platform(): NodeJS.Platform {
    return process.platform;
  },
  isDirectory(target: string): boolean {
    try {
      return fs.statSync(target).isDirectory();
    } catch {
      return false;
    }
  },
  readDir(target: string): string[] {
    try {
      return fs.readdirSync(target);
    } catch {
      return [];
    }
  },
};

/** Higher scores sort first. */
function plausibility(root: string, io: ProbeIo): number {
  const entries = io.readDir(root);
  if (entries.length === 0) return 0;                                          // exists but empty
  if (entries.some(e => e.toLowerCase() === 'bin')) return 2;                  // real packages root
  return 1;                                                                    // populated, no bin
}

/**
 * Every `<drive>:\AosService\PackagesLocalDirectory` that exists on this
 * machine, most plausible first. Empty on non-Windows.
 */
export function scanPackagesRoots(io: ProbeIo = realIo): string[] {
  if (io.platform !== 'win32') return [];

  const hits: { root: string; score: number; rank: number }[] = [];
  for (const letter of SCANNED_DRIVES) {
    if (!io.isDirectory(`${letter}:\\`)) continue;
    const root = `${letter}:\\AosService\\PackagesLocalDirectory`;
    if (!io.isDirectory(root)) continue;
    const preferred = PREFERRED_DRIVES.indexOf(letter);
    hits.push({
      root,
      score: plausibility(root, io),
      rank: preferred === -1 ? PREFERRED_DRIVES.length : preferred,
    });
  }

  return hits
    .sort((a, b) => b.score - a.score || a.rank - b.rank || a.root.localeCompare(b.root))
    .map(hit => hit.root);
}

let cached: string[] | null = null;

/** Cached {@link scanPackagesRoots}. */
export function packagesRoots(): string[] {
  if (cached === null) cached = scanPackagesRoots();
  return cached;
}

/** The most plausible packages root on this machine, or null when there is none. */
export function findPackagesRoot(): string | null {
  return packagesRoots()[0] ?? null;
}

/**
 * The packages root to use when no configuration and no detection produced one.
 * Falls back to {@link FALLBACK_PACKAGES_ROOT} so error messages name a path.
 */
export function defaultPackagesRoot(): string {
  return findPackagesRoot() ?? FALLBACK_PACKAGES_ROOT;
}

/**
 * Detected roots joined with a relative path, e.g. `bin\xppc.exe` — the probe
 * list callers walk when they need a specific binary rather than the root.
 */
export function packagesRootCandidates(...relative: string[]): string[] {
  return packagesRoots().map(root => path.join(root, ...relative));
}

/** Human-readable summary of what the scan found, for error messages. */
export function describePackagesRootScan(): string {
  const found = packagesRoots();
  return found.length > 0
    ? `Detected packages roots: ${found.join(', ')}`
    : `No <drive>:\\AosService\\PackagesLocalDirectory found on any drive (C: to Z: were scanned).`;
}

/**
 * Absolute in the Windows sense as well as the POSIX one.
 *
 * `path.isAbsolute` on a POSIX host says `K:\AosService\…` is RELATIVE, so a
 * perfectly good absolute path gets joined onto a packages root — the server
 * can run on Linux while every path it handles comes from a Windows metadata
 * store. Mirrors the same check in modifyD365File.ts.
 */
function isAbsoluteXPlat(p: string): boolean {
  return path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p);
}

/**
 * Join a Windows-style root to a relative path without letting the host's
 * separator decide. `path.resolve` on POSIX would prefix the process cwd to a
 * `K:\…` root, producing `/home/runner/…/K:\…\K:\…`.
 */
function joinXPlat(root: string, relative: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(root) || /^\\\\/.test(root)) {
    return `${root.replace(/[\\/]+$/, '')}\\${relative.replace(/\//g, '\\')}`;
  }
  return path.resolve(root, relative);
}

/**
 * An absolute path for a `file_path` read out of the symbol index.
 *
 * The index holds both shapes. Most rows are absolute, but a measured 5,345 of
 * them are package-relative — `ContosoCore/ContosoCore/AxForm/Foo.xml` —
 * left over from an extraction that ran with the packages root as its cwd.
 * Handing one of those to `fs.readFile` resolves it against the CURRENT cwd,
 * which for a server VS Code spawned is the user's home directory. The failure
 * is a puzzling ENOENT naming a path that could never exist:
 *
 *   C:\Users\<user>\ContosoCore\ContosoCore\AxForm\Foo.xml
 *
 * Absolute inputs are returned unchanged, so this is safe to apply everywhere a
 * file_path leaves the index — which is the only way to be sure a caller does
 * not hit one of the 5,345.
 *
 * `roots` is injectable for tests; it defaults to the detected packages roots,
 * tried in order, with the first existing candidate winning.
 */
export function resolveIndexedFilePath(
  filePath: string,
  opts: { roots?: readonly string[]; exists?: (p: string) => boolean } = {},
): string {
  if (!filePath || isAbsoluteXPlat(filePath)) return filePath;
  const exists = opts.exists ?? fs.existsSync;
  const roots = opts.roots ?? packagesRoots();
  for (const root of roots) {
    const candidate = joinXPlat(root, filePath);
    if (exists(candidate)) return candidate;
  }
  // Nothing matched: resolve against the best-known root anyway, so the error
  // names a path the user can recognise instead of one under their home.
  return joinXPlat(roots[0] ?? FALLBACK_PACKAGES_ROOT, filePath);
}

/**
 * Is this indexed `file_path` actually an AOT source file, rather than one of
 * the pre-extracted JSON caches the indexer builds from?
 *
 * Twenty sites in symbolIndex.ts store `<object>.sourcePath || filePath`, where
 * `filePath` is the `.json` cache the object was read from (see indexEnums:
 * `path.join(enumsPath, file)` over a `.json` listing). An object whose cache
 * entry carries no `sourcePath` therefore lands in the index with a path to the
 * cache rather than to the AOT source.
 *
 * That is worse than a missing path, because the cache file genuinely exists:
 * every `fs.existsSync` / `fs.access` guard downstream passes, and the caller
 * proceeds to read — or write — the wrong file. Existence is not the question;
 * identity is. Hence an extension test rather than a stat.
 *
 * Measured on a full index (1,188,687 rows): 8,262 rows carried a `.json` path,
 * and all of them were enums — extractEnums was the one extractor writing a bare
 * `{ raw }` object with no `sourcePath`. That is fixed at the source in
 * scripts/extract-metadata.ts, so freshly extracted metadata no longer produces
 * such rows. This check stays because the shipped SQLite database is downloaded
 * prebuilt from blob storage: every database built before that fix still carries
 * the poisoned rows, and `file_path` is `TEXT NOT NULL`, so there was never an
 * honest empty value to store in their place.
 *
 * What a caller should do with a `false` here depends on what it wants. To READ,
 * prefer readXmlFile in utils/indexedXmlLookup.ts — the cache holds the original
 * XML in `raw`, so it can be unwrapped rather than refused. To WRITE, or to judge
 * whether the object is still on disk, the path is unusable and no verdict can be
 * drawn from it.
 */
export function isAotSourcePath(filePath: string | null | undefined): filePath is string {
  return !!filePath && /\.(xml|xpp)$/i.test(filePath.trim());
}

/** Test seam — drops the cached scan. */
export function resetPackagesRootCache(): void {
  cached = null;
}
