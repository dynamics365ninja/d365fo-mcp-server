/**
 * undo and delete remove the compiler-metadata copy of the element they delete.
 *
 * The platform keeps `<root>\<Package>\XppMetadata\<Model>\<AxType>\<Name>.xml` next to
 * the source. pruneStaleCompilerMetadata drops it once the source is gone, but only on
 * an incremental build of this server; a Visual Studio build or a packaging step before
 * that kept the deleted element in the manifests. Seen after a create-then-undo of a
 * class: the source was gone, its XppMetadata copy was not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import path from 'path';
import { removeCompilerMetadataFor } from '../../src/tools/sdlc/compilerMetadataPrune';

let root: string;
let source: string;
let copy: string;

async function write(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '<AxClass />', 'utf-8');
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'compiler-copy-'));
  source = path.join(root, 'Contoso', 'Contoso', 'AxClass', 'ContosoSmoke.xml');
  copy = path.join(root, 'Contoso', 'XppMetadata', 'Contoso', 'AxClass', 'ContosoSmoke.xml');
  await write(source);
  await write(copy);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('removeCompilerMetadataFor', () => {
  it('removes the copy of a deleted source, and its now-empty type folder', async () => {
    await fs.unlink(source);

    await expect(removeCompilerMetadataFor(source)).resolves.toBe(copy);
    expect(await exists(copy)).toBe(false);
    expect(await exists(path.dirname(copy))).toBe(false);
  });

  it('keeps the type folder when other copies are in it', async () => {
    const other = path.join(path.dirname(copy), 'ContosoOther.xml');
    await write(other);
    await fs.unlink(source);

    await removeCompilerMetadataFor(source);
    expect(await exists(copy)).toBe(false);
    expect(await exists(other)).toBe(true);
  });

  it('leaves the copy alone while the source still exists', async () => {
    await expect(removeCompilerMetadataFor(source)).resolves.toBeNull();
    expect(await exists(copy)).toBe(true);
  });

  it('is null when there is no copy', async () => {
    await fs.unlink(source);
    await fs.unlink(copy);
    await expect(removeCompilerMetadataFor(source)).resolves.toBeNull();
  });
});
