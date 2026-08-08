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

/** Drop cached scans (test isolation, or after a known workspace write). */
export function resetMetadataMtimeCache(): void {
  scanCache.clear();
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
  status: 'fresh' | 'stale' | 'unknown';
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
 */
export function checkIndexStaleness(
  lastIndexedAt: string | null,
  modelMetadataDir: string | null,
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

  const scan = findNewestMetadataMtime(modelMetadataDir);
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
