/**
 * #802: an incremental `custom` build deletes labels it never re-indexes whenever a model's
 * top-level PACKAGE folder name differs from its AOT MODEL name (a common ISV deployment
 * convention — e.g. package folder "DocentricAX" holding model "Docentric AX").
 *
 * `clearLabelsForModels()` deletes by the `model` column (the real model name). `indexAllLabels`
 * must re-index using that same key. Before the fix it filtered on the top-level package folder
 * name instead — which is only discovered as a *fallback* model name and never matches the real
 * one when the two differ — so the re-index silently skipped the package and the labels stayed
 * deleted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { indexAllLabels } from '../../src/metadata/labelParser';

let tmpDir: string;

/**
 * Lay out {packagesPath}/{packageFolder}/{modelName}/AxLabelFile/LabelResources/en-US/{labelFileId}.en-US.label.txt
 * — the real on-disk shape, where the package folder and the model subfolder can carry
 * different names.
 */
async function writeModelLabels(
  packagesPath: string,
  packageFolder: string,
  modelName: string,
  labelFileId: string,
  entries: Record<string, string>,
): Promise<void> {
  const dir = path.join(packagesPath, packageFolder, modelName, 'AxLabelFile', 'LabelResources', 'en-US');
  await fs.mkdir(dir, { recursive: true });
  const content = Object.entries(entries).map(([id, text]) => `${id}=${text}`).join('\n');
  await fs.writeFile(path.join(dir, `${labelFileId}.en-US.label.txt`), content);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'label-pkg-mismatch-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('indexAllLabels: package folder name != model name (#802)', () => {
  it('indexes a model whose package folder name differs from the model name', async () => {
    const packagesPath = path.join(tmpDir, 'packages');
    // Package folder "DocentricAX" holds the model "Docentric AX" (space differs).
    await writeModelLabels(packagesPath, 'DocentricAX', 'Docentric AX', 'DocentricAXLabels', {
      '@Doc:Hello': 'Hello from Docentric',
    });

    const index = new XppSymbolIndex(':memory:', ':memory:');
    const { totalLabels, modelsIndexed } = await indexAllLabels(
      index,
      packagesPath,
      (modelName) => modelName === 'Docentric AX',
    );

    expect(modelsIndexed).toBe(1);
    expect(totalLabels).toBe(1);

    const rows = index.labelsDb.prepare('SELECT model, label_id FROM labels').all() as any[];
    expect(rows).toEqual([{ model: 'Docentric AX', label_id: '@Doc:Hello' }]);

    index.close?.();
  });

  it('survives a clear + re-index round trip for a scoped custom build', async () => {
    // Mirrors build-database's incremental custom path: clearLabelsForModels(modelsToRebuild)
    // followed by indexAllLabels(..., (m) => modelsToRebuild.includes(m)).
    const packagesPath = path.join(tmpDir, 'packages');
    await writeModelLabels(packagesPath, 'DocentricAX', 'Docentric AX', 'DocentricAXLabels', {
      '@Doc:Hello': 'Hello from Docentric',
    });
    await writeModelLabels(packagesPath, 'ContosoCore', 'ContosoCore', 'ContosoCoreLabels', {
      '@Con:Keep': 'Untouched by the scoped rebuild',
    });

    const index = new XppSymbolIndex(':memory:', ':memory:');
    await indexAllLabels(index, packagesPath);
    expect(index.getLabelCount()).toBe(2);

    // Scoped rebuild of the ISV model only — the manifest carries the real MODEL name.
    const modelsToRebuild = ['Docentric AX'];
    index.clearLabelsForModels(modelsToRebuild, { ftsStrategy: 'incremental' });

    const { totalLabels, modelsIndexed } = await indexAllLabels(
      index,
      packagesPath,
      (modelName) => modelsToRebuild.includes(modelName),
      { ftsStrategy: 'incremental' },
    );

    expect(modelsIndexed).toBe(1);
    expect(totalLabels).toBe(1);

    // No net loss: the scoped model came back, and the untouched one was never cleared.
    expect(index.getLabelCount()).toBe(2);
    const models = index.labelsDb.prepare('SELECT DISTINCT model FROM labels ORDER BY model').all();
    expect(models).toEqual([{ model: 'ContosoCore' }, { model: 'Docentric AX' }]);

    index.close?.();
  });

  it('does not index a model excluded by the filter, even when the package folder name would match', async () => {
    const packagesPath = path.join(tmpDir, 'packages');
    await writeModelLabels(packagesPath, 'ContosoCore', 'ContosoCore', 'ContosoCoreLabels', {
      '@Con:Excluded': 'Should stay out',
    });

    const index = new XppSymbolIndex(':memory:', ':memory:');
    const { totalLabels, modelsIndexed } = await indexAllLabels(
      index,
      packagesPath,
      (modelName) => modelName === 'Docentric AX',
    );

    expect(modelsIndexed).toBe(0);
    expect(totalLabels).toBe(0);
    expect(index.getLabelCount()).toBe(0);

    index.close?.();
  });
});
