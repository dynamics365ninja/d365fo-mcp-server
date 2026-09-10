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
 * The scan is one stat per drive letter plus one readdir per hit, cached for
 * the process lifetime; drives do not appear mid-session. It is NOT always
 * cheap: a stat on a disconnected mapped network drive stalls for the SMB
 * timeout — tens of seconds for one letter — and the scan runs lazily, on the
 * first tool call that needs a packages path. So the letters that have ever
 * held AosService are probed first and unconditionally, the remaining ones
 * only while the scan is inside DRIVE_SCAN_BUDGET_MS, and D365FO_SCAN_DRIVES
 * pins the probed set outright on a machine whose mapped drives are known to
 * stall. What was probed, skipped and slow is kept for `doctor` and the
 * not-found messages, so a missed volume names the letter it sits on.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
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

/**
 * Wall-clock budget for the letters outside PREFERRED_DRIVES. Two seconds is
 * far above a healthy probe (a local stat is microseconds) and far below one
 * hung SMB stat, so a healthy machine still scans every letter and a machine
 * with one dead mapped drive pays for that drive once, not for every letter
 * behind it.
 */
export const DRIVE_SCAN_BUDGET_MS = 2_000;

/** A single probe slower than this is reported by name — it is the hang. */
const SLOW_PROBE_MS = 1_000;

/** What the last scan did, for doctor and the not-found messages. */
export interface DriveScanReport {
  /** Letters actually probed, in probe order. */
  probed: string[];
  /** Letters the budget left unprobed — a root there would have been missed. */
  skipped: string[];
  /** Probes that took SLOW_PROBE_MS or more, with their cost. */
  slow: Array<{ letter: string; ms: number }>;
  /** True when D365FO_SCAN_DRIVES fixed the probed set. */
  pinned: boolean;
}

let lastReport: DriveScanReport | null = null;

/** The report of the most recent scan, or null when none has run. */
export function lastDriveScanReport(): DriveScanReport | null {
  return lastReport;
}

/**
 * The letters to probe, in probe order. A D365FO_SCAN_DRIVES value such as
 * "C,K" (separators and colons tolerated) pins the set; otherwise the
 * preferred letters come first so a stalled drive further down the alphabet
 * cannot delay the ones that actually hold AosService.
 */
export function driveLettersToProbe(pinnedSpec?: string): { letters: string[]; pinned: boolean } {
  const pinned = (pinnedSpec ?? '')
    .toUpperCase()
    .split(/[,;\s]+/)
    .map(s => s.replace(/[:\\/]/g, ''))
    .filter(l => /^[C-Z]$/.test(l));
  if (pinned.length > 0) return { letters: [...new Set(pinned)], pinned: true };
  const rest = SCANNED_DRIVES.filter(l => !PREFERRED_DRIVES.includes(l));
  return { letters: [...PREFERRED_DRIVES, ...rest], pinned: false };
}

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

/** Filesystem seam for the off-the-loop scan. Mirrors {@link ProbeIo}, promised. */
export interface AsyncProbeIo {
  platform: NodeJS.Platform;
  isDirectory(target: string): Promise<boolean>;
  readDir(target: string): Promise<string[]>;
}

const realAsyncIo: AsyncProbeIo = {
  // Read through, for the same reason realIo does — see the note there.
  get platform(): NodeJS.Platform {
    return process.platform;
  },
  async isDirectory(target: string): Promise<boolean> {
    try {
      return (await fsp.stat(target)).isDirectory();
    } catch {
      return false;
    }
  },
  async readDir(target: string): Promise<string[]> {
    try {
      return await fsp.readdir(target);
    } catch {
      return [];
    }
  },
};

/** Higher scores sort first. Pure, so both scans rank a directory the same way. */
function scoreEntries(entries: string[]): number {
  if (entries.length === 0) return 0;                                          // exists but empty
  if (entries.some(e => e.toLowerCase() === 'bin')) return 2;                  // real packages root
  return 1;                                                                    // populated, no bin
}

function plausibility(root: string, io: ProbeIo): number {
  return scoreEntries(io.readDir(root));
}

