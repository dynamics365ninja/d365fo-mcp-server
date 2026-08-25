/**
 * Index staleness detection.
 *
 * Compares the newest XML mtime in the active model's metadata folder with
 * the index's last_indexed_at timestamp and produces a warning when the
 * workspace has changed since the last (re)index.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Hard cap on stat'ed files so the scan stays fast on huge models. */
const MAX_SCANNED_FILES = 5000;

/** Files newer than the index by less than this are tolerated (clock skew, in-flight writes). */
const TOLERANCE_MS = 60_000;

/**
 * How long a completed scan answers for.
 *
 * The scan is up to MAX_SCANNED_FILES synchronous statSync calls — 1-3 s of blocked
 * event loop on Windows — and get_workspace_info ran it on every single call, with
 * no cache and outside the in-flight dedup. Half of TOLERANCE_MS, so the cache can
 * never widen the staleness blind spot beyond the one the comparison already grants.
 */
const SCAN_CACHE_MS = 30_000;

const scanCache = new Map<string, { at: number; result: MtimeScanResult | null }>();
/** Roots whose background scan is already scheduled — one at a time per root. */
const scanInFlight = new Set<string>();

/** Drop cached scans (test isolation, or after a known workspace write). */
export function resetMetadataMtimeCache(): void {
  scanCache.clear();
  scanInFlight.clear();
}

export interface MtimeScanResult {
  /** Epoch ms of the newest .xml/.label.txt file found */
  newestMtime: number;
  newestFile: string;
  scannedFiles: number;
  /** True when the scan stopped at MAX_SCANNED_FILES */
  truncated: boolean;
}

/**
 * Recursively find the newest metadata file mtime under rootDir.
 * Returns null when the directory does not exist or contains no metadata files.
 *
 * Cached for SCAN_CACHE_MS per root — see that constant for why.
 */
export function findNewestMetadataMtime(rootDir: string): MtimeScanResult | null {
  const hit = scanCache.get(rootDir);
  if (hit && Date.now() - hit.at < SCAN_CACHE_MS) return hit.result;
  const result = scanNewestMetadataMtime(rootDir);
  scanCache.set(rootDir, { at: Date.now(), result });
  return result;
}

/**
 * A scan result, or the fact that one is being computed.
 *
 * The scan itself cannot be made cheap — it is up to MAX_SCANNED_FILES
 * synchronous `statSync` calls, and on a cold Windows file cache the first one
 * is seconds, not milliseconds. What it CAN stop being is the first thing a
 * session waits for: `get_workspace_info` averaged 31.5 s over 31 real calls and
 * is neither bridge-gated nor DB-gated, so the cost was inside the tool.
 */
export type MtimeScanState =
  | { status: 'ready'; result: MtimeScanResult | null }
  | { status: 'pending' };

/**
 * Cached scan, computed in the background when the caller cannot wait.
 *
 * `blocking: true` is the old behaviour — scan now, answer now — and is what
 * `diagnostics: true` uses, because the whole point of diagnostics is the full
 * picture. `blocking: false` answers from cache or says "pending" and schedules
 * the walk on a later tick, so the request path never carries it. Either way the
 * result lands in the same cache, so the NEXT call has the real verdict.
 */
export function findNewestMetadataMtimeCached(
  rootDir: string,
  opts: { blocking?: boolean } = {},
): MtimeScanState {
  const hit = scanCache.get(rootDir);
  if (hit && Date.now() - hit.at < SCAN_CACHE_MS) return { status: 'ready', result: hit.result };
  if (opts.blocking) return { status: 'ready', result: findNewestMetadataMtime(rootDir) };

  if (!scanInFlight.has(rootDir)) {
    scanInFlight.add(rootDir);
    // setTimeout, not a worker: the walk is synchronous fs work either way, but
    // off the response path it costs the caller nothing. unref() so a pending
    // scan can never hold the process open after the last request.
    const timer = setTimeout(() => {
      try {
        scanCache.set(rootDir, { at: Date.now(), result: scanNewestMetadataMtime(rootDir) });
      } catch {
        scanCache.set(rootDir, { at: Date.now(), result: null });
      } finally {
        scanInFlight.delete(rootDir);
      }
    }, 0);
    timer.unref?.();
  }
  return { status: 'pending' };
}

function scanNewestMetadataMtime(rootDir: string): MtimeScanResult | null {
  let newestMtime = 0;
  let newestFile = '';
  let scannedFiles = 0;
  let truncated = false;

  const walk = (dir: string): void => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip build output and VCS noise
        const lower = entry.name.toLowerCase();
        if (lower === 'bin' || lower === '.git' || lower === 'xppmetadata') continue;
        walk(full);
      } else if (/\.(xml|label\.txt)$/i.test(entry.name)) {
        scannedFiles++;
        if (scannedFiles > MAX_SCANNED_FILES) {
          truncated = true;
          return;
        }
        try {
          const mtime = fs.statSync(full).mtimeMs;
          if (mtime > newestMtime) {
            newestMtime = mtime;
            newestFile = full;
          }
        } catch { /* file vanished mid-scan */ }
      }
    }
  };

  try {
    if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) return null;
  } catch {
    return null;
  }
  walk(rootDir);
  if (scannedFiles === 0) return null;
  return { newestMtime, newestFile, scannedFiles, truncated };
}

