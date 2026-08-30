/**
 * resolve() must not sweep the whole metadata root to answer about one model.
 *
 * buildMap() reads every package directory, every descriptor in it, and then
 * every subdirectory of it again — 214 packages on the reference VM, ~5 s with
 * the directory metadata already cached and far worse cold. Every write path
 * constructs a fresh PackageResolver, so every write paid for it: a create in
 * benchmark run d79f62a3 took 341 s and reported all of it as `(unmeasured)`.
 *
 * `<root>/<modelName>` answers the same question in two readdirs. The sweep is
 * still there for the packages that are not named after their model — these
 * tests pin that it is reached only then.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PackageResolver } from '../../src/utils/packageResolver';

let root: string;

const descriptor = (name: string, moduleName: string) =>
  `<?xml version="1.0"?>\n<AxModelInfo>\n  <Name>${name}</Name>\n  <ModelModule>${moduleName}</ModelModule>\n</AxModelInfo>\n`;

async function writePackage(pkg: string, opts: { descriptorFor?: [string, string]; modelDir?: string }) {
  const pkgPath = path.join(root, pkg);
  if (opts.descriptorFor) {
    await fs.mkdir(path.join(pkgPath, 'Descriptor'), { recursive: true });
    await fs.writeFile(
      path.join(pkgPath, 'Descriptor', `${opts.descriptorFor[0]}.xml`),
      descriptor(opts.descriptorFor[0], opts.descriptorFor[1]),
    );
  }
  if (opts.modelDir) await fs.mkdir(path.join(pkgPath, opts.modelDir, 'AxClass'), { recursive: true });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgresolver-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('PackageResolver.resolve', () => {
  it('answers from the model-named directory without building the map', async () => {
    await writePackage('AslFinanceSK', { descriptorFor: ['AslFinanceSK', 'AslFinanceSK'], modelDir: 'AslFinanceSK' });
    await writePackage('SomeOtherPackage', { descriptorFor: ['OtherModel', 'SomeOtherPackage'] });

    const resolver: any = new PackageResolver([root]);
    const resolved = await resolver.resolve('AslFinanceSK');

    expect(resolved).toMatchObject({ packageName: 'AslFinanceSK', modelName: 'AslFinanceSK' });
    // The sweep never ran — that, not the timing, is the property under test.
    expect(resolver.modelToPackageMap).toBeNull();
  });

  it('takes the package name from the descriptor, not from the directory', async () => {
    await writePackage('ContosoUtilities', { descriptorFor: ['ContosoUtilities', 'ContosoExtensions'] });

    const resolved = await new PackageResolver([root]).resolve('ContosoUtilities');

    expect(resolved).toMatchObject({ packageName: 'ContosoExtensions', modelName: 'ContosoUtilities' });
  });

  it('resolves a package with no descriptor from its AOT folders', async () => {
    await writePackage('LegacyModel', { modelDir: 'LegacyModel' });

    const resolved = await new PackageResolver([root]).resolve('LegacyModel');

    expect(resolved).toMatchObject({ packageName: 'LegacyModel', modelName: 'LegacyModel' });
  });

  it('keeps the caller spelling when the descriptor differs only in case', async () => {
    // Real shape: the directory is ATLApplicationSuite, the descriptor declares
    // AtlApplicationSuite. The path has to name the directory.
    await writePackage('ATLFoundation', { descriptorFor: ['AtlFoundation', 'AtlFoundation'] });

    const resolved = await new PackageResolver([root]).resolve('ATLFoundation');

    expect(resolved).toMatchObject({ packageName: 'AtlFoundation', modelName: 'ATLFoundation' });
  });

  it('still sweeps for a package that is not named after its model', async () => {
    await writePackage('CustomExtensions', { descriptorFor: ['Contoso Reporting', 'CustomExtensions'] });

    const resolver: any = new PackageResolver([root]);
    const resolved = await resolver.resolve('Contoso Reporting');

    expect(resolved).toMatchObject({ packageName: 'CustomExtensions', modelName: 'Contoso Reporting' });
    expect(resolver.modelToPackageMap).not.toBeNull();
  });

  it('returns null for a model no root knows', async () => {
    await writePackage('AslFinanceSK', { descriptorFor: ['AslFinanceSK', 'AslFinanceSK'] });

    expect(await new PackageResolver([root]).resolve('NoSuchModel')).toBeNull();
  });
});
