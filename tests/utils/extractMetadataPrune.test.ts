/**
 * extract-metadata orphan sweep tests (phantom objects surviving a delete + rebuild)
 *
 * Extraction only ever wrote JSON — one file per XML found — and the sole cleanup was an
 * `fs.rm(OUTPUT_PATH)` gated on EXTRACT_MODE='all'. So in the `custom`/`standard` modes
 * everyone actually runs, deleting an object from PackagesLocalDirectory left its JSON in
 * extracted-metadata forever, and build-database read it straight back in: clearModels()
 * emptied the model's rows, then the very next pass re-inserted the orphan. The object
 * came back from the dead with stale metadata and was served as if it were on disk —
 * get_object_info answered from "symbol index (extracted metadata)" for a file that did
 * not exist, and only verify_d365fo_project (which stats the disk) disagreed.
 *
 * Observed on model ContosoFinanceSK: a delete + full re-extract + rebuild left 4 of 95 JSON
 * files untouched — an enum, a class, its class-extension record and a form-extension —
 * all of which kept answering queries for two further sessions.
 *
 * Covers:
 *   - a JSON with no live source file is deleted
 *   - a JSON this run rewrote is kept
 *   - the derived class-extensions record dies with its class
 *   - emptied folders are removed, non-empty ones survive
 *   - non-JSON files are never touched
 *
 * Regression guards:
 *   - pruning MUST be scoped to the model's own directory
 *   - an empty write set MUST NOT be treated as "nothing to do" (that was the bug)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pruneOrphanedMetadata } from '../../scripts/extract-metadata';

let outputPath: string;

/** Write a metadata JSON under <outputPath>/<model>/<dir>/<name>.json, return its path. */
async function seed(model: string, dir: string, name: string): Promise<string> {
  const full = path.join(outputPath, model, dir, `${name}.json`);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, JSON.stringify({ name }));
  return full;
}

const exists = async (p: string) => fs.access(p).then(() => true, () => false);

beforeEach(async () => {
  outputPath = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-prune-'));
});

afterEach(async () => {
  await fs.rm(outputPath, { recursive: true, force: true });
});

describe('pruneOrphanedMetadata', () => {
  it('deletes the JSON of an object that no longer exists on disk', async () => {
    const live = await seed('ContosoFinanceSK', 'enums', 'ConSK_VATCSSection');
    const orphan = await seed('ContosoFinanceSK', 'enums', 'ConSK_QualityTier');

    const removed = await pruneOrphanedMetadata(outputPath, 'ContosoFinanceSK', new Set([live]));

    expect(removed).toEqual(['enums/ConSK_QualityTier.json']);
    expect(await exists(orphan)).toBe(false);
    expect(await exists(live)).toBe(true);
  });

  it('drops a class and its derived class-extension record together', async () => {
    // A class carrying [ExtensionOf(...)] emits two JSONs. Deleting the AxClass must
    // retire both, or find_coc_extensions keeps reporting a CoC wrapper that is gone.
    const cls = await seed('ContosoFinanceSK', 'classes', 'ConCore_ChangeLogConSK_Extension');
    const ext = await seed('ContosoFinanceSK', 'class-extensions', 'ConCore_ChangeLogConSK_Extension');

    const removed = await pruneOrphanedMetadata(outputPath, 'ContosoFinanceSK', new Set());

    expect(removed.sort()).toEqual([
      'class-extensions/ConCore_ChangeLogConSK_Extension.json',
      'classes/ConCore_ChangeLogConSK_Extension.json',
    ]);
    expect(await exists(cls)).toBe(false);
    expect(await exists(ext)).toBe(false);
  });

  it('sweeps everything when the run wrote nothing for the model', async () => {
    // An empty write set means the model produced no output at all — every JSON under it
    // is stale. Short-circuiting on "no writes" would leave the whole model phantom.
    await seed('ContosoFinanceSK', 'enums', 'Gone');
    await seed('ContosoFinanceSK', 'tables', 'AlsoGone');

    const removed = await pruneOrphanedMetadata(outputPath, 'ContosoFinanceSK', new Set());

    expect(removed.length).toBe(2);
  });

  it('removes emptied folders but keeps ones that still hold metadata', async () => {
    const kept = await seed('ContosoFinanceSK', 'tables', 'Live');
    await seed('ContosoFinanceSK', 'enums', 'Dead');

    await pruneOrphanedMetadata(outputPath, 'ContosoFinanceSK', new Set([kept]));

    expect(await exists(path.join(outputPath, 'ContosoFinanceSK', 'enums'))).toBe(false);
    expect(await exists(path.join(outputPath, 'ContosoFinanceSK', 'tables'))).toBe(true);
  });

  it('never touches another model', async () => {
    const other = await seed('ContosoFinanceCZ', 'enums', 'ConCZ_Something');
    await seed('ContosoFinanceSK', 'enums', 'Dead');

    const removed = await pruneOrphanedMetadata(outputPath, 'ContosoFinanceSK', new Set());

    expect(removed).toEqual(['enums/Dead.json']);
    expect(await exists(other)).toBe(true);
  });

  it('leaves files it did not write, whatever their extension', async () => {
    // The extract manifest and any operator scratch files live alongside the metadata.
    const manifest = path.join(outputPath, 'ContosoFinanceSK', 'notes.txt');
    await fs.mkdir(path.dirname(manifest), { recursive: true });
    await fs.writeFile(manifest, 'keep me');

    const removed = await pruneOrphanedMetadata(outputPath, 'ContosoFinanceSK', new Set());

    expect(removed).toEqual([]);
    expect(await exists(manifest)).toBe(true);
  });

  it('is a no-op for a model with no extracted metadata directory', async () => {
    const removed = await pruneOrphanedMetadata(outputPath, 'NeverExtracted', new Set());

    expect(removed).toEqual([]);
  });
});
