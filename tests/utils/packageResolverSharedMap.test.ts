/**
 * PackageResolver: the model-to-package map is swept once per set of roots and
 * shared by every instance, and the sweep opens a package's subfolders only when
 * its descriptors name no model.
 *
 * Every caller constructs a fresh resolver, so a map held on the instance was
 * rebuilt on every lookup the direct probe could not answer (a model in a
 * package of another name, a package of several models, a mistyped model name).
 * These tests count directory reads on real temp directories.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const spy = vi.hoisted(() => ({ readdirs: [] as string[] }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const readdir = (p: any, ...rest: any[]) => {
    spy.readdirs.push(String(p));
    return (actual.readdir as any)(p, ...rest);
  };
  return { ...actual, readdir, default: { ...actual, readdir } };
});

import * as fs from 'fs/promises';
import { realpathSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PackageResolver, clearSharedPackageMaps } from '../../src/utils/packageResolver';

let root: string;

const descriptor = (name: string, moduleName: string) =>
  `<?xml version="1.0"?>\n<AxModelInfo>\n  <Name>${name}</Name>\n  <ModelModule>${moduleName}</ModelModule>\n</AxModelInfo>\n`;

/** A package folder with the given descriptors ([model, module]) and model folders. */
async function writePackage(
  pkg: string,
  opts: { descriptors?: [string, string][]; modelDirs?: string[]; plainDirs?: string[] },
  base = root,
) {
  const pkgPath = path.join(base, pkg);
  await fs.mkdir(pkgPath, { recursive: true });
  for (const [model, moduleName] of opts.descriptors ?? []) {
    await fs.mkdir(path.join(pkgPath, 'Descriptor'), { recursive: true });
    await fs.writeFile(path.join(pkgPath, 'Descriptor', `${model}.xml`), descriptor(model, moduleName));
  }
  for (const dir of opts.modelDirs ?? []) await fs.mkdir(path.join(pkgPath, dir, 'AxClass'), { recursive: true });
  for (const dir of opts.plainDirs ?? []) await fs.mkdir(path.join(pkgPath, dir), { recursive: true });
}

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
/** How many times a directory was listed since the last reset. */
const reads = (dir: string) => spy.readdirs.filter(p => norm(p) === norm(dir)).length;
/** A sweep lists the root itself, the direct probe never does. */
const sweeps = () => reads(root);

beforeEach(async () => {
  root = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'pkgshared-')));
  clearSharedPackageMaps();
  spy.readdirs.length = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  clearSharedPackageMaps();
  await fs.rm(root, { recursive: true, force: true });
});

describe('PackageResolver — shared model-to-package map', () => {
  it('two instances on the same roots share one sweep', async () => {
    await writePackage('ContosoCore', {
      descriptors: [['ContosoExt', 'ContosoCore'], ['ContosoReporting', 'ContosoCore']],
      modelDirs: ['ContosoExt', 'ContosoReporting'],
    });

    const first = await new PackageResolver([root]).resolve('ContosoExt');
    const second = await new PackageResolver([root]).resolve('ContosoReporting');

    expect(first).toMatchObject({ packageName: 'ContosoCore', modelName: 'ContosoExt' });
    expect(second).toMatchObject({ packageName: 'ContosoCore', modelName: 'ContosoReporting' });
    expect(sweeps()).toBe(1);
  });

  it('lookups that start at the same moment share one sweep', async () => {
    await writePackage('ContosoCore', { descriptors: [['ContosoExt', 'ContosoCore']], modelDirs: ['ContosoExt'] });

    const results = await Promise.all(
      [1, 2, 3].map(() => new PackageResolver([root]).resolve('ContosoExt')),
    );

    expect(results.every(r => r?.packageName === 'ContosoCore')).toBe(true);
    expect(sweeps()).toBe(1);
  });

  it('sweeps again after clearCache(), also for another instance', async () => {
    await writePackage('ContosoCore', { descriptors: [['ContosoExt', 'ContosoCore']], modelDirs: ['ContosoExt'] });

    const resolver = new PackageResolver([root]);
    await resolver.resolve('ContosoExt');
    expect(sweeps()).toBe(1);

    resolver.clearCache();
    await new PackageResolver([root]).resolve('ContosoExt');
    expect(sweeps()).toBe(2);
  });

  it('sweeps again after clearSharedPackageMaps()', async () => {
    await writePackage('ContosoCore', { descriptors: [['ContosoExt', 'ContosoCore']], modelDirs: ['ContosoExt'] });

    await new PackageResolver([root]).resolve('ContosoExt');
    clearSharedPackageMaps();
    await new PackageResolver([root]).resolve('ContosoExt');

    expect(sweeps()).toBe(2);
  });

  it('keeps a map per set of roots', async () => {
    const otherRoot = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'pkgshared-other-')));
    try {
      await writePackage('ContosoCore', { descriptors: [['ContosoExt', 'ContosoCore']], modelDirs: ['ContosoExt'] });
      await writePackage('ContosoOther', { descriptors: [['ContosoExt', 'ContosoOther']], modelDirs: ['ContosoExt'] }, otherRoot);

      const here = await new PackageResolver([root]).resolve('ContosoExt');
      const there = await new PackageResolver([otherRoot]).resolve('ContosoExt');

      expect(here).toMatchObject({ packageName: 'ContosoCore' });
      expect(there).toMatchObject({ packageName: 'ContosoOther' });
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('a mistyped model does not sweep twice in quick succession', async () => {
    await writePackage('ContosoCore', { descriptors: [['ContosoExt', 'ContosoCore']], modelDirs: ['ContosoExt'] });

    expect(await new PackageResolver([root]).resolve('ContosoTypo')).toBeNull();
    expect(await new PackageResolver([root]).resolve('ContosoTypo')).toBeNull();
    expect(await new PackageResolver([root]).resolve('ContosoTypo')).toBeNull();

    expect(sweeps()).toBe(1);
  });

  it('finds a model created after the first sweep once the interval has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await writePackage('ContosoCore', { descriptors: [['ContosoExt', 'ContosoCore']], modelDirs: ['ContosoExt'] });
    await new PackageResolver([root]).resolve('ContosoExt');
    expect(sweeps()).toBe(1);

    // A second model appears in the package, as Visual Studio would create it.
    await writePackage('ContosoCore', { descriptors: [['ContosoNew', 'ContosoCore']], modelDirs: ['ContosoNew'] });

    // Right away the map is too fresh for a miss to rebuild it.
    expect(await new PackageResolver([root]).resolve('ContosoNew')).toBeNull();
    expect(sweeps()).toBe(1);

    vi.setSystemTime(new Date('2026-01-01T00:00:06Z'));
    const found = await new PackageResolver([root]).resolve('ContosoNew');
    expect(found).toMatchObject({ packageName: 'ContosoCore', modelName: 'ContosoNew' });
    expect(sweeps()).toBe(2);

    // The rebuilt map is fresh again: a miss right after it does not sweep.
    expect(await new PackageResolver([root]).resolve('ContosoTypo')).toBeNull();
    expect(sweeps()).toBe(2);
  });

  it('a hit never rebuilds, however old the map is', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await writePackage('ContosoCore', { descriptors: [['ContosoExt', 'ContosoCore']], modelDirs: ['ContosoExt'] });
    await new PackageResolver([root]).resolve('ContosoExt');

    vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
    await new PackageResolver([root]).resolve('ContosoExt');

    expect(sweeps()).toBe(1);
  });

  it('getAllMappings uses the shared map', async () => {
    await writePackage('ContosoCore', { descriptors: [['ContosoExt', 'ContosoCore']], modelDirs: ['ContosoExt'] });

    const a = await new PackageResolver([root]).getAllMappings();
    const b = await new PackageResolver([root]).getAllMappings();

    expect([...a.keys()]).toEqual(['ContosoExt']);
    expect([...b.keys()]).toEqual(['ContosoExt']);
    expect(sweeps()).toBe(1);
  });
});