export interface StalenessReport {
  status: 'fresh' | 'stale' | 'unknown' | 'pending';
  /** Full "## Index Freshness" section — diagnostics=true only. */
  lines: string[];
  /**
   * Compact default: one `Index : …` line, and the fix only when the index is
   * actually stale. The scan detail (newest file, files scanned) is diagnostics
   * material — it changes nothing about what the agent should do next.
   */
  compactLines: string[];
}

/**
 * Compare workspace mtimes against the index timestamp and render a report
 * section for get_workspace_info.
 *
 * `blocking` defaults to TRUE so every existing caller keeps the full answer;
 * the request path passes `{ blocking: false }` and gets a 'pending' report on a
 * cold cache — see findNewestMetadataMtimeCached.
 */
export function checkIndexStaleness(
  lastIndexedAt: string | null,
  modelMetadataDir: string | null,
  opts: { blocking?: boolean } = {},
): StalenessReport {
  const lines: string[] = ['## Index Freshness', ''];

  if (!lastIndexedAt) {
    lines.push(
      'ℹ️  Index has no freshness timestamp yet (built before this feature or never built).',
      '   It will be recorded on the next build-database run or update_symbol_index call.',
    );
    return {
      status: 'unknown',
      lines,
      compactLines: ['Index       : no freshness timestamp yet (never indexed?)'],
    };
  }

  const indexedAtMs = Date.parse(lastIndexedAt);
  const ageHours = Math.round((Date.now() - indexedAtMs) / 3_600_000);
  lines.push(`Last indexed   : ${lastIndexedAt} (${ageHours} h ago)`);

  if (!modelMetadataDir) {
    lines.push('ℹ️  Model metadata folder not resolved — cannot compare workspace mtimes.');
    return {
      status: 'unknown',
      lines,
      compactLines: [`Index       : indexed ${ageHours} h ago (model folder not resolved — not compared)`],
    };
  }

  const state = findNewestMetadataMtimeCached(modelMetadataDir, { blocking: opts.blocking !== false });
  if (state.status === 'pending') {
    // Said, not hidden: the number is being computed, not missing. The next call
    // has it, and diagnostics=true computes it on the spot.
    lines.push(
      'ℹ️  Workspace scan is running in the background — freshness verdict not in yet.',
      '   Call get_workspace_info again for it, or diagnostics=true to compute it now.',
    );
    return {
      status: 'pending',
      lines,
      compactLines: [
        `Index       : indexed ${ageHours} h ago — freshness scan running in the background ` +
        `(call again for the verdict; diagnostics=true computes it now)`,
      ],
    };
  }
  const scan = state.result;
  if (!scan) {
    lines.push(`ℹ️  No metadata files found under ${modelMetadataDir} — nothing to compare.`);
    return {
      status: 'unknown',
      lines,
      compactLines: [`Index       : indexed ${ageHours} h ago (no metadata files to compare)`],
    };
  }

  lines.push(
    `Newest file    : ${path.basename(scan.newestFile)} (${new Date(scan.newestMtime).toISOString()})` +
    (scan.truncated ? ` — scanned first ${MAX_SCANNED_FILES} files` : ` — ${scan.scannedFiles} files scanned`),
  );

  if (scan.newestMtime > indexedAtMs + TOLERANCE_MS) {
    lines.push(
      '',
      '⚠️  **INDEX IS STALE** — the workspace contains files newer than the last index update.',
      `   Newest change: ${scan.newestFile}`,
      '   Symbol lookups may return outdated signatures/fields for recently edited objects.',
      `   Fix: call \`update_symbol_index(filePath="${scan.newestFile.replace(/\\/g, '\\\\')}")\` for the changed file(s),`,
      '   or run `npm run build-database` (EXTRACT_MODE=custom) for a full custom-model refresh.',
    );
    return {
      status: 'stale',
      lines,
      compactLines: [
        `Index       : ⚠️  STALE — indexed ${ageHours} h ago, workspace has newer files (lookups may be outdated)`,
        `              Fix: update_symbol_index(filePath="${scan.newestFile.replace(/\\/g, '\\\\')}")`,
      ],
    };
  }

  lines.push('✅ Index is up to date with the workspace.');
  return {
    status: 'fresh',
    lines,
    compactLines: [`Index       : up to date (indexed ${ageHours} h ago)`],
  };
}
