/**
 * Regression (audit finding 1, CRITICAL): the containment guard was bypassable.
 *
 * `toAbsolute()` returned an already-absolute path verbatim, so `..` segments
 * survived normalisation. A path like
 *   <root>/Pkg/Model/AxTable/a.xml/../../../../../evil/target.xml
 * starts under an allowed root (root check passes) and its first four segments
 * are Pkg / Model / AxTable / a.xml (AOT-shape check passes, since that check
 * only inspects those four). Win32 collapsed the `..` only at write time —
 * i.e. the guard approved a write to an arbitrary location on disk.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/configManager.js', () => ({
  getConfigManager: () => ({
    ensureLoaded: async () => {},
    getPackagePath: () => 'C:/PLD',
    getCustomPackagesPath: async () => null,
    getMicrosoftPackagesPath: async () => null,
  }),
  fallbackPackagePath: () => 'C:/never',
}));

import { assertWritePathAllowed, assertReadRootAllowed, isFileUnderRoot } from '../../src/utils/pathContainment.js';

describe('pathContainment — `..` traversal', () => {
  it('rejects the AxTable-segment traversal that escapes the allowed root', async () => {
    const attack = 'C:/PLD/Pkg/Model/AxTable/a.xml/../../../../../evil/target.xml';
    const r = await assertWritePathAllowed(attack, 'Model');
    expect(r.ok).toBe(false);
    expect(r.canonicalPath).toBeUndefined();
  });

  it('rejects the same traversal spelled with Windows separators', async () => {
    const attack = 'C:\\PLD\\Pkg\\Model\\AxTable\\a.xml\\..\\..\\..\\..\\..\\evil\\target.xml';
    const r = await assertWritePathAllowed(attack, 'Model');
    expect(r.ok).toBe(false);
  });

  it('rejects a path that climbs above its own root', async () => {
    const r = await assertWritePathAllowed('C:/../evil/Pkg/Model/AxTable/Foo.xml', 'Model');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/traverses above its own root/i);
  });

  it('collapses harmless `..` inside the root instead of leaking it into canonicalPath', async () => {
    const r = await assertWritePathAllowed(
      'C:/PLD/Other/Junk/../../Pkg/Model/AxTable/Foo.xml',
      'Model',
    );
    expect(r.ok).toBe(true);
    expect(r.canonicalPath).toBe('C:/PLD/Pkg/Model/AxTable/Foo.xml');
    expect(r.canonicalPath).not.toContain('..');
    expect(r.packageSegment).toBe('Pkg');
    expect(r.modelSegment).toBe('Model');
  });

  it('still enforces the model hint against the COLLAPSED path, not the written one', async () => {
    // Traversal used to relocate the write while the shape check still read the
    // pre-collapse segments — so the model hint was checked against a model the
    // file would never land in.
    const r = await assertWritePathAllowed(
      'C:/PLD/Pkg/Model/AxTable/a.xml/../../../../OtherPkg/ApplicationSuite/AxTable/Foo.xml',
      'Model',
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Model mismatch/i);
  });

  it('rejects traversal on the read side too (assertReadRootAllowed)', async () => {
    const r = await assertReadRootAllowed('C:/PLD/Pkg/../../../Windows/System32');
    expect(r.ok).toBe(false);
  });

  it('rejects a traversing glob result in isFileUnderRoot', () => {
    expect(isFileUnderRoot('C:/PLD/Pkg/../../evil/Foo.xml', 'C:/PLD')).toBe(false);
    expect(isFileUnderRoot('C:/PLD/Pkg/Model/AxTable/Foo.xml', 'C:/PLD')).toBe(true);
  });
});