describe('PackageResolver — subfolders are opened only as the fallback', () => {
  it('does not open the folders of a package whose descriptors name its models', async () => {
    await writePackage('ContosoCore', {
      descriptors: [['ContosoExt', 'ContosoCore']],
      modelDirs: ['ContosoExt'],
      plainDirs: ['Resources', 'Reports'],
    });

    const mappings = await new PackageResolver([root]).getAllMappings();

    expect(mappings.get('ContosoExt')).toMatchObject({ packageName: 'ContosoCore' });
    for (const dir of ['ContosoExt', 'Resources', 'Reports']) {
      expect(reads(path.join(root, 'ContosoCore', dir))).toBe(0);
    }
  });

  it('still opens the folders of a package without a Descriptor directory', async () => {
    await writePackage('ContosoLegacyPackage', { modelDirs: ['ContosoLegacyModel'], plainDirs: ['Resources'] });

    const resolved = await new PackageResolver([root]).resolve('ContosoLegacyModel');

    expect(resolved).toMatchObject({ packageName: 'ContosoLegacyPackage', modelName: 'ContosoLegacyModel' });
    expect(reads(path.join(root, 'ContosoLegacyPackage', 'ContosoLegacyModel'))).toBeGreaterThan(0);
  });

  it('still opens the folders of a package whose Descriptor directory names no model', async () => {
    await writePackage('ContosoLegacyPackage', { modelDirs: ['ContosoLegacyModel'] });
    await fs.mkdir(path.join(root, 'ContosoLegacyPackage', 'Descriptor'), { recursive: true });
    await fs.writeFile(path.join(root, 'ContosoLegacyPackage', 'Descriptor', 'Broken.xml'), '<AxModelInfo />');

    const resolved = await new PackageResolver([root]).resolve('ContosoLegacyModel');

    expect(resolved).toMatchObject({ packageName: 'ContosoLegacyPackage', modelName: 'ContosoLegacyModel' });
  });

  it('keeps the folder spelling of a model whose descriptor differs only in case', async () => {
    // Descriptor declares ContosoExt, the folder on disk is CONTOSOExt.
    await writePackage('ContosoCore', { descriptors: [['ContosoExt', 'ContosoCore']], modelDirs: ['CONTOSOExt'] });

    const mappings = await new PackageResolver([root]).getAllMappings();

    expect(mappings.get('ContosoExt')).toMatchObject({ packageName: 'ContosoCore', modelName: 'ContosoExt' });
    expect(mappings.get('CONTOSOExt')).toMatchObject({ packageName: 'ContosoCore', modelName: 'CONTOSOExt' });
  });

  it('does not report a folder that no descriptor of its package declares', async () => {
    // Descriptors are authoritative where they exist: an extra folder with AOT
    // content beside a declared model is not a model.
    await writePackage('ContosoCore', {
      descriptors: [['ContosoExt', 'ContosoCore']],
      modelDirs: ['ContosoExt', 'ContosoUndeclared'],
    });

    expect(await new PackageResolver([root]).resolve('ContosoUndeclared')).toBeNull();
  });
});
