/**
 * The note azure-blob-manager leaves for extract-metadata (#881).
 *
 * Both scripts write into OUTPUT_PATH/<model>/…, and the orphan sweep deletes every
 * .json under a re-extracted model that the run did not write. For a model that is
 * both blob-downloaded and locally re-extracted, "the blob had it, this disk does
 * not" is indistinguishable from "deleted from the AOT". The precedence is intended;
 * being unable to SAY so is what made it read as data loss.
 *
 * Two things have to hold: the marker survives a sweep (it is a .json file, so its
 * location at the metadata root is load-bearing, not cosmetic), and an absent or
 * corrupt marker degrades to "say nothing" rather than throwing inside a run summary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  writeBlobDownloadMarker,
  readBlobDownloadMarker,
  BLOB_DOWNLOAD_MARKER_FILENAME,
} from '../../src/utils/blobDownloadMarker';
import { pruneOrphanedMetadata } from '../../scripts/extract-metadata';

let outputPath: string;

beforeEach(async () => {
  outputPath = await fs.mkdtemp(path.join(os.tmpdir(), 'blob-marker-'));
});

afterEach(async () => {
  await fs.rm(outputPath, { recursive: true, force: true });
});

describe('blob-download marker', () => {
  it('round-trips what the extract run needs to name the interaction', () => {
    writeBlobDownloadMarker(outputPath, {
      downloadedAt: '2026-08-09T10:00:00.000Z',
      modelType: 'custom',
      models: ['ContosoFinanceSK', 'Contoso'],
      fileCount: 1234,
    });

    const marker = readBlobDownloadMarker(outputPath);

    expect(marker?.modelType).toBe('custom');
    expect(marker?.models).toContain('ContosoFinanceSK');
    expect(marker?.downloadedAt).toBe('2026-08-09T10:00:00.000Z');
  });

  it('says nothing when the metadata directory was never populated from blob storage', () => {
    expect(readBlobDownloadMarker(outputPath)).toBeUndefined();
  });

  it('says nothing rather than throwing on a corrupt marker', async () => {
    await fs.writeFile(path.join(outputPath, BLOB_DOWNLOAD_MARKER_FILENAME), '{ not json');
    expect(readBlobDownloadMarker(outputPath)).toBeUndefined();
  });

  it('survives the orphan sweep', async () => {
    // It is a .json file and the sweep deletes every .json a run did not write —
    // it is only safe because it lives at the metadata ROOT, outside any model dir.
    writeBlobDownloadMarker(outputPath, {
      downloadedAt: '2026-08-09T10:00:00.000Z', modelType: 'all', models: ['ContosoFinanceSK'], fileCount: 1,
    });
    const orphan = path.join(outputPath, 'ContosoFinanceSK', 'enums', 'ConSK_QualityTier.json');
    await fs.mkdir(path.dirname(orphan), { recursive: true });
    await fs.writeFile(orphan, '{}');

    const removed = await pruneOrphanedMetadata(outputPath, 'ContosoFinanceSK', new Set());

    expect(removed).toContain('enums/ConSK_QualityTier.json');
    expect(readBlobDownloadMarker(outputPath)).toBeDefined();
  });
});