/**
 * Every `<drive>:\AosService\PackagesLocalDirectory` that exists on this
 * machine, most plausible first. Empty on non-Windows.
 */
export interface ScanOptions {
  /** Clock seam for the budget (tests advance it per probe). */
  clock?: () => number;
  budgetMs?: number;
  /** Overrides D365FO_SCAN_DRIVES. */
  drives?: string;
}

/**
 * The parts of the scan that do not touch the filesystem, shared by the
 * synchronous scan and its async twin so the two can never disagree about
 * which letters get probed or how the hits are ranked. Only the probe itself
 * differs between them — everything around it lives here.
 */
interface ScanPlan {
  letters: string[];
  pinned: boolean;
  budgetMs: number;
  clock: () => number;
  report: DriveScanReport;
}

function planScan(opts: ScanOptions): ScanPlan {
  const { letters, pinned } = driveLettersToProbe(opts.drives ?? process.env.D365FO_SCAN_DRIVES);
  return {
    letters,
    pinned,
    budgetMs: opts.budgetMs ?? DRIVE_SCAN_BUDGET_MS,
    clock: opts.clock ?? Date.now,
    report: { probed: [], skipped: [], slow: [], pinned },
  };
}

/**
 * True when this letter is not worth probing any more. The preferred letters
 * and a pinned set are ALWAYS probed, however long the scan has already taken:
 * skipping one because an earlier drive stalled would hide the packages root
 * on it, which is a wrong answer rather than a slow one.
 */
function outOfBudget(plan: ScanPlan, preferred: number, start: number): boolean {
  return !plan.pinned && preferred === -1 && plan.clock() - start > plan.budgetMs;
}

function rootOf(letter: string): string {
  return `${letter}:\\AosService\\PackagesLocalDirectory`;
}

function rankHits(hits: { root: string; score: number; rank: number }[]): string[] {
  return hits
    .sort((a, b) => b.score - a.score || a.rank - b.rank || a.root.localeCompare(b.root))
    .map(hit => hit.root);
}

export function scanPackagesRoots(io: ProbeIo = realIo, opts: ScanOptions = {}): string[] {
  if (io.platform !== 'win32') return [];

  const plan = planScan(opts);
  const { clock, report } = plan;
  const hits: { root: string; score: number; rank: number }[] = [];
  const start = clock();
  for (const letter of plan.letters) {
    const preferred = PREFERRED_DRIVES.indexOf(letter);
    if (outOfBudget(plan, preferred, start)) {
      report.skipped.push(letter);
      continue;
    }
    const t0 = clock();
    const root = rootOf(letter);
    const hit = io.isDirectory(`${letter}:\\`) && io.isDirectory(root);
    const ms = clock() - t0;
    report.probed.push(letter);
    if (ms >= SLOW_PROBE_MS) report.slow.push({ letter, ms });
    if (!hit) continue;
    hits.push({
      root,
      score: plausibility(root, io),
      rank: preferred === -1 ? PREFERRED_DRIVES.length : preferred,
    });
  }
  lastReport = report;

  return rankHits(hits);
}

/**
 * The same scan with `fs.promises` instead of `fs.*Sync`.
 *
 * Identical letters, identical budget, identical ranking — the ONLY difference
 * is where the stall lands. `statSync` on a disconnected mapped network drive
 * blocks the thread it runs on, and on the main thread that is the event loop:
 * the server stops answering, stops logging and stops sending heartbeats, which
 * is indistinguishable from a crash (this is what a 1.17.2 first call looked
 * like). The promise form hands the same stat to the libuv threadpool, so the
 * drive still costs its SMB timeout but nothing else waits for it.
 *
 * Probes run one at a time on purpose: the threadpool has four threads by
 * default, and several dead drives probed at once would occupy all of them and
 * stall every other file operation in the process instead.
 */
