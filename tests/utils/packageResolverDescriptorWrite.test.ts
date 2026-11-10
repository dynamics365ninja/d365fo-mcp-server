/**
 * A descriptor write drops the shared model-to-package map.
 *
 * The map is built from the descriptors and shared by every PackageResolver, so
 * after the server rewrites one the next lookup has to sweep again instead of
 * answering from what the descriptors said before.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PackageResolver, clearSharedPackageMaps } from '../../src/utils/packageResolver';
import {
  directXmlAddModuleReference,
  directXmlRemoveModuleReference,
} from '../../src/tools/write/directXmlWriters';

const descriptor = (name: string, moduleName: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n` +
  `<AxModelInfo xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays">\n` +
  `  <Name>${name}</Name>\n` +
  `  <ModelModule>${moduleName}</ModelModule>\n` +
  `  <ModuleReferences>\n` +
  `    <d2p1:string>ApplicationSuite</d2p1:string>\n` +
  `  </ModuleReferences>\n` +
  `</AxModelInfo>`;

let root: string;
let descriptorFile: string;

async function addModel(model: string): Promise<string> {
  const pkg = path.join(root, 'ContosoCore');
  await fs.mkdir(path.join(pkg, 'Descriptor'), { recursive: true });
  await fs.mkdir(path.join(pkg, model, 'AxClass'), { recursive: true });
  const file = path.join(pkg, 'Descriptor', `${model}.xml`);
  await fs.writeFile(file, descriptor(model, 'ContosoCore'), 'utf-8');
  return file;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgdescwrite-'));
  clearSharedPackageMaps();
  descriptorFile = await addModel('ContosoExt');
});

afterEach(async () => {
  clearSharedPackageMaps();
  await fs.rm(root, { recursive: true, force: true });
});

describe('descriptor writers invalidate the shared model-to-package map', () => {
  it('a model added after the sweep is found right after add-module-reference', async () => {
    expect(await new PackageResolver([root]).resolve('ContosoExt')).toMatchObject({ packageName: 'ContosoCore' });
    await addModel('ContosoNew');
    // Inside the miss interval the fresh map answers, so the new model is unknown.
    expect(await new PackageResolver([root]).resolve('ContosoNew')).toBeNull();

    const r = await directXmlAddModuleReference(descriptorFile, 'Ledger', '');
    expect(r?.success).toBe(true);

    expect(await new PackageResolver([root]).resolve('ContosoNew')).toMatchObject({
      packageName: 'ContosoCore',
      modelName: 'ContosoNew',
    });
  });

  it('remove-module-reference invalidates as well', async () => {
    await new PackageResolver([root]).resolve('ContosoExt');
    await addModel('ContosoNew');
    expect(await new PackageResolver([root]).resolve('ContosoNew')).toBeNull();

    const r = await directXmlRemoveModuleReference(descriptorFile, 'ApplicationSuite');
    expect(r?.success).toBe(true);

    expect(await new PackageResolver([root]).resolve('ContosoNew')).not.toBeNull();
  });
});
