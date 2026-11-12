/**
 * resolveExtractXppConfig (scripts/extract-metadata.ts): a pinned XPP config
 * that matches none of the configs on the machine stops the extraction.
 *
 * Before, getActiveConfig()'s null for that pin was read as "not a UDE", and
 * the extraction ran against the drive-scanned packages root instead: often an
 * empty leftover PackagesLocalDirectory, so it extracted nothing with exit code
 * 0 and the full rebuild cleared the database.
 */
import { describe, it, expect } from 'vitest';
import { resolveExtractXppConfig } from '../../scripts/extract-metadata.js';
import type { XppEnvironmentConfig } from '../../src/utils/xppConfigProvider.js';

function config(fullFilename: string): XppEnvironmentConfig {
  const [configName, version] = fullFilename.split('___');
  return {
    configName,
    version,
    fullFilename,
    customPackagesPath: 'C:\\Contoso\\Metadata',
    microsoftPackagesPath: 'C:\\Contoso\\PackagesLocalDirectory',
    referencePackagesPaths: [],
  } as XppEnvironmentConfig;
}

/** A provider over a fixed config list, matching names as getActiveConfig does. */
function provider(configs: XppEnvironmentConfig[]) {
  return {
    listConfigs: async () => configs,
    getActiveConfig: async (name?: string) =>
      name ? configs.find(c => c.fullFilename === name || c.configName === name) ?? null : configs[0] ?? null,
  };
}

describe('resolveExtractXppConfig', () => {
  it('returns the pinned config when it exists', async () => {
    const p = provider([config('contoso-dev___10.0.2500.7'), config('contoso-dev___10.0.2428.63')]);

    expect((await resolveExtractXppConfig(p, 'contoso-dev___10.0.2428.63'))?.fullFilename)
      .toBe('contoso-dev___10.0.2428.63');
  });

  it('throws, naming what is there, when the pinned config is gone', async () => {
    const p = provider([config('contoso-dev___10.0.2500.7')]);

    await expect(resolveExtractXppConfig(p, 'contoso-dev___10.0.2428.63'))
      .rejects.toThrow(/'contoso-dev___10\.0\.2428\.63' matches none.*contoso-dev___10\.0\.2500\.7/);
  });

  it('throws when the pin differs only in case, which getActiveConfig does not match', async () => {
    const p = provider([config('contoso-dev___10.0.2500.7')]);

    await expect(resolveExtractXppConfig(p, 'Contoso-Dev___10.0.2500.7')).rejects.toThrow(/matches none/);
  });

  it('returns null on a machine without XPP configs, so a traditional VM still falls back', async () => {
    expect(await resolveExtractXppConfig(provider([]), 'contoso-dev___10.0.2428.63')).toBeNull();
    expect(await resolveExtractXppConfig(provider([]), undefined)).toBeNull();
  });

  it('auto-selects as before when nothing is pinned', async () => {
    const p = provider([config('contoso-dev___10.0.2500.7')]);

    expect((await resolveExtractXppConfig(p, undefined))?.fullFilename).toBe('contoso-dev___10.0.2500.7');
  });
});