export async function scanPackagesRootsAsync(
  io: AsyncProbeIo = realAsyncIo,
  opts: ScanOptions = {},
): Promise<string[]> {
  if (io.platform !== 'win32') return [];

  const plan = planScan(opts);
  const { clock, report } = plan;
  const hits: { root: string; score: number; rank: number }[] = [];
  const start = clock();
  for (const letter of plan.letters) {
    const preferred = PREFERRED_DRIVES.indexOf(letter);
    if (outOfBudget(plan, preferred, start)) {
      report.skipped.push(letter);
      continue;
    }
    const t0 = clock();
    const root = rootOf(letter);
    const hit = (await io.isDirectory(`${letter}:\\`)) && (await io.isDirectory(root));
    const ms = clock() - t0;
    report.probed.push(letter);
    if (ms >= SLOW_PROBE_MS) report.slow.push({ letter, ms });
    if (!hit) continue;
    const entries = await io.readDir(root);
    hits.push({
      root,
      score: scoreEntries(entries),
      rank: preferred === -1 ? PREFERRED_DRIVES.length : preferred,
    });
  }
  lastReport = report;

  return rankHits(hits);
}

let cached: string[] | null = null;
let warming: Promise<string[]> | null = null;
/** Bumped by resetPackagesRootCache so an in-flight warm-up cannot outlive it. */
let cacheGeneration = 0;

/**
 * Run the scan off the event loop and cache it, so every later synchronous
 * caller is answered from memory instead of probing drives itself.
 *
 * Started as early as the server has a startup sequence and awaited by
 * `ConfigManager.ensureLoaded()`, which every request path passes through
 * before it reaches a synchronous getter. Idempotent: concurrent callers share
 * the one in-flight scan, and a warm cache resolves immediately.
 */
export function warmPackagesRoots(): Promise<string[]> {
  if (cached !== null) return Promise.resolve(cached);
  if (warming) return warming;
  // The generation guard makes a reset actually take: clearing `warming` alone
  // would leave the in-flight scan free to write its (now stale) answer into
  // the cache after the reset — in a test run, one case's fake drives landing
  // in the next case's scan.
  const generation = cacheGeneration;
  warming = scanPackagesRootsAsync()
    .catch(() => [] as string[])
    .then(roots => {
      if (generation === cacheGeneration) {
        cached = roots;
        warming = null;
      }
      return roots;
    });
  return warming;
}

/**
 * Cached {@link scanPackagesRoots}.
 *
 * Falls back to the synchronous scan only when nothing has warmed the cache
 * yet — a CLI command, or a request that beat the warm-up started at startup.
 * That path can still block on a dead drive; it is kept because the alternative
 * (answering "no packages root" while the warm-up is in flight) would make
 * every one of this function's callers wrong instead of slow.
 */
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
  return describeDriveScan(packagesRoots(), lastReport);
}

/** The sentence for a given outcome — pure, so a fake scan can be described in tests. */
export function describeDriveScan(found: string[], report: DriveScanReport | null): string {
  const notes: string[] = [];
  if (report?.slow.length) {
    notes.push(
      `Probing ${report.slow.map(s => `${s.letter}: took ${(s.ms / 1000).toFixed(1)} s`).join(', ')} — ` +
      'a disconnected mapped network drive stalls every probe; set D365FO_SCAN_DRIVES (e.g. "C,K") to skip it, ' +
      'or D365FO_PACKAGE_PATH to skip the scan.'
    );
  }
  if (report?.skipped.length) {
    notes.push(
      `The scan ran out of its ${DRIVE_SCAN_BUDGET_MS / 1000} s budget and did not probe ` +
      `${report.skipped.map(l => `${l}:`).join(' ')} — a packages root there was not seen. ` +
      'Name the drive in D365FO_SCAN_DRIVES, or set D365FO_PACKAGE_PATH.'
    );
  }
  const scanned = report?.pinned
    ? `${report.probed.map(l => `${l}:`).join(', ')} were scanned (D365FO_SCAN_DRIVES)`
    : report?.skipped.length
      ? `${report.probed.map(l => `${l}:`).join(', ')} were scanned`
      : 'C: to Z: were scanned';
  const head = found.length > 0
    ? `Detected packages roots: ${found.join(', ')}`
    : `No <drive>:\\AosService\\PackagesLocalDirectory found on any drive (${scanned}).`;
  return [head, ...notes].join(' ');
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
  lastReport = null;
  warming = null;
  cacheGeneration++;
}
