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

/** Test seam — drops the cached scan. */
export function resetPackagesRootCache(): void {
  cached = null;
}
