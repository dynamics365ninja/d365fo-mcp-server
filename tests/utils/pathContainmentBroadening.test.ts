import { describe, it, expect, vi } from 'vitest';

// Simulate a config where the explicit packagePath points at a single package
// (…/PackagesLocalDirectory/ApplicationSuite) rather than the PLD base — the
// shape that previously rejected writes to sibling custom packages.
vi.mock('../../src/utils/configManager.js', () => ({
  getConfigManager: () => ({
    ensureLoaded: async () => {},
    getPackagePath: () => 'K:/AosService/PackagesLocalDirectory/ApplicationSuite',
    getCustomPackagesPath: async () => null,
    getMicrosoftPackagesPath: async () => null,
  }),
  fallbackPackagePath: () => 'C:/AosService/PackagesLocalDirectory',
}));

import { assertWritePathAllowed } from '../../src/utils/pathContainment.js';

describe('pathContainment — PLD-base broadening', () => {
  it('allows a sibling-package object when packagePath is a single package dir', async () => {
    const r = await assertWritePathAllowed(
      'K:\\AosService\\PackagesLocalDirectory\\MyCustomPkg\\MyCustomModel\\AxTable\\AslRentEquipment.xml',
      'MyCustomModel',
    );
    expect(r.ok).toBe(true);
  });

  it('still rejects paths outside any PackagesLocalDirectory, without blaming separators', async () => {
    const r = await assertWritePathAllowed(
      'K:\\Repos\\evil\\AxTable\\Foo.xml',
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('NOT a path-separator issue');
  });

  it('suggests the exact package root for a repo-checkout layout', async () => {
    // The real reported case: metadata lives in a Git checkout, not under PLD.
    const r = await assertWritePathAllowed(
      'K:\\repos\\ASL\\src\\d365fo\\metadata\\fm-mcp\\fm-mcp\\AxTable\\AslRentEquipment.xml',
      'fm-mcp',
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('packagePath="K:/repos/ASL/src/d365fo/metadata"');
  });
});
