/**
 * findAotFilesInAllPackages — one Ax* folder across every package under the roots.
 *
 * The write-only companion has no index and findD365FileOnDisk looks in the
 * configured model only, so a standard menu was invisible to it: a menu
 * extension's parent and submenu-name checks fell back to "NOT checked".
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import path from 'path';

const roots: { pld: string | null; custom: string | null; ms: string | null; env: string } = { pld: null, custom: null, ms: null, env: 'traditional' };
vi.mock('../../src/utils/configManager.js', () => ({
  getConfigManager: () => ({
    ensureLoaded: async () => {},
    getPackagePath: () => roots.pld,
    getCustomPackagesPath: async () => roots.custom,
    getMicrosoftPackagesPath: async () => roots.ms,
    getDevEnvironmentType: async () => roots.env,
  }),
  fallbackPackagePath: () => '/nonexistent-fallback',
}));

import { findAotFilesInAllPackages, resetPackageFolderCache } from '../../src/utils/objectFileLookup.js';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = undefined;
  roots.pld = roots.custom = roots.ms = null;
  roots.env = 'traditional';
  resetPackageFolderCache();
});

async function touch(rel: string): Promise<string> {
  const f = path.join(dir!, rel);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, '<x/>', 'utf-8');
  return f;
}

describe('findAotFilesInAllPackages', () => {
  it('finds the folder in every <Package>/<Model> of every root, package != model included', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aot-all-'));
    const a = await touch('pld/ApplicationSuite/Foundation/AxMenu/ContosoMain.xml');
    const b = await touch('pld/ContosoPkg/ContosoPkg/AxMenu/ContosoOwn.xml');
    await touch('pld/ApplicationSuite/Foundation/AxMenuExtension/ContosoMain.X.xml');
    await touch('pld/ApplicationSuite/Descriptor/Foundation.xml');
    const c = await touch('ms/Fw/Fw/AxMenu/ContosoFw.xml');
    roots.pld = path.join(dir, 'pld');
    roots.ms = path.join(dir, 'ms');
    // The Microsoft packages path is a root on UDE only.
    expect((await findAotFilesInAllPackages('AxMenu', () => true)).sort()).toEqual([a, b].sort());
    roots.env = 'ude';
    const found = await findAotFilesInAllPackages('AxMenu', () => true);
    expect(found.sort()).toEqual([a, b, c].sort());
  });

  it('applies the file-name filter, and reads the Ax* folders anew on each call', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aot-all-'));
    await touch('pld/Std/Std/AxMenuExtension/ContosoMain.One.xml');
    await touch('pld/Std/Std/AxMenuExtension/Other.One.xml');
    roots.pld = path.join(dir, 'pld');
    const prefix = (n: string) => n.startsWith('ContosoMain.');
    expect(await findAotFilesInAllPackages('AxMenuExtension', prefix)).toHaveLength(1);
    // Written after the first call, in a model folder that was already listed.
    await touch('pld/Std/Std/AxMenuExtension/ContosoMain.Two.xml');
    expect(await findAotFilesInAllPackages('AxMenuExtension', prefix)).toHaveLength(2);
  });

  it('follows a package or a model folder that is a junction or symbolic link', async () => {
    // A Dirent describes the link itself, so isDirectory() is false for one. A linked package
    // is the usual way a source-controlled model gets into PackagesLocalDirectory.
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aot-all-'));
    const viaPackage = path.join(dir, 'repo', 'ContosoLinked', 'ContosoLinked', 'AxMenu', 'ContosoLinked.xml');
    const viaModel = path.join(dir, 'repo', 'ContosoModel', 'AxMenu', 'ContosoModel.xml');
    for (const f of [viaPackage, viaModel]) {
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, '<x/>', 'utf-8');
    }
    await fs.mkdir(path.join(dir, 'pld', 'ContosoPkg'), { recursive: true });
    await fs.symlink(path.join(dir, 'repo', 'ContosoLinked'), path.join(dir, 'pld', 'ContosoLinked'), 'junction');
    await fs.symlink(path.join(dir, 'repo', 'ContosoModel'), path.join(dir, 'pld', 'ContosoPkg', 'ContosoModel'), 'junction');
    roots.pld = path.join(dir, 'pld');
    const found = (await findAotFilesInAllPackages('AxMenu', () => true)).map(f => path.basename(f)).sort();
    expect(found).toEqual(['ContosoLinked.xml', 'ContosoModel.xml']);
  });

  it('returns nothing for roots that do not exist', async () => {
    roots.pld = '/nonexistent-root';
    expect(await findAotFilesInAllPackages('AxMenu', () => true)).toEqual([]);
  });
});
