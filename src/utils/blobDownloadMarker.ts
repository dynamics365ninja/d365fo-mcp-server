/**
 * Blob-download marker — the note `azure-blob-manager` leaves for `extract-metadata`.
 *
 * Both scripts write into the same `OUTPUT_PATH/<model>/…` layout: the blob manager
 * downloads metadata produced elsewhere, extraction writes metadata read from THIS
 * machine's PackagesLocalDirectory. Extraction then sweeps every `.json` under a model
 * it re-extracted that this run did not write (see pruneOrphanedMetadata), which is
 * how a deleted AOT object stops surviving rebuilds as a phantom.
 *
 * For a model that is BOTH downloaded and locally re-extracted, that sweep cannot tell
 * "the blob had it, this disk does not" apart from "it was deleted from the AOT", and
 * removes it. Local disk is meant to be authoritative for a model you just extracted,
 * so the precedence is intended — but on a machine with a partial PackagesLocalDirectory
 * it reads as data loss, and neither script said a word about the other.
 *
 * This marker is what lets the extract run SAY so. It is written at the metadata
 * directory root, not inside a model folder, so the sweep (which walks
 * OUTPUT_PATH/<model> only) can never touch it.
 */

import * as fs from 'fs';
import * as path from 'path';

/** File written into the metadata output directory. Not a model dir — scanners skip files. */
export const BLOB_DOWNLOAD_MARKER_FILENAME = '.blob-download.json';

export interface BlobDownloadMarker {
  /** ISO timestamp of the download that produced this marker. */
  downloadedAt: string;
  /** What was asked for: 'standard' | 'custom' | 'all'. */
  modelType: string;
  /** Models the download actually wrote into, as on-disk directory names. */
  models: string[];
  /** How many files the download wrote (diagnostics only). */
  fileCount: number;
}

function markerPath(metadataDir: string): string {
  return path.join(metadataDir, BLOB_DOWNLOAD_MARKER_FILENAME);
}

/** Record a completed blob download. Best-effort: a download succeeds even if this fails. */
export function writeBlobDownloadMarker(metadataDir: string, marker: BlobDownloadMarker): void {
  fs.writeFileSync(markerPath(metadataDir), JSON.stringify(marker, null, 2));
}

/**
 * Read the last blob download's marker, or `undefined` when this metadata directory
 * was never populated from blob storage (the normal local-only case).
 */
export function readBlobDownloadMarker(metadataDir: string): BlobDownloadMarker | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath(metadataDir), 'utf-8')) as Partial<BlobDownloadMarker>;
    if (typeof parsed.downloadedAt !== 'string') return undefined;
    return {
      downloadedAt: parsed.downloadedAt,
      modelType: typeof parsed.modelType === 'string' ? parsed.modelType : 'unknown',
      models: Array.isArray(parsed.models) ? parsed.models.filter((m): m is string => typeof m === 'string') : [],
      fileCount: typeof parsed.fileCount === 'number' ? parsed.fileCount : 0,
    };
  } catch {
    // No marker (ENOENT) or unparseable — the caller says nothing about blob storage.
    return undefined;
  }
}
